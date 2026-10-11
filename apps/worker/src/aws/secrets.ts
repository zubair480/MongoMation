// Worker secrets from AWS Secrets Manager / SSM Parameter Store. Only fills env vars that are UNSET, so a
// value in .env / .env.rig / the shell always wins. Returns the names it set - never the values.
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import type { Sender } from "./config.ts";
import { getSecureParameter } from "./ssm.ts";

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

export async function loadSecretIntoEnv(sm: Sender, secretId: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const r = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  const raw = r?.SecretString;
  if (typeof raw !== "string") return [];
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error(`secret ${secretId} is not a JSON object of ENV_NAME -> value`);
  }
  const set: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!ENV_NAME.test(k) || (typeof v !== "string" && typeof v !== "number") || String(v) === "") continue;
    if (env[k]) continue;
    env[k] = String(v);
    set.push(k);
  }
  return set;
}

/** OPENPLC_PASSWORD from SSM Parameter Store (same parameter scripts/rig-env.sh reads). */
export async function loadOpenPlcPassword(ssm: Sender, param: string, env: NodeJS.ProcessEnv = process.env): Promise<"already_set" | "loaded" | "missing"> {
  if (env.OPENPLC_PASSWORD) return "already_set";
  const v = await getSecureParameter(ssm, param);
  if (!v) return "missing";
  env.OPENPLC_PASSWORD = v;
  return "loaded";
}
