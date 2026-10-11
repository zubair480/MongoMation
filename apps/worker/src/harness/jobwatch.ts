// MongoDB change stream on `jobs`: wakes the idle worker the moment the dashboard enqueues a job or an
// "Interrupt Worker" command, instead of waiting for the next poll. Polling stays as the safety net: every wait
// below still times out on its own, so a broken stream only costs latency, never correctness. The resume token is
// persisted in `change_stream_tokens`, so a restarted worker replays the inserts it missed while it was down.
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { MongoServerError, type ChangeStream, type ChangeStreamOptions, type Collection, type Document, type ResumeToken } from "mongodb";
import { col } from "../db/index.ts";

/** A wait that ends after `ms` or as soon as `fire()` is called, whichever is first. */
export class Wakeup {
  private waiters = new Set<() => void>();
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }
  fire() {
    for (const done of [...this.waiters]) done();
  }
}

export const jobArrived = new Wakeup();
export const commandArrived = new Wakeup();

// Inserted jobs, and jobs put back to "queued" by stale-claim recovery on another worker.
const PIPELINE: Document[] = [
  {
    $match: {
      $or: [{ operationType: "insert" }, { operationType: "update", "updateDescription.updatedFields.status": "queued" }],
    },
  },
  { $project: { operationType: 1, "fullDocument.type": 1, "fullDocument.status": 1, "fullDocument.command": 1 } },
];

/** Resume token errors: the token fell off the oplog or is unusable -> start fresh (polling covers the gap). */
const tokenUnusable = (err: unknown) => err instanceof MongoServerError && (err.code === 286 || err.code === 280 || err.code === 260);

export function watchJobs(log: (m: string) => void) {
  const key = `jobs-wakeup:${process.env.WORKER_ID || hostname()}`;
  void (async () => {
    let backoff = 1_000;
    for (;;) {
      let stream: ChangeStream | undefined;
      try {
        const saved = await col.streamTokens().findOne({ _id: key as never });
        const resumeAfter = saved?.token as ResumeToken | undefined;
        stream = col.jobs().watch(PIPELINE, resumeAfter ? { resumeAfter } : {});
        log(`change stream on jobs open${resumeAfter ? " (resumed from saved token)" : ""}; polling stays as fallback`);
        for await (const ch of stream) {
          backoff = 1_000;
          const doc = (ch as { fullDocument?: { type?: string; status?: string; command?: string } }).fullDocument;
          if (doc?.type === "worker_command") commandArrived.fire();
          else jobArrived.fire();
          await col.streamTokens().updateOne({ _id: key as never }, { $set: { token: ch._id, at: new Date() } }, { upsert: true });
        }
      } catch (err) {
        if (tokenUnusable(err)) await col.streamTokens().updateOne({ _id: key as never }, { $unset: { token: "" } }).catch(() => {});
        log(`change stream: ${(err as Error).message} — polling continues, reopening in ${backoff / 1000}s`);
      } finally {
        await stream?.close().catch(() => {});
      }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  })();
}

// ---------------------------------------------------------------------------------------------------------------
// Audit streams. Both collections have changeStreamPreAndPostImages enabled (db/schema.ts), so each update event
// carries the document exactly as it was BEFORE and AFTER that write — not a later re-read. The $match runs on the
// server, so the worker only receives the events it audits.
// ---------------------------------------------------------------------------------------------------------------

type ChangeEvent = Document & { _id: ResumeToken; operationType: string; fullDocument?: Document; fullDocumentBeforeChange?: Document; documentKey?: { _id: unknown }; clusterTime?: unknown; updateDescription?: { updatedFields?: Document } };

/** A resumable change stream: persists its token per worker, reopens with backoff, never throws. */
export function durableWatch(key: string, coll: () => Collection, pipeline: Document[], options: ChangeStreamOptions, onChange: (ch: ChangeEvent) => Promise<void>, log: (m: string) => void) {
  const tokenKey = `${key}:${process.env.WORKER_ID || hostname()}`;
  let stopped = false;
  let current: ChangeStream | undefined;
  void (async () => {
    let backoff = 1_000;
    while (!stopped) {
      try {
        const saved = await col.streamTokens().findOne({ _id: tokenKey as never });
        const resumeAfter = saved?.token as ResumeToken | undefined;
        current = coll().watch(pipeline, resumeAfter ? { ...options, resumeAfter } : options);
        log(`change stream ${key} open${resumeAfter ? " (resumed)" : ""}`);
        for await (const ch of current) {
          backoff = 1_000;
          await onChange(ch as ChangeEvent);
          await col.streamTokens().updateOne({ _id: tokenKey as never }, { $set: { token: ch._id, at: new Date() } }, { upsert: true });
        }
      } catch (err) {
        if (stopped) break;
        if (tokenUnusable(err)) await col.streamTokens().updateOne({ _id: tokenKey as never }, { $unset: { token: "" } }).catch(() => {});
        log(`change stream ${key}: ${(err as Error).message} — reopening in ${backoff / 1000}s`);
      } finally {
        await current?.close().catch(() => {});
      }
      if (!stopped) await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  })();
  return async () => {
    stopped = true;
    await current?.close().catch(() => {});
  };
}

/** Only inserts and updates that touch `status`: the job lifecycle, nothing else (heartbeats are filtered out). */
export const TRANSITIONS_PIPELINE: Document[] = [
  { $match: { $or: [{ operationType: "insert" }, { operationType: "update", "updateDescription.updatedFields.status": { $exists: true } }] } },
  { $match: { "fullDocument.type": { $ne: "worker_command" } } },
];

/** Builds the job_transitions doc for one change event (exported for unit tests). */
export function transitionDoc(ch: ChangeEvent) {
  const after = ch.fullDocument ?? {};
  const before = ch.fullDocumentBeforeChange;
  return {
    _id: String((ch._id as { _data?: string })._data ?? JSON.stringify(ch._id)), // event id: idempotent across workers
    jobId: String(ch.documentKey?._id ?? after._id),
    type: after.type ?? null,
    from: ch.operationType === "insert" ? null : (before?.status ?? null),
    to: after.status ?? ch.updateDescription?.updatedFields?.status ?? null,
    by: after.claimedBy ?? null,
    attempts: after.attempts ?? null,
    error: typeof after.error === "string" ? after.error.slice(0, 300) : undefined,
    clusterTime: ch.clusterTime,
    at: new Date(),
  };
}

/** Job status transition audit -> `job_transitions` (TTL), e.g. queued -> running -> queued (recovered) -> completed. */
export function watchJobTransitions(log: (m: string) => void) {
  return durableWatch(
    "jobs-transitions",
    col.jobs,
    TRANSITIONS_PIPELINE,
    { fullDocument: "whenAvailable", fullDocumentBeforeChange: "whenAvailable" },
    async (ch) => {
      await col.jobTransitions().insertOne(transitionDoc(ch) as never).catch((err: unknown) => {
        if (!(err instanceof MongoServerError && err.code === 11000)) throw err; // another worker recorded it
      });
    },
    log,
  );
}

/**
 * Harness versions are immutable once decided (kept / rolled_back / rejected): only pending -> decided is legal.
 * The pre-image tells us the verdict BEFORE the write; any other update, replace or delete is written to
 * `audit_log` as an integrity alert the dashboard can surface.
 */
export function watchHarnessImmutability(log: (m: string) => void) {
  return durableWatch(
    "harness-immutability",
    col.harness,
    [{ $match: { operationType: { $in: ["update", "replace", "delete"] } } }],
    { fullDocumentBeforeChange: "whenAvailable" },
    async (ch) => {
      const before = ch.fullDocumentBeforeChange;
      if (ch.operationType === "update" && before?.verdict === "pending") return; // the one legal transition
      const doc = {
        _id: String((ch._id as { _data?: string })._data),
        kind: "harness_immutability_violation",
        op: ch.operationType,
        version: before?.version ?? null,
        verdictBefore: before?.verdict ?? null,
        updatedFields: ch.updateDescription?.updatedFields ? Object.keys(ch.updateDescription.updatedFields) : [],
        at: new Date(),
      };
      log(`AUDIT: harness v${doc.version} (${doc.verdictBefore}) was ${doc.op}d — immutable versions must not change`);
      await col.audit().insertOne(doc as never).catch((err: unknown) => {
        if (!(err instanceof MongoServerError && err.code === 11000)) throw err;
      });
    },
    log,
  );
}
