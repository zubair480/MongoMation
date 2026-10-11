// One-shot READ-ONLY rig health probe through SSM Run Command (the same probe the worker runs when
// MM_AWS_RIG_HEALTH=1). Inspects processes / listening ports only; changes nothing on the instance.
//   npx tsx --env-file-if-exists=.env scripts/rig-health.ts            # print the probe result
//   npx tsx --env-file-if-exists=.env scripts/rig-health.ts --write    # also $set rig_status.aws + CloudWatch metric
// Env: RIG_INSTANCE (Linux OpenPLC host), optional RIG_FIO_INSTANCE (Windows Factory I/O host), region as rig-power.ts.
import { SSMClient } from "@aws-sdk/client-ssm";
import { awsErr, awsSettings } from "../apps/worker/src/aws/config.ts";
import { rigHealthy, runProbe } from "../apps/worker/src/aws/ssm.ts";

const cfg = awsSettings();
if (!cfg.rigInstance) {
  console.error("rig-health: RIG_INSTANCE is not set");
  process.exit(3);
}

try {
  if (process.argv.includes("--write")) {
    const { connect, client } = await import("../apps/worker/src/db/index.ts");
    await connect();
    process.env.MM_AWS_RIG_HEALTH = "1";
    const aws = await import("../apps/worker/src/aws/index.ts");
    await aws.initAws(console.log, { rigHealthLoop: false });
    const r = await aws.checkRigHealth();
    console.log(JSON.stringify(r, null, 2));
    await aws.awsFlush();
    await client.close();
    process.exit(r?.healthy ? 0 : 1);
  }
  const ssm = new SSMClient({ region: cfg.region });
  const targets = [{ role: "openplc", id: cfg.rigInstance, platform: "linux" as const }, ...(cfg.fioInstance ? [{ role: "factoryio", id: cfg.fioInstance, platform: "windows" as const }] : [])];
  const results = await Promise.all(targets.map((t) => runProbe(ssm, { instanceId: t.id, platform: t.platform })));
  targets.forEach((t, i) => console.log(`${t.role}: ${results[i].status}`, JSON.stringify({ checks: results[i].checks, stats: results[i].stats, detail: results[i].detail || undefined })));
  const healthy = rigHealthy(results);
  console.log(`rig healthy: ${healthy}`);
  process.exit(healthy ? 0 : 1);
} catch (e) {
  console.error(`rig-health: ${awsErr(e)}`);
  process.exit(2);
}
