// explain() of the hot queue queries against live Atlas: proves each one is served by an index (IXSCAN), not a
// collection scan. Used by setup:atlas; also runnable alone:
//   tsx --env-file=.env scripts/atlas-explain.ts
import type { Db, Document } from "mongodb";

/** The queries the worker loop and dashboard run every second or so (harness/jobs.ts, web mutations). */
export const QUEUE_QUERIES: { name: string; filter: Document; sort?: Document }[] = [
  { name: "claimNext", filter: { status: "queued", type: { $ne: "worker_command" } }, sort: { createdAt: 1 } },
  { name: "recoverStale", filter: { status: { $in: ["running", "verifying"] }, heartbeatAt: { $lt: new Date(Date.now() - 15_000) }, type: { $ne: "worker_command" } } },
  { name: "pendingCommand", filter: { type: "worker_command", status: "queued", command: "interrupt" } },
  { name: "dashboardQueuedPerType", filter: { type: "engineer", status: "queued" } },
];

function findStage(plan: Document | undefined, pred: (p: Document) => boolean): Document | undefined {
  if (!plan) return undefined;
  if (pred(plan)) return plan;
  for (const k of ["inputStage", "queryPlan"]) {
    const hit = findStage(plan[k], pred);
    if (hit) return hit;
  }
  for (const child of (plan.inputStages as Document[] | undefined) ?? []) {
    const hit = findStage(child, pred);
    if (hit) return hit;
  }
  return undefined;
}

export async function explainQueueQueries(db: Db) {
  const out: { name: string; stage: string; index: string | null; keysExamined: number; docsExamined: number; returned: number }[] = [];
  for (const q of QUEUE_QUERIES) {
    const ex = await db.collection("jobs").find(q.filter, { sort: q.sort, limit: 1 }).explain("executionStats");
    const winning = (ex.queryPlanner?.winningPlan ?? {}) as Document;
    const ix = findStage(winning, (p) => p.stage === "IXSCAN");
    const coll = findStage(winning, (p) => p.stage === "COLLSCAN");
    out.push({
      name: q.name,
      stage: ix ? "IXSCAN" : coll ? "COLLSCAN" : String(winning.stage ?? "?"),
      index: (ix?.indexName as string | undefined) ?? null,
      keysExamined: ex.executionStats?.totalKeysExamined ?? -1,
      docsExamined: ex.executionStats?.totalDocsExamined ?? -1,
      returned: ex.executionStats?.nReturned ?? -1,
    });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { client, connect, db } = await import("../apps/worker/src/db/index.ts");
  await connect();
  for (const e of await explainQueueQueries(db)) console.log(JSON.stringify(e));
  await client.close();
}
