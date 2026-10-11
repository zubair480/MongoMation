import { RaindropQuery } from "../apps/worker/src/telemetry/raindrop-query.ts";
const q = RaindropQuery.fromEnv()!;
const since = new Date(Date.now() - 60 * 86_400_000);
for (const name of ["engineering_job", "spec_change", "fault_and_improve", "raindrop_smoke", "ablation_case"]) {
  const evs = await q.events({ eventName: name, limit: 50, since }).catch((e) => (console.log(name, String(e)), []));
  console.log(name, evs.length, evs.slice(0, 3).map((e) => JSON.stringify({ id: e.id, ts: e.timestamp, convo: e.convo_id, sig: e.signals?.map((s) => s.name), props: e.properties, ff: (e as any).feature_flags })).join("\n  "));
}
const ws = "http://127.0.0.1:5899";
const evs = await q.events({ eventName: "engineering_job", limit: 1, since });
if (evs[0]) {
  const r = await fetch(`${ws}/api/cloud/traces/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event_id: evs[0].id, open_in_ui: false }) });
  console.log("import", r.status, (await r.text()).slice(0, 600));
  const s = await fetch(`${ws}/api/traces/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: `SELECT name, span_type, status, model, input_tokens, output_tokens, substr(attributes,1,400) a, substr(output_payload,1,150) o FROM spans WHERE run_id='${evs[0].id}' ORDER BY start_time_ms LIMIT 40` }) });
  console.log(JSON.stringify((await s.json()).rows, null, 1).slice(0, 9000));
}
const s2 = await fetch(`${ws}/api/traces/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: `SELECT r.event_name, s.name, s.span_type, s.status, substr(s.attributes,1,500) a FROM spans s JOIN runs r ON r.id=s.run_id WHERE r.event_name='raindrop_smoke' LIMIT 10` }) });
console.log(JSON.stringify((await s2.json()).rows, null, 1).slice(0, 6000));
