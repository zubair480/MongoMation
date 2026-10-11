// Modelence cron jobs (interval-scheduled, one instance runs them under a DB lock). They READ the worker's
// Atlas collections and WRITE only to app-owned Stores (stores.ts): alerts and digests. They never modify
// worker documents: the "nudge" for a stale job is an alert pushed live to every dashboard (and to
// telemetry), the worker's own STALE_MS reclaim does the actual recovery.
import { time } from 'modelence';
import type { CronJobInputParams } from 'modelence/server';
import { captureError, logInfo, logError, startTransaction } from 'modelence/telemetry';
import type { Db } from 'mongodb';
import { WORKER_STALE_MS } from '@/shared/mongomation';
import type { OpsSeverity } from '@/shared/insights';
import { errorMessage, getAtlasDb } from './atlas';
import { date, idOf, num, str } from './docs';
import { dbOpsAlerts, dbOpsDigests } from './stores';

type AlertKind = 'rig_stale' | 'job_stale' | 'worker_silent' | 'queue_backlog';

const RIG_STALE_MS = 60_000;
const RIG_CRITICAL_MS = 5 * 60_000;
const JOB_STALE_MS = 4 * WORKER_STALE_MS;
const BACKLOG_MS = 5 * 60_000;

async function openAlert(key: string, kind: AlertKind, severity: OpsSeverity, message: string, subjectId?: string) {
  const now = new Date();
  await dbOpsAlerts.upsertOne(
    { key, resolvedAt: { $exists: false } },
    {
      $set: { kind, severity, message, lastSeenAt: now, ...(subjectId ? { subjectId } : {}) },
      $setOnInsert: { key, openedAt: now },
    },
  );
}

async function resolveAlerts(filter: { key?: string | { $nin: string[] }; kind?: AlertKind }) {
  await dbOpsAlerts.updateMany({ ...filter, resolvedAt: { $exists: false } }, { $set: { resolvedAt: new Date() } });
}

/** Runs a cron body with a telemetry transaction; Atlas being down is logged, not thrown in a loop. */
function job(name: string, description: string, interval: number, body: (db: Db) => Promise<Record<string, unknown>>): CronJobInputParams {
  return {
    description,
    interval,
    timeout: Math.min(interval, time.minutes(2)),
    handler: async () => {
      const tx = startTransaction('cron', `mongomation.${name}`);
      try {
        const db = await getAtlasDb();
        const context = await body(db);
        tx.end('success', context);
      } catch (err) {
        logError(`mongomation cron ${name} failed`, { error: errorMessage(err) });
        captureError(err instanceof Error ? err : new Error(String(err)));
        tx.end('error', { error: errorMessage(err) });
      }
    },
  };
}

// ---- rig heartbeat staleness -----------------------------------------------------------------------

async function rigWatch(db: Db) {
  const rig = await db.collection('rig_status').find({}).sort({ checkedAt: -1 }).limit(1).next();
  const checkedAt = date(rig?.checkedAt);
  if (!rig || !checkedAt) return { rig: 'none' };
  const age = Date.now() - checkedAt.getTime();
  const rigId = str(rig.rigId) ?? idOf(rig._id);
  if (age > RIG_STALE_MS) {
    const severity: OpsSeverity = age > RIG_CRITICAL_MS ? 'critical' : 'warn';
    await openAlert(
      'rig_stale',
      'rig_stale',
      severity,
      `Rig ${rigId} has not reported for ${Math.round(age / 1000)} s (fault injection needs < 10 s)`,
      rigId,
    );
    return { rig: 'stale', ageMs: age };
  }
  await resolveAlerts({ key: 'rig_stale' });
  return { rig: 'fresh', ageMs: age };
}

// ---- stale jobs / silent worker / queue backlog ----------------------------------------------------

async function jobWatch(db: Db) {
  const now = Date.now();
  const jobs = db.collection('jobs');
  const [stale, workers, oldQueued] = await Promise.all([
    jobs
      .find(
        { status: { $in: ['running', 'verifying'] }, heartbeatAt: { $lt: new Date(now - JOB_STALE_MS) } },
        { projection: { type: 1, claimedBy: 1, heartbeatAt: 1 } },
      )
      .limit(20)
      .toArray(),
    db.collection('workers').find({}, { projection: { heartbeatAt: 1, workerId: 1 } }).sort({ heartbeatAt: -1 }).limit(1).toArray(),
    jobs.countDocuments({ status: 'queued', type: { $ne: 'worker_command' }, createdAt: { $lt: new Date(now - BACKLOG_MS) } }),
  ]);

  const staleKeys: string[] = [];
  for (const j of stale) {
    const id = idOf(j._id);
    const beat = date(j.heartbeatAt);
    const age = beat ? Math.round((now - beat.getTime()) / 1000) : undefined;
    const key = `job_stale:${id}`;
    staleKeys.push(key);
    await openAlert(
      key,
      'job_stale',
      'warn',
      `Job ${id} (${str(j.type) ?? 'job'}) claimed by ${str(j.claimedBy) ?? 'a worker'} has no heartbeat for ${age ?? '?'} s; the worker's stale reclaim should pick it up`,
      id,
    );
  }
  await resolveAlerts({ kind: 'job_stale', key: { $nin: staleKeys } });

  const workerBeat = date(workers[0]?.heartbeatAt);
  const workerAge = workerBeat ? now - workerBeat.getTime() : undefined;
  if (oldQueued > 0 && (workerAge === undefined || workerAge > JOB_STALE_MS)) {
    await openAlert(
      'worker_silent',
      'worker_silent',
      'critical',
      `${oldQueued} job(s) queued for over ${BACKLOG_MS / 60_000} min and no worker heartbeat${workerAge !== undefined ? ` for ${Math.round(workerAge / 1000)} s` : ''}`,
    );
  } else {
    await resolveAlerts({ key: 'worker_silent' });
  }
  if (oldQueued >= 3 && workerAge !== undefined && workerAge <= JOB_STALE_MS) {
    await openAlert('queue_backlog', 'queue_backlog', 'info', `${oldQueued} job(s) have waited over ${BACKLOG_MS / 60_000} min for the worker`);
  } else {
    await resolveAlerts({ key: 'queue_backlog' });
  }
  return { staleJobs: stale.length, oldQueued, workerAgeMs: workerAge };
}

// ---- periodic summary --------------------------------------------------------------------------------

const DIGEST_HOURS = 24;

async function opsDigest(db: Db) {
  const since = new Date(Date.now() - DIGEST_HOURS * 3600_000);
  const [jobCounts, testCounts, samples, projects] = await Promise.all([
    db
      .collection('jobs')
      .aggregate<{ _id: unknown; n: number }>([
        { $match: { createdAt: { $gte: since }, type: { $ne: 'worker_command' } } },
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ])
      .toArray(),
    db
      .collection('test_results')
      .aggregate<{ _id: unknown; n: number }>([
        { $match: { startedAt: { $gte: since }, superseded: { $ne: true } } },
        { $group: { _id: '$verdict', n: { $sum: 1 } } },
      ])
      .toArray(),
    db.collection('measurements').countDocuments({ ts: { $gte: since } }),
    db.collection('projects').countDocuments({ createdAt: { $gte: since } }),
  ]);
  const j = new Map(jobCounts.map((c) => [String(c._id), num(c.n) ?? 0]));
  const t = new Map(testCounts.map((c) => [String(c._id), num(c.n) ?? 0]));
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const digest = {
    createdAt: new Date(),
    windowHours: DIGEST_HOURS,
    jobs: {
      total: sum(j),
      completed: j.get('completed') ?? 0,
      failed: j.get('failed') ?? 0,
      blocked: j.get('blocked') ?? 0,
      active: (j.get('running') ?? 0) + (j.get('verifying') ?? 0),
      queued: j.get('queued') ?? 0,
    },
    tests: { total: sum(t), passed: t.get('passed') ?? 0, failed: t.get('failed') ?? 0, blocked: t.get('blocked') ?? 0 },
    samples,
    projects,
  };
  await dbOpsDigests.insertOne(digest);
  // Keep the last 200 digests.
  const old = await dbOpsDigests.fetch({}, { sort: { createdAt: -1 }, skip: 200, limit: 500, projection: { _id: 1 } });
  if (old.length) await dbOpsDigests.deleteMany({ _id: { $in: old.map((d) => d._id) } });
  logInfo('mongomation ops digest', { jobs: digest.jobs.total, tests: digest.tests.total, samples });
  return { jobs: digest.jobs.total, tests: digest.tests.total, samples };
}

export const cronJobs: Record<string, CronJobInputParams> = {
  rigWatch: job('rigWatch', 'Opens/resolves an alert when the rig heartbeat (rig_status) goes stale', time.seconds(30), rigWatch),
  jobWatch: job('jobWatch', 'Flags claimed jobs without heartbeat, a silent worker and queue backlog', time.minutes(1), jobWatch),
  opsDigest: job('opsDigest', 'Writes a 24 h summary of jobs, tests and samples', time.minutes(15), opsDigest),
};

export const cronList = Object.entries(cronJobs).map(([alias, c]) => ({
  alias: `mongomation.${alias}`,
  description: c.description ?? '',
  intervalMs: c.interval,
}));
