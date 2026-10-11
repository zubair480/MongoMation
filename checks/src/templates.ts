// Public validation primitives: one template per requirement kind. Each turns a requirement bound to real
// scene tags into deterministic tests with fixed acceptance thresholds. The code generator is told the
// *titles* of public tests (acceptance criteria), never given this file.
import type { BoundRequirement, TestCase, TestStep } from "@mongomation/types";

/** End-to-end latency budget: Factory I/O -> Modbus poll -> PLC scan -> Modbus -> Factory I/O. */
export const RESPONSE_MS = 1500;
/**
 * How long a push button is held (and a passing part blocks a sensor). Live rig evidence (sim runs 6acbd930..c6,
 * 6acbd9d3..97): 400-700 ms presses of Start/Stop/Reset were visible on the Factory I/O tag yet never reached the
 * PLC through the Factory I/O -> Modbus -> OpenPLC path, while >= 1.5 s holds always did. A real operator press
 * also lasts a good fraction of a second, so 1 s is both physically plausible and inside the rig's input latency.
 */
export const PRESS_MS = 1000;

export type Template = (r: BoundRequirement) => TestCase[];

const need = (r: BoundRequirement, ...roles: string[]) => {
  const missing = roles.filter((role) => !r.bindings[role]);
  if (missing.length) throw new UnbindableRequirement(r.id, `missing role(s) ${missing.join(", ")}`);
  return roles.map((role) => r.bindings[role]);
};

export class UnbindableRequirement extends Error {
  constructor(
    readonly requirementId: string,
    reason: string,
  ) {
    super(`${requirementId}: ${reason}`);
  }
}

const num = (r: BoundRequirement, key: string, fallback: number) => {
  const v = r.params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
};

const tc = (r: BoundRequirement, suffix: string, title: string, category: TestCase["category"], observe: string[], steps: TestStep[]): TestCase => ({
  id: `${r.id}-${suffix}`,
  title,
  category,
  visibility: "public",
  requirementIds: [r.id],
  observe: [...new Set(observe)],
  steps,
});

/** Brings the machine to a known stopped state before a test. */
const stopFirst = (stop?: string): TestStep[] => (stop ? [{ op: "press", tag: stop, holdMs: PRESS_MS }, { op: "wait", ms: 500 }] : []);

/** Fault detection is usually armed only while running: start the machine first when the spec has a start. */
export const startIfBound = (r: BoundRequirement): TestStep[] => {
  const start = r.bindings.start;
  const act = r.bindings.actuator;
  if (!start) return [];
  return [{ op: "press", tag: start, holdMs: PRESS_MS }, ...(act ? [{ op: "expect", tag: act, value: true, withinMs: RESPONSE_MS, label: `${act} running` } as TestStep] : [{ op: "wait", ms: 500 } as TestStep])];
};

export const PUBLIC_TEMPLATES: Partial<Record<BoundRequirement["kind"], Template>> = {
  start_stop: (r) => {
    const [start, stop, act] = need(r, "start", "stop", "actuator");
    return [
      tc(r, "start", `Pressing ${start} runs ${act}`, "start_stop", [start, stop, act], [
        ...stopFirst(stop),
        { op: "expectStable", tag: act, value: false, forMs: 1000, label: `${act} idle before start` },
        { op: "press", tag: start, holdMs: PRESS_MS },
        { op: "expect", tag: act, value: true, withinMs: RESPONSE_MS, label: `${act} on after start` },
        { op: "expectStable", tag: act, value: true, forMs: 1500, label: `${act} keeps running after start is released` },
      ]),
      tc(r, "stop", `Pressing ${stop} stops ${act}`, "start_stop", [start, stop, act], [
        ...stopFirst(stop),
        { op: "press", tag: start, holdMs: PRESS_MS },
        { op: "expect", tag: act, value: true, withinMs: RESPONSE_MS, label: `${act} on after start` },
        { op: "press", tag: stop, holdMs: PRESS_MS },
        { op: "expect", tag: act, value: false, withinMs: RESPONSE_MS, label: `${act} off after stop` },
        { op: "expectStable", tag: act, value: false, forMs: 1000, label: `${act} stays off after stop` },
      ]),
    ];
  },

  run_until_sensor: (r) => {
    const [act, sensor] = need(r, "actuator", "sensor");
    const start = r.bindings.start;
    const stop = r.bindings.stop;
    return [
      tc(r, "arrive", `${act} stops when ${sensor} detects a part`, "sensor_transition", [act, sensor, ...(start ? [start] : [])], [
        ...stopFirst(stop),
        ...(start ? [{ op: "press", tag: start, holdMs: PRESS_MS } as TestStep] : []),
        { op: "expect", tag: act, value: true, withinMs: RESPONSE_MS, label: `${act} running` },
        { op: "hold", tag: sensor },
        { op: "expect", tag: act, value: false, withinMs: RESPONSE_MS, label: `${act} off when ${sensor} is on` },
        { op: "release", tag: sensor },
      ]),
    ];
  },

  sensor_actuator: (r) => {
    const [sensor, act] = need(r, "sensor", "actuator");
    const delay = num(r, "delayMs", 0);
    const want = r.params.actuatorValue === false ? false : true;
    return [
      tc(r, "follow", `${act} responds to ${sensor}`, "sensor_transition", [sensor, act], [
        { op: "expectStable", tag: act, value: !want, forMs: 800, label: `${act} at rest` },
        { op: "hold", tag: sensor },
        { op: "expect", tag: act, value: want, withinMs: delay + RESPONSE_MS, label: `${act} = ${want} after ${sensor}` },
        { op: "release", tag: sensor },
      ]),
    ];
  },

  interlock: (r) => {
    const [act, blocker] = need(r, "actuator", "blocker");
    const start = r.bindings.start;
    const stop = r.bindings.stop;
    return [
      tc(r, "block", `${act} stops while ${blocker} is active`, "interlock", [act, blocker, ...(start ? [start] : [])], [
        ...stopFirst(stop),
        ...(start ? [{ op: "press", tag: start, holdMs: PRESS_MS } as TestStep] : []),
        { op: "expect", tag: act, value: true, withinMs: RESPONSE_MS, label: `${act} running` },
        { op: "hold", tag: blocker },
        { op: "expect", tag: act, value: false, withinMs: RESPONSE_MS, label: `${act} off while ${blocker} active` },
        { op: "expectStable", tag: act, value: false, forMs: 1500, label: `${act} held off by interlock` },
        { op: "release", tag: blocker },
      ]),
    ];
  },

  timer_timeout: (r) => {
    const [sensor, act] = need(r, "sensor", "actuator");
    const timeout = num(r, "timeoutMs", 5000);
    const fault = r.bindings.fault_indicator;
    const start = r.bindings.start;
    const stop = r.bindings.stop;
    return [
      tc(r, "jam", `A ${sensor} blocked longer than ${timeout} ms stops ${act}${fault ? ` and lights ${fault}` : ""}`, "timer", [sensor, act, ...(fault ? [fault] : []), ...(start ? [start] : [])], [
        ...stopFirst(stop),
        ...(start ? [{ op: "press", tag: start, holdMs: PRESS_MS } as TestStep] : []),
        { op: "expect", tag: act, value: true, withinMs: RESPONSE_MS, label: `${act} running` },
        { op: "hold", tag: sensor },
        { op: "expect", tag: act, value: false, withinMs: timeout + RESPONSE_MS, label: `${act} off after timeout` },
        ...(fault ? [{ op: "expect", tag: fault, value: true, withinMs: RESPONSE_MS, label: `${fault} on after timeout` } as TestStep] : []),
        { op: "release", tag: sensor },
      ]),
    ];
  },

  fault_latch: (r) => {
    const [cause, fault, reset] = need(r, "cause", "fault_indicator", "reset");
    const timeout = num(r, "timeoutMs", 0);
    return [
      tc(r, "latch", `${fault} stays latched after the cause clears, until ${reset}`, "fault_latch", [cause, fault, reset, ...Object.values(r.bindings)], [
        ...startIfBound(r),
        { op: "hold", tag: cause },
        { op: "expect", tag: fault, value: true, withinMs: timeout + RESPONSE_MS, label: `${fault} on` },
        { op: "release", tag: cause },
        { op: "expectStable", tag: fault, value: true, forMs: 2000, label: `${fault} latched after cause cleared` },
        { op: "press", tag: reset, holdMs: PRESS_MS },
        { op: "expect", tag: fault, value: false, withinMs: RESPONSE_MS, label: `${fault} cleared by ${reset}` },
      ]),
    ];
  },

  reset_precondition: (r) => {
    const [cause, fault, reset] = need(r, "cause", "fault_indicator", "reset");
    const timeout = num(r, "timeoutMs", 0);
    return [
      tc(r, "guard", `${reset} does not clear ${fault} while the cause is still present`, "reset_condition", [cause, fault, reset, ...Object.values(r.bindings)], [
        ...startIfBound(r),
        { op: "hold", tag: cause },
        { op: "expect", tag: fault, value: true, withinMs: timeout + RESPONSE_MS, label: `${fault} on` },
        { op: "press", tag: reset, holdMs: PRESS_MS },
        { op: "expectStable", tag: fault, value: true, forMs: 1500, label: `${fault} still on while cause present` },
        { op: "release", tag: cause },
        { op: "press", tag: reset, holdMs: PRESS_MS },
        { op: "expect", tag: fault, value: false, withinMs: RESPONSE_MS, label: `${fault} cleared once cause is gone` },
      ]),
    ];
  },

  no_auto_restart: (r) => {
    const [start, act, reset, cause] = need(r, "start", "actuator", "reset", "cause");
    const timeout = num(r, "timeoutMs", 0);
    return [
      tc(r, "restart", `After a fault reset ${act} waits for ${start}`, "recovery", [start, act, reset, cause], [
        { op: "press", tag: start, holdMs: PRESS_MS },
        { op: "expect", tag: act, value: true, withinMs: RESPONSE_MS, label: `${act} running` },
        { op: "hold", tag: cause },
        { op: "expect", tag: act, value: false, withinMs: timeout + RESPONSE_MS, label: `${act} stopped by fault` },
        { op: "release", tag: cause },
        { op: "press", tag: reset, holdMs: PRESS_MS },
        { op: "expectStable", tag: act, value: false, forMs: 2000, label: `${act} does not restart by itself` },
        { op: "press", tag: start, holdMs: PRESS_MS },
        { op: "expect", tag: act, value: true, withinMs: RESPONSE_MS, label: `${act} restarts on ${start}` },
      ]),
    ];
  },

  estop: (r) => {
    const [estop, act] = need(r, "estop", "actuator");
    const start = r.bindings.start;
    return [
      tc(r, "estop", `Emergency stop de-energizes ${act}`, "safety", [estop, act, ...(start ? [start] : [])], [
        ...(start ? [{ op: "press", tag: start, holdMs: PRESS_MS } as TestStep] : []),
        { op: "expect", tag: act, value: true, withinMs: RESPONSE_MS, label: `${act} running` },
        { op: "press", tag: estop, holdMs: 1500 },
        { op: "expect", tag: act, value: false, withinMs: 1000, label: `${act} off on e-stop` },
      ]),
    ];
  },

  indicator: (r) => {
    const [start, stop, light] = need(r, "start", "stop", "indicator");
    return [
      tc(r, "light", `${light} shows the running state`, "state_transition", [start, stop, light], [
        ...stopFirst(stop),
        { op: "expectStable", tag: light, value: false, forMs: 800, label: `${light} off when stopped` },
        { op: "press", tag: start, holdMs: PRESS_MS },
        { op: "expect", tag: light, value: true, withinMs: RESPONSE_MS, label: `${light} on when running` },
        { op: "press", tag: stop, holdMs: PRESS_MS },
        { op: "expect", tag: light, value: false, withinMs: RESPONSE_MS, label: `${light} off after stop` },
      ]),
    ];
  },

  counter: (r) => {
    const [sensor, act] = need(r, "sensor", "actuator");
    const n = Math.max(1, Math.min(10, Math.round(num(r, "count", 3))));
    const start = r.bindings.start;
    const steps: TestStep[] = [...(start ? [{ op: "press", tag: start, holdMs: PRESS_MS } as TestStep] : [])];
    steps.push({ op: "expect", tag: act, value: true, withinMs: RESPONSE_MS, label: `${act} running` });
    for (let i = 0; i < n; i++) steps.push({ op: "hold", tag: sensor }, { op: "wait", ms: PRESS_MS }, { op: "release", tag: sensor }, { op: "wait", ms: PRESS_MS });
    steps.push({ op: "expect", tag: act, value: false, withinMs: RESPONSE_MS, label: `${act} off after ${n} parts` });
    return [tc(r, "count", `${act} stops after ${n} parts pass ${sensor}`, "state_transition", [sensor, act, ...(start ? [start] : [])], steps)];
  },

  // Routing: parts of ONE class (classifier active, or with classifierValue=false NOT active, e.g. "short boxes =
  // high sensor off -> left") go to `diverter`; parts of the other class must not. Both classes are presented
  // with the line running (start pressed when the spec has one) and, when bound, the part-presence `sensor`
  // held, because a real short box is "presence on, classifier off", not "no box at all".
  sorting: (r) => {
    const [classifier, diverter] = need(r, "classifier", "diverter");
    const { start, stop, sensor: presence } = r.bindings;
    const when = classifierValue(r);
    const selectClass: TestStep = when ? { op: "hold", tag: classifier } : { op: "release", tag: classifier };
    const otherClass: TestStep = when ? { op: "release", tag: classifier } : { op: "hold", tag: classifier };
    const part = when ? `A part detected by ${classifier}` : `A part not detected by ${classifier}`;
    const other = when ? `a part not detected by ${classifier}` : `a part detected by ${classifier}`;
    return [
      tc(r, "divert", `${part} is diverted by ${diverter}`, "sensor_transition", [classifier, diverter, ...(presence ? [presence] : []), ...(start ? [start] : [])], [
        ...stopFirst(stop),
        // Present the other class first and let it reach the PLC before the line starts, so a correct router
        // never sees an unclassified instant.
        ...(presence ? [{ op: "hold", tag: presence } as TestStep] : []),
        otherClass,
        { op: "wait", ms: PRESS_MS },
        ...(start ? [{ op: "press", tag: start, holdMs: PRESS_MS } as TestStep] : []),
        { op: "expectStable", tag: diverter, value: false, forMs: 1000, label: `${diverter} not actuated for ${other}` },
        selectClass,
        { op: "expect", tag: diverter, value: true, withinMs: num(r, "delayMs", 0) + RESPONSE_MS, label: `${diverter} actuates for a part ${when ? "" : "not "}detected by ${classifier}` },
        { op: "release", tag: classifier },
        ...(presence ? [{ op: "release", tag: presence } as TestStep] : []),
      ]),
    ];
  },
};

/** Which classifier state selects this route. Default true; `false` (or "false") means NOT detected by it. */
export function classifierValue(r: BoundRequirement): boolean {
  const v = r.params.classifierValue;
  return !(v === false || (typeof v === "string" && v.trim().toLowerCase() === "false"));
}
