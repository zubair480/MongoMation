// Unit tests for the indicator oracle: a lamp is tested against the state the requirement says it shows
// (params.when). Live RSI evidence (sorting-plausibility): "light the Reset light as a fault lamp" was tested as a
// RUN lamp, so a correct latch-driven Reset light failed, and the repair that ORed it with Running broke the
// fault_latch tests instead. Uses an in-process TEST DOUBLE rig only; demo and benchmark code never import this folder.
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { BoundRequirement, SceneDefinition, TagValue } from "@mongomation/types";
import { buildTestPlan, executeTest, type SimRig } from "../src/index.ts";

const sensor = (name: string, activeLow = false) => ({ name, role: "sensor" as const, dataType: "BOOL" as const, plcAddress: "%IX0.0", kind: "pushbutton", description: "", activeLow });
const actuator = (name: string) => ({ name, role: "actuator" as const, dataType: "BOOL" as const, plcAddress: "%QX0.0", kind: "light", description: "", activeLow: false });

const SCENE: SceneDefinition = {
  id: "unit-test-double-lamps",
  factoryIoScene: "TEST DOUBLE (not a Factory I/O scene)",
  title: "Unit test double lamps",
  description: "In-process stand-in used only by unit tests",
  capabilities: [],
  tags: [sensor("Start"), sensor("Stop", true), sensor("Reset"), sensor("High sensor"), sensor("Low sensor"), actuator("Conveyor entry"), actuator("Run light"), actuator("Reset light")],
  faults: [],
  timing: { samplePeriodMs: 25, settleMs: 0 },
  setup: { beforeTests: [], afterTests: [] },
  verified: false,
};

const req = (id: string, kind: BoundRequirement["kind"], bindings: Record<string, string>, params: BoundRequirement["params"] = {}): BoundRequirement => ({
  id,
  kind,
  text: id,
  roles: Object.fromEntries(Object.keys(bindings).map((k) => [k, k])),
  params,
  bindings,
  support: "supported",
});

const FAULT_MS = 300;
const LINE = req("R1", "start_stop", { start: "Start", stop: "Stop", actuator: "Conveyor entry" });
const RUN_LAMP = req("R2", "indicator", { start: "Start", stop: "Stop", indicator: "Run light" });
const FAULT_LAMP = req("R3", "indicator", { indicator: "Reset light", cause: "High sensor", reset: "Reset", start: "Start", actuator: "Conveyor entry" }, { when: "fault", timeoutMs: FAULT_MS });
const FAULT_LATCH = req("R4", "fault_latch", { cause: "High sensor", fault_indicator: "Reset light", reset: "Reset", start: "Start", actuator: "Conveyor entry" }, { timeoutMs: FAULT_MS });
// What the requirements stage produced before the fix: the fault lamp extracted as a run lamp.
const FAULT_LAMP_AS_RUN_LAMP = req("R5", "indicator", { start: "Start", stop: "Stop", indicator: "Reset light" });

/**
 * TEST DOUBLE PLC, scanned every 10 ms: Start/Stop seal-in; the cause (High ON while Low OFF) held for FAULT_MS while running latches a
 * fault that stops the line; Reset clears it only once the cause is gone; no auto-restart. "Run light" = running.
 * "Reset light" follows `resetLight`: "fault" (correct fault lamp) or "fault-or-running" (the bent repair).
 */
class LampDouble implements SimRig {
  private forced = new Map<string, TagValue>();
  private running = false;
  private fault = false;
  private causeSince: number | undefined;
  private timer: NodeJS.Timeout;
  constructor(
    private readonly resetLight: "fault" | "fault-or-running",
    /** Rest value of Low sensor: true stands in for a real tall box covering it (the fault can then never trip unforced). */
    private readonly lowRest = false,
  ) {
    this.timer = setInterval(() => this.scan(), 10);
  }
  private input(tag: string) {
    const rest = tag === "Stop" || (tag === "Low sensor" && this.lowRest);
    return (this.forced.has(tag) ? this.forced.get(tag) : rest) === true;
  }
  private scan() {
    const cause = this.input("High sensor") && !this.input("Low sensor"); // plausibility: High ON while Low OFF
    const now = performance.now();
    this.causeSince = cause ? (this.causeSince ?? now) : undefined;
    if (cause && this.running && now - this.causeSince! >= FAULT_MS) this.fault = true;
    if (this.fault && !cause && this.input("Reset")) this.fault = false;
    if (!this.input("Stop") || this.fault) this.running = false;
    else if (this.input("Start")) this.running = true;
  }
  private value(tag: string): TagValue {
    switch (tag) {
      case "Conveyor entry":
        return this.running;
      case "Run light":
        return this.running;
      case "Reset light":
        return this.resetLight === "fault" ? this.fault : this.fault || this.running;
      default:
        return this.input(tag);
    }
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

async function run(rig: LampDouble, reqs: BoundRequirement[], testId: string) {
  const plan = buildTestPlan(reqs, SCENE, { includeHidden: false });
  const test = plan.tests.find((t) => t.id === testId);
  assert.ok(test, `${testId} planned (have ${plan.tests.map((t) => t.id).join(", ")}; untestable ${JSON.stringify(plan.untestable)})`);
  return (await executeTest(rig, SCENE, test)).result;
}

describe("indicator oracle (params.when)", () => {
  it("(a) a run lamp driven by Running passes the default (when=running) indicator test", async () => {
    const rig = new LampDouble("fault");
    try {
      const result = await run(rig, [LINE, RUN_LAMP], "R2-light");
      assert.equal(result.verdict, "passed", JSON.stringify(result.assertions));
    } finally {
      rig.close();
    }
  });

  it("(b) a latch-driven fault lamp passes the when=fault indicator test AND the fault_latch test", async () => {
    const rig = new LampDouble("fault");
    try {
      for (const id of ["R3-fault-light", "R4-latch"]) {
        const result = await run(rig, [LINE, FAULT_LAMP, FAULT_LATCH], id);
        assert.equal(result.verdict, "passed", `${id}: ${JSON.stringify(result.assertions)}`);
      }
    } finally {
      rig.close();
    }
  });

  it("(b) a fault lamp that also lights while merely running FAILS the when=fault indicator test", async () => {
    const rig = new LampDouble("fault-or-running");
    try {
      const result = await run(rig, [LINE, FAULT_LAMP], "R3-fault-light");
      assert.equal(result.verdict, "failed");
      assert.ok(result.assertions.some((a) => !a.passed && /off with no fault/.test(a.label)), JSON.stringify(result.assertions));
    } finally {
      rig.close();
    }
  });

  it("the old extraction (fault lamp as a run lamp) fails a correct fault lamp: the oracle was wrong, not the code", async () => {
    const rig = new LampDouble("fault");
    try {
      const result = await run(rig, [LINE, FAULT_LAMP_AS_RUN_LAMP], "R5-light");
      assert.equal(result.verdict, "failed");
    } finally {
      rig.close();
    }
  });

  it("a fault lamp with no bound cause, or an unknown `when`, is UNTESTED, never tested as a run lamp", () => {
    const noCause = req("R6", "indicator", { indicator: "Reset light", start: "Start", stop: "Stop" }, { when: "fault" });
    const bogus = req("R7", "indicator", { indicator: "Reset light", start: "Start", stop: "Stop" }, { when: "blinking" });
    const plan = buildTestPlan([LINE, noCause, bogus], SCENE, { includeHidden: false });
    assert.deepEqual(plan.untestable.map((u) => u.requirementId).sort(), ["R6", "R7"]);
    assert.ok(!plan.tests.some((t) => t.requirementIds.includes("R6") || t.requirementIds.includes("R7")));
  });

  it("a lamp bound as fault_indicator with no explicit when is tested as a FAULT lamp", () => {
    const implicit = req("R8", "indicator", { fault_indicator: "Reset light", cause: "High sensor", reset: "Reset", start: "Start" });
    const plan = buildTestPlan([LINE, implicit], SCENE, { includeHidden: false });
    assert.deepEqual(plan.tests.map((t) => t.id), ["R1-start", "R1-stop", "R8-fault-light"]);
  });
});

describe("explicit fault injection (cause_clear)", () => {
  const LATCH_CLEAR = req("R4", "fault_latch", { ...FAULT_LATCH.bindings, cause_clear: "Low sensor" }, { timeoutMs: FAULT_MS });
  const LAMP_CLEAR = req("R3", "indicator", { ...FAULT_LAMP.bindings, cause_clear: "Low sensor" }, { when: "fault", timeoutMs: FAULT_MS });

  it("forces the cause_clear input to its inactive level right before every hold of the cause", () => {
    const plan = buildTestPlan([LINE, LATCH_CLEAR], SCENE, { includeHidden: true });
    const latch = plan.tests.filter((t) => t.requirementIds.includes("R4"));
    assert.ok(latch.length >= 2, "public + hidden fault_latch tests");
    for (const t of latch) {
      const i = t.steps.findIndex((s) => s.op === "hold" && s.tag === "High sensor");
      assert.deepEqual(t.steps[i - 1], { op: "force", tag: "Low sensor", value: false }, t.id);
    }
  });

  it("a scene where Low reads ON (a real tall box) never trips the fault unless Low is forced OFF; with cause_clear a correct latch passes", async () => {
    const rig = new LampDouble("fault", true);
    try {
      const unforced = await run(rig, [LINE, FAULT_LATCH], "R4-latch");
      assert.equal(unforced.verdict, "failed", "without explicit injection the fault cannot be produced");
      for (const id of ["R4-latch", "R3-fault-light"]) {
        const result = await run(rig, [LINE, LATCH_CLEAR, LAMP_CLEAR], id);
        assert.equal(result.verdict, "passed", `${id}: ${JSON.stringify(result.assertions)}`);
      }
    } finally {
      rig.close();
    }
  });
});
