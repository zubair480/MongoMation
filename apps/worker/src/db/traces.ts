// trace_refs: the join table between Atlas evidence and Raindrop traces. Every telemetry span that returns a real
// Raindrop event id is recorded here with the run it belongs to and the Atlas evidence ids it produced, so the
// dashboard (and the RSI loop) can go evidence id -> trace and run -> all traces with one indexed query.
// Best effort: a failed write is logged once and never breaks the pipeline. No-op until the worker is connected.
import { col, isConnected } from "./index.ts";

export interface TraceRef {
  runId: string;
  kind: "run" | "ai" | "tool";
  name: string;
  eventId: string;
  evidenceIds?: string[];
  ok?: boolean;
  at: Date;
}

let warned = false;

export function recordTraceRef(ref: Omit<TraceRef, "at">) {
  if (!ref.eventId || !isConnected()) return;
  void col
    .traces()
    .insertOne({ ...ref, evidenceIds: ref.evidenceIds ?? [], at: new Date() }, { writeConcern: { w: 1 } })
    .catch((err: unknown) => {
      if (!warned) console.warn(`trace_refs: write failed (${(err as Error).message}); continuing without`);
      warned = true;
    });
}

/** All traces linked to an evidence id (test result, compile result, measurement batch ...). */
export const tracesForEvidence = (evidenceId: string) => col.traces().find({ evidenceIds: evidenceId }, { sort: { at: 1 } }).toArray();
/** All traces of one run (project id / rsi-<job> / benchmark-<job>). */
export const tracesForRun = (runId: string) => col.traces().find({ runId }, { sort: { at: 1 } }).toArray();
