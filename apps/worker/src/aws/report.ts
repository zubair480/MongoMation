// Pure builders for S3 artifacts + job metrics (no Mongo / AWS imports, so they are unit-tested directly).
import type { JobSummary } from "./metrics.ts";

type Doc = Record<string, unknown>;

/** Hidden test steps never leave Atlas: strip `steps` always, and step logs of hidden tests. */
export function publicTestResult(tr: Doc): Doc {
  const { _id, steps: _steps, stepLogs, ...rest } = tr;
  return { id: String(_id), ...rest, ...(rest.visibility !== "hidden" && stepLogs !== undefined && { stepLogs }) };
}

export function testReport(simRun: Doc, results: Doc[]): string {
  const { _id, ...run } = simRun;
  return JSON.stringify({ kind: "mongomation.test_report", version: 1, simRunId: String(_id), ...run, results: results.map(publicTestResult) }, null, 2);
}

export function measurementsNdjson(rows: Doc[]): string {
  return rows.map(({ _id, ...r }) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}

export function compileLogText(c: Doc): string {
  const head = [
    `# MongoMation compile record ${String(c._id)}`,
    `# stage: ${c.stage}  toolchain: ${c.toolchain}  plcVersionId: ${c.plcVersionId}`,
    `# result: ${c.ok === undefined ? c.status : c.ok ? "ok" : "failed"}  durationMs: ${c.durationMs ?? "?"}  at: ${c.createdAt instanceof Date ? c.createdAt.toISOString() : c.createdAt}`,
    "",
  ];
  return head.join("\n") + String(c.log ?? "");
}

export function stSource(v: Doc): string {
  return String(v.source ?? "");
}

/** Metrics for one finished job from the documents it produced (window = job startedAt .. now). */
export function summarizeJob(job: Doc, compiles: Doc[], simRuns: Doc[], repairs: Doc[], now = new Date()): JobSummary {
  const started = (job.startedAt ?? job.createdAt) as Date | undefined;
  const finished = (job.finishedAt as Date | undefined) ?? now;
  const real = compiles.filter((c) => c.stage === "compile");
  const sum = (k: string) => simRuns.reduce((a, r) => a + (typeof r[k] === "number" ? (r[k] as number) : 0), 0);
  return {
    jobType: String(job.type ?? "unknown"),
    status: String(job.status ?? "unknown"),
    durationS: started instanceof Date ? Math.max(0, (finished.getTime() - started.getTime()) / 1000) : null,
    compiles: { ok: real.filter((c) => c.ok === true).length, failed: real.filter((c) => c.ok === false).length },
    tests: { passed: sum("passed"), failed: sum("failed"), blocked: sum("blocked") },
    repairs: repairs.length,
  };
}
