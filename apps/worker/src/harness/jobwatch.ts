// MongoDB change stream on `jobs`: wakes the idle worker the moment the dashboard enqueues a job or an
// "Interrupt Worker" command, instead of waiting for the next poll. Polling stays as the safety net: every wait
// below still times out on its own, so a broken stream only costs latency, never correctness. The resume token is
// persisted in `change_stream_tokens`, so a restarted worker replays the inserts it missed while it was down.
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { MongoServerError, type ChangeStream, type Document, type ResumeToken } from "mongodb";
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
