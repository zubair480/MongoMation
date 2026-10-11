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
import { commandArrived, jobArrived, watchHarnessImmutability, watchJobs, watchJobTransitions } from "./harness/jobwatch.ts";
import { BlockedError, event } from "./harness/stages.ts";
import { runEngineering, newProjectId, redactRigHost } from "./pipeline/engineer.ts";
import { runFaultAndImprove } from "./pipeline/fault.ts";
import { runEvolveRound, runBenchmarkJob, runAblationJob, type RunLimits } from "./rsi/evolve.ts";
import { harnessFlags, initTelemetry, telemetry } from "./telemetry/index.ts";
import { createRig } from "./tools/connect.ts";
import { awsAfterJob, initAws } from "./aws/index.ts";

const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} [${workerId()}] ${m}`);

await connect();
await initTelemetry(log);
await initAws(log); // MM_AWS_* flags: S3 artifacts, CloudWatch, SSM secrets + rig health (no-op when unset)
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
    await commandArrived.wait(1000); // change stream wakes this at once; 1 s poll is the fallback
  }
})();
watchJobs(log);
watchJobTransitions(log); // status audit from pre/post images -> job_transitions
watchHarnessImmutability(log); // decided harness versions must never change -> audit_log

// --- job loop ---------------------------------------------------------------------------------------------
for (;;) {
  const recovered = await recoverStale();
  if (recovered) log(`recovered ${recovered} interrupted job(s) from Atlas`);
  const raw = await claimNext();
  if (!raw) {
    await workerBeat(null).catch(() => {});
    await jobArrived.wait(1500); // woken by the jobs change stream on insert; 1.5 s poll is the fallback
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
    const message = redactRigHost(err instanceof Error ? err.message : String(err));
    const blocked = err instanceof BlockedError;
    await setStatus(job._id, blocked ? "blocked" : "failed", { error: message });
    // The engineer job may have created the project after claim, so re-read the job's projectId.
    const projectId = job.projectId ?? ((await col.jobs().findOne({ _id: job._id }, { projection: { projectId: 1 } }))?.projectId as string | undefined);
    if (projectId) {
      // Only a project this job left "running" (ended before the verification stage) is closed out here.
      await col.projects().updateOne({ _id: projectId as never, status: "running" }, { $set: { status: blocked ? "blocked" : "failed", error: message } }).catch(() => {});
      await event(projectId, jobId, null, "error", `${blocked ? "BLOCKED" : "FAILED"}: ${message}`);
    }
    log(`${blocked ? "blocked" : "failed"} ${job.type} ${jobId}: ${message}`);
  } finally {
    clearInterval(beat);
    await telemetry.flush().catch(() => {});
    void awsAfterJob(job._id); // S3 artifacts + CloudWatch metrics; never throws
  }
}

/** Explicit run limits written on the job by scripts/evolve.ts (--limit / --max-repairs / --evidence-since). */
function jobLimits(job: JobDoc): RunLimits {
  const j = job as unknown as { caseLimit?: unknown; maxRepairs?: unknown; evidenceSince?: unknown };
  const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
  const since = j.evidenceSince instanceof Date ? j.evidenceSince : typeof j.evidenceSince === "string" ? new Date(j.evidenceSince) : undefined;
  return { caseLimit: int(j.caseLimit) || undefined, maxRepairs: int(j.maxRepairs), evidenceSince: since && !Number.isNaN(since.getTime()) ? since : undefined };
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
      // A resumed job (crash / stale reclaim) continues the Raindrop interaction its first attempt began.
      const rdEventId = telemetry.beginRun(projectId, { event: "engineering_job", input: job.specText ?? "", properties: { harness_version: config.version, scene: scene.id, origin: job.origin }, featureFlags: harnessFlags(config), resumeEventId: (job as { raindropEventId?: string }).raindropEventId });
      if (rdEventId) await col.jobs().updateOne({ _id: job._id }, { $set: { raindropEventId: rdEventId } });
      const r = await telemetry.span(projectId, "engineering", () => runEngineering({ projectId, jobId, specText: job.specText ?? "", scene, config }, { ...rig, rigId }));
      await telemetry.finishRun(projectId, `${r.status} after ${r.attempts} attempt(s)`, { status: r.status, attempts: r.attempts });
      return { projectId, ...r, lastSimRun: r.lastSimRun && { simRunId: r.lastSimRun.simRunId, passed: r.lastSimRun.passed, failed: r.lastSimRun.failed, blocked: r.lastSimRun.blocked } };
    }
    case "fault_and_improve": {
      if (!job.projectId) throw new BlockedError("no project selected: run an engineering job first");
      const project = await col.projects().findOne({ _id: job.projectId as never });
      const scene = await loadScene(project?.sceneId as string);
      return runFaultAndImprove({ jobId, projectId: job.projectId, faultId: job.faultId, scene, config, limits: jobLimits(job) }, { ...rig, rigId });
    }
    case "spec_change": {
      if (!job.projectId) throw new BlockedError("spec change needs a project");
      const project = await col.projects().findOne({ _id: job.projectId as never });
      if (!project) throw new BlockedError(`project ${job.projectId} not found`);
      const scene = await loadScene(project.sceneId as string);
      const revision = ((project.revision as number | undefined) ?? 0) + 1;
      const baseline = project.finalPlcVersionId ? await col.plcVersions().findOne({ _id: new (await import("mongodb")).ObjectId(String(project.finalPlcVersionId)) }) : null;
      await col.projects().updateOne({ _id: job.projectId as never }, { $set: { specText: job.specText, revision, status: "running" }, $push: { specHistory: { revision, specText: job.specText, at: new Date() } } as never });
      telemetry.beginRun(job.projectId, { event: "spec_change", input: job.specText ?? "", properties: { revision }, featureFlags: harnessFlags(config) });
      const r = await runEngineering(
        { projectId: job.projectId, jobId, specText: job.specText ?? "", scene, config, revision, baselineSource: (baseline?.source as string | undefined) ?? undefined },
        { ...rig, rigId },
      );
      await telemetry.finishRun(job.projectId, `${r.status} after ${r.attempts} attempt(s)`, { status: r.status });
      return { projectId: job.projectId, revision, status: r.status, attempts: r.attempts };
    }
    case "evolve":
      return runEvolveRound({ jobId, config, trigger: "manual evolve job", limits: jobLimits(job) });
    case "benchmark":
      return runBenchmarkJob({ jobId, candidateVersion: (job as unknown as { candidateVersion?: number }).candidateVersion, limits: jobLimits(job) }, { ...rig, rigId, loadScene });
    case "ablation":
      return runAblationJob({ jobId, limits: jobLimits(job) }, { ...rig, rigId, loadScene });
    default:
      throw new Error(`job type ${type} not handled by this worker`);
  }
}
