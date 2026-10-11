// Real-time plumbing for the dashboard: ONE MongoDB change stream on the Atlas database the worker writes
// to, shared by every Modelence live-query subscription in this process (Modelence calls `watch` once per
// client subscription, so a stream per subscriber would exhaust the pool with a handful of viewers).
//
//   worker insert/update ──► Atlas change stream ──► hub ──► invalidate shared read cache
//                                                         ├─► LiveData.publish() of matching subscriptions
//                                                         └─► ServerChannel `mm-events` (new worker events)
//
// `measurements` is a time-series collection and cannot be watched; the analytics query listens to the
// `test_results` / `sim_runs` writes that accompany every batch of samples instead.
import { LiveData, ServerChannel } from 'modelence/server';
import { captureError, logInfo } from 'modelence/telemetry';
import type { ChangeStream, ChangeStreamDocument, Document } from 'mongodb';
import { EVENTS_CHANNEL, type LiveEventMessage } from '@/shared/insights';
import { errorMessage, getAtlasDb } from './atlas';
import { invalidate } from './cache';
import { str, toEvent } from './docs';

export const WATCHED_COLLECTIONS = [
  'jobs',
  'workers',
  'rig_status',
  'projects',
  'stages',
  'events',
  'requirements',
  'plc_versions',
  'compile_results',
  'sim_runs',
  'test_results',
  'fault_injections',
  'diagnoses',
  'scenes',
  'harness_versions',
  'rsi_proposals',
  'benchmark_runs',
] as const;
export type WatchedCollection = (typeof WATCHED_COLLECTIONS)[number];

export interface LiveChange {
  coll: string;
  op: string;
  /** projectId / simRunId of the written document when the change carries it (inserts, replaces). */
  projectId?: string;
  simRunId?: string;
}

type Listener = (change: LiveChange | null) => void;

/** Public worker event stream. Anyone may watch (the dashboard is public read-only). */
export const eventsChannel = new ServerChannel<LiveEventMessage>(EVENTS_CHANNEL);

const listeners = new Set<Listener>();
let stream: ChangeStream | null = null;
let starting = false;
let resumeToken: unknown = undefined;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelayMs = 1000;
let lastError: string | null = null;
let changesSeen = 0;

export function liveStatus() {
  return { streaming: !!stream, subscribers: listeners.size, changesSeen, lastError };
}

function notify(change: LiveChange | null) {
  // Every read the dashboard shares between viewers (cache.ts) may now be stale.
  invalidate();
  for (const l of [...listeners]) {
    try {
      l(change);
    } catch (err) {
      captureError(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

// Hidden test ids of a project, so pushed events are scrubbed exactly like the project query scrubs them.
const hiddenIdsCache = new Map<string, { at: number; ids: string[] }>();
async function hiddenIdsFor(projectId: string): Promise<string[]> {
  const hit = hiddenIdsCache.get(projectId);
  if (hit && Date.now() - hit.at < 5000) return hit.ids;
  const db = await getAtlasDb();
  const raw = await db
    .collection('test_results')
    .distinct('testId', { projectId, visibility: { $ne: 'public' }, superseded: { $ne: true } });
  const ids = raw.map((v) => str(v)).filter((v): v is string => !!v);
  hiddenIdsCache.set(projectId, { at: Date.now(), ids });
  if (hiddenIdsCache.size > 200) hiddenIdsCache.delete(hiddenIdsCache.keys().next().value as string);
  return ids;
}

async function pushEvent(doc: Document) {
  const projectId = str(doc.projectId);
  if (!projectId) return;
  const hidden = await hiddenIdsFor(projectId).catch(() => []);
  eventsChannel.broadcast(projectId, { projectId, event: toEvent(doc, hidden) });
}

function scheduleRetry() {
  if (retryTimer || listeners.size === 0) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void ensureStream();
  }, retryDelayMs);
  retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
}

async function ensureStream(): Promise<void> {
  if (stream || starting || listeners.size === 0) return;
  starting = true;
  try {
    const db = await getAtlasDb();
    const pipeline: Document[] = [
      {
        $match: {
          'ns.coll': { $in: [...WATCHED_COLLECTIONS] },
          operationType: { $in: ['insert', 'update', 'replace', 'delete'] },
        },
      },
      // Keep events small: drop the bulky fields; the fetch re-reads what it needs.
      {
        $project: {
          'fullDocument.data': 0,
          'fullDocument.output': 0,
          'fullDocument.steps': 0,
          'fullDocument.stepLogs': 0,
          'fullDocument.source': 0,
          'fullDocument.diffFromPrevious': 0,
          'fullDocument.rules': 0,
          updateDescription: 0,
        },
      },
    ];
    const cs = db.watch(pipeline, resumeToken ? { resumeAfter: resumeToken } : {});
    stream = cs;
    lastError = null;
    retryDelayMs = 1000;
    logInfo('mongomation live: change stream opened', { collections: WATCHED_COLLECTIONS.length });
    cs.on('change', (ev: ChangeStreamDocument) => {
      resumeToken = ev._id;
      changesSeen++;
      const coll = 'ns' in ev && ev.ns && 'coll' in ev.ns ? String(ev.ns.coll) : '';
      const full = 'fullDocument' in ev ? (ev.fullDocument as Document | undefined) : undefined;
      const change: LiveChange = {
        coll,
        op: ev.operationType,
        projectId: str(full?.projectId),
        simRunId: str(full?.simRunId),
      };
      if (coll === 'events' && ev.operationType === 'insert' && full) void pushEvent(full).catch(() => undefined);
      notify(change);
    });
    cs.on('error', (err) => {
      lastError = errorMessage(err);
      captureError(err instanceof Error ? err : new Error(String(err)));
      if (stream === cs) stream = null;
      void cs.close().catch(() => undefined);
      // A resume token can expire (oplog rolled over); start fresh rather than failing forever.
      if (/resume|ChangeStreamHistoryLost/i.test(lastError)) resumeToken = undefined;
      notify(null);
      scheduleRetry();
    });
  } catch (err) {
    // Atlas not configured / unreachable: subscribers refetch (and render DISCONNECTED), we retry.
    lastError = errorMessage(err);
    notify(null);
    scheduleRetry();
  } finally {
    starting = false;
  }
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  void ensureStream();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      const cs = stream;
      stream = null;
      void cs?.close().catch(() => undefined);
    }
  };
}

export interface LiveOptions {
  /** Which changes concern this subscription. Change-less wake-ups (stream errors) always publish. */
  match: (change: LiveChange) => boolean;
  /** Trailing throttle, so a burst of worker writes becomes one refetch. */
  throttleMs?: number;
  /** Re-publish this often even without changes (re-anchors server-computed ages). 0 disables. */
  heartbeatMs?: number;
}

/** A Modelence LiveData whose `publish` is driven by the shared Atlas change stream. */
export function liveFromAtlas<T>(fetch: () => Promise<T>, { match, throttleMs = 400, heartbeatMs = 20_000 }: LiveOptions) {
  return new LiveData<T>({
    fetch,
    watch: ({ publish }) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const fire = () => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          publish();
        }, throttleMs);
      };
      const unsubscribe = subscribe((change) => {
        if (!change || match(change)) fire();
      });
      const beat = heartbeatMs > 0 ? setInterval(publish, heartbeatMs) : null;
      return () => {
        unsubscribe();
        if (timer) clearTimeout(timer);
        if (beat) clearInterval(beat);
      };
    },
  });
}

/** Matcher helpers. */
export const inCollections =
  (...colls: WatchedCollection[]) =>
  (c: LiveChange) =>
    (colls as string[]).includes(c.coll);

/** A change to `colls` that belongs to `projectId`, or whose project is unknown (updates, deletes). */
export const forProject =
  (projectId: string, ...colls: WatchedCollection[]) =>
  (c: LiveChange) =>
    (colls as string[]).includes(c.coll) && (!c.projectId || c.projectId === projectId);
