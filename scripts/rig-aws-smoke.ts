// Live AWS smoke for the worker integration (no Mongo, no rig writes):
//   1. S3: upload one small test object to MM_AWS_ARTIFACTS_BUCKET and presign it, then GET it back via the URL
//   2. CloudWatch: PutMetricData one "SmokeTest" datapoint in MM_AWS_METRICS_NAMESPACE
//   3. CloudWatch Logs: one structured event to MM_AWS_LOG_GROUP (when set)
//   npx tsx --env-file-if-exists=.env scripts/rig-aws-smoke.ts
import { S3Client } from "@aws-sdk/client-s3";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { awsErr, awsSettings } from "../apps/worker/src/aws/config.ts";
import { artifactKey, presignGet, putArtifact } from "../apps/worker/src/aws/s3.ts";
import { putMetrics } from "../apps/worker/src/aws/metrics.ts";
import { CloudWatchLogSink } from "../apps/worker/src/aws/logs.ts";

const cfg = awsSettings();
let failed = false;
const row = (ok: boolean | null, name: string, detail: string) => {
  if (ok === false) failed = true;
  console.log(`${ok === null ? "-" : ok ? "OK  " : "FAIL"} ${name.padEnd(12)} ${detail}`);
};

if (cfg.bucket) {
  try {
    const s3 = new S3Client({ region: cfg.region });
    const key = artifactKey(cfg.prefix, null, "smoke", `smoke-${Date.now()}.txt`);
    const ref = await putArtifact(s3, { bucket: cfg.bucket, key, body: `mongomation smoke ${new Date().toISOString()}\n`, contentType: "text/plain", metadata: { kind: "smoke" } });
    const url = await presignGet(s3, cfg.bucket, key, 300);
    const got = await fetch(url);
    row(got.ok, "s3", `put s3://${cfg.bucket}/${key} (${ref.bytes} B), presigned GET -> HTTP ${got.status}`);
  } catch (e) {
    row(false, "s3", awsErr(e));
  }
} else row(null, "s3", "skipped (MM_AWS_ARTIFACTS_BUCKET not set)");

try {
  await putMetrics(new CloudWatchClient({ region: cfg.region }), cfg.namespace, [{ MetricName: "SmokeTest", Value: 1, Unit: "Count", Timestamp: new Date() }]);
  row(true, "cloudwatch", `PutMetricData ${cfg.namespace}/SmokeTest=1`);
} catch (e) {
  row(false, "cloudwatch", awsErr(e));
}

if (cfg.logGroup) {
  const warnings: string[] = [];
  const sink = new CloudWatchLogSink(new CloudWatchLogsClient({ region: cfg.region }), cfg.logGroup, `smoke-${Date.now()}`, (m) => warnings.push(m));
  sink.emit("smoke_test", { at: new Date().toISOString() });
  await sink.flush();
  row(!warnings.length, "logs", warnings[0] ?? `1 event -> ${cfg.logGroup}/${sink.stream}`);
} else row(null, "logs", "skipped (MM_AWS_LOG_GROUP not set)");

process.exit(failed ? 1 : 0);
