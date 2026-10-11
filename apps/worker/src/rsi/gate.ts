// The verification gate: decides KEPT / ROLLED BACK from benchmark scores measured under the same
// model, the same scene, the same frozen cases and the same validator (plan hashes must match).
// REJECTED is decided earlier, by guardrails, without spending a benchmark.
import type { HarnessScores } from "@mongomation/types";

/** Differences smaller than these are noise, not improvement. */
export const SATISFACTION_EPS = 0.05;
export const RATE_EPS = 0.1;

export interface GateDecision {
  verdict: "kept" | "rolled_back";
  reasons: string[];
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

/**
 * Correctness first, safety never traded:
 *   0. hidden safety pass rate may not drop at all              -> otherwise ROLLED BACK
 *   1. requirement satisfaction up by > SATISFACTION_EPS         -> KEPT; down by > eps -> ROLLED BACK
 *   2. tie -> first-try compile rate up by > RATE_EPS            -> KEPT
 *   3. tie -> fewer repairs per case (by >= 0.5)                 -> KEPT
 *   4. tie -> cheaper by >= 20% and not slower by > 20%          -> KEPT
 *   5. otherwise                                                 -> ROLLED BACK (no measured improvement)
 */
export function decide(candidate: HarnessScores, parent: HarnessScores): GateDecision {
  const line = (s: HarnessScores) =>
    `satisfaction ${pct(s.requirement_satisfaction)}, safety ${pct(s.safety_pass_rate)}, compile 1st try ${pct(s.compile_first_try)}, ` +
    `${s.repairs_per_case.toFixed(1)} repairs, $${s.cost_usd_per_case.toFixed(3)}/case, ${s.seconds_per_case.toFixed(0)} s/case (${s.cases} cases)`;
  const reasons = [`candidate: ${line(candidate)}`, `parent: ${line(parent)}`];
  const done = (verdict: GateDecision["verdict"], why: string): GateDecision => ({ verdict, reasons: [why, ...reasons] });

  if (candidate.cases !== parent.cases || candidate.cases === 0) return done("rolled_back", "not comparable: different or empty case sets");
  if (candidate.safety_pass_rate < parent.safety_pass_rate - 1e-9) return done("rolled_back", "safety regression: hidden safety tests passed less often");
  const dSat = candidate.requirement_satisfaction - parent.requirement_satisfaction;
  if (dSat > SATISFACTION_EPS) return done("kept", `requirement satisfaction +${pct(dSat)}`);
  if (dSat < -SATISFACTION_EPS) return done("rolled_back", `requirement satisfaction ${pct(dSat)}`);
  if (candidate.compile_first_try - parent.compile_first_try > RATE_EPS) return done("kept", "same correctness, compiles first try more often");
  if (parent.repairs_per_case - candidate.repairs_per_case >= 0.5) return done("kept", "same correctness, fewer repair attempts");
  if (candidate.cost_usd_per_case <= parent.cost_usd_per_case * 0.8 && candidate.seconds_per_case <= parent.seconds_per_case * 1.2)
    return done("kept", "same correctness, at least 20% cheaper");
  return done("rolled_back", "no measured improvement over the parent");
}
