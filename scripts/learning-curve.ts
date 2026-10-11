// Learning curve (READ-ONLY): every run of one example spec, oldest first, with the Atlas ids that prove it.
//   npx tsx --env-file-if-exists=.env --env-file-if-exists=.env.rig scripts/learning-curve.ts [--spec sorting-plausibility-v2]
// Prints Markdown to stdout. Never writes to Atlas; never prints connection strings or keys.
import { readFileSync } from "node:fs";
import { client, col, connect } from "../apps/worker/src/db/index.ts";

const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const specId = arg("--spec") ?? "sorting-plausibility-v2";
const examples = JSON.parse(readFileSync(new URL("../specs/examples.json", import.meta.url), "utf8")).examples as { id: string; sceneId: string; text: string }[];
const ex = examples.find((e) => e.id === specId);
if (!ex) throw new Error(`unknown --spec ${specId}; choose one of ${examples.map((e) => e.id).join(", ")}`);

await connect();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = Record<string, any>;
const la = (d: unknown) =>
  d ? new Date(d as string).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "-";
const ms = (a: unknown, b: unknown) => (a && b ? new Date(b as string).getTime() - new Date(a as string).getTime() : 0);
const sec = (n: number | null | undefined) => (n == null || !Number.isFinite(n) || n <= 0 ? "-" : (n / 1000).toFixed(1));
const usd = (n: unknown) => (typeof n === "number" ? `$${n.toFixed(3)}` : "-");
const pct = (a: number, b: number) => (a > 0 ? `${b <= a ? "−" : "+"}${Math.abs(Math.round(((a - b) / a) * 100))}%` : "n/a");

const jobs = (await col.jobs().find({ type: "engineer", specText: ex.text }, { sort: { createdAt: 1 } }).toArray()) as Any[];

const rows: Any[] = [];
for (const j of jobs) {
  const pid = j.projectId ?? j.result?.projectId;
  const p = (pid ? await col.projects().findOne({ _id: pid as never }, { projection: { specText: 0, verdicts: 0, rounds: 0 } }) : null) as Any | null;
  const m = (p?.metrics ?? {}) as Any;
  const stages = pid ? ((await col.stages().find({ projectId: pid }, { projection: { stage: 1, startedAt: 1, finishedAt: 1, retrievalVia: 1 } }).toArray()) as Any[]) : [];
  const st = (...names: string[]) => stages.filter((s) => names.includes(s.stage)).reduce((a, s) => a + ms(s.startedAt, s.finishedAt), 0);
  const via = stages.find((s) => s.stage === "plc_code")?.retrievalVia ?? null;
  const sims = pid ? ((await col.simRuns().find({ projectId: pid }, { projection: { _id: 1 } }).toArray()) as Any[]) : [];
  const simIds = sims.map((s) => String(s._id));
  const samples = simIds.length ? await col.measurements().countDocuments({ "meta.simRunId": { $in: simIds } }) : 0;
  const transitions = await col.jobTransitions().countDocuments({ jobId: String(j._id) }).catch(() => 0);
  const rec = (p?.recall ?? m.recall ?? null) as Any | null;
  const lr = j.result?.lastSimRun;
  const tests = m.tests ?? (lr ? { passed: lr.passed, total: lr.passed + lr.failed + lr.blocked } : null);
  rows.push({
    start: m.startedAt ?? j.startedAt ?? j.createdAt,
    runIndex: typeof m.runIndex === "number" ? m.runIndex : typeof rec?.runIndex === "number" ? rec.runIndex : null,
    memory: m.memoryRequested ?? j.memory ?? null,
    recallKind: rec?.kind ?? (m.memoryRequested === false || j.memory === false ? "none (memory off)" : pid ? "-" : "pending"),
    recallSrc: rec?.sourceProjectId ?? null,
    recallScore: rec?.score ?? null,
    recallLookupMs: rec?.lookupMs ?? null,
    msSaved: rec?.msSaved ?? null,
    status: p?.status ?? j.status,
    jobStatus: j.status,
    ttv: m.timeToVerifiedSec ?? m.timeToReuseSec ?? null,
    seconds: m.seconds ?? j.result?.seconds ?? null,
    requirements: st("requirements"),
    io: st("io_design", "state_machine"),
    plc: st("plc_code"),
    compile: st("preflight", "compile"),
    deploy: st("deploy"),
    tests: st("simulate", "tests"),
    repairs: m.repairs ?? (typeof p?.attempts === "number" ? Math.max(0, p.attempts - 1) : null),
    cost: m.costUsd ?? p?.costUsd ?? j.result?.costUsd ?? null,
    testsStr: tests ? `${tests.passed}/${tests.total}` : "-",
    jobId: String(j._id),
    projectId: pid ? String(pid) : "-",
    raindrop: j.raindropEventId ?? null,
    via,
    memoryUsed: m.memoryUsed ?? null,
    retrievalMs: m.retrievalMs ?? null,
    samples,
    simRuns: simIds.length,
    transitions,
  });
}

const out: string[] = [];
out.push(`# Learning curve: \`${specId}\``, "");
out.push(`Generated ${la(new Date())} (America/Los_Angeles) from Atlas db \`${process.env.MONGODB_DB || "mongomation"}\` (read-only). Scene \`${ex.sceneId}\`. ${rows.length} job(s) with this exact spec text.`, "");
out.push("| run | start (PT) | runIndex | recall (kind / source / score) | status | time-to-verified s | req s | io s | plc_code s | compile s | deploy+link s | tests s | repairs | Claude $ | tests | job id | project id |");
out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
rows.forEach((r, i) => {
  const score = r.recallScore != null ? ` / ${typeof r.recallScore === "number" ? r.recallScore.toFixed(3) : r.recallScore}` : "";
  const recall = `${r.recallKind}${r.recallSrc ? ` / \`${r.recallSrc}\`` : ""}${score}`;
  const status = r.jobStatus === "completed" || r.jobStatus === "failed" ? r.status : `${r.status} (job ${r.jobStatus})`;
  const ttv = r.ttv ?? (r.seconds != null ? `(${r.seconds} wall)` : "-");
  out.push(
    `| ${i + 1} | ${la(r.start)} | ${r.runIndex ?? "-"} | ${recall} | ${status} | ${ttv} | ${sec(r.requirements)} | ${sec(r.io)} | ${sec(r.plc)} | ${sec(r.compile)} | ${sec(r.deploy)} | ${sec(r.tests)} | ${r.repairs ?? "-"} | ${usd(r.cost)} | ${r.testsStr} | \`${r.jobId}\` | \`${r.projectId}\` |`,
  );
});

const done = rows.filter((r) => r.ttv != null || r.seconds != null);
out.push("");
if (done.length >= 2) {
  const a = done[0];
  const b = done[done.length - 1];
  const ta = a.ttv ?? a.seconds;
  const tb = b.ttv ?? b.seconds;
  const costPct = typeof a.cost === "number" && typeof b.cost === "number" ? ` (${pct(a.cost, b.cost)})` : "";
  out.push(`**Summary: run ${rows.indexOf(a) + 1} → run ${rows.indexOf(b) + 1}: ${ta} s → ${tb} s (${pct(ta, tb)}), ${usd(a.cost)} → ${usd(b.cost)}${costPct}**`);
} else if (done.length === 1) {
  const a = done[0];
  out.push(`**Summary: run 1 only so far: ${a.ttv ?? a.seconds} s, ${usd(a.cost)}, ${a.testsStr} tests (${a.status}). Waiting for runs 2 and 3.**`);
} else out.push("**Summary: no finished run yet.**");
out.push(
  "",
  "Notes: `runIndex` = prior runs of these requirements on this scene (metrics.runIndex; absent on runs made before experience recall shipped). Stage seconds are summed from the `stages` checkpoints (all attempts); deploy includes the PLC-to-simulator link-up gate; tests = simulate + tests stages. time-to-verified = metrics.timeToVerifiedSec (claim to verified), or timeToReuseSec for verified-by-reuse.",
);

// MongoDB features per run ---------------------------------------------------------------------------------
const vp = client.db(process.env.MONGODB_DB || "mongomation").collection("verified_programs");
const searchIdx = (await vp.listSearchIndexes().toArray().catch(() => [])) as Any[];
const vec = searchIdx.find((x) => x.name === "verified_programs_vec");
const vecDef = JSON.stringify(vec?.latestDefinition ?? {});
const model = vecDef.match(/voyage[-\w.]*/)?.[0];
const vecDesc = vec ? `\`verified_programs_vec\` (${vec.type ?? "vectorSearch"}, ${vec.status ?? (vec.queryable ? "READY" : "?")}${model ? `, autoEmbed ${model}` : ""})` : "`verified_programs_vec` not found";
const fpIdx = [
  ...((await vp.indexes().catch(() => [])) as Any[]).filter((x) => x.name === "scene_fingerprint").map(() => "verified_programs"),
  ...((await col.projects().indexes().catch(() => [])) as Any[]).filter((x) => x.name === "scene_fingerprint").map(() => "projects"),
];
const vpCount = await vp.countDocuments({}).catch(() => 0);
const harnessVersions = await col.harness().countDocuments({}).catch(() => 0);
out.push("", "## MongoDB features per run", "");
out.push(
  `Cluster-level: vector index ${vecDesc}; ${vpCount} verified programs in memory; \`scene_fingerprint\` index on ${fpIdx.length ? fpIdx.join(" + ") : "(not found)"}; multi-document ACID transactions are used by RSI evolve (harness_versions + rsi_proposals; ${harnessVersions} harness versions), not inside an engineering job.`,
  "",
);
out.push("| run | project | memory | program-memory retrieval ($rankFusion of autoEmbed $vectorSearch + Atlas Search) | experience recall (scene_fingerprint lookup) | change-stream job transitions | sim runs | time-series measurements |");
out.push("|---|---|---|---|---|---|---|---|");
rows.forEach((r, i) => {
  const mem = r.memory === false ? "off" : r.memory === true ? "on" : "default";
  const retr = r.memoryUsed ? `used via ${r.via ?? "?"} (${r.retrievalMs ?? "?"} ms)` : r.memory === false ? "not used (memory off)" : `not used${r.via ? ` (via ${r.via})` : ""}`;
  const k = String(r.recallKind);
  const rc = !k.startsWith("none") && k !== "-" && k !== "pending" ? `${k} in ${r.recallLookupMs ?? "?"} ms${r.msSaved != null ? `, ~${Math.round(r.msSaved / 1000)} s saved (est.)` : ""}` : k;
  out.push(`| ${i + 1} | \`${r.projectId}\` | ${mem} | ${retr} | ${rc} | ${r.transitions} | ${r.simRuns} | ${r.samples} |`);
});

out.push("", "## Raindrop", "");
out.push("- Dashboard (RSI learning curve): https://app.raindrop.ai/dashboards/817fd0ec-a165-4d1b-a45e-669750fe91c7?org=c4886d11&project=default");
out.push("- Experiment (Experience recall ON vs OFF): https://app.raindrop.ai/experiments/a1ddf994-d802-480a-a9ab-fca2e4f401ef?org=c4886d11&project=default");
rows.forEach((r, i) => r.raindrop && out.push(`- run ${i + 1}: Raindrop event \`${r.raindrop}\` (job \`${r.jobId}\`)`));

console.log(out.join("\n"));
await client.close();
