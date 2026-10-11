// "Inject Fault & Improve Harness".
//   Phase A: apply a REAL fault through the Factory I/O Web API, confirm it by reading the tag back, and run
//            the independent fault tests with the fault as the stimulus.
//   Phase B: if the program mishandled it, diagnose and repair (real compile/deploy/retest, real diff).
//   Phase C: only if there is evidence of a harness weakness, ask the meta-agent for a harness change and
//            send it to guardrails + benchmark + gate (rsi/evolve.ts). Handled faults do not invent failures.
import type { BoundRequirement, FaultScenario, HarnessConfig, IoPoint, SceneDefinition } from "@mongomation/types";
import { ObjectId, type Document } from "mongodb";
import { diagnose, repairLogic, type EngineeringContext } from "../agents/codegen.ts";
import { col } from "../db/index.ts";
import { retrieveLessons, similarFailures } from "../harness/memory.ts";
import { withRig } from "../harness/riglock.ts";
import { BlockedError, event } from "../harness/stages.ts";
import { runEvolveRound, type RunLimits } from "../rsi/evolve.ts";
import { telemetry } from "../telemetry/index.ts";
import { preflight } from "../tools/preflight.ts";
import type { PlcRuntime, Simulator } from "../tools/rig.ts";
import { linkGate } from "./engineer.ts";
import { assembleProgram, lineDiff, lintLogic } from "./st.ts";
import { buildTestPlan, failureFeedback, publicView, runPlan } from "./validate.ts";

const FAULT_RELEVANT = new Set(["timer_timeout", "interlock", "fault_latch", "reset_precondition", "no_auto_restart", "run_until_sensor", "estop"]);

/** Picks the scene fault that exercises the project's fault-handling requirements (deterministic). */
export function chooseFault(scene: SceneDefinition, reqs: BoundRequirement[], requested?: string): FaultScenario | null {
  if (requested) return scene.faults.find((f) => f.id === requested) ?? null;
  const boundTags = new Map<string, number>();
  for (const r of reqs) if (r.support === "supported" && FAULT_RELEVANT.has(r.kind)) for (const t of Object.values(r.bindings)) boundTags.set(t, (boundTags.get(t) ?? 0) + 1);
  const ranked = [...scene.faults].sort((a, b) => (boundTags.get(b.tag) ?? 0) - (boundTags.get(a.tag) ?? 0));
  return ranked[0] ?? null;
}

/** The slice of the plc_versions collection used to allocate a repair version (fakeable in tests). */
export interface PlcVersionStore {
  findOne(filter: Document, options: { sort: Document; projection: Document }): Promise<Document | null>;
  insertOne(doc: Document): Promise<{ insertedId: unknown }>;
}

/**
 * Inserts a fault-repair PLC version under the next free number for the project. Repairs stay in the 1000+
 * band above their base (base 3 -> 1003, as before) but never reuse a number: a second repair on the same
 * project gets max(version)+1 (e.g. 1004). The unique {projectId, version} index is the arbiter; on a
 * concurrent E11000 we re-read the max and retry once.
 */
export async function insertRepairVersion(store: PlcVersionStore, projectId: string, baseVersion: number, doc: Document) {
  for (let attempt = 0; ; attempt++) {
    const top = await store.findOne({ projectId }, { sort: { version: -1 }, projection: { version: 1 } });
    const version = Math.max(Number(top?.version ?? 0) + 1, baseVersion + 1000);
    try {
      return { ...(await store.insertOne({ projectId, version, ...doc })), version };
    } catch (e) {
      if (attempt >= 1 || (e as { code?: number }).code !== 11000) throw e;
    }
  }
}

export async function runFaultAndImprove(
  args: { jobId: string; projectId: string; faultId?: string; scene: SceneDefinition; config: HarnessConfig; limits?: RunLimits },
  deps: { plc: PlcRuntime; sim: Simulator; rigId: string },
) {
  const { jobId, projectId, scene, config, limits } = args;
  const log = (stage: string, m: string, level: "info" | "warn" | "error" = "info") => event(projectId, jobId, stage, level, m);
  const project = await col.projects().findOne({ _id: projectId as never });
  if (!project?.finalPlcVersionId) throw new BlockedError("project has no engineered program yet");
  const reqDoc = await col.requirements().findOne({ projectId }, { sort: { revision: -1 } });
  if (!reqDoc) throw new BlockedError("project has no requirements record");
  const reqs = reqDoc.requirements as BoundRequirement[];
  const io = reqDoc.io as IoPoint[];
  const version = await col.plcVersions().findOne({ _id: new ObjectId(String(project.finalPlcVersionId)) });
  if (!version) throw new BlockedError("final PLC version not found");
  const fault = chooseFault(scene, reqs, args.faultId);
  if (!fault) throw new BlockedError(`scene ${scene.id} has no registered fault scenarios`);
  telemetry.beginRun(projectId, { event: "fault_and_improve", input: `${fault.id} on ${project.specText}`, properties: { fault: fault.id } });

  // The fault tests: every planned test whose stimulus is the faulted tag, so the injected fault is exercised.
  const fullPlan = buildTestPlan(reqs, scene, { includeHidden: true });
  const faultTests = fullPlan.tests.filter((t) => t.steps.some((s) => (s.op === "force" || s.op === "hold") && s.tag === fault.tag));
  const plan = { ...fullPlan, tests: faultTests, hash: `${fullPlan.hash}:fault:${fault.id}` };

  const phaseA = await withRig(deps.rigId, jobId, async () => {
    // Make sure the project's final program is what is running (reconcile, don't assume).
    const comp = await deps.plc.compile(String(version.source), `mm_${projectId.slice(-6)}_fault`);
    if (!comp.ok) throw new Error(`could not reload the project's program: ${comp.log.slice(-500)}`);
    await deps.plc.start();
    await linkGate(deps.sim, String(version.source), (m) => log("deploy", m));

    // Phase A.1: apply the fault for real and confirm by read-back.
    await log("simulate", `injecting ${fault.kind} on "${fault.tag}" via Factory I/O Web API`);
    const t0 = performance.now();
    await deps.sim.force(fault.tag, fault.value);
    const readBack = (await deps.sim.read([fault.tag]))[fault.tag];
    const all = await deps.sim.tags();
    const forcedList = all.filter((t) => t.forced).map((t) => t.name);
    const entry = all.find((t) => t.name === fault.tag && t.kind === "Input");
    const confirmed = Boolean(entry?.forced) && entry?.forcedValue === fault.value;
    const inj = await col.faults().insertOne({ projectId, jobId, faultId: fault.id, tag: fault.tag, value: fault.value, appliedAt: new Date(), readBack, forcedList, confirmed });
    telemetry.tool({ name: "factoryio_fault_injection", runId: projectId, input: { fault: fault.id, tag: fault.tag } }, { ok: confirmed, summary: `read-back ${String(readBack)}; forced: ${forcedList.join(", ")}`, durationMs: Math.round(performance.now() - t0), evidenceIds: [String(inj.insertedId)] });
    // Hold the fault for one scan window so its effect on the running program is captured, then release:
    // each fault test re-applies it as its own stimulus, with measurements.
    const observed = await deps.sim.read([...new Set([fault.tag, ...io.filter((p) => p.role === "actuator").map((p) => p.tag)])]);
    await deps.sim.release([fault.tag]);
    await col.faults().updateOne({ _id: inj.insertedId }, { $set: { observedWhileForced: observed, releasedAt: new Date() } });
    if (!confirmed) throw new BlockedError(`fault not confirmed by read-back (${fault.tag} = ${String(readBack)}); nothing was tested`);
    if (!faultTests.length) return { confirmed, observed, run: null as Awaited<ReturnType<typeof runPlan>> | null };

    const run = await runPlan({
      sim: deps.sim,
      scene,
      plan,
      requirements: reqs,
      projectId,
      plcVersionId: String(version._id),
      sourceHash: String(version.sourceHash),
      harnessVersion: config.version,
      faultId: fault.id,
      onProgress: (m) => log("tests", m),
    });
    return { confirmed, observed, run };
  });

  if (!phaseA.run) {
    await log("tests", `no requirement defines the expected response to ${fault.id}; observed behaviour recorded, nothing claimed`, "warn");
    await telemetry.finishRun(projectId, `fault ${fault.id}: no validated expectation`);
    return { fault: fault.id, confirmed: phaseA.confirmed, outcome: "untested", rsi: { verdict: "no_change", reason: "no fault-handling requirement to evaluate" } };
  }
  const failed = phaseA.run.results.filter((r) => r.verdict === "failed");
  if (!failed.length) {
    await log("verification", `fault ${fault.id} handled correctly: ${phaseA.run.passed}/${phaseA.run.results.length} fault tests passed`);
    // Phase C still consults history: a weakness may exist elsewhere; the meta-agent may (and should) say "no change".
    const rsi = await runEvolveRound({ jobId, config, trigger: `fault ${fault.id} was handled correctly by the current program`, limits });
    await telemetry.finishRun(projectId, `fault ${fault.id} handled; RSI: ${rsi.verdict}`);
    return { fault: fault.id, confirmed: true, outcome: "handled", simRunId: phaseA.run.simRunId, rsi };
  }

  // Phase B: diagnose and repair against the fault failures, then re-run the FULL plan (regression).
  const feedback = failureFeedback(phaseA.run.results, "observed");
  await log("diagnosis", `${failed.length} fault test(s) failed: ${failed.map((f) => f.testId).join(", ")}`, "warn");
  const ectx: EngineeringContext = { specText: String(project.specText), requirements: reqs, io, acceptance: publicView(fullPlan).tests.map((t) => `${t.id}: ${t.title}`), lessons: [], similarFailures: [] };
  // Engineering memory (hybrid vector + lexical): fault description + observed failures as the query.
  const memQuery = `${fault.title}: ${fault.description}\n${feedback.join("\n")}`;
  [ectx.lessons, ectx.similarFailures] = await Promise.all([retrieveLessons(memQuery, config.context), similarFailures(memQuery, config.context, scene.id)]);
  const diag = await diagnose(ectx, String(version.source), feedback, config, projectId);
  const diagDoc = await col.diagnoses().insertOne({ projectId, plcVersionId: String(version._id), sceneId: scene.id, split: "train", feedback, summary: diag.data.summary, text: `${diag.data.summary} ${diag.data.causes.map((c) => `${c.cause} -> ${c.fix}`).join(" ")}`, causes: diag.data.causes, lessons: diag.data.lessons, traceId: diag.traceId, harnessVersion: config.version, faultId: fault.id, createdAt: new Date() });
  const fix = await repairLogic(ectx, { previousSource: String(version.source), feedback, diagnosis: diag.data.summary, failingRequirementIds: [...new Set(failed.flatMap((f) => f.requirementIds))] }, config, config.routing.repair, projectId);
  const { source, sourceHash } = assembleProgram(io, fix.data, `MongoMation ${projectId} fault repair (${fault.id})`);
  const lint = lintLogic(io, fix.data);
  const pf = lint.length ? null : await preflight(source);
  const newVersion = await insertRepairVersion(col.plcVersions(), projectId, Number(version.version), { source, sourceHash, createdBy: "repair", reason: `fault ${fault.id}`, harnessVersion: config.version, diffFromPrevious: lineDiff(String(version.source), source), diagnosisId: String(diagDoc.insertedId), createdAt: new Date() });
  const repairRecord = { projectId, fromVersionId: String(version._id), toVersionId: String(newVersion.insertedId), diagnosisId: String(diagDoc.insertedId), lint, preflight: pf?.status ?? "skipped", createdAt: new Date() };
  if (lint.length || pf?.status === "failed") {
    await col.repairs().insertOne({ ...repairRecord, outcome: "did_not_compile" });
    await log("repair", `repair did not pass static checks/preflight: ${lint.join("; ") || pf?.log}`, "error");
  }
  const after = lint.length || pf?.status === "failed" ? null : await withRig(deps.rigId, jobId, async () => {
    const comp = await deps.plc.compile(source, `mm_${projectId.slice(-6)}_faultfix`);
    await col.compiles().insertOne({ plcVersionId: String(newVersion.insertedId), stage: "compile", toolchain: deps.plc.label, ...comp, createdAt: new Date() });
    if (!comp.ok) return null;
    await deps.plc.start();
    await linkGate(deps.sim, source, (m) => log("deploy", m));
    await new Promise((r) => setTimeout(r, scene.timing.settleMs));
    return runPlan({ sim: deps.sim, scene, plan: fullPlan, requirements: reqs, projectId, plcVersionId: String(newVersion.insertedId), sourceHash, harnessVersion: config.version, faultId: fault.id, onProgress: (m) => log("verification", m) });
  });
  const fixed = Boolean(after && after.failed === 0 && after.blocked === 0);
  await col.repairs().insertOne({ ...repairRecord, outcome: fixed ? "fixed" : "not_fixed", afterSimRunId: after?.simRunId ?? null });
  if (fixed) await col.projects().updateOne({ _id: projectId as never }, { $set: { finalPlcVersionId: String(newVersion.insertedId), lastSimRunId: after!.simRunId } });
  await log("verification", fixed ? `repair verified: fault tests and full regression pass (sim run ${after!.simRunId})` : "repair did not fully pass; project keeps its previous verified program", fixed ? "info" : "warn");

  // Phase C: the harness question — is there a repeated, measured weakness worth a harness change?
  const rsi = await runEvolveRound({ jobId, config, trigger: `fault ${fault.id} exposed ${failed.length} failing test(s) on project ${projectId}${fixed ? " (fixed by repair)" : " (repair failed)"}`, limits });
  await telemetry.finishRun(projectId, `fault ${fault.id}: ${fixed ? "repaired" : "not repaired"}; RSI: ${rsi.verdict}`);
  return { fault: fault.id, confirmed: true, outcome: fixed ? "repaired" : "repair_failed", beforeSimRunId: phaseA.run.simRunId, afterSimRunId: after?.simRunId ?? null, rsi };
}
