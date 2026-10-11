// AWS integration settings. Every feature is OFF unless its env flag is set, and every call is fail-soft:
// the worker runs exactly as before without AWS credentials (see apps/worker/src/aws/index.ts).
//
//   MM_AWS_REGION                region for all AWS clients (default: AWS_REGION, then RIG_REGION, then us-west-2)
//   MM_AWS_ARTIFACTS_BUCKET      S3 bucket for run artifacts (ST source, compile logs, test reports, measurement exports)
//   MM_AWS_ARTIFACTS_PREFIX      key prefix inside the bucket (default "runs/")
//   MM_AWS_PRESIGN_TTL_S         presigned GET URL lifetime in seconds (default 3600, max 604800)
//   MM_AWS_METRICS=1             CloudWatch custom metrics via PutMetricData
//   MM_AWS_METRICS_NAMESPACE     metric namespace (default "MongoMation")
//   MM_AWS_LOG_GROUP             CloudWatch Logs group for structured worker events (e.g. /mongomation/worker)
//   MM_AWS_SSM_SECRETS=1         read OPENPLC_PASSWORD from SSM (OPENPLC_PASSWORD_SSM_PARAM) when it is not already set
//   MM_AWS_SECRETS_ID            Secrets Manager secret (JSON object) whose keys fill UNSET env vars at worker start
//   MM_AWS_RIG_HEALTH=1          SSM Run Command health probe of the rig host (needs RIG_INSTANCE), written to rig_status.aws
//   MM_AWS_RIG_HEALTH_MS         probe interval (default 120000; min 30000)
//   RIG_FIO_INSTANCE             optional: Windows Factory I/O instance id, probed with AWS-RunPowerShellScript

export interface AwsSettings {
  region: string;
  bucket: string | null;
  prefix: string;
  presignTtlS: number;
  metrics: boolean;
  namespace: string;
  logGroup: string | null;
  ssmSecrets: boolean;
  openplcParam: string;
  secretsId: string | null;
  rigHealth: boolean;
  rigHealthMs: number;
  rigInstance: string | null;
  fioInstance: string | null;
  rigId: string;
}

const flag = (v: string | undefined) => v === "1" || v?.toLowerCase() === "true";
const str = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
const int = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);

export function awsSettings(env: NodeJS.ProcessEnv = process.env): AwsSettings {
  const prefix = (env.MM_AWS_ARTIFACTS_PREFIX ?? "runs/").replace(/^\/+/, "");
  return {
    region: str(env.MM_AWS_REGION) ?? str(env.AWS_REGION) ?? str(env.RIG_REGION) ?? "us-west-2",
    bucket: str(env.MM_AWS_ARTIFACTS_BUCKET),
    prefix: prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix,
    presignTtlS: Math.min(604_800, Math.max(60, int(env.MM_AWS_PRESIGN_TTL_S, 3600))),
    metrics: flag(env.MM_AWS_METRICS),
    namespace: str(env.MM_AWS_METRICS_NAMESPACE) ?? "MongoMation",
    logGroup: str(env.MM_AWS_LOG_GROUP),
    ssmSecrets: flag(env.MM_AWS_SSM_SECRETS),
    openplcParam: str(env.OPENPLC_PASSWORD_SSM_PARAM) ?? "/autominus/openplc-api-password",
    secretsId: str(env.MM_AWS_SECRETS_ID),
    rigHealth: flag(env.MM_AWS_RIG_HEALTH),
    rigHealthMs: Math.max(30_000, int(env.MM_AWS_RIG_HEALTH_MS, 120_000)),
    rigInstance: str(env.RIG_INSTANCE),
    fioInstance: str(env.RIG_FIO_INSTANCE),
    rigId: str(env.RIG_ID) ?? "rig-1",
  };
}

/** Anything the AWS SDK v3 clients have in common: `send(command)`. Tests pass fakes with the same shape. */
export interface Sender {
  send(command: unknown): Promise<any>;
}

/** Error text safe to log: never includes credentials (SDK errors do not), trimmed. */
export const awsErr = (e: unknown) => {
  const err = e as { name?: string; message?: string };
  return `${err?.name ?? "Error"}: ${String(err?.message ?? e).slice(0, 300)}`;
};
