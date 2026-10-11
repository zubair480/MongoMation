// Enqueues the same job the dashboard's "Run Example" button does, then follows its events until it ends.
//   npm run example -- [--example sorting|two-conveyors] [--memory | --no-memory] [--recall | --no-recall]
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { client, col, connect } from "../apps/worker/src/db/index.ts";
import { enqueue } from "../apps/worker/src/harness/jobs.ts";

const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const examples = JSON.parse(readFileSync(new URL("../specs/examples.json", import.meta.url), "utf8")).examples as { id: string; sceneId: string; text: string }[];
const ex = examples.find((e) => e.id === (arg("--example") ?? "sorting"));
if (!ex) throw new Error(`unknown example; choose one of ${examples.map((e) => e.id).join(", ")}`);

await connect();
const scene = await col.scenes().findOne({ id: ex.sceneId });
if (!scene?.verified) {
  console.error(`BLOCKED: scene ${ex.sceneId} is ${scene ? "not verified on the live rig" : "not registered"} — see docs/INTEGRATION_CONTRACT.md`);
  await client.close();
  process.exit(2);
}
console.log(`spec (${ex.id}):\n${ex.text}\n`);
// --memory / --no-memory: Verified Program Memory for codegen (job option; omitted -> worker MEMORY_PROGRAMS env).
const memory = process.argv.includes("--memory") ? true : process.argv.includes("--no-memory") ? false : undefined;
// --recall / --no-recall (aliases --fastpath / --no-fastpath): experience recall (job option; omitted -> on whenever
// program memory is on, so --no-memory alone gives a fully cold run). RECALL_TRUST=1 on the WORKER enables trusted reuse.
const has = (...f: string[]) => f.some((x) => process.argv.includes(x));
const recall = has("--recall", "--fastpath") ? true : has("--no-recall", "--no-fastpath") ? false : undefined;
const jobId = await enqueue({ type: "engineer", specText: ex.text, sceneId: ex.sceneId, origin: "example" }, { ...(memory !== undefined && { memory }), ...(recall !== undefined && { recall }) });
if (memory !== undefined) console.log(`program memory: ${memory ? "WARM (verified reference programs on)" : "COLD (off)"}`);
if (recall !== undefined) console.log(`experience recall: ${recall ? "ON (reuse rig-verified programs with identical requirements)" : "OFF"}`);
console.log(`job ${jobId} queued — the worker on AWS picks it up`);
let seen = new Date(0);
for (;;) {
  const job = await col.jobs().findOne({ _id: jobId });
  if (job?.projectId) {
    const events = await col.events().find({ projectId: job.projectId, ts: { $gt: seen } }, { sort: { ts: 1 } }).toArray();
    for (const e of events) console.log(`${e.ts.toISOString().slice(11, 19)} [${e.stage ?? "-"}] ${e.message}`);
    if (events.length) seen = events.at(-1)!.ts;
  }
  if (job && ["completed", "failed", "blocked"].includes(job.status)) {
    console.log(`\njob ${job.status}${job.error ? `: ${job.error}` : ""}`);
    console.log(JSON.stringify(job.result ?? {}, null, 2));
    break;
  }
  await sleep(1500);
}
await client.close();
