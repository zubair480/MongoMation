// Unit tests for the test runner's sampler under slow consumers and slow / hung reads (live evidence: ablation
// 6acbe8a8.. was BLOCKED by 0.5-6.6 s sampling holes while Raindrop/OTLP exports were timing out). Uses in-process
// TEST DOUBLE rigs only; demo and benchmark code never import this folder.
import { strict as assert } from "node:assert";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import type { Sample, SceneDefinition, TagValue, TestCase } from "@mongomation/types";
import { executeTest, type ReadOptions, type SimRig } from "../src/index.ts";

const SCENE: SceneDefinition = {
  id: "unit-test-double-sampler",
  factoryIoScene: "TEST DOUBLE (not a Factory I/O scene)",
  title: "Unit test double",
  description: "In-process stand-in used only by unit tests",
  capabilities: [],
  tags: [
    { name: "Start", role: "sensor", dataType: "BOOL", plcAddress: "%IX0.0", kind: "pushbutton", description: "", activeLow: false },
    { name: "Conveyor entry", role: "actuator", dataType: "BOOL", plcAddress: "%QX0.0", kind: "conveyor", description: "", activeLow: false },
  ],
  faults: [],
  timing: { samplePeriodMs: 25, settleMs: 0 },
  setup: { beforeTests: [], afterTests: [] },
  verified: false,
};

const IDLE: TestCase = {
  id: "IDLE",
  title: "idle",
  category: "safety",
  visibility: "public",
  requirementIds: ["R1"],
  observe: ["Conveyor entry"],
  steps: [{ op: "expectStable", tag: "Conveyor entry", value: false, forMs: 1500, label: "idle" }],
};

const maxGap = (s: Sample[]) => s.slice(1).reduce((m, x, i) => Math.max(m, x.t - s[i].t), 0);

/** Answers every read in ~`latencyMs`; reads for which `slow(n)` holds take `slowMs` (or never answer if Infinity). */
class LatencyRig implements SimRig {
  reads = 0;
  lastOpts?: ReadOptions;
  constructor(
    private readonly slow: (n: number) => boolean = () => false,
    private readonly slowMs = 0,
    private readonly latencyMs = 5,
  ) {}
  async read(tags: string[], opts?: ReadOptions): Promise<Record<string, TagValue>> {
    const n = ++this.reads;
    this.lastOpts = opts;
    if (this.slow(n)) {
      if (this.slowMs === Infinity) await new Promise(() => {}); // a hung socket: never answers
      await sleep(this.slowMs);
    } else await sleep(this.latencyMs);
    return Object.fromEntries(tags.map((t) => [t, t === "Conveyor entry" ? false : n]));
  }
  async force() {}
  async release() {}
}

describe("sampler is not stalled by slow telemetry / consumers", () => {
  it("a slow (2 s) telemetry call fired from onSample does not delay the next sample", async () => {
    const telemetryCalls: Promise<void>[] = [];
    let threw = false;
    const exec = await executeTest(new LatencyRig(), SCENE, IDLE, {
      retryBlocked: false,
      onSample: () => {
        // Stand-in for a Raindrop/OTLP export that hangs on a bad uplink; it is fire-and-forget by contract.
        telemetryCalls.push(sleep(2000).then(() => undefined));
        if (!threw) {
          threw = true;
          throw new Error("telemetry exporter blew up"); // must not kill the sampler either
        }
      },
    });
    assert.equal(exec.result.verdict, "passed");
    assert.ok(telemetryCalls.length >= 30, `only ${telemetryCalls.length} samples in ~1.5 s`);
    assert.ok(maxGap(exec.samples) < 150, `sampling stalled for ${maxGap(exec.samples)} ms behind slow telemetry`);
  });
});

describe("sampler hedges slow reads and abandons hung ones", () => {
  it("a single slow read (1.2 s) is hedged: no hole above the grader's 400 ms floor, test PASSES first time", async () => {
    const rig = new LatencyRig((n) => n % 6 === 0, 1200);
    const exec = await executeTest(rig, SCENE, IDLE, { retryBlocked: false });
    assert.ok(maxGap(exec.samples) < 400, `hole of ${maxGap(exec.samples)} ms`);
    assert.equal(exec.result.verdict, "passed");
    assert.equal(exec.attempts, 1);
  });

  it("a slow answer that arrives after a later-sent read was recorded is dropped (no stale data after fresh data)", async () => {
    const rig = new LatencyRig((n) => n % 6 === 0, 400);
    const exec = await executeTest(rig, SCENE, { ...IDLE, observe: ["Conveyor entry", "Start"] }, { retryBlocked: false });
    const seqs = exec.samples.map((s) => s.values.Start as number);
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], `read #${seqs[i]} recorded after #${seqs[i - 1]}`);
    for (let i = 1; i < exec.samples.length; i++) assert.ok(exec.samples[i].t >= exec.samples[i - 1].t);
  });

  it("a read that never answers is abandoned (sample timeout) and sampling continues; reads are fail-fast", async () => {
    const rig = new LatencyRig((n) => n === 3, Infinity);
    const started = performance.now();
    const exec = await executeTest(rig, SCENE, IDLE, { retryBlocked: false, sampleTimeoutMs: 500 });
    assert.ok(performance.now() - started < 5000, "runner hung on a read that never answered");
    assert.ok(maxGap(exec.samples) < 400, `hole of ${maxGap(exec.samples)} ms`);
    assert.equal(exec.result.verdict, "passed");
    assert.deepEqual(rig.lastOpts, { timeoutMs: 500, retries: 0 });
  });

  it("hedging is bounded: at most maxInFlight reads outstanding while the rig is slow", async () => {
    let inFlight = 0;
    let peak = 0;
    const rig: SimRig = {
      async read(tags) {
        peak = Math.max(peak, ++inFlight);
        await sleep(300);
        inFlight--;
        return Object.fromEntries(tags.map((t) => [t, false]));
      },
      async force() {},
      async release() {},
    };
    await executeTest(rig, SCENE, { ...IDLE, steps: [{ op: "expectStable", tag: "Conveyor entry", value: false, forMs: 600, label: "idle" }] }, { retryBlocked: false, maxInFlight: 2, hedgeAfterMs: 100 });
    assert.ok(peak <= 3, `peak ${peak} reads in flight`); // 2 for the current sample + at most 1 straggler being abandoned
  });
});
