// Atlas Function for the scheduled trigger `requeue-stale-jobs` (trigger.json). Server-side twin of
// apps/worker/src/harness/jobs.ts recoverStale(): a job whose worker stopped heartbeating is put back to "queued"
// even when NO worker is alive to run recoverStale() itself. Same compare-and-set guard (heartbeatAt + claimedBy),
// so it can never steal a job from a live worker or race a worker doing the same recovery.
exports = async function () {
  const STALE_MS = 15000;
  const jobs = context.services.get("mongodb-atlas").db("mongomation").collection("jobs");
  const stale = new Date(Date.now() - STALE_MS);
  const running = await jobs
    .find({ status: { $in: ["running", "verifying"] }, heartbeatAt: { $lt: stale }, type: { $ne: "worker_command" } })
    .toArray();
  let n = 0;
  for (const j of running) {
    const r = await jobs.updateOne(
      { _id: j._id, heartbeatAt: j.heartbeatAt, claimedBy: j.claimedBy },
      { $set: { status: "queued", resumedFrom: j.claimedBy, interruptedAt: new Date(), recoveredBy: "atlas-trigger" }, $unset: { claimedBy: "" } },
    );
    n += r.modifiedCount;
  }
  return { requeued: n };
};
