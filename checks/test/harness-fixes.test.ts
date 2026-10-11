// Unit tests for the harness fixes after the first live rig runs (sim runs 6acbd930..c6, 6acbd9d3..97):
// sorting template (line start, classifier polarity, presence), known-state preamble, press length, coverage
// threshold relative to the achieved sample rate, and the single no-evidence retry. Uses in-process TEST DOUBLE
// rigs only; demo and benchmark code never import this folder.
import { strict as assert } from "node:assert";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import type { BoundRequirement, SceneDefinition, TagValue, TestCase } from "@mongomation/types";
import { buildTestPlan, executeTest, gradeTest, PRESS_MS, type SimRig } from "../src/index.ts";
import { maxGapFor } from "../src/grader.ts";

const sensor = (name: string, activeLow = false) => ({ name, role: "sensor" as const, dataType: "BOOL" as const, plcAddress: "%QX12.4", kind: "pushbutton", description: "", activeLow });
const actuator = (name: string) => ({ name, role: "actuator" as const, dataType: "BOOL" as const, plcAddress: "%QX0.0", kind: "conveyor", description: "", activeLow: false });

const SCENE: SceneDefinition = {
  id: "unit-test-double-sorter",
  factoryIoScene: "TEST DOUBLE (not a Factory I/O scene)",
  title: "Unit test double sorter",
  description: "In-process stand-in used only by unit tests",
  capabilities: [],
  tags: [
    sensor("Start"),
    sensor("Stop", true),
    sensor("Reset"),
    sensor("High sensor"),
    sensor("Low sensor"),
    sensor("At left exit", true),
    actuator("Conveyor entry"),
    actuator("Transf. left"),
    actuator("Transf. right"),
    actuator("Reset light"),
  ],
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

const LINE = req("R1", "start_stop", { start: "Start", stop: "Stop", actuator: "Conveyor entry" });
const TALL_RIGHT = req("R3", "sorting", { classifier: "High sensor", diverter: "Transf. right", sensor: "Low sensor" });
const SHORT_LEFT = req("R4", "sorting", { classifier: "High sensor", diverter: "Transf. left", sensor: "Low sensor" }, { classifierValue: false });
const JAM_LATCH = req("R6", "fault_latch", { cause: "At left exit", fault_indicator: "Reset light", reset: "Reset", start: "Start", actuator: "Conveyor entry" });

/**
 * TEST DOUBLE PLC: a sorter that routes only while Running and only when a part is present (Low sensor):
 * tall (High) -> right, short (Low and NOT High) -> left. Scanned every 10 ms. It ignores input changes shorter
 * than `minPulseMs`, standing in for the rig's slow input path. With `inputLagMs` > 0 the logic keeps seeing the
 * PREVIOUS input value for that long after a change (a real PLC's scan/IO latency); tests use it so a reaction
 * cannot land on the exact closing millisecond of the previous step's window, where real timers (which may wake
 * ~1 ms early) and ms rounding of timestamps race the grader's inclusive window bound.
 */
class SorterDouble implements SimRig {
  private forced = new Map<string, TagValue>();
  private since = new Map<string, number>();
  private prev = new Map<string, TagValue>();
  private running = false;
  private timer: NodeJS.Timeout;
  constructor(
    private readonly minPulseMs = 0,
    private readonly inputLagMs = 0,
  ) {
    this.timer = setInterval(() => {
      if (!this.input("Stop")) this.running = false;
      else if (this.input("Start")) this.running = true;
    }, 10);
  }
  /** What the PLC sees: a forced value only once it has been stable for minPulseMs (and inputLagMs has passed). */
  private input(tag: string): boolean {
    const raw = this.raw(tag);
    const age = performance.now() - (this.since.get(tag) ?? 0);
    if (age < this.minPulseMs) return this.rest(tag);
    if (age < this.inputLagMs) return (this.prev.has(tag) ? this.prev.get(tag) : this.rest(tag)) === true;
    return raw === true;
  }
  private changed(tag: string) {
    this.prev.set(tag, this.raw(tag));
    this.since.set(tag, performance.now());
  }
  private rest(tag: string) {
    return tag === "Stop" || tag === "At left exit";
  }
  private raw(tag: string): TagValue {
    return this.forced.has(tag) ? this.forced.get(tag)! : this.rest(tag);
  }
  private value(tag: string): TagValue {
    const part = this.input("Low sensor");
    const tall = this.input("High sensor");
    switch (tag) {
      case "Conveyor entry":
        return this.running;
      case "Transf. right":
        return this.running && part && tall;
      case "Transf. left":
        return this.running && part && !tall;
      case "Reset light":
        return false;
      default:
        return this.raw(tag);
    }
  }
  async read(tags: string[]) {
    return Object.fromEntries(tags.map((t) => [t, this.value(t)]));
  }
  async force(tag: string, value: TagValue) {
    this.changed(tag);
    this.forced.set(tag, value);
  }
  async release(tags: string[]) {
    for (const t of tags) {
      this.changed(t);
      this.forced.delete(t);
    }
  }
  close() {
    clearInterval(this.timer);
  }
}

describe("sorting template", () => {
  it("presses the line Start inherited from the spec's start_stop requirement", () => {
    const plan = buildTestPlan([LINE, TALL_RIGHT], SCENE, { includeHidden: false });
    const t = plan.tests.find((x) => x.id === "R3-divert")!;
    assert.ok(t.steps.some((s) => s.op === "press" && s.tag === "Start"), "sorting test must start the line");
  });

  it("takes the classifier polarity from the requirement (classifierValue=false: NOT detected -> this diverter)", () => {
    const plan = buildTestPlan([LINE, SHORT_LEFT], SCENE, { includeHidden: false });
    const t = plan.tests.find((x) => x.id === "R4-divert")!;
    assert.match(t.title, /not detected by High sensor is diverted by Transf\. left/);
    const holdHigh = t.steps.findIndex((s) => s.op === "hold" && s.tag === "High sensor");
    const releaseHigh = t.steps.findIndex((s) => s.op === "release" && s.tag === "High sensor");
    const expectLeft = t.steps.findIndex((s) => s.op === "expect" && s.tag === "Transf. left" && s.value === true);
    assert.ok(holdHigh >= 0 && holdHigh < releaseHigh && releaseHigh < expectLeft, "tall part first (must not go left), then short part goes left");
  });

  it("a correct presence-aware router passes BOTH lanes; the old template could not (it never started the line)", async () => {
    // 100 ms input lag: the classifier change made right after the 1000 ms "not actuated" window must not be
    // sampled at +1000 ms (inclusive bound) just because a real timer woke ~1 ms early. Well inside RESPONSE_MS.
    const rig = new SorterDouble(0, 100);
    try {
      const plan = buildTestPlan([LINE, TALL_RIGHT, SHORT_LEFT], SCENE, { includeHidden: false });
      for (const id of ["R3-divert", "R4-divert"]) {
        const { result } = await executeTest(rig, SCENE, plan.tests.find((x) => x.id === id)!);
        assert.equal(result.verdict, "passed", `${id}: ${JSON.stringify(result.assertions)}`);
      }
    } finally {
      rig.close();
    }
  });

  it("a router that sends short boxes the wrong way still fails", async () => {
    const wrong = { ...SHORT_LEFT, bindings: { ...SHORT_LEFT.bindings, diverter: "Transf. right" } };
    const rig = new SorterDouble();
    try {
      const plan = buildTestPlan([LINE, wrong], SCENE, { includeHidden: false });
      const { result } = await executeTest(rig, SCENE, plan.tests.find((x) => x.id === "R4-divert")!);
      assert.equal(result.verdict, "failed");
    } finally {
      rig.close();
    }
  });
});

describe("known-state preamble", () => {
  it("every test (public and hidden) starts with Reset then Stop, so a latched fault cannot leak into the next test", () => {
    const plan = buildTestPlan([LINE, JAM_LATCH, TALL_RIGHT], SCENE, { includeHidden: true });
    assert.ok(plan.tests.length >= 4);
    for (const t of plan.tests) {
      const [a, b] = t.steps;
      assert.deepEqual([a.op, a.op === "press" && a.tag, b.op, b.op === "press" && b.tag], ["press", "Reset", "press", "Stop"], t.id);
    }
  });
});

describe("press length", () => {
  it("presses last long enough for the rig's input path (>= 800 ms)", async () => {
    assert.ok(PRESS_MS >= 800);
    // A PLC that needs 600 ms of a stable input (like the live rig) sees our press.
    const rig = new SorterDouble(600);
    try {
      const plan = buildTestPlan([LINE], SCENE, { includeHidden: false });
      const { result } = await executeTest(rig, SCENE, plan.tests.find((x) => x.id === "R1-start")!);
      assert.equal(result.verdict, "passed", JSON.stringify(result.assertions));
    } finally {
      rig.close();
    }
  });
});

describe("coverage threshold relative to the achieved sample rate", () => {
  const stable: TestCase = {
    id: "S",
    title: "s",
    category: "safety",
    visibility: "public",
    requirementIds: ["R1"],
    observe: ["Conveyor entry"],
    steps: [{ op: "expectStable", tag: "Conveyor entry", value: false, forMs: 1500, label: "off" }],
  };
  const log = [{ index: 0, op: "expectStable" as const, startedAt: 0, endedAt: 1500 }];
  const every = (ms: number) => Array.from({ length: Math.floor(1500 / ms) + 1 }, (_, i) => ({ t: i * ms, values: { "Conveyor entry": false } }));

  it("floor 400 ms at a fast cadence, 4x median for a slow gateway, ceiling 800 ms", () => {
    assert.equal(maxGapFor(every(50)), 400);
    assert.equal(maxGapFor(every(150)), 600);
    assert.equal(maxGapFor(every(300)), 800);
  });
  it("a steady 110 ms gateway with an occasional 440 ms hiccup (> the 400 ms floor) is covered; a multi-second stall is still BLOCKED", () => {
    const hiccup = every(110).filter((s) => s.t < 450 || s.t > 800);
    assert.equal(gradeTest(stable, log, hiccup).verdict, "passed");
    const stall = every(50).filter((s) => s.t < 300 || s.t > 1400);
    assert.equal(gradeTest(stable, log, stall).verdict, "blocked");
  });
});

/** Wraps a rig: reads matching `stall(n)` (n = 1-based read count) take 1.2 s, like the gateway stalls seen live. */
class StallingRig implements SimRig {
  reads = 0;
  constructor(
    private readonly inner: SimRig,
    private readonly stall: (n: number) => boolean,
  ) {}
  async read(tags: string[]) {
    this.reads++;
    if (this.stall(this.reads)) await sleep(1200);
    return this.inner.read(tags);
  }
  force(tag: string, value: TagValue) {
    return this.inner.force(tag, value);
  }
  release(tags: string[]) {
    return this.inner.release(tags);
  }
}

describe("single retry of a test BLOCKED for missing evidence", () => {
  const idle: TestCase = {
    id: "I",
    title: "idle",
    category: "safety",
    visibility: "public",
    requirementIds: ["R1"],
    observe: ["Conveyor entry"],
    steps: [{ op: "expectStable", tag: "Conveyor entry", value: false, forMs: 1000, label: "idle" }],
  };

  it("a stall in the first attempt -> one retry; the superseded attempt is returned for the record", async () => {
    const double = new SorterDouble();
    try {
      const rig = new StallingRig(double, (n) => n === 4);
      const exec = await executeTest(rig, SCENE, idle);
      assert.equal(exec.attempts, 2);
      assert.equal(exec.superseded?.result.verdict, "blocked");
      assert.equal(exec.result.verdict, "passed");
    } finally {
      double.close();
    }
  });

  it("a FAILED test (measured violation) is never retried", async () => {
    const double = new SorterDouble();
    try {
      const rig = new StallingRig(double, () => false);
      const running: TestCase = { ...idle, steps: [{ op: "expectStable", tag: "Conveyor entry", value: true, forMs: 500, label: "running" }] };
      const exec = await executeTest(rig, SCENE, running);
      assert.equal(exec.result.verdict, "failed");
      assert.equal(exec.attempts, 1);
      assert.equal(exec.superseded, undefined);
    } finally {
      double.close();
    }
  });

  it("blocked again stays blocked (at most one retry)", async () => {
    const double = new SorterDouble();
    try {
      const rig = new StallingRig(double, (n) => n % 4 === 0);
      const exec = await executeTest(rig, SCENE, idle);
      assert.equal(exec.attempts, 2);
      assert.equal(exec.result.verdict, "blocked");
    } finally {
      double.close();
    }
  });
});
