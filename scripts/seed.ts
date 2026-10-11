// Seeds harness v0 and the scene registry into Atlas. Safe to re-run.
//   npm run seed
// Scenes come from scenes/*.json (filled in and verified by Developer 1). A scene stays `verified: false`
// — and every validation on it BLOCKED — until its addresses were confirmed on the live rig.
import { readdirSync, readFileSync } from "node:fs";
import { SceneDefinition } from "@mongomation/types";
import { client, col, connect } from "../apps/worker/src/db/index.ts";
import { currentConfig, seedBaseline } from "../apps/worker/src/harness/config.ts";

await connect();
await seedBaseline();
const cur = await currentConfig();
console.log(`harness: current v${cur.version} (${cur.rules.length} rules)`);

const dir = new URL("../scenes/", import.meta.url);
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
  const parsed = SceneDefinition.safeParse(JSON.parse(readFileSync(new URL(f, dir), "utf8")));
  if (!parsed.success) {
    console.error(`scenes/${f}: invalid — ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    continue;
  }
  const s = parsed.data;
  await col.scenes().updateOne({ id: s.id }, { $set: { ...s, seededAt: new Date() } }, { upsert: true });
  console.log(`scene ${s.id}: ${s.tags.length} tags, ${s.faults.length} faults, ${s.verified ? "VERIFIED" : "UNVERIFIED (validation will be BLOCKED)"}`);
}
await client.close();
