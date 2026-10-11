import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { BoundRequirement, HarnessConfig } from "@mongomation/types";
import { contextBlock, referenceProgramsBlock, type EngineeringContext } from "../src/agents/codegen.ts";
import { buildVerifiedProgram, fullyPassing, memoryEnabled, programsValidator, programsVectorDefinition, requirementsSummary, selectBackfill, type BackfillRun } from "../src/harness/programs.ts";

const saved = process.env.MEMORY_PROGRAMS;
beforeEach(() => delete process.env.MEMORY_PROGRAMS);
afterEach(() => (saved === undefined ? delete process.env.MEMORY_PROGRAMS : (process.env.MEMORY_PROGRAMS = saved)));

const reqs = [
  { id: "R1", kind: "start_stop", text: "Start runs the line; Stop dominates.", roles: { start: "Start button" }, params: {}, bindings: { start: "Start", stop: "Stop", actuator: "Conveyor entry" }, support: "supported" },
  { id: "R2", kind: "estop", text: "E-stop stops everything.", roles: {}, params: {}, bindings: { estop: "Emergency stop" }, support: "supported" },
] as unknown as BoundRequirement[];

const config = { rules: [] } as unknown as HarnessConfig;
const ectx = (extra: Partial<EngineeringContext> = {}): EngineeringContext => ({
  specText: "Automate the sorting station",
  requirements: reqs,
  io: [],
  acceptance: ["R1-start: Pressing Start runs Conveyor entry"],
  lessons: [],
  similarFailures: [],
  ...extra,
});
const ref = { projectId: "p1", score: 0.0327, specText: "Old spec", requirementsSummary: "R1 [start_stop] roles: start=Start", stSource: "PROGRAM main\n  Run := TRUE;\nEND_PROGRAM", tests: { passed: 19, total: 19 } };

describe("verified program memory: flag", () => {
  it("is off by default, on with MEMORY_PROGRAMS=1, and the job option wins", () => {
    assert.equal(memoryEnabled(), false);
    process.env.MEMORY_PROGRAMS = "1";
    assert.equal(memoryEnabled(), true);
    assert.equal(memoryEnabled(undefined), true);
    assert.equal(memoryEnabled(false), false);
    delete process.env.MEMORY_PROGRAMS;
    assert.equal(memoryEnabled(true), true);
  });
});

describe("verified program memory: prompt injection", () => {
  it("adds nothing when memory is off (no references)", () => {
    const text = contextBlock(ectx(), config);
    assert.ok(!text.includes("Verified reference programs"));
    assert.equal(referenceProgramsBlock(undefined), "");
    assert.equal(referenceProgramsBlock([]), "");
  });
  it("injects references with test evidence and the adapt instruction when on", () => {
    const text = contextBlock(ectx({ referencePrograms: [ref] }), config);
    assert.ok(text.includes("## Verified reference programs"));
    assert.ok(text.includes("19/19 tests passed"));
    assert.ok(text.includes("Reuse the proven structure"));
    assert.ok(text.includes("adapt it to the differences"));
    assert.ok(text.includes("Run := TRUE;"));
    assert.ok(text.includes("project p1"));
  });
});

describe("verified program memory: write + backfill selection", () => {
  const run = (passed: number, failed = 0, blocked = 0, extra: Partial<BackfillRun> = {}): BackfillRun => ({ _id: `r${passed}${failed}${blocked}`, passed, failed, blocked, plcVersionId: "v1", split: "train", ...extra });
  it("fullyPassing needs passes and no failures/blocked", () => {
    assert.equal(fullyPassing(run(19)), true);
    assert.equal(fullyPassing(run(18, 1)), false);
    assert.equal(fullyPassing(run(18, 0, 1)), false);
    assert.equal(fullyPassing(run(0)), false);
    assert.equal(fullyPassing(null), false);
  });
  it("selects only projects whose LAST run passed every test on the train split", () => {
    const runs = new Map<string, BackfillRun>([
      ["a", run(19)],
      ["b", run(15)], // partially_verified status but every test passed -> eligible
      ["c", run(10, 2)],
      ["d", run(5, 0, 1)],
      ["e", run(8, 0, 0, { split: "heldout" })],
    ]);
    const picked = selectBackfill(
      [
        { projectId: "A", status: "verified", lastSimRunId: "a", sceneId: "s" },
        { projectId: "B", status: "partially_verified", lastSimRunId: "b", sceneId: "s" },
        { projectId: "C", status: "partially_verified", lastSimRunId: "c", sceneId: "s" },
        { projectId: "D", status: "blocked", lastSimRunId: "d", sceneId: "s" },
        { projectId: "E", status: "verified", lastSimRunId: "e", sceneId: "s" },
        { projectId: "F", status: "running", lastSimRunId: null, sceneId: "s" },
        { projectId: "G", status: "verified", lastSimRunId: "missing", sceneId: "s" },
      ],
      runs,
    );
    assert.deepEqual(picked.map((p) => p.projectId), ["A", "B"]);
    assert.equal(picked[0].plcVersionId, "v1");
  });
  it("stores counts and agent-visible summaries only (no test definitions or ids)", () => {
    const doc = buildVerifiedProgram({ projectId: "A", sceneId: "s", specText: "spec", requirements: reqs, stSource: "src", plcVersionId: "v1", run: { passed: 19, failed: 0, blocked: 0 }, harnessVersion: 0 });
    assert.deepEqual(doc.tests, { passed: 19, total: 19 });
    assert.deepEqual(Object.keys(doc.tests).sort(), ["passed", "total"]);
    assert.deepEqual(doc.requirementKinds, ["start_stop", "estop"]);
    assert.ok(doc.embedText.includes("spec") && doc.embedText.includes("R1 [start_stop]"));
    const json = JSON.stringify(doc);
    assert.ok(!/H-R\d|testIds|verdicts|expect/.test(json), "no hidden test data in memory");
    assert.equal(requirementsSummary(reqs).split("\n").length, 2);
    // the validator pins tests to counts only
    assert.equal(programsValidator.$jsonSchema.properties.tests.additionalProperties, false);
    assert.equal(programsVectorDefinition("voyage-4").fields[0].path, "embedText");
  });
});
