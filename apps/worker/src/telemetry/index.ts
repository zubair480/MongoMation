// Agent observability. Every model call, tool call (compile, deploy, simulate, test), failure and repair is
// reported here; the Raindrop implementation (raindrop.ts) sends it to the real Raindrop platform.
// When RAINDROP_WRITE_KEY is missing, telemetry is DISABLED: calls are no-ops and trace ids are null.
// We never invent trace ids.
import type { HarnessConfig } from "@mongomation/types";
import { recordTraceRef } from "../db/traces.ts";

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
  /** The step did not run (e.g. tool not installed): recorded as a non-error span. */
  skipped?: boolean;
}

export type FlagValue = string | number | boolean;

export interface RunAttachment {
  name: string;
  value: string;
  /** Hint only: Raindrop's viewer does not display "code" attachments, so the Raindrop sink sends all as "text". */
  type?: "code" | "text";
  language?: string;
  role?: "input" | "output";
}

export interface BeginRunArgs {
  event: string;
  input: string;
  properties?: Record<string, FlagValue>;
  /** Raindrop feature flags (harness version, model routing) — what Raindrop experiments split cohorts on. */
  featureFlags?: Record<string, FlagValue>;
  /** Event id of an interaction started by an earlier (crashed / stale) attempt of the same job: resume it. */
  resumeEventId?: string | null;
}

export interface Telemetry {
  readonly enabled: boolean;
  /** One Raindrop interaction per engineering job; tool calls become its spans. Returns its event id. */
  beginRun(runId: string, args: BeginRunArgs): string | null;
  finishRun(runId: string, output: string, properties?: Record<string, FlagValue>): Promise<void>;
  beginAi(args: { agent: string; model: string; runId: string; input: string }): AiSpan;
  /** One engineering tool execution: preflight, compile, deploy, simulate, test, fault injection.
   *  A call about one test (input.testId) gets its OWN Raindrop event, so the returned id is per test. */
  tool(args: { name: string; runId: string; input: Record<string, unknown> }, result: ToolSpanResult): string | null;
  /** Named signals the RSI loop and Raindrop dashboards group on: simulator_test_failed, plc_compile_failed, ... */
  signal(args: { runId: string; name: string; eventId?: string | null; properties?: Record<string, unknown> }): void;
  /** Artifacts on the job interaction: generated ST program, compile log, program diff. */
  attach(runId: string, attachments: RunAttachment[]): void;
  /** Run `fn` inside a real span on the job trace: every span, tool call and sub-agent dispatch it emits nests under it. */
  span<T>(runId: string, name: string, fn: () => Promise<T>): Promise<T>;
  flush(): Promise<void>;
}

/** Feature flags describing a harness config, so Raindrop can split events by harness version and routing. */
export function harnessFlags(config: HarnessConfig): Record<string, FlagValue> {
  return {
    harness_version: `v${config.version}`,
    route_requirements: config.routing.requirements,
    route_codegen: config.routing.codegen,
    route_critic: config.routing.critic,
    route_repair: config.routing.repair,
    repair_strategy: config.repair.strategy,
    repair_budget: config.workflow.repair_budget,
  };
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
  attach() {}
  span<T>(_runId: string, _name: string, fn: () => Promise<T>) {
    return fn();
  }
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

/** Tests only: swap the implementation. */
export function setTelemetryImpl(t: Telemetry) {
  impl = t;
}

export const telemetry: Telemetry = {
  get enabled() {
    return impl.enabled;
  },
  // Every real Raindrop event id is also written to Atlas `trace_refs` (db/traces.ts): evidence id <-> trace.
  beginRun: (r, a) => {
    const id = impl.beginRun(r, a);
    if (id) recordTraceRef({ runId: r, kind: "run", name: a.event, eventId: id });
    return id;
  },
  finishRun: (r, o, p) => impl.finishRun(r, o, p),
  beginAi: (a) => {
    const span = impl.beginAi(a);
    return {
      finish: (out) => {
        const id = span.finish(out);
        if (id) recordTraceRef({ runId: a.runId, kind: "ai", name: a.agent, eventId: id, ok: true });
        return id;
      },
      fail: (err) => span.fail(err),
    };
  },
  tool: (a, r) => {
    const id = impl.tool(a, r);
    if (id) recordTraceRef({ runId: a.runId, kind: "tool", name: a.name, eventId: id, evidenceIds: r.evidenceIds, ok: r.ok });
    return id;
  },
  signal: (a) => impl.signal(a),
  attach: (r, a) => impl.attach(r, a),
  span: (r, n, fn) => impl.span(r, n, fn),
  flush: () => impl.flush(),
};
