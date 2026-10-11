// Mine real repairs that fixed failing tests into lessons (same path as the LESSON_WRITER change stream).
//   npm run lessons:backfill                      runs since 24 h ago
//   npm run lessons:backfill -- --since 2026-10-11T00:00:00Z
//   npm run lessons:backfill -- --dry-run         show which runs qualify and the evidence; no LLM call, no writes
//   npm run lessons:backfill -- --project <id>    one project only
import { client, col, connect } from "../apps/worker/src/db/index.ts";
import { consolidate, lessonPrompt, lessonText, normalizeTrigger, ORIGIN, processSimRun, repairEvidence, type WriteOutcome } from "../apps/worker/src/harness/lessonwriter.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const dry = process.argv.includes("--dry-run");
const since = arg("--since") ? new Date(arg("--since")!) : new Date(Date.now() - 24 * 3600_000);
const project = arg("--project");

await connect();
try {
  // --rebuild: append-only re-mine. Earlier lesson-writer docs are kept on record (status "superseded", out of
  // retrieval, origin renamed) and today's repairs are mined again with the current prompt and dedupe.
  if (process.argv.includes("--rebuild") && !dry) {
    const r = await col.lessons().updateMany({ origin: ORIGIN }, { $set: { origin: `${ORIGIN}-superseded`, status: "superseded", active: false, verified: false, supersededAt: new Date() } });
    console.log(`rebuild: ${r.modifiedCount} earlier lesson-writer lesson(s) marked superseded (kept, not retrieved)`);
  }
  const runs = await col
    .simRuns()
    .find({ status: "done", split: { $ne: "heldout" }, startedAt: { $gte: since }, ...(project && { projectId: project }) }, { projection: { _id: 1, projectId: 1 }, sort: { startedAt: 1 } })
    .toArray();
  console.log(`lessons:backfill: ${runs.length} finished run(s) since ${since.toISOString()}${dry ? " (dry run)" : ""}`);
  const outcomes: WriteOutcome[] = [];
  for (const r of runs) {
    const id = String(r._id);
    if (dry) {
      const { ev, skip } = await repairEvidence(id);
      if (ev) console.log(`\n--- run ${id} (project ${ev.projectId}, ${ev.rigVerified ? "rig-verified" : "candidate"})\n${lessonPrompt(ev)}`);
      else if (process.argv.includes("--verbose")) console.log(`skip ${id}: ${skip}`);
      continue;
    }
    try {
      const o = await processSimRun(id, () => {});
      outcomes.push(o);
      if (o.action !== "skipped") console.log(`${o.action.toUpperCase()} [${o.status}] project ${r.projectId} run ${id}\n   ${o.text}${o.reason ? `  (${o.reason})` : ""}`);
      else if (o.reason?.startsWith("isolation")) console.log(`DROPPED run ${id}: ${o.reason}`);
    } catch (err) {
      console.error(`run ${id}: ${(err as Error).message}`);
    }
  }
  if (!dry) {
    // Older lesson-writer docs may carry a leading "when" (codegen renders "When <pattern>: <fix>").
    for (const l of await col.lessons().find({ origin: ORIGIN, pattern: /^when\s/i }).toArray()) {
      const pattern = normalizeTrigger(String(l.pattern));
      await col.lessons().updateOne({ _id: l._id }, { $set: { pattern, trigger: pattern, text: lessonText({ trigger: pattern, rule: String(l.fix) }) } });
    }
    const folded = await consolidate((m) => console.log(m));
    if (folded) console.log(`consolidated ${folded} duplicate lesson(s) into earlier ones (status "merged", support added)`);
    const n =(a: WriteOutcome["action"]) => outcomes.filter((o) => o.action === a).length;
    const byStatus = await col.lessons().aggregate([{ $match: { origin: ORIGIN } }, { $group: { _id: "$status", n: { $sum: 1 }, support: { $sum: "$support" } } }]).toArray();
    console.log(`\nthis run: inserted ${n("inserted")}, merged ${n("merged")}, skipped ${n("skipped")}`);
    console.log(`lesson-writer lessons in Atlas: ${byStatus.map((b) => `${b._id}=${b.n} (support ${b.support})`).join(", ") || "none"}; all lessons: ${await col.lessons().countDocuments()}`);
  }
} finally {
  await client.close();
}
