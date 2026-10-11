// The validator stage: runs the independent test plan on the REAL rig and stores every sample as evidence.
// Lives outside agents/ on purpose: it is the only worker module that imports @mongomation/checks.
import type { BoundRequirement, SceneDefinition, TestResult } from "@mongomation/types";
import { buildTestPlan, executeTest, failureFeedback, publicView, requirementVerdicts, type TestPlan } from "@mongomation/checks";
import { ObjectId } from "mongodb";
import { col } from "../db/index.ts";
import { telemetry } from "../telemetry/index.ts";
import type { Simulator } from "../tools/rig.ts";

export { buildTestPlan, publicView, failureFeedback };

export interface SimRunSummary {
  simRunId: string;
  planHash: string;
  results: TestResult[];
  verdicts: ReturnType<typeof requirementVerdicts>;
  passed: number;
  failed: number;
  blocked: number;
}

export async function runPlan(args: {
  sim: Simulator;
  scene: SceneDefinition;
  plan: TestPlan;
  requirements: BoundRequirement[];
  projectId: string;
  plcVersionId: string;
  sourceHash: string;
  harnessVersion: number;
  faultId?: string;
  split?: "train" | "heldout";
  onProgress?: (msg: string) => Promise<void>;
}): Promise<SimRunSummary> {
  const simRunId = new ObjectId();
  const released = await args.sim.releaseAll(); // never start from a forced state left by a crash
  await col.simRuns().insertOne({
    _id: simRunId,
    projectId: args.projectId,
    plcVersionId: args.plcVersionId,
    sourceHash: args.sourceHash,
    sceneId: args.scene.id,
    planHash: args.plan.hash,
    harnessVersion: args.harnessVersion,
    faultId: args.faultId ?? null,
    split: args.split ?? "train",
    releasedAtStart: released,
    startedAt: new Date(),
    status: "running",
  });
  // Deterministic stimulus: stop the scene's own part flow (pre-forced emitter) and reset it, restore afterwards.
  await args.sim.applySetup(args.scene.setup.beforeTests);
  const results: TestResult[] = [];
  try {
  for (const test of args.plan.tests) {
    await args.onProgress?.(`test ${test.id} (${test.visibility}) running`);
    const t0 = performance.now();
    const exec = await executeTest(args.sim, args.scene, test);
    results.push(exec.result);
    const base = Date.parse(exec.startedAt);
    if (exec.samples.length)
      await col.measurements().insertMany(
        exec.samples.map((s) => ({ ts: new Date(base + s.t), meta: { simRunId: String(simRunId), testId: test.id }, t: s.t, values: s.values })),
      );
    const tr = await col.testResults().insertOne({
      simRunId: String(simRunId),
      projectId: args.projectId,
      plcVersionId: args.plcVersionId,
      harnessVersion: args.harnessVersion,
      split: args.split ?? "train",
      ...exec.result,
      // hidden test steps are stored for audit but never projected into agent context or the web app
      steps: test.steps,
      stepLogs: exec.logs,
      startedAt: new Date(base),
    });
    const traceId = telemetry.tool(
      { name: "simulator_test", runId: args.projectId, input: { testId: test.id, visibility: test.visibility } },
      { ok: exec.result.verdict === "passed", summary: `${test.id}: ${exec.result.verdict}`, durationMs: Math.round(performance.now() - t0), evidenceIds: [String(tr.insertedId)] },
    );
    if (traceId) await col.testResults().updateOne({ _id: tr.insertedId }, { $set: { traceId } });
    if (exec.result.verdict === "failed")
      telemetry.signal({ runId: args.projectId, name: "simulator_test_failed", eventId: traceId, properties: { testId: test.id, category: test.category } });
  }
  } finally {
    await args.sim.applySetup(args.scene.setup.afterTests);
  }
  const verdicts = requirementVerdicts(args.requirements, args.plan, results);
  const count = (v: TestResult["verdict"]) => results.filter((r) => r.verdict === v).length;
  const summary = { passed: count("passed"), failed: count("failed"), blocked: count("blocked") };
  await col.simRuns().updateOne({ _id: simRunId }, { $set: { status: "done", finishedAt: new Date(), verdicts, ...summary } });
  return { simRunId: String(simRunId), planHash: args.plan.hash, results, verdicts, ...summary };
}
