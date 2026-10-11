// Live readiness check — every line is a real call; nothing is assumed green.
//   npm run green
import Anthropic from "@anthropic-ai/sdk";
import { client, connect, DB_NAME } from "../apps/worker/src/db/index.ts";
import { initTelemetry, telemetry } from "../apps/worker/src/telemetry/index.ts";
import { createRig } from "../apps/worker/src/tools/connect.ts";
import { preflight } from "../apps/worker/src/tools/preflight.ts";

const row = (ok: boolean | null, name: string, detail: string) => console.log(`${ok === null ? "–" : ok ? "✓" : "✗"} ${name.padEnd(14)} ${detail}`);

try {
  await connect();
  const info = await client.db("admin").command({ buildInfo: 1 }).catch(() => ({ version: "?" }));
  row(true, "atlas", `db ${DB_NAME}, server ${info.version}`);
} catch (err) {
  row(false, "atlas", (err as Error).message);
}

try {
  const res = await new Anthropic().messages.create({ model: process.env.MODEL_FAST || "claude-sonnet-5-5", max_tokens: 64, messages: [{ role: "user", content: "Reply with the word OK." }] });
  row(true, "claude", `${res.model}: ${res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim()} (${res.usage.input_tokens}+${res.usage.output_tokens} tokens)`);
} catch (err) {
  row(false, "claude", (err as Error).message);
}

await initTelemetry(() => {});
if (telemetry.enabled) {
  const id = telemetry.beginAi({ agent: "green_check", model: "none", runId: "green-check", input: "readiness check" }).finish({ output: "ok", model: "none", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 });
  await telemetry.flush();
  row(Boolean(id), "raindrop", id ? `event ${id} sent — confirm it appears in the Raindrop UI` : "event rejected (see RAINDROP_DEBUG=true)");
} else row(null, "raindrop", "DISABLED (no RAINDROP_WRITE_KEY)");

const pf = await preflight("PROGRAM p\n  VAR\n    x : BOOL;\n  END_VAR\n  x := NOT x;\nEND_PROGRAM\n\nCONFIGURATION Config0\n  RESOURCE Res0 ON PLC\n    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);\n    PROGRAM instance0 WITH task0 : p;\n  END_RESOURCE\nEND_CONFIGURATION\n");
row(pf.status === "ok" ? true : pf.status === "unavailable" ? null : false, "preflight", `${pf.status} ${pf.status === "ok" ? `(${pf.durationMs} ms)` : pf.log.slice(0, 120)}`);

try {
  const rig = createRig();
  const plc = await rig.plc.status();
  row(plc.reachable, "openplc", `${rig.plc.label}: ${plc.detail}`);
  const sim = await rig.sim.health();
  row(sim.reachable, "factoryio", `${rig.sim.label}: ${sim.detail}${sim.tagCount ? ` (${sim.tagCount} tags)` : ""}`);
} catch (err) {
  row(false, "rig", (err as Error).message);
}
await client.close().catch(() => {});
process.exit(0);
