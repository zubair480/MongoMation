// AWS sponsor integration for the worker: S3 artifacts, CloudWatch metrics + logs, SSM secrets + rig health,
// Secrets Manager. Wired from main.ts with two calls (initAws at start, awsAfterJob after each job).
// Everything is behind env flags (see ./config.ts) and fail-soft: with no flags or no credentials the worker
// behaves exactly as before, and an AWS error is logged once per feature, never thrown into the job loop.
import type { ObjectId } from "mongodb";
import { hostname } from "node:os";
import { awsErr, awsSettings, type AwsSettings, type Sender } from "./config.ts";
import type { CloudWatchLogSink } from "./logs.ts";

const cfg: AwsSettings = awsSettings();
let s3: Sender | null = null;
let cw: Sender | null = null;
let ssm: Sender | null = null;
let sink: CloudWatchLogSink | null = null;
let log: (m: string) => void = console.log;
const warned = new Set<string>();
const warnOnce = (feature: string, e: unknown) => {
  if (warned.has(feature)) return;
  warned.add(feature);
  log(`aws: ${feature} failed (${awsErr(e)}) - continuing without it`);
};

export const awsConfig = () => cfg;

/** Structured event to CloudWatch Logs (no-op unless MM_AWS_LOG_GROUP is set). */
export function awsEvent(event: string, fields: Record<string, unknown> = {}) {
  sink?.emit(event, { worker: process.env.WORKER_ID || `worker-${hostname()}-${process.pid}`, ...fields });
}

/** Call once at worker start, BEFORE createRig() (it may fill OPENPLC_PASSWORD from SSM / Secrets Manager). */
export async function initAws(logger: (m: string) => void = console.log, opts: { rigHealthLoop?: boolean } = {}) {
  log = logger;
  const on: string[] = [];
  const region = cfg.region;
  try {
    if (cfg.secretsId) {
      const { SecretsManagerClient } = await import("@aws-sdk/client-secrets-manager");
      const { loadSecretIntoEnv } = await import("./secrets.ts");
      const set = await loadSecretIntoEnv(new SecretsManagerClient({ region }), cfg.secretsId).catch((e) => (warnOnce("Secrets Manager", e), [] as string[]));
      on.push(`secrets(${set.length} var(s): ${set.join(", ") || "none needed"})`);
    }
    if (cfg.ssmSecrets || cfg.rigHealth) {
      const { SSMClient } = await import("@aws-sdk/client-ssm");
      ssm = new SSMClient({ region });
    }
    if (cfg.ssmSecrets && ssm) {
      const { loadOpenPlcPassword } = await import("./secrets.ts");
      const r = await loadOpenPlcPassword(ssm, cfg.openplcParam).catch((e) => (warnOnce("SSM GetParameter", e), "error"));
      on.push(`ssm-param(${r})`);
    }
    if (cfg.bucket) {
      const { S3Client } = await import("@aws-sdk/client-s3");
      s3 = new S3Client({ region });
      on.push(`s3(${cfg.bucket}/${cfg.prefix})`);
    }
    if (cfg.metrics) {
      const { CloudWatchClient } = await import("@aws-sdk/client-cloudwatch");
      cw = new CloudWatchClient({ region });
      on.push(`metrics(${cfg.namespace})`);
    }
    if (cfg.logGroup) {
      const { CloudWatchLogsClient } = await import("@aws-sdk/client-cloudwatch-logs");
      const { CloudWatchLogSink } = await import("./logs.ts");
      const stream = `${process.env.WORKER_ID || hostname()}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${process.pid}`;
      sink = new CloudWatchLogSink(new CloudWatchLogsClient({ region }), cfg.logGroup, stream, log);
      setInterval(() => void sink?.flush(), 5000).unref();
      on.push(`logs(${cfg.logGroup})`);
    }
    if (cfg.rigHealth && opts.rigHealthLoop !== false) {
      if (!cfg.rigInstance) log("aws: MM_AWS_RIG_HEALTH=1 but RIG_INSTANCE is not set - rig health probe off");
      else {
        startRigHealthLoop();
        on.push(`rig-health(every ${Math.round(cfg.rigHealthMs / 1000)} s)`);
      }
    }
  } catch (e) {
    warnOnce("init", e);
  }
  log(on.length ? `aws: enabled ${on.join(", ")} [${region}]` : "aws: DISABLED (no MM_AWS_* flags set)");
  awsEvent("worker_start", { features: on });
}

/** After every job (success or not). Never throws; safe to `void`. */
export async function awsAfterJob(jobId: ObjectId): Promise<void> {
  if (!s3 && !cw && !sink) return;
  try {
    const { archiveJob } = await import("./archive.ts");
    const r = await archiveJob(jobId, s3, cfg);
    if (r.summary && cw) {
      const { jobMetricData, putMetrics } = await import("./metrics.ts");
      await putMetrics(cw, cfg.namespace, jobMetricData(r.summary)).catch((e) => warnOnce("CloudWatch PutMetricData", e));
    }
    awsEvent("job_finished", { jobId: String(jobId), ...r.summary, artifacts: r.uploaded.length });
    if (r.uploaded.length) log(`aws: archived ${r.uploaded.length} artifact(s) for job ${String(jobId)} to s3://${cfg.bucket}`);
  } catch (e) {
    warnOnce("S3 archive", e);
  } finally {
    await sink?.flush();
  }
}

/** Presigned GET URL for an artifact key stored on a Mongo doc (null when S3 is off). */
export async function presignArtifact(key: string, ttlS = cfg.presignTtlS): Promise<string | null> {
  if (!s3 || !cfg.bucket) return null;
  const { presignGet } = await import("./s3.ts");
  return presignGet(s3 as never, cfg.bucket, key, ttlS);
}

export async function awsFlush() {
  await sink?.flush();
}

// --- rig health via SSM Run Command -------------------------------------------------------------------------
let healthTimer: NodeJS.Timeout | null = null;

export async function checkRigHealth(): Promise<{ healthy: boolean; hosts: Record<string, unknown> } | null> {
  if (!ssm || !cfg.rigInstance) return null;
  const { runProbe, rigHealthy } = await import("./ssm.ts");
  const targets: { role: string; instanceId: string; platform: "linux" | "windows" }[] = [{ role: "openplc", instanceId: cfg.rigInstance, platform: "linux" }];
  if (cfg.fioInstance) targets.push({ role: "factoryio", instanceId: cfg.fioInstance, platform: "windows" });
  const results = await Promise.all(
    targets.map((t) => runProbe(ssm!, { instanceId: t.instanceId, platform: t.platform }).catch((e) => ({ ok: false, status: "Error", checks: {}, stats: {}, detail: awsErr(e) }))),
  );
  const healthy = rigHealthy(results);
  const hosts = Object.fromEntries(targets.map((t, i) => [t.role, results[i]]));
  const allChecks = Object.fromEntries(targets.flatMap((t, i) => Object.entries(results[i].checks).map(([k, v]) => [`${t.role}.${k}`, v])));
  try {
    const { col } = await import("../db/index.ts");
    await col.rigStatus().updateOne({ _id: cfg.rigId as never }, { $set: { aws: { checkedAt: new Date(), via: "ssm-run-command", healthy, hosts } } }, { upsert: true });
  } catch (e) {
    warnOnce("rig_status write", e);
  }
  if (cw) {
    const { putMetrics, rigHealthMetricData } = await import("./metrics.ts");
    await putMetrics(cw, cfg.namespace, rigHealthMetricData(cfg.rigId, healthy, allChecks)).catch((e) => warnOnce("CloudWatch PutMetricData", e));
  }
  awsEvent("rig_health", { rigId: cfg.rigId, healthy, checks: allChecks });
  return { healthy, hosts };
}

function startRigHealthLoop() {
  if (healthTimer) return;
  const tick = async () => {
    await checkRigHealth().catch((e) => warnOnce("SSM rig health", e));
    healthTimer = setTimeout(() => void tick(), cfg.rigHealthMs);
    healthTimer.unref();
  };
  void tick();
}
