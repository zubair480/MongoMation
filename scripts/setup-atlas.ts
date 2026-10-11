// Creates collections and indexes in the Atlas hackathon sandbox. Safe to re-run.
//   npm run setup:atlas
// Vector indexes are optional: if the cluster tier refuses them, the script says so and continues
// (retrieval then falls back to recency + keyword filters, and the dashboard shows "vector search: off").
import { client, col, connect, db, DB_NAME } from "../apps/worker/src/db/index.ts";
import { ensureExtraIndexes, ensurePrePostImages, ensureTtl, ensureValidators } from "../apps/worker/src/db/schema.ts";
import { explainQueueQueries } from "./atlas-explain.ts";

const log = (m: string) => console.log(m);
await connect();
log(`connected to ${DB_NAME}`);

// Measurements as a time series collection (fallback: regular collection with a compound index).
const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name));
if (!existing.has("measurements")) {
  try {
    await db.createCollection("measurements", { timeseries: { timeField: "ts", metaField: "meta", granularity: "seconds" } });
    log("measurements: time series collection created");
  } catch (err) {
    log(`measurements: time series unavailable (${(err as Error).message}); using a regular collection`);
    await db.createCollection("measurements");
  }
}

const idx: [keyof typeof col, Record<string, 1 | -1>, Record<string, unknown>?][] = [
  ["jobs", { status: 1, createdAt: 1 }],
  ["jobs", { projectId: 1, createdAt: -1 }],
  ["projects", { createdAt: -1 }],
  ["stages", { projectId: 1, revision: 1, stage: 1, attempt: 1 }, { unique: true }],
  ["events", { projectId: 1, ts: 1 }],
  ["events", { jobId: 1, ts: 1 }],
  ["requirements", { projectId: 1, revision: 1 }, { unique: true }],
  ["plcVersions", { projectId: 1, version: 1 }, { unique: true }],
  ["plcVersions", { sourceHash: 1 }],
  ["compiles", { plcVersionId: 1, stage: 1 }],
  ["deployments", { plcVersionId: 1 }],
  ["simRuns", { projectId: 1, startedAt: -1 }],
  ["testResults", { simRunId: 1 }],
  ["testResults", { projectId: 1, verdict: 1 }],
  ["testResults", { harnessVersion: 1, verdict: 1 }],
  ["measurements", { "meta.simRunId": 1, "meta.testId": 1, ts: 1 }],
  ["diagnoses", { projectId: 1, createdAt: -1 }],
  ["lessons", { active: 1, createdAt: -1 }],
  ["harness", { version: 1 }, { unique: true }],
  ["harness", { verdict: 1, version: -1 }],
  ["proposals", { createdAt: -1 }],
  ["benchmarks", { harnessVersion: 1, caseId: 1, condition: 1 }],
  ["manifests", { hash: 1 }, { unique: true }],
  ["workers", { heartbeatAt: -1 }],
  ["scenes", { id: 1 }, { unique: true }],
  ["traces", { runId: 1 }],
];
for (const [name, keys, opts] of idx) {
  await col[name]().createIndex(keys, opts ?? {});
}
log(`${idx.length} regular indexes ensured`);

// Data-platform guarantees (db/schema.ts): TTL on ephemeral collections, $jsonSchema validators (existing docs are
// checked first; strict only when none violate), change-stream pre/post images for the audit streams, meta-field
// indexes on the time series. Then prove the hot queue queries use an index (explain).
await ensureExtraIndexes(db, log);
await ensureTtl(db, log);
await ensureValidators(db, log);
await ensurePrePostImages(db, log);
for (const e of await explainQueueQueries(db)) log(`explain ${e.name}: ${e.stage} via ${e.index ?? "NO INDEX"} (keys ${e.keysExamined}, docs ${e.docsExamined}, returned ${e.returned})`);

// Atlas Vector Search on lessons and diagnosed failure patterns. Default: Automated Embedding (autoEmbed
// index on the `text` field, Atlas embeds documents and queries). EMBEDDING_MODE=voyage: bring-your-own
// 1024-dim vectors in `embedding`. Free clusters allow 3 search/vector indexes IN TOTAL — drop leftovers
// (e.g. a smoke_test index) first if you hit the cap.
const mode = process.env.EMBEDDING_MODE || "auto";
const dims = Number(process.env.EMBEDDING_DIMS || 1024);
for (const [name, filters] of [
  ["lessons", ["active", "verified"]],
  ["diagnoses", ["split", "sceneId"]],
] as const) {
  if (mode === "off") break;
  try {
    const coll = db.collection(name);
    if (!(await db.listCollections({ name }, { nameOnly: true }).toArray()).length) await db.createCollection(name);
    const indexName = `${name}_vec`;
    if ((await coll.listSearchIndexes().toArray()).some((i) => i.name === indexName)) {
      log(`${indexName}: exists`);
      continue;
    }
    const field =
      mode === "auto"
        ? { type: "autoEmbed", modality: "text", path: "text", model: process.env.EMBEDDING_MODEL || "voyage-4" }
        : { type: "vector", path: "embedding", numDimensions: dims, similarity: "cosine" };
    await coll.createSearchIndex({ name: indexName, type: "vectorSearch", definition: { fields: [field, ...filters.map((f) => ({ type: "filter", path: f }))] } });
    log(`${indexName}: created (${mode}; builds asynchronously — wait for queryable)`);
  } catch (err) {
    log(`${name}_vec: NOT created — ${(err as Error).message}`);
  }
}
await client.close();
