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

export function hiddenTestsFor(r: BoundRequirement): TestCase[] {
  const out: TestCase[] = [];
  switch (r.kind) {
    case "start_stop": {
      const [start, stop, act] = [b(r, "start"), b(r, "stop"), b(r, "actuator")];
      if (!start || !stop || !act) break;
      out.push(
        hidden(r, "stop-dominates", "Stop dominates a simultaneous start", "safety", [start, stop, act], [
          { op: "press", tag: stop, holdMs: PRESS_MS },
          { op: "wait", ms: 300 },
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
          { op: "wait", ms: 500 },
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
      break;
    }
    case "fault_latch": {
      const [cause, fault, start, act] = [b(r, "cause"), b(r, "fault_indicator"), b(r, "start"), b(r, "actuator")];
      const timeout = typeof r.params.timeoutMs === "number" ? r.params.timeoutMs : 0;
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
          { op: "wait", ms: 300 },
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
