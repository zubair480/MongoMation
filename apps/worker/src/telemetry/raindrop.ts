// Raindrop implementation of Telemetry (raindrop-ai@1.0.1; API verified against the package's .d.ts —
// see docs/research/raindrop.md). Model:
//   - one interaction per engineering job (begin/finish), convoId = project id;
//   - every model call is its own trackAi event in the same conversation, with token usage;
//   - compile/deploy/test steps are tool spans on the job interaction; failures carry `error`;
//   - failures and outcomes are also signals, so Raindrop can group them for the RSI meta-agent.
// Caveats handled: span properties must be strings, output must be non-empty, payloads are truncated.
import { randomUUID } from "node:crypto";
import { Raindrop } from "raindrop-ai";
import type { AiSpan, Telemetry, ToolSpanResult } from "./index.ts";

const USER = "mongomation-worker";
const MAX = 200_000; // characters per text field (Raindrop limit is 1M; events are 1 MB total)
const cut = (s: string) => (s.length > MAX ? `${s.slice(0, MAX)}\n…[truncated ${s.length - MAX} chars]` : s);
const strProps = (p: Record<string, unknown> = {}) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));

type Interaction = ReturnType<Raindrop["begin"]>;

export class RaindropTelemetry implements Telemetry {
  readonly enabled = true;
  private rd: Raindrop;
  private runs = new Map<string, { interaction: Interaction; eventId: string }>();

  constructor(writeKey: string) {
    this.rd = new Raindrop({ writeKey, projectId: process.env.RAINDROP_PROJECT_ID, debugLogs: process.env.RAINDROP_DEBUG === "true" });
  }

  beginRun(runId: string, args: { event: string; input: string; properties?: Record<string, string | number | boolean> }) {
    const eventId = randomUUID();
    const interaction = this.rd.begin({ eventId, event: args.event, userId: USER, convoId: runId, input: cut(args.input), properties: { run_id: runId, ...args.properties } });
    this.runs.set(runId, { interaction, eventId });
    return eventId;
  }

  async finishRun(runId: string, output: string, properties?: Record<string, string | number | boolean>) {
    const run = this.runs.get(runId);
    if (!run) return;
    if (properties) run.interaction.setProperties(properties);
    await run.interaction.finish({ output: cut(output || "(no output)") });
    this.runs.delete(runId);
  }

  beginAi(args: { agent: string; model: string; runId: string; input: string }): AiSpan {
    const eventId = randomUUID();
    return {
      finish: (out) => {
        const ret = this.rd.trackAi({
          eventId,
          event: args.agent,
          userId: USER,
          convoId: args.runId,
          model: out.model,
          input: cut(args.input),
          output: cut(out.output || "(empty)"),
          properties: { run_id: args.runId, cost_usd: out.costUsd, latency_ms: out.latencyMs },
          usage: { provider: "anthropic", inputTokens: out.inputTokens, outputTokens: out.outputTokens },
        });
        return typeof ret === "string" ? ret : null;
      },
      fail: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        const ret = this.rd.trackAi({ eventId, event: args.agent, userId: USER, convoId: args.runId, model: args.model, input: cut(args.input), output: `ERROR: ${message}`, properties: { run_id: args.runId, failed: true } });
        if (typeof ret === "string") this.rd.trackSignal({ eventId, name: "agent_call_failed", sentiment: "NEGATIVE", properties: { agent: args.agent, error: message.slice(0, 500) } });
      },
    };
  }

  tool(args: { name: string; runId: string; input: Record<string, unknown> }, result: ToolSpanResult) {
    const run = this.runs.get(args.runId);
    if (run) {
      run.interaction.trackTool({
        name: args.name,
        input: args.input,
        output: { summary: result.summary, evidenceIds: result.evidenceIds ?? [] },
        durationMs: result.durationMs,
        ...(result.ok ? {} : { error: result.summary || `${args.name} failed` }),
      });
      return run.eventId;
    }
    // No job interaction (e.g. a CLI script): record the tool call as its own event.
    const eventId = randomUUID();
    const ret = this.rd.trackAi({ eventId, event: `tool:${args.name}`, userId: USER, convoId: args.runId, input: cut(JSON.stringify(args.input)), output: cut(`${result.ok ? "OK" : "FAILED"}: ${result.summary}`), properties: { run_id: args.runId, ok: result.ok } });
    return typeof ret === "string" ? ret : null;
  }

  signal(args: { runId: string; name: string; eventId?: string | null; properties?: Record<string, unknown> }) {
    const eventId = args.eventId ?? this.runs.get(args.runId)?.eventId;
    if (!eventId) return;
    const negative = /fail|error|blocked|not_verified|rejected|rolled/.test(args.name);
    this.rd.trackSignal({ eventId, name: args.name, sentiment: negative ? "NEGATIVE" : "POSITIVE", properties: strProps(args.properties) });
  }

  async flush() {
    await this.rd.close();
  }
}
