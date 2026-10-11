// Targeted re-test for repair rounds. After a repair, re-run first ONLY the tests that failed or were blocked in the
// previous round (their ids are read back from Atlas test_results), iterate repairs on that subset, and run ONE full
// pass on the program that passes it. Correctness is unchanged: a project is only "verified" after a full pass on the
// final program; a full pass that breaks a previously passing test is a regression and counts as a failure.
// Pure control flow (no Atlas, no rig): the caller supplies `exec`, so the loop logic is unit-tested.

export type RetestMode = "targeted" | "full";

/** Job option `targetedRetest: true|false`; absent -> on unless TARGETED_RETEST=0 (cold baselines the old way). */
export function targetedRetestEnabled(opt?: boolean): boolean {
  if (typeof opt === "boolean") return opt;
  const env = (process.env.TARGETED_RETEST ?? "").trim().toLowerCase();
  return !(env === "0" || env === "false" || env === "off");
}

export interface RunLike {
  results: { testId: string; verdict: string }[];
  passed: number;
  failed: number;
  blocked: number;
  /** Tests not run because a repair round stopped early (they still need re-testing). */
  skipped?: string[];
  orderSource?: OrderSource;
  earlyStop?: boolean;
}

export interface RetestRound {
  mode: RetestMode;
  attempt: number;
  tests: number;
  passed: number;
  failed: number;
  blocked: number;
  ms: number;
  simRunId?: string;
  /** Full pass only: tests that passed in the previous full pass and fail now. */
  regressions?: string[];
  /** Experience-ordered testing: how the run was ordered and whether it stopped at the first N failures. */
  orderSource: OrderSource;
  earlyStop: boolean;
  skipped: number;
}

/** Ids worth re-running after a repair: every failed or blocked test of the round, in plan order, de-duplicated. */
export function retestIds(results: RunLike["results"]): string[] {
  return [...new Set(results.filter((r) => r.verdict === "failed" || r.verdict === "blocked").map((r) => r.testId))];
}

/** What the next targeted round must re-run: failed + blocked + tests skipped by an early stop. */
export function nextTargetIds(run: RunLike): string[] {
  return [...new Set([...retestIds(run.results), ...(run.skipped ?? [])])];
}

/** Tests that passed in `previous` and fail in `current`. */
export function regressionsOf(previous: RunLike | null, current: RunLike): string[] {
  if (!previous) return [];
  const passedBefore = new Set(previous.results.filter((r) => r.verdict === "passed").map((r) => r.testId));
  return [...new Set(current.results.filter((r) => r.verdict === "failed" && passedBefore.has(r.testId)).map((r) => r.testId))];
}

export interface TestProgramResult<R extends RunLike> {
  /** The run that decides this attempt: a failing targeted run, or the full pass. */
  run: R;
  mode: RetestMode;
  rounds: RetestRound[];
  /** The full pass of this attempt, if one ran. */
  full: R | null;
  regressions: string[];
}

/**
 * Tests one program. With `targetIds` (non-empty) it runs that subset first; if any of them FAILS, that run decides
 * the attempt (repair on it, no full pass yet). Otherwise (subset passes, or only blocked) it runs the full plan,
 * whose verdict alone may verify the program. Without `targetIds` it runs the full plan directly (old behaviour).
 */
export async function testProgram<R extends RunLike & { simRunId?: string }>(opts: {
  attempt: number;
  targetIds: string[] | null;
  previousFull: R | null;
  exec: (mode: RetestMode, testIds: string[] | null) => Promise<R>;
  now?: () => number;
}): Promise<TestProgramResult<R>> {
  const now = opts.now ?? (() => performance.now());
  const rounds: RetestRound[] = [];
  const round = (mode: RetestMode, run: R, ms: number, regressions?: string[]): RetestRound => ({
    mode,
    attempt: opts.attempt,
    tests: run.results.length,
    passed: run.passed,
    failed: run.failed,
    blocked: run.blocked,
    ms: Math.round(ms),
    ...(run.simRunId && { simRunId: run.simRunId }),
    ...(regressions && { regressions }),
    orderSource: run.orderSource ?? "plan",
    earlyStop: Boolean(run.earlyStop),
    skipped: run.skipped?.length ?? 0,
  });
  if (opts.targetIds?.length) {
    const t0 = now();
    const t = await opts.exec("targeted", opts.targetIds);
    rounds.push(round("targeted", t, now() - t0));
    // A targeted run that stopped early with failures still decides the attempt (repair on what it found).
    if (t.failed > 0) return { run: t, mode: "targeted", rounds, full: null, regressions: [] };
  }
  const t0 = now();
  const f = await opts.exec("full", null);
  const regressions = regressionsOf(opts.previousFull, f);
  rounds.push(round("full", f, now() - t0, regressions));
  return { run: f, mode: "full", rounds, full: f, regressions };
}

// ---- Experience-ordered testing ----------------------------------------------------------------------------------
// The harness learns from its own evidence which tests tend to fail: before a run, tests are ordered by their
// historical failure rate on this scene (Atlas aggregation over test_results, keyed by requirement kind + test
// category), most failure-prone first. A repair round (targeted) can then stop at the first N failures: the rest is
// re-run anyway (next targeted round, and always in the complete final full pass). Full passes never stop early.

export interface FailureStat {
  /** Requirement kind ("" when unknown, e.g. older rows) and test category. */
  kind: string;
  category: string;
  failed: number;
  total: number;
}

export type OrderSource = "atlas-history" | "plan";

/** Failure-rate lookup: kind+category when there is history for it, else the category across kinds, else 0. */
export function failureRateOf(stats: FailureStat[]): (kind: string, category: string) => number {
  const exact = new Map<string, FailureStat>();
  const byCat = new Map<string, { failed: number; total: number }>();
  for (const s of stats) {
    exact.set(`${s.kind}|${s.category}`, s);
    const c = byCat.get(s.category) ?? { failed: 0, total: 0 };
    c.failed += s.failed;
    c.total += s.total;
    byCat.set(s.category, c);
  }
  return (kind, category) => {
    const e = exact.get(`${kind}|${category}`);
    if (e && e.total > 0) return e.failed / e.total;
    const c = byCat.get(category);
    return c && c.total > 0 ? c.failed / c.total : 0;
  };
}

/** Stable sort, highest historical failure rate first; ties keep plan order. Never drops or duplicates a test. */
export function orderByExperience<T extends { category: string }>(tests: T[], kindOf: (t: T) => string, stats: FailureStat[]): { tests: T[]; source: OrderSource } {
  if (!stats.some((s) => s.total > 0)) return { tests: [...tests], source: "plan" };
  const rate = failureRateOf(stats);
  const ordered = tests
    .map((t, i) => ({ t, i, r: rate(kindOf(t), t.category) }))
    .sort((a, b) => b.r - a.r || a.i - b.i)
    .map((x) => x.t);
  return { tests: ordered, source: "atlas-history" };
}

/** Early-stop threshold for repair rounds: env TEST_EARLY_STOP_N (default 3; 0 disables). */
export function earlyStopN(): number {
  const raw = process.env.TEST_EARLY_STOP_N;
  const n = raw === undefined || raw.trim() === "" ? 3 : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Stop the round now? Only with a limit, once `failed` reached it, and only if tests remain. */
export function shouldStopEarly(failed: number, limit: number | undefined, remaining: number): boolean {
  return Boolean(limit && limit > 0 && failed >= limit && remaining > 0);
}
