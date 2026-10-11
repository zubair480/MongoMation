// Atlas Search (lexical) indexes for hybrid retrieval of engineering memory. Safe to re-run.
//   npm run setup:search            create missing indexes, add missing vector filter fields
//   npm run setup:search -- --wait  ... and wait until every memory index is queryable
//   npm run setup:search -- --update  also push changed lexical definitions to existing indexes
// Run after `npm run setup:atlas` (which creates the autoEmbed vector indexes). Never drops anything.
// Free (M0) clusters allow 3 search + vector indexes IN TOTAL: if a create is refused, the script lists every
// search index in the database so leftovers can be removed by hand (Atlas UI or dropSearchIndex).
import type { Document } from "mongodb";
import { client, connect, db, DB_NAME } from "../apps/worker/src/db/index.ts";
import { SEARCH_INDEX, VECTOR_FILTERS, VECTOR_INDEX, diagnosesSearchDefinition, lessonsSearchDefinition } from "../apps/worker/src/harness/search-indexes.ts";

const args = new Set(process.argv.slice(2));
const log = (m: string) => console.log(m);
await connect();
log(`connected to ${DB_NAME}`);

async function inventory() {
  const out: { collection: string; name: string; type?: string; status?: string; queryable?: boolean }[] = [];
  for (const { name } of await db.listCollections({ type: "collection" }, { nameOnly: true }).toArray()) {
    try {
      // The driver types listSearchIndexes() rows as { name }; Atlas also returns type/status/queryable/latestDefinition.
      for (const i of (await db.collection(name).listSearchIndexes().toArray()) as Document[]) out.push({ collection: name, name: i.name, type: i.type, status: i.status, queryable: i.queryable });
    } catch {
      /* time series collections etc. cannot carry search indexes */
    }
  }
  return out;
}

const before = await inventory();
log(`search/vector indexes in ${DB_NAME}: ${before.length}`);
for (const i of before) log(`  ${i.collection}.${i.name} (${i.type}, ${i.status}${i.queryable ? ", queryable" : ""})`);
const known = new Set([...Object.values(SEARCH_INDEX), ...Object.values(VECTOR_INDEX)]);
const unknown = before.filter((i) => !known.has(i.name as never));
if (unknown.length) log(`  not used by MongoMation (review; this script never drops): ${unknown.map((i) => `${i.collection}.${i.name}`).join(", ")}`);

// 1) Vector filter fields (e.g. lessons `verified`) so $vectorSearch pre-filters instead of post-filtering.
for (const [name, filters] of Object.entries(VECTOR_FILTERS) as [keyof typeof VECTOR_FILTERS, readonly string[]][]) {
  const coll = db.collection(name);
  const idx = ((await coll.listSearchIndexes(VECTOR_INDEX[name]).toArray()) as Document[])[0];
  if (!idx) {
    log(`${VECTOR_INDEX[name]}: missing (run npm run setup:atlas first)`);
    continue;
  }
  const fields = (idx.latestDefinition?.fields ?? []) as { type: string; path: string }[];
  const missing = filters.filter((f) => !fields.some((x) => x.type === "filter" && x.path === f));
  if (!missing.length) {
    log(`${VECTOR_INDEX[name]}: filter fields ok (${filters.join(", ")})`);
    continue;
  }
  try {
    await coll.updateSearchIndex(VECTOR_INDEX[name], { fields: [...fields, ...missing.map((path) => ({ type: "filter", path }))] });
    log(`${VECTOR_INDEX[name]}: added filter field(s) ${missing.join(", ")} (rebuilds asynchronously)`);
  } catch (err) {
    log(`${VECTOR_INDEX[name]}: could not add filter field(s) ${missing.join(", ")}: ${(err as Error).message}`);
  }
}

// 2) Lexical indexes, in priority order (diagnoses carries the data and the dashboard facets).
const lexical = [
  ["diagnoses", SEARCH_INDEX.diagnoses, diagnosesSearchDefinition],
  ["lessons", SEARCH_INDEX.lessons, lessonsSearchDefinition],
] as const;
for (const [name, indexName, definition] of lexical) {
  try {
    if (!(await db.listCollections({ name }, { nameOnly: true }).toArray()).length) await db.createCollection(name);
    const coll = db.collection(name);
    if ((await coll.listSearchIndexes(indexName).toArray()).length) {
      if (args.has("--update")) {
        await coll.updateSearchIndex(indexName, definition);
        log(`${indexName}: definition updated (rebuilds asynchronously)`);
      } else log(`${indexName}: exists`);
      continue;
    }
    await coll.createSearchIndex({ name: indexName, type: "search", definition });
    log(`${indexName}: created (builds asynchronously — wait for queryable)`);
  } catch (err) {
    log(`${indexName}: NOT created — ${(err as Error).message}`);
    log(`  (free/M0 clusters allow 3 search + vector indexes in total; retrieval on ${name} stays vector-only until this exists)`);
  }
}

if (args.has("--wait")) {
  const wanted = [...known];
  for (let i = 0; i < 60; i++) {
    const now = (await inventory()).filter((x) => wanted.includes(x.name as never));
    const pending = now.filter((x) => !x.queryable || x.status !== "READY");
    if (!pending.length) break;
    log(`waiting for: ${pending.map((x) => `${x.name} (${x.status})`).join(", ")}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
const after = await inventory();
log(`done: ${after.length} search/vector index(es): ${after.map((i) => `${i.collection}.${i.name}=${i.status}`).join(", ")}`);
await client.close();
