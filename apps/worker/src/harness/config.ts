// Versioned harness configuration in Atlas. Never edited in place: every change is a new version whose
// `parent` is the version it came from. "Current" = newest version with verdict "kept".
import { readFileSync } from "node:fs";
import type { HarnessBody, HarnessConfig } from "@mongomation/types";
import { MongoServerError } from "mongodb";
import { col } from "../db/index.ts";

export const BASELINE: HarnessConfig = {
  ...JSON.parse(readFileSync(new URL("../../../../harness/v0.json", import.meta.url), "utf8")),
  createdAt: "2026-10-11T00:00:00.000Z",
};

const strip = ({ _id, ...c }: HarnessConfig & { _id?: unknown }) => c as HarnessConfig;

export async function seedBaseline() {
  await col.harness().updateOne({ version: 0 }, { $setOnInsert: BASELINE }, { upsert: true });
}

export async function currentConfig(): Promise<HarnessConfig> {
  const doc = await col.harness().findOne({ verdict: "kept" }, { sort: { version: -1 } });
  if (!doc) throw new Error("no kept harness config in Atlas; run npm run seed");
  return strip(doc as unknown as HarnessConfig);
}

export async function getConfig(version: number) {
  const doc = await col.harness().findOne({ version });
  return doc ? strip(doc as unknown as HarnessConfig) : null;
}

export async function history(): Promise<HarnessConfig[]> {
  return (await col.harness().find({}, { sort: { version: 1 } }).toArray()).map((d) => strip(d as unknown as HarnessConfig));
}

/** Stores a candidate as a new "pending" version on top of `parent`. Returns it. */
export async function storeCandidate(parent: HarnessConfig, body: HarnessBody, rationale: string, evidence: HarnessConfig["evidence"]) {
  for (let tries = 0; ; tries++) {
    const [latest] = await col.harness().find({}, { sort: { version: -1 }, limit: 1, projection: { version: 1 } }).toArray();
    const next: HarnessConfig = {
      ...body,
      version: ((latest?.version as number | undefined) ?? -1) + 1,
      parent: parent.version,
      verdict: "pending",
      rationale,
      evidence,
      createdAt: new Date().toISOString(),
    };
    try {
      await col.harness().insertOne({ ...next });
      return next;
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000 && tries < 5) continue;
      throw err;
    }
  }
}

export async function recordVerdict(version: number, update: Partial<HarnessConfig>) {
  await col.harness().updateOne({ version, verdict: "pending" }, { $set: { ...update, decidedAt: new Date().toISOString() } });
}
