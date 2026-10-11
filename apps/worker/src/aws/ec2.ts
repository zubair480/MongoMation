// Rig cost control through the EC2 API (start / stop / describe). Used by scripts/rig-power.ts.
// Stopping requires an explicit confirm flag in the caller; DryRun lets you prove permissions without acting.
import { DescribeInstancesCommand, StartInstancesCommand, StopInstancesCommand } from "@aws-sdk/client-ec2";
import type { Sender } from "./config.ts";

export interface RigInstance {
  instanceId: string;
  state: string;
  type: string | null;
  launchTime: Date | null;
  name: string | null;
  tags: Record<string, string>;
}

export async function describeRig(ec2: Sender, instanceId: string): Promise<RigInstance | null> {
  const r = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  const i = r?.Reservations?.[0]?.Instances?.[0];
  if (!i) return null;
  const tags = Object.fromEntries(((i.Tags ?? []) as { Key?: string; Value?: string }[]).map((t) => [t.Key ?? "", t.Value ?? ""]));
  return { instanceId, state: i.State?.Name ?? "unknown", type: i.InstanceType ?? null, launchTime: i.LaunchTime ?? null, name: tags.Name ?? null, tags };
}

/** DryRun success comes back as a DryRunOperation *error*: normalise to "allowed". */
async function act(ec2: Sender, cmd: unknown, dryRun: boolean): Promise<string> {
  try {
    const r = await ec2.send(cmd);
    const change = (r?.StartingInstances ?? r?.StoppingInstances)?.[0];
    return change ? `${change.PreviousState?.Name} -> ${change.CurrentState?.Name}` : "ok";
  } catch (e) {
    if (dryRun && (e as { name?: string })?.name === "DryRunOperation") return "dry-run: permitted";
    throw e;
  }
}

export const startRig = (ec2: Sender, instanceId: string, dryRun = false) => act(ec2, new StartInstancesCommand({ InstanceIds: [instanceId], DryRun: dryRun }), dryRun);

export const stopRig = (ec2: Sender, instanceId: string, dryRun = false) => act(ec2, new StopInstancesCommand({ InstanceIds: [instanceId], DryRun: dryRun }), dryRun);
