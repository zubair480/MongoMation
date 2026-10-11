// Contract between the dashboard's server module (src/server/mongomation) and the React client.
// Pure TypeScript: no Node or browser APIs, so both the server bundle and the Vite client import it.
//
// Every value here describes data read from MongoDB Atlas (written by the MongoMation worker) or the
// shape of a request the dashboard writes to `jobs`. Nothing in this file produces data on its own.

/** Polling cadence (react-query refetchInterval). */
export const POLL_FAST_MS = 1500;
export const POLL_MS = 2000;
export const POLL_SLOW_MS = 5000;

/** Fault injection needs a rig heartbeat younger than this (checked on the server and mirrored in the UI). */
export const RIG_FRESH_MS = 10_000;
/** Mirrors the worker's STALE_MS: a claimed job without a heartbeat for this long is considered stale. */
export const WORKER_STALE_MS = 15_000;
/** A job type with this many unclaimed jobs refuses new requests (protects the queue from double clicks). */
export const MAX_QUEUED_PER_TYPE = 5;

export type JobType = 'engineer' | 'fault_and_improve' | 'evolve' | 'benchmark' | 'spec_change' | 'worker_command';
export type JobStatus = 'queued' | 'running' | 'verifying' | 'completed' | 'failed' | 'blocked' | 'interrupted';
export const ACTIVE_JOB_STATUSES: readonly string[] = ['queued', 'running', 'verifying'];

// ------------------------------------------------------------------------------------------------
// Envelope: every read query answers with this, so the UI can always tell "no data" from "no Atlas".
// ------------------------------------------------------------------------------------------------

/** config = no URI configured; connect = cluster unreachable / auth failed; query = a read failed. */
export type AtlasErrorStage = 'config' | 'connect' | 'query';
export interface Disconnected {
  connected: false;
  error: string;
  stage: AtlasErrorStage;
}
/**
 * `cacheAgeMs`: how old the server's shared read was when it was served (reads are shared between
 * viewers for up to ~1 s); the client adds it to the server-computed ages so "x s ago" stays exact.
 */
export type Envelope<T> = (({ connected: true; db: string } & T) | Disconnected) & { cacheAgeMs?: number };

// ------------------------------------------------------------------------------------------------
// DTOs (all optional fields stay undefined when the worker has not written them; the UI renders
// an explicit empty state instead of inventing a value).
// ------------------------------------------------------------------------------------------------

export type TagValue = boolean | number;

export interface JobLite {
  id: string;
  type: string;
  status: string;
  origin?: string;
  command?: string;
  sceneId?: string;
  projectId?: string;
  faultId?: string;
  claimedBy?: string;
  handledBy?: string;
  heartbeatAt?: Date;
  /** Server-computed age of heartbeatAt at query time (avoids browser clock skew). */
  heartbeatAgeMs?: number;
  attempts?: number;
  resumedFrom?: string;
  interruptedAt?: Date;
  error?: string;
  requestedBy?: string;
  createdAt?: Date;
  createdAgeMs?: number;
  startedAt?: Date;
  finishedAt?: Date;
  specExcerpt?: string;
}

export interface WorkerLite {
  id: string;
  host?: string;
  pid?: number;
  heartbeatAt?: Date;
  heartbeatAgeMs?: number;
  currentJobId?: string;
}

export interface RigLite {
  id: string;
  checkedAt?: Date;
  /** Server-computed age of checkedAt at query time. */
  ageMs?: number;
  sceneId?: string;
  openplc?: { reachable?: boolean; running?: boolean; detail?: string };
  factoryio?: { reachable?: boolean; detail?: string };
  forced: string[];
  tags: Record<string, TagValue>;
  dcvUrl?: string;
}

export interface SceneTagLite {
  name: string;
  role?: string;
  dataType?: string;
  plcAddress?: string;
  kind?: string;
  normallyClosed?: boolean;
}

export interface SceneFaultLite {
  id: string;
  title?: string;
  kind?: string;
  tag?: string;
  value?: TagValue;
  description?: string;
}

export interface SceneLite {
  id: string;
  title?: string;
  description?: string;
  factoryIoScene?: string;
  verified: boolean;
  capabilities: string[];
  tags: SceneTagLite[];
  faults: SceneFaultLite[];
}

/** Example metadata. The spec text itself stays on the server and is returned by runExample. */
export interface ExampleLite {
  id: string;
  title: string;
  sceneId: string;
}

export interface ProjectListItem {
  id: string;
  specExcerpt: string;
  sceneId?: string;
  status?: string;
  currentVersion?: number;
  attempts?: number;
  harnessVersion?: number;
  costUsd?: number;
  createdAt?: Date;
}

export interface StageLite {
  stage: string;
  attempt: number;
  status?: string;
  startedAt?: Date;
  finishedAt?: Date;
  /** finishedAt - startedAt, or (query time - startedAt) while running. */
  durationMs?: number;
  error?: string;
  runs?: number;
  dependsOn: string[];
  jobId?: string;
}

export interface DashboardData {
  serverTime: Date;
  /** Whether Modelence's own database (users / sessions) is configured, i.e. whether sign-in can work. */
  authDbConfigured: boolean;
  workers: WorkerLite[];
  rig: RigLite | null;
  latestJobs: {
    generate: JobLite | null;
    example: JobLite | null;
    fault: JobLite | null;
    specChange: JobLite | null;
    command: JobLite | null;
  };
  /** Unclaimed jobs waiting for a worker. */
  queuedCount: number;
  /** Newest job in running / verifying state (excluding worker commands), if any. */
  activeJob: JobLite | null;
  /** Newest job of any state (excluding worker commands). */
  lastJob: JobLite | null;
  /** Project the active (or last) job works on, and its stage checkpoints. */
  checkpointProjectId: string | null;
  checkpoints: StageLite[];
  projects: ProjectListItem[];
}

export interface ScenesData {
  scenes: SceneLite[];
  examples: ExampleLite[];
}

export interface RequirementLite {
  id: string;
  kind?: string;
  text?: string;
  bindings: Record<string, string>;
  support?: string;
  unsupportedReason?: string;
}

export interface IoLite {
  variable?: string;
  tag?: string;
  address?: string;
  dataType?: string;
  role?: string;
  normallyClosed?: boolean;
}

export interface ProjectDetail {
  id: string;
  specText?: string;
  sceneId?: string;
  status?: string;
  harnessVersion?: number;
  currentPlcVersionId?: string;
  currentVersion?: number;
  finalPlcVersionId?: string;
  lastSimRunId?: string;
  attempts?: number;
  costUsd?: number;
  createdAt?: Date;
  unsupported: { id?: string; reason?: string }[];
  /** Experience recall outcome (worker: projects.recall). kind "none" = cold run. */
  recall?: RecallLite;
  /** Prior runs of these requirements on this scene before this one (worker: metrics.runIndex, 0-based). */
  runIndex?: number;
  /** status "verified-by-reuse" only: the source project's rig evidence (NOT re-tested in this project). */
  reusedFrom?: { projectId?: string; tests?: { passed?: number; total?: number } };
}

export interface RecallLite {
  kind?: string;
  sourceProjectId?: string;
  score?: number;
  msSaved?: number;
  confirmed?: boolean;
}

export interface EventLite {
  id: string;
  ts?: Date;
  level?: string;
  stage?: string;
  message: string;
  jobId?: string;
}

export interface PlcVersionMeta {
  id: string;
  version?: number;
  createdBy?: string;
  harnessVersion?: number;
  sourceHash?: string;
  createdAt?: Date;
}

export interface CompileLite {
  id: string;
  plcVersionId?: string;
  stage?: string;
  toolchain?: string;
  status?: string;
  ok?: boolean;
  durationMs?: number;
  log?: string;
  logTruncated?: boolean;
  createdAt?: Date;
}

export interface SimRunLite {
  id: string;
  status?: string;
  plcVersionId?: string;
  sceneId?: string;
  faultId?: string;
  planHash?: string;
  harnessVersion?: number;
  startedAt?: Date;
  finishedAt?: Date;
  passed?: number;
  failed?: number;
  blocked?: number;
}

export interface AssertionLite {
  label?: string;
  passed?: boolean;
  detail?: string;
  atMs?: number;
}

/** A test result as the dashboard may show it. Hidden tests carry no title, test id, steps or assertions. */
export interface TestLite {
  id: string;
  simRunId?: string;
  /** Only for public tests. */
  testId?: string;
  title: string;
  category?: string;
  visibility: 'public' | 'hidden';
  requirementIds: string[];
  verdict?: string;
  assertions: AssertionLite[];
  blockedReason?: string;
  durationMs?: number;
  sampleCount?: number;
  traceId?: string;
}

export interface VerdictLite {
  requirementId: string;
  status?: string;
  testIds: string[];
  detail?: string;
}

export interface FaultInjectionLite {
  id: string;
  faultId?: string;
  tag?: string;
  value?: string;
  readBack?: string;
  status?: string;
  appliedAt?: Date;
  releasedAt?: Date;
}

export interface DiagnosisLite {
  id: string;
  plcVersionId?: string;
  summary?: string;
  causes: { requirementId?: string; cause?: string; fix?: string }[];
  lessons: { pattern?: string; fix?: string }[];
  traceId?: string;
  createdAt?: Date;
}

export interface ProjectData {
  project: ProjectDetail | null;
  requirements: { revision?: number; sceneId?: string; items: RequirementLite[]; io: IoLite[] } | null;
  stages: StageLite[];
  events: EventLite[];
  /** Newest first. */
  plcVersions: PlcVersionMeta[];
  /** Preflight + OpenPLC compile results for the newest PLC version, newest first. */
  compiles: CompileLite[];
  /** Newest simulation run of the project (may still be running). */
  simRun: SimRunLite | null;
  tests: TestLite[];
  testCounts: { passed: number; failed: number; blocked: number; total: number };
  verdicts: VerdictLite[];
  /**
   * Where `verdicts` came from: the newest sim run that has verdicts (`latestRun` false when a newer run
   * is still in progress), or the project's final verification.
   */
  verdictSource: { kind: 'sim_run' | 'project'; simRunId?: string; latestRun?: boolean } | null;
  faults: FaultInjectionLite[];
  diagnosis: DiagnosisLite | null;
  /** Lessons for the Log tab: this project's (diagnoses + lessons-collection entries citing it), then recent global ones. */
  lessons?: { project: LessonLite[]; global: LessonLite[] };
}

/** One lesson as shown in the Log tab. Hidden test ids are scrubbed from all text. */
export interface LessonLite {
  id: string;
  pattern?: string;
  fix?: string;
  /** diagnosis = from a diagnosis of this run; repair = that diagnosis drove a repair; critic/lesson-writer = lessons collection. */
  source: 'diagnosis' | 'repair' | 'critic' | 'lesson-writer';
  /** Requirements the originating diagnosis covered (failing requirement ids). */
  requirementIds: string[];
  createdAt?: Date;
  status?: string;
  category?: string;
  verified?: boolean;
  projectId?: string;
}

export interface PlcSourceData {
  found: boolean;
  id: string;
  version?: number;
  createdBy?: string;
  source?: string;
  /** Lines prefixed "+ ", "- " or "  " (null for the first version). */
  diff: string[] | null;
}

export interface TimelineData {
  found: boolean;
  /** Hidden regression tests never expose their measured stimulus (it would reveal the test steps). */
  hidden: boolean;
  simRunId: string;
  testId: string;
  /** Change points only (consecutive identical samples are dropped; a step chart is unchanged by this). */
  samples: { t: number; values: Record<string, TagValue> }[];
  totalSamples: number;
  truncated: boolean;
  durationMs?: number;
  assertions: AssertionLite[];
}

export interface HarnessScoresLite {
  cases?: number;
  requirement_satisfaction?: number;
  safety_pass_rate?: number;
  compile_first_try?: number;
  test_pass_rate?: number;
  repairs_per_case?: number;
  cost_usd_per_case?: number;
  seconds_per_case?: number;
  /** Tests that produced no evidence (counted as not passed). */
  tests_blocked?: number;
}

export interface HarnessVersionLite {
  version: number;
  parent?: number;
  verdict?: string;
  rationale?: string;
  gateNote?: string;
  createdAt?: Date;
  decidedAt?: Date;
  rulesCount: number;
  hasScores: boolean;
  /** Set when this version is an operator restore (copy) of an earlier version. */
  restoredFrom?: number;
}

export interface HarnessDetail extends HarnessVersionLite {
  rules: string[];
  scores?: HarnessScoresLite;
  parentScores?: HarnessScoresLite;
  evidence?: { runIds: string[]; testResultIds: string[]; raindropEventIds: string[] };
  settings: { section: string; values: Record<string, string> }[];
}

export interface ProposalLite {
  id: string;
  createdAt?: Date;
  fromVersion?: number;
  candidateVersion?: number;
  change?: boolean;
  rationale?: string;
  expectedEffect?: string;
  citedRunIds: string[];
  diff: string[];
  guardrailViolations: string[];
  verdict?: string;
  benchmarkIds: string[];
  provenance?: string;
  jobId?: string;
  trigger?: string;
  evidence?: {
    harnessVersion?: number;
    projects?: number;
    requirementSatisfaction?: number;
    clusters: { pattern: string; count: number; projects?: number; runIds: string[]; raindropEvents: number }[];
    raindrop?: { source?: string; windowDays?: number; totalEvents?: number; signals: { name: string; sentiment?: string; events: number }[] };
  };
}

export interface RsiData {
  active: HarnessDetail | null;
  /** Rules diff of the active version vs its parent ("+ " / "- " lines); [] when the rules are identical. */
  activeRuleDiff?: string[];
  /** sim_run id → project id for the latest proposal's cited runs (only those resolvable). */
  citedRunProjects?: Record<string, string>;
  /** Newest first, up to 5. */
  recentProposals?: { id: string; createdAt?: Date; verdict?: string; fromVersion?: number; summary?: string }[];
  /** Newest first. */
  versions: HarnessVersionLite[];
  latestProposal: ProposalLite | null;
  candidate: HarnessDetail | null;
  proposalCount: number;
}

/** One condition of the newest ablation run (bare one-shot / harness v0 / evolved vN). */
export interface AblationConditionLite {
  /** Key in the summary row: "bare", "v0", "v3"... */
  key: string;
  /** Harness version for vN keys (undefined for "bare"). */
  version?: number;
  scores?: HarnessScoresLite;
  /** Per-case rows stored in benchmark_runs for this condition and run. */
  rows: number;
}

export interface AblationData {
  /** Newest `kind: "ablation_summary"` row, or null when no ablation has finished. */
  summary: {
    benchmarkId: string;
    manifestHash?: string;
    createdAt?: Date;
    model?: { fast?: string; strong?: string };
    conditions: AblationConditionLite[];
  } | null;
  /** Newest ablation case rows whose run has no summary yet (a run still going, or one that stopped). */
  inProgress: { benchmarkId: string; rows: number; lastRowAt?: Date } | null;
  summaryCount: number;
}

// ------------------------------------------------------------------------------------------------
// Pipeline stages
// ------------------------------------------------------------------------------------------------

export const PIPELINE_STAGES = [
  'requirements',
  'io_design',
  'state_machine',
  'plc_code',
  'preflight',
  'compile',
  'deploy',
  'simulate',
  'tests',
  'diagnosis',
  'repair',
  'verification',
  'deliver',
] as const;

export const STAGE_LABELS: Record<string, string> = {
  requirements: 'Requirements',
  io_design: 'I/O design',
  state_machine: 'State machine',
  plc_code: 'PLC code',
  preflight: 'Preflight (MatIEC)',
  compile: 'OpenPLC compile',
  deploy: 'Deploy',
  simulate: 'Simulate',
  tests: 'Tests',
  diagnosis: 'Diagnosis',
  repair: 'Repair',
  verification: 'Verification',
  deliver: 'Deliver',
};

/** The ten stages shown in "Engineering Execution", each backed by one or more worker stages. */
export const DISPLAY_STAGES: { key: string; label: string; raw: string[] }[] = [
  { key: 'requirements', label: 'Requirements', raw: ['requirements'] },
  { key: 'io_design', label: 'I/O Design', raw: ['io_design'] },
  { key: 'plc_code', label: 'PLC Code', raw: ['state_machine', 'plc_code'] },
  { key: 'compile', label: 'Compilation', raw: ['preflight', 'compile'] },
  { key: 'deploy', label: 'Deployment', raw: ['deploy'] },
  { key: 'simulate', label: 'Simulation', raw: ['simulate'] },
  { key: 'tests', label: 'Independent Tests', raw: ['tests'] },
  { key: 'diagnosis', label: 'Diagnosis', raw: ['diagnosis'] },
  { key: 'repair', label: 'Repair', raw: ['repair'] },
  { key: 'verification', label: 'Verification', raw: ['verification'] },
];

export interface StageSummary {
  /** running | done | failed | blocked | pending (no checkpoint in Atlas yet). */
  status: string;
  /** Distinct attempt numbers recorded for this stage group. */
  attempts: number;
  /** Total executions including re-runs after a resume. */
  runs: number;
  latestAttempt?: number;
  startedAt?: Date;
  finishedAt?: Date;
  durationMs?: number;
  error?: string;
}

/** Folds the stage checkpoints of one group (e.g. preflight + compile) into one row, from real docs only. */
export function summarizeStages(docs: StageLite[]): StageSummary {
  if (docs.length === 0) return { status: 'pending', attempts: 0, runs: 0 };
  const latestAttempt = Math.max(...docs.map((d) => d.attempt));
  const latest = docs.filter((d) => d.attempt === latestAttempt);
  const statuses = latest.map((d) => d.status ?? 'unknown');
  const status = statuses.includes('running')
    ? 'running'
    : statuses.includes('failed')
      ? 'failed'
      : statuses.includes('blocked')
        ? 'blocked'
        : statuses.every((s) => s === 'done')
          ? 'done'
          : statuses[0];
  const started = latest.map((d) => d.startedAt?.getTime()).filter((t): t is number => t !== undefined);
  const finished = latest.map((d) => d.finishedAt?.getTime()).filter((t): t is number => t !== undefined);
  const durations = latest.map((d) => d.durationMs).filter((t): t is number => t !== undefined);
  const withError = [...docs]
    .filter((d) => d.error)
    .sort((a, b) => (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0))[0];
  return {
    status,
    attempts: new Set(docs.map((d) => d.attempt)).size,
    runs: docs.reduce((n, d) => n + (d.runs ?? 0), 0),
    latestAttempt,
    startedAt: started.length ? new Date(Math.min(...started)) : undefined,
    finishedAt: finished.length && status !== 'running' ? new Date(Math.max(...finished)) : undefined,
    durationMs: durations.length ? durations.reduce((a, b) => a + b, 0) : undefined,
    error: status === 'done' ? undefined : withError?.error,
  };
}

// ------------------------------------------------------------------------------------------------
// Preconditions (the server enforces them; the UI mirrors them to disable buttons and explain why)
// ------------------------------------------------------------------------------------------------

export interface FaultPreconditionInput {
  project: { id: string; sceneId?: string; finalPlcVersionId?: string } | null;
  scene: { id: string; verified: boolean } | null;
  rig: { checkedAgeMs?: number; factoryioReachable?: boolean; factoryioDetail?: string } | null;
}

/** Reasons the fault-injection job cannot run. Empty array = all preconditions hold. */
export function faultPreconditionFailures({ project, scene, rig }: FaultPreconditionInput): string[] {
  const reasons: string[] = [];
  if (!project) {
    reasons.push('no project selected');
  } else {
    if (!project.finalPlcVersionId) reasons.push('the project has no final PLC version yet (finalPlcVersionId is empty)');
    if (!project.sceneId) reasons.push('the project has no scene');
    else if (!scene) reasons.push(`scene "${project.sceneId}" is not registered in Atlas`);
    else if (!scene.verified) reasons.push(`scene "${scene.id}" is UNVERIFIED`);
  }
  if (!rig) {
    reasons.push('no rig status in Atlas (rig_status is empty)');
  } else {
    if (rig.factoryioReachable !== true)
      reasons.push(`Factory I/O is not reachable${rig.factoryioDetail ? `: ${rig.factoryioDetail}` : ''}`);
    if (rig.checkedAgeMs === undefined) reasons.push('rig status has no checkedAt timestamp');
    else if (rig.checkedAgeMs >= RIG_FRESH_MS)
      reasons.push(`rig status is stale (checked ${Math.round(rig.checkedAgeMs / 1000)} s ago, must be under ${RIG_FRESH_MS / 1000} s)`);
  }
  return reasons;
}

export function sceneRunBlocker(sceneId: string, scene: { verified: boolean } | null | undefined): string | null {
  if (!scene) return `scene "${sceneId}" is not registered in Atlas`;
  if (!scene.verified) return `scene "${sceneId}" is UNVERIFIED (unverified scenes cannot produce test evidence)`;
  return null;
}

// ------------------------------------------------------------------------------------------------
// Mutation arguments / results
// ------------------------------------------------------------------------------------------------

export type GenerateArgs = { specText: string; sceneId: string };
export type RunExampleArgs = { exampleId: string };
export type InjectFaultArgs = { projectId: string; faultId?: string };
export type ChangeSpecArgs = { projectId: string; specText: string };
export type JobCreated = { jobId: string };
export type ExampleCreated = JobCreated & { exampleId: string; specText: string; sceneId: string };

export const SPEC_MIN_CHARS = 20;
export const SPEC_MAX_CHARS = 8000;
