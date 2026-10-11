// Engineering agent, steps 3-4: (optional) state machine, then Structured Text logic. Also the repairer.
// Context is assembled only from agent-visible sources: spec, requirements, I/O table, PUBLIC acceptance
// criteria, harness rules, retrieved lessons and observed failure feedback. Hidden tests never appear here.
import type { BoundRequirement, HarnessConfig, IoPoint } from "@mongomation/types";
import { z } from "zod";
import { complete } from "../tools/llm.ts";
import { ALLOWED_TYPES } from "../pipeline/st.ts";

export interface EngineeringContext {
  specText: string;
  requirements: BoundRequirement[];
  io: IoPoint[];
  /** Titles of public acceptance tests, e.g. "R1-start: Pressing Start runs Entry conveyor". */
  acceptance: string[];
  lessons: { pattern: string; fix: string }[];
  similarFailures: string[];
  stateMachine?: StateMachine;
  /** Mid-project spec change: the previously verified program. Evolve it; keep verified behaviour intact. */
  baselineSource?: string;
  /** Verified Program Memory (MEMORY_PROGRAMS=1): closest programs that passed ALL their rig tests. Counts only. */
  referencePrograms?: ReferenceProgram[];
}

export interface ReferenceProgram {
  projectId: string;
  score: number;
  specText: string;
  requirementsSummary: string;
  stSource: string;
  tests: { passed: number; total: number };
}

/** Prompt section for verified reference programs (empty string when there are none). */
export function referenceProgramsBlock(refs: ReferenceProgram[] | undefined): string {
  if (!refs?.length) return "";
  const items = refs.map(
    (r, i) =>
      `### Reference ${i + 1} (project ${r.projectId}, similarity ${r.score.toFixed(4)}): VERIFIED on the real rig, ${r.tests.passed}/${r.tests.total} tests passed\nIts specification:\n${r.specText}\nIts requirements:\n${r.requirementsSummary}\nIts verified program:\n${r.stSource}`,
  );
  return `## Verified reference programs (proven on the real rig for similar specifications)
Reuse the proven structure of the closest reference (state handling, seal-in/latch patterns, timers, fault handling, output
assignment) and adapt it to the differences in THIS specification, requirements and I/O table. Use only the I/O variables
declared above; requirements that differ from the reference must follow this specification, not the reference.
${items.join("\n\n")}`;
}

export const StateMachine = z.object({
  states: z.array(z.object({ name: z.string(), outputs: z.array(z.string()), description: z.string() })).min(1),
  initial: z.string(),
  transitions: z.array(z.object({ from: z.string(), to: z.string(), condition: z.string(), requirementIds: z.array(z.string()) })),
});
export type StateMachine = z.infer<typeof StateMachine>;

const Logic = z.object({
  variables: z.array(
    z.object({
      name: z.string(),
      type: z.enum(ALLOWED_TYPES),
      initial: z.string().nullable(),
      comment: z.string().nullable(),
    }),
  ),
  body: z.string().min(1),
  explanation: z.string(),
});

const ST_DIALECT = `Target: OpenPLC (IEC 61131-3 Structured Text compiled by STruC++ for OpenPLC Runtime v4). Write ONLY:
1) "variables": internal variables (types: ${ALLOWED_TYPES.join(", ")}). Do NOT redeclare I/O variables; they exist already.
2) "body": the statements inside PROGRAM ... END_PROGRAM. No PROGRAM/VAR/CONFIGURATION keywords in the body.
Conventions:
- Every scan: compute next state, then assign every output exactly once at the end of the body.
- Timers are function block instances: declare e.g. JamTimer : TON; call JamTimer(IN := cond, PT := T#5000ms); use JamTimer.Q.
- Edge detection: declare StartEdge : R_TRIG; StartEdge(CLK := I_Start); use StartEdge.Q.
- Inputs marked active-low read FALSE when active: NC Stop/E-stop buttons read TRUE when NOT pressed ("stop pressed" is NOT I_Stop), and retroreflective photo-eyes read FALSE when a part blocks them ("part present" is NOT I_AtLeftExit).
- Use := for assignment, = for comparison, (* comments *). No WHILE/REPEAT loops.
- Never use IEC keywords as names (STEP, TRANSITION, ACTION, INTERVAL, ON, AT, TASK...): e.g. use StepNo, not Step.
- Compare like types only (INT with INT, REAL with REAL); convert with INT_TO_REAL / REAL_TO_INT when needed.
- Outputs must be FALSE in any stopped or faulted state unless a requirement says otherwise.`;

export function contextBlock(ctx: EngineeringContext, config: HarnessConfig) {
  const io = ctx.io.map((p) => `- ${p.variable} : ${p.dataType} = "${p.tag}" (${p.role === "sensor" ? "input" : "output"}${p.activeLow ? ", active-low: FALSE when pressed/blocked" : ""})`).join("\n");
  const reqs = ctx.requirements
    .map((r) => (r.support === "supported" ? `- ${r.id} [${r.kind}] ${r.text} (roles: ${JSON.stringify(r.bindings)}; params: ${JSON.stringify(r.params)})` : `- ${r.id} UNSUPPORTED on this scene: ${r.text}`))
    .join("\n");
  const parts = [
    `## Specification\n${ctx.specText}`,
    `## Requirements\n${reqs}`,
    `## I/O table (already declared)\n${io}`,
    `## Acceptance criteria that will be measured on the simulator\n${ctx.acceptance.map((a) => `- ${a}`).join("\n")}`,
  ];
  if (config.rules.length) parts.push(`## Engineering rules (mandatory)\n${config.rules.map((r) => `- ${r}`).join("\n")}`);
  if (ctx.lessons.length) parts.push(`## Lessons from verified past projects\n${ctx.lessons.map((l) => `- When ${l.pattern}: ${l.fix}`).join("\n")}`);
  if (ctx.similarFailures.length) parts.push(`## Failures seen on similar projects\n${ctx.similarFailures.map((f) => `- ${f}`).join("\n")}`);
  const refs = referenceProgramsBlock(ctx.referencePrograms);
  if (refs) parts.push(refs);
  if (ctx.stateMachine) parts.push(`## Verified state machine (implement it exactly)\n${JSON.stringify(ctx.stateMachine, null, 2)}`);
  if (ctx.baselineSource)
    parts.push(`## Previously verified program (the specification changed)\nModify this program to satisfy the changed requirements. Keep the logic for unchanged requirements as it is; every requirement is re-tested.\n${ctx.baselineSource}`);
  return parts.join("\n\n");
}

export async function designStateMachine(ctx: EngineeringContext, config: HarnessConfig, runId: string) {
  return complete({
    agent: "state_machine",
    tier: config.routing.codegen,
    system: `You design the control state machine for a PLC program before any code is written. Use the I/O variable
names in conditions and outputs. Include explicit stopped, running and (if any fault requirement exists) faulted states.
Every requirement id must be covered by at least one transition.`,
    user: contextBlock(ctx, config),
    schema: StateMachine,
    runId,
  });
}

/** Deterministic check: names resolve, initial exists, every state reachable, every supported requirement covered. */
export function checkStateMachine(sm: StateMachine, reqs: BoundRequirement[], io: IoPoint[]): string[] {
  const out: string[] = [];
  const names = new Set(sm.states.map((s) => s.name));
  if (!names.has(sm.initial)) out.push(`initial state ${sm.initial} is not defined`);
  for (const t of sm.transitions) for (const s of [t.from, t.to]) if (!names.has(s)) out.push(`transition uses undefined state ${s}`);
  const outputs = new Set(io.filter((p) => p.role === "actuator").map((p) => p.variable));
  for (const s of sm.states) for (const o of s.outputs) if (!outputs.has(o)) out.push(`state ${s.name} drives unknown output ${o}`);
  const reach = new Set([sm.initial]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const t of sm.transitions) if (reach.has(t.from) && !reach.has(t.to)) reach.add(t.to), (changed = true);
  }
  for (const s of names) if (!reach.has(s)) out.push(`state ${s} is unreachable`);
  for (const r of reqs.filter((x) => x.support === "supported" && x.kind !== "indicator"))
    if (!sm.transitions.some((t) => t.requirementIds.includes(r.id))) out.push(`requirement ${r.id} is not covered by any transition`);
  return out;
}

export async function generateLogic(ctx: EngineeringContext, config: HarnessConfig, runId: string) {
  return complete({
    agent: "codegen",
    tier: config.routing.codegen,
    system: `You are a senior PLC programmer. Write production-quality IEC 61131-3 Structured Text that satisfies every
supported requirement and will be compiled, deployed to a real OpenPLC runtime and measured on a Factory I/O simulation.
${ST_DIALECT}`,
    user: contextBlock(ctx, config),
    schema: Logic,
    runId,
  });
}

export interface RepairInput {
  previousSource: string;
  /** Compiler output, lint problems or observed test failures (never hidden test code). */
  feedback: string[];
  diagnosis?: string;
  failingRequirementIds: string[];
}

export async function repairLogic(ctx: EngineeringContext, input: RepairInput, config: HarnessConfig, tier: HarnessConfig["routing"]["repair"], runId: string) {
  const strategy =
    config.repair.strategy === "targeted_patch"
      ? "Change as little as possible: keep every part of the program that is not implicated by the failures."
      : "You may restructure the program if that is the clearest fix.";
  const focus = config.repair.isolate_failing_requirements && input.failingRequirementIds.length
    ? `Focus on ${input.failingRequirementIds.join(", ")}; requirements not listed currently pass and must keep passing.`
    : "";
  return complete({
    agent: "repair",
    tier,
    system: `You repair a PLC program that failed compilation or measured simulator tests. ${strategy} ${focus}
Return the complete corrected variables and body.
${ST_DIALECT}`,
    user: `${contextBlock(ctx, config)}\n\n## Previous program\n${input.previousSource}\n\n## What failed (measured)\n${input.feedback.map((f) => `- ${f}`).join("\n")}${
      input.diagnosis ? `\n\n## Engineer's diagnosis\n${input.diagnosis}` : ""
    }`,
    schema: Logic,
    runId,
  });
}

const Diagnosis = z.object({
  causes: z.array(z.object({ requirementId: z.string(), cause: z.string(), fix: z.string() })),
  lessons: z.array(z.object({ pattern: z.string(), fix: z.string() })),
  summary: z.string(),
});

export async function diagnose(ctx: EngineeringContext, source: string, feedback: string[], config: HarnessConfig, runId: string) {
  return complete({
    agent: "critic",
    tier: config.routing.critic,
    system: `You are a commissioning engineer diagnosing a PLC program from measured simulator behaviour.
For each failure, name the root cause in the code and the smallest fix. Then write at most 3 reusable lessons phrased
as "pattern -> fix" that would prevent this class of failure on a different machine (no tag names, no numbers specific
to this project).`,
    user: `${contextBlock(ctx, config)}\n\n## Program under test\n${source}\n\n## Measured failures\n${feedback.map((f) => `- ${f}`).join("\n")}`,
    schema: Diagnosis,
    runId,
  });
}
