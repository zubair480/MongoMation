// Immutable guardrails for the meta-harness. A proposal that violates any of them is REJECTED before a
// single benchmark run is spent. Nothing here is configurable by the meta-agent: this file, checks/ and the
// frozen benchmark manifest are outside its reach (it only ever emits a HarnessBody JSON document).
import { HarnessBody, type HarnessConfig } from "@mongomation/types";

/** Phrases that would turn a rule into "make the score go up without fixing anything". */
const FORBIDDEN_RULE_PATTERNS: [RegExp, string][] = [
  [/\b(skip|disable|bypass|ignore|suppress|silence)\b.{0,40}\b(test|check|compile|compil|verification|validator|error|fault|alarm)/i, "weakens verification or silences errors"],
  [/\b(mark|report|declare|treat)\b.{0,30}\b(pass|passed|passing|success|verified)\b/i, "declares outcomes instead of producing them"],
  [/\bhidden\b|\bregression test\b.{0,20}\b(expect|answer)/i, "refers to hidden test expectations"],
  [/\b(physical|real|live)\b.{0,20}\b(machine|plant|equipment|hardware)\b/i, "reaches beyond the simulator"],
  [/\b(benchmark|dataset|held[- ]?out)\b/i, "refers to the evaluation set"],
];

export interface GuardrailContext {
  /** Run ids the proposal cites; they must exist in Atlas as failed runs under the parent config. */
  citedRunIdsExist: boolean;
}

export function guardrailViolations(parent: HarnessConfig, candidate: unknown, ctx: GuardrailContext): string[] {
  const v: string[] = [];
  const parsed = HarnessBody.safeParse(candidate);
  if (!parsed.success) {
    // Unknown fields (e.g. "skip_tests"), run_regression_tests: false, out-of-range budgets all land here.
    return parsed.error.issues.map((i) => `schema: ${i.path.join(".") || "(root)"} ${i.message}`);
  }
  const c = parsed.data;
  const removed = parent.rules.filter((r) => !c.rules.includes(r));
  if (removed.length) v.push(`removes existing rule(s): ${removed.map((r) => `"${r}"`).join(", ")}`);
  for (const rule of c.rules.filter((r) => !parent.rules.includes(r))) {
    for (const [re, why] of FORBIDDEN_RULE_PATTERNS) if (re.test(rule)) v.push(`rule "${rule}" ${why}`);
  }
  if (parent.workflow.preflight_compile && !c.workflow.preflight_compile)
    v.push("turns off the preflight compile (a verification step)");
  if (parent.workflow.state_machine_before_code && !c.workflow.state_machine_before_code)
    v.push("removes state-machine verification once adopted");
  if (c.workflow.repair_budget > parent.workflow.repair_budget + 1) v.push("raises the repair budget by more than 1 in one step");
  if (!ctx.citedRunIdsExist) v.push("cites no real failed run under the parent config (proposal must be grounded in measured failures)");
  const changed = JSON.stringify(stripMeta(parent)) !== JSON.stringify(c);
  if (!changed) v.push("no-op: identical to the parent config");
  return v;
}

export function stripMeta(c: HarnessConfig): HarnessBody {
  return { rules: c.rules, context: c.context, workflow: c.workflow, repair: c.repair, routing: c.routing };
}

/** "context.lessons_k: 3 → 5" style lines, for the dashboard's config diff and the evidence ledger. */
export function configDiff(a: unknown, b: unknown, path = ""): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (Array.isArray(a) && Array.isArray(b)) {
    const added = b.filter((x) => !a.some((y) => JSON.stringify(y) === JSON.stringify(x)));
    const removed = a.filter((x) => !b.some((y) => JSON.stringify(y) === JSON.stringify(x)));
    return [...added.map((x) => `+ ${path}: ${JSON.stringify(x)}`), ...removed.map((x) => `- ${path}: ${JSON.stringify(x)}`)];
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) =>
      configDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k),
    );
  }
  return [`~ ${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`];
}
