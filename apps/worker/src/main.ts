// The engineering worker. Runs inside the AWS VPC next to the rig (OpenPLC + Factory I/O are private).
//   npm run worker
// Loop: recover stale jobs → claim → run with heartbeats → write results. A rig monitor publishes live tag
// values and connection state to `rig_status` for the dashboard. "Interrupt Worker" kills this process hard
// (exit 137, like a crash); the launcher or a human restarts it and the job resumes from Atlas checkpoints.
import type { JobType, SceneDefinition } from "@mongomation/types";
import { setTimeout as sleep } from "node:timers/promises";
import { col, connect } from "./db/index.ts";
import { currentConfig } from "./harness/config.ts";
import { claimNext, heartbeat, HEARTBEAT_MS, pendingCommand, recoverStale, setStatus, workerBeat, workerId, type JobDoc } from "./harness/jobs.ts";
import { BlockedError, event } from "./harness/stages.ts";
import { runEngineering, newProjectId } from "./pipeline/engineer.ts";
import { runFaultAndImprove } from "./pipeline/fault.ts";
import { runEvolveRound, runBenchmarkJob } from "./rsi/evolve.ts";
import { initTelemetry, telemetry } from "./telemetry/index.ts";
import { createRig } from "./tools/connect.ts";

const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} [${workerId()}] ${m}`);

await connect();
await initTelemetry(log);
const rig = createRig(); // throws with a clear message when OPENPLC_URL / FACTORYIO_URL are missing
const rigId = process.env.RIG_ID || "rig-1";
log(`worker up: ${rig.plc.label} | ${rig.sim.label}`);

// Reconcile real rig state on start: never leave a fault forced by a crashed predecessor.
try {
  const released = await rig.sim.releaseAll();
  if (released.length) log(`reconcile: released ${released.length} forced tag(s) left by a previous run: ${released.join(", ")}`);
} catch (err) {
  log(`reconcile: Factory I/O unreachable (${(err as Error).message}) — jobs needing the rig will be BLOCKED`);
}

async function loadScene(id?: string): Promise<SceneDefinition> {
  const sceneId = id || process.env.SCENE_ID;
  const doc = sceneId ? await col.scenes().findOne({ id: sceneId }) : null;
  if (!doc) throw new BlockedError(`scene "${sceneId}" is not registered in Atlas (npm run seed)`);
  const { _id, ...scene } = doc;
  if (!scene.verified) throw new BlockedError(`scene "${sceneId}" is not verified on the live rig yet (Developer 1 must confirm the I/O map)`);
  return scene as unknown as SceneDefinition;
}

// --- rig monitor: live tags for the dashboard's simulation panel ---------------------------------------
void (async () => {
  for (;;) {
    try {
      const scene = process.env.SCENE_ID ? await col.scenes().findOne({ id: process.env.SCENE_ID }) : null;
      const [plc, sim] = await Promise.all([rig.plc.status().catch((e) => ({ reachable: false, running: false, detail: String(e) })), rig.sim.health().catch((e) => ({ reachable: false, detail: String(e) }))]);
      let tags: Record<string, unknown> = {};
      let forced: string[] = [];
      if (sim.reachable) {
        const all = await rig.sim.tags();
        forced = all.filter((t) => t.forced).map((t) => t.name);
        const names = scene ? (scene.tags as { name: string }[]).map((t) => t.name) : all.slice(0, 40).map((t) => t.name);
        tags = Object.fromEntries(all.filter((t) => names.includes(t.name)).map((t) => [t.name, t.value]));
      }
      await col.rigStatus().updateOne(
        { _id: rigId as never },
        { $set: { checkedAt: new Date(), sceneId: process.env.SCENE_ID ?? null, openplc: plc, factoryio: sim, forced, tags, dcvUrl: process.env.DCV_URL ?? null, worker: workerId() } },
        { upsert: true },
      );
    } catch (err) {
      log(`rig monitor: ${(err as Error).message}`);
    }
    await sleep(1500);
  }
})();

// --- interrupt command watcher ---------------------------------------------------------------------------
void (async () => {
  for (;;) {
    if ((await pendingCommand().catch(() => null)) === "interrupt") {
      log("INTERRUPT requested from the dashboard: exiting now without cleanup (simulated crash)");
      process.exit(137);
    }
    await sleep(1000);
  }
})();

// --- job loop ---------------------------------------------------------------------------------------------
for (;;) {
  const recovered = await recoverStale();
  if (recovered) log(`recovered ${recovered} interrupted job(s) from Atlas`);
  const raw = await claimNext();
  if (!raw) {
    await workerBeat(null).catch(() => {});
    await sleep(1500);
    continue;
  }
  const job = raw as unknown as JobDoc;
  const jobId = String(job._id);
  log(`claimed ${job.type} ${jobId}${job.resumedFrom ? ` (resuming after ${job.resumedFrom})` : ""}`);
  const beat = setInterval(() => void heartbeat(job._id).catch(() => {}), HEARTBEAT_MS);
  try {
    const result = await dispatch(job.type, job, jobId);
    await setStatus(job._id, "completed", { result });
    log(`completed ${job.type} ${jobId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const blocked = err instanceof BlockedError;
    await setStatus(job._id, blocked ? "blocked" : "failed", { error: message });
    if (job.projectId) await event(job.projectId, jobId, null, "error", `${blocked ? "BLOCKED" : "FAILED"}: ${message}`);
    log(`${blocked ? "blocked" : "failed"} ${job.type} ${jobId}: ${message}`);
  } finally {
    clearInterval(beat);
    await telemetry.flush().catch(() => {});
  }
}

async function dispatch(type: JobType, job: JobDoc, jobId: string) {
  const config = await currentConfig();
  switch (type) {
    case "engineer": {
      const scene = await loadScene(job.sceneId);
      // A resumed job keeps its project id so completed stages are reused from Atlas.
      const projectId = job.projectId ?? newProjectId();
      if (!job.projectId) {
        await col.jobs().updateOne({ _id: job._id }, { $set: { projectId } });
        await col.projects().insertOne({ _id: projectId as never, specText: job.specText, sceneId: scene.id, status: "running", harnessVersion: config.version, origin: job.origin, createdAt: new Date() });
      }
      telemetry.beginRun(projectId, { event: "engineering_job", input: job.specText ?? "", properties: { harness_version: config.version, scene: scene.id, origin: job.origin } });
      const r = await runEngineering({ projectId, jobId, specText: job.specText ?? "", scene, config }, { ...rig, rigId });
      await telemetry.finishRun(projectId, `${r.status} after ${r.attempts} attempt(s)`, { status: r.status, attempts: r.attempts });
      return { projectId, ...r, lastSimRun: r.lastSimRun && { simRunId: r.lastSimRun.simRunId, passed: r.lastSimRun.passed, failed: r.lastSimRun.failed, blocked: r.lastSimRun.blocked } };
    }
    case "fault_and_improve": {
      if (!job.projectId) throw new BlockedError("no project selected: run an engineering job first");
      const project = await col.projects().findOne({ _id: job.projectId as never });
      const scene = await loadScene(project?.sceneId as string);
      return runFaultAndImprove({ jobId, projectId: job.projectId, faultId: job.faultId, scene, config }, { ...rig, rigId });
    }
    case "spec_change": {
      if (!job.projectId) throw new BlockedError("spec change needs a project");
      const project = await col.projects().findOne({ _id: job.projectId as never });
      if (!project) throw new BlockedError(`project ${job.projectId} not found`);
      const scene = await loadScene(project.sceneId as string);
      const revision = ((project.revision as number | undefined) ?? 0) + 1;
      const baseline = project.finalPlcVersionId ? await col.plcVersions().findOne({ _id: new (await import("mongodb")).ObjectId(String(project.finalPlcVersionId)) }) : null;
      await col.projects().updateOne({ _id: job.projectId as never }, { $set: { specText: job.specText, revision, status: "running" }, $push: { specHistory: { revision, specText: job.specText, at: new Date() } } as never });
      telemetry.beginRun(job.projectId, { event: "spec_change", input: job.specText ?? "", properties: { revision } });
      const r = await runEngineering(
        { projectId: job.projectId, jobId, specText: job.specText ?? "", scene, config, revision, baselineSource: (baseline?.source as string | undefined) ?? undefined },
        { ...rig, rigId },
      );
      await telemetry.finishRun(job.projectId, `${r.status} after ${r.attempts} attempt(s)`, { status: r.status });
      return { projectId: job.projectId, revision, status: r.status, attempts: r.attempts };
    }
    case "evolve":
      return runEvolveRound({ jobId, config, trigger: "manual evolve job" });
    case "benchmark":
      return runBenchmarkJob({ jobId, candidateVersion: (job as unknown as { candidateVersion?: number }).candidateVersion }, { ...rig, rigId, loadScene });
    default:
      throw new Error(`job type ${type} not handled by this worker`);
  }
}
