// Engineering deliverable for one project: ST source, I/O list, requirements, verification report with evidence ids.
//   npm run export -- <projectId>      → out/<projectId>/
import { mkdirSync, writeFileSync } from "node:fs";
import { ObjectId } from "mongodb";
import { client, col, connect } from "../apps/worker/src/db/index.ts";

const projectId = process.argv[2];
if (!projectId) throw new Error("usage: npm run export -- <projectId>");
await connect();
const p = await col.projects().findOne({ _id: projectId as never });
if (!p) throw new Error(`project ${projectId} not found`);
const req = await col.requirements().findOne({ projectId }, { sort: { revision: -1 } });
const v = p.finalPlcVersionId ? await col.plcVersions().findOne({ _id: new ObjectId(String(p.finalPlcVersionId)) }) : null;
const run = p.lastSimRunId ? await col.simRuns().findOne({ _id: new ObjectId(String(p.lastSimRunId)) }) : null;
const tests = run ? await col.testResults().find({ simRunId: String(run._id) }, { projection: { steps: 0, stepLogs: 0 } }).toArray() : [];
const compiles = v ? await col.compiles().find({ plcVersionId: String(v._id) }).toArray() : [];
const dir = `out/${projectId}`;
mkdirSync(dir, { recursive: true });
if (v) writeFileSync(`${dir}/program.st`, String(v.source));
writeFileSync(`${dir}/io_list.csv`, ["variable,tag,address,type,role,active_low", ...((req?.io as { variable: string; tag: string; address: string; dataType: string; role: string; activeLow: boolean }[]) ?? []).map((x) => `${x.variable},"${x.tag}",${x.address},${x.dataType},${x.role},${x.activeLow}`)].join("\n"));
writeFileSync(`${dir}/requirements.json`, JSON.stringify(req?.requirements ?? [], null, 2));
const verdicts = (p.verdicts as { requirementId: string; status: string; detail: string }[] | undefined) ?? [];
writeFileSync(
  `${dir}/verification_report.md`,
  [
    `# Verification report — project ${projectId}`,
    "",
    `Spec: ${p.specText}`,
    `Scene: ${p.sceneId} · Harness v${p.harnessVersion} · Status: **${p.status}** · Attempts: ${p.attempts}`,
    `PLC version: \`${v?._id ?? "-"}\` (sha256 ${String(v?.sourceHash ?? "-").slice(0, 16)}…) · Sim run: \`${run?._id ?? "-"}\``,
    "",
    "## Requirements",
    "| id | status | detail |",
    "|---|---|---|",
    ...verdicts.map((x) => `| ${x.requirementId} | ${x.status.toUpperCase()} | ${x.detail.replace(/\|/g, "/")} |`),
    "",
    "## Tests (measured on Factory I/O)",
    "| test | visibility | verdict | samples | Raindrop |",
    "|---|---|---|---|---|",
    ...tests.map((t) => `| ${t.visibility === "hidden" ? `hidden ${t.category}` : t.title} | ${t.visibility} | ${t.verdict} | ${t.sampleCount} | ${t.traceId ?? "-"} |`),
    "",
    "## Compilation",
    ...compiles.map((c) => `- ${c.stage} (${c.toolchain}): ${c.ok ?? c.status} in ${c.durationMs} ms — record \`${c._id}\``),
  ].join("\n"),
);
console.log(`wrote ${dir}/ (program.st, io_list.csv, requirements.json, verification_report.md)`);
await client.close();
