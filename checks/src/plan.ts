// Builds the test plan for a project from its bound requirements and the scene, and rolls test results up
// into per-requirement verdicts. Deterministic: same requirements + scene -> same plan, same ids.
import { createHash } from "node:crypto";
import type { BoundRequirement, RequirementVerdict, SceneDefinition, TestCase, TestResult, TestStep } from "@mongomation/types";
import { hiddenTestsFor } from "./hidden/regression.ts";
import { PRESS_MS, PUBLIC_TEMPLATES, UnbindableRequirement } from "./templates.ts";

export interface TestPlan {
  tests: TestCase[];
  /** Requirements no primitive can validate yet (reported as "untested", never as verified). */
  untestable: { requirementId: string; reason: string }[];
  /** sha256 of the plan, stored with every run so results are only compared on identical plans. */
  hash: string;
}

/** Public part of a plan, safe to show to the code generator and the dashboard. */
export interface PublicPlanView {
  tests: { id: string; title: string; requirementIds: string[]; category: string }[];
  hiddenCount: number;
}

function validateBindings(r: BoundRequirement, scene: SceneDefinition) {
  for (const [role, tag] of Object.entries(r.bindings)) {
    if (!scene.tags.some((t) => t.name === tag)) throw new UnbindableRequirement(r.id, `role ${role} bound to unknown tag "${tag}"`);
  }
}

/** Operator controls the spec itself defines: the line Start/Stop (from its start_stop requirement) and every
 *  stop / reset button a supported requirement binds to a real scene sensor. Derived from the requirements only. */
function operatorControls(requirements: BoundRequirement[], scene: SceneDefinition) {
  const isSensor = (tag?: string) => Boolean(tag && scene.tags.some((t) => t.name === tag && t.role === "sensor"));
  const supported = requirements.filter((r) => r.support === "supported");
  const line = supported.find((r) => r.kind === "start_stop" && isSensor(r.bindings.start))?.bindings;
  const uniq = (role: string) => [...new Set(supported.map((r) => r.bindings[role]).filter(isSensor))];
  return { lineStart: line?.start, lineStop: isSensor(line?.stop) ? line?.stop : undefined, stops: uniq("stop"), resets: uniq("reset") };
}

/**
 * Sorting happens while the line runs: a sorting requirement that names no start of its own inherits the line's
 * Start/Stop from the spec's start_stop requirement (a router gated by "Running" is correct, not a defect).
 */
function withLineControls(r: BoundRequirement, ctl: ReturnType<typeof operatorControls>): BoundRequirement {
  if (r.kind !== "sorting" || r.bindings.start || !ctl.lineStart) return r;
  return { ...r, bindings: { ...r.bindings, start: ctl.lineStart, ...(ctl.lineStop && !r.bindings.stop ? { stop: ctl.lineStop } : {}) } };
}

/**
 * Every test starts from the same known state, independent of the test before it: clear latched faults with the
 * spec's Reset (every cause is released by then: the runner releases all its forces after each test), then Stop.
 * Without this a jam fault latched by one test leaked into the next ones (live sim run 6acbd9d3..97: R6, H-R5, H-R6).
 */
export function knownStatePreamble(requirements: BoundRequirement[], scene: SceneDefinition): TestStep[] {
  const ctl = operatorControls(requirements, scene);
  const presses = [...ctl.resets, ...ctl.stops].map((tag): TestStep => ({ op: "press", tag, holdMs: PRESS_MS }));
  return presses.length ? [...presses, { op: "wait", ms: 500 }] : [];
}

export function buildTestPlan(requirements: BoundRequirement[], scene: SceneDefinition, opts: { includeHidden: boolean }): TestPlan {
  const tests: TestCase[] = [];
  const untestable: TestPlan["untestable"] = [];
  const ctl = operatorControls(requirements, scene);
  const preamble = knownStatePreamble(requirements, scene);
  const fromKnownState = (t: TestCase): TestCase => ({ ...t, steps: [...preamble, ...t.steps] });
  for (const req of requirements) {
    if (req.support !== "supported") continue;
    const r = withLineControls(req, ctl);
    const template = PUBLIC_TEMPLATES[r.kind];
    if (!template) {
      untestable.push({ requirementId: r.id, reason: `no validation primitive for kind "${r.kind}" yet` });
      continue;
    }
    try {
      validateBindings(r, scene);
      tests.push(...template(r).map(fromKnownState));
      if (opts.includeHidden) tests.push(...hiddenTestsFor(r).map(fromKnownState));
    } catch (err) {
      if (err instanceof UnbindableRequirement) untestable.push({ requirementId: r.id, reason: err.message });
      else throw err;
    }
  }
  const hash = createHash("sha256").update(JSON.stringify({ scene: scene.id, tests, untestable })).digest("hex");
  return { tests, untestable, hash };
}

export function publicView(plan: TestPlan): PublicPlanView {
  return {
    tests: plan.tests.filter((t) => t.visibility === "public").map(({ id, title, requirementIds, category }) => ({ id, title, requirementIds, category })),
    hiddenCount: plan.tests.filter((t) => t.visibility === "hidden").length,
  };
}

/**
 * A requirement is VERIFIED only if every test that covers it passed with measured evidence.
 * Any failure -> FAILED. Any blocked test (and no failure) -> BLOCKED. No tests -> UNTESTED / UNSUPPORTED.
 */
export function requirementVerdicts(requirements: BoundRequirement[], plan: TestPlan, results: TestResult[]): RequirementVerdict[] {
  return requirements.map((r) => {
    if (r.support !== "supported")
      return { requirementId: r.id, status: "unsupported", testIds: [], detail: r.unsupportedReason ?? "not supported by the selected scene" };
    const untestable = plan.untestable.find((u) => u.requirementId === r.id);
    if (untestable) return { requirementId: r.id, status: "untested", testIds: [], detail: untestable.reason };
    const covering = results.filter((t) => t.requirementIds.includes(r.id));
    const ids = covering.map((t) => t.testId);
    const planned = plan.tests.filter((t) => t.requirementIds.includes(r.id)).length;
    if (!covering.length || covering.length < planned)
      return { requirementId: r.id, status: "blocked", testIds: ids, detail: `${covering.length}/${planned} planned tests produced results` };
    const failed = covering.filter((t) => t.verdict === "failed");
    if (failed.length) return { requirementId: r.id, status: "failed", testIds: ids, detail: `failed: ${failed.map((t) => t.testId).join(", ")}` };
    const blocked = covering.filter((t) => t.verdict === "blocked");
    if (blocked.length)
      return { requirementId: r.id, status: "blocked", testIds: ids, detail: `blocked: ${blocked.map((t) => `${t.testId} (${t.blockedReason})`).join("; ")}` };
    return { requirementId: r.id, status: "verified", testIds: ids, detail: `${covering.length} tests passed with measured evidence` };
  });
}

/**
 * What the agents may learn from a failure: the observed behaviour, never the test implementation.
 * Held-out benchmark runs pass `detail: "category"` so hidden expectations cannot leak into lessons.
 */
export function failureFeedback(results: TestResult[], detail: "observed" | "category"): string[] {
  return results
    .filter((t) => t.verdict === "failed")
    .map((t) => {
      if (t.visibility === "hidden" && detail === "category")
        return `A hidden ${t.category} regression test for ${t.requirementIds.join(", ")} failed.`;
      const bad = t.assertions.filter((a) => !a.passed).map((a) => `${a.label}: ${a.detail}`);
      const name = t.visibility === "hidden" ? `Hidden ${t.category} regression test` : `Test "${t.title}"`;
      return `${name} (${t.requirementIds.join(", ")}) failed. ${bad.join(" | ")}`;
    });
}
