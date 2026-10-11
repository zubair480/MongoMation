// Verified Program Memory: every PLC program that passed ALL of its tests on the real rig is stored in
// `verified_programs` with its spec, a requirement summary and its test evidence (COUNTS only). For a new spec,
// hybrid search ($rankFusion of autoEmbed $vectorSearch + Atlas Search) over the same scene finds the closest
// verified programs, and codegen adapts a proven program instead of starting cold.
//
// Read path is OFF unless asked for: MEMORY_PROGRAMS=1 in the worker env, or a job option `memory: true|false`
// (the job option wins), so cold vs warm runs can be compared on demand.
// Isolation: only test counts and agent-visible requirement summaries are stored, never test definitions/ids.
import type { BoundRequirement, IoPoint, SceneDefinition } from "@mongomation/types";
import { createHash } from "node:crypto";
import type { Collection, Document } from "mongodb";
import { col, db } from "../db/index.ts";
import { embeddingMode, fusionMode, hybridSearch, lexicalPipeline, vectorStage } from "./memory.ts";

export const PROGRAMS_COLLECTION = "verified_programs";
export const PROGRAMS_VECTOR_INDEX = "verified_programs_vec";
export const PROGRAMS_SEARCH_INDEX = "verified_programs_search";
/** voyage-code-4 suits ST source + spec text; override with PROGRAMS_EMBEDDING_MODEL if the cluster refuses it. */
export const programsModel = () => process.env.PROGRAMS_EMBEDDING_MODEL || "voyage-code-4";

export const programsVectorDefinition = (model = programsModel()) => ({
  fields: [
    { type: "autoEmbed", modality: "text", path: "embedText", model },
    { type: "filter", path: "sceneId" },
  ],
});

const english = { type: "string", analyzer: "lucene.english" } as const;
export const programsSearchDefinition = {
  mappings: {
    dynamic: false,
    fields: {
      embedText: english,
      specText: english,
      requirementsSummary: english,
      sceneId: { type: "token" },
      projectId: { type: "token" },
      verifiedAt: { type: "date" },
    },
  },
};

/** $jsonSchema for verified_programs (validationAction "warn": never blocks a write, logs drift). */
export const programsValidator = {
  $jsonSchema: {
    bsonType: "object",
    required: ["projectId", "sceneId", "specText", "requirementsSummary", "stSource", "plcVersionId", "tests", "verifiedAt", "embedText"],
    properties: {
      projectId: { bsonType: "string" },
      sceneId: { bsonType: "string" },
      specText: { bsonType: "string" },
      requirementsSummary: { bsonType: "string" },
      requirementKinds: { bsonType: "array", items: { bsonType: "string" } },
      stSource: { bsonType: "string" },
      plcVersionId: { bsonType: "string" },
      tests: {
        bsonType: "object",
        required: ["passed", "total"],
        additionalProperties: false,
        properties: { passed: { bsonType: ["int", "long", "double"] }, total: { bsonType: ["int", "long", "double"] } },
      },
      verifiedAt: { bsonType: "date" },
      harnessVersion: { bsonType: ["int", "long", "double"] },
      embedText: { bsonType: "string" },
      fingerprint: { bsonType: "string" },
      specHash: { bsonType: "string" },
      planHash: { bsonType: "string" },
      originProjectId: { bsonType: "string" },
      replay: { bsonType: "object" },
    },
  },
};

export interface VerifiedProgram {
  projectId: string;
  sceneId: string;
  specText: string;
  requirementsSummary: string;
  requirementKinds: string[];
  stSource: string;
  plcVersionId: string;
  tests: { passed: number; total: number };
  verifiedAt: Date;
  harnessVersion: number;
  embedText: string;
  /** Requirement fingerprint (requirementFingerprint): exact-match key for experience recall. */
  fingerprint: string;
  /** Spec-level exact-recall key (specHash): normalized spec text + scene + scene I/O map version. */
  specHash?: string;
  /** hash of the validator test plan this program passed (trusted recall requires the same plan). */
  planHash?: string;
  /** Lineage: the ORIGINAL (non-recall) build this program descends from (itself when built cold). */
  originProjectId?: string;
  /** Stored stage outputs replayed by spec-level recall (agent-visible requirements and I/O only; no tests). */
  replay?: SpecReplay;
}

/** What an exact-spec recall replays instead of calling Claude: extracted + bound requirements and the I/O map. */
export interface SpecReplay {
  /** The requirements stage output (extraction result), replayed verbatim. */
  requirements: unknown;
  bound: BoundRequirement[];
  io: IoPoint[];
}

const programs = (): Collection => db.collection(PROGRAMS_COLLECTION);

/** Flag: job option wins over the env (MEMORY_PROGRAMS=1). Default off (cold). */
export function memoryEnabled(jobOption?: boolean | null): boolean {
  if (typeof jobOption === "boolean") return jobOption;
  return ["1", "true", "on"].includes((process.env.MEMORY_PROGRAMS ?? "").trim().toLowerCase());
}

/** Agent-visible requirement summary: id, kind, roles -> scene tags and the requirement text. No test data. */
export function requirementsSummary(reqs: Pick<BoundRequirement, "id" | "kind" | "text" | "bindings" | "support">[]): string {
  return reqs
    .map((r) => {
      const roles = Object.entries(r.bindings ?? {}).map(([role, tag]) => `${role}=${tag}`).join(", ");
      return `${r.id} [${r.kind}]${r.support === "unsupported" ? " (unsupported)" : ""} roles: ${roles || "-"} | ${r.text}`;
    })
    .join("\n");
}

export const embedTextOf = (specText: string, summary: string) => `${specText}\n\nRequirements:\n${summary}`;

/** A run counts as verified memory only if every test passed: no failures, nothing blocked. */
export const fullyPassing = (run: { passed: number; failed: number; blocked: number } | null | undefined): boolean =>
  Boolean(run && run.passed > 0 && run.failed === 0 && run.blocked === 0);

export function buildVerifiedProgram(args: {
  projectId: string;
  sceneId: string;
  specText: string;
  requirements: (Pick<BoundRequirement, "id" | "kind" | "text" | "bindings" | "support"> & { params?: BoundRequirement["params"] })[];
  stSource: string;
  plcVersionId: string;
  run: { passed: number; failed: number; blocked: number };
  harnessVersion: number;
  verifiedAt?: Date;
  specHash?: string;
  planHash?: string;
  originProjectId?: string;
  replay?: SpecReplay;
}): VerifiedProgram {
  const summary = requirementsSummary(args.requirements);
  return {
    fingerprint: requirementFingerprint(args.sceneId, args.requirements),
    projectId: args.projectId,
    sceneId: args.sceneId,
    specText: args.specText,
    requirementsSummary: summary,
    requirementKinds: [...new Set(args.requirements.map((r) => r.kind))],
    stSource: args.stSource,
    plcVersionId: args.plcVersionId,
    tests: { passed: args.run.passed, total: args.run.passed + args.run.failed + args.run.blocked },
    verifiedAt: args.verifiedAt ?? new Date(),
    harnessVersion: args.harnessVersion,
    embedText: embedTextOf(args.specText, summary),
    originProjectId: args.originProjectId ?? args.projectId,
    ...(args.specHash && { specHash: args.specHash }),
    ...(args.planHash && { planHash: args.planHash }),
    ...(args.replay && { replay: args.replay }),
  };
}

/** One document per project (its latest fully passing program wins). */
export async function upsertVerifiedProgram(doc: VerifiedProgram) {
  await programs().updateOne({ projectId: doc.projectId }, { $set: doc, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
}

export interface BackfillCandidate {
  projectId: string;
  status?: string;
  finalPlcVersionId?: string | null;
  lastSimRunId?: string | null;
  sceneId?: string;
}
export interface BackfillRun {
  _id: unknown;
  passed: number;
  failed: number;
  blocked: number;
  plcVersionId?: string;
  split?: string;
}

/** Projects whose LAST measured run passed every test, on the train split, with a known final program. */
export function selectBackfill(projects: BackfillCandidate[], runs: Map<string, BackfillRun>): { projectId: string; run: BackfillRun; plcVersionId: string }[] {
  const out: { projectId: string; run: BackfillRun; plcVersionId: string }[] = [];
  for (const p of projects) {
    if (!p.lastSimRunId || !p.sceneId) continue;
    const run = runs.get(String(p.lastSimRunId));
    if (!run || !fullyPassing(run) || (run.split && run.split !== "train")) continue;
    const plcVersionId = String(run.plcVersionId ?? p.finalPlcVersionId ?? "");
    if (!plcVersionId) continue;
    out.push({ projectId: p.projectId, run, plcVersionId });
  }
  return out;
}

export interface ProgramHit {
  projectId: string;
  score: number;
  specText: string;
  requirementsSummary: string;
  stSource: string;
  tests: { passed: number; total: number };
}

export interface ProgramRetrieval {
  memoryUsed: boolean;
  hits: { projectId: string; score: number }[];
  retrievalMs: number;
  via?: string;
  references: ProgramHit[];
  error?: string;
}

/** Closest verified programs on the same scene (hybrid search), excluding the project being built. */
export async function retrieveVerifiedPrograms(
  query: string,
  sceneId: string,
  opts: { k?: number; excludeProjectId?: string; coll?: Pick<Collection, "aggregate"> } = {},
): Promise<ProgramRetrieval> {
  const t0 = performance.now();
  const k = opts.k ?? 2;
  const n = k + 1; // one spare in case the current project is itself stored
  try {
    if (embeddingMode() === "off") throw new Error("EMBEDDING_MODE=off");
    const filter = { sceneId };
    const project = { projectId: 1, specText: 1, requirementsSummary: 1, stSource: 1, tests: 1 };
    const spec = {
      vector: await vectorStage(PROGRAMS_VECTOR_INDEX, query, n, filter, "embedText"),
      lexical: lexicalPipeline(PROGRAMS_SEARCH_INDEX, query, ["embedText", "specText", "requirementsSummary"], filter, n),
      limit: n,
      project: project as Record<string, 0 | 1>,
    };
    const { hits, via } = await hybridSearch<Omit<ProgramHit, "score">>(opts.coll ?? programs(), spec);
    const refs = hits
      .filter((h) => h.projectId !== opts.excludeProjectId)
      .slice(0, k)
      .map((h) => ({ projectId: String(h.projectId), score: Number(h.score ?? 0), specText: h.specText, requirementsSummary: h.requirementsSummary, stSource: h.stSource, tests: h.tests }));
    return { memoryUsed: refs.length > 0, hits: refs.map((r) => ({ projectId: r.projectId, score: r.score })), retrievalMs: Math.round(performance.now() - t0), via: via ?? fusionMode(), references: refs };
  } catch (err) {
    // Lexical-free fallback: most recent verified programs on the scene (still real verified evidence).
    try {
      const docs = (await programs()
        .find({ sceneId, ...(opts.excludeProjectId && { projectId: { $ne: opts.excludeProjectId } }) }, { sort: { verifiedAt: -1 }, limit: k })
        .toArray()) as Document[];
      const refs = docs.map((d) => ({ projectId: String(d.projectId), score: 0, specText: d.specText, requirementsSummary: d.requirementsSummary, stSource: d.stSource, tests: d.tests }));
      return { memoryUsed: refs.length > 0, hits: refs.map((r) => ({ projectId: r.projectId, score: 0 })), retrievalMs: Math.round(performance.now() - t0), via: "recency", references: refs, error: (err as Error).message };
    } catch (err2) {
      return { memoryUsed: false, hits: [], retrievalMs: Math.round(performance.now() - t0), references: [], error: `${(err as Error).message}; ${(err2 as Error).message}` };
    }
  }
}

/** Stamp the retrieval outcome on the plc_code stage doc (top-level fields, easy to query cold vs warm). */
export async function recordRetrieval(key: { projectId: string; revision: number }, r: Pick<ProgramRetrieval, "memoryUsed" | "hits" | "retrievalMs" | "via">, requested: boolean) {
  await col.stages().updateOne({ ...key, stage: "plc_code", attempt: 0 }, { $set: { memoryRequested: requested, memoryUsed: r.memoryUsed, hits: r.hits, retrievalMs: r.retrievalMs, retrievalVia: r.via ?? null } });
}

// ---------------------------------------------------------------------------------------------------------------
// Experience recall key: requirement fingerprint. Two jobs whose normalized requirements (kind, support, roles
// bound to scene I/O tags, parameters) are identical on the same scene get the SAME validator test plan, so a
// program that passed every one of those tests on the rig is a genuine candidate for verbatim reuse.
// Requirement ids and texts are deliberately NOT part of the key (paraphrases of the same spec still match).
// ---------------------------------------------------------------------------------------------------------------
export const FINGERPRINT_VERSION = 3;
export type FingerprintReq = Pick<BoundRequirement, "kind" | "bindings"> & { params?: BoundRequirement["params"]; support?: BoundRequirement["support"] };

/** Params the validator templates key on beyond numbers (checks/src/templates.ts): enum / boolean switches. */
export const SEMANTIC_PARAMS = ["when", "actuatorValue", "classifierValue"] as const;
const boolish = (v: string): string | boolean => (v === "true" ? true : v === "false" ? false : v);
/** Numeric params (numeric strings coerced), booleans, and the validator's enum params (lowercased).
 *  Other free-text params are dropped: they drift between LLM extractions and no test reads them. */
const canonicalParams = (o: Record<string, unknown> | undefined) =>
  Object.entries(o ?? {})
    .map(([k, v]): readonly [string, number | boolean | string | null] => {
      const key = k.trim();
      if (typeof v === "number") return [key, Number.isFinite(v) ? v : null];
      if (typeof v === "boolean") return [key, v];
      if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return [key, Number(v)];
      if (typeof v === "string" && (SEMANTIC_PARAMS as readonly string[]).includes(key)) return [key, boolish(v.trim().toLowerCase())];
      return [key, null];
    })
    .filter(([, v]) => v !== null)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
const sortedBindings = (o: Record<string, string> | undefined) =>
  Object.entries(o ?? {})
    .map(([k, v]) => [k.trim().toLowerCase(), String(v).trim()] as const)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));

/** One canonical string per requirement: kind + roles->tags + numeric params. No ids, texts or order. */
export function canonicalRequirements(reqs: FingerprintReq[]): string[] {
  return reqs.map((r) => JSON.stringify({ k: r.kind, b: sortedBindings(r.bindings), p: canonicalParams(r.params) })).sort();
}

/** Deterministic sha256 of (fingerprint version, sceneId, sorted canonical requirements). */
export function requirementFingerprint(sceneId: string, reqs: FingerprintReq[]): string {
  const canon = JSON.stringify({ v: FINGERPRINT_VERSION, sceneId, reqs: canonicalRequirements(reqs) });
  return `fp${FINGERPRINT_VERSION}:${createHash("sha256").update(canon).digest("hex")}`;
}

export interface ExactProgram {
  projectId: string;
  sceneId: string;
  fingerprint: string;
  stSource: string;
  plcVersionId: string;
  tests: { passed: number; total: number };
  verifiedAt: Date;
  harnessVersion?: number;
  planHash?: string;
  originProjectId?: string;
  specHash?: string;
  replay?: SpecReplay;
}

const EXACT_PROJECTION = { projectId: 1, sceneId: 1, fingerprint: 1, stSource: 1, plcVersionId: 1, tests: 1, verifiedAt: 1, harnessVersion: 1, planHash: 1, originProjectId: 1, specHash: 1 } as const;
const allPassedDoc = (docs: Document[]) => docs.find((x) => x.stSource && x.tests && Number(x.tests.total) > 0 && Number(x.tests.passed) === Number(x.tests.total));
const asExact = (d: Document) => ({ ...d, projectId: String(d.projectId), plcVersionId: String(d.plcVersionId), ...(d.originProjectId && { originProjectId: String(d.originProjectId) }) }) as unknown as ExactProgram;

/** Most recent rig-verified program (every test passed) with this exact fingerprint on this scene. */
export async function findExactProgram(sceneId: string, fingerprint: string, excludeProjectId?: string, coll: Pick<Collection, "find"> = programs()): Promise<ExactProgram | null> {
  const docs = (await coll
    .find(
      { sceneId, fingerprint, ...(excludeProjectId && { projectId: { $ne: excludeProjectId } }) },
      { sort: { verifiedAt: -1 }, limit: 5, projection: EXACT_PROJECTION },
    )
    .toArray()) as Document[];
  // Belt and braces: only documents whose stored rig evidence says ALL tests passed.
  const d = allPassedDoc(docs);
  return d ? asExact(d) : null;
}

/** {sceneId, fingerprint} index on verified_programs (exact recall); created by setup:search and recall:backfill. */
export const RECALL_INDEX = { keys: { sceneId: 1, fingerprint: 1, verifiedAt: -1 }, name: "scene_fingerprint" } as const;

// ---------------------------------------------------------------------------------------------------------------
// Spec-level exact recall (tier 1, checked BEFORE requirement extraction). Requirement extraction is an LLM call and
// is nondeterministic on identical text (12 vs 9 requirements), so the fingerprint alone cannot recognise a repeat
// spec. specHash = sha256(normalized spec text + sceneId + scene I/O map version).
// ---------------------------------------------------------------------------------------------------------------
export const SPEC_HASH_VERSION = 1;

/** Trimmed, whitespace collapsed to single spaces, lowercased. */
export const normalizeSpec = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

/** Version of the scene's I/O map: hash of every tag's name, address, kind, polarity and Factory I/O kind. */
export function ioMapVersion(scene: Pick<SceneDefinition, "tags">): string {
  const tags = scene.tags.map((t) => JSON.stringify([t.name, t.plcAddress, t.kind, Boolean(t.activeLow), t.fioKind ?? ""])).sort();
  return createHash("sha256").update(JSON.stringify(tags)).digest("hex").slice(0, 16);
}

export function specHash(specText: string, scene: Pick<SceneDefinition, "id" | "tags">): string {
  const canon = JSON.stringify({ v: SPEC_HASH_VERSION, sceneId: scene.id, io: ioMapVersion(scene), spec: normalizeSpec(specText) });
  return `sh${SPEC_HASH_VERSION}:${createHash("sha256").update(canon).digest("hex")}`;
}

/** Rig-verified programs (every test passed, complete replay) with this specHash on this scene, most recent first. */
export async function findSpecPrograms(sceneId: string, hash: string, excludeProjectId?: string, coll: Pick<Collection, "find"> = programs()): Promise<ExactProgram[]> {
  const docs = (await coll
    .find(
      { sceneId, specHash: hash, ...(excludeProjectId && { projectId: { $ne: excludeProjectId } }) },
      { sort: { verifiedAt: -1 }, limit: 10, projection: { ...EXACT_PROJECTION, replay: 1 } },
    )
    .toArray()) as Document[];
  return docs
    .filter((x) => x.replay?.bound?.length && x.replay?.io?.length && x.replay?.requirements != null)
    .filter((x) => allPassedDoc([x]))
    .map(asExact);
}

/** Most recent such program (see findSpecPrograms). */
export async function findSpecProgram(sceneId: string, hash: string, excludeProjectId?: string, coll: Pick<Collection, "find"> = programs()): Promise<ExactProgram | null> {
  return (await findSpecPrograms(sceneId, hash, excludeProjectId, coll))[0] ?? null;
}

/** {sceneId, specHash} index on verified_programs (spec-level exact recall). */
export const SPEC_RECALL_INDEX = { keys: { sceneId: 1, specHash: 1, verifiedAt: -1 }, name: "scene_spechash" } as const;
