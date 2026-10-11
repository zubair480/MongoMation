// Validation of the industrial-practice hidden edge cases (held reset, timer lifecycle, one product = one count).
// For each rule: a CORRECT stand-in PLC passes the new hidden test AND every other test of that requirement, while
// a deliberately WRONG one (the bug the rule is about) passes every PUBLIC test (the public suite is blind to it)
// yet FAILS the new hidden test on the expected assertion. Uses in-process TEST DOUBLE rigs only; demo and
// benchmark code never import this folder.
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { BoundRequirement, SceneDefinition, TagValue, TestResult } from "@mongomation/types";
import { buildTestPlan, executeTest, publicView, type SimRig } from "../src/index.ts";

const sensor = (name: string, activeLow = false) => ({ name, role: "sensor" as const, dataType: "BOOL" as const, plcAddress: "%IX0.0", kind: "pushbutton", description: "", activeLow });
const actuator = (name: string) => ({ name, role: "actuator" as const, dataType: "BOOL" as const, plcAddress: "%QX0.0", kind: "conveyor", description: "", activeLow: false });

const SCENE: SceneDefinition = {
  id: "unit-test-double-edgecases",
  factoryIoScene: "TEST DOUBLE (not a Factory I/O scene)",
  title: "Unit test double conveyor with jam timer, fault latch and part counter",
  description: "In-process stand-in used only by unit tests",
  capabilities: [],
  tags: [sensor("Start"), sensor("Stop", true), sensor("Reset"), sensor("Jam sensor"), sensor("Part sensor"), actuator("Conveyor"), actuator("Fault light")],
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

/** Jam timeout of the double. 3 s is the shortest timeout for which the timer-rearm test is generated. */
const JAM_MS = 3000;
const PARTS = 3;
const LINE = req("R1", "start_stop", { start: "Start", stop: "Stop", actuator: "Conveyor" });
const LATCH = req("R2", "fault_latch", { cause: "Jam sensor", fault_indicator: "Fault light", reset: "Reset", start: "Start", actuator: "Conveyor" }, { timeoutMs: JAM_MS });
const JAM = req("R3", "timer_timeout", { sensor: "Jam sensor", actuator: "Conveyor", fault_indicator: "Fault light", start: "Start", stop: "Stop" }, { timeoutMs: JAM_MS });
const COUNT = req("R4", "counter", { sensor: "Part sensor", actuator: "Conveyor", start: "Start" }, { count: PARTS });
const SPEC = [LINE, LATCH, JAM, COUNT];

interface Flaws {
  /** Level-triggered acknowledge: `IF Reset AND NOT cause THEN fault := FALSE` (instead of R_TRIG(Reset)). */
  levelReset?: boolean;
  /** Retentive jam timer: elapsed time only cleared by Reset, never when the cause clears or the line stops. */
  retentiveTimer?: boolean;
  /** Counts the sensor LEVEL every scan instead of its rising edge. */
  levelCount?: boolean;
}

/**
 * TEST DOUBLE PLC, scanned every 10 ms. Start/Stop seal-in (Stop dominates); Jam sensor ON for JAM_MS while running
 * latches a fault that stops the line and lights the Fault light; Reset (rising edge) clears it only once the jam
 * is gone; no auto-restart. Every rising edge of Part sensor while running counts one part; after PARTS parts the
 * conveyor stops; a new Start clears the count. `flaws` injects exactly one classic bug each.
 */
class LineDouble implements SimRig {
  private forced = new Map<string, TagValue>();
  private running = false;
  private fault = false;
  private jamMs = 0;
  private count = 0;
  private prevReset = false;
  private prevPart = false;
  private last = performance.now();
  private timer: NodeJS.Timeout;
  constructor(private readonly flaws: Flaws = {}) {
    this.timer = setInterval(() => this.scan(), 10);
  }
  private input(tag: string) {
    return (this.forced.has(tag) ? this.forced.get(tag) : tag === "Stop") === true;
  }
  private scan() {
    const now = performance.now();
    const dt = now - this.last;
    this.last = now;
    const [jam, reset, part] = [this.input("Jam sensor"), this.input("Reset"), this.input("Part sensor")];
    const resetEdge = reset && !this.prevReset;
    this.prevReset = reset;

    // Jam timer (TON: IN = jam AND running; elapsed resets when IN is FALSE) or the retentive bug.
    if (this.flaws.retentiveTimer) {
      if (jam && this.running) this.jamMs += dt;
      if (reset) this.jamMs = 0;
    } else this.jamMs = jam && this.running ? this.jamMs + dt : 0;
    if (this.jamMs >= JAM_MS) this.fault = true;

    // Acknowledge: only once the cause is gone; an edge (correct) or a level (bug).
    if (this.fault && !jam && (this.flaws.levelReset ? reset : resetEdge)) this.fault = false;

    if (!this.input("Stop") || this.fault) this.running = false;
    else if (this.input("Start") && !this.running) {
      this.running = true;
      this.count = 0;
    }

    // Counter: R_TRIG on the part sensor (correct) or the level every scan (bug).
    const counted = this.flaws.levelCount ? part : part && !this.prevPart;
    this.prevPart = part;
    if (this.running && counted) this.count++;
    if (this.count >= PARTS) this.running = false;
  }
  private value(tag: string): TagValue {
    if (tag === "Conveyor") return this.running;
    if (tag === "Fault light") return this.fault;
    return this.input(tag);
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

const PLAN = buildTestPlan(SPEC, SCENE, { includeHidden: true });

/** Runs one planned test on a fresh double (tests run concurrently, each on its own PLC). */
async function runOn(flaws: Flaws, testId: string): Promise<TestResult> {
  const test = PLAN.tests.find((t) => t.id === testId);
  assert.ok(test, `${testId} planned (have ${PLAN.tests.map((t) => t.id).join(", ")})`);
  const rig = new LineDouble(flaws);
  try {
    return (await executeTest(rig, SCENE, test)).result;
  } finally {
    rig.close();
  }
}

const testsOf = (r: BoundRequirement, visibility?: "public" | "hidden") =>
  PLAN.tests.filter((t) => t.requirementIds.includes(r.id) && (!visibility || t.visibility === visibility)).map((t) => t.id);

const failedLabels = (r: TestResult) => r.assertions.filter((a) => !a.passed).map((a) => a.label);

/**
 * The proof for one rule: (1) the correct PLC passes every test of the requirement (public, old hidden, new
 * hidden): the new test does not contradict the spec or the other tests; (2) the wrong PLC passes every public
 * test, so only the new hidden test can catch it; (3) it FAILS the new hidden test, on `expectedFailure`.
 */
async function proveRule(r: BoundRequirement, newTest: string, flaw: Flaws, expectedFailure: RegExp) {
  const all = testsOf(r);
  const pub = testsOf(r, "public");
  assert.ok(all.includes(newTest), `${newTest} planned`);
  const [correct, wrongPublic, wrongNew] = await Promise.all([
    Promise.all(all.map((id) => runOn({}, id))),
    Promise.all(pub.map((id) => runOn(flaw, id))),
    runOn(flaw, newTest),
  ]);
  for (const res of correct) assert.equal(res.verdict, "passed", `correct PLC must pass ${res.testId}: ${JSON.stringify(res.assertions)}`);
  for (const res of wrongPublic) assert.equal(res.verdict, "passed", `the flaw is invisible to public ${res.testId}: ${JSON.stringify(res.assertions)}`);
  assert.equal(wrongNew.verdict, "failed", `wrong PLC must fail ${newTest}: ${JSON.stringify(wrongNew.assertions)}`);
  assert.ok(failedLabels(wrongNew).some((l) => expectedFailure.test(l)), `${newTest} fails on ${expectedFailure}, got ${JSON.stringify(failedLabels(wrongNew))}`);
  return wrongNew.assertions.filter((a) => !a.passed).map((a) => `${newTest} FAILED (wrong PLC): ${a.label}: ${a.detail}`);
}

describe("hidden edge cases: generated only where the requirement structure says they apply", () => {
  it("adds held-reset, timer-rearm and single-count to the hidden plan only", () => {
    const ids = PLAN.tests.map((t) => t.id);
    for (const id of ["H-R2-held-reset", "H-R3-timer-rearm", "H-R4-single-count"]) {
      assert.ok(ids.includes(id), id);
      assert.equal(PLAN.tests.find((t) => t.id === id)!.visibility, "hidden");
    }
    const pub = buildTestPlan(SPEC, SCENE, { includeHidden: false });
    assert.ok(!pub.tests.some((t) => t.id.startsWith("H-")), "never in the public plan");
    assert.ok(!JSON.stringify(publicView(PLAN)).includes("held-reset"), "never in the public view");
  });

  it("is NOT generated when the rule does not apply", () => {
    const noReset = req("R2", "fault_latch", { cause: "Jam sensor", fault_indicator: "Fault light", start: "Start", actuator: "Conveyor" });
    const shortTimer = req("R3", "timer_timeout", { ...JAM.bindings }, { timeoutMs: 2000 });
    const oneShot = req("R4", "counter", { ...COUNT.bindings }, { count: 1 });
    const resetGuard = req("R5", "reset_precondition", { ...LATCH.bindings }, { timeoutMs: JAM_MS });
    const ids = buildTestPlan([LINE, noReset, shortTimer, oneShot, resetGuard], SCENE, { includeHidden: true }).tests.map((t) => t.id);
    assert.ok(!ids.some((id) => /held-reset|timer-rearm|single-count/.test(id)), ids.join(", "));
  });

  it("injects the cause_clear force before the held-reset cause hold, like every other cause hold", () => {
    const withClear = req("R2", "fault_latch", { ...LATCH.bindings, cause_clear: "Part sensor" }, { timeoutMs: JAM_MS });
    const t = buildTestPlan([LINE, withClear], SCENE, { includeHidden: true }).tests.find((x) => x.id === "H-R2-held-reset")!;
    const i = t.steps.findIndex((s) => s.op === "hold" && s.tag === "Jam sensor");
    assert.deepEqual(t.steps[i - 1], { op: "force", tag: "Part sensor", value: false });
  });
});

describe("hidden edge cases: a correct PLC passes, the classic wrong one fails", () => {
  it("HELD RESET: level-triggered `IF Reset AND NOT cause` passes the public latch test but fails H-held-reset", async (t) => {
    for (const d of await proveRule(LATCH, "H-R2-held-reset", { levelReset: true }, /still latched when the cause clears under a held Reset/)) t.diagnostic(d);
  });

  it("TIMER LIFECYCLE: a retentive jam timer passes the public jam test but fails H-timer-rearm", async (t) => {
    for (const d of await proveRule(JAM, "H-R3-timer-rearm", { retentiveTimer: true }, /no fault before a full new 3000 ms window/)) t.diagnostic(d);
  });

  it("ONE PRODUCT, ONE COUNT: counting the sensor level passes the public counter test but fails H-single-count", async (t) => {
    for (const d of await proveRule(COUNT, "H-R4-single-count", { levelCount: true }, /keeps running while one part sits on Part sensor/)) t.diagnostic(d);
  });
});
