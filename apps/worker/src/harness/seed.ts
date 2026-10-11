// Operator-made harness versions for the RSI demo. Both are APPEND-ONLY (history is never edited in place):
//   seed    : a new version = bareCondition(v0) (no rules, no lessons, no preflight, no state machine) but with
//             repair budget 1 so failures still produce diagnoses. Inserted with verdict "kept", so it becomes
//             current (currentConfig = newest kept version) and the next evolve proposes relative to it.
//   restore : a new version copying vN's body (e.g. v0), verdict "kept", so vN's behaviour is current again.
// Pending candidates proposed from an older parent are then rejected by the gate as "stale parent".
import type { HarnessConfig } from "@mongomation/types";
import { MongoServerError } from "mongodb";
import { col } from "../db/index.ts";
import { bareCondition } from "../rsi/evolve.ts";
import { currentConfig, getConfig } from "./config.ts";

export const SEED_LABEL = "seed";
export const SEED_RATIONALE = "RSI seed: minimal harness, no domain rules (honest baseline)";

/** Pure: the seed config built from v0 (bare one-shot control + repair budget 1). */
export function seedConfig(v0: HarnessConfig, version: number, createdAt = new Date().toISOString()): HarnessConfig {
  const bare = bareCondition(v0);
  return {
    rules: [],
    context: { ...bare.context, lessons_k: 0 },
    workflow: { ...bare.workflow, repair_budget: 1, run_regression_tests: true },
    repair: bare.repair,
    routing: bare.routing,
    version,
    parent: v0.version,
    verdict: "kept",
    rationale: SEED_RATIONALE,
    label: SEED_LABEL,
    createdAt,
  };
}

/** Pure: a copy of `src`'s body as a new current version. */
export function restoredConfig(src: HarnessConfig, version: number, createdAt = new Date().toISOString()): HarnessConfig {
  return {
    rules: src.rules,
    context: src.context,
    workflow: src.workflow,
    repair: src.repair,
    routing: src.routing,
    version,
    parent: src.version,
    verdict: "kept",
    rationale: `Restore: v${src.version} made current again (operator action; copy of its body, history is append-only).`,
    label: `restore:v${src.version}`,
    restoredFrom: src.version,
    createdAt,
  };
}

async function insertNext(build: (version: number) => HarnessConfig): Promise<HarnessConfig> {
  for (let tries = 0; ; tries++) {
    const [latest] = await col.harness().find({}, { sort: { version: -1 }, limit: 1, projection: { version: 1 } }).toArray();
    const doc = build(((latest?.version as number | undefined) ?? -1) + 1);
    try {
      await col.harness().insertOne({ ...doc });
      return doc;
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000 && tries < 5) continue;
      throw err;
    }
  }
}

/** Creates the seed and makes it current. Idempotent: if the current harness already is a seed, returns it. */
export async function makeSeedCurrent(): Promise<{ created: boolean; config: HarnessConfig; previous: HarnessConfig }> {
  const previous = await currentConfig();
  if (previous.label === SEED_LABEL) return { created: false, config: previous, previous };
  const v0 = await getConfig(0);
  if (!v0) throw new Error("harness v0 missing in Atlas; run npm run seed");
  return { created: true, config: await insertNext((version) => seedConfig(v0, version)), previous };
}

/** Makes version `from` current again by appending a copy of it. */
export async function restoreVersion(from: number): Promise<{ config: HarnessConfig; previous: HarnessConfig }> {
  const previous = await currentConfig();
  const src = await getConfig(from);
  if (!src) throw new Error(`harness v${from} not found`);
  return { config: await insertNext((version) => restoredConfig(src, version)), previous };
}
