// Lesson writer: failures become reusable lessons automatically.
//
// A MongoDB change stream on `sim_runs` fires when a run finishes (status -> "done"). If that run tested a program
// produced by a REPAIR, and tests that failed on the program it repaired now pass, Claude (fast tier) writes ONE short
// behaviour rule ("when <trigger>, PLC code must <rule>") citing the evidence (project, test ids, failing assertion,
// the diff that fixed it). The lesson is appended to the existing `lessons` collection in the shape memory.ts
// retrieves (pattern / fix / text / active / verified), so the `lessons_vec` autoEmbed index and `lessons_search`
// pick it up with no extra work.
//
//   status "active"    the re-test on the rig passed in full (failed = 0, blocked = 0): active + verified, retrieved.
//   status "candidate" the repair fixed the cited tests but the run still has other failures: stored, not retrieved;
//                      promoted to active as soon as a later run of that same repaired program passes in full.
//
// Research rules applied: append small lessons, never rewrite a playbook; near-duplicates increment `support` on the
// existing lesson instead of inserting; scoped by plant (sceneId); held-out runs never write memory.
// Isolation: hidden tests are never shown to the model (only "a hidden <category> check on R6"); every lesson is
// checked against hidden test ids / titles / assertion labels and dropped if any appears verbatim.
// Fire-and-forget: started from the worker behind LESSON_WRITER=1; failures are logged, never thrown into jobs.
import { MongoServerError, ObjectId, type Document } from "mongodb";
import { z } from "zod";
import { col } from "../db/index.ts";
import { complete } from "../tools/llm.ts";
import { durableWatch } from "./jobwatch.ts";
import { embeddingMode, SEARCH_READ, vectorStage } from "./memory.ts";
import { VECTOR_INDEX } from "./search-indexes.ts";

export const ORIGIN = "lesson-writer";
export const LessonCategory =z.enum(["safety_norm", "plant_quirk", "spec_conflict", "generic"]);

/** What Claude returns. evidence / sceneId are echoed back and then overwritten with the authoritative values. */
export const LessonDraft = z.object({
  trigger: z.string().min(8).describe("the situation in at most 15 words, completing 'When ...' (do not start with 'when'; no tag names, no test ids)"),
  rule: z.string().min(8).describe("what the PLC code must (or must never) do, at most 30 words; starts with 'PLC code must'"),
  category: LessonCategory,
  sceneId: z.string(),
  evidence: z.object({ projectId: z.string(), testIds: z.array(z.string()), failingAssertion: z.string() }),
  goodExample: z.string().nullable().describe("a 1-3 line Structured Text fragment that follows the rule, or null"),
  badExample: z.string().nullable().describe("a 1-3 line Structured Text fragment that breaks the rule, or null"),
});
export type LessonDraft = z.infer<typeof LessonDraft>;
export type LessonStatus = "active" | "candidate";

/** One failing test the repair fixed. Hidden tests carry no title / assertion text (isolation). */
export interface FixedTest {
  testId: string;
  visibility: "public" | "hidden";
  category: string;
  requirementIds: string[];
  title?: string;
  failingAssertion?: string;
}

export interface RepairEvidence {
  projectId: string;
  sceneId: string;
  simRunId: string; // the re-test run that passed the previously failing tests
  beforeSimRunId: string; // the run whose failures the repair addressed
  fromVersionId: string;
  toVersionId: string;
  diagnosisId: string | null;
  diagnosis: string | null;
  diff: string;
  fixed: FixedTest[];
  /** Hidden test strings the lesson must never contain verbatim. Never sent to the model. */
  hiddenStrings: string[];
  rigVerified: boolean;
}

// ---- pure helpers (unit-tested) --------------------------------------------------------------------------------

export const statusFor = (run: Record<string, unknown>): LessonStatus => (Number(run.failed ?? 0) === 0 && Number(run.blocked ?? 0) === 0 ? "active" : "candidate");

/** Only the changed lines of a lineDiff (the fix), header comments dropped, capped. */
export function changedLines(diff: string, max = 60): string {
  return diff
    .split("\n")
    .filter((l) => /^[+-] /.test(l) && !/^[+-]\s*\(\* MongoMation /.test(l))
    .slice(0, max)
    .join("\n");
}

/** Test ids that failed before and pass after (superseded attempts ignored). */
export function fixedTestIds(before: { testId: string; verdict: string; superseded?: boolean }[], after: { testId: string; verdict: string; superseded?: boolean }[]): string[] {
  const failed = new Set(before.filter((t) => !t.superseded && t.verdict === "failed").map((t) => t.testId));
  return [...new Set(after.filter((t) => !t.superseded && t.verdict === "passed" && failed.has(t.testId)).map((t) => t.testId))];
}

/** The first failing assertion of a PUBLIC test, as "label: detail". */
export function firstFailingAssertion(assertions: { label?: string; passed?: boolean; detail?: string }[] | undefined): string | undefined {
  const a = (assertions ?? []).find((x) => x.passed === false);
  return a ? `${a.label ?? "assertion"}: ${a.detail ?? "failed"}`.slice(0, 300) : undefined;
}

/** Strings a lesson must never contain: hidden test ids, titles and assertion labels (long enough to be specific). */
export function hiddenStringsOf(tests: { testId: string; visibility?: string; title?: string; assertions?: { label?: string }[] }[]): string[] {
  const out = new Set<string>();
  for (const t of tests) {
    if (t.visibility !== "hidden") continue;
    out.add(t.testId);
    if (t.title && t.title.length >= 12) out.add(t.title);
    for (const a of t.assertions ?? []) if (a.label && a.label.length >= 16) out.add(a.label);
  }
  return [...out];
}

/** Returns the leaked hidden string, if any field of the draft contains one verbatim (case-insensitive). */
export function leaksHidden(draft: Pick<LessonDraft, "trigger" | "rule" | "goodExample" | "badExample">, hidden: string[]): string | null {
  const hay = [draft.trigger, draft.rule, draft.goodExample ?? "", draft.badExample ?? ""].join("\n").toLowerCase();
  return hidden.find((h) => h && hay.includes(h.toLowerCase())) ?? null;
}

const STOP = new Set("the a an and or of to in on for is are be must when with without plc code it its that this by as at from never only after before".split(" "));
const tokens = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t)));
export function jaccard(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** "when X," -> "X": codegen renders lessons as "When <pattern>: <fix>". */
export const normalizeTrigger = (t: string) => t.trim().replace(/^when\s+/i, "").replace(/[,:;.]+$/, "");

export const lessonText =(d: Pick<LessonDraft, "trigger" | "rule">) => `${d.trigger} -> ${d.rule}`;

export interface ExistingLesson {
  _id: unknown;
  text?: string;
  pattern?: string;
  fix?: string;
  sceneId?: string | null;
  score?: number; // vector similarity (0..1), when available
}

export type DedupeDecision = { action: "insert" } | { action: "merge"; id: unknown; why: string; other?: string };

/** Near-duplicate if vector similarity >= vecMin or token overlap >= jacMin, within the same plant (or unscoped). */
export function dedupeDecision(draft: Pick<LessonDraft, "trigger" | "rule">, sceneId: string, existing: ExistingLesson[], opts = { vecMin: 0.9, jacMin: 0.55 }): DedupeDecision {
  const text = lessonText(draft);
  let best: { id: unknown; why: string; s: number; other: string } | null = null;
  for (const e of existing) {
    if (e.sceneId && e.sceneId !== sceneId) continue;
    const other = e.text || `${e.pattern ?? ""} -> ${e.fix ?? ""}`;
    const j = jaccard(text, other);
    const v = e.score ?? 0;
    const s = Math.max(v >= opts.vecMin ? v : 0, j >= opts.jacMin ? j : 0);
    if (s > 0 && (!best || s > best.s)) best = { id: e._id, why: j >= opts.jacMin ? `overlap ${j.toFixed(2)}` : `vector ${v.toFixed(3)}`, s, other };
  }
  return best ? { action: "merge", id: best.id, why: best.why, other: best.other } : { action: "insert" };
}

const SameRule = z.object({ same: z.boolean().describe("true only if both lessons prescribe the same PLC behaviour; false if they differ or contradict"), reason: z.string() });

/**
 * Embeddings put "lamp must also show running" and "lamp must show the fault alone" close together, so a merge found
 * by vector similarity alone is confirmed by Claude (fast tier); a merge found by word overlap needs no confirmation.
 */
export async function confirmMerge(text: string, d: DedupeDecision, runId: string, judge: (a: string, b: string, runId: string) => Promise<boolean> = sameRule): Promise<DedupeDecision> {
  if (d.action !== "merge" || !d.why.startsWith("vector")) return d;
  try {
    return (await judge(text, d.other ?? "", runId)) ? d : { action: "insert" };
  } catch {
    return { action: "insert" }; // unsure -> append (never fold away a lesson on a failed check)
  }
}

async function sameRule(a: string, b: string, runId: string) {
  const r = await complete({ agent: "lesson", tier: "fast", system: "You compare two PLC engineering lessons (trigger -> rule).", user: `Lesson A: ${a}\nLesson B: ${b}\nDo they prescribe the same behaviour?`, schema: SameRule, runId, effort: "low", maxTokens: 500 });
  return r.data.same;
}

/** The `lessons` document for a new lesson (memory.ts retrieval fields + lesson-writer fields). */
export function lessonDoc(draft: LessonDraft, ev: RepairEvidence, status: LessonStatus, at = new Date()) {
  const source = sourceOf(ev, status);
  return {
    pattern: draft.trigger,
    fix: draft.rule,
    text: lessonText(draft),
    active: status === "active",
    verified: status === "active",
    status,
    sceneId: ev.sceneId,
    category: draft.category,
    trigger: draft.trigger,
    rule: draft.rule,
    goodExample: draft.goodExample ?? null,
    badExample: draft.badExample ?? null,
    evidence: { projectId: ev.projectId, testIds: publicIds(ev), hiddenFixed: ev.fixed.length - publicIds(ev).length, failingAssertion: publicAssertion(ev) },
    support: 1,
    timesHelped: 0,
    origin: ORIGIN,
    sources: [source],
    lastSource: source,
    createdAt: at,
  };
}

/** Evidence cites public test ids only; hidden tests are counted, never named (isolation). */
export const publicIds = (ev: Pick<RepairEvidence, "fixed">) => ev.fixed.filter((t) => t.visibility === "public").map((t) => t.testId);
const publicAssertion = (ev: RepairEvidence) => ev.fixed.find((t) => t.failingAssertion)?.failingAssertion ?? `${ev.fixed.length} test(s) failing before the repair`;
const sourceOf = (ev: RepairEvidence, status: LessonStatus) => ({
  projectId: ev.projectId,
  diagnosisId: ev.diagnosisId ?? "",
  simRunId: ev.simRunId,
  beforeSimRunId: ev.beforeSimRunId,
  toVersionId: ev.toVersionId,
  testIds: publicIds(ev),
  hiddenFixed: ev.fixed.length - publicIds(ev).length,
  verifiedBy: status === "active" ? "rig_retest_passed" : undefined,
});

/** The change-stream filter: sim runs that just finished. */
export const SIM_DONE_PIPELINE: Document[] = [
  { $match: { $or: [{ operationType: "update", "updateDescription.updatedFields.status": "done" }, { operationType: "insert", "fullDocument.status": "done" }] } },
];

/** Decides what a change event means for the lesson writer (pure; unit-tested). */
export function simRunFromEvent(ch: { operationType: string; documentKey?: { _id: unknown }; fullDocument?: Document; updateDescription?: { updatedFields?: Document } }): { simRunId: string; skip?: string } | null {
  const doc = ch.fullDocument;
  const status = doc?.status ?? ch.updateDescription?.updatedFields?.status;
  if (status !== "done") return null;
  const simRunId = String(ch.documentKey?._id ?? doc?._id ?? "");
  if (!simRunId) return null;
  if (doc && doc.split === "heldout") return { simRunId, skip: "held-out run (never writes memory)" };
  return { simRunId };
}

// ---- evidence from Atlas ---------------------------------------------------------------------------------------

const oid = (id: string) => (ObjectId.isValid(id) && String(new ObjectId(id)) === id ? new ObjectId(id) : (id as never));
const TEST_PROJECTION = { testId: 1, verdict: 1, superseded: 1, visibility: 1, title: 1, category: 1, requirementIds: 1, assertions: 1 } as const;
type TestDoc = { testId: string; verdict: string; superseded?: boolean; visibility?: string; title?: string; category?: string; requirementIds?: string[]; assertions?: { label?: string; passed?: boolean; detail?: string }[] };

/** Builds the evidence for "this repair fixed failing tests", or a reason why this run is not such a fix. */
export async function repairEvidence(simRunId: string): Promise<{ ev?: RepairEvidence; skip?: string }> {
  const run = await col.simRuns().findOne({ _id: oid(simRunId) });
  if (!run || run.status !== "done") return { skip: "run not done" };
  if (run.split === "heldout") return { skip: "held-out run" };
  const projectId = String(run.projectId);
  const toVersionId = String(run.plcVersionId);
  const version = await col.plcVersions().findOne({ _id: oid(toVersionId) }, { projection: { source: 0 } });
  if (!version || version.createdBy !== "repair") return { skip: "program was not produced by a repair" };
  // Parent program: the fault path records it on the repair; the engineer path is the previous version number.
  const faultRep = await col.repairs().findOne({ projectId, toVersionId }, { sort: { createdAt: -1 } });
  const parent = faultRep?.fromVersionId
    ? { _id: faultRep.fromVersionId as string }
    : await col.plcVersions().findOne({ projectId, version: Number(version.version) - 1, ...(version.revision != null && { revision: version.revision }) }, { projection: { _id: 1 } });
  if (!parent) return { skip: "no parent program" };
  const fromVersionId = String(parent._id);
  const rep = faultRep ?? (await col.repairs().findOne({ projectId, fromVersionId }, { sort: { createdAt: -1 } }));
  const before = await col.simRuns().findOne({ projectId, plcVersionId: fromVersionId, status: "done", failed: { $gt: 0 }, startedAt: { $lt: run.startedAt } }, { sort: { startedAt: -1 } });
  if (!before) return { skip: "no failing run of the parent program" };
  const [beforeTests, afterTests] = await Promise.all([
    col.testResults().find({ simRunId: String(before._id) }, { projection: TEST_PROJECTION }).toArray() as unknown as Promise<TestDoc[]>,
    col.testResults().find({ simRunId }, { projection: TEST_PROJECTION }).toArray() as unknown as Promise<TestDoc[]>,
  ]);
  const ids = fixedTestIds(beforeTests, afterTests);
  if (!ids.length) return { skip: "the repair fixed none of the failing tests" };
  const fixed: FixedTest[] = ids.map((id) => {
    const t = beforeTests.find((x) => x.testId === id && !x.superseded && x.verdict === "failed")!;
    const hidden = t.visibility === "hidden";
    return {
      testId: id,
      visibility: hidden ? "hidden" : "public",
      category: t.category ?? "unknown",
      requirementIds: t.requirementIds ?? [],
      ...(!hidden && { title: t.title, failingAssertion: firstFailingAssertion(t.assertions) }),
    };
  });
  const diagnosisId = (rep?.diagnosisId as string | undefined) ?? (version.diagnosisId as string | undefined) ?? null;
  const diag = diagnosisId ? await col.diagnoses().findOne({ _id: oid(diagnosisId) }, { projection: { summary: 1 } }) : null;
  return {
    ev: {
      projectId,
      sceneId: String(run.sceneId),
      simRunId,
      beforeSimRunId: String(before._id),
      fromVersionId,
      toVersionId,
      diagnosisId,
      diagnosis: (diag?.summary as string | undefined) ?? null,
      diff: changedLines(String(version.diffFromPrevious ?? "")),
      fixed,
      hiddenStrings: hiddenStringsOf([...beforeTests, ...afterTests]),
      rigVerified: statusFor(run) === "active",
    },
  };
}

// ---- Claude ----------------------------------------------------------------------------------------------------

const SYSTEM = `You write ONE reusable engineering lesson for PLC (IEC 61131-3 Structured Text) code generation, from a
failing test that a code repair fixed on a real simulator rig. Phrase it as: trigger = the situation ("when ..."),
rule = what PLC code must or must never do ("PLC code must ..."). Example: trigger "after a fault reset",
rule "PLC code must require a new Start rising edge before motion; never auto-restart".
Rules: one behaviour rule, short, general enough to transfer to another program on the same plant; no tag addresses,
no test ids, no project ids, no timing numbers copied from the measurements. Do not restate or quote any test; summarise
the behaviour only. category: safety_norm (stop / e-stop / fault / reset / restart safety), plant_quirk (behaviour of
this plant's sensors, actuators or I/O), spec_conflict (the spec was ambiguous or contradicted itself and the repair
picked the reading the tests confirmed), generic (anything else). Echo sceneId and evidence exactly as given.
goodExample / badExample: optional 1-3 line ST fragments with generic names, or null.`;

export function lessonPrompt(ev: RepairEvidence): string {
  const tests = ev.fixed
    .map((t) => (t.visibility === "hidden" ? `- a hidden ${t.category} check on ${t.requirementIds.join(", ")} (details withheld)` : `- ${t.testId} [${t.category}] "${t.title ?? ""}" failed: ${t.failingAssertion ?? "failed"}`))
    .join("\n");
  return `sceneId: ${ev.sceneId}
evidence: ${JSON.stringify({ projectId: ev.projectId, testIds: ev.fixed.filter((t) => t.visibility === "public").map((t) => t.testId), failingAssertion: publicAssertion(ev) })}

## Tests that failed before the repair and pass after it (re-tested on the rig${ev.rigVerified ? ", full run passed" : ", other tests still failing"})
${tests}

## Diagnosis before the repair
${ev.diagnosis ?? "(none recorded)"}

## The repair (changed lines only)
${ev.diff || "(diff unavailable)"}`;
}

export async function draftLesson(ev: RepairEvidence): Promise<LessonDraft> {
  const r = await complete({ agent: "lesson", tier: "fast", system: SYSTEM, user: lessonPrompt(ev), schema: LessonDraft, runId: ev.projectId, effort: "low", maxTokens: 2000 });
  return r.data;
}

// ---- store -----------------------------------------------------------------------------------------------------

async function similarLessons(draft: LessonDraft, sceneId: string): Promise<ExistingLesson[]> {
  const pool = (await col
    .lessons()
    .find({ status: { $nin: ["merged", "superseded"] }, $or: [{ sceneId }, { sceneId: { $exists: false } }, { sceneId: null }] }, { projection: { text: 1, pattern: 1, fix: 1, sceneId: 1 }, limit: 500 })
    .toArray()) as ExistingLesson[];
  if (embeddingMode() === "off") return pool;
  try {
    const stage = (await vectorStage(VECTOR_INDEX.lessons, lessonText(draft), 5, {})) as { $vectorSearch: Document };
    delete stage.$vectorSearch.filter; // dedupe across active AND candidate lessons
    const hits = await col.lessons().aggregate<ExistingLesson>([stage, { $project: { text: 1, pattern: 1, fix: 1, sceneId: 1, score: { $meta: "vectorSearchScore" } } }], SEARCH_READ).toArray();
    const byId = new Map(pool.map((p) => [String(p._id), p]));
    for (const h of hits) if (byId.has(String(h._id))) byId.set(String(h._id), { ...byId.get(String(h._id)), ...h });
    return [...byId.values()];
  } catch (err) {
    console.warn(`lesson dedupe: vector search unavailable (${(err as Error).message}); token overlap only`);
    return pool;
  }
}

export interface WriteOutcome {
  simRunId: string;
  action: "inserted" | "merged" | "skipped";
  status?: LessonStatus;
  lessonId?: string;
  text?: string;
  reason?: string;
}

/** Full path for one finished sim run: evidence -> Claude -> isolation check -> dedupe -> insert / merge. */
export async function processSimRun(simRunId: string, log: (m: string) => void = console.log): Promise<WriteOutcome> {
  // Promotion first: a candidate becomes active once its repaired program passes the FULL plan on the rig
  // (fault-scenario runs only exercise the fault tests, so they do not promote).
  const run = await col.simRuns().findOne({ _id: oid(simRunId) }, { projection: { plcVersionId: 1, failed: 1, blocked: 1, status: 1, split: 1, faultId: 1 } });
  if (run && run.status === "done" && run.split !== "heldout" && !run.faultId && statusFor(run) === "active") {
    const p = await col.lessons().updateMany({ origin: ORIGIN, status: "candidate", "sources.toVersionId": String(run.plcVersionId) }, { $set: { status: "active", active: true, verified: true, promotedAt: new Date(), promotedBy: simRunId } });
    if (p.modifiedCount) log(`lesson-writer: promoted ${p.modifiedCount} candidate lesson(s) to active (sim run ${simRunId} passed)`);
  }
  if (await col.lessons().findOne({ origin: ORIGIN, "sources.simRunId": simRunId }, { projection: { _id: 1 } })) return { simRunId, action: "skipped", reason: "already recorded" };
  const { ev, skip } = await repairEvidence(simRunId);
  if (!ev) return { simRunId, action: "skipped", reason: skip };
  const raw = await draftLesson(ev);
  const draft: LessonDraft = { ...raw, trigger: normalizeTrigger(raw.trigger), sceneId: ev.sceneId, evidence: { projectId: ev.projectId, testIds: publicIds(ev), failingAssertion: publicAssertion(ev) } };
  // Isolation guard: examples are optional, so drop a leaking example; a leaking trigger / rule drops the lesson.
  for (const k of ["goodExample", "badExample"] as const) if (draft[k] && leaksHidden({ trigger: "", rule: "", goodExample: draft[k], badExample: null }, ev.hiddenStrings)) draft[k] = null;
  const leak = leaksHidden(draft, ev.hiddenStrings);
  if (leak) return { simRunId, action: "skipped", reason: `isolation: lesson quoted hidden test text "${leak.slice(0, 40)}"` };
  const status: LessonStatus = ev.rigVerified ? "active" : "candidate";
  const decision = await confirmMerge(lessonText(draft), dedupeDecision(draft, ev.sceneId, await similarLessons(draft, ev.sceneId)), ev.projectId);
  if (decision.action === "merge") {
    const source = sourceOf(ev, status);
    await col.lessons().updateOne(
      { _id: decision.id as never },
      {
        $inc: { support: 1 },
        $addToSet: { sources: source, "evidence.testIds": { $each: source.testIds } } as never,
        $set: { lastSource: source, ...(status === "active" && { status: "active", active: true, verified: true }) },
      },
    );
    log(`lesson-writer: run ${simRunId} supports existing lesson ${String(decision.id)} (${decision.why})`);
    return { simRunId, action: "merged", status, lessonId: String(decision.id), text: lessonText(draft), reason: decision.why };
  }
  try {
    const res = await col.lessons().insertOne(lessonDoc(draft, ev, status) as never);
    log(`lesson-writer: ${status} lesson from run ${simRunId}: when ${draft.trigger} -> ${draft.rule}`);
    return { simRunId, action: "inserted", status, lessonId: String(res.insertedId), text: lessonText(draft) };
  } catch (err) {
    // `pattern` may be uniquely indexed: an identical trigger is the same lesson -> count it as support.
    if (err instanceof MongoServerError && err.code === 11000) {
      await col.lessons().updateOne({ pattern: draft.trigger }, { $inc: { support: 1 }, $addToSet: { sources: sourceOf(ev, status) } as never });
      return { simRunId, action: "merged", status, text: lessonText(draft), reason: "same trigger" };
    }
    throw err;
  }
}

/** Starts the change stream (resume token in change_stream_tokens). Never throws; never blocks jobs. */
export function watchLessons(log: (m: string) => void) {
  return durableWatch(
    "lesson-writer",
    col.simRuns,
    SIM_DONE_PIPELINE,
    { fullDocument: "updateLookup" },
    async (ch) => {
      const hit = simRunFromEvent(ch);
      if (!hit || hit.skip) return;
      // Detached: the token is saved at once, and a slow LLM call never holds up the stream or a job.
      void processSimRun(hit.simRunId, log)
        .then((o) => o.action === "skipped" || log(`lesson-writer: ${o.action} (${o.status}) ${o.text ?? ""}`))
        .catch((err: unknown) => log(`lesson-writer: run ${hit.simRunId}: ${(err as Error).message}`));
    },
    log,
  );
}

/**
 * Consolidation (append-only, nothing deleted): a later lesson-writer lesson that duplicates an earlier one is folded
 * into it (support + sources added to the keeper) and kept on record as status "merged", out of retrieval.
 */
export async function consolidate(log: (m: string) => void = console.log): Promise<number> {
  const all = (await col.lessons().find({ origin: ORIGIN, status: { $in: ["active", "candidate"] } }, { sort: { createdAt: 1 } }).toArray()) as (ExistingLesson & Document)[];
  const kept: (ExistingLesson & Document)[] = [];
  let merged = 0;
  for (const l of all) {
    const draft = { trigger: String(l.pattern), rule: String(l.fix) };
    const d = await confirmMerge(lessonText(draft), dedupeDecision(draft, String(l.sceneId), await scoreAgainst(lessonText(draft), kept)), "lesson-consolidation");
    if (d.action === "insert") {
      kept.push(l);
      continue;
    }
    const keeper = kept.find((k) => String(k._id) === String(d.id))!;
    const promote = l.status === "active" && keeper.status !== "active";
    await col.lessons().updateOne(
      { _id: keeper._id as never },
      {
        $inc: { support: Number(l.support ?? 1) },
        $addToSet: { sources: { $each: (l.sources as Document[]) ?? [] }, "evidence.testIds": { $each: (l.evidence as { testIds?: string[] } | undefined)?.testIds ?? [] } } as never,
        ...(promote && { $set: { status: "active", active: true, verified: true } }),
      },
    );
    if (promote) keeper.status = "active";
    await col.lessons().updateOne({ _id: l._id as never }, { $set: { status: "merged", active: false, verified: false, mergedInto: keeper._id, mergedWhy: d.why } });
    log(`lesson-writer: merged ${String(l._id)} into ${String(keeper._id)} (${d.why})`);
    merged++;
  }
  return merged;
}

async function scoreAgainst(text: string, pool: ExistingLesson[]): Promise<ExistingLesson[]> {
  if (!pool.length || embeddingMode() === "off") return pool;
  try {
    const stage = (await vectorStage(VECTOR_INDEX.lessons, text, 10, {})) as { $vectorSearch: Document };
    delete stage.$vectorSearch.filter;
    const hits = await col.lessons().aggregate<ExistingLesson>([stage, { $project: { score: { $meta: "vectorSearchScore" } } }], SEARCH_READ).toArray();
    const score = new Map(hits.map((h) => [String(h._id), h.score]));
    return pool.map((p) => ({ ...p, score: score.get(String(p._id)) }));
  } catch {
    return pool;
  }
}
