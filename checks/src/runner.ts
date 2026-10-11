// Executes a TestCase against a live simulation rig while sampling its tags, then grades it.
// The runner only drives sensor-side inputs (buttons, photo-eyes) and observes; it never writes actuators
// and never touches the PLC program. Every force it applies is released in `finally`.
import { setTimeout as sleep } from "node:timers/promises";
import type { Sample, SceneDefinition, StepLog, TagValue, TestCase, TestResult } from "@mongomation/types";import { gradeTest } from "./grader.ts";

/** Per-call options for a sampling read: fail fast, no internal retries (the sampler's next tick / hedge is the retry). */
export interface ReadOptions {
  timeoutMs?: number;
  retries?: number;
}

/** What the validator needs from the simulator. Implemented by the Factory I/O Web API client. */
export interface SimRig {
  read(tags: string[], opts?: ReadOptions): Promise<Record<string, TagValue>>;
  force(tag: string, value: TagValue): Promise<void>;
  release(tags: string[]): Promise<void>;
}

export interface ExecutedTest {
  result: TestResult;
  logs: StepLog[];
  samples: Sample[];
  startedAt: string; // ISO wall clock of t = 0
  /** How many times the test ran (2 only after a first attempt BLOCKED for insufficient measurements). */
  attempts: number;
  /** The first, superseded attempt when a retry happened. */
  superseded?: Omit<ExecutedTest, "attempts" | "superseded">;
}

export interface RunOptions {
  samplePeriodMs?: number;
  /** Called with every sample, for live dashboards. Must not throw. */
  onSample?: (s: Sample) => void;
  now?: () => number;
  /** false disables the single no-evidence retry (default true). */
  retryBlocked?: boolean;
  /** A sample read still unanswered after this long gets a hedge read (default max(150, 3 x period) ms). */
  hedgeAfterMs?: number;
  /** Max reads in flight for one sample, hedges included (default 3); abandoned reads end at sampleTimeoutMs. */
  maxInFlight?: number;
  /** A sample read is abandoned after this long (default 1500 ms); it is never retried, the next tick is. */
  sampleTimeoutMs?: number;
}

/** BLOCKED purely for missing evidence (e.g. a multi-second gateway stall left a window unmeasured). */
export const blockedForMissingEvidence = (r: TestResult) => r.verdict === "blocked" && Boolean(r.blockedReason?.startsWith("insufficient measurements"));

/**
 * Runs a test. A test that ended BLOCKED for insufficient measurements is re-run AT MOST ONCE; a FAILED test
 * (a measured violation), a step error or any other block is never retried, so a defect cannot be retried away,
 * and a test blocked again stays blocked. The superseded first attempt is returned in `superseded` so the caller
 * stores it too (marked superseded) and the record stays complete.
 */
export async function executeTest(rig: SimRig, scene: SceneDefinition, test: TestCase, opts: RunOptions = {}): Promise<ExecutedTest> {
  const first = await executeOnce(rig, scene, test, opts);
  if (opts.retryBlocked === false || !blockedForMissingEvidence(first.result)) return { ...first, attempts: 1 };
  const second = await executeOnce(rig, scene, test, opts);
  return { ...second, attempts: 2, superseded: first };
}

function activeLevel(scene: SceneDefinition, tag: string): boolean {
  const t = scene.tags.find((x) => x.name === tag);
  if (!t) throw new Error(`tag "${tag}" is not in scene ${scene.id}`);
  if (t.role !== "sensor") throw new Error(`tag "${tag}" is an actuator; tests only drive sensors`);
  return !t.activeLow;
}

async function executeOnce(rig: SimRig, scene: SceneDefinition, test: TestCase, opts: RunOptions): Promise<Omit<ExecutedTest, "attempts" | "superseded">> {
  const now = opts.now ?? (() => performance.now());
  const period = opts.samplePeriodMs ?? scene.timing.samplePeriodMs;
  const startedAt = new Date().toISOString();
  const t0 = now();
  const samples: Sample[] = [];
  const logs: StepLog[] = [];
  const touched = new Set<string>();
  let sampling = true;
  let samplerError: string | undefined;

  for (const tag of test.observe) if (!scene.tags.some((t) => t.name === tag)) throw new Error(`observe tag "${tag}" not in scene`);

  // Sampling is decoupled from any single HTTP round trip. Live evidence (ablation 6acbe8a8..): the worker's event
  // loop was never blocked (wait steps ran to +-5 ms), but ~7% of gateway reads took 0.5-0.7 s (laptop uplink
  // jitter, also seen on pings to unrelated hosts) and a few hung for seconds; with one serial read per sample (and
  // 15 s timeout + 2 retries with backoff inside the client) each such read became a 0.5-6.6 s hole in the record.
  // Now: a read unanswered after `hedgeAfterMs` gets a hedge read (bounded in-flight count); the first answer wins;
  // every read is abandoned after `sampleTimeoutMs` with no retry (the next tick is the retry). A response is only
  // recorded if no LATER-sent read was recorded already, so a slow, stale answer never lands after fresher data.
  // Samples are still stamped when the value arrives, exactly as before; the grader is unchanged.
  const hedgeAfterMs = opts.hedgeAfterMs ?? Math.max(150, 3 * period);
  const maxInFlight = Math.max(1, opts.maxInFlight ?? 3);
  const sampleTimeoutMs = opts.sampleTimeoutMs ?? 1500;
  let seq = 0;
  let recordedSeq = 0;
  let closed = false;
  const record = (mySeq: number, values: Record<string, TagValue>) => {
    if (closed || mySeq <= recordedSeq) return;
    recordedSeq = mySeq;
    const s = { t: Math.round(now() - t0), values };
    samples.push(s);
    try {
      opts.onSample?.(s); // fire-and-forget: never awaited, so a slow consumer (telemetry, live feed) cannot stall sampling
    } catch {
      /* onSample must not throw; a throwing consumer must not kill the sampler either */
    }
  };
  /** One sample: resolves when a read (original or hedge) answered, or every launched read failed / timed out. */
  const sampleOnce = () =>
    new Promise<void>((resolve) => {
      let done = false;
      let pending = 0;
      let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(hedgeTimer);
        resolve();
      };
      const launch = () => {
        const mySeq = ++seq;
        pending++;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`sample read timed out after ${sampleTimeoutMs} ms`)), sampleTimeoutMs);
        });
        const read = Promise.resolve().then(() => rig.read(test.observe, { timeoutMs: sampleTimeoutMs, retries: 0 })); // sync throws become rejections
        Promise.race([read, timeout])
          .then(
            (values) => {
              record(mySeq, values);
              finish();
            },
            (err) => {
              samplerError = err instanceof Error ? err.message : String(err);
              if (pending === 1) finish(); // the last outstanding read of this sample failed: go to the next tick
            },
          )
          .finally(() => {
            clearTimeout(timer);
            pending--;
          });
        hedgeTimer = setTimeout(() => {
          // Bounded per sample (abandoned stragglers from earlier samples must not disable hedging; they time out).
          if (!done && pending < maxInFlight) launch();
        }, hedgeAfterMs);
      };
      launch();
    });

  const sampler = (async () => {
    while (sampling) {
      const tick = now();
      await sampleOnce();
      const spent = now() - tick;
      if (spent < period) await sleep(period - spent);
    }
  })();

  const latest = (tag: string) => samples.findLast((s) => s.values[tag] !== undefined)?.values[tag];
  let blockedReason: string | undefined;

  try {
    // Give the sampler one period so every test starts with a measured baseline.
    await sleep(period);
    for (let i = 0; i < test.steps.length; i++) {
      const step = test.steps[i];
      const startedAtMs = Math.round(now() - t0);
      const log: StepLog = { index: i, op: step.op, startedAt: startedAtMs, endedAt: startedAtMs };
      try {
        switch (step.op) {
          case "press": {
            const level = activeLevel(scene, step.tag);
            touched.add(step.tag);
            await rig.force(step.tag, level);
            await sleep(step.holdMs);
            await rig.release([step.tag]);
            touched.delete(step.tag);
            break;
          }
          case "hold":
            touched.add(step.tag);
            await rig.force(step.tag, activeLevel(scene, step.tag));
            break;
          case "force":
            touched.add(step.tag);
            await rig.force(step.tag, step.value);
            break;
          case "release":
            await rig.release([step.tag]);
            touched.delete(step.tag);
            break;
          case "wait":
            await sleep(step.ms);
            break;
          case "expect": {
            // Wait until the condition is observed or the window closes; the grader decides from samples.
            const deadline = now() + step.withinMs;
            while (now() < deadline) {
              const v = latest(step.tag);
              if (v === step.value && samples.at(-1)!.t >= startedAtMs) break;
              await sleep(Math.max(5, Math.floor(period / 2)));
            }
            break;
          }
          case "expectStable":
            await sleep(step.forMs);
            break;
        }
      } catch (err) {
        log.error = err instanceof Error ? err.message : String(err);
      }
      log.endedAt = Math.round(now() - t0);
      logs.push(log);
      if (log.error) break;
    }
    // One more period so the last window has a closing sample.
    await sleep(period);
  } finally {
    sampling = false;
    await sampler;
    closed = true; // late answers from abandoned reads must not land after grading starts
    if (touched.size) {
      try {
        await rig.release([...touched]);
      } catch (err) {
        blockedReason = `cleanup failed to release ${[...touched].join(", ")}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }
  if (samplerError && samples.length === 0) blockedReason = `could not read tags: ${samplerError}`;
  return { result: gradeTest(test, logs, samples, blockedReason), logs, samples, startedAt };
}
