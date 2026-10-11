// Experience Recall (the RSI harness's speed engine). Every rig-verified run writes its experience into Atlas
// (`verified_programs`, keyed by a requirement fingerprint); the next job with the same requirements recalls it.
//   exact   same fingerprint, same scene: reuse the verified ST verbatim -> compile -> deploy -> ONE confirmation
//           pass of the full test plan. No codegen, no repairs. A failed confirmation falls back to the normal loop.
//   trusted RECALL_TRUST=1 (default OFF) + exact hit: skip the rig entirely, status "verified-by-reuse" (NOT
//           "verified"), citing the source project and its rig evidence. Honest label: not re-tested on this job.
//   near    no exact hit, hybrid ($rankFusion) score >= RECALL_NEAR_SCORE: memory-guided codegen.
//   none    nothing close: the normal cold loop.
//   exact-spec / trusted-spec  (tier 1, BEFORE requirement extraction) same normalized spec text + scene + I/O map
//           version (specHash): replay the source's stored requirements, I/O binding AND program: no Claude calls at
//           all. Then exactly as exact / trusted. Requirement extraction is nondeterministic, so this tier is what
//           recognises a repeat spec; the fingerprint tiers above remain for different spec text.
// Trusted (either tier) additionally requires the source's stored test-plan hash to equal this job's plan; otherwise
// it is downgraded to a confirmation pass. msSaved follows lineage to the ORIGINAL non-recall build.
// Recall only ever reuses programs whose stored rig evidence says every test passed. Never stores test definitions.
import type { IoPoint } from "@mongomation/types";
import { col } from "../db/index.ts";
import { assembleProgram, type GeneratedLogic } from "../pipeline/st.ts";
import { HEARTBEAT_MARK } from "../tools/linkprobe.ts";
import { telemetry } from "../telemetry/index.ts";
import { findExactProgram, findSpecPrograms, memoryEnabled, requirementFingerprint, retrieveVerifiedPrograms, type ExactProgram, type ProgramRetrieval, type SpecReplay } from "./programs.ts";

export type RecallKind = "exact-spec" | "trusted-spec" | "exact" | "trusted" | "near" | "none";
export const isReuseKind = (k: RecallKind | undefined | null) => k === "exact" || k === "trusted" || k === "exact-spec" || k === "trusted-spec";
export const isTrustedKind = (k: RecallKind | undefined | null) => k === "trusted" || k === "trusted-spec";

const truthy = (v: string | undefined) => ["1", "true", "on"].includes((v ?? "").trim().toLowerCase());

/** Job option `recall` (alias `fastpath`) wins; otherwise on whenever program memory is on (MEMORY_PROGRAMS=1 or job memory:true). */
export function recallEnabled(jobRecall?: boolean | null, jobMemory?: boolean | null): boolean {
  if (typeof jobRecall === "boolean") return jobRecall;
  return memoryEnabled(jobMemory);
}

/** RECALL_TRUST=1 (alias FASTPATH_TRUST=1). Default OFF: an exact hit is always re-confirmed on the rig. */
export const trustEnabled = (env: NodeJS.ProcessEnv = process.env) => truthy(env.RECALL_TRUST) || truthy(env.FASTPATH_TRUST);

/** $rankFusion score a hit must reach to count as "near" (2/61 ~ 0.033 = ranked first by both vector and lexical). */
export const nearThreshold = (env: NodeJS.ProcessEnv = process.env) => {
  const n = Number(env.RECALL_NEAR_SCORE ?? env.FASTPATH_NEAR_SCORE);
  return Number.isFinite(n) && n > 0 ? n : 0.025;
};

export interface RecallStore {
  findExact(sceneId: string, fingerprint: string, excludeProjectId: string): Promise<ExactProgram | null>;
  /** Spec-level tier: verified programs (with stored replay) of the same specHash on this scene, most recent first. */
  findSpec(sceneId: string, specHash: string, excludeProjectId: string): Promise<ExactProgram[]>;
  retrieve(query: string, sceneId: string, excludeProjectId: string): Promise<ProgramRetrieval>;
  /** Prior engineering runs of the same fingerprint on the same scene (learning-curve x axis). */
  priorRuns(sceneId: string, fingerprint: string, excludeProjectId: string): Promise<number>;
  /** How long the source project took to reach verified (ms), for the msSaved estimate. */
  sourceBuildMs(projectId: string): Promise<number | null>;
}

export const atlasRecallStore = (): RecallStore => ({
  findExact: (sceneId, fp, ex) => findExactProgram(sceneId, fp, ex),
  findSpec: (sceneId, h, ex) => findSpecPrograms(sceneId, h, ex),
  retrieve: (q, sceneId, ex) => retrieveVerifiedPrograms(q, sceneId, { k: 2, excludeProjectId: ex }),
  priorRuns: (sceneId, fp, ex) => col.projects().countDocuments({ sceneId, fingerprint: fp, _id: { $ne: ex as never } }),
  sourceBuildMs: async (pid) => {
    const p = await col.projects().findOne({ _id: pid as never }, { projection: { metrics: 1 } });
    const s = Number((p?.metrics as { seconds?: number } | undefined)?.seconds);
    return Number.isFinite(s) && s > 0 ? s * 1000 : null;
  },
});

export interface RecallDecision {
  kind: RecallKind;
  fingerprint: string;
  sourceProjectId: string | null;
  score: number | null;
  lookupMs: number;
  runIndex: number;
  sourceBuildMs: number | null;
  reason: string;
  /** exact/trusted only: the source program and its logic, parsed back so the harness re-assembles it verbatim. */
  exact?: ExactProgram;
  logic?: GeneratedLogic;
  /** exact-spec/trusted-spec only: the source's stored requirements, I/O binding and the specHash matched. */
  replay?: SpecReplay;
  specHash?: string;
  /** True when RECALL_TRUST was on but the source's test plan differs (or is unknown): confirmation pass instead. */
  trustDowngraded?: boolean;
  /** Hybrid retrieval (near/none); empty for exact hits (no search needed). */
  retrieval: ProgramRetrieval;
}

const emptyRetrieval: ProgramRetrieval = { memoryUsed: false, hits: [], retrievalMs: 0, references: [] };

/** Parse a harness-assembled program back into {variables, body}. Null when it is not in the harness layout. */
export function logicFromSource(source: string): GeneratedLogic | null {
  const lines = source.split("\n");
  const ends = lines.map((l, i) => (l.trim() === "END_VAR" ? i : -1)).filter((i) => i >= 0);
  if (ends.length < 2) return null;
  const varStart = lines.findIndex((l, i) => i > ends[0] && l.trim() === "VAR");
  const endProg = lines.findIndex((l) => l.trim() === "END_PROGRAM");
  if (varStart < 0 || endProg < 0 || varStart > ends[1]) return null;
  const variables: GeneratedLogic["variables"] = [];
  for (const l of lines.slice(varStart + 1, ends[1])) {
    const m = /^ {4}([A-Za-z_]\w*) : ([A-Za-z_]\w*)(?: := (.*?))?;(?: \(\* (.*) \*\))?$/.exec(l);
    if (!m) return null;
    if (m[1] === "mm_hb" || m[1] === "mm_unused") continue;
    variables.push({ name: m[1], type: m[2] as GeneratedLogic["variables"][number]["type"], ...(m[3] !== undefined && { initial: m[3] }), ...(m[4] !== undefined && { comment: m[4] }) });
  }
  let body = lines.slice(ends[1] + 1, endProg);
  const hb = body.findIndex((l) => l.includes(HEARTBEAT_MARK));
  if (hb >= 0) body = body.slice(0, hb);
  return { variables, body: body.map((l) => (l.startsWith("  ") ? l.slice(2) : l)).join("\n") };
}

/** True when re-assembling `logic` on this job's I/O reproduces `source` byte for byte (header comment aside). */
export function reproducesVerbatim(io: IoPoint[], logic: GeneratedLogic, source: string): boolean {
  const strip = (s: string) => s.split("\n").slice(1).join("\n");
  return strip(assembleProgram(io, logic, "recall").source) === strip(source);
}

/** Trusted reuse only when the source passed the SAME test plan this job would run (docs without planHash never). */
export const trustAllowed = (trust: boolean | undefined, sourcePlanHash: string | undefined, planHash: string | undefined) => Boolean(trust && sourcePlanHash && planHash && sourcePlanHash === planHash);
/** Lineage root for msSaved: the original non-recall build. */
const originOf = (e: ExactProgram) => e.originProjectId ?? e.projectId;

/** Tier 1: spec-level exact recall, decided BEFORE requirement extraction. Null = no usable hit (fall through). */
export async function decideSpecRecall(args: { sceneId: string; specHash: string; projectId: string; store: RecallStore; trust?: boolean; planHashOf?: (bound: SpecReplay["bound"]) => string }): Promise<RecallDecision | null> {
  const t0 = performance.now();
  const { sceneId, specHash, projectId, store } = args;
  const candidates = await store.findSpec(sceneId, specHash, projectId).catch(() => [] as ExactProgram[]);
  // Usable = complete replay that re-assembles verbatim. Among those, PREFER one whose stored planHash equals the plan
  // this job would run on its replayed requirements (current checks code); only then the most recent.
  const usable = candidates.flatMap((c) => {
    if (!c.replay) return [];
    const lg = logicFromSource(c.stSource);
    if (!lg || !reproducesVerbatim(c.replay.io, lg, c.stSource)) return [];
    return [{ c, logic: lg, planHash: args.planHashOf ? args.planHashOf(c.replay.bound) : undefined }];
  });
  const pick = usable.find((u) => u.planHash && u.c.planHash === u.planHash) ?? usable[0];
  if (!pick) return null;
  const { c: hit, logic, planHash } = pick;
  const replay = hit.replay!;
  const fingerprint = requirementFingerprint(sceneId, replay.bound);
  const runIndex = await store.priorRuns(sceneId, fingerprint, projectId).catch(() => 0);
  const trusted = trustAllowed(args.trust, hit.planHash, planHash);
  const sourceBuildMs = await store.sourceBuildMs(originOf(hit)).catch(() => null);
  return {
    kind: trusted ? "trusted-spec" : "exact-spec",
    fingerprint,
    runIndex,
    sourceProjectId: hit.projectId,
    score: 1,
    lookupMs: Math.round(performance.now() - t0),
    sourceBuildMs,
    reason: `identical spec text on scene ${sceneId} (${specHash.slice(0, 14)}…): replaying requirements, I/O binding and verified program of ${hit.projectId} (${hit.tests.passed}/${hit.tests.total} rig tests)${args.trust && !trusted ? "; RECALL_TRUST downgraded to a confirmation pass (source test plan differs or unknown)" : ""}`,
    exact: hit,
    logic,
    replay,
    specHash,
    trustDowngraded: Boolean(args.trust && !trusted),
    retrieval: emptyRetrieval,
  };
}

export async function decideRecall(args: { sceneId: string; fingerprint: string; query: string; projectId: string; io: IoPoint[]; store: RecallStore; trust?: boolean; threshold?: number; planHash?: string }): Promise<RecallDecision> {
  const t0 = performance.now();
  const { sceneId, fingerprint, projectId, store } = args;
  const runIndex = await store.priorRuns(sceneId, fingerprint, projectId).catch(() => 0);
  const base = { fingerprint, runIndex };
  let reason = "";
  const exact = await store.findExact(sceneId, fingerprint, projectId).catch(() => null);
  if (exact) {
    const logic = logicFromSource(exact.stSource);
    if (logic && reproducesVerbatim(args.io, logic, exact.stSource)) {
      const sourceBuildMs = await store.sourceBuildMs(originOf(exact)).catch(() => null);
      const trusted = trustAllowed(args.trust, exact.planHash, args.planHash);
      return {
        ...base,
        kind: trusted ? "trusted" : "exact",
        trustDowngraded: Boolean(args.trust && !trusted),
        sourceProjectId: exact.projectId,
        score: 1,
        lookupMs: Math.round(performance.now() - t0),
        sourceBuildMs,
        reason: `identical requirements on scene ${sceneId}: verified program of ${exact.projectId} (${exact.tests.passed}/${exact.tests.total} rig tests)${args.trust && !trusted ? "; RECALL_TRUST downgraded to a confirmation pass (source test plan differs or unknown)" : ""}`,
        exact,
        logic,
        retrieval: emptyRetrieval,
      };
    }
    reason = `exact fingerprint hit ${exact.projectId} does not re-assemble verbatim on this I/O map; not reused`;
  }
  const retrieval = await store.retrieve(args.query, sceneId, projectId);
  const top = retrieval.references[0];
  const threshold = args.threshold ?? nearThreshold();
  const near = Boolean(top && top.score >= threshold);
  return {
    ...base,
    kind: near ? "near" : "none",
    sourceProjectId: top?.projectId ?? null,
    score: top ? top.score : null,
    lookupMs: Math.round(performance.now() - t0),
    sourceBuildMs: near && top ? await store.sourceBuildMs(top.projectId).catch(() => null) : null,
    reason: reason || (near ? `closest verified program ${top!.projectId} score ${top!.score.toFixed(4)} >= ${threshold}` : top ? `closest score ${top.score.toFixed(4)} < ${threshold}` : "no verified program on this scene"),
    retrieval,
  };
}

/** What a recall decision skipped (shown on the project and in events; never claims tests that did not run). */
export function recallSkipped(kind: RecallKind): string[] {
  const spec = ["requirements extraction (Claude)", "I/O binding (Claude)"];
  if (kind === "trusted-spec") return [...spec, "Claude codegen", "repair loop", "OpenPLC compile", "deploy", "rig confirmation tests"];
  if (kind === "exact-spec") return [...spec, "Claude codegen", "repair loop (unless the confirmation pass fails)"];
  if (kind === "trusted") return ["Claude codegen", "repair loop", "OpenPLC compile", "deploy", "rig confirmation tests"];
  if (kind === "exact") return ["Claude codegen", "repair loop (unless the confirmation pass fails)"];
  return [];
}

/** Raindrop signal per job: recall_exact_spec / recall_trusted_spec / recall_exact / recall_trusted / recall_near / recall_none. */
export function recallSignal(projectId: string, d: Pick<RecallDecision, "kind" | "lookupMs" | "sourceProjectId" | "score" | "runIndex" | "fingerprint">, extra: Record<string, unknown> = {}) {
  telemetry.signal({
    runId: projectId,
    name: `recall_${d.kind.replace(/-/g, "_")}`,
    sentiment: d.kind === "none" ? "NEGATIVE" : "POSITIVE",
    properties: { lookup_ms: d.lookupMs, source_project: d.sourceProjectId ?? "", score: d.score ?? "", run_index: d.runIndex, fingerprint: d.fingerprint.slice(0, 16), ...extra },
  });
}
