// Live tag values sampled by a RUNNING sim run (read-only, polled by the HMI tab every ~400 ms).
//
// While a sim run samples, the worker's rig monitor pauses its own Factory I/O reads (worker harness/sampling.ts),
// so rig_status.tags freeze for the whole test phase. The test sampler meanwhile writes ~17 rows/s to the
// `measurements` time-series collection (ts, t, values {tag: value}, meta {simRunId, testId}). This query returns the
// newest of those rows for the project's running sim run, so the 3D twin keeps moving during tests.
//
// `measurements` is a time-series collection and cannot be watched by the change stream (live.ts), hence a poll.
// Hidden tests stay hidden: a row from a test known to be hidden is never returned, and no test id is ever sent.
import { z } from 'zod';
import type { Db } from 'mongodb';
import type { TagValue } from '@/shared/mongomation';
import { withAtlas } from './atlas';
import { cached } from './cache';
import { idFilter, str } from './docs';
import { parseArgs } from './errors';

const args = z.object({ projectId: z.string().trim().min(1).max(64) });

/** A row older than this is not "live" (crashed run left as running, or between tests). */
const LIVE_MAX_AGE_MS = 5000;

export interface SimLiveData {
  live: boolean;
  simRunId?: string;
  ts?: Date;
  /** Server-computed age of ts at query time (avoids browser clock skew). */
  ageMs?: number;
  values?: Record<string, TagValue>;
}

const hiddenCache = new Map<string, { at: number; ids: Set<string> }>();
async function hiddenTestIds(db: Db, projectId: string): Promise<Set<string>> {
  const hit = hiddenCache.get(projectId);
  if (hit && Date.now() - hit.at < 30_000) return hit.ids;
  const ids = new Set(
    (await db.collection('test_results').distinct('testId', { projectId: idFilter(projectId), visibility: { $ne: 'public' } })).map(String),
  );
  hiddenCache.set(projectId, { at: Date.now(), ids });
  return ids;
}

async function read(db: Db, projectId: string): Promise<SimLiveData> {
  const run = await db
    .collection('sim_runs')
    .findOne({ projectId: idFilter(projectId), status: 'running' }, { sort: { startedAt: -1 }, projection: { _id: 1 } });
  if (!run) return { live: false };
  const simRunId = String(run._id);
  const row = await db
    .collection('measurements')
    .findOne({ 'meta.simRunId': simRunId }, { sort: { ts: -1 }, projection: { _id: 0, ts: 1, values: 1, meta: 1 } });
  if (!row || !(row.ts instanceof Date)) return { live: false, simRunId };
  const ageMs = Math.max(0, Date.now() - row.ts.getTime());
  if (ageMs > LIVE_MAX_AGE_MS) return { live: false, simRunId, ageMs };
  const testId = str((row.meta as Record<string, unknown> | undefined)?.testId);
  if (testId && (await hiddenTestIds(db, projectId)).has(testId.replace(/~attempt\d+$/, ''))) return { live: false, simRunId };
  const values: Record<string, TagValue> = {};
  for (const [k, v] of Object.entries((row.values ?? {}) as Record<string, unknown>)) {
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) values[k] = v;
  }
  return { live: true, simRunId, ts: row.ts, ageMs, values };
}

export async function simLive(input: unknown) {
  const { projectId } = parseArgs(args, input);
  return cached(`simlive:${projectId}`, () => withAtlas<SimLiveData>((db) => read(db, projectId)), 250);
}