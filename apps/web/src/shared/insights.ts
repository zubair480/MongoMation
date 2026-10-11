// Contract for the dashboard's Modelence-native extras: live measurement analytics (Atlas window functions),
// ops alerts and digests written by Modelence cron jobs, operator notes (a Modelence Store), the optional
// "explain this failure" helper (@modelence/ai) and the live worker event stream (a Modelence channel).
// Pure TypeScript, imported by both the server module and the React client.
import type { EventLite } from './mongomation';

/** Name of the Modelence ServerChannel / ClientChannel that pushes worker events; channel id = projectId. */
export const EVENTS_CHANNEL = 'mm-events';

// ---- measurement analytics ($setWindowFields / $densify / $fill / $percentile on `measurements`) --------

/** One second of a sim run's public-test samples, gap-filled with $densify so idle seconds read as 0. */
export interface AnalyticsSecond {
  ts: Date;
  samples: number;
  /** $avg over a 5 s range window. */
  avg5s: number;
  /** Running total ($sum over [unbounded, current]). */
  cumulative: number;
  /** Largest gap between two consecutive samples that ended in this second (ms). */
  maxGapMs?: number;
}

export interface AnalyticsTest {
  testId: string;
  samples: number;
  durationMs: number;
  /** samples / duration. */
  rateHz?: number;
  p50GapMs?: number;
  p95GapMs?: number;
  maxGapMs?: number;
  verdict?: string;
}

export interface AnalyticsTag {
  tag: string;
  /** Number of value changes ($shift over the previous sample of the same test). */
  transitions: number;
  perMinute?: number;
}

export interface RunTrendPoint {
  simRunId: string;
  startedAt?: Date;
  publicPassed: number;
  publicTotal: number;
  passRate?: number;
  /** $avg of passRate over the current and two previous runs. */
  rolling3?: number;
}

export interface AnalyticsData {
  simRunId: string | null;
  runStatus?: string;
  series: AnalyticsSecond[];
  tests: AnalyticsTest[];
  tags: AnalyticsTag[];
  /** Hidden tests are never analysed for the browser; only their number is reported. */
  hiddenTestsExcluded: number;
  totalSamples: number;
  trend: RunTrendPoint[];
  computedInMs: number;
}

// ---- ops (cron jobs) ---------------------------------------------------------------------------------

export type OpsSeverity = 'info' | 'warn' | 'critical';

export interface OpsAlertLite {
  id: string;
  kind: string;
  severity: OpsSeverity;
  message: string;
  subjectId?: string;
  openedAt: Date;
  lastSeenAt: Date;
  resolvedAt?: Date;
  acknowledgedBy?: string;
}

export interface OpsDigestLite {
  createdAt: Date;
  windowHours: number;
  jobs: { total: number; completed: number; failed: number; blocked: number; active: number; queued: number };
  tests: { total: number; passed: number; failed: number; blocked: number };
  samples: number;
  projects: number;
}

export interface OpsData {
  /** False when Modelence's own database is not configured (stores and cron jobs need it). */
  available: boolean;
  reason?: string;
  alerts: OpsAlertLite[];
  digest: OpsDigestLite | null;
  canAcknowledge: boolean;
  /** Cron jobs this server registers (alias, interval). */
  crons: { alias: string; description: string; intervalMs: number }[];
}

// ---- notes (Modelence Store) + AI explanations ---------------------------------------------------------

export interface NoteLite {
  id: string;
  projectId: string;
  kind: 'note' | 'ai';
  body: string;
  authorHandle: string;
  createdAt: Date;
  provider?: string;
  model?: string;
  mine: boolean;
}

export interface NotesData {
  available: boolean;
  reason?: string;
  items: NoteLite[];
  ai: { configured: boolean; provider: string; model: string };
  viewer: { signedIn: boolean; verified: boolean; roles: string[] };
}

export const NOTE_MAX_CHARS = 1000;

// ---- failure search (Atlas Search index `diagnoses_search`, lexical + autocomplete + facets) ------------

export interface FailureHit {
  id: string;
  summary: string;
  sceneId?: string;
  faultId?: string;
  projectId?: string;
  split?: string;
  createdAt?: Date;
  score: number;
  /** Highlight passages as [text, isHit] segments. */
  highlights: [string, boolean][][];
}

export interface FailureSearchData {
  query: string;
  tookMs: number;
  hits: FailureHit[];
}

export interface FailureSuggestData {
  suggestions: { id: string; summary: string }[];
}

export interface FacetBucket {
  value: string;
  count: number;
}

export interface FailureFacetsData {
  total: number;
  byScene: FacetBucket[];
  byFault: FacetBucket[];
  bySplit: FacetBucket[];
}

/** Pushed on EVENTS_CHANNEL for every event the worker inserts (hidden test ids already scrubbed). */
export interface LiveEventMessage {
  projectId: string;
  event: EventLite;
}
