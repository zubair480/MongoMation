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
const jobId = await enqueue({ type: "fault_and_improve", projectId: String(project._id), faultId: arg("--fault"), origin: "script" });
console.log(`fault job ${jobId} queued for project ${project._id}`);
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
