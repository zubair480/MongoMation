// Evidence ledger: every claimed result with the Atlas ids and Raindrop ids that prove it.
//   npm run ledger > docs/EVIDENCE_LEDGER.md
import { client, col, connect } from "../apps/worker/src/db/index.ts";

await connect();
const out: string[] = ["# Evidence ledger", "", `Generated ${new Date().toISOString()} from Atlas (db ${process.env.MONGODB_DB || "mongomation"}). Every row links to real records.`, ""];

out.push("## Engineering projects", "", "| project | spec (start) | scene | harness | status | attempts | final PLC version | last sim run | verified reqs |", "|---|---|---|---|---|---|---|---|---|");
for (const p of await col.projects().find({}, { sort: { createdAt: -1 }, limit: 50 }).toArray()) {
  const v = (p.verdicts as { status: string }[] | undefined) ?? [];
  out.push(`| \`${p._id}\` | ${String(p.specText ?? "").slice(0, 50).replace(/\|/g, "/")}… | ${p.sceneId} | v${p.harnessVersion} | ${p.status} | ${p.attempts ?? "-"} | \`${p.finalPlcVersionId ?? "-"}\` | \`${p.lastSimRunId ?? "-"}\` | ${v.filter((x) => x.status === "verified").length}/${v.filter((x) => x.status !== "unsupported").length} |`);
}

out.push("", "## Compilations (real OpenPLC toolchain)", "", "| compile id | PLC version | stage | toolchain | ok | ms |", "|---|---|---|---|---|---|");
for (const c of await col.compiles().find({}, { sort: { createdAt: -1 }, limit: 50 }).toArray())
  out.push(`| \`${c._id}\` | \`${c.plcVersionId}\` | ${c.stage} | ${c.toolchain} | ${c.ok ?? c.status} | ${c.durationMs} |`);

out.push("", "## Simulation runs (Factory I/O measurements)", "", "| sim run | project | fault | passed | failed | blocked | samples stored |", "|---|---|---|---|---|---|---|");
for (const r of await col.simRuns().find({}, { sort: { startedAt: -1 }, limit: 50 }).toArray()) {
  const samples = await col.measurements().countDocuments({ "meta.simRunId": String(r._id) });
  out.push(`| \`${r._id}\` | \`${r.projectId}\` | ${r.faultId ?? "-"} | ${r.passed ?? "-"} | ${r.failed ?? "-"} | ${r.blocked ?? "-"} | ${samples} |`);
}

out.push("", "## Fault injections", "", "| id | project | fault | tag | confirmed by read-back | released |", "|---|---|---|---|---|---|");
for (const f of await col.faults().find({}, { sort: { appliedAt: -1 }, limit: 50 }).toArray())
  out.push(`| \`${f._id}\` | \`${f.projectId}\` | ${f.faultId} | ${f.tag} | ${f.confirmed} | ${f.releasedAt ? new Date(f.releasedAt).toISOString() : "NO"} |`);

out.push("", "## Harness versions and RSI verdicts", "", "| version | parent | verdict | rationale | gate note |", "|---|---|---|---|---|");
for (const h of await col.harness().find({}, { sort: { version: 1 } }).toArray())
  out.push(`| v${h.version} | ${h.parent ?? "-"} | ${String(h.verdict).toUpperCase()} | ${String(h.rationale).slice(0, 80).replace(/\|/g, "/")} | ${String(h.gateNote ?? "").slice(0, 120).replace(/\|/g, "/")} |`);

out.push("", "## RSI proposals", "", "| proposal | from | candidate | verdict | provenance | cited runs | meta trace |", "|---|---|---|---|---|---|---|");
for (const p of await col.proposals().find({}, { sort: { createdAt: -1 }, limit: 50 }).toArray())
  out.push(`| \`${p._id}\` | v${p.fromVersion} | ${p.candidateVersion !== undefined ? `v${p.candidateVersion}` : "-"} | ${String(p.verdict).toUpperCase()} | ${p.provenance} | ${(p.citedRunIds ?? []).length} | \`${p.metaTraceId ?? "-"}\` |`);

out.push("", "## Raindrop trace references", "", "Test results with a Raindrop event id:", "");
const traced = await col.testResults().find({ traceId: { $exists: true } }, { projection: { testId: 1, traceId: 1, verdict: 1, simRunId: 1 }, sort: { _id: -1 }, limit: 30 }).toArray();
for (const t of traced) out.push(`- sim run \`${t.simRunId}\` · ${t.testId} · ${t.verdict} · Raindrop \`${t.traceId}\``);
if (!traced.length) out.push("(none — telemetry disabled or no runs yet)");

console.log(out.join("\n"));
await client.close();
