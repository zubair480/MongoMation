import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Document } from "mongodb";
import {
  SEARCH_READ,
  hybridSearch,
  lexicalPipeline,
  lexicalQuery,
  maybeRerank,
  rankFusionPipeline,
  resetFusionSupport,
  rrfMerge,
  scoreFusionPipeline,
  vectorStage,
  type HybridSpec,
} from "../src/harness/memory.ts";
import { VECTOR_FILTERS, diagnosesSearchDefinition, lessonsSearchDefinition } from "../src/harness/search-indexes.ts";

const ENV = ["SEARCH_FUSION", "SEARCH_RERANK", "VOYAGE_API_KEY", "EMBEDDING_MODE"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  for (const k of ENV) delete process.env[k];
  resetFusionSupport();
});
afterEach(() => {
  for (const k of ENV) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]));
});

/** Fake collection: answers each aggregate by its first stage; records pipelines and options. */
function fakeColl(answer: (stage: string, pipeline: Document[]) => Document[] | Error) {
  const calls: { stage: string; pipeline: Document[]; options: unknown }[] = [];
  return {
    calls,
    coll: {
      aggregate(pipeline: Document[], options: unknown) {
        const stage = Object.keys(pipeline[0])[0];
        calls.push({ stage, pipeline, options });
        return { toArray: async () => { const r = answer(stage, pipeline); if (r instanceof Error) throw r; return r; } };
      },
    } as never,
  };
}

const spec = (): HybridSpec => ({
  vector: { $vectorSearch: { index: "v", path: "text", query: { text: "q" }, numCandidates: 50, limit: 3, filter: { split: "train", sceneId: "s1" } } },
  lexical: lexicalPipeline("l", "conveyor never starts", ["text"], { split: "train", sceneId: "s1" }, 3),
  limit: 3,
  project: { summary: 1 },
});

describe("lexical query building", () => {
  it("dedupes, drops short tokens, keeps PLC addresses and caps the term count", () => {
    assert.equal(lexicalQuery("The the conveyor %IX0.1 at Conveyor on stop."), "The conveyor %IX0.1 stop");
    assert.equal(lexicalQuery(Array.from({ length: 100 }, (_, i) => `word${i}`).join(" "), 5).split(" ").length, 5);
  });
  it("puts exact filters in compound.filter (non-scoring) and fuzzy text in should", () => {
    const [s, l] = lexicalPipeline("diagnoses_search", "jam timer", ["text", "summary"], { split: "train", sceneId: "abc" }, 7);
    assert.deepEqual(s.$search.compound.filter, [{ equals: { path: "split", value: "train" } }, { equals: { path: "sceneId", value: "abc" } }]);
    assert.deepEqual(s.$search.compound.should[0].text.fuzzy, { maxEdits: 1, prefixLength: 2 });
    assert.deepEqual(l, { $limit: 7 });
  });
});

describe("vector stage", () => {
  it("auto mode passes the query text for Atlas to embed, with the caller's pre-filter", async () => {
    const st = await vectorStage("lessons_vec", "q", 4, { active: true, verified: true });
    assert.deepEqual(st.$vectorSearch.query, { text: "q" });
    assert.deepEqual(st.$vectorSearch.filter, { active: true, verified: true });
    assert.equal(st.$vectorSearch.numCandidates, 80);
  });
});

describe("fusion pipelines", () => {
  it("$rankFusion: vector + lexical input pipelines, projection only after fusion", () => {
    const p = rankFusionPipeline(spec());
    assert.deepEqual(Object.keys(p[0].$rankFusion.input.pipelines), ["vector", "lexical"]);
    assert.equal(p[0].$rankFusion.input.pipelines.vector[0].$vectorSearch.filter.sceneId, "s1");
    assert.ok(!JSON.stringify(p[0]).includes("$project"));
    assert.deepEqual(p[2].$project.score, { $meta: "score" });
  });
  it("$scoreFusion uses sigmoid normalization and avg combination", () => {
    const p = scoreFusionPipeline(spec());
    assert.equal(p[0].$scoreFusion.input.normalization, "sigmoid");
    assert.equal(p[0].$scoreFusion.combination.method, "avg");
  });
});

describe("rrfMerge", () => {
  it("matches the $rankFusion formula and ranks docs found by both sides first", () => {
    const out = rrfMerge([{ docs: [{ _id: "a" }, { _id: "b" }], weight: 1 }, { docs: [{ _id: "b" }, { _id: "c" }], weight: 1 }], 10);
    assert.deepEqual(out.map((d) => d._id), ["b", "a", "c"]);
    assert.equal(out[0].score, 1 / 62 + 1 / 61);
    assert.equal(out[1].score, 1 / 61);
  });
  it("honours weights and the limit", () => {
    const out = rrfMerge([{ docs: [{ _id: "a" }], weight: 0.1 }, { docs: [{ _id: "c" }], weight: 1 }], 1);
    assert.deepEqual(out.map((d) => d._id), ["c"]);
  });
});

describe("hybridSearch degradation", () => {
  it("uses server-side $rankFusion by default, with readConcern local", async () => {
    const f = fakeColl((st) => (st === "$rankFusion" ? [{ _id: 1, summary: "x", score: 0.03 }] : new Error("unexpected")));
    const r = await hybridSearch(f.coll, spec());
    assert.equal(r.via, "rankFusion");
    assert.equal(r.hits.length, 1);
    assert.deepEqual(f.calls[0].options, SEARCH_READ);
  });
  it("score mode: $scoreFusion unsupported -> $rankFusion, and remembers the refusal", async () => {
    process.env.SEARCH_FUSION = "score";
    const unknown = Object.assign(new Error("Unrecognized pipeline stage name: '$scoreFusion'"), { code: 40324 });
    const f = fakeColl((st) => (st === "$scoreFusion" ? unknown : [{ _id: 1, summary: "x" }]));
    assert.equal((await hybridSearch(f.coll, spec())).via, "rankFusion");
    assert.equal((await hybridSearch(f.coll, spec())).via, "rankFusion");
    assert.deepEqual(f.calls.map((c) => c.stage), ["$scoreFusion", "$rankFusion", "$rankFusion"]);
  });
  it("fusion stage refused -> client RRF over separate vector and lexical queries", async () => {
    const f = fakeColl((st) => (st === "$rankFusion" ? new Error("Unrecognized pipeline stage name: '$rankFusion'") : st === "$vectorSearch" ? [{ _id: "a" }, { _id: "b" }] : [{ _id: "b" }]));
    const r = await hybridSearch(f.coll, spec());
    assert.equal(r.via, "client-rrf");
    assert.deepEqual(r.hits.map((h) => h._id), ["b", "a"]);
  });
  it("vector side rate-limited -> lexical results still come back", async () => {
    const f = fakeColl((st) => (st === "$search" ? [{ _id: "z" }] : new Error("rate limit exceeded")));
    const r = await hybridSearch(f.coll, spec());
    assert.equal(r.via, "lexical");
    assert.deepEqual(r.hits.map((h) => h._id), ["z"]);
  });
  it("both sides failing throws (caller falls back to recency)", async () => {
    const f = fakeColl(() => new Error("down"));
    await assert.rejects(hybridSearch(f.coll, spec()), /vector: down; lexical: down/);
  });
  it("SEARCH_FUSION=vector keeps the semantic-only behaviour", async () => {
    process.env.SEARCH_FUSION = "vector";
    const f = fakeColl(() => [{ _id: 1 }]);
    assert.equal((await hybridSearch(f.coll, spec())).via, "vector");
    assert.equal(f.calls[0].stage, "$vectorSearch");
  });
});

describe("Voyage rerank", () => {
  const hits = [{ t: "a", score: 1 }, { t: "b", score: 0.5 }, { t: "c", score: 0.2 }];
  it("is a no-op (truncate) without SEARCH_RERANK=voyage and a key", async () => {
    let called = false;
    const out = await maybeRerank("q", hits, (h) => h.t, 2, (async () => ((called = true), new Response("{}"))) as typeof fetch);
    assert.equal(called, false);
    assert.deepEqual(out.map((h) => h.t), ["a", "b"]);
  });
  it("re-orders by relevance_score when enabled", async () => {
    process.env.SEARCH_RERANK = "voyage";
    process.env.VOYAGE_API_KEY = "test-key";
    let body: Record<string, unknown> = {};
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ data: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.4 }] }));
    }) as unknown as typeof fetch;
    const out = await maybeRerank("q", hits, (h) => h.t, 2, fakeFetch);
    assert.deepEqual(out.map((h) => [h.t, h.score]), [["c", 0.9], ["a", 0.4]]);
    assert.deepEqual(body.documents, ["a", "b", "c"]);
    assert.equal(body.top_k, 2);
  });
  it("keeps fusion order when the rerank call fails", async () => {
    process.env.SEARCH_RERANK = "voyage";
    process.env.VOYAGE_API_KEY = "test-key";
    const out = await maybeRerank("q", hits, (h) => h.t, 3, (async () => new Response("no", { status: 401 })) as unknown as typeof fetch);
    assert.deepEqual(out.map((h) => h.t), ["a", "b", "c"]);
  });
});

describe("search index definitions", () => {
  it("facet and filter fields are token/boolean typed (required by equals + string facets)", () => {
    const d = diagnosesSearchDefinition.mappings.fields;
    for (const f of ["sceneId", "split", "faultId"] as const) assert.equal(d[f].type, "token");
    assert.ok(d.summary.some((x) => x.type === "autocomplete"));
    assert.equal(lessonsSearchDefinition.mappings.fields.verified.type, "boolean");
    assert.deepEqual([...VECTOR_FILTERS.lessons], ["active", "verified"]);
    assert.deepEqual([...VECTOR_FILTERS.diagnoses], ["split", "sceneId"]);
  });
});
