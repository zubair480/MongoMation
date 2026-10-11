// Live Raindrop round trip: emit one clearly-labelled smoke interaction through the worker's real telemetry path
// (feature flags, sub-agent model call, job-level + per-test tool spans, signals, attachments, resume), then read
// it back through the Raindrop Query API to prove ingest. No model is called; the AI payloads are labelled smoke.
//   npm run raindrop:smoke                     (RAINDROP_WORKSHOP=1 also checks the local Workshop mirror)
import { harnessFlags, initTelemetry, telemetry } from "../apps/worker/src/telemetry/index.ts";
import { RaindropQuery, raindropEvidence } from "../apps/worker/src/telemetry/raindrop-query.ts";
import { workshopUrl } from "../apps/worker/src/telemetry/raindrop.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
if (!process.env.RAINDROP_WRITE_KEY || !process.env.RAINDROP_QUERY_API_KEY) {
  console.error("needs RAINDROP_WRITE_KEY and RAINDROP_QUERY_API_KEY");
  process.exit(2);
}
await initTelemetry();
const runId = `smoke-${Date.now().toString(36)}`;
const version = Number(process.env.SMOKE_HARNESS_VERSION ?? 0);
const config = { version, routing: { requirements: "fast", codegen: "strong", critic: "fast", repair: "strong", escalate_after_failures: 1 }, repair: { strategy: "targeted_patch" }, workflow: { repair_budget: 2 } } as never;

const jobEvent = telemetry.beginRun(runId, { event: "raindrop_smoke", input: "SMOKE: telemetry round trip (no PLC, no model call)", properties: { harness_version: version, smoke: true }, featureFlags: harnessFlags(config) });
const { aiEvent, testEvent } = await telemetry.span(runId, "engineering", async () => {
  const ai = telemetry.beginAi({ agent: "codegen", model: "smoke-no-model", runId, input: "SMOKE input" });
  await sleep(150);
  const aiEvent = ai.finish({ output: '{"smoke":true}', model: "smoke-no-model", inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 150 });
  telemetry.tool({ name: "openplc_compile", runId, input: { sourceHash: "smoke" } }, { ok: true, summary: "compiled (smoke)", durationMs: 12 });
  const testEvent = telemetry.tool({ name: "simulator_test", runId, input: { testId: "SMOKE-1", visibility: "visible" } }, { ok: false, summary: "SMOKE-1: failed", durationMs: 30, evidenceIds: ["smoke-evidence"] });
  return { aiEvent, testEvent };
});
telemetry.signal({ runId, name: "simulator_test_failed", eventId: testEvent, properties: { testId: "SMOKE-1", category: "smoke" } });
telemetry.attach(runId, [{ name: "program v1.st", value: "PROGRAM smoke\nEND_PROGRAM", type: "code", language: "pascal" }]);
await telemetry.finishRun(runId, "SMOKE finished", { status: "smoke" });
await telemetry.flush();
console.log(JSON.stringify({ runId, jobEvent, aiEvent, testEvent }));

// Read back through the Query API (ingest is asynchronous: poll up to ~2 min).
const q = RaindropQuery.fromEnv()!;
// testEvent === jobEvent unless RAINDROP_CLOUD_PER_TEST=1 (per-test cloud events are off by default).
const want = [...new Set([jobEvent, aiEvent, testEvent].filter(Boolean) as string[])];
const found = new Map<string, unknown>();
for (let i = 0; i < 24 && found.size < want.length; i++) {
  await sleep(5000);
  for (const id of want) {
    if (found.has(id)) continue;
    const ev = await q.event(id).catch(() => null);
    if (ev) found.set(id, ev);
  }
}
for (const id of want) {
  const e = found.get(id) as Record<string, unknown> | undefined;
  console.log(id, e ? JSON.stringify({ id: e.id, event_name: e.event_name, convo_id: e.convo_id, signals: e.signals, feature_flags: e.feature_flags, properties: e.properties }).slice(0, 800) : "NOT FOUND");
}
const ev = await raindropEvidence({ windowDays: 1, log: console.error });
console.log("evidence summary:", JSON.stringify(ev && { totalEvents: ev.totalEvents, signals: ev.signals.map((s) => `${s.name}=${s.events}`), errorSpans: ev.errorSpans }));

// Workshop mirror (RAINDROP_WORKSHOP=1): the same job trace must also be in the local Workshop daemon.
let workshopOk = true;
const ws = workshopUrl();
if (ws && jobEvent) {
  const base = new URL(ws).origin;
  const res = await fetch(`${base}/api/traces/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: `SELECT id, event_name, span_count, finished FROM runs_with_hints WHERE event_id = '${jobEvent}'` }) }).catch(() => null);
  const rows = res?.ok ? ((await res.json()) as { rows: unknown[] }).rows : [];
  workshopOk = rows.length > 0;
  console.log(`workshop ${base}:`, workshopOk ? JSON.stringify(rows) : "NOT FOUND");
}
process.exit(found.size === want.length && workshopOk ? 0 : 1);
