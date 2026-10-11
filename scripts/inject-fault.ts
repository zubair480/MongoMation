// Same job as the "Inject Fault & Improve Harness" button, for the latest (or given) project.
//   npm run fault -- [--project <id>] [--fault <faultId>]
import { setTimeout as sleep } from "node:timers/promises";
import { client, col, connect } from "../apps/worker/src/db/index.ts";
import { enqueue } from "../apps/worker/src/harness/jobs.ts";

const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : undefined;
};
await connect();
const project = arg("--project")
  ? await col.projects().findOne({ _id: arg("--project") as never })
  : await col.projects().findOne({ finalPlcVersionId: { $ne: null }, origin: { $ne: "benchmark" } }, { sort: { createdAt: -1 } });
if (!project?.finalPlcVersionId) {
  console.error("BLOCKED: no engineered project with a deployed program yet (run `npm run example` first)");
  process.exit(2);
}
// Optional explicit limits for the evolve round this job runs (same meaning as scripts/evolve.ts):
//   --limit N, --max-repairs N  passed on to the gate benchmark; --evidence-since-job  only failures recorded from
//   this fault job on are given to the meta-agent (earlier failures, e.g. from since-fixed harness bugs, are ignored).
const int = (v?: string) => (v !== undefined && Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);
const limits = {
  ...(int(arg("--limit")) && { caseLimit: int(arg("--limit")) }),
  ...(int(arg("--max-repairs")) !== undefined && { maxRepairs: int(arg("--max-repairs")) }),
  ...(process.argv.includes("--evidence-since-job") && { evidenceSince: new Date() }),
};
const jobId = await enqueue({ type: "fault_and_improve", projectId: String(project._id), faultId: arg("--fault"), origin: "script" }, limits);
console.log(`fault job ${jobId} queued for project ${project._id}${Object.keys(limits).length ? ` with limits ${JSON.stringify(limits)}` : ""}`);
for (;;) {
  const job = await col.jobs().findOne({ _id: jobId });
  if (job && ["completed", "failed", "blocked"].includes(job.status)) {
    console.log(`job ${job.status}${job.error ? `: ${job.error}` : ""}`);
    console.log(JSON.stringify(job.result ?? {}, null, 2));
    break;
  }
  await sleep(2000);
}
await client.close();
