import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { HarnessConfig, HarnessScores } from "@mongomation/types";
import { decide } from "../src/rsi/gate.ts";
import { configDiff, guardrailViolations, stripMeta } from "../src/rsi/guardrails.ts";
import { caseRow, evidenceResultFilter, measuredProjectsFilter, score } from "../src/rsi/evolve.ts";

const v0 = { ...JSON.parse(readFileSync(new URL("../../../harness/v0.json", import.meta.url), "utf8")), createdAt: "2026-10-11T00:00:00Z" } as HarnessConfig;
const ok = { citedRunIdsExist: true };

describe("guardrails", () => {
  it("accepts a grounded rule addition", () => {
    const c = { ...stripMeta(v0), rules: ["Latch every recoverable fault and clear it only on Reset with the cause gone"] };
    assert.deepEqual(guardrailViolations(v0, c, ok), []);
  });
  it("rejects disabling regression tests and unknown fields", () => {
    const off = { ...stripMeta(v0), workflow: { ...v0.workflow, run_regression_tests: false } };
    assert.ok(guardrailViolations(v0, off, ok).some((x) => x.includes("run_regression_tests")));
    const smuggled = { ...stripMeta(v0), skip_tests: true };
    assert.ok(guardrailViolations(v0, smuggled, ok).length > 0);
  });
  it("rejects rules that silence errors or declare passes", () => {
    for (const rule of ["Skip the jam test when it is flaky", "Mark fault tests as passed if compile succeeds", "Ignore compile errors about timers"]) {
      const c = { ...stripMeta(v0), rules: [rule] };
      assert.ok(guardrailViolations(v0, c, ok).length > 0, rule);
    }
  });
  it("rejects ungrounded and no-op proposals", () => {
    assert.ok(guardrailViolations(v0, stripMeta(v0), ok).some((x) => x.startsWith("no-op")));
    const c = { ...stripMeta(v0), rules: ["Model every recoverable fault as a latched bit with explicit reset logic"] };
    assert.ok(guardrailViolations(v0, c, { citedRunIdsExist: false }).some((x) => x.includes("grounded")));
  });
  it("diffs configs line by line", () => {
    const c = { ...stripMeta(v0), context: { ...v0.context, lessons_k: 5 } };
    assert.deepEqual(configDiff(stripMeta(v0), c), ["~ context.lessons_k: 3 → 5"]);
  });
});

describe("gate", () => {
  const base: HarnessScores = {
    cases: 4, requirement_satisfaction: 0.6, safety_pass_rate: 1, compile_first_try: 0.75, test_pass_rate: 0.7,
    repairs_per_case: 1.5, cost_usd_per_case: 0.2, seconds_per_case: 240,
  };
  it("keeps a real correctness gain", () => {
    assert.equal(decide({ ...base, requirement_satisfaction: 0.8 }, base).verdict, "kept");
  });
  it("rolls back any safety regression even with higher satisfaction", () => {
    assert.equal(decide({ ...base, requirement_satisfaction: 0.9, safety_pass_rate: 0.75 }, base).verdict, "rolled_back");
  });
  it("rolls back noise-level changes", () => {
    assert.equal(decide({ ...base, requirement_satisfaction: 0.62 }, base).verdict, "rolled_back");
  });
  it("refuses to compare different case sets", () => {
    assert.equal(decide({ ...base, cases: 3 }, base).verdict, "rolled_back");
  });
  it("never keeps a change while either side has blocked tests (inconclusive)", () => {
    const d = decide({ ...base, requirement_satisfaction: 0.9, tests_blocked: 0 }, { ...base, tests_blocked: 2 });
    assert.equal(d.verdict, "rolled_back");
    assert.match(d.reasons[0], /^inconclusive: 2 blocked/);
    assert.equal(decide({ ...base, requirement_satisfaction: 0.9, tests_blocked: 1 }, base).verdict, "rolled_back");
    assert.equal(decide({ ...base, requirement_satisfaction: 0.9, tests_blocked: 0 }, { ...base, tests_blocked: 0 }).verdict, "kept");
  });
});

describe("evaluation scoring with blocked tests", () => {
  const reqs = [
    { id: "R1", kind: "start_stop", support: "supported" },
    { id: "R2", kind: "interlock", support: "supported" },
  ] as never;
  // Shape of the real ablation run 6acbe94b (h1-interlock, bare): 4 passed + 2 blocked, R1 verified, R2 blocked.
  const lastSimRun = {
    results: [
      { verdict: "passed", category: "functional" }, { verdict: "passed", category: "functional" },
      { verdict: "passed", category: "safety" }, { verdict: "passed", category: "functional" },
      { verdict: "blocked", category: "safety" }, { verdict: "blocked", category: "functional" },
    ],
    verdicts: [{ requirementId: "R1", status: "verified" }, { requirementId: "R2", status: "blocked" }],
  } as never;
  const r = { attempts: 1, firstCompileOk: true, costUsd: 0.05, seconds: 120, lastSimRun };

  it("an ablation row keeps its results and counts blocked tests as not passed", () => {
    const row = caseRow(r, reqs);
    assert.deepEqual(row.tests, [4, 6, 2]);
    assert.deepEqual(row.safety, [1, 2]);
    assert.equal(row.satisfaction, 0.5);
    const s = score([row]);
    assert.equal(s.cases, 1);
    assert.equal(s.tests_blocked, 2);
    assert.ok(Math.abs(s.test_pass_rate - 4 / 6) < 1e-9);
    assert.equal(s.safety_pass_rate, 0.5);
  });
  it("a fully measured row reports zero blocked tests", () => {
    const clean = { ...r, lastSimRun: { results: [{ verdict: "passed", category: "functional" }], verdicts: [{ requirementId: "R1", status: "verified" }] } as never };
    assert.equal(score([caseRow(clean, reqs)]).tests_blocked, 0);
  });
});

/** Minimal Mongo matcher for the operators the evidence filters use ($ne, $gte, $in, equality). */
function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, cond]) => {
    const v = doc[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      const c = cond as Record<string, unknown>;
      if ("$ne" in c && v === c.$ne) return false;
      if ("$gte" in c && !(v instanceof Date && v.getTime() >= (c.$gte as Date).getTime())) return false;
      if ("$in" in c && !(c.$in as unknown[]).includes(v)) return false;
      return true;
    }
    return v === cond;
  });
}

describe("collectEvidence window", () => {
  const cutoff = new Date("2026-10-11T12:00:00Z");
  const before = new Date("2026-10-11T09:00:00Z");
  const after = new Date("2026-10-11T13:00:00Z");
  const projects = [
    { _id: "p-old", harnessVersion: 3, status: "failed", createdAt: before }, // created before cutoff, fails inside it
    { _id: "p-new", harnessVersion: 3, status: "failed", createdAt: after },
    { _id: "p-stale", harnessVersion: 3, status: "verified", createdAt: before }, // only pre-cutoff evidence
  ];
  const results = [
    { projectId: "p-old", harnessVersion: 3, split: "train", verdict: "failed", startedAt: after },
    { projectId: "p-new", harnessVersion: 3, split: "train", verdict: "failed", startedAt: after },
    { projectId: "p-stale", harnessVersion: 3, split: "train", verdict: "failed", startedAt: before },
    { projectId: "p-stale", harnessVersion: 3, split: "train", verdict: "failed", startedAt: after, superseded: true },
  ];
  const measured = (since?: Date) => {
    const f = evidenceResultFilter(3, since);
    const ids = since ? [...new Set(results.filter((r) => matches(r, f)).map((r) => r.projectId))] : null;
    return projects.filter((p) => matches(p, measuredProjectsFilter(3, ids))).map((p) => p._id).sort();
  };
  it("counts a project created before the cutoff whose failing runs are inside the window", () => {
    assert.deepEqual(measured(cutoff), ["p-new", "p-old"]);
    assert.ok(!("createdAt" in measuredProjectsFilter(3, ["p-old"])));
  });
  it("keeps --evidence-since semantics: pre-cutoff and superseded results are not evidence", () => {
    const f = { ...evidenceResultFilter(3, cutoff), verdict: "failed" };
    assert.deepEqual(results.filter((r) => matches(r, f)).map((r) => r.projectId).sort(), ["p-new", "p-old"]);
  });
  it("without a window, measures every finished project of the version", () => {
    assert.deepEqual(measured(), ["p-new", "p-old", "p-stale"]);
  });
});
