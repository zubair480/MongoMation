// Rig cost control via the EC2 API (SDK, not shell). Default is read-only status.
//   npx tsx --env-file-if-exists=.env scripts/rig-power.ts status
//   npx tsx --env-file-if-exists=.env scripts/rig-power.ts start [--dry-run]
//   npx tsx --env-file-if-exists=.env scripts/rig-power.ts stop --yes [--dry-run]    # stop REQUIRES --yes
// Env: RIG_INSTANCE (instance id, private handoff / .env), MM_AWS_REGION | AWS_REGION | RIG_REGION (default us-west-2).
// Credentials: the normal AWS chain (aws login / SSO / env / instance role). Nothing is printed besides state.
import { EC2Client } from "@aws-sdk/client-ec2";
import { awsErr, awsSettings } from "../apps/worker/src/aws/config.ts";
import { describeRig, startRig, stopRig } from "../apps/worker/src/aws/ec2.ts";

const [cmd = "status", ...flags] = process.argv.slice(2);
const cfg = awsSettings();
const dryRun = flags.includes("--dry-run");
if (!cfg.rigInstance) {
  console.error("rig-power: RIG_INSTANCE is not set (EC2 instance id from the private handoff)");
  process.exit(3);
}
const ec2 = new EC2Client({ region: cfg.region });

try {
  if (cmd === "status") {
    const r = await describeRig(ec2, cfg.rigInstance);
    console.log(r ? `rig ${r.name ?? r.instanceId}: ${r.state} (${r.type}, launched ${r.launchTime?.toISOString() ?? "?"})` : "rig instance not found");
  } else if (cmd === "start") {
    console.log(`start: ${await startRig(ec2, cfg.rigInstance, dryRun)}`);
  } else if (cmd === "stop") {
    if (!flags.includes("--yes") && !dryRun) {
      console.error("rig-power: stop needs --yes (it powers off OpenPLC for everyone using the rig). Use --dry-run to test permissions.");
      process.exit(2);
    }
    console.log(`stop: ${await stopRig(ec2, cfg.rigInstance, dryRun)}`);
  } else {
    console.error("usage: rig-power.ts status | start [--dry-run] | stop --yes [--dry-run]");
    process.exit(1);
  }
} catch (e) {
  console.error(`rig-power: ${awsErr(e)}`);
  process.exit(1);
}
