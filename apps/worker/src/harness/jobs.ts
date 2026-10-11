// Durable job queue in Atlas. The dashboard inserts {type, status:"queued"}; workers claim atomically,
// heartbeat while working, and a job whose worker died (stale heartbeat) is put back and resumed from its
// stage checkpoints (harness/stages.ts). Three rules make "kill it, restart it, nothing lost" true:
//   1. a stage's output is persisted before the stage is marked done;
//   2. side-effecting stages reconcile real rig state before acting again;
//   3. claims carry worker id + heartbeat, so recovery never steals a live job.
import { hostname } from "node:os";
import type { JobRequest, JobStatus } from "@mongomation/types";
import { ObjectId, type WithId, type Document } from "mongodb";
import { col } from "../db/index.ts";

export const HEARTBEAT_MS = 3_000;
export const STALE_MS = 15_000;
export const workerId = () => process.env.WORKER_ID || `worker-${hostname()}-${process.pid}`;

export interface JobDoc extends JobRequest {
  _id: ObjectId;
  status: JobStatus;
  createdAt: Date;
  claimedBy?: string;
  heartbeatAt?: Date;
  attempts: number;
  resumedFrom?: string; // worker id whose interrupted claim this job was recovered from
  projectId?: string;
  result?: Record<string, unknown>;
  error?: string;
}

export async function enqueue(req: JobRequest) {
  const doc = { ...req, status: "queued" as JobStatus, createdAt: new Date(), attempts: 0 };
  const res = await col.jobs().insertOne(doc);
  return res.insertedId;
}

/** Re-queues jobs whose worker stopped heartbeating. Returns how many were recovered. */
export async function recoverStale() {
  const stale = new Date(Date.now() - STALE_MS);
  const running = await col.jobs().find({ status: { $in: ["running", "verifying"] }, heartbeatAt: { $lt: stale }, type: { $ne: "worker_command" } }).toArray();
  let n = 0;
  for (const j of running) {
    const r = await col.jobs().updateOne(
      { _id: j._id, heartbeatAt: j.heartbeatAt, claimedBy: j.claimedBy },
      { $set: { status: "queued", resumedFrom: j.claimedBy, interruptedAt: new Date() }, $unset: { claimedBy: "" } },
    );
    n += r.modifiedCount;
  }
  return n;
}

export async function claimNext(): Promise<WithId<Document> | null> {
  return col.jobs().findOneAndUpdate(
    { status: "queued", type: { $ne: "worker_command" } },
    { $set: { status: "running", claimedBy: workerId(), heartbeatAt: new Date(), startedAt: new Date() }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, returnDocument: "after" },
  );
}

/** Worker liveness for the dashboard (also called while idle). */
export async function workerBeat(currentJobId: ObjectId | null) {
  await col.workers().updateOne(
    { _id: workerId() as unknown as ObjectId },
    { $set: { host: hostname(), pid: process.pid, heartbeatAt: new Date(), currentJobId } },
    { upsert: true },
  );
}

/** Returns false when the claim was lost (another worker recovered the job). */
export async function heartbeat(jobId: ObjectId) {
  const r = await col.jobs().updateOne({ _id: jobId, claimedBy: workerId() }, { $set: { heartbeatAt: new Date() } });
  await workerBeat(jobId);
  return r.matchedCount === 1;
}

export async function setStatus(jobId: ObjectId, status: JobStatus, extra: Record<string, unknown> = {}) {
  await col.jobs().updateOne({ _id: jobId, claimedBy: workerId() }, { $set: { status, ...extra, ...(isFinal(status) && { finishedAt: new Date() }) } });
}

const isFinal = (s: JobStatus) => s === "completed" || s === "failed" || s === "blocked";

/** Worker control commands written by the dashboard ("Interrupt Worker"). */
export async function pendingCommand(): Promise<"interrupt" | null> {
  const cmd = await col.jobs().findOneAndUpdate(
    { type: "worker_command" as never, status: "queued", command: "interrupt" },
    { $set: { status: "completed", handledBy: workerId(), finishedAt: new Date() } },
  );
  return cmd ? "interrupt" : null;
}
