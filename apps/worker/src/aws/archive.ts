// After a job: copy its artifacts to S3 and stamp the S3 reference onto the Atlas documents, then emit metrics.
// Idempotent: documents that already carry `artifact` / `artifacts` are skipped, so a crash just means the next
// job of the same project picks up whatever was missed. Atlas stays the system of record; S3 holds the bytes.
import type { ObjectId } from "mongodb";
import { col } from "../db/index.ts";
import type { AwsSettings, Sender } from "./config.ts";
import type { JobSummary } from "./metrics.ts";
import { compileLogText, measurementsNdjson, stSource, summarizeJob, testReport } from "./report.ts";
import { artifactKey, putArtifact } from "./s3.ts";

const MAX_MEASUREMENT_ROWS = 200_000;

export interface ArchiveOutcome {
  uploaded: string[];
  summary: JobSummary | null;
}

export async function archiveJob(jobObjectId: ObjectId, s3: Sender | null, cfg: AwsSettings): Promise<ArchiveOutcome> {
  const job = await col.jobs().findOne({ _id: jobObjectId });
  if (!job) return { uploaded: [], summary: null };
  const jobId = String(job._id);
  const projectId = (job.projectId ?? (job.result as { projectId?: string } | undefined)?.projectId ?? null) as string | null;
  const since = (job.startedAt ?? job.createdAt) as Date;
  const uploaded: string[] = [];
  const bucket = cfg.bucket;
  const put = async (key: string, body: string, contentType: string, metadata: Record<string, string>) => {
    const ref = await putArtifact(s3!, { bucket: bucket!, key, body, contentType, metadata });
    uploaded.push(key);
    return ref;
  };

  let compilesInJob: Record<string, unknown>[] = [];
  let simRunsInJob: Record<string, unknown>[] = [];
  let repairsInJob: Record<string, unknown>[] = [];

  if (projectId) {
    const versions = await col.plcVersions().find({ projectId }, { projection: { _id: 1, version: 1, source: 1, sourceHash: 1, artifact: 1 } }).toArray();
    const versionIds = versions.map((v) => String(v._id));
    compilesInJob = await col.compiles().find({ plcVersionId: { $in: versionIds }, createdAt: { $gte: since } }, { projection: { log: 0 } }).toArray();
    simRunsInJob = await col.simRuns().find({ projectId, startedAt: { $gte: since } }, { projection: { _id: 1, passed: 1, failed: 1, blocked: 1 } }).toArray();
    repairsInJob = await col.repairs().find({ projectId, createdAt: { $gte: since } }, { projection: { _id: 1 } }).toArray();

    if (s3 && bucket) {
      for (const v of versions.filter((x) => !x.artifact)) {
        const ref = await put(artifactKey(cfg.prefix, projectId, "st", `v${v.version}-${String(v._id)}.st`), stSource(v), "text/plain; charset=utf-8", { kind: "st", sourcehash: String(v.sourceHash ?? "") });
        await col.plcVersions().updateOne({ _id: v._id }, { $set: { artifact: ref } });
      }
      const compiles = await col.compiles().find({ plcVersionId: { $in: versionIds }, artifact: { $exists: false } }).toArray();
      for (const c of compiles) {
        const ref = await put(artifactKey(cfg.prefix, projectId, "compiles", `${String(c._id)}-${String(c.stage)}.log`), compileLogText(c), "text/plain; charset=utf-8", { kind: "compile_log" });
        await col.compiles().updateOne({ _id: c._id }, { $set: { artifact: ref } });
      }
      const runs = await col.simRuns().find({ projectId, status: "done", artifacts: { $exists: false } }).toArray();
      for (const run of runs) {
        const simRunId = String(run._id);
        const results = await col.testResults().find({ simRunId }).toArray();
        const report = await put(artifactKey(cfg.prefix, projectId, "simruns", simRunId, "test-report.json"), testReport(run, results), "application/json", { kind: "test_report" });
        const rows = await col.measurements().find({ "meta.simRunId": simRunId }).sort({ ts: 1 }).limit(MAX_MEASUREMENT_ROWS).toArray();
        const meas = await put(artifactKey(cfg.prefix, projectId, "simruns", simRunId, "measurements.ndjson"), measurementsNdjson(rows), "application/x-ndjson", { kind: "measurements", rows: String(rows.length) });
        await col.simRuns().updateOne({ _id: run._id }, { $set: { artifacts: { testReport: report, measurements: { ...meas, rows: rows.length, truncated: rows.length >= MAX_MEASUREMENT_ROWS } } } });
      }
    }
  }

  if (s3 && bucket) {
    const { _id, ...rest } = job;
    const ref = await put(artifactKey(cfg.prefix, projectId, "jobs", `${jobId}.json`), JSON.stringify({ kind: "mongomation.job", jobId, ...rest }, null, 2), "application/json", { kind: "job_record", jobtype: String(job.type) });
    await col.jobs().updateOne({ _id: job._id }, { $set: { artifact: ref } });
  }

  return { uploaded, summary: summarizeJob(job, compilesInJob, simRunsInJob, repairsInJob) };
}
