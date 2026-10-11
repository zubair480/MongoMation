// Engineering memory: verified lessons and diagnosed failure patterns, retrieved with Atlas hybrid search
// (Vector Search + Atlas Search fused with $rankFusion).
// EMBEDDING_MODE:
//   auto   (default) Atlas Automated Embedding: an `autoEmbed` vector index on the `text` field; Atlas embeds
//          documents and queries itself (Voyage models hosted by MongoDB; no key in our code). Free clusters
//          without a payment method are limited to 3 query RPM per model.
//   voyage bring-your-own embeddings via the Voyage API (VOYAGE_API_KEY; Atlas model keys use ai.mongodb.com).
//   off    recency only.
// SEARCH_FUSION (how the semantic and lexical result lists are merged):
//   rank   (default) server-side $rankFusion (reciprocal rank fusion, MongoDB 8.0+).
//   score  server-side $scoreFusion (MongoDB 8.3+); falls back to rank, then client.
//   client run $vectorSearch and $search separately and fuse with RRF in the worker.
//   vector semantic only (the pre-hybrid behaviour).
// Any fusion failure degrades: server fusion -> client RRF (keeps whichever side still answers) -> recency.
// SEARCH_RERANK=voyage re-orders fused candidates with the Voyage rerank API (needs VOYAGE_API_KEY).
// Search stages must run with readConcern "local" (Atlas rejects $search/$vectorSearch under "majority",
// which is the client default), so every search aggregate here passes SEARCH_READ.
// The context policy (k values, on/off) comes from the harness config, so the meta-harness can tune it.
// Only lessons that preceded a measured fix are "verified"; held-out benchmark runs never write memory.
import type { HarnessConfig } from "@mongomation/types";
import type { AggregateOptions, Collection, Document } from "mongodb";
import { col } from "../db/index.ts";
import { SEARCH_INDEX, VECTOR_INDEX } from "./search-indexes.ts";

export type EmbeddingMode = "auto" | "voyage" | "off";
export const embeddingMode = (): EmbeddingMode => (process.env.EMBEDDING_MODE as EmbeddingMode) || "auto";
const MODEL = () => process.env.EMBEDDING_MODEL || "voyage-4";
export type FusionMode = "rank" | "score" | "client" | "vector";
export const fusionMode = (): FusionMode => (process.env.SEARCH_FUSION as FusionMode) || "rank";
// Read at call time (keys may be rotated without a restart of anything that re-reads env).
const voyageKey = () => (process.env.VOYAGE_API_KEY ?? "").trim();
export const rerankEnabled = () => process.env.SEARCH_RERANK === "voyage" && Boolean(voyageKey());

export const SEARCH_READ: AggregateOptions = { readConcern: { level: "local" } };
/** VOYAGE_BASE_URL wins; otherwise legacy Voyage platform keys (`pa-…`) go to api.voyageai.com and
 *  MongoDB Atlas model API keys (`al-…`, the default) to ai.mongodb.com. Keys only work on their own host. */
export const voyageBase = () =>
  (process.env.VOYAGE_BASE_URL?.trim() || (voyageKey().startsWith("pa-") ? "https://api.voyageai.com/v1" : "https://ai.mongodb.com/v1")).replace(/\/+$/, "");

export async function embed(texts: string[], inputType: "document" | "query"): Promise<number[][]> {
  const res = await fetch(`${voyageBase()}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${voyageKey()}` },
    body: JSON.stringify({ input: texts, model: MODEL(), input_type: inputType }),
  });
  if (!res.ok) throw new Error(`embedding request failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => d.embedding);
}

/** Voyage rerank (cross-encoder): returns document indexes ordered by relevance to `query`. */
export async function rerank(query: string, documents: string[], topK: number, fetchImpl: typeof fetch = fetch): Promise<{ index: number; score: number }[]> {
  const res = await fetchImpl(`${voyageBase()}/rerank`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${voyageKey()}` },
    body: JSON.stringify({ query, documents, model: process.env.RERANK_MODEL || "rerank-2.5", top_k: topK, truncation: true }),
  });
  if (!res.ok) throw new Error(`rerank request failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: { index: number; relevance_score: number }[] };
  return json.data.map((d) => ({ index: d.index, score: d.relevance_score }));
}

/** The $vectorSearch stage for the configured mode (auto: Atlas embeds the query text itself). */
export async function vectorStage(index: string, query: string, limit: number, filter: Record<string, unknown>, textPath = "text") {
  if (embeddingMode() === "auto") return { $vectorSearch: { index, path: textPath, query: { text: query }, numCandidates: Math.max(50, limit * 20), limit, filter } };
  const [queryVector] = await embed([query], "query");
  return { $vectorSearch: { index, path: "embedding", queryVector, numCandidates: Math.max(50, limit * 20), limit, filter } };
}

/**
 * Lexical query text: retrieval queries are whole specs (hundreds of words); Lucene caps boolean clauses and long
 * queries mostly add noise, so keep the first distinct informative terms (PLC addresses like %IX0.1 survive).
 */
export function lexicalQuery(text: string, maxTerms = 48): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[^\p{L}\p{N}%._-]+/u)) {
    const t = raw.replace(/^[._-]+|[._-]+$/g, "");
    if (t.length < 3 || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= maxTerms) break;
  }
  return out.join(" ");
}

/** [$search, $limit]: fuzzy full-text over `paths`, with exact (non-scoring) filters on token/boolean fields. */
export function lexicalPipeline(index: string, query: string, paths: string[], filters: Record<string, string | boolean>, limit: number): Document[] {
  return [
    {
      $search: {
        index,
        compound: {
          should: [{ text: { query: lexicalQuery(query), path: paths, fuzzy: { maxEdits: 1, prefixLength: 2 } } }],
          minimumShouldMatch: 1,
          filter: Object.entries(filters).map(([path, value]) => ({ equals: { path, value } })),
        },
      },
    },
    { $limit: limit },
  ];
}

export interface HybridSpec {
  vector: Document; // a $vectorSearch stage
  lexical: Document[]; // [$search, ..., $limit]
  limit: number;
  project: Record<string, 0 | 1>;
  weights?: { vector: number; lexical: number };
}

export function rankFusionPipeline(spec: HybridSpec): Document[] {
  return [
    {
      $rankFusion: {
        input: { pipelines: { vector: [spec.vector], lexical: spec.lexical } },
        combination: { weights: spec.weights ?? { vector: 1, lexical: 1 } },
      },
    },
    { $limit: spec.limit },
    { $project: { ...spec.project, _id: 1, score: { $meta: "score" } } },
  ];
}

export function scoreFusionPipeline(spec: HybridSpec): Document[] {
  return [
    {
      $scoreFusion: {
        input: { pipelines: { vector: [spec.vector], lexical: spec.lexical }, normalization: "sigmoid" },
        combination: { weights: spec.weights ?? { vector: 1, lexical: 1 }, method: "avg" },
      },
    },
    { $limit: spec.limit },
    { $project: { ...spec.project, _id: 1, score: { $meta: "score" } } },
  ];
}

/** Reciprocal rank fusion in the worker (same formula as $rankFusion: sum of weight / (60 + rank)). */
export function rrfMerge<T extends { _id: unknown }>(lists: { docs: T[]; weight: number }[], limit: number, k = 60): (T & { score: number })[] {
  const acc = new Map<string, { doc: T; score: number }>();
  for (const { docs, weight } of lists) {
    docs.forEach((doc, i) => {
      const key = String(doc._id);
      const prev = acc.get(key);
      const add = weight / (k + i + 1);
      if (prev) prev.score += add;
      else acc.set(key, { doc, score: add });
    });
  }
  return [...acc.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ doc, score }) => ({ ...doc, score }));
}

const unsupported = { rank: false, score: false };
const isUnknownStage = (err: unknown) => /unrecognized pipeline stage|unknown.*stage|40324/i.test(`${(err as Error).message} ${(err as { code?: number }).code ?? ""}`);
/** Exposed for tests: forget which fusion stages the server refused. */
export const resetFusionSupport = () => Object.assign(unsupported, { rank: false, score: false });

export type HybridHit<T> = T & { _id: unknown; score: number };
export interface HybridResult<T> {
  hits: HybridHit<T>[];
  via: "scoreFusion" | "rankFusion" | "client-rrf" | "vector" | "lexical";
}

/** Semantic + lexical retrieval on one collection, fused server-side when the cluster allows it. */
export async function hybridSearch<T extends Document>(coll: Pick<Collection, "aggregate">, spec: HybridSpec): Promise<HybridResult<T>> {
  const run = (pipeline: Document[]) => coll.aggregate<HybridHit<T>>(pipeline, SEARCH_READ).toArray();
  const mode = fusionMode();
  if (mode === "vector") return { hits: await run([spec.vector, { $project: { ...spec.project, _id: 1, score: { $meta: "vectorSearchScore" } } }]), via: "vector" };
  if (mode === "score" && !unsupported.score) {
    try {
      return { hits: await run(scoreFusionPipeline(spec)), via: "scoreFusion" };
    } catch (err) {
      if (isUnknownStage(err)) unsupported.score = true;
      console.warn(`$scoreFusion unavailable (${(err as Error).message}); trying $rankFusion`);
    }
  }
  if ((mode === "score" || mode === "rank") && !unsupported.rank) {
    try {
      return { hits: await run(rankFusionPipeline(spec)), via: "rankFusion" };
    } catch (err) {
      if (isUnknownStage(err)) unsupported.rank = true;
      console.warn(`$rankFusion unavailable (${(err as Error).message}); fusing in the worker`);
    }
  }
  const [vec, lex] = await Promise.allSettled([
    run([spec.vector, { $project: { ...spec.project, _id: 1 } }]),
    run([...spec.lexical, { $project: { ...spec.project, _id: 1 } }]),
  ]);
  if (vec.status === "rejected" && lex.status === "rejected") throw new Error(`vector: ${(vec.reason as Error).message}; lexical: ${(lex.reason as Error).message}`);
  if (vec.status === "rejected") console.warn(`vector side unavailable (${(vec.reason as Error).message}); lexical only`);
  if (lex.status === "rejected") console.warn(`lexical side unavailable (${(lex.reason as Error).message}); vector only`);
  const w = spec.weights ?? { vector: 1, lexical: 1 };
  const lists = [
    { docs: vec.status === "fulfilled" ? vec.value : [], weight: w.vector },
    { docs: lex.status === "fulfilled" ? lex.value : [], weight: w.lexical },
  ];
  const via = vec.status === "rejected" ? "lexical" : lex.status === "rejected" ? "vector" : "client-rrf";
  return { hits: rrfMerge(lists, spec.limit), via };
}

/** Optional Voyage rerank of fused candidates; keeps the fusion order if rerank is off or fails. */
export async function maybeRerank<T>(query: string, hits: T[], textOf: (h: T) => string, k: number, fetchImpl?: typeof fetch): Promise<T[]> {
  if (!rerankEnabled() || hits.length <= 1) return hits.slice(0, k);
  try {
    const order = await rerank(query, hits.map(textOf), k, fetchImpl);
    return order.map((o) => ({ ...hits[o.index], score: o.score }));
  } catch (err) {
    console.warn(`rerank unavailable (${(err as Error).message}); keeping fusion order`);
    return hits.slice(0, k);
  }
}

const candidates = (k: number) => (rerankEnabled() ? Math.max(k * 3, 10) : k);

export interface Lesson {
  pattern: string;
  fix: string;
}

export async function addLesson(lesson: Lesson, source: { projectId: string; diagnosisId: string; verifiedBy?: string }) {
  const text = `${lesson.pattern} -> ${lesson.fix}`;
  const embedding = embeddingMode() === "voyage" ? (await embed([text], "document"))[0] : undefined;
  await col.lessons().updateOne(
    { pattern: lesson.pattern },
    {
      $setOnInsert: { createdAt: new Date(), active: true, timesHelped: 0 },
      $set: { fix: lesson.fix, text, ...(embedding && { embedding }), verified: Boolean(source.verifiedBy), lastSource: source },
      $addToSet: { sources: source },
    },
    { upsert: true },
  );
}

export async function retrieveLessons(query: string, context: HarnessConfig["context"]): Promise<(Lesson & { score?: number })[]> {
  if (context.lessons_k <= 0) return [];
  if (embeddingMode() !== "off") {
    try {
      const n = candidates(context.lessons_k);
      const filter = { active: true, verified: true };
      const { hits } = await hybridSearch<Lesson & { text?: string }>(col.lessons(), {
        vector: await vectorStage(VECTOR_INDEX.lessons, query, n, filter),
        lexical: lexicalPipeline(SEARCH_INDEX.lessons, query, ["pattern", "fix", "text"], filter, n),
        limit: n,
        project: { pattern: 1, fix: 1, text: 1 },
      });
      const top = await maybeRerank(query, hits, (h) => h.text || `${h.pattern} -> ${h.fix}`, context.lessons_k);
      return top.map((h) => ({ pattern: h.pattern, fix: h.fix, score: h.score }));
    } catch (err) {
      console.warn(`lessons search unavailable (${(err as Error).message}); using recency`);
    }
  }
  return col
    .lessons()
    .find({ active: true, verified: true }, { sort: { createdAt: -1 }, limit: context.lessons_k, projection: { _id: 0, pattern: 1, fix: 1 } })
    .toArray() as unknown as Promise<Lesson[]>;
}

export async function similarFailures(query: string, context: HarnessConfig["context"], sceneId: string): Promise<string[]> {
  if (!context.retrieve_similar_failures || context.failures_k <= 0) return [];
  if (embeddingMode() !== "off") {
    try {
      const n = candidates(context.failures_k);
      const filter = { split: "train", sceneId };
      const { hits } = await hybridSearch<{ summary: string; text?: string }>(col.diagnoses(), {
        vector: await vectorStage(VECTOR_INDEX.diagnoses, query, n, filter),
        lexical: lexicalPipeline(SEARCH_INDEX.diagnoses, query, ["text", "summary", "causes.cause", "causes.fix"], filter, n),
        limit: n,
        project: { summary: 1, text: 1 },
      });
      const top = await maybeRerank(query, hits, (h) => h.text || h.summary, context.failures_k);
      return top.map((d) => String(d.summary));
    } catch (err) {
      console.warn(`failure search unavailable (${(err as Error).message}); using recency`);
    }
  }
  const docs = await col.diagnoses().find({ sceneId, split: "train" }, { sort: { createdAt: -1 }, limit: context.failures_k }).toArray();
  return docs.map((d) => String(d.summary));
}

// ---- Read APIs for the dashboard (lexical only: no embedding call, so no automated-embedding rate limit). ----

export interface DiagnosisHit {
  id: string;
  summary: string;
  sceneId?: string;
  faultId?: string | null;
  createdAt?: Date;
  score: number;
  highlights: string[];
}

/** Typo-tolerant full-text search over diagnosed failures, with highlighted snippets. */
export async function searchDiagnoses(query: string, opts: { sceneId?: string; limit?: number } = {}): Promise<DiagnosisHit[]> {
  const docs = await col
    .diagnoses()
    .aggregate(
      [
        {
          $search: {
            index: SEARCH_INDEX.diagnoses,
            compound: {
              should: [
                { text: { query: lexicalQuery(query), path: ["summary", "text", "causes.cause", "causes.fix"], fuzzy: { maxEdits: 1, prefixLength: 1 } } },
                { autocomplete: { query: query.slice(0, 60), path: "summary", fuzzy: { maxEdits: 1 } } },
              ],
              minimumShouldMatch: 1,
              filter: opts.sceneId ? [{ equals: { path: "sceneId", value: opts.sceneId } }] : [],
            },
            highlight: { path: ["summary", "text"] },
          },
        },
        { $limit: opts.limit ?? 10 },
        { $project: { summary: 1, sceneId: 1, faultId: 1, createdAt: 1, score: { $meta: "searchScore" }, highlights: { $meta: "searchHighlights" } } },
      ],
      SEARCH_READ,
    )
    .toArray();
  return docs.map((d) => ({
    id: String(d._id),
    summary: String(d.summary),
    sceneId: d.sceneId,
    faultId: d.faultId ?? null,
    createdAt: d.createdAt,
    score: d.score,
    highlights: ((d.highlights ?? []) as { texts: { value: string; type: string }[] }[]).map((h) => h.texts.map((t) => (t.type === "hit" ? `**${t.value}**` : t.value)).join("")),
  }));
}

/** Search-as-you-type suggestions over diagnosis summaries (edgeGram autocomplete, 1 typo allowed). */
export async function suggestDiagnoses(prefix: string, limit = 5): Promise<{ id: string; summary: string }[]> {
  if (prefix.trim().length < 2) return [];
  const docs = await col
    .diagnoses()
    .aggregate(
      [
        { $search: { index: SEARCH_INDEX.diagnoses, autocomplete: { query: prefix, path: "summary", tokenOrder: "sequential", fuzzy: { maxEdits: 1, prefixLength: 1 } } } },
        { $limit: limit },
        { $project: { summary: 1 } },
      ],
      SEARCH_READ,
    )
    .toArray();
  return docs.map((d) => ({ id: String(d._id), summary: String(d.summary) }));
}

export interface FailureFacets {
  total: number;
  byScene: { value: string; count: number }[];
  byFault: { value: string; count: number }[];
  bySplit: { value: string; count: number }[];
}

/** $searchMeta facet counts of diagnosed failures (optionally within one scene and/or matching a text query). */
export async function failureFacets(opts: { sceneId?: string; query?: string } = {}): Promise<FailureFacets> {
  const must: Document[] = opts.query ? [{ text: { query: lexicalQuery(opts.query), path: ["summary", "text", "causes.cause"], fuzzy: { maxEdits: 1 } } }] : [{ exists: { path: "summary" } }];
  const filter: Document[] = opts.sceneId ? [{ equals: { path: "sceneId", value: opts.sceneId } }] : [];
  const [meta] = await col
    .diagnoses()
    .aggregate(
      [
        {
          $searchMeta: {
            index: SEARCH_INDEX.diagnoses,
            facet: {
              operator: { compound: { must, filter } },
              facets: {
                scene: { type: "string", path: "sceneId", numBuckets: 20 },
                fault: { type: "string", path: "faultId", numBuckets: 20 },
                split: { type: "string", path: "split" },
              },
            },
            count: { type: "total" },
          },
        },
      ],
      SEARCH_READ,
    )
    .toArray();
  const buckets = (name: string) => ((meta?.facet?.[name]?.buckets ?? []) as { _id: string; count: number }[]).map((b) => ({ value: b._id, count: Number(b.count) }));
  return { total: Number(meta?.count?.total ?? meta?.count?.lowerBound ?? 0), byScene: buckets("scene"), byFault: buckets("fault"), bySplit: buckets("split") };
}
