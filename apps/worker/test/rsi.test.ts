import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { HarnessConfig, HarnessScores } from "@mongomation/types";
import { decide } from "../src/rsi/gate.ts";
import { configDiff, guardrailViolations, stripMeta } from "../src/rsi/guardrails.ts";

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
});
