// CloudWatch custom metrics. Pure builders (unit-tested) + one PutMetricData sender.
// Dimensions are low-cardinality on purpose (JobType, Rig) so the metric count - and cost - stays flat.
import { PutMetricDataCommand, type MetricDatum, type StandardUnit } from "@aws-sdk/client-cloudwatch";
import type { Sender } from "./config.ts";

export interface JobSummary {
  jobType: string;
  status: string; // completed | failed | blocked
  durationS: number | null;
  compiles: { ok: number; failed: number };
  tests: { passed: number; failed: number; blocked: number };
  repairs: number;
}

const d = (name: string, value: number, unit: StandardUnit, dims: Record<string, string>, ts: Date): MetricDatum => ({
  MetricName: name,
  Value: value,
  Unit: unit,
  Timestamp: ts,
  Dimensions: Object.entries(dims).map(([Name, Value]) => ({ Name, Value })),
});

export function jobMetricData(s: JobSummary, ts = new Date()): MetricDatum[] {
  const dims = { JobType: s.jobType };
  const out: MetricDatum[] = [
    d("JobCompleted", s.status === "completed" ? 1 : 0, "Count", dims, ts),
    d("JobFailed", s.status === "failed" ? 1 : 0, "Count", dims, ts),
    d("JobBlocked", s.status === "blocked" ? 1 : 0, "Count", dims, ts),
    d("RepairAttempts", s.repairs, "Count", dims, ts),
  ];
  if (s.durationS !== null) out.push(d("JobDuration", s.durationS, "Seconds", dims, ts));
  const compiles = s.compiles.ok + s.compiles.failed;
  if (compiles) {
    out.push(d("CompileAttempts", compiles, "Count", dims, ts), d("CompileFailures", s.compiles.failed, "Count", dims, ts));
    out.push(d("CompilePassRate", (100 * s.compiles.ok) / compiles, "Percent", dims, ts));
  }
  const decided = s.tests.passed + s.tests.failed; // blocked = no evidence, excluded from the pass rate
  if (decided + s.tests.blocked) {
    out.push(d("TestsPassed", s.tests.passed, "Count", dims, ts), d("TestsFailed", s.tests.failed, "Count", dims, ts), d("TestsBlocked", s.tests.blocked, "Count", dims, ts));
    if (decided) out.push(d("TestPassRate", (100 * s.tests.passed) / decided, "Percent", dims, ts));
  }
  return out;
}

export function rigHealthMetricData(rigId: string, healthy: boolean, checks: Record<string, boolean>, ts = new Date()): MetricDatum[] {
  return [
    d("RigHealthy", healthy ? 1 : 0, "Count", { Rig: rigId }, ts),
    ...Object.entries(checks).map(([check, ok]) => d("RigCheckOk", ok ? 1 : 0, "Count", { Rig: rigId, Check: check }, ts)),
  ];
}

export async function putMetrics(cw: Sender, namespace: string, data: MetricDatum[]): Promise<void> {
  for (let i = 0; i < data.length; i += 500) await cw.send(new PutMetricDataCommand({ Namespace: namespace, MetricData: data.slice(i, i + 500) }));
}
