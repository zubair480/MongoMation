// HIDDEN regression and safety tests. Never shown to the code generator, the critic, the meta-agent,
// retrieval, Raindrop prompts or the dashboard's agent context. Only `plan.ts` imports this file.
// `npm run verify:isolation` fails the build if anything under apps/worker/src/agents or src/rsi imports it.
//
// They probe the same requirement from a different angle than the public test, the way a commissioning
// engineer would: simultaneous commands, conditions present before start, near-miss timings.
import type { BoundRequirement, TestCase, TestStep } from "@mongomation/types";
import { PRESS_MS, RESPONSE_MS, startIfBound } from "../templates.ts";

const hidden = (r: BoundRequirement, suffix: string, title: string, category: TestCase["category"], observe: string[], steps: TestStep[]): TestCase => ({
  id: `H-${r.id}-${suffix}`,
  title,
  category,
  visibility: "hidden",
  requirementIds: [r.id],
  observe: [...new Set(observe)],
  steps,
});

const b = (r: BoundRequirement, role: string) => r.bindings[role];

/** "Already active before start" must really have reached the PLC: the rig's input path needs up to ~1 s. */
const SETTLE_INPUT_MS = PRESS_MS;

export function hiddenTestsFor(r: BoundRequirement): TestCase[] {
  const out: TestCase[] = [];
  switch (r.kind) {
    case "start_stop": {
      const [start, stop, act] = [b(r, "start"), b(r, "stop"), b(r, "actuator")];
      if (!start || !stop || !act) break;
      out.push(
        hidden(r, "stop-dominates", "Stop dominates a simultaneous start", "safety", [start, stop, act], [
          { op: "press", tag: stop, holdMs: PRESS_MS },
          { op: "wait", ms: SETTLE_INPUT_MS },
          { op: "hold", tag: stop },
          { op: "hold", tag: start },
          { op: "expectStable", tag: act, value: false, forMs: 1200, label: "no motion while start and stop are both pressed" },
          { op: "release", tag: start },
          { op: "release", tag: stop },
        ]),
        hidden(r, "no-motion-at-rest", "No motion without a start command", "safety", [act], [
          { op: "press", tag: stop, holdMs: PRESS_MS },
          { op: "expectStable", tag: act, value: false, forMs: 2500, label: "actuator idle with no command" },
        ]),
      );
      break;
    }
    case "interlock": {
      const [act, blocker, start] = [b(r, "actuator"), b(r, "blocker"), b(r, "start")];
      if (!act || !blocker || !start) break;
      out.push(
        hidden(r, "blocked-before-start", "Start is refused while the interlock is already active", "interlock", [act, blocker, start], [
          { op: "hold", tag: blocker },
          { op: "wait", ms: SETTLE_INPUT_MS },
          { op: "press", tag: start, holdMs: PRESS_MS },
          { op: "expectStable", tag: act, value: false, forMs: 2000, label: "no motion into a blocked downstream" },
          { op: "release", tag: blocker },
        ]),
      );
      break;
    }
    case "timer_timeout": {
      const [sensor, act, start] = [b(r, "sensor"), b(r, "actuator"), b(r, "start")];
      const timeout = typeof r.params.timeoutMs === "number" ? r.params.timeoutMs : 5000;
      if (!sensor || !act) break;
      out.push(
        hidden(r, "no-false-trip", "A normal part transit shorter than the timeout does not trip the fault", "timer", [sensor, act, ...(start ? [start] : [])], [
          ...(start ? [{ op: "press", tag: start, holdMs: PRESS_MS } as TestStep] : []),
          { op: "expect", tag: act, value: true, withinMs: RESPONSE_MS, label: "running" },
          { op: "hold", tag: sensor },
          { op: "wait", ms: Math.round(timeout * 0.4) },
          { op: "release", tag: sensor },
          { op: "expectStable", tag: act, value: true, forMs: 1500, label: "still running after a short transit" },
        ]),
      );
      const rearm = timerRearmTest(r);
      if (rearm) out.push(rearm);
      break;
    }
    case "counter": {
      const single = singleCountTest(r);
      if (single) out.push(single);
      break;
    }
    case "fault_latch": {
      const [cause, fault, start, act] = [b(r, "cause"), b(r, "fault_indicator"), b(r, "start"), b(r, "actuator")];
      const timeout = typeof r.params.timeoutMs === "number" ? r.params.timeoutMs : 0;
      const held = heldResetTest(r);
      if (held) out.push(held);
      if (!cause || !fault || !start || !act) break;
      out.push(
        hidden(r, "start-without-reset", "Start does not bypass a latched fault", "fault_latch", [cause, fault, start, act], [
          ...startIfBound(r),
          { op: "hold", tag: cause },
          { op: "expect", tag: fault, value: true, withinMs: timeout + RESPONSE_MS, label: "fault on" },
          { op: "release", tag: cause },
          { op: "press", tag: start, holdMs: PRESS_MS },
          { op: "expectStable", tag: act, value: false, forMs: 1500, label: "no motion until the fault is reset" },
        ]),
      );
      break;
    }
    case "estop": {
      const [estop, act, start] = [b(r, "estop"), b(r, "actuator"), b(r, "start")];
      if (!estop || !act || !start) break;
      out.push(
        hidden(r, "estop-held", "Start is ignored while the emergency stop is held", "safety", [estop, act, start], [
          { op: "hold", tag: estop },
          { op: "wait", ms: SETTLE_INPUT_MS },
          { op: "press", tag: start, holdMs: PRESS_MS },
          { op: "expectStable", tag: act, value: false, forMs: 1500, label: "no motion with e-stop held" },
          { op: "release", tag: estop },
        ]),
      );
      break;
    }
    default:
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Industrial-practice edge cases a commissioning engineer checks and a generator easily misses. Each one is
// generated ONLY when the requirement's own structure says the rule applies, and none of them changes what the
// customer specified: they only pin down HOW an already-specified behaviour must react to real operator timing.
// ---------------------------------------------------------------------------------------------

const numParam = (r: BoundRequirement, key: string, fallback: number) => {
  const v = r.params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
};

/**
 * HELD RESET (PLCopen SF_EmergencyStop / SF_ResetButton practice: a reset is a command EDGE, not a level). A Reset
 * pressed and HELD while the cause is still present must not clear the latch the moment the cause disappears:
 * acknowledging a fault needs a fresh Reset press once the cause is gone. Level-triggered `IF Reset AND NOT cause`
 * clears it behind the operator's back (a jammed button or a taped-down Reset would make the latch useless).
 * Requires a fault_latch that binds cause, fault_indicator and reset.
 * Deliberately NO assertion between "release Reset" and the new press: some correct designs (PLCopen falling-edge
 * reset detection) acknowledge on the release, which is a fresh operator action after the cause is gone.
 */
export function heldResetTest(r: BoundRequirement): TestCase | undefined {
  if (r.kind !== "fault_latch") return undefined;
  const [cause, fault, reset, start, act] = [b(r, "cause"), b(r, "fault_indicator"), b(r, "reset"), b(r, "start"), b(r, "actuator")];
  if (!cause || !fault || !reset) return undefined;
  const timeout = numParam(r, "timeoutMs", 0);
  return hidden(r, "held-reset", `A ${reset} held from before the cause cleared does not clear ${fault}; a fresh ${reset} does`, "reset_condition", [cause, fault, reset, ...(start ? [start] : []), ...(act ? [act] : [])], [
    ...startIfBound(r),
    { op: "hold", tag: cause },
    { op: "expect", tag: fault, value: true, withinMs: timeout + RESPONSE_MS, label: `${fault} on` },
    ...(act ? [{ op: "expect", tag: act, value: false, withinMs: RESPONSE_MS, label: `${act} stopped by the fault` } as TestStep] : []),
    { op: "hold", tag: reset },
    { op: "wait", ms: SETTLE_INPUT_MS }, // the held Reset reaches the PLC while the cause is still present
    { op: "release", tag: cause },
    { op: "expectStable", tag: fault, value: true, forMs: 2000, label: `${fault} still latched when the cause clears under a held ${reset}` },
    ...(act ? [{ op: "expectStable", tag: act, value: false, forMs: 500, label: `${act} still off under a held ${reset}` } as TestStep] : []),
    { op: "release", tag: reset },
    { op: "wait", ms: SETTLE_INPUT_MS },
    { op: "press", tag: reset, holdMs: PRESS_MS },
    { op: "expect", tag: fault, value: false, withinMs: RESPONSE_MS, label: `${fault} cleared by a fresh ${reset} press` },
    ...(act ? [{ op: "expectStable", tag: act, value: false, forMs: 1000, label: `${act} waits for a new start after the reset` } as TestStep] : []),
  ]);
}

/**
 * TIMER LIFECYCLE (IEC 61131-3 TON: elapsed time resets when IN goes FALSE). A jam timer must not carry elapsed
 * time across a cleared cause and a stop/start: hold the cause for ~80% of the timeout, clear it, stop and
 * restart, re-apply it, and the fault must not trip before a full new window. A retentive accumulator (TONR-like
 * `t := t + dt` without a reset) trips after the remaining ~20%. Requires a timer_timeout with a sensor and
 * actuator and a timeout long enough to leave a 1 s margin on both sides for the rig's input latency.
 */
export function timerRearmTest(r: BoundRequirement): TestCase | undefined {
  if (r.kind !== "timer_timeout") return undefined;
  const [sensor, act, start, stop, fault] = [b(r, "sensor"), b(r, "actuator"), b(r, "start"), b(r, "stop"), b(r, "fault_indicator")];
  if (!sensor || !act) return undefined;
  const timeout = numParam(r, "timeoutMs", 5000);
  // ~80% of the window, but never closer than PRESS_MS to it: the rig's input path may stretch the hold by ~1 s.
  const first = Math.round(Math.min(timeout * 0.8, timeout - PRESS_MS));
  if (first < 2 * PRESS_MS) return undefined; // too short a timeout to separate "carried over" from rig latency
  const restart: TestStep[] =
    start && stop
      ? [
          { op: "press", tag: stop, holdMs: PRESS_MS },
          { op: "wait", ms: 500 },
          { op: "press", tag: start, holdMs: PRESS_MS },
          { op: "expect", tag: act, value: true, withinMs: RESPONSE_MS, label: `${act} running again after restart` },
        ]
      : [{ op: "wait", ms: PRESS_MS + 500 }];
  return hidden(r, "timer-rearm", `The ${sensor} timeout restarts from zero after the cause clears${start && stop ? " and the line restarts" : ""}`, "timer", [sensor, act, ...(start ? [start] : []), ...(stop ? [stop] : []), ...(fault ? [fault] : [])], [
    ...(start ? [{ op: "press", tag: start, holdMs: PRESS_MS } as TestStep] : []),
    { op: "expect", tag: act, value: true, withinMs: RESPONSE_MS, label: `${act} running` },
    { op: "hold", tag: sensor },
    { op: "wait", ms: first },
    { op: "release", tag: sensor },
    { op: "expectStable", tag: act, value: true, forMs: 500, label: `no fault after ${first} ms of a ${timeout} ms timeout` },
    ...restart,
    { op: "hold", tag: sensor },
    { op: "expectStable", tag: act, value: true, forMs: timeout - PRESS_MS, label: `no fault before a full new ${timeout} ms window (elapsed time not carried over)` },
    { op: "expect", tag: act, value: false, withinMs: PRESS_MS + RESPONSE_MS, label: `${act} off once the new window expires` },
    ...(fault ? [{ op: "expect", tag: fault, value: true, withinMs: RESPONSE_MS, label: `${fault} on after the new window` } as TestStep] : []),
    { op: "release", tag: sensor },
  ]);
}

/**
 * ONE PRODUCT, ONE COUNT (R_TRIG counting). A part that stays on the sensor for many scans is ONE part: counting
 * the level adds one per scan and reaches N on the first part. Hold one part for 3 s (hundreds of scans), then
 * pass the remaining parts normally: the actuator must keep running until exactly the N-th part. Requires a
 * counter with sensor and actuator and N >= 2 (with N = 1 a level counter is indistinguishable).
 */
export function singleCountTest(r: BoundRequirement): TestCase | undefined {
  if (r.kind !== "counter") return undefined;
  const [sensor, act, start] = [b(r, "sensor"), b(r, "actuator"), b(r, "start")];
  if (!sensor || !act) return undefined;
  const n = Math.max(1, Math.min(10, Math.round(numParam(r, "count", 3)))); // same clamp as the public counter template
  if (n < 2) return undefined;
  const pass: TestStep[] = [{ op: "hold", tag: sensor }, { op: "wait", ms: PRESS_MS }, { op: "release", tag: sensor }, { op: "wait", ms: PRESS_MS }];
  return hidden(r, "single-count", `A part held on ${sensor} for many scans counts once`, "state_transition", [sensor, act, ...(start ? [start] : [])], [
    ...(start ? [{ op: "press", tag: start, holdMs: PRESS_MS } as TestStep] : []),
    { op: "expect", tag: act, value: true, withinMs: RESPONSE_MS, label: `${act} running` },
    { op: "hold", tag: sensor },
    { op: "expectStable", tag: act, value: true, forMs: 3000, label: `${act} keeps running while one part sits on ${sensor}` },
    { op: "release", tag: sensor },
    { op: "wait", ms: PRESS_MS },
    ...Array.from({ length: n - 2 }, () => pass).flat(),
    { op: "expectStable", tag: act, value: true, forMs: 1000, label: `${act} still running after ${n - 1} part(s)` },
    { op: "hold", tag: sensor },
    { op: "wait", ms: PRESS_MS },
    { op: "release", tag: sensor },
    { op: "expect", tag: act, value: false, withinMs: RESPONSE_MS, label: `${act} off after exactly ${n} parts` },
  ]);
}
