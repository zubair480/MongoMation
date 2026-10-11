// Targeted re-test + experience-ordered testing: subset selection, loop control flow (targeted -> full, regression),
// flag off = old behaviour, failure-history ordering and early stop. Pure: no Atlas, no rig.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  earlyStopN,
  nextTargetIds,
  orderByExperience,
  regressionsOf,
  retestIds,
  shouldStopEarly,
  targetedRetestEnabled,
  testProgram,
  type RetestMode,
  type RunLike,
  type TestProgramResult,
} from "../src/pipeline/retest.ts";
import { subsetPlan } from "../src/pipeline/validate.ts";

type V = "passed" | "failed" | "blocked";
const run = (verdicts: Record<string, V>, extra: Partial<RunLike> = {}): RunLike & { simRunId: string } => {
  const results = Object.entries(verdicts).map(([testId, verdict]) => ({ testId, verdict }));
  const n = (v: V) => results.filter((r) => r.verdict === v).length;
  return { simRunId: `run-${Object.keys(verdicts).join("")}`, results, passed: n("passed"), failed: n("failed"), blocked: n("blocked"), ...extra };
};

/** Fake rig: returns scripted runs per call and records (mode, ids). */
function fakeExec(script: RunLike[]) {
  const calls: { mode: RetestMode; ids: string[] | null }[] = [];
  const exec = async (mode: RetestMode, ids: string[] | null) => {
    calls.push({ mode, ids });
    const r = script.shift();
    if (!r) throw new Error("unexpected run");
    return r as RunLike & { simRunId?: string };
  };
  return { exec, calls };
}

describe("targeted re-test", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it("flag: default on, TARGETED_RETEST=0 disables, job option wins", () => {
    delete process.env.TARGETED_RETEST;
    assert.equal(targetedRetestEnabled(), true);
    process.env.TARGETED_RETEST = "0";
    assert.equal(targetedRetestEnabled(), false);
    assert.equal(targetedRetestEnabled(true), true);
    delete process.env.TARGETED_RETEST;
    assert.equal(targetedRetestEnabled(false), false);
  });

  it("selects failed + blocked ids (deduplicated) and early-stop leftovers", () => {
    const r = run({ T1: "passed", T2: "failed", H1: "blocked", T3: "passed" }, { skipped: ["T9", "T2"] });
    assert.deepEqual(retestIds(r.results), ["T2", "H1"]);
    assert.deepEqual(nextTargetIds(r), ["T2", "H1", "T9"]);
  });

  it("subsetPlan keeps plan order, the per-test preamble and gets its own hash", () => {
    const pre = { op: "press", tag: "Reset", holdMs: 300 };
    const t = (id: string) => ({ id, title: id, category: "functional", visibility: "public", requirementIds: ["R1"], observe: [], steps: [pre, { op: "wait", ms: id.length }] });
    const plan = { tests: [t("T1"), t("T2"), t("H-T3")], untestable: [], hash: "abc" } as never;
    const sub = subsetPlan(plan, ["H-T3", "T1"]);
    assert.deepEqual(sub.tests.map((x) => x.id), ["T1", "H-T3"]);
    assert.deepEqual(sub.tests[1]!.steps[0], pre);
    assert.notEqual(sub.hash, "abc");
    assert.ok(sub.hash.startsWith("abc:targeted:"));
  });

  it("no target ids -> one full pass (flag off = old behaviour)", async () => {
    const { exec, calls } = fakeExec([run({ T1: "passed", T2: "failed" })]);
    const r = await testProgram({ attempt: 0, targetIds: null, previousFull: null, exec });
    assert.deepEqual(calls, [{ mode: "full", ids: null }]);
    assert.equal(r.mode, "full");
    assert.equal(r.rounds.length, 1);
    assert.equal(r.rounds[0]!.mode, "full");
  });

  it("targeted subset still failing -> decides the attempt, no full pass", async () => {
    const { exec, calls } = fakeExec([run({ T2: "failed" })]);
    const r = await testProgram({ attempt: 1, targetIds: ["T2"], previousFull: null, exec });
    assert.deepEqual(calls, [{ mode: "targeted", ids: ["T2"] }]);
    assert.equal(r.mode, "targeted");
    assert.equal(r.full, null);
  });

  it("targeted passes -> exactly one full pass decides (verification only from a full pass)", async () => {
    const full = run({ T1: "passed", T2: "passed", H1: "passed" });
    const { exec, calls } = fakeExec([run({ T2: "passed" }), full]);
    let clock = 0;
    const r = await testProgram({ attempt: 1, targetIds: ["T2"], previousFull: null, exec, now: () => (clock += 1000) });
    assert.deepEqual(calls.map((c) => c.mode), ["targeted", "full"]);
    assert.equal(r.mode, "full");
    assert.equal(r.run, full);
    assert.deepEqual(r.rounds.map((x) => [x.mode, x.tests, x.passed, x.failed]), [["targeted", 1, 1, 0], ["full", 3, 3, 0]]);
    assert.ok(r.rounds.every((x) => x.ms === 1000));
  });

  it("targeted blocked-only -> goes to the full pass (blocked is never repaired)", async () => {
    const { exec, calls } = fakeExec([run({ T2: "blocked" }), run({ T1: "passed", T2: "passed" })]);
    await testProgram({ attempt: 1, targetIds: ["T2"], previousFull: null, exec });
    assert.deepEqual(calls.map((c) => c.mode), ["targeted", "full"]);
  });

  it("full pass after targeted reveals a regression in a previously passing test -> failure", async () => {
    const previousFull = run({ T1: "passed", T2: "failed", T3: "passed" });
    const { exec } = fakeExec([run({ T2: "passed" }), run({ T1: "failed", T2: "passed", T3: "passed" })]);
    const r = await testProgram({ attempt: 1, targetIds: ["T2"], previousFull, exec });
    assert.equal(r.mode, "full");
    assert.equal(r.run.failed, 1);
    assert.deepEqual(r.regressions, ["T1"]);
    assert.deepEqual(r.rounds[1]!.regressions, ["T1"]);
    assert.deepEqual(nextTargetIds(r.run), ["T1"]); // next targeted round re-tests the regression
    assert.deepEqual(regressionsOf(null, r.run), []);
  });

  it("simulated repair loop: full -> targeted fail -> targeted pass + full pass verifies", async () => {
    const script = [
      run({ T1: "passed", T2: "failed", T3: "failed" }), // attempt 0 full
      run({ T2: "passed", T3: "failed" }), // attempt 1 targeted
      run({ T3: "passed" }), // attempt 2 targeted
      run({ T1: "passed", T2: "passed", T3: "passed" }), // attempt 2 full
    ];
    const { exec, calls } = fakeExec(script);
    let ids: string[] | null = null;
    let lastFull: RunLike | null = null;
    let verified = false;
    for (let attempt = 0; attempt <= 3 && !verified; attempt++) {
      const r: TestProgramResult<RunLike> = await testProgram({ attempt, targetIds: ids, previousFull: lastFull as never, exec });
      if (r.full) lastFull = r.full;
      if (!r.run.failed && r.mode === "full") verified = true;
      else ids = nextTargetIds(r.run);
    }
    assert.ok(verified);
    assert.deepEqual(calls.map((c) => `${c.mode}:${c.ids?.join(",") ?? "*"}`), ["full:*", "targeted:T2,T3", "targeted:T3", "full:*"]);
  });
});

describe("experience-ordered testing", () => {
  const tests = [
    { id: "T1", category: "functional", kind: "start_stop" },
    { id: "T2", category: "safety", kind: "fault_latch" },
    { id: "T3", category: "functional", kind: "sorting" },
    { id: "T4", category: "timing", kind: "sorting" },
  ];
  const kindOf = (t: (typeof tests)[number]) => t.kind;

  it("no history -> plan order, source plan", () => {
    const r = orderByExperience(tests, kindOf, []);
    assert.equal(r.source, "plan");
    assert.deepEqual(r.tests.map((t) => t.id), ["T1", "T2", "T3", "T4"]);
  });

  it("orders by failure rate (kind+category, category fallback), stable, never drops a test", () => {
    const r = orderByExperience(tests, kindOf, [
      { kind: "fault_latch", category: "safety", failed: 9, total: 10 },
      { kind: "sorting", category: "functional", failed: 5, total: 10 },
      { kind: "start_stop", category: "functional", failed: 0, total: 10 },
      { kind: "", category: "timing", failed: 3, total: 10 }, // older rows without kind: category fallback
    ]);
    assert.equal(r.source, "atlas-history");
    assert.deepEqual(r.tests.map((t) => t.id), ["T2", "T3", "T4", "T1"]);
    assert.equal(new Set(r.tests).size, tests.length);
  });

  it("early stop: only with a limit, at N failures, while tests remain", () => {
    assert.equal(shouldStopEarly(3, 3, 2), true);
    assert.equal(shouldStopEarly(2, 3, 2), false);
    assert.equal(shouldStopEarly(3, 3, 0), false);
    assert.equal(shouldStopEarly(9, undefined, 5), false); // full pass: never
    assert.equal(shouldStopEarly(9, 0, 5), false);
  });

  it("early-stop N: default 3, env override, 0 disables", () => {
    const prev = process.env.TEST_EARLY_STOP_N;
    delete process.env.TEST_EARLY_STOP_N;
    assert.equal(earlyStopN(), 3);
    process.env.TEST_EARLY_STOP_N = "2";
    assert.equal(earlyStopN(), 2);
    process.env.TEST_EARLY_STOP_N = "0";
    assert.equal(earlyStopN(), 0);
    if (prev === undefined) delete process.env.TEST_EARLY_STOP_N;
    else process.env.TEST_EARLY_STOP_N = prev;
  });

  it("round records order source and early stop", async () => {
    const early = { ...run({ T2: "failed", T3: "failed", T4: "failed" }), orderSource: "atlas-history" as const, earlyStop: true, skipped: ["T5"] };
    const { exec } = fakeExec([early]);
    const r = await testProgram({ attempt: 1, targetIds: ["T2", "T3", "T4", "T5"], previousFull: null, exec });
    assert.equal(r.rounds[0]!.orderSource, "atlas-history");
    assert.equal(r.rounds[0]!.earlyStop, true);
    assert.equal(r.rounds[0]!.skipped, 1);
    assert.deepEqual(nextTargetIds(r.run), ["T2", "T3", "T4", "T5"]);
  });
});
