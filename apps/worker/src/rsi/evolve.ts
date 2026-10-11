// Loop 2 — recursive self-improvement of the harness.
//   runEvolveRound: real failures (Atlas) → clusters → meta-agent → guardrails → candidate (pending) → benchmark job
//   runBenchmarkJob: frozen cases under parent and candidate, same model + scene + validator → gate → KEPT/ROLLED BACK
// Every proposal, diff, violation, score and verdict is stored (rsi_proposals, harness_versions, benchmark_runs).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BoundRequirement, HarnessConfig, HarnessScores, SceneDefinition } from "@mongomation/types";
import { ObjectId } from "mongodb";
import { col, withTxn } from "../db/index.ts";
import { currentConfig, getConfig, recordVerdict, storeCandidate } from "../harness/config.ts";
import { enqueue } from "../harness/jobs.ts";
import { newProjectId, runEngineering, type EngineerResult } from "../pipeline/engineer.ts";
import { telemetry } from "../telemetry/index.ts";
import { raindropEvidence } from "../telemetry/raindrop-query.ts";
import type { PlcRuntime, Simulator } from "../tools/rig.ts";
import { decide } from "./gate.ts";
import { configDiff, guardrailViolations, stripMeta } from "./guardrails.ts";
import { proposeHarnessChange, type FailureCluster, type MetaEvidence } from "./meta.ts";

/** Failures need to repeat before they justify a harness change. */
const MIN_CLUSTER = 2;

/**
 * Explicit, recorded run limits for time-boxed runs (all optional; absent = full benchmark, harness budgets).
 *   caseLimit    : use only the FIRST N cases of the split, in specs/benchmark.json order (deterministic). The frozen
 *                  file and its hash are untouched; every row stores `limit` + the case ids actually run.
 *   maxRepairs   : cap repair rounds per case at min(config.workflow.repair_budget, N) for EVERY condition alike
 *                  (bare stays 0). Recorded on every row; the stored harness configs are not changed.
 *   evidenceSince: evolve only — consider failures recorded at/after this time (e.g. after a harness bug fix), so
 *                  failures caused by since-fixed test bugs or a dead rig link are not fed to the meta-agent.
 */
export interface RunLimits {
  caseLimit?: number;
  maxRepairs?: number;
  evidenceSince?: Date;
  /** --cases: exactly these frozen cases of the split (full id, or the short prefix before the first "-",
   *  e.g. "t3" = "t3-jam-latch"), run in benchmark.json order. Unknown/ambiguous/other-split ids throw. */
  caseIds?: string[];
}

/** Resolves --cases ids (full or short "t3") against one split; throws on anything it cannot match exactly once. */
export function resolveCaseIds<T extends { id: string; split: string }>(cases: T[], split: "train" | "heldout", ids: string[]): string[] {
  const all = cases.filter((c) => c.split === split);
  return [...new Set(ids.map((raw) => {
    const want = raw.trim();
    const exact = all.find((c) => c.id === want);
    if (exact) return exact.id;
    const short = all.filter((c) => c.id.split("-")[0] === want);
    if (short.length === 1) return short[0].id;
    throw new Error(`--cases: "${want}" is not ${short.length ? "a unique" : "a"} ${split} case (have: ${all.map((c) => c.id).join(", ")})`);
  }))];
}

export function selectCases<T extends { id: string; split: string }>(cases: T[], split: "train" | "heldout", caseLimit?: number, caseIds?: string[]) {
  const all = cases.filter((c) => c.split === split);
  const wanted = caseIds?.length ? new Set(resolveCaseIds(cases, split, caseIds)) : null;
  const picked = wanted ? all.filter((c) => wanted.has(c.id)) : all;
  const selected = caseLimit && caseLimit > 0 ? picked.slice(0, caseLimit) : picked;
  return { selected, total: all.length, limit: caseLimit && caseLimit > 0 ? caseLimit : null, explicit: wanted ? selected.map((c) => c.id) : null };
}

/** Gate-note line for a subset run (null for a full run). */
export function subsetNote(sel: { selected: { id: string }[]; total: number; limit: number | null; explicit: string[] | null }, maxRepairs?: number) {
  if (!sel.limit && !sel.explicit) return null;
  const ids = sel.selected.map((c) => c.id).join(", ");
  const how = sel.explicit ? `--cases ${sel.explicit.join(",")}${sel.limit ? `, limit=${sel.limit}` : ""}` : `first ${sel.selected.length}, limit=${sel.limit}`;
  return `subset: ${ids} (${sel.selected.length} of ${sel.total} frozen cases; ${how})${maxRepairs !== undefined ? `, repairs capped at ${maxRepairs}` : ""}`;
}

export function capRepairs(cfg: HarnessConfig, maxRepairs?: number): HarnessConfig {
  if (maxRepairs === undefined || maxRepairs < 0 || cfg.workflow.repair_budget <= maxRepairs) return cfg;
  return { ...cfg, workflow: { ...cfg.workflow, repair_budget: maxRepairs } };
}

/** Test results that count as evidence: this harness version, train split, not superseded by a retry, and (with
 *  --evidence-since) recorded at/after the cutoff. */
export function evidenceResultFilter(version: number, evidenceSince?: Date) {
  return { harnessVersion: version, split: { $ne: "heldout" }, superseded: { $ne: true }, ...(evidenceSince && { startedAt: { $gte: evidenceSince } }) };
}

/** Projects measured for the meta-agent. With an evidence window the set is the projects that have in-window test
 *  results (windowProjectIds), NOT projects created after the cutoff: a project created earlier whose failing runs
 *  fall inside the window is still measured (otherwise clusters say projects: 2 while metrics say 1). */
export function measuredProjectsFilter(version: number, windowProjectIds: string[] | null) {
  return { harnessVersion: version, status: { $in: ["verified", "partially_verified", "failed"] }, ...(windowProjectIds && { _id: { $in: windowProjectIds } }) };
}

export async function collectEvidence(config: HarnessConfig, evidenceSince?: Date): Promise<MetaEvidence> {
  const failed = await col
    .testResults()
    .find(
      { ...evidenceResultFilter(config.version, evidenceSince), verdict: "failed" },
      { projection: { steps: 0, stepLogs: 0 } },
    )
    .sort({ startedAt: -1 })
    .limit(400)
    .toArray();
  const byPattern = new Map<string, FailureCluster & { projectSet: Set<string> }>();
  for (const t of failed) {
    const firstBad = (t.assertions as { label: string; passed: boolean }[]).find((a) => !a.passed)?.label ?? "unknown";
    const pattern = `${t.category}: ${firstBad.replace(/"[^"]*"/g, "TAG").replace(/\b[A-Z][a-z]+( [a-z]+)*\b/g, (m) => m)}`;
    const c = byPattern.get(pattern) ?? { pattern, count: 0, projects: 0, runIds: [], testResultIds: [], diagnoses: [], raindropEventIds: [], projectSet: new Set<string>() };
    c.count++;
    c.projectSet.add(String(t.projectId));
    c.runIds.push(String(t.simRunId));
    c.testResultIds.push(String(t._id));
    if (t.traceId) c.raindropEventIds.push(String(t.traceId));
    byPattern.set(pattern, c);
  }
  const clusters = [...byPattern.values()].sort((a, b) => b.count - a.count).slice(0, 8);
  for (const c of clusters) {
    c.projects = c.projectSet.size;
    const diags = await col.diagnoses().find({ projectId: { $in: [...c.projectSet] }, split: { $ne: "heldout" } }, { sort: { createdAt: -1 }, limit: 3 }).toArray();
    c.diagnoses = diags.map((d) => String(d.summary));
    c.runIds = [...new Set(c.runIds)];
    c.raindropEventIds = [...new Set(c.raindropEventIds)];
  }
  const windowProjectIds = evidenceSince ? (await col.testResults().distinct("projectId", evidenceResultFilter(config.version, evidenceSince))).map(String) : null;
  const projects = await col.projects().find(measuredProjectsFilter(config.version, windowProjectIds) as never).toArray();
  const sat = projects.map((p) => {
    const v = (p.verdicts as { status: string }[] | undefined) ?? [];
    const relevant = v.filter((x) => x.status !== "unsupported");
    return relevant.length ? relevant.filter((x) => x.status === "verified").length / relevant.length : 0;
  });
  const lessons = await col.lessons().find({ active: true }, { sort: { createdAt: -1 }, limit: 6 }).toArray();
  return {
    harnessVersion: config.version,
    projects: projects.length,
    requirementSatisfaction: sat.length ? sat.reduce((a, b) => a + b, 0) / sat.length : 0,
    repairsPerProject: projects.length ? projects.reduce((a, p) => a + Math.max(0, Number(p.attempts ?? 1) - 1), 0) / projects.length : 0,
    clusters: clusters.map(({ projectSet: _p, ...c }) => c),
    recentLessons: lessons.map((l) => `${l.pattern} -> ${l.fix}`),
    // Raindrop Query API: signal counts, failing spans and failure samples across all runs (null = unavailable).
    raindrop: await raindropEvidence({ log: (m) => console.warn(`rsi: ${m}`) }),
  };
}

export async function runEvolveRound(args: { jobId: string; config: HarnessConfig; trigger: string; limits?: RunLimits }) {
  const parent = args.config;
  const limits = args.limits ?? {};
  const evidence = { ...(await collectEvidence(parent, limits.evidenceSince)), trigger: args.trigger, evidenceSince: limits.evidenceSince?.toISOString() ?? null };
  const repeated = evidence.clusters.filter((c) => c.count >= MIN_CLUSTER);
  const base = { createdAt: new Date(), jobId: args.jobId, fromVersion: parent.version, trigger: args.trigger, evidenceSummary: evidence };
  if (!repeated.length) {
    const doc = await col.proposals().insertOne({ ...base, change: false, verdict: "no_change", rationale: `No repeated failure pattern under v${parent.version} (${evidence.clusters.length} distinct failures, none seen ${MIN_CLUSTER}+ times). No justified harness change.`, provenance: "live" });
    return { verdict: "no_change" as const, proposalId: String(doc.insertedId) };
  }
  const meta = await proposeHarnessChange({ ...evidence, clusters: repeated }, parent, `rsi-${args.jobId}`);
  const p = meta.data;
  if (!p.change || !p.config) {
    const doc = await col.proposals().insertOne({ ...base, change: false, verdict: "no_change", rationale: p.rationale, metaTraceId: meta.traceId, provenance: "live" });
    return { verdict: "no_change" as const, proposalId: String(doc.insertedId) };
  }
  // Guardrails: grounded in real failed runs under the parent, schema-valid, no weakening.
  const cited = (p.citedRunIds as string[]).filter((id) => /^[a-f0-9]{24}$/.test(id));
  const citedExisting = cited.length ? await col.simRuns().countDocuments({ _id: { $in: cited.map((id) => new ObjectId(id)) }, harnessVersion: parent.version, failed: { $gt: 0 } }) : 0;
  const violations = guardrailViolations(parent, p.config, { citedRunIdsExist: citedExisting > 0 });
  const diff = configDiff(stripMeta(parent), p.config);
  if (violations.length) {
    const doc = await col.proposals().insertOne({ ...base, change: true, verdict: "rejected", rationale: p.rationale, expectedEffect: p.expectedEffect, citedRunIds: cited, diff, guardrailViolations: violations, proposedConfig: p.config, metaTraceId: meta.traceId, provenance: "live" });
    telemetry.signal({ runId: `rsi-${args.jobId}`, name: "harness_proposal_rejected", eventId: meta.traceId, properties: { violations: violations.join("; ") } });
    return { verdict: "rejected" as const, proposalId: String(doc.insertedId), violations };
  }
  const evidenceRefs = { runIds: cited, testResultIds: repeated.flatMap((c) => c.testResultIds).slice(0, 50), raindropEventIds: repeated.flatMap((c) => c.raindropEventIds).slice(0, 50) };
  // ONE transaction: the pending harness version, the benchmark job that will judge it and the proposal linking
  // them commit together or not at all. A crash can no longer leave a "pending" version with no benchmark job, and
  // a worker woken by the jobs change stream never sees the benchmark job before its candidate exists.
  const { candidate, benchmarkJobId, proposalId } = await withTxn(async (session) => {
    const candidate = await storeCandidate(parent, p.config as never, p.rationale, evidenceRefs, session);
    // The gate benchmark inherits the evolve job's explicit limits (recorded on the job and on every row).
    const benchmarkJobId = await enqueue(
      { type: "benchmark", origin: "script" },
      { candidateVersion: candidate.version, ...(limits.caseLimit && { caseLimit: limits.caseLimit }), ...(limits.maxRepairs !== undefined && { maxRepairs: limits.maxRepairs }), ...(limits.caseIds?.length && { caseIds: limits.caseIds }) },
      session,
    );
    const doc = await col.proposals().insertOne({ ...base, change: true, verdict: "pending", candidateVersion: candidate.version, rationale: p.rationale, expectedEffect: p.expectedEffect, citedRunIds: cited, diff, guardrailViolations: [], metaTraceId: meta.traceId, benchmarkJobId: String(benchmarkJobId), provenance: "live" }, { session });
    return { candidate, benchmarkJobId, proposalId: String(doc.insertedId) };
  });
  return { verdict: "pending" as const, proposalId, candidateVersion: candidate.version, diff, benchmarkJobId: String(benchmarkJobId) };
}

// --------------------------------------------------------------------------------------------------------
// Benchmark: frozen cases, train split for the gate, held-out split for the ablation table.
// --------------------------------------------------------------------------------------------------------

export interface BenchmarkCase {
  id: string;
  split: "train" | "heldout";
  sceneId: string;
  specText: string;
  /** Ground-truth requirements used for grading, identical for every condition (never shown to agents). */
  requirements: BoundRequirement[];
}

const BENCHMARK_PATH = new URL("../../../../specs/benchmark.json", import.meta.url);

/** Loads the benchmark and refuses to run if it changed after its hash was first recorded in Atlas. */
export async function loadFrozenBenchmark(): Promise<{ cases: BenchmarkCase[]; hash: string }> {
  const raw = readFileSync(BENCHMARK_PATH, "utf8");
  const hash = createHash("sha256").update(raw).digest("hex");
  const existing = await col.manifests().findOne({}, { sort: { frozenAt: 1 } });
  if (!existing) await col.manifests().insertOne({ hash, frozenAt: new Date(), cases: (JSON.parse(raw).cases as BenchmarkCase[]).map((c) => ({ id: c.id, split: c.split })) });
  else if (existing.hash !== hash) throw new Error(`benchmark changed after it was frozen (${String(existing.hash).slice(0, 12)} → ${hash.slice(0, 12)}); refusing to compare`);
  return { cases: JSON.parse(raw).cases as BenchmarkCase[], hash };
}

export type CaseRow = {
  r: Pick<EngineerResult, "attempts" | "firstCompileOk" | "costUsd" | "seconds">;
  safety: [number, number];
  /** [passed, total, blocked]: blocked tests are in total and never in passed. */
  tests: [number, number, number];
  satisfaction: number;
};

/** Per-condition scores. Blocked (no-evidence) tests count as not passed and are reported in tests_blocked. */
export function score(results: CaseRow[]): HarnessScores {
  const n = results.length;
  const mean = (f: (x: (typeof results)[number]) => number) => (n ? results.reduce((a, x) => a + f(x), 0) / n : 0);
  const safetyTotal = results.reduce((a, x) => a + x.safety[1], 0);
  const testTotal = results.reduce((a, x) => a + x.tests[1], 0);
  return {
    cases: n,
    requirement_satisfaction: mean((x) => x.satisfaction),
    safety_pass_rate: safetyTotal ? results.reduce((a, x) => a + x.safety[0], 0) / safetyTotal : 1,
    compile_first_try: mean((x) => (x.r.firstCompileOk ? 1 : 0)),
    test_pass_rate: testTotal ? results.reduce((a, x) => a + x.tests[0], 0) / testTotal : 0,
    repairs_per_case: mean((x) => x.r.attempts - 1),
    cost_usd_per_case: mean((x) => x.r.costUsd),
    seconds_per_case: mean((x) => x.r.seconds),
    tests_blocked: results.reduce((a, x) => a + x.tests[2], 0),
  };
}

/** Grades one finished case from its last simulator run (pure; used by runCase and unit tests). */
export function caseRow(r: CaseRow["r"] & { lastSimRun: EngineerResult["lastSimRun"] }, requirements: BoundRequirement[]): CaseRow {
  const results = r.lastSimRun?.results ?? [];
  const safety = results.filter((t) => t.category === "safety");
  const supported = requirements.filter((x) => x.support === "supported").length;
  const verified = (r.lastSimRun?.verdicts ?? []).filter((v) => v.status === "verified").length;
  return {
    r,
    safety: [safety.filter((t) => t.verdict === "passed").length, safety.length],
    tests: [results.filter((t) => t.verdict === "passed").length, results.length, results.filter((t) => t.verdict === "blocked").length],
    satisfaction: supported ? verified / supported : 0,
  };
}

async function runCase(
  c: BenchmarkCase,
  harness: HarnessConfig,
  condition: string,
  scene: SceneDefinition,
  deps: { plc: PlcRuntime; sim: Simulator; rigId: string },
  benchmarkId: string,
  run: { limit: number | null; caseIds: string[]; maxRepairs?: number },
) {
  const config = capRepairs(harness, run.maxRepairs);
  const projectId = newProjectId();
  await col.projects().insertOne({ _id: projectId as never, specText: c.specText, sceneId: scene.id, status: "running", harnessVersion: config.version, origin: "benchmark", benchmarkId, caseId: c.id, condition, createdAt: new Date() });
  const r = await runEngineering({ projectId, jobId: benchmarkId, specText: c.specText, scene, config, heldOut: c.split === "heldout", evaluationRequirements: c.requirements, evaluation: true }, deps);
  const row = caseRow(r, c.requirements);
  await col.benchmarks().insertOne({
    benchmarkId, harnessVersion: config.version, condition, caseId: c.id, split: c.split, projectId,
    limit: run.limit, caseIds: run.caseIds, maxRepairs: run.maxRepairs ?? null, repairBudgetUsed: config.workflow.repair_budget, repairBudgetConfigured: harness.workflow.repair_budget,
    metrics: { satisfaction: row.satisfaction, safety: row.safety, tests: row.tests, blocked: row.tests[2], attempts: r.attempts, firstCompileOk: r.firstCompileOk, costUsd: r.costUsd, seconds: r.seconds, status: r.status }, createdAt: new Date() });
  return row;
}

export const gateSignalName = (verdict: "kept" | "rolled_back") => (verdict === "kept" ? "harness_change_kept" : "harness_change_rolled_back");

export async function runBenchmarkJob(
  args: { jobId: string; candidateVersion?: number; limits?: RunLimits },
  deps: { plc: PlcRuntime; sim: Simulator; rigId: string; loadScene: (id?: string) => Promise<SceneDefinition> },
) {
  const { cases, hash } = await loadFrozenBenchmark();
  const parent = await currentConfig();
  const candidate = args.candidateVersion !== undefined ? await getConfig(args.candidateVersion) : null;
  if (args.candidateVersion !== undefined && (!candidate || candidate.verdict !== "pending")) throw new Error(`candidate v${args.candidateVersion} is not pending`);
  if (candidate && candidate.parent !== parent.version) {
    await recordVerdict(candidate.version, { verdict: "rejected", gateNote: `stale: proposed from v${candidate.parent}, current is v${parent.version}` });
    return { verdict: "rejected", reason: "stale parent" };
  }
  const sel = selectCases(cases, "train", args.limits?.caseLimit, args.limits?.caseIds);
  const { selected: train, total, limit } = sel;
  const maxRepairs = args.limits?.maxRepairs;
  const subset = { limit, caseIds: train.map((c) => c.id), totalCases: total, maxRepairs: maxRepairs ?? null, explicitCases: sel.explicit };
  const run = { limit, caseIds: subset.caseIds, maxRepairs };
  const rows: Record<string, Awaited<ReturnType<typeof runCase>>[]> = { parent: [], candidate: [] };
  for (const c of train) {
    const scene = await deps.loadScene(c.sceneId);
    rows.parent.push(await runCase(c, parent, `v${parent.version}`, scene, deps, args.jobId, run));
    if (candidate) rows.candidate.push(await runCase(c, candidate, `v${candidate.version}`, scene, deps, args.jobId, run));
  }
  const parentScores = score(rows.parent);
  if (!candidate) {
    await col.benchmarks().insertOne({ benchmarkId: args.jobId, kind: "benchmark_summary", manifestHash: hash, split: "train", ...subset, harnessVersion: parent.version, scores: { [`v${parent.version}`]: parentScores }, createdAt: new Date() });
    return { manifestHash: hash, ...subset, parentScores };
  }
  const candidateScores = score(rows.candidate);
  const decision = decide(candidateScores, parentScores);
  // Honest labelling: a limited run says so in the gate note itself, not only in a side field.
  const note = subsetNote(sel, maxRepairs);
  const d = note ? { ...decision, reasons: [...decision.reasons, note] } : decision;
  // ONE transaction: the harness version's verdict (which decides what currentConfig() returns, i.e. which harness
  // every later job runs) and the proposal's verdict shown on the dashboard can never disagree.
  await withTxn(async (session) => {
    await recordVerdict(candidate.version, { verdict: d.verdict, scores: candidateScores, parentScores, gateNote: d.reasons.join("; ") }, session);
    await col.proposals().updateOne({ candidateVersion: candidate.version }, { $set: { verdict: d.verdict, scores: candidateScores, parentScores, gateNote: d.reasons.join("; "), decidedAt: new Date(), manifestHash: hash, benchmarkSubset: subset } }, { session });
  });
  // No interaction is ever begun under `benchmark-<jobId>`, so the signal must name an event explicitly: the meta-agent
  // event that proposed this candidate (otherwise telemetry.signal finds no event and silently drops it).
  const proposal = await col.proposals().findOne({ candidateVersion: candidate.version }, { projection: { metaTraceId: 1 } });
  telemetry.signal({ runId: `benchmark-${args.jobId}`, name: gateSignalName(d.verdict), eventId: (proposal as { metaTraceId?: string | null } | null)?.metaTraceId ?? null, properties: { version: candidate.version, cases: train.length, benchmark_job: args.jobId } });
  return { manifestHash: hash, ...subset, verdict: d.verdict, reasons: d.reasons, parentScores, candidateScores };
}

// --------------------------------------------------------------------------------------------------------
// Ablation: held-out cases only, same model, same scene, same independent grader, three conditions.
//   bare : one-shot generator — no rules, no retrieved lessons/failures, no state machine, no preflight,
//          no repair attempts. A fixed control: never stored as a harness version, never made current.
//   v0   : the baseline harness.
//   vN   : the current kept harness (skipped while it is still v0).
// Rows go to benchmark_runs with condition "ablation:<name>"; the summary row has kind "ablation_summary".
// --------------------------------------------------------------------------------------------------------

export function bareCondition(v0: HarnessConfig): HarnessConfig {
  return {
    ...v0,
    version: -1,
    parent: null,
    rules: [],
    context: { ...v0.context, lessons_k: 0, retrieve_similar_failures: false, failures_k: 0, include_previous_attempt: false },
    workflow: { ...v0.workflow, state_machine_before_code: false, preflight_compile: false, repair_budget: 0 },
    repair: { strategy: "full_rewrite", isolate_failing_requirements: false },
    rationale: "Ablation control: bare one-shot generator (same model routing as v0).",
  };
}

export async function runAblationJob(
  args: { jobId: string; limits?: RunLimits },
  deps: { plc: PlcRuntime; sim: Simulator; rigId: string; loadScene: (id?: string) => Promise<SceneDefinition> },
) {
  const { cases, hash } = await loadFrozenBenchmark();
  const sel = selectCases(cases, "heldout", args.limits?.caseLimit, args.limits?.caseIds);
  const { selected: heldout, total, limit } = sel;
  const maxRepairs = args.limits?.maxRepairs;
  const subset = { limit, caseIds: heldout.map((c) => c.id), totalCases: total, maxRepairs: maxRepairs ?? null, explicitCases: sel.explicit };
  if (!heldout.length) throw new Error("benchmark has no held-out cases");
  const v0 = await getConfig(0);
  if (!v0) throw new Error("harness v0 missing in Atlas; run npm run seed");
  const current = await currentConfig();
  const conditions: [string, HarnessConfig][] = [["bare", bareCondition(v0)], ["v0", v0]];
  if (current.version !== 0) conditions.push([`v${current.version}`, current]);
  const rows: Record<string, Awaited<ReturnType<typeof runCase>>[]> = Object.fromEntries(conditions.map(([k]) => [k, []]));
  for (const c of heldout) {
    const scene = await deps.loadScene(c.sceneId);
    for (const [name, cfg] of conditions) rows[name].push(await runCase(c, cfg, `ablation:${name}`, scene, deps, args.jobId, { limit, caseIds: subset.caseIds, maxRepairs }));
  }
  const scores = Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, score(v)]));
  await col.benchmarks().insertOne({ benchmarkId: args.jobId, kind: "ablation_summary", manifestHash: hash, split: "heldout", ...subset, model: { fast: process.env.MODEL_FAST ?? null, strong: process.env.MODEL_STRONG ?? null }, scores, createdAt: new Date() });
  return { manifestHash: hash, cases: subset.caseIds, ...subset, scores };
}
