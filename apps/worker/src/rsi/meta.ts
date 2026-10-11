// Meta-agent: reads REAL failure evidence (Atlas test results, diagnoses, lessons, Raindrop trace refs) and
// proposes at most one change to the harness — never to the PLC program, the tests or the benchmark.
// It may (and often should) propose nothing. It never applies anything: guardrails and the gate decide.
import { ModelTier, type HarnessConfig } from "@mongomation/types";
import { z } from "zod";
import { formatRaindropEvidence, type RaindropEvidence } from "../telemetry/raindrop-query.ts";
import { complete } from "../tools/llm.ts";
import { stripMeta } from "./guardrails.ts";

export interface FailureCluster {
  /** Normalized description shared by the failures, e.g. "fault_latch: fault indicator cleared when cause cleared". */
  pattern: string;
  count: number;
  projects: number;
  /** Atlas ids: sim run ids and test result ids carrying the evidence. */
  runIds: string[];
  testResultIds: string[];
  /** Critic diagnoses attached to these failures. */
  diagnoses: string[];
  raindropEventIds: string[];
}

export interface MetaEvidence {
  harnessVersion: number;
  projects: number;
  requirementSatisfaction: number;
  repairsPerProject: number;
  clusters: FailureCluster[];
  recentLessons: string[];
  /** Outcome of the fault injection that triggered this round, if any. */
  trigger?: string;
  /** What Raindrop observed across all runs (signals, failing spans, failure samples) via the Query API;
   *  null when the Query API is unavailable. */
  raindrop?: RaindropEvidence | null;
}

/** Same shape as HarnessBody without range checks: an out-of-range proposal must reach the guardrails
 *  (and be recorded as REJECTED), not die in response parsing. */
const HarnessBodyLoose = z.object({
  rules: z.array(z.string()),
  context: z.object({ lessons_k: z.number(), retrieve_similar_failures: z.boolean(), failures_k: z.number(), include_previous_attempt: z.boolean() }),
  workflow: z.object({
    state_machine_before_code: z.boolean(),
    preflight_compile: z.boolean(),
    repair_budget: z.number(),
    module_split_threshold: z.number(),
    run_regression_tests: z.boolean(),
  }),
  repair: z.object({ strategy: z.enum(["full_rewrite", "targeted_patch"]), isolate_failing_requirements: z.boolean() }),
  routing: z.object({ requirements: ModelTier, codegen: ModelTier, critic: ModelTier, repair: ModelTier, escalate_after_failures: z.number() }),
});

const Proposal = z.object({
  change: z.boolean(),
  rationale: z.string(),
  /** Run ids from the evidence that justify the change (must be real, checked by guardrails). */
  citedRunIds: z.array(z.string()),
  expectedEffect: z.string(),
  config: HarnessBodyLoose.nullable(),
});

const SYSTEM = `You improve the HARNESS of an autonomous PLC engineering agent: the rules it is given, what context it
retrieves, its workflow, its repair strategy and its model routing. You never edit PLC programs, tests or benchmarks.

You receive clusters of real, measured failures from recent engineering runs. Propose at most ONE change that would
prevent the most frequent failure cause on future, different machines — or propose no change.

Rules:
- If failures are rare, one-off, or already fixed by repairs without a pattern, set change=false and config=null.
  "No justified change" is a correct and valuable answer.
- Prefer one concrete engineering rule (an instruction given to the code generator) over workflow changes.
  Example: "Model every recoverable fault as a latched bit set by the detection condition and cleared only by Reset when
  the cause is absent; gate all outputs with NOT fault."
- Rules must be general (no tag names, no project-specific numbers) and must never weaken, skip, or reinterpret tests,
  compilation, or error reporting. Never mention benchmarks, held-out sets, or hidden tests.
- Each rule string MUST be at most 400 characters (hard schema limit; longer rules are rejected). State one precise rule.
- Existing rules must be kept (append only). Repair budget may change by at most 1.
- cite the run ids that show the pattern in citedRunIds.
- Raindrop telemetry (signal counts, failing spans, failure samples) tells you how often a failure kind occurs across
  all recent runs. Use it to pick the most widespread cause; never cite Raindrop event ids as run ids.
- "config" is the COMPLETE new harness body (rules, context, workflow, repair, routing) when change=true.`;

/** The meta-agent's user prompt: Atlas measurements + Raindrop production telemetry. Exported for tests. */
export function metaUserPrompt(evidence: MetaEvidence, current: HarnessConfig) {
  return `## Current harness v${current.version}
${JSON.stringify(stripMeta(current), null, 2)}

## Measured results under v${current.version}
${evidence.projects} projects, requirement satisfaction ${(evidence.requirementSatisfaction * 100).toFixed(0)}%, ${evidence.repairsPerProject.toFixed(1)} repairs per project.
${evidence.trigger ? `\nTrigger: ${evidence.trigger}\n` : ""}
## Failure clusters (most frequent first)
${evidence.clusters.length ? evidence.clusters.map((c) => `- (${c.count}x across ${c.projects} projects) ${c.pattern}\n  runs: ${c.runIds.slice(0, 6).join(", ")}\n  diagnoses: ${c.diagnoses.slice(0, 3).join(" | ")}${c.raindropEventIds.length ? `\n  raindrop events: ${[...new Set(c.raindropEventIds)].slice(0, 4).join(", ")}` : ""}`).join("\n") : "(no failures)"}

## Raindrop production telemetry (all harness versions; use it to judge how widespread a cluster is)
${formatRaindropEvidence(evidence.raindrop)}

## Lessons the critic wrote recently
${evidence.recentLessons.length ? evidence.recentLessons.map((l) => `- ${l}`).join("\n") : "(none)"}`;
}

export async function proposeHarnessChange(evidence: MetaEvidence, current: HarnessConfig, runId: string) {
  const user = metaUserPrompt(evidence, current);
  return complete({ agent: "meta", tier: "strong", system: SYSTEM, user, schema: Proposal, runId, effort: "high" });
}
