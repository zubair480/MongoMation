// Backfill Verified Program Memory from projects whose last measured run passed EVERY test (train split).
//   npm run memory:backfill            upsert all fully passing projects
//   npm run memory:backfill -- --dry   only report what would be stored
// Stores spec, requirement summary (kinds + roles), final ST source and test COUNTS; never test definitions.
import { ObjectId, type Document } from "mongodb";
import { client, col, connect, db, DB_NAME } from "../apps/worker/src/db/index.ts";
import { PROGRAMS_COLLECTION, buildVerifiedProgram, selectBackfill, upsertVerifiedProgram, type BackfillCandidate, type BackfillRun } from "../apps/worker/src/harness/programs.ts";

const dry = process.argv.includes("--dry");
await connect();
const projects = ((await col.projects().find({ lastSimRunId: { $ne: null } }, { projection: { _id: 1, status: 1, finalPlcVersionId: 1, lastSimRunId: 1, sceneId: 1, specText: 1, harnessVersion: 1, revision: 1 } }).toArray()) as Document[]).map(
  (p): Document & { projectId: string } => ({ ...p, projectId: String(p._id) }),
);
const runIds = projects.map((p) => p.lastSimRunId).filter(Boolean).map((id) => (ObjectId.isValid(String(id)) ? new ObjectId(String(id)) : id));
const runs = new Map<string, BackfillRun>();
for (const r of await col.simRuns().find({ _id: { $in: runIds as never[] } }, { projection: { passed: 1, failed: 1, blocked: 1, plcVersionId: 1, split: 1 } }).toArray())
  runs.set(String(r._id), { _id: r._id, passed: Number(r.passed ?? 0), failed: Number(r.failed ?? 0), blocked: Number(r.blocked ?? 0), plcVersionId: r.plcVersionId as string | undefined, split: r.split as string | undefined });

const selected = selectBackfill(projects as unknown as BackfillCandidate[], runs);
console.log(`${DB_NAME}: ${projects.length} project(s) with a measured run, ${selected.length} fully passing`);
let stored = 0;
let skipped = 0;
for (const s of selected) {
  const p = projects.find((x) => x.projectId === s.projectId)!;
  const version = await col.plcVersions().findOne({ _id: new ObjectId(s.plcVersionId) });
  const reqDoc = await col.requirements().findOne({ projectId: s.projectId }, { sort: { revision: -1 } });
  if (!version?.source || !reqDoc?.requirements || !p.specText) {
    skipped++;
    console.log(`  skip ${s.projectId}: missing ${!version?.source ? "program source" : !reqDoc?.requirements ? "requirements" : "spec"}`);
    continue;
  }
  const doc = buildVerifiedProgram({
    projectId: s.projectId,
    sceneId: String(p.sceneId),
    specText: String(p.specText),
    requirements: reqDoc.requirements,
    stSource: String(version.source),
    plcVersionId: s.plcVersionId,
    run: s.run,
    harnessVersion: Number(version.harnessVersion ?? p.harnessVersion ?? 0),
    verifiedAt: (version.createdAt as Date | undefined) ?? new Date(),
  });
  console.log(`  ${dry ? "would store" : "store"} ${s.projectId} (${p.status}, ${doc.tests.passed}/${doc.tests.total} tests, scene ${doc.sceneId}, kinds ${doc.requirementKinds.join(",")})`);
  if (!dry) await upsertVerifiedProgram(doc);
  stored++;
}
console.log(`done: ${stored} ${dry ? "eligible" : "upserted"}, ${skipped} skipped; ${PROGRAMS_COLLECTION} now holds ${await db.collection(PROGRAMS_COLLECTION).countDocuments()} program(s)`);
await client.close();
