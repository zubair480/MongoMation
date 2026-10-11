import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { HarnessBody, type HarnessConfig } from "@mongomation/types";
import { restoredConfig, SEED_RATIONALE, seedConfig } from "../src/harness/seed.ts";
import { resolveCaseIds, selectCases, subsetNote } from "../src/rsi/evolve.ts";
import { guardrailViolations, stripMeta } from "../src/rsi/guardrails.ts";

const v0 = { ...JSON.parse(readFileSync(new URL("../../../harness/v0.json", import.meta.url), "utf8")), createdAt: "2026-10-11T00:00:00Z" } as HarnessConfig;
const bench = JSON.parse(readFileSync(new URL("../../../specs/benchmark.json", import.meta.url), "utf8")).cases as { id: string; split: "train" | "heldout" }[];

describe("RSI seed harness", () => {
  const seed = seedConfig(v0, 7, "2026-10-11T12:00:00Z");
  it("is the bare one-shot control with repair budget 1, labelled seed, kept", () => {
    assert.deepEqual(seed.rules, []);
    assert.equal(seed.context.lessons_k, 0);
    assert.equal(seed.context.retrieve_similar_failures, false);
    assert.equal(seed.context.include_previous_attempt, false);
    assert.equal(seed.workflow.repair_budget, 1);
    assert.equal(seed.workflow.preflight_compile, false);
    assert.equal(seed.workflow.state_machine_before_code, false);
    assert.equal(seed.workflow.run_regression_tests, true);
    assert.equal(seed.verdict, "kept");
    assert.equal(seed.label, "seed");
    assert.equal(seed.version, 7);
    assert.equal(seed.parent, 0);
    assert.equal(seed.rationale, SEED_RATIONALE);
  });
  it("is schema-valid (HarnessBody, i.e. what the harness_versions validator checks)", () => {
    assert.ok(HarnessBody.safeParse(stripMeta(seed)).success);
  });
  it("a grounded candidate proposed from the seed passes the guardrails", () => {
    const cand = { ...stripMeta(seed), rules: ["Latch the jam alarm until the reset button is pressed and the jam sensor is clear."], workflow: { ...seed.workflow, preflight_compile: true } };
    assert.deepEqual(guardrailViolations(seed, cand, { citedRunIdsExist: true }), []);
  });
  it("restore copies the source body as a new kept version", () => {
    const r = restoredConfig(v0, 9, "2026-10-11T12:00:00Z");
    assert.deepEqual(stripMeta(r), stripMeta(v0));
    assert.equal(r.version, 9);
    assert.equal(r.parent, 0);
    assert.equal(r.restoredFrom, 0);
    assert.equal(r.verdict, "kept");
    assert.equal(r.label, "restore:v0");
  });
});

describe("case selection (--cases / --limit)", () => {
  it("full split by default", () => {
    const s = selectCases(bench, "train");
    assert.deepEqual(s.selected.map((c) => c.id), ["t1-start-stop-light", "t2-estop", "t3-jam-latch", "t4-reset-guard"]);
    assert.equal(s.explicit, null);
    assert.equal(subsetNote(s), null);
  });
  it("--cases picks exactly those (short or full ids), in benchmark order", () => {
    const s = selectCases(bench, "train", undefined, ["t4", "t3-jam-latch"]);
    assert.deepEqual(s.selected.map((c) => c.id), ["t3-jam-latch", "t4-reset-guard"]);
    assert.deepEqual(s.explicit, ["t3-jam-latch", "t4-reset-guard"]);
    assert.equal(s.total, 4);
    const note = subsetNote(s, 1) ?? "";
    assert.match(note, /^subset: t3-jam-latch, t4-reset-guard \(2 of 4 frozen cases; --cases t3-jam-latch,t4-reset-guard\), repairs capped at 1$/);
  });
  it("--limit alone keeps the old first-N behaviour", () => {
    const s = selectCases(bench, "train", 2);
    assert.deepEqual(s.selected.map((c) => c.id), ["t1-start-stop-light", "t2-estop"]);
    assert.match(subsetNote(s) ?? "", /first 2, limit=2/);
  });
  it("rejects unknown and other-split ids", () => {
    assert.throws(() => resolveCaseIds(bench, "train", ["t9"]), /--cases: "t9"/);
    assert.throws(() => resolveCaseIds(bench, "train", ["h1"]), /not a train case/);
    assert.deepEqual(resolveCaseIds(bench, "heldout", ["h1"]), ["h1-interlock"]);
  });
});
