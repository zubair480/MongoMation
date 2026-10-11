// Workshop evals: score MongoMation's REAL engineering traces in Raindrop Workshop (local, free, MIT —
// github.com/raindrop-ai/workshop) and compare harness versions. Replaces the hosted Raindrop Evals suite
// (scripts/raindrop-ablation.eval.ts, which needs a paid org).
//
//   1. discover root job events in Raindrop cloud via the Query API (engineering_job, spec_change,
//      fault_and_improve, raindrop_smoke; read-only, costs no ingest events) and import each trace into Workshop
//      (POST /api/cloud/traces/import — the same path as the Workshop MCP tool `import_cloud_trace`);
//      runs mirrored locally with RAINDROP_WORKSHOP=1 are scored too;
//   2. score every run from its Workshop spans (SQL over /api/traces/query) + its cloud event (signals, flags,
//      status) + its child model-call events (cost_usd);
//   3. print a per-run table and a per-harness_version comparison; failing runs get a Workshop `issue`
//      annotation so a coding agent (Workshop MCP: query_traces / get_run_outline / annotations) sees them.
//
//   npm run workshop:eval                 (needs `raindrop workshop` running on :5899 and RAINDROP_QUERY_API_KEY)
//   WORKSHOP_EVAL_DAYS=30 WORKSHOP_EVAL_STRICT=1 npm run workshop:eval   (strict: exit 1 when any assertion fails)
import { RaindropQuery } from "../apps/worker/src/telemetry/raindrop-query.ts";

const WS = (process.env.RAINDROP_WORKSHOP_API || "http://127.0.0.1:5899").replace(/\/+$/, "");
const DAYS = Number(process.env.WORKSHOP_EVAL_DAYS || 30);
const ROOT_EVENTS = ["engineering_job", "spec_change", "fault_and_improve", "raindrop_smoke"];
const NOTE = "[workshop-eval]";

type Row = Record<string, unknown>;
async function ws<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${WS}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`workshop ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}
const sql = async (q: string) => (await ws<{ rows: Row[] }>("/api/traces/query", { sql: q, limit: 1000, max_bytes: 1_000_000 })).rows;
const esc = (s: string) => s.replace(/'/g, "''");
const json = (s: unknown): Row => {
  try {
    return typeof s === "string" ? (JSON.parse(s) as Row) : {};
  } catch {
    return {};
  }
};

const q = RaindropQuery.fromEnv();
if (!q) {
  console.error("needs RAINDROP_QUERY_API_KEY");
  process.exit(2);
}
await ws("/api/status").catch((e) => {
  console.error(`Workshop daemon not reachable at ${WS} (start it: scripts/workshop-start.sh): ${e}`);
  process.exit(2);
});

// 1. Discover + import.
const since = new Date(Date.now() - DAYS * 86_400_000);
const cloud = new Map<string, Row>();
for (const name of ROOT_EVENTS) for (const e of await q.events({ eventName: name, limit: 100, since })) cloud.set(e.id, e as unknown as Row);
const present = new Set((await sql(`SELECT event_id FROM runs WHERE event_id IS NOT NULL`)).map((r) => String(r.event_id)));
let imported = 0;
const importErrors: string[] = [];
for (const id of cloud.keys()) {
  if (present.has(id)) continue;
  try {
    await ws("/api/cloud/traces/import", { event_id: id, open_in_ui: false });
    imported++;
  } catch (e) {
    importErrors.push(`${id}: ${String(e).slice(0, 160)}`);
  }
}

// 2. Score. One Workshop run per job event (prefer the cloud import, whose run id is the event id).
const runs = await sql(`SELECT id, event_id, event_name, convo_id, started_at, metadata FROM runs WHERE event_name IN (${ROOT_EVENTS.map((n) => `'${n}'`).join(",")}) ORDER BY started_at`);
const byEvent = new Map<string, Row>();
for (const r of runs) {
  const key = String(r.event_id ?? r.id);
  if (!byEvent.has(key) || r.id === key) byEvent.set(key, r);
}

interface Score {
  run: string;
  event: string;
  name: string;
  harness: string;
  status: string;
  compilePassed: boolean | null;
  simPassRate: number | null;
  simTests: string;
  budgetOk: boolean;
  verified: boolean;
  costUsd: number;
  modelCalls: number;
  failures: string[];
}
const money = (s: Score) => (s.modelCalls ? `$${s.costUsd.toFixed(3)} (${s.modelCalls} calls)` : "n/a");
const costCache = new Map<string, number>();
async function childCost(id: string) {
  if (!costCache.has(id)) {
    const ev = (await q!.event(id).catch(() => null)) as Row | null;
    costCache.set(id, Number((ev?.properties as Row | undefined)?.cost_usd ?? 0) || 0);
  }
  return costCache.get(id)!;
}

const AGENTS = ["requirements", "binder", "state_machine", "codegen", "critic", "repair"];
const aiEvents: Row[] = [];
for (const name of AGENTS) aiEvents.push(...((await q.events({ eventName: name, limit: 100, since }).catch(() => [])) as unknown as Row[]));

const scores: Score[] = [];
for (const [eventId, r] of byEvent) {
  const meta = json(r.metadata);
  const ev = cloud.get(eventId) ?? ((await q.event(eventId).catch(() => null)) as Row | null) ?? {};
  const props = { ...(meta.properties as Row | undefined), ...(ev.properties as Row | undefined) };
  const flags = (ev.feature_flags as Row | undefined) ?? {};
  const signals = new Set([...((ev.signals as Row[] | undefined) ?? []), ...((meta.signals as Row[] | undefined) ?? [])].map((s) => String(s.name)));
  const spans = await sql(`SELECT id, name, status, start_time_ms, input_payload, attributes FROM spans WHERE run_id = '${esc(String(r.id))}' ORDER BY start_time_ms`);

  const compiles = spans.filter((s) => s.name === "openplc_compile");
  const lastTest = new Map<string, Row>(); // last attempt of each test wins (repairs re-run tests)
  for (const s of spans.filter((s) => s.name === "simulator_test")) lastTest.set(String(json(s.input_payload).testId ?? s.id), s);
  const tests = [...lastTest.values()];
  const passed = tests.filter((s) => s.status !== "ERROR").length;
  // Cost = cost_usd of the job's model-call events: linked by agent:<name> span child ids when the trace has them,
  // else the cloud model-call events of the same convo (project) inside the run's time window.
  let cost = 0;
  let costCalls = 0;
  for (const s of spans.filter((s) => String(s.name).startsWith("agent:"))) {
    const attrs = json(s.attributes);
    const child = Object.entries(attrs).find(([k]) => k.endsWith("child_event_id"))?.[1];
    if (child) (cost += await childCost(String(child))), costCalls++;
  }
  if (!costCalls && spans.length) {
    const evTs = Date.parse(String(ev.timestamp ?? "")); // job begin; the first model calls precede any tool span
    const t0 = Math.min(...spans.map((s) => Number(s.start_time_ms)), Number.isFinite(evTs) ? evTs : Infinity) - 5000;
    const t1 = Math.max(...spans.map((s) => Number(s.start_time_ms))) + 5000;
    for (const e of aiEvents.filter((e) => e.convo_id === r.convo_id && Date.parse(String(e.timestamp)) >= t0 && Date.parse(String(e.timestamp)) <= t1)) {
      cost += Number((e.properties as Row | undefined)?.cost_usd ?? 0) || 0;
      costCalls++;
    }
  }
  const hv = flags.harness_version ?? (props.harness_version !== undefined ? `v${props.harness_version}` : "none");
  const sc: Score = {
    run: String(r.id),
    event: eventId,
    name: String(r.event_name),
    harness: String(hv),
    status: String(props.status ?? (r.event_name === "fault_and_improve" ? "fault" : "?")),
    compilePassed: compiles.length ? compiles[compiles.length - 1]!.status !== "ERROR" : null,
    simPassRate: tests.length ? passed / tests.length : null,
    simTests: tests.length ? `${passed}/${tests.length}` : "-",
    budgetOk: !signals.has("repair_budget_exhausted"),
    verified: String(props.status) === "verified" || signals.has("project_verified"),
    costUsd: cost,
    modelCalls: costCalls,
    failures: [],
  };
  // Assertions (the "failing check" of the self-healing loop). Smoke runs are synthetic: scored, not asserted.
  if (sc.name !== "raindrop_smoke") {
    if (sc.compilePassed === false) sc.failures.push("final OpenPLC compile failed");
    if (sc.simPassRate !== null && sc.simPassRate < 1) sc.failures.push(`simulator tests ${sc.simTests} passed (last attempt per test): ${tests.filter((s) => s.status === "ERROR").map((s) => json(s.input_payload).testId).join(", ")}`);
    if (!sc.budgetOk) sc.failures.push("repair budget exhausted");
  }
  scores.push(sc);

  // Workshop annotation: replace this eval's previous verdict on the run.
  const existing = await ws<Row[]>(`/api/annotations?run_id=${encodeURIComponent(sc.run)}`).catch(() => []);
  for (const a of existing) if (String(a.note ?? "").startsWith(NOTE)) await fetch(`${WS}/api/annotations/${a.id}`, { method: "DELETE" }).catch(() => {});
  await ws("/api/annotations", { run_id: sc.run, kind: sc.failures.length ? "issue" : "good", source: "user", note: `${NOTE} ${sc.failures.length ? sc.failures.join("; ") : "all assertions passed"} | harness ${sc.harness}, sim ${sc.simTests}, cost ${money(sc)}` }).catch(() => {});
}

// 3. Report.
const pct = (x: number | null) => (x === null ? "-" : `${(x * 100).toFixed(0)}%`);
console.log(`Workshop ${WS}: ${cloud.size} cloud job events in last ${DAYS}d, ${imported} newly imported, ${scores.length} runs scored${importErrors.length ? `, ${importErrors.length} import errors` : ""}`);
for (const e of importErrors) console.log(`  import error ${e}`);
console.log("\nrun (event id)                         event              harness status              compile sim     budget verified cost");
for (const s of scores) console.log(`${s.event.padEnd(38)} ${s.name.padEnd(18)} ${s.harness.padEnd(7)} ${s.status.padEnd(19)} ${String(s.compilePassed ?? "-").padEnd(7)} ${s.simTests.padEnd(7)} ${String(s.budgetOk).padEnd(6)} ${String(s.verified).padEnd(8)} ${money(s)}${s.failures.length ? `\n    FAIL: ${s.failures.join("; ")}` : ""}`);

const groups = new Map<string, Score[]>();
for (const s of scores.filter((s) => s.name === "engineering_job" || s.name === "spec_change")) groups.set(s.harness, [...(groups.get(s.harness) ?? []), s]);
console.log("\nharness_version comparison (engineering jobs only)");
console.log("harness  jobs  compile_pass  sim_pass_mean  budget_ok  verified  total_cost  cost_per_verified");
const summary: Row[] = [];
for (const [h, g] of [...groups].sort()) {
  const c = g.filter((s) => s.compilePassed !== null);
  const sim = g.filter((s) => s.simPassRate !== null);
  const cost = g.reduce((a, s) => a + s.costUsd, 0); // jobs with no model-call events contribute 0 (shown as n/a per run)
  const verified = g.filter((s) => s.verified).length;
  const row = { harness: h, jobs: g.length, compile_pass: c.length ? c.filter((s) => s.compilePassed).length / c.length : null, sim_pass_mean: sim.length ? sim.reduce((a, s) => a + s.simPassRate!, 0) / sim.length : null, budget_ok: g.filter((s) => s.budgetOk).length / g.length, verified, total_cost: cost, cost_per_verified: verified ? cost / verified : null };
  summary.push(row);
  console.log(`${h.padEnd(8)} ${String(g.length).padEnd(5)} ${pct(row.compile_pass).padEnd(13)} ${pct(row.sim_pass_mean).padEnd(14)} ${pct(row.budget_ok).padEnd(10)} ${String(verified).padEnd(9)} $${cost.toFixed(3).padEnd(10)} ${row.cost_per_verified === null ? "n/a (0 verified)" : `$${row.cost_per_verified.toFixed(3)}`}`);
}
if (!groups.size) console.log("(no engineering_job traces in the window)");

const failed = scores.filter((s) => s.failures.length);
console.log(`\nassertions: ${scores.length - failed.length}/${scores.length} runs pass${failed.length ? ` — failing runs annotated as 'issue' in Workshop` : ""}`);
if (process.argv.includes("--json")) console.log(JSON.stringify({ scores, summary }, null, 2));
process.exit(process.env.WORKSHOP_EVAL_STRICT === "1" && failed.length ? 1 : 0);
