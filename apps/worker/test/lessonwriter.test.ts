import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  changedLines,
  confirmMerge,
  dedupeDecision,
  normalizeTrigger,
  firstFailingAssertion,
  fixedTestIds,
  hiddenStringsOf,
  jaccard,
  leaksHidden,
  LessonDraft,
  lessonDoc,
  lessonPrompt,
  simRunFromEvent,
  SIM_DONE_PIPELINE,
  statusFor,
  type RepairEvidence,
} from "../src/harness/lessonwriter.ts";

const draft: LessonDraft = {
  trigger: "after a fault reset",
  rule: "PLC code must require a new Start rising edge before motion; never auto-restart",
  category: "safety_norm",
  sceneId: "sorting-by-height-basic",
  evidence: { projectId: "p1", testIds: ["R6-latch"], failingAssertion: "Load running: never reached true" },
  goodExample: null,
  badExample: null,
};

const ev: RepairEvidence = {
  projectId: "p1",
  sceneId: "sorting-by-height-basic",
  simRunId: "run2",
  beforeSimRunId: "run1",
  fromVersionId: "v1",
  toVersionId: "v2",
  diagnosisId: "d1",
  diagnosis: "transport gated on sensors",
  diff: "- Q_Load := Running AND I_Box;\n+ Q_Load := Running;",
  fixed: [
    { testId: "R6-latch", visibility: "public", category: "fault_latch", requirementIds: ["R6"], title: "Reset light stays latched", failingAssertion: "Load running: never reached true" },
    { testId: "H-R6-start-without-reset", visibility: "hidden", category: "fault_latch", requirementIds: ["R6"] },
  ],
  hiddenStrings: ["H-R6-start-without-reset", "Start does not bypass a latched fault", "no motion until the fault is reset"],
  rigVerified: true,
};

describe("lesson schema", () => {
  it("accepts a well-formed draft and rejects bad categories / missing fields", () => {
    assert.ok(LessonDraft.safeParse(draft).success);
    assert.equal(LessonDraft.safeParse({ ...draft, category: "vibes" }).success, false);
    const { rule: _r, ...noRule } = draft;
    assert.equal(LessonDraft.safeParse(noRule).success, false);
    assert.ok(LessonDraft.safeParse({ ...draft, goodExample: "IF StartEdge.Q THEN Run := TRUE; END_IF;" }).success);
  });
  it("builds a lessons doc that memory.ts retrieval and the autoEmbed index can use", () => {
    const d = lessonDoc(draft, ev, "active", new Date("2026-10-11T00:00:00Z"));
    assert.equal(d.pattern, draft.trigger);
    assert.equal(d.fix, draft.rule);
    assert.equal(d.text, `${draft.trigger} -> ${draft.rule}`);
    assert.equal(d.active, true);
    assert.equal(d.verified, true);
    assert.equal(d.status, "active");
    assert.equal(d.sceneId, "sorting-by-height-basic");
    assert.equal(d.support, 1);
    assert.deepEqual(d.evidence.testIds, ["R6-latch"]); // hidden tests are counted, never named
    assert.equal(d.evidence.hiddenFixed, 1);
    assert.deepEqual(d.sources[0].testIds, ["R6-latch"]);
    assert.equal(normalizeTrigger("When a fault is reset,"), "a fault is reset");
    assert.equal(d.sources[0].simRunId, "run2");
    const c = lessonDoc(draft, { ...ev, rigVerified: false }, "candidate");
    assert.equal(c.active, false);
    assert.equal(c.verified, false);
    assert.equal(c.status, "candidate");
  });
  it("status: active only when the re-test passed in full", () => {
    assert.equal(statusFor({ failed: 0, blocked: 0 }), "active");
    assert.equal(statusFor({ failed: 1, blocked: 0 }), "candidate");
    assert.equal(statusFor({ failed: 0, blocked: 2 }), "candidate");
  });
});

describe("isolation", () => {
  it("never sends hidden test titles or assertions to the model", () => {
    const p = lessonPrompt(ev);
    for (const h of ev.hiddenStrings.slice(1)) assert.ok(!p.includes(h), `prompt leaked "${h}"`);
    assert.ok(!p.includes("H-R6-start-without-reset"));
    assert.ok(p.includes("a hidden fault_latch check on R6"));
  });
  it("flags a lesson that quotes a hidden test verbatim (case-insensitive)", () => {
    assert.equal(leaksHidden(draft, ev.hiddenStrings), null);
    assert.equal(leaksHidden({ ...draft, rule: "PLC code must ensure START DOES NOT BYPASS A LATCHED FAULT" }, ev.hiddenStrings), "Start does not bypass a latched fault");
    assert.ok(leaksHidden({ ...draft, badExample: "(* H-R6-start-without-reset *)" }, ev.hiddenStrings));
  });
  it("collects hidden strings only from hidden tests", () => {
    const s = hiddenStringsOf([
      { testId: "R1-start", visibility: "public", title: "Pressing Start runs Conveyor entry" },
      { testId: "H-1", visibility: "hidden", title: "Start does not bypass a latched fault", assertions: [{ label: "no motion until the fault is reset" }, { label: "fault on" }] },
    ]);
    assert.deepEqual(s, ["H-1", "Start does not bypass a latched fault", "no motion until the fault is reset"]);
  });
});

describe("dedupe decision", () => {
  it("merges a near-identical lesson in the same plant", () => {
    const d = dedupeDecision(draft, "sorting-by-height-basic", [{ _id: "L1", text: "after a fault reset -> PLC code must require a new Start rising edge before motion, never auto-restart", sceneId: "sorting-by-height-basic" }]);
    assert.equal(d.action, "merge");
    assert.equal((d as { id: unknown }).id, "L1");
  });
  it("merges on high vector similarity even with different wording", () => {
    const d = dedupeDecision(draft, "s", [{ _id: "L2", text: "Once faults are acknowledged the line must wait for the operator", score: 0.95 }]);
    assert.equal(d.action, "merge");
  });
  it("inserts when nothing is close, or the close one belongs to another plant", () => {
    assert.equal(dedupeDecision(draft, "s", [{ _id: "L3", text: "jam timers must be fed from a debounced sensor", score: 0.7 }]).action, "insert");
    assert.equal(dedupeDecision(draft, "sorting-by-height-basic", [{ _id: "L4", text: lessonDocText(), sceneId: "other-plant" }]).action, "insert");
    assert.equal(dedupeDecision(draft, "s", []).action, "insert");
  });
  it("a vector-only merge must be confirmed by the judge; an overlap merge needs none; judge failure appends", async () => {
    const vec = { action: "merge" as const, id: "L2", why: "vector 0.920", other: "lamp shows fault alone" };
    assert.equal((await confirmMerge("x", vec, "r", async () => false)).action, "insert");
    assert.equal((await confirmMerge("x", vec, "r", async () => true)).action, "merge");
    assert.equal((await confirmMerge("x", vec, "r", async () => { throw new Error("api down"); })).action, "insert");
    let called = false;
    const lex = { action: "merge" as const, id: "L1", why: "overlap 0.80" };
    assert.equal((await confirmMerge("x", lex, "r", async () => ((called = true), false))).action, "merge");
    assert.equal(called, false);
  });
  it("token overlap ignores stopwords", () => {
    assert.equal(jaccard("the PLC code must", "a when and"), 0);
    assert.ok(jaccard("fault reset start edge", "start edge after fault reset") > 0.9);
  });
});

const lessonDocText = () => `${draft.trigger} -> ${draft.rule}`;

describe("change-event handling", () => {
  it("the pipeline only matches finished runs", () => {
    const m = JSON.stringify(SIM_DONE_PIPELINE);
    assert.ok(m.includes("updateDescription.updatedFields.status") && m.includes('"done"'));
  });
  it("maps a done update to its sim run id, ignores other updates, skips held-out runs", () => {
    assert.deepEqual(simRunFromEvent({ operationType: "update", documentKey: { _id: "r9" }, updateDescription: { updatedFields: { status: "done" } } }), { simRunId: "r9" });
    assert.deepEqual(simRunFromEvent({ operationType: "update", documentKey: { _id: "r9" }, fullDocument: { _id: "r9", status: "done", split: "train" } }), { simRunId: "r9" });
    assert.equal(simRunFromEvent({ operationType: "update", documentKey: { _id: "r9" }, updateDescription: { updatedFields: { passed: 3 } } }), null);
    assert.equal(simRunFromEvent({ operationType: "insert", documentKey: { _id: "r9" }, fullDocument: { status: "running" } }), null);
    assert.equal(simRunFromEvent({ operationType: "update", documentKey: { _id: "r9" }, fullDocument: { status: "done", split: "heldout" } })?.skip, "held-out run (never writes memory)");
  });
  it("finds tests the repair fixed (failed before, passed after), ignoring superseded attempts", () => {
    const before = [
      { testId: "A", verdict: "failed" },
      { testId: "B", verdict: "failed" },
      { testId: "C", verdict: "passed" },
      { testId: "D", verdict: "failed", superseded: true },
    ];
    const after = [
      { testId: "A", verdict: "passed" },
      { testId: "B", verdict: "failed" },
      { testId: "C", verdict: "passed" },
      { testId: "D", verdict: "passed" },
    ];
    assert.deepEqual(fixedTestIds(before, after), ["A"]);
  });
  it("keeps only the changed lines of the fix, without the version header", () => {
    const diff = "- (* MongoMation p v1 *)\n+ (* MongoMation p v2 *)\n  PROGRAM x\n-   A := B AND C;\n+   A := B;";
    assert.equal(changedLines(diff), "-   A := B AND C;\n+   A := B;");
    assert.equal(firstFailingAssertion([{ label: "ok", passed: true }, { label: "Load running", passed: false, detail: "never true" }]), "Load running: never true");
    assert.equal(firstFailingAssertion([]), undefined);
  });
});
