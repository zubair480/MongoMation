// SSM in code (replaces the shell-only scripts/rig-env.sh path for the worker):
//  - GetParameter WithDecryption for the OpenPLC API password (value is never logged)
//  - Run Command health probe of the rig host(s); the parsed result feeds rig_status.aws + the RigHealthy metric
import { GetCommandInvocationCommand, GetParameterCommand, SendCommandCommand } from "@aws-sdk/client-ssm";
import type { Sender } from "./config.ts";

export async function getSecureParameter(ssm: Sender, name: string): Promise<string | null> {
  const r = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const v = r?.Parameter?.Value;
  return typeof v === "string" && v && v !== "None" ? v : null;
}

/**
 * Linux rig host probe (OpenPLC runtime). Prints exactly one JSON line; every check is a boolean.
 * Read-only: inspects processes and listening ports, changes nothing on the instance.
 */
export const LINUX_PROBE = [
  "set +e",
  'has() { "$@" >/dev/null 2>&1 && echo true || echo false; }',
  'listen() { (ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null) | grep -Eq "[:.]$1[[:space:]]" && echo true || echo false; }',
  "plc=$(has pgrep -f -i openplc)",
  "api=$(listen 8443)",
  "modbus=$(listen 502)",
  "docker_ok=$(has sh -c 'docker ps 2>/dev/null | grep -qi openplc')",
  "load=$(cut -d' ' -f1 /proc/loadavg)",
  "mem=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)",
  "disk=$(df -P / | awk 'NR==2{gsub(\"%\",\"\",$5); print $5}')",
  'up=$(cut -d" " -f1 /proc/uptime | cut -d. -f1)',
  'printf \'{"openplcProcess":%s,"openplcApiListening":%s,"modbusListening":%s,"openplcContainer":%s,"load1":%s,"memAvailableMb":%s,"diskUsedPct":%s,"uptimeS":%s}\\n\' "$plc" "$api" "$modbus" "$docker_ok" "${load:-0}" "${mem:-0}" "${disk:-0}" "${up:-0}"',
];

/** Windows Factory I/O host probe (optional; needs RIG_FIO_INSTANCE). */
export const WINDOWS_PROBE = [
  "$p = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'Factory*' })",
  "$w = [bool](Get-NetTCPConnection -State Listen -LocalPort 7410 -ErrorAction SilentlyContinue)",
  "$dcv = [bool](Get-Process -Name dcvserver -ErrorAction SilentlyContinue)",
  "@{ factoryioProcess = ($p.Count -gt 0); webApiListening = $w; dcvServer = $dcv } | ConvertTo-Json -Compress",
];

export interface ProbeResult {
  ok: boolean;
  status: string; // SSM invocation status (Success, Failed, TimedOut, ...)
  checks: Record<string, boolean>;
  stats: Record<string, number>;
  detail: string;
}

/** Parses the probe's JSON line out of stdout (ignores any banner noise). */
export function parseProbe(status: string, stdout: string): ProbeResult {
  const line = stdout.split(/\r?\n/).reverse().find((l) => l.trim().startsWith("{"));
  let obj: Record<string, unknown> = {};
  try {
    obj = line ? JSON.parse(line) : {};
  } catch {
    /* fall through: no checks */
  }
  const checks: Record<string, boolean> = {};
  const stats: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "boolean") checks[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) stats[k] = v;
  }
  return { ok: status === "Success" && Object.keys(checks).length > 0, status, checks, stats, detail: line ? "" : stdout.slice(-300) };
}

/** Runs a probe via SSM Run Command and waits (polling) for the result. */
export async function runProbe(
  ssm: Sender,
  args: { instanceId: string; platform: "linux" | "windows"; timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<unknown> },
): Promise<ProbeResult> {
  const sleep = args.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const sent = await ssm.send(
    new SendCommandCommand({
      InstanceIds: [args.instanceId],
      DocumentName: args.platform === "linux" ? "AWS-RunShellScript" : "AWS-RunPowerShellScript",
      Comment: "mongomation rig health probe (read-only)",
      TimeoutSeconds: 60,
      Parameters: { commands: args.platform === "linux" ? LINUX_PROBE : WINDOWS_PROBE, executionTimeout: ["30"] },
    }),
  );
  const commandId: string = sent?.Command?.CommandId;
  if (!commandId) return { ok: false, status: "NoCommandId", checks: {}, stats: {}, detail: "SendCommand returned no CommandId" };
  const deadline = Date.now() + (args.timeoutMs ?? 45_000);
  for (;;) {
    await sleep(args.pollMs ?? 2000);
    let inv: { Status?: string; StandardOutputContent?: string; StandardErrorContent?: string } | undefined;
    try {
      inv = await ssm.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: args.instanceId }));
    } catch (e) {
      if ((e as { name?: string })?.name !== "InvocationDoesNotExist") throw e; // not registered yet: keep polling
    }
    const st = inv?.Status ?? "Pending";
    if (!["Pending", "InProgress", "Delayed"].includes(st)) return parseProbe(st, `${inv?.StandardOutputContent ?? ""}`);
    if (Date.now() > deadline) return { ok: false, status: "ProbeTimeout", checks: {}, stats: {}, detail: `no result within ${args.timeoutMs ?? 45_000} ms (last ${st})` };
  }
}

/** Healthy = the invocation succeeded and every boolean check is true (optional checks excluded). */
export function rigHealthy(results: ProbeResult[], optional: string[] = ["openplcContainer", "dcvServer"]): boolean {
  return results.length > 0 && results.every((r) => r.ok && Object.entries(r.checks).every(([k, v]) => v || optional.includes(k)));
}
