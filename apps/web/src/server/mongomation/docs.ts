// Defensive readers for worker-written documents. Atlas documents are untyped from the dashboard's point
// of view, so every DTO is built field by field from a whitelist: a field the worker did not write stays
// undefined (rendered as an empty state), and nothing that is not listed here (test steps, step logs,
// stage outputs, ...) can reach the browser.
import { ObjectId, type Document } from 'mongodb';
import type {
  AssertionLite,
  CompileLite,
  DiagnosisLite,
  EventLite,
  FaultInjectionLite,
  HarnessDetail,
  HarnessScoresLite,
  HarnessVersionLite,
  IoLite,
  JobLite,
  PlcVersionMeta,
  ProjectDetail,
  ProjectListItem,
  ProposalLite,
  RequirementLite,
  RigLite,
  SceneLite,
  SimRunLite,
  StageLite,
  TagValue,
  TestLite,
  VerdictLite,
  WorkerLite,
} from '@/shared/mongomation';

// ---- primitives ---------------------------------------------------------------------------------

function isObjectIdLike(v: unknown): v is { toHexString(): string } {
  return typeof v === 'object' && v !== null && typeof (v as { toHexString?: unknown }).toHexString === 'function';
}

export const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : isObjectIdLike(v) ? v.toHexString() : undefined;

export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

export function date(v: unknown): Date | undefined {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v;
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

export const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => str(x) ?? (typeof x === 'number' ? String(x) : undefined)).filter((x): x is string => !!x) : [];

export const objArr = (v: unknown): Document[] =>
  Array.isArray(v) ? v.filter((x): x is Document => typeof x === 'object' && x !== null) : [];

export const obj = (v: unknown): Document | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && !isObjectIdLike(v)
    ? (v as Document)
    : undefined;

export const idOf = (v: unknown): string => str(v) ?? String(v);

export const tagValue = (v: unknown): TagValue | undefined =>
  typeof v === 'boolean' ? v : typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Short printable form of an arbitrary scalar (fault values / read-backs). */
export function scalarText(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v).slice(0, 200);
  } catch {
    return undefined;
  }
}

export const clip = (s: string | undefined, max: number): string | undefined =>
  s === undefined ? undefined : s.length > max ? `${s.slice(0, max)}…` : s;

/** Matches an id stored either as a hex string (projects) or as an ObjectId (plc_versions, sim_runs). */
export function idFilter(id: string): string | { $in: (string | ObjectId)[] } {
  return /^[0-9a-f]{24}$/i.test(id) ? { $in: [id, new ObjectId(id)] } : id;
}

export const ageMs = (d: Date | undefined, now: number): number | undefined =>
  d ? Math.max(0, now - d.getTime()) : undefined;

// Hidden regression test ids describe what they probe (checks/src/hidden/regression.ts builds them as
// `H-<requirement>-<what-it-checks>`) and the worker logs "test <id> (hidden) running" before a result
// exists. Free text shown in the dashboard is therefore scrubbed of that pattern and of known hidden ids.
const HIDDEN_TEST_ID = /\bH-R\d+-[A-Za-z0-9_-]+/g;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function redactHidden(text: string | undefined, hiddenIds: readonly string[] = []): string | undefined {
  if (!text) return text;
  let out = text.replace(HIDDEN_TEST_ID, '[hidden test]');
  for (const id of hiddenIds) {
    if (id) out = out.replace(new RegExp(escapeRegExp(id), 'g'), '[hidden test]');
  }
  return out;
}

// ---- collections --------------------------------------------------------------------------------

export function toJob(d: Document, now: number): JobLite {
  const heartbeatAt = date(d.heartbeatAt);
  const createdAt = date(d.createdAt);
  const spec = str(d.specText);
  return {
    id: idOf(d._id),
    type: str(d.type) ?? 'unknown',
    status: str(d.status) ?? 'unknown',
    origin: str(d.origin),
    command: str(d.command),
    sceneId: str(d.sceneId),
    projectId: str(d.projectId),
    faultId: str(d.faultId),
    claimedBy: str(d.claimedBy),
    handledBy: str(d.handledBy),
    heartbeatAt,
    heartbeatAgeMs: ageMs(heartbeatAt, now),
    attempts: num(d.attempts),
    resumedFrom: str(d.resumedFrom),
    interruptedAt: date(d.interruptedAt),
    error: clip(redactHidden(str(d.error)), 1000),
    requestedBy: str(d.requestedBy),
    createdAt,
    createdAgeMs: ageMs(createdAt, now),
    startedAt: date(d.startedAt),
    finishedAt: date(d.finishedAt),
    specExcerpt: clip(spec, 160),
  };
}

export function toWorker(d: Document, now: number): WorkerLite {
  const heartbeatAt = date(d.heartbeatAt);
  return {
    id: idOf(d._id),
    host: str(d.host),
    pid: num(d.pid),
    heartbeatAt,
    heartbeatAgeMs: ageMs(heartbeatAt, now),
    currentJobId: str(d.currentJobId),
  };
}

export function toRig(d: Document, now: number): RigLite {
  const checkedAt = date(d.checkedAt);
  const openplc = obj(d.openplc);
  const factoryio = obj(d.factoryio);
  const tags: Record<string, TagValue> = {};
  for (const [name, value] of Object.entries(obj(d.tags) ?? {})) {
    const v = tagValue(value);
    if (v !== undefined) tags[name] = v;
  }
  return {
    id: idOf(d._id),
    checkedAt,
    ageMs: ageMs(checkedAt, now),
    sceneId: str(d.sceneId),
    openplc: openplc
      ? { reachable: bool(openplc.reachable), running: bool(openplc.running), detail: clip(str(openplc.detail), 400) }
      : undefined,
    factoryio: factoryio ? { reachable: bool(factoryio.reachable), detail: clip(str(factoryio.detail), 400) } : undefined,
    forced: strArr(d.forced),
    tags,
    dcvUrl: safeHttpUrl(str(d.dcvUrl)),
  };
}

/** Only http(s) links are rendered as anchors (never javascript: or data: URLs). */
function safeHttpUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function toScene(d: Document): SceneLite {
  return {
    id: str(d.id) ?? idOf(d._id),
    title: str(d.title),
    description: clip(str(d.description), 600),
    factoryIoScene: str(d.factoryIoScene),
    verified: d.verified === true,
    capabilities: strArr(d.capabilities),
    tags: objArr(d.tags)
      .map((t) => ({
        name: str(t.name) ?? '',
        role: str(t.role),
        dataType: str(t.dataType),
        plcAddress: str(t.plcAddress),
        kind: str(t.kind),
        normallyClosed: bool(t.normallyClosed),
      }))
      .filter((t) => t.name),
    faults: objArr(d.faults)
      .map((f) => ({
        id: str(f.id) ?? '',
        title: str(f.title),
        kind: str(f.kind),
        tag: str(f.tag),
        value: tagValue(f.value),
        description: clip(str(f.description), 400),
      }))
      .filter((f) => f.id),
  };
}

export function toProjectListItem(d: Document): ProjectListItem {
  return {
    id: idOf(d._id),
    specExcerpt: clip(str(d.specText), 140) ?? '',
    sceneId: str(d.sceneId),
    status: str(d.status),
    currentVersion: num(d.currentVersion),
    attempts: num(d.attempts),
    harnessVersion: num(d.harnessVersion),
    costUsd: num(d.costUsd),
    createdAt: date(d.createdAt),
  };
}

export function toProject(d: Document): ProjectDetail {
  return {
    id: idOf(d._id),
    specText: clip(str(d.specText), 10_000),
    sceneId: str(d.sceneId),
    status: str(d.status),
    harnessVersion: num(d.harnessVersion),
    currentPlcVersionId: str(d.currentPlcVersionId),
    currentVersion: num(d.currentVersion),
    finalPlcVersionId: str(d.finalPlcVersionId),
    lastSimRunId: str(d.lastSimRunId),
    attempts: num(d.attempts),
    costUsd: num(d.costUsd),
    createdAt: date(d.createdAt),
    unsupported: objArr(d.unsupported).map((u) => ({ id: str(u.id), reason: clip(str(u.reason), 400) })),
    ...recallFields(d),
  };
}

// Experience recall (whitelisted; the fingerprint, reason text and source test list stay on the server).
function recallFields(d: Document): Pick<ProjectDetail, 'recall' | 'runIndex' | 'reusedFrom'> {
  const r = obj(d.recall);
  const m = obj(d.metrics);
  const rf = obj(d.reusedFrom);
  const rt = obj(rf?.tests);
  return {
    recall: r ? { kind: str(r.kind), sourceProjectId: str(r.sourceProjectId), score: num(r.score), msSaved: num(r.msSaved), confirmed: typeof r.confirmed === 'boolean' ? r.confirmed : undefined } : undefined,
    runIndex: num(m?.runIndex) ?? num(r?.runIndex),
    reusedFrom: rf ? { projectId: str(rf.projectId), tests: rt ? { passed: num(rt.passed), total: num(rt.total) } : undefined } : undefined,
  };
}

export function toStage(d: Document, now: number, hiddenIds: readonly string[] = []): StageLite {
  const startedAt = date(d.startedAt);
  const finishedAt = date(d.finishedAt);
  const status = str(d.status);
  const durationMs =
    startedAt && finishedAt
      ? Math.max(0, finishedAt.getTime() - startedAt.getTime())
      : startedAt && status === 'running'
        ? Math.max(0, now - startedAt.getTime())
        : undefined;
  return {
    stage: str(d.stage) ?? 'unknown',
    attempt: num(d.attempt) ?? 0,
    status,
    startedAt,
    finishedAt: status === 'running' ? undefined : finishedAt,
    durationMs,
    error: clip(redactHidden(str(d.error), hiddenIds), 1200),
    runs: num(d.runs),
    dependsOn: strArr(d.dependsOn),
    jobId: str(d.jobId),
  };
}

export function toEvent(d: Document, hiddenIds: readonly string[] = []): EventLite {
  return {
    id: idOf(d._id),
    ts: date(d.ts),
    level: str(d.level),
    stage: str(d.stage),
    message: clip(redactHidden(str(d.message), hiddenIds), 1200) ?? '',
    jobId: str(d.jobId),
  };
}

export function toRequirement(d: Document): RequirementLite {
  const bindings: Record<string, string> = {};
  for (const [role, tag] of Object.entries(obj(d.bindings) ?? {})) {
    const t = str(tag);
    if (t) bindings[role] = t;
  }
  return {
    id: str(d.id) ?? '?',
    kind: str(d.kind),
    text: clip(str(d.text), 800),
    bindings,
    support: str(d.support),
    unsupportedReason: clip(str(d.unsupportedReason), 400),
  };
}

export function toIo(d: Document): IoLite {
  return {
    variable: str(d.variable),
    tag: str(d.tag),
    address: str(d.address),
    dataType: str(d.dataType),
    role: str(d.role),
    normallyClosed: bool(d.normallyClosed),
  };
}

export function toPlcVersionMeta(d: Document): PlcVersionMeta {
  return {
    id: idOf(d._id),
    version: num(d.version),
    createdBy: str(d.createdBy),
    harnessVersion: num(d.harnessVersion),
    sourceHash: str(d.sourceHash),
    createdAt: date(d.createdAt),
  };
}

const LOG_TAIL = 4000;
export function toCompile(d: Document): CompileLite {
  const log = str(d.log);
  return {
    id: idOf(d._id),
    plcVersionId: str(d.plcVersionId),
    stage: str(d.stage),
    toolchain: str(d.toolchain),
    status: str(d.status),
    ok: bool(d.ok),
    durationMs: num(d.durationMs),
    // Compiler errors are at the end of the log.
    log: log && log.length > LOG_TAIL ? log.slice(-LOG_TAIL) : log,
    logTruncated: !!log && log.length > LOG_TAIL,
    createdAt: date(d.createdAt),
  };
}

export function toSimRun(d: Document): SimRunLite {
  return {
    id: idOf(d._id),
    status: str(d.status),
    plcVersionId: str(d.plcVersionId),
    sceneId: str(d.sceneId),
    faultId: str(d.faultId),
    planHash: str(d.planHash),
    harnessVersion: num(d.harnessVersion),
    startedAt: date(d.startedAt),
    finishedAt: date(d.finishedAt),
    passed: num(d.passed),
    failed: num(d.failed),
    blocked: num(d.blocked),
  };
}

export function toAssertion(d: Document): AssertionLite {
  return { label: clip(str(d.label), 300), passed: bool(d.passed), detail: clip(str(d.detail), 600), atMs: num(d.atMs) };
}

/** Hidden tests are reduced to category + verdict: no title, test id, assertions, steps or step logs. */
export function toTest(d: Document): TestLite {
  const hidden = str(d.visibility) !== 'public';
  const category = str(d.category);
  const base = {
    id: idOf(d._id),
    simRunId: str(d.simRunId),
    category,
    requirementIds: strArr(d.requirementIds),
    verdict: str(d.verdict),
    blockedReason: clip(redactHidden(str(d.blockedReason)), 600),
    durationMs: num(d.durationMs),
    sampleCount: num(d.sampleCount),
    traceId: str(d.traceId),
  };
  if (hidden) {
    return { ...base, visibility: 'hidden', title: `Hidden regression: ${category ?? 'uncategorized'}`, assertions: [] };
  }
  return {
    ...base,
    visibility: 'public',
    testId: str(d.testId),
    title: clip(str(d.title), 300) ?? str(d.testId) ?? 'Untitled test',
    assertions: objArr(d.assertions).slice(0, 50).map(toAssertion),
  };
}

export function toVerdict(d: Document): VerdictLite {
  return {
    requirementId: str(d.requirementId) ?? '?',
    status: str(d.status),
    testIds: strArr(d.testIds),
    detail: clip(str(d.detail), 600),
  };
}

export function toFaultInjection(d: Document): FaultInjectionLite {
  return {
    id: idOf(d._id),
    faultId: str(d.faultId),
    tag: str(d.tag),
    value: scalarText(d.value),
    readBack: scalarText(d.readBack),
    status: str(d.status),
    appliedAt: date(d.appliedAt),
    releasedAt: date(d.releasedAt),
  };
}

export function toDiagnosis(d: Document): DiagnosisLite {
  return {
    id: idOf(d._id),
    plcVersionId: str(d.plcVersionId),
    summary: clip(str(d.summary), 2000),
    causes: objArr(d.causes)
      .slice(0, 20)
      .map((c) => ({ requirementId: str(c.requirementId), cause: clip(str(c.cause), 600), fix: clip(str(c.fix), 600) })),
    lessons: objArr(d.lessons)
      .slice(0, 20)
      .map((l) => ({ pattern: clip(str(l.pattern), 400), fix: clip(str(l.fix), 400) })),
    traceId: str(d.traceId),
    createdAt: date(d.createdAt),
  };
}

// ---- harness / RSI ------------------------------------------------------------------------------

const SCORE_KEYS: (keyof HarnessScoresLite)[] = [
  'cases',
  'requirement_satisfaction',
  'safety_pass_rate',
  'compile_first_try',
  'test_pass_rate',
  'repairs_per_case',
  'cost_usd_per_case',
  'seconds_per_case',
  'tests_blocked',
];

export function toScores(v: unknown): HarnessScoresLite | undefined {
  const o = obj(v);
  if (!o) return undefined;
  const out: HarnessScoresLite = {};
  let any = false;
  for (const k of SCORE_KEYS) {
    const n = num(o[k]);
    if (n !== undefined) {
      out[k] = n;
      any = true;
    }
  }
  return any ? out : undefined;
}

export function toHarnessVersion(d: Document): HarnessVersionLite {
  return {
    version: num(d.version) ?? -1,
    parent: num(d.parent),
    verdict: str(d.verdict),
    rationale: clip(str(d.rationale), 400),
    gateNote: clip(str(d.gateNote), 400),
    createdAt: date(d.createdAt),
    decidedAt: date(d.decidedAt),
    rulesCount: num(d.rulesCount) ?? (Array.isArray(d.rules) ? d.rules.length : 0),
    hasScores: !!toScores(d.scores),
    restoredFrom: num(d.restoredFrom),
  };
}

const SETTING_SECTIONS = ['context', 'workflow', 'repair', 'routing'] as const;

export function toHarnessDetail(d: Document): HarnessDetail {
  const evidence = obj(d.evidence);
  return {
    ...toHarnessVersion(d),
    rationale: clip(str(d.rationale), 3000),
    gateNote: clip(str(d.gateNote), 2000),
    rules: strArr(d.rules).map((r) => clip(r, 600) ?? r),
    scores: toScores(d.scores),
    parentScores: toScores(d.parentScores),
    evidence: evidence
      ? {
          runIds: strArr(evidence.runIds),
          testResultIds: strArr(evidence.testResultIds),
          raindropEventIds: strArr(evidence.raindropEventIds),
        }
      : undefined,
    settings: SETTING_SECTIONS.flatMap((section) => {
      const o = obj(d[section]);
      if (!o) return [];
      const values: Record<string, string> = {};
      for (const [k, v] of Object.entries(o)) {
        const text = scalarText(v);
        if (text !== undefined) values[k] = text;
      }
      return [{ section, values }];
    }),
  };
}

export function toProposal(d: Document): ProposalLite {
  return {
    id: idOf(d._id),
    createdAt: date(d.createdAt),
    fromVersion: num(d.fromVersion),
    candidateVersion: num(d.candidateVersion),
    change: bool(d.change),
    rationale: clip(str(d.rationale), 3000),
    expectedEffect: clip(str(d.expectedEffect), 1500),
    citedRunIds: strArr(d.citedRunIds),
    diff: (Array.isArray(d.diff) ? strArr(d.diff) : (str(d.diff)?.split('\n') ?? [])).slice(0, 400),
    guardrailViolations: strArr(d.guardrailViolations),
    verdict: str(d.verdict),
    benchmarkIds: strArr(d.benchmarkIds),
    provenance: str(d.provenance),
    jobId: str(d.jobId) ?? (d.jobId ? idOf(d.jobId) : undefined),
    trigger: clip(str(d.trigger), 200),
    evidence: toProposalEvidence(d.evidenceSummary),
  };
}

// Evidence the proposer saw. Test-result ids are deliberately NOT forwarded (they can reference hidden tests);
// free text is scrubbed of hidden-test-id patterns.
function toProposalEvidence(v: unknown): ProposalLite['evidence'] {
  const e = obj(v);
  if (!e) return undefined;
  const rd = obj(e.raindrop);
  return {
    harnessVersion: num(e.harnessVersion),
    projects: num(e.projects),
    requirementSatisfaction: num(e.requirementSatisfaction),
    clusters: objArr(e.clusters)
      .slice(0, 12)
      .map((c) => ({
        pattern: redactHidden(clip(str(c.pattern), 300)) ?? '—',
        count: num(c.count) ?? 0,
        projects: num(c.projects),
        runIds: strArr(c.runIds).slice(0, 20),
        raindropEvents: strArr(c.raindropEventIds).length,
      })),
    raindrop: rd
      ? {
          source: str(rd.source),
          windowDays: num(rd.windowDays),
          totalEvents: num(rd.totalEvents),
          signals: objArr(rd.signals)
            .slice(0, 10)
            .map((s) => ({ name: clip(str(s.name), 120) ?? '—', sentiment: str(s.sentiment), events: num(s.events) ?? 0 })),
        }
      : undefined,
  };
}
