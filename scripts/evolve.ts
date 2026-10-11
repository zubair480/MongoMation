// Recursive-harnessing round(s): evidence → meta-agent → guardrails → candidate → benchmark job → gate.
//   npm run evolve                       one evolve job (the worker runs it; candidates queue a benchmark job)
//   npm run evolve -- --benchmark-only   score the current harness on the frozen train cases (baseline rows)
//   npm run ablation                     held-out cases: bare one-shot vs v0 vs current vN (same model)
// Optional, explicit limits for time-boxed runs (stored on the job and on every benchmark_runs row; the frozen
// specs/benchmark.json and its hash are never touched):
//   --limit N               only the FIRST N cases of the split, in benchmark.json order (env BENCH_LIMIT)
//   --max-repairs N         cap repair rounds per case at min(harness budget, N), same for every condition (env BENCH_MAX_REPAIRS)
//   --evidence-since X      evolve: only failures recorded at/after X (ISO time, or a job id = that job's createdAt)
// An evolve job passes --limit/--max-repairs on to the gate benchmark job it queues.
import { setTimeout as sleep } from "node:timers/promises";
import { ObjectId } from "mongodb";
import { client, col, connect } from "../apps/worker/src/db/index.ts";
import { enqueue } from "../apps/worker/src/harness/jobs.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const intArg = (name: string, env: string, min: number) => {
  const raw = arg(name) ?? process.env[env];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min} (got "${raw}")`);
  return n;
};

await connect();
const type = process.argv.includes("--ablation") ? "ablation" : process.argv.includes("--benchmark-only") ? "benchmark" : "evolve";
const caseLimit = intArg("--limit", "BENCH_LIMIT", 1);
const maxRepairs = intArg("--max-repairs", "BENCH_MAX_REPAIRS", 0);
let evidenceSince: Date | undefined;
const sinceRaw = arg("--evidence-since");
if (sinceRaw) {
  if (/^[a-f0-9]{24}$/.test(sinceRaw)) {
    const ref = await col.jobs().findOne({ _id: new ObjectId(sinceRaw) }, { projection: { createdAt: 1 } });
    if (!ref) throw new Error(`--evidence-since: job ${sinceRaw} not found`);
    evidenceSince = ref.createdAt as Date;
  } else {
    evidenceSince = new Date(sinceRaw);
    if (Number.isNaN(evidenceSince.getTime())) throw new Error(`--evidence-since: not a time or job id: ${sinceRaw}`);
  }
}
const extra = { ...(caseLimit && { caseLimit }), ...(maxRepairs !== undefined && { maxRepairs }), ...(evidenceSince && type === "evolve" && { evidenceSince }) };
const jobId = await enqueue({ type, origin: "script" }, extra);
console.log(`${type} job ${jobId} queued${Object.keys(extra).length ? ` with limits ${JSON.stringify(extra)}` : ""}`);
for (;;) {
  const job = await col.jobs().findOne({ _id: jobId });
  if (job && ["completed", "failed", "blocked"].includes(job.status)) {
    console.log(`job ${job.status}${job.error ? `: ${job.error}` : ""}`);
    console.log(JSON.stringify(job.result ?? {}, null, 2));
    break;
  }
  await sleep(3000);
}
const latest = await col.proposals().findOne({}, { sort: { createdAt: -1 } });
if (latest) console.log(`latest proposal: ${String(latest.verdict).toUpperCase()} — ${latest.rationale}\n${(latest.diff ?? []).join("\n")}`);
await client.close();
