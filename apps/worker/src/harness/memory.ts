// Engineering memory: verified lessons and diagnosed failure patterns, retrieved with Atlas Vector Search.
// EMBEDDING_MODE:
//   auto   (default) Atlas Automated Embedding: an `autoEmbed` vector index on the `text` field; Atlas embeds
//          documents and queries itself (Voyage models hosted by MongoDB; no key in our code). Free clusters
//          without a payment method are limited to 3 query RPM per model.
//   voyage bring-your-own embeddings via the Voyage API (VOYAGE_API_KEY; Atlas model keys use ai.mongodb.com).
//   off    recency only.
// The context policy (k values, on/off) comes from the harness config, so the meta-harness can tune it.
// Only lessons that preceded a measured fix are "verified"; held-out benchmark runs never write memory.
import type { HarnessConfig } from "@mongomation/types";
import { col } from "../db/index.ts";

export type EmbeddingMode = "auto" | "voyage" | "off";
export const embeddingMode = (): EmbeddingMode => (process.env.EMBEDDING_MODE as EmbeddingMode) || "auto";
const MODEL = () => process.env.EMBEDDING_MODEL || "voyage-4";

export async function embed(texts: string[], inputType: "document" | "query"): Promise<number[][]> {
  const base = process.env.VOYAGE_BASE_URL || "https://ai.mongodb.com/v1";
  const res = await fetch(`${base}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.VOYAGE_API_KEY}` },
    body: JSON.stringify({ input: texts, model: MODEL(), input_type: inputType }),
  });
  if (!res.ok) throw new Error(`embedding request failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => d.embedding);
}

/** The $vectorSearch stage for the configured mode (auto: Atlas embeds the query text itself). */
async function vectorStage(index: string, query: string, limit: number, filter: Record<string, unknown>) {
  if (embeddingMode() === "auto") return { $vectorSearch: { index, path: "text", query: { text: query }, numCandidates: Math.max(50, limit * 20), limit, filter } };
  const [queryVector] = await embed([query], "query");
  return { $vectorSearch: { index, path: "embedding", queryVector, numCandidates: Math.max(50, limit * 20), limit, filter } };
}

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
      return await col
        .lessons()
        .aggregate<Lesson & { score: number }>([
          await vectorStage("lessons_vec", query, context.lessons_k, { active: true }),
          { $project: { _id: 0, pattern: 1, fix: 1, score: { $meta: "vectorSearchScore" } } },
        ])
        .toArray();
    } catch (err) {
      console.warn(`lessons vector search unavailable (${(err as Error).message}); using recency`);
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
      const docs = await col
        .diagnoses()
        .aggregate<{ summary: string }>([await vectorStage("diagnoses_vec", query, context.failures_k, { split: "train" }), { $project: { _id: 0, summary: 1 } }])
        .toArray();
      return docs.map((d) => d.summary);
    } catch (err) {
      console.warn(`failure vector search unavailable (${(err as Error).message}); using recency`);
    }
  }
  const docs = await col.diagnoses().find({ sceneId, split: "train" }, { sort: { createdAt: -1 }, limit: context.failures_k }).toArray();
  return docs.map((d) => String(d.summary));
}
