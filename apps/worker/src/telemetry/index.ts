// Agent observability. Every model call, tool call (compile, deploy, simulate, test), failure and repair is
// reported here; the Raindrop implementation (raindrop.ts) sends it to the real Raindrop platform.
// When RAINDROP_WRITE_KEY is missing, telemetry is DISABLED: calls are no-ops and trace ids are null.
// We never invent trace ids.

export interface AiSpan {
  /** Returns the Raindrop event id (or null when telemetry is disabled / the event was rejected). */
  finish(out: { output: string; model: string; inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number }): string | null;
  fail(err: unknown): void;
}

export interface ToolSpanResult {
  ok: boolean;
  summary: string;
  durationMs: number;
  /** Atlas ids of the evidence this tool call produced (compile log, measurement batch, ...). */
  evidenceIds?: string[];
}

export interface Telemetry {
  readonly enabled: boolean;
  /** One Raindrop interaction per engineering job; tool calls become its spans. Returns its event id. */
  beginRun(runId: string, args: { event: string; input: string; properties?: Record<string, string | number | boolean> }): string | null;
  finishRun(runId: string, output: string, properties?: Record<string, string | number | boolean>): Promise<void>;
  beginAi(args: { agent: string; model: string; runId: string; input: string }): AiSpan;
  /** One engineering tool execution: preflight, compile, deploy, simulate, test, fault injection. */
  tool(args: { name: string; runId: string; input: Record<string, unknown> }, result: ToolSpanResult): string | null;
  /** Named signals the RSI loop and Raindrop dashboards group on: simulator_test_failed, plc_compile_failed, ... */
  signal(args: { runId: string; name: string; eventId?: string | null; properties?: Record<string, unknown> }): void;
  flush(): Promise<void>;
}

class DisabledTelemetry implements Telemetry {
  readonly enabled = false;
  beginRun() {
    return null;
  }
  async finishRun() {}
  beginAi(): AiSpan {
    return { finish: () => null, fail: () => {} };
  }
  tool() {
    return null;
  }
  signal() {}
  async flush() {}
}

let impl: Telemetry = new DisabledTelemetry();

/** Called once at worker start. */
export async function initTelemetry(log: (m: string) => void = console.log) {
  if (!process.env.RAINDROP_WRITE_KEY) {
    log("telemetry: DISABLED (RAINDROP_WRITE_KEY not set) — no traces are being recorded");
    return;
  }
  const { RaindropTelemetry } = await import("./raindrop.ts");
  impl = new RaindropTelemetry(process.env.RAINDROP_WRITE_KEY);
  log("telemetry: Raindrop enabled");
}

export const telemetry: Telemetry = {
  get enabled() {
    return impl.enabled;
  },
  beginRun: (r, a) => impl.beginRun(r, a),
  finishRun: (r, o, p) => impl.finishRun(r, o, p),
  beginAi: (a) => impl.beginAi(a),
  tool: (a, r) => impl.tool(a, r),
  signal: (a) => impl.signal(a),
  flush: () => impl.flush(),
};
