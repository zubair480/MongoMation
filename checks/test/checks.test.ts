// Unit tests for the validator. They use an explicitly labeled TEST DOUBLE rig (a few lines of ladder logic
// simulated in-process) so the grader and runner can be tested without the AWS rig. Demo and benchmark
// code paths never import anything from this folder.
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { BoundRequirement, SceneDefinition, TagValue, TestCase } from "@mongomation/types";
import { buildTestPlan, executeTest, gradeTest, requirementVerdicts, type SimRig } from "../src/index.ts";

const SCENE: SceneDefinition = {
  id: "unit-test-double",
  factoryIoScene: "TEST DOUBLE (not a Factory I/O scene)",
  title: "Unit test double",
  description: "In-process stand-in used only by unit tests",
  capabilities: ["conveyor", "pushbutton"],
  tags: [
    { name: "Start", role: "sensor", dataType: "BOOL", plcAddress: "%IX100.0", kind: "pushbutton", description: "", activeLow: false },
    { name: "Stop", role: "sensor", dataType: "BOOL", plcAddress: "%IX100.1", kind: "pushbutton", description: "", activeLow: true },
    { name: "Conveyor", role: "actuator", dataType: "BOOL", plcAddress: "%QX100.0", kind: "conveyor", description: "", activeLow: false },
  ],
  faults: [],
  timing: { samplePeriodMs: 25, settleMs: 0 },
  setup: { beforeTests: [], afterTests: [] },
  verified: false,
};

/** TEST DOUBLE: start/stop logic scanned every 10 ms. `sealIn: false` reproduces a classic bug. */
class TestDoubleRig implements SimRig {
  private forced = new Map<string, TagValue>();
  private running = false;
  private timer: NodeJS.Timeout;
  constructor(sealIn: boolean) {
    this.timer = setInterval(() => {
      const start = this.value("Start") === true;
      const stop = this.value("Stop") === false; // NC: pressed reads false
      this.running = sealIn ? (this.running || start) && !stop : start && !stop;
    }, 10);
  }
  private value(tag: string): TagValue {
    if (this.forced.has(tag)) return this.forced.get(tag)!;
    if (tag === "Stop") return true;
    if (tag === "Conveyor") return this.running;
    return false;
  }
  async read(tags: string[]) {
    return Object.fromEntries(tags.map((t) => [t, this.value(t)]));
  }
  async force(tag: string, value: TagValue) {
    this.forced.set(tag, value);
  }
  async release(tags: string[]) {
    for (const t of tags) this.forced.delete(t);
  }
  close() {
    clearInterval(this.timer);
  }
}

const REQ: BoundRequirement = {
  id: "R1",
  kind: "start_stop",
  text: "Start runs the conveyor, Stop stops it",
  roles: { start: "start button", stop: "stop button", actuator: "conveyor" },
  params: {},
  bindings: { start: "Start", stop: "Stop", actuator: "Conveyor" },
  support: "supported",
};

describe("grader", () => {
  const test: TestCase = {
    id: "T",
    title: "t",
    category: "start_stop",
    visibility: "public",
    requirementIds: ["R1"],
    observe: ["Conveyor"],
    steps: [{ op: "expect", tag: "Conveyor", value: true, withinMs: 500, label: "on" }],
  };
  const log = [{ index: 0, op: "expect" as const, startedAt: 0, endedAt: 500 }];
  const series = (vals: boolean[]) => vals.map((v, i) => ({ t: i * 100, values: { Conveyor: v } }));

  it("passes on a measured sample that satisfies the assertion", () => {
    assert.equal(gradeTest(test, log, series([false, false, true])).verdict, "passed");
  });
  it("fails when the window is fully measured and never satisfied", () => {
    assert.equal(gradeTest(test, log, series([false, false, false, false, false, false])).verdict, "failed");
  });
  it("is blocked, never passed, without enough measurements", () => {
    assert.equal(gradeTest(test, log, []).verdict, "blocked");
    assert.equal(gradeTest(test, log, [{ t: 0, values: { Conveyor: false } }]).verdict, "blocked");
  });
});

describe("runner + plan against the TEST DOUBLE rig", { concurrency: true }, () => {
  it("a correct seal-in controller passes public and hidden start/stop tests", async () => {
    const rig = new TestDoubleRig(true);
    try {
      const plan = buildTestPlan([REQ], SCENE, { includeHidden: true });
      const results = [];
      for (const t of plan.tests) results.push((await executeTest(rig, SCENE, t)).result);
      for (const r of results) assert.equal(r.verdict, "passed", `${r.testId}: ${JSON.stringify(r.assertions)}`);
      assert.equal(requirementVerdicts([REQ], plan, results)[0].status, "verified");
    } finally {
      rig.close();
    }
  });

  it("a controller without seal-in fails the public start test", async () => {
    const rig = new TestDoubleRig(false);
    try {
      const plan = buildTestPlan([REQ], SCENE, { includeHidden: false });
      const start = plan.tests.find((t) => t.id === "R1-start")!;
      const { result } = await executeTest(rig, SCENE, start);
      assert.equal(result.verdict, "failed");
      assert.ok(result.assertions.some((a) => !a.passed && a.label.includes("keeps running")));
    } finally {
      rig.close();
    }
  });
});

describe("plan", () => {
  it("reports requirements it cannot validate instead of claiming them", () => {
    const seq: BoundRequirement = { ...REQ, id: "R2", kind: "sequence", bindings: {} };
    const bad: BoundRequirement = { ...REQ, id: "R3", bindings: { start: "Start", stop: "Stop", actuator: "Nope" } };
    const plan = buildTestPlan([seq, bad], SCENE, { includeHidden: true });
    assert.equal(plan.tests.length, 0);
    assert.deepEqual(plan.untestable.map((u) => u.requirementId), ["R2", "R3"]);
    const verdicts = requirementVerdicts([seq, bad], plan, []);
    assert.deepEqual(verdicts.map((v) => v.status), ["untested", "untested"]);
  });
});
