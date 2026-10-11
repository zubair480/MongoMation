// Experience recall backfill: stamp the requirement fingerprint on existing verified_programs and projects (from each
// project's latest stored bound requirements) and create the {sceneId, fingerprint} indexes. Idempotent.
//   npm run recall:backfill            write
//   npm run recall:backfill -- --dry   only report
// Reads requirements only (kind, support, bindings, params); writes the fingerprint string. No test definitions.
// Spec-level recall: also stamps specHash (from the stored specText + the scene's current I/O map), the replay
// (requirements stage output + bound requirements + I/O map), originProjectId (lineage), and planHash ONLY when the
// recomputed plan hash provably equals the plan the source's final simulate stage ran (stage inputHash match).
import { ObjectId } from "mongodb";
import { client, col, connect, db } from "../apps/worker/src/db/index.ts";
import type { BoundRequirement, SceneDefinition } from "@mongomation/types";
import { FINGERPRINT_VERSION, PROGRAMS_COLLECTION, RECALL_INDEX, SPEC_RECALL_INDEX, requirementFingerprint, specHash } from "../apps/worker/src/harness/programs.ts";
import { hashOf } from "../apps/worker/src/harness/stages.ts";
import { buildTestPlan } from "../apps/worker/src/pipeline/validate.ts";

const dry = process.argv.includes("--dry");
await connect();
const programs = db.collection(PROGRAMS_COLLECTION);

async function fingerprintOf(projectId: string, sceneId: string): Promise<string | null> {
  const reqDoc = await col.requirements().findOne({ projectId }, { sort: { revision: -1 } });
  const reqs = reqDoc?.requirements as Parameters<typeof requirementFingerprint>[1] | undefined;
  return reqs?.length ? requirementFingerprint(sceneId, reqs) : null;
}

let progDone = 0;
let progSkip = 0;
const scenes = new Map<string, SceneDefinition | null>();
const sceneOf = async (id: string) => {
  if (!scenes.has(id)) {
    const d = await col.scenes().findOne({ id });
    scenes.set(id, d ? ({ ...d, _id: undefined } as unknown as SceneDefinition) : null);
  }
  return scenes.get(id)!;
};

let specDone = 0;
for (const p of await programs.find({}, { projection: { projectId: 1, sceneId: 1, fingerprint: 1, specText: 1, plcVersionId: 1, originProjectId: 1, planHash: 1 } }).toArray()) {
  const projectId = String(p.projectId);
  const fp = await fingerprintOf(projectId, String(p.sceneId));
  if (!fp) {
    progSkip++;
    console.log(`  skip program ${projectId}: no stored requirements`);
    continue;
  }
  const set: Record<string, unknown> = { fingerprint: fp };
  if (!p.originProjectId) set.originProjectId = projectId;
  const scene = await sceneOf(String(p.sceneId));
  const reqDoc = await col.requirements().findOne({ projectId }, { sort: { revision: -1 } });
  const stage = await col.stages().findOne({ projectId, stage: "requirements", status: "done" }, { sort: { revision: -1 } });
  const extracted = (stage?.output as { requirements?: unknown } | undefined)?.requirements;
  let note = "";
  if (scene && p.specText && reqDoc?.requirements?.length && reqDoc?.io?.length && extracted != null) {
    set.specHash = specHash(String(p.specText), scene);
    set.replay = { requirements: extracted, bound: reqDoc.requirements, io: reqDoc.io };
    specDone++;
    note += ` specHash ${String(set.specHash).slice(0, 14)}…`;
    // planHash: only if it provably equals the plan the final simulate stage ran.
    const ver = await col.plcVersions().findOne({ _id: (/^[0-9a-f]{24}$/.test(String(p.plcVersionId)) ? new ObjectId(String(p.plcVersionId)) : p.plcVersionId) as never });
    const planHash = buildTestPlan(reqDoc.requirements as BoundRequirement[], scene, { includeHidden: true }).hash;
    const sims = ver ? await col.stages().find({ projectId, stage: "simulate", status: "done" }).toArray() : [];
    if (ver && sims.some((st) => st.inputHash === hashOf({ sourceHash: ver.sourceHash, plan: planHash }))) {
      set.planHash = planHash;
      note += ` planHash ${planHash.slice(0, 12)} (verified against simulate stage)`;
    } else note += ` planHash NOT set (recomputed plan does not match a stored full simulate run)`;
  } else note += ` no specHash (scene ${scene ? "ok" : "missing"}, specText ${p.specText ? "ok" : "missing"}, bound ${reqDoc?.requirements?.length ?? 0}, io ${reqDoc?.io?.length ?? 0}, extracted ${extracted != null})`;
  console.log(`  program ${projectId} scene ${p.sceneId} -> ${fp.slice(0, 20)}…${p.fingerprint && p.fingerprint !== fp ? " (changed)" : ""};${note}`);
  if (!dry) await programs.updateOne({ _id: p._id }, { $set: set });
  progDone++;
}

let projDone = 0;
for (const p of await col.projects().find({ fingerprint: { $not: new RegExp(`^fp${FINGERPRINT_VERSION}:`) }, sceneId: { $exists: true } }, { projection: { _id: 1, sceneId: 1 } }).toArray()) {
  const fp = await fingerprintOf(String(p._id), String(p.sceneId));
  if (!fp) continue;
  if (!dry) await col.projects().updateOne({ _id: p._id }, { $set: { fingerprint: fp } });
  projDone++;
}

if (!dry) {
  await programs.createIndex(RECALL_INDEX.keys, { name: RECALL_INDEX.name });
  await programs.createIndex(SPEC_RECALL_INDEX.keys, { name: SPEC_RECALL_INDEX.name });
  await col.projects().createIndex({ sceneId: 1, fingerprint: 1, createdAt: 1 }, { name: "scene_fingerprint" });
}
// Learning-curve preview: how many verified programs share each fingerprint.
const groups = await programs.aggregate([{ $match: { fingerprint: { $exists: true } } }, { $group: { _id: { sceneId: "$sceneId", fp: "$fingerprint" }, n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 10 }]).toArray();
for (const g of groups) console.log(`  ${g._id.sceneId} ${String(g._id.fp).slice(0, 20)}…: ${g.n} verified program(s)`);
console.log(`done${dry ? " (dry)" : ""}: ${progDone} program(s) fingerprinted, ${progSkip} skipped, ${specDone} spec-hashed, ${projDone} project(s) fingerprinted${dry ? "" : "; indexes ensured"}`);
await client.close();
