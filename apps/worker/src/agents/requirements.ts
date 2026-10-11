// Engineering agent, step 1: read a natural-language specification into structured, testable control
// requirements. Scene-agnostic on purpose: what the customer asked for is recorded even when no registered
// scene can validate it (the binder marks those UNSUPPORTED instead of dropping them).
//
// LLM-facing schemas are deliberately loose (no records, no regexes): structured outputs force
// additionalProperties:false, so maps are sent as arrays and converted. Strict validation happens after.
import { ControlRequirements, RequirementKind, type HarnessConfig } from "@mongomation/types";
import { z } from "zod";
import { complete } from "../tools/llm.ts";

export const ROLE_GUIDE = `Requirement kinds and the role keys each one uses (use exactly these keys):
- start_stop: start, stop, actuator   (start/stop are operator pushbuttons; stop dominates start)
- run_until_sensor: actuator, sensor, optional start, stop   (actuator runs until the sensor detects a part)
- sensor_actuator: sensor, actuator   params: delayMs?, actuatorValue? (true|false)
- interlock: actuator, blocker, optional start, stop   (actuator must be off while blocker is active, e.g. downstream full/jammed)
- timer_timeout: sensor, actuator, optional fault_indicator, start, stop   params: timeoutMs   (sensor stuck too long = jam/fault)
- fault_latch: cause, fault_indicator, reset, optional start, actuator   params: timeoutMs?
- reset_precondition: cause, fault_indicator, reset   params: timeoutMs?
- no_auto_restart: start, actuator, reset, cause   params: timeoutMs?
- estop: estop, actuator, optional start
- indicator: start, stop, indicator
- counter: sensor, actuator, optional start   params: count
- sorting: classifier, diverter   params: delayMs?
- sequence, mode, other: describe roles freely (these may not be automatically testable)
Role values are the equipment names as the specification describes them (e.g. "upstream conveyor", "jam photo-eye").`;

const SYSTEM = `You are a senior controls engineer. You turn a customer's natural-language automation specification
into a precise list of testable control requirements for an IEC 61131-3 PLC program.

Rules:
- One requirement per observable behaviour. Split compound sentences.
- Give each requirement an id R1, R2, ... in the order they appear in the spec.
- Make implied industrial conventions explicit only when the spec clearly implies them (e.g. "start/stop buttons"
  implies a seal-in circuit where stop dominates; "jam protection" implies a timeout fault that stops the conveyor).
- Never invent equipment the spec does not mention. Put non-testable wishes (documentation, HMI styling) in notes.
- Timing values: use the spec's numbers; if a timeout is required but unspecified, use 5000 ms and say so in the text.

${ROLE_GUIDE}`;

const RequirementsOut = z.object({
  summary: z.string(),
  equipment: z.array(z.string()),
  operatingStates: z.array(z.string()),
  requirements: z.array(
    z.object({
      id: z.string(),
      kind: RequirementKind,
      text: z.string(),
      roles: z.array(z.object({ role: z.string(), equipment: z.string() })),
      params: z.array(z.object({ name: z.string(), value: z.union([z.number(), z.string(), z.boolean()]) })),
    }),
  ),
  notes: z.array(z.string()),
});

export function toControlRequirements(out: z.infer<typeof RequirementsOut>): ControlRequirements {
  return ControlRequirements.parse({
    summary: out.summary,
    equipment: out.equipment,
    operatingStates: out.operatingStates,
    notes: out.notes,
    requirements: out.requirements.map((r) => ({
      id: r.id,
      kind: r.kind,
      text: r.text,
      roles: Object.fromEntries(r.roles.map((x) => [x.role, x.equipment])),
      params: Object.fromEntries(r.params.map((p) => [p.name, p.value])),
    })),
  });
}

export async function extractRequirements(specText: string, config: HarnessConfig, runId: string) {
  const call = await complete({
    agent: "requirements",
    tier: config.routing.requirements,
    system: SYSTEM,
    user: `Specification:\n"""\n${specText}\n"""`,
    schema: RequirementsOut,
    runId,
  });
  return { ...call, data: toControlRequirements(call.data) };
}
