// Engineering agent, step 2: match each requirement's roles to REAL tags of the selected Factory I/O scene.
// The model may only choose from the scene's tag list (or say UNSUPPORTED); the result is then checked
// deterministically (tag exists, sensor vs actuator direction fits the role). Anything that fails the check
// is reported as unsupported — never silently "fixed".
import type { BoundRequirement, ControlRequirements, HarnessConfig, SceneDefinition } from "@mongomation/types";
import { z } from "zod";
import { complete } from "../tools/llm.ts";

/** Roles that must be PLC inputs (sensors/buttons) vs PLC outputs (actuators/lights). */
export const SENSOR_ROLES = new Set(["start", "stop", "reset", "estop", "sensor", "blocker", "cause", "cause_clear", "classifier"]);
export const ACTUATOR_ROLES = new Set(["actuator", "diverter", "fault_indicator", "indicator"]);

const Binding = z.object({
  requirementId: z.string(),
  supported: z.boolean(),
  reason: z.string(),
  bindings: z.array(z.object({ role: z.string(), tag: z.string() })),
});
const BinderOutput = z.object({ results: z.array(Binding) });

export function sceneSummary(scene: SceneDefinition) {
  return scene.tags
    .map((t) => `- "${t.name}" (${t.role === "sensor" ? "PLC input" : "PLC output"}, ${t.dataType}, ${t.kind}${t.activeLow ? ", active-low: FALSE when pressed/blocked" : ""})${t.description ? `: ${t.description}` : ""}`)
    .join("\n");
}

export async function bindRequirements(reqs: ControlRequirements, scene: SceneDefinition, config: HarnessConfig, runId: string) {
  const call = await complete({
    agent: "binder",
    tier: config.routing.requirements,
    system: `You map control requirements onto the real equipment of a Factory I/O scene.
Use ONLY tag names from the list, spelled exactly. Input roles (${[...SENSOR_ROLES].join(", ")}) must map to PLC inputs;
output roles (${[...ACTUATOR_ROLES].join(", ")}) must map to PLC outputs. If the scene has no suitable equipment for a
role, mark the requirement unsupported and say what is missing. Do not stretch a tag to mean something it is not.`,
    user: `Scene "${scene.title}" (${scene.factoryIoScene}) tags:\n${sceneSummary(scene)}\n\nRequirements:\n${JSON.stringify(reqs.requirements, null, 2)}`,
    schema: BinderOutput,
    runId,
  });
  return { ...call, data: checkBindings(reqs, scene, call.data.results) };
}

/** Deterministic check of the model's mapping. Exported for unit tests. */
export function checkBindings(reqs: ControlRequirements, scene: SceneDefinition, results: z.infer<typeof Binding>[]): BoundRequirement[] {
  return reqs.requirements.map((r) => {
    const res = results.find((x) => x.requirementId === r.id);
    if (!res) return { ...r, bindings: {}, support: "unsupported", unsupportedReason: "binder returned no mapping" };
    if (!res.supported) return { ...r, bindings: {}, support: "unsupported", unsupportedReason: res.reason };
    const bindings: Record<string, string> = {};
    for (const { role, tag } of res.bindings) {
      const t = scene.tags.find((x) => x.name === tag);
      if (!t) return { ...r, bindings: {}, support: "unsupported", unsupportedReason: `tag "${tag}" does not exist in ${scene.id}` };
      if (SENSOR_ROLES.has(role) && t.role !== "sensor")
        return { ...r, bindings: {}, support: "unsupported", unsupportedReason: `role ${role} needs a PLC input but "${tag}" is an output` };
      if (ACTUATOR_ROLES.has(role) && t.role !== "actuator")
        return { ...r, bindings: {}, support: "unsupported", unsupportedReason: `role ${role} needs a PLC output but "${tag}" is an input` };
      bindings[role] = tag;
    }
    return { ...r, bindings, support: "supported" };
  });
}
