// Pure grader: turns a test's step log and measured samples into verdicts. No I/O, no clock, no model.
// Because it is pure, any stored run can be re-graded from Atlas measurements by anyone.
//
// Evidence rules:
//   - A pass needs a measured sample that satisfies the assertion inside its window.
//   - A failure needs a measured sample that violates it (or full window coverage without satisfaction).
//   - Not enough samples in the window is neither: the test is BLOCKED. Missing data is never a pass.
import type { AssertionResult, Sample, StepLog, TagValue, TestCase, TestResult } from "@mongomation/types";

/** Largest gap between samples (or between a window edge and the nearest sample) still treated as covered. */
export const MAX_SAMPLE_GAP_MS = 400;

const same = (a: TagValue | undefined, b: TagValue) =>
  typeof b === "number" && typeof a === "number" ? Math.abs(a - b) < 1e-6 : a === b;

const fmt = (v: TagValue | undefined) => (v === undefined ? "no value" : String(v));

function inWindow(samples: Sample[], from: number, to: number, tag: string) {
  return samples.filter((s) => s.t >= from && s.t <= to && s.values[tag] !== undefined);
}

/** True when samples cover [from, to] with no gap above MAX_SAMPLE_GAP_MS. */
export function covers(samples: Sample[], from: number, to: number): boolean {
  if (!samples.length) return false;
  if (samples[0].t - from > MAX_SAMPLE_GAP_MS) return false;
  if (to - samples[samples.length - 1].t > MAX_SAMPLE_GAP_MS) return false;
  for (let i = 1; i < samples.length; i++) if (samples[i].t - samples[i - 1].t > MAX_SAMPLE_GAP_MS) return false;
  return true;
}

type Graded = AssertionResult & { evidence: "satisfied" | "violated" | "insufficient" };

function gradeExpect(step: Extract<TestCase["steps"][number], { op: "expect" }>, index: number, log: StepLog, samples: Sample[]): Graded {
  const from = log.startedAt;
  const to = log.startedAt + step.withinMs;
  const win = inWindow(samples, from, to, step.tag);
  const hit = win.find((s) => same(s.values[step.tag], step.value));
  if (hit)
    return {
      stepIndex: index,
      label: step.label,
      passed: true,
      evidence: "satisfied",
      atMs: hit.t,
      detail: `${step.tag} = ${fmt(step.value)} after ${Math.round(hit.t - from)} ms (limit ${step.withinMs} ms)`,
    };
  // Not satisfied. It is a measured failure only if we watched the whole window.
  const lastBeforeEnd = win.at(-1);
  if (covers(win, from, Math.min(to, log.endedAt))) {
    return {
      stepIndex: index,
      label: step.label,
      passed: false,
      evidence: "violated",
      atMs: lastBeforeEnd?.t,
      detail: `${step.tag} never reached ${fmt(step.value)} within ${step.withinMs} ms (measured ${fmt(lastBeforeEnd?.values[step.tag])} at +${Math.round((lastBeforeEnd?.t ?? from) - from)} ms)`,
    };
  }
  return {
    stepIndex: index,
    label: step.label,
    passed: false,
    evidence: "insufficient",
    detail: `not enough measurements of ${step.tag} between +${from} and +${to} ms (${win.length} samples)`,
  };
}

function gradeStable(step: Extract<TestCase["steps"][number], { op: "expectStable" }>, index: number, log: StepLog, samples: Sample[]): Graded {
  const from = log.startedAt;
  const to = log.startedAt + step.forMs;
  const win = inWindow(samples, from, to, step.tag);
  const bad = win.find((s) => !same(s.values[step.tag], step.value));
  if (bad)
    return {
      stepIndex: index,
      label: step.label,
      passed: false,
      evidence: "violated",
      atMs: bad.t,
      detail: `${step.tag} was ${fmt(bad.values[step.tag])} at +${Math.round(bad.t - from)} ms; expected ${fmt(step.value)} for ${step.forMs} ms`,
    };
  if (covers(win, from, to))
    return {
      stepIndex: index,
      label: step.label,
      passed: true,
      evidence: "satisfied",
      atMs: to,
      detail: `${step.tag} held ${fmt(step.value)} for ${step.forMs} ms (${win.length} samples)`,
    };
  return {
    stepIndex: index,
    label: step.label,
    passed: false,
    evidence: "insufficient",
    detail: `not enough measurements of ${step.tag} to cover ${step.forMs} ms (${win.length} samples)`,
  };
}

export function gradeTest(test: TestCase, logs: StepLog[], samples: Sample[], blockedReason?: string): TestResult {
  const base = {
    testId: test.id,
    title: test.title,
    category: test.category,
    visibility: test.visibility,
    requirementIds: test.requirementIds,
    sampleCount: samples.length,
    durationMs: logs.length ? logs[logs.length - 1].endedAt : 0,
  };
  if (blockedReason) return { ...base, verdict: "blocked", assertions: [], blockedReason };
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const graded: Graded[] = [];
  test.steps.forEach((step, i) => {
    const log = logs.find((l) => l.index === i);
    if (step.op !== "expect" && step.op !== "expectStable") return;
    if (!log) {
      graded.push({ stepIndex: i, label: step.label, passed: false, evidence: "insufficient", detail: "step did not run" });
      return;
    }
    graded.push(step.op === "expect" ? gradeExpect(step, i, log, sorted) : gradeStable(step, i, log, sorted));
  });
  const stepError = logs.find((l) => l.error);
  const assertions = graded.map(({ evidence: _e, ...a }) => a);
  if (stepError)
    return { ...base, verdict: "blocked", assertions, blockedReason: `step ${stepError.index} (${stepError.op}) errored: ${stepError.error}` };
  if (!graded.length) return { ...base, verdict: "blocked", assertions, blockedReason: "test has no assertions" };
  if (graded.some((g) => g.evidence === "violated")) return { ...base, verdict: "failed", assertions };
  if (graded.some((g) => g.evidence === "insufficient"))
    return { ...base, verdict: "blocked", assertions, blockedReason: "insufficient measurements for at least one assertion" };
  return { ...base, verdict: "passed", assertions };
}
