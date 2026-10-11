// Durable stage runner: every pipeline stage persists its output in Atlas before it is marked done.
// On resume, a stage whose stored input hash matches is skipped and its stored output is reused,
// so a restarted worker continues from the last checkpoint instead of starting over — and a spec change
// re-runs exactly the stages whose inputs changed.
import { createHash } from "node:crypto";
import type { PipelineStage } from "@mongomation/types";
import { col } from "../db/index.ts";

export const hashOf = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 32);

/** Upstream stages per stage: the dependency graph shown on the dashboard and stored with each stage. */
export const DEPENDS_ON: Record<PipelineStage, PipelineStage[]> = {
  requirements: [],
  io_design: ["requirements"],
  state_machine: ["io_design"],
  plc_code: ["io_design", "state_machine"],
  preflight: ["plc_code"],
  compile: ["preflight"],
  deploy: ["compile"],
  simulate: ["deploy"],
  tests: ["simulate"],
  diagnosis: ["tests"],
  repair: ["diagnosis"],
  verification: ["tests"],
  deliver: ["verification"],
};

export interface StageContext {
  projectId: string;
  jobId: string;
  /** Spec revision: a mid-project spec change starts a new revision; earlier revisions' checkpoints are kept. */
  revision: number;
  log: (msg: string, data?: Record<string, unknown>) => Promise<void>;
}

export async function event(projectId: string, jobId: string, stage: string | null, level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) {
  await col.events().insertOne({ projectId, jobId, stage, level, message, data, ts: new Date() });
}

/**
 * Runs `fn` once per (project, stage, attempt, input). Output must be JSON-serializable (store large
 * artifacts in their own collections and return their ids).
 */
export async function runStage<T>(ctx: StageContext, stage: PipelineStage, attempt: number, input: unknown, fn: () => Promise<T>): Promise<T> {
  const inputHash = hashOf(input);
  const key = { projectId: ctx.projectId, revision: ctx.revision, stage, attempt };
  const prior = await col.stages().findOne(key);
  if (prior?.status === "done" && prior.inputHash === inputHash) {
    await event(ctx.projectId, ctx.jobId, stage, "info", `${stage}#${attempt}: reused checkpoint from Atlas`, { stageId: String(prior._id) });
    return prior.output as T;
  }
  await col.stages().updateOne(
    key,
    {
      $set: { status: "running", inputHash, jobId: ctx.jobId, startedAt: new Date(), dependsOn: DEPENDS_ON[stage] },
      $unset: { error: "", output: "", finishedAt: "" },
      $inc: { runs: 1 },
    },
    { upsert: true },
  );
  await event(ctx.projectId, ctx.jobId, stage, "info", `${stage}#${attempt}: started`);
  try {
    const output = await fn();
    await col.stages().updateOne(key, { $set: { status: "done", output, finishedAt: new Date() } });
    await event(ctx.projectId, ctx.jobId, stage, "info", `${stage}#${attempt}: done`);
    return output;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const blocked = err instanceof BlockedError;
    await col.stages().updateOne(key, { $set: { status: blocked ? "blocked" : "failed", error: message, finishedAt: new Date() } });
    await event(ctx.projectId, ctx.jobId, stage, "error", `${stage}#${attempt}: ${blocked ? "BLOCKED" : "failed"}: ${message}`);
    throw err;
  }
}

/** Output of a completed stage with the same input, or null (used to skip rig work whose evidence already exists). */
export async function completedStage<T>(ctx: StageContext, stage: PipelineStage, attempt: number, input: unknown): Promise<T | null> {
  const prior = await col.stages().findOne({ projectId: ctx.projectId, revision: ctx.revision, stage, attempt });
  return prior?.status === "done" && prior.inputHash === hashOf(input) ? (prior.output as T) : null;
}

/** Process-unique id: rig side effects (compile/deploy) are re-done after a restart, because the runtime may hold
 *  a different program now; completed simulation evidence is still reused. */
export const BOOT_ID = `${process.pid}-${Date.now()}`;

/** A dependency is unavailable (rig disconnected, scene unverified, key missing). Shown as BLOCKED, never retried silently. */
export class BlockedError extends Error {}
