// Recursive-harnessing round(s): evidence → meta-agent → guardrails → candidate → benchmark job → gate.
//   npm run evolve                       one evolve job (the worker runs it; candidates queue a benchmark job)
//   npm run evolve -- --benchmark-only   score the current harness on the frozen train cases (baseline rows)
//   npm run ablation                     held-out cases: bare one-shot vs v0 vs current vN (same model)
import { setTimeout as sleep } from "node:timers/promises";
import { client, col, connect } from "../apps/worker/src/db/index.ts";
import { enqueue } from "../apps/worker/src/harness/jobs.ts";

await connect();
const type = process.argv.includes("--ablation") ? "ablation" : process.argv.includes("--benchmark-only") ? "benchmark" : "evolve";
const jobId = await enqueue({ type, origin: "script" });
console.log(`${type} job ${jobId} queued`);
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
