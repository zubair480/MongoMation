// The validator stage: runs the independent test plan on the REAL rig and stores every sample as evidence.
// Lives outside agents/ on purpose: it is the only worker module that imports @mongomation/checks.
import type { BoundRequirement, SceneDefinition, TestResult } from "@mongomation/types";
import { buildTestPlan, executeTest, failureFeedback, publicView, requirementVerdicts, type TestPlan } from "@mongomation/checks";
import { ObjectId } from "mongodb";
import { col } from "../db/index.ts";
import { setSampling } from "../harness/sampling.ts";
import { telemetry } from "../telemetry/index.ts";
import type { Simulator } from "../tools/rig.ts";
import { orderByExperience, shouldStopEarly, type FailureStat, type OrderSource } from "./retest.ts";

export { buildTestPlan, publicView, failureFeedback };

/** The plan restricted to `testIds` (plan order kept; every test already carries its known-state preamble). */
export function subsetPlan(plan: TestPlan, testIds: string[]): TestPlan {
  const want = new Set(testIds);
  const tests = plan.tests.filter((t) => want.has(t.id));
  return { tests, untestable: plan.untestable, hash: `${plan.hash}:targeted:${tests.map((t) => t.id).join(",")}` };
}

/**
 * Failed + blocked test ids of a sim run, read from Atlas test_results (final attempts only, superseded first
 * attempts excluded), plus tests an early stop skipped. Falls back to the in-memory results when Atlas has none.
 */
export async function failedTestIdsOf(run: SimRunSummary): Promise<string[]> {
  const ids = new Set<string>();
  try {
    const docs = await col.testResults().find({ simRunId: run.simRunId, superseded: { $ne: true }, verdict: { $in: ["failed", "blocked"] } }).project({ testId: 1 }).toArray();
    for (const d of docs) ids.add(String((d as { testId?: unknown }).testId));
  } catch {
    /* Atlas unavailable: use the run in hand */
  }
  if (!ids.size) for (const r of run.results) if (r.verdict === "failed" || r.verdict === "blocked") ids.add(r.testId);
  for (const id of run.skipped ?? []) ids.add(id);
  return [...ids];
}

/**
 * Report view of a targeted run: the last full pass with the targeted tests' results replaced, verdicts recomputed
 * on the FULL plan. Used only to report a project whose budget ran out on a targeted round (it has failures, so it
 * can never read as verified); verification itself always needs a real full pass.
 */
export function mergeTargeted(plan: TestPlan, requirements: BoundRequirement[], full: SimRunSummary, targeted: SimRunSummary): SimRunSummary {
  const byId = new Map(full.results.map((r) => [r.testId, r] as const));
  for (const r of targeted.results) byId.set(r.testId, r);
  const results = plan.tests.map((t) => byId.get(t.id)).filter((r): r is TestResult => Boolean(r));
  const count = (v: TestResult["verdict"]) => results.filter((r) => r.verdict === v).length;
  return { ...targeted, planHash: plan.hash, results, verdicts: requirementVerdicts(requirements, plan, results), passed: count("passed"), failed: count("failed"), blocked: count("blocked") };
}

/**
 * Experience-ordered testing, read side: historical failed/total per (requirement kind, test category) on this scene,
 * aggregated in Atlas over test_results (superseded attempts excluded, blocked rows excluded: no evidence either way).
 * Older rows carry no kind; they count under kind "" and feed the per-category fallback.
 */
export async function failureHistory(sceneId: string, opts: { limitRuns?: number } = {}): Promise<FailureStat[]> {
  try {
    const runIds = await col
      .simRuns()
      .find({ sceneId, status: "done" })
      .sort({ startedAt: -1 })
      .limit(opts.limitRuns ?? 500)
      .project({ _id: 1 })
      .toArray();
    if (!runIds.length) return [];
    const rows = await col
      .testResults()
      .aggregate([
        { $match: { simRunId: { $in: runIds.map((r) => String(r._id)) }, superseded: { $ne: true }, verdict: { $in: ["passed", "failed"] } } },
        { $group: { _id: { kind: { $ifNull: ["$kind", ""] }, category: "$category" }, failed: { $sum: { $cond: [{ $eq: ["$verdict", "failed"] }, 1, 0] } }, total: { $sum: 1 } } },
      ])
      .toArray();
    return rows.map((r) => ({ kind: String(r._id.kind ?? ""), category: String(r._id.category ?? ""), failed: Number(r.failed), total: Number(r.total) }));
  } catch {
    return []; // no history -> plan order
  }
}

/** Requirement kind of a test (its first requirement), for experience ordering and for the stored row. */
const kindOfTest = (requirements: BoundRequirement[]) => (t: { requirementIds: string[] }) =>
  String(requirements.find((r) => t.requirementIds.includes(r.id))?.kind ?? "");

export interface SimRunSummary {
  simRunId: string;
  planHash: string;
  results: TestResult[];
  verdicts: ReturnType<typeof requirementVerdicts>;
  passed: number;
  failed: number;
  blocked: number;
  mode?: "targeted" | "full";
  /** Experience-ordered testing: how this run was ordered, and the tests an early stop did not run. */
  orderSource?: OrderSource;
  earlyStop?: boolean;
  skipped?: string[];
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
  /** "targeted": `plan` is a subset (subsetPlan) of the full plan; its test ids are stored on the sim_run. */
  mode?: "targeted" | "full";
  /** Experience-ordered testing: order tests by this failure history (most failure-prone first). */
  history?: FailureStat[];
  /** Repair rounds only: stop after this many failures (the rest is re-run later). Full passes never set it. */
  stopAfterFailures?: number;
}): Promise<SimRunSummary> {
  const simRunId = new ObjectId();
  const kindOf = kindOfTest(args.requirements);
  const ordered = args.history ? orderByExperience(args.plan.tests, kindOf, args.history) : { tests: args.plan.tests, source: "plan" as OrderSource };
  const mode = args.mode ?? "full";
  const stopAfter = mode === "targeted" ? args.stopAfterFailures : undefined;
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
    mode,
    ...(mode === "targeted" && { testIds: args.plan.tests.map((t) => t.id) }),
    orderSource: ordered.source,
    order: ordered.tests.map((t) => t.id),
    startedAt: new Date(),
    status: "running",
  });
  // Deterministic stimulus: stop the scene's own part flow (pre-forced emitter) and reset it, restore afterwards.
  await args.sim.applySetup(args.scene.setup.beforeTests);
  const results: TestResult[] = [];
  let skipped: string[] = [];
  // The rig monitor (main.ts) pauses its own Factory I/O reads while a plan run samples (harness/sampling.ts).
  setSampling(true);
  try {
  for (const [i, test] of ordered.tests.entries()) {
    if (shouldStopEarly(results.filter((r) => r.verdict === "failed").length, stopAfter, ordered.tests.length - i)) {
      skipped = ordered.tests.slice(i).map((t) => t.id);
      await args.onProgress?.(`early stop after ${stopAfter} failure(s): ${skipped.length} test(s) left for the next round`);
      break;
    }
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
      kind: kindOf(test),
      // hidden test steps are stored for audit but never projected into agent context or the web app
      steps: test.steps,
      stepLogs: exec.logs,
      startedAt: new Date(base),
      attempt: exec.attempts,
    });
    // A first attempt BLOCKED for insufficient measurements was re-run once (never a FAILED one). Keep it on
    // record, marked superseded; its samples go under a distinct testId so the final attempt's timeline is clean.
    if (exec.superseded) {
      const prev = exec.superseded;
      const prevBase = Date.parse(prev.startedAt);
      const prevKey = `${test.id}~attempt1`;
      if (prev.samples.length)
        await col.measurements().insertMany(
          prev.samples.map((s) => ({ ts: new Date(prevBase + s.t), meta: { simRunId: String(simRunId), testId: prevKey }, t: s.t, values: s.values })),
        );
      await col.testResults().insertOne({
        simRunId: String(simRunId),
        projectId: args.projectId,
        plcVersionId: args.plcVersionId,
        harnessVersion: args.harnessVersion,
        split: args.split ?? "train",
        ...prev.result,
        steps: test.steps,
        stepLogs: prev.logs,
        startedAt: new Date(prevBase),
        attempt: 1,
        superseded: true,
        supersededBy: String(tr.insertedId),
        measurementsKey: prevKey,
      });
    }
    const traceId = telemetry.tool(
      { name: "simulator_test", runId: args.projectId, input: { testId: test.id, visibility: test.visibility } },
      { ok: exec.result.verdict === "passed", summary: `${test.id}: ${exec.result.verdict}`, durationMs: Math.round(performance.now() - t0), evidenceIds: [String(tr.insertedId)] },
    );
    if (traceId) await col.testResults().updateOne({ _id: tr.insertedId }, { $set: { traceId } });
    if (exec.result.verdict === "failed")
      telemetry.signal({ runId: args.projectId, name: "simulator_test_failed", eventId: traceId, properties: { testId: test.id, category: test.category } });
  }
  } finally {
    setSampling(false);
    await args.sim.applySetup(args.scene.setup.afterTests);
  }
  const verdicts = requirementVerdicts(args.requirements, args.plan, results);
  const count = (v: TestResult["verdict"]) => results.filter((r) => r.verdict === v).length;
  const summary = { passed: count("passed"), failed: count("failed"), blocked: count("blocked") };
  const earlyStop = skipped.length > 0;
  await col.simRuns().updateOne({ _id: simRunId }, { $set: { status: "done", finishedAt: new Date(), verdicts, ...summary, earlyStop, skipped } });
  return { simRunId: String(simRunId), planHash: args.plan.hash, results, verdicts, ...summary, mode, orderSource: ordered.source, earlyStop, skipped };
}
