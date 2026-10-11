// Raindrop implementation of Telemetry (raindrop-ai@1.0.1; every call below is checked against the package's
// .d.ts — Interaction.{subagent,startSpan,trackTool,addAttachments,setFeatureFlags,setProperties,finish},
// Raindrop.{begin,resumeInteraction,trackAi,trackSignal,setUserDetails,close}). Model:
//   - one interaction per engineering job (begin/finish), convoId = project id; a job that resumes after a crash
//     or a stale-heartbeat reclaim RESUMES the same interaction (resumeInteraction) instead of starting a new one;
//   - the job interaction carries feature flags (harness version, model routing) so Raindrop experiments can
//     compare harness versions, plus attachments (generated ST program, compile log, program diff);
//   - every model call is its own trackAi event (with token usage) AND a sub-agent of the job: the job records a
//     `launch_subagent` dispatch span naming the child event id, and a real `agent:<name>` span with the call's
//     duration, so the job trace shows requirements → binder → codegen → critic → repair as nested work;
//   - compile/deploy/test steps are tool spans on the job interaction (with real start time + duration);
//     failures carry `error`. A step about ONE test (input.testId) additionally gets its own event (a sub-agent
//     of the job), so the trace id stored on each test result points at exactly that test;
//   - failures and outcomes are also signals, so Raindrop can group them for the RSI meta-agent.
// Caveats handled: span properties must be strings, output must be non-empty, payloads are truncated, and no
// telemetry failure ever propagates into the engineering pipeline (every SDK call is guarded).
import { randomUUID } from "node:crypto";
import { Raindrop } from "raindrop-ai";
import type { AiSpan, BeginRunArgs, FlagValue, RunAttachment, Telemetry, ToolSpanResult } from "./index.ts";

const USER = "mongomation-worker";
const MAX = 200_000; // characters per text field (Raindrop limit is 1M; events are 1 MB total)
const MAX_ATTACHMENT = 100_000;
const cut = (s: string, max = MAX) => (s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]` : s);
const strProps = (p: Record<string, unknown> = {}) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
const NEGATIVE = /fail|error|blocked|not_verified|rejected|rolled|exhausted/;
const debug = (m: string) => process.env.RAINDROP_DEBUG === "true" && console.warn(`raindrop: ${m}`);

type Interaction = ReturnType<Raindrop["begin"]>;
/** The subset of the SDK this class uses — lets tests inject a recording fake. */
export type RaindropClient = Pick<Raindrop, "begin" | "resumeInteraction" | "trackAi" | "trackSignal" | "setUserDetails" | "close">;

interface Run {
  interaction: Interaction;
  eventId: string;
  flags: Record<string, FlagValue>;
}

/** Never let observability break engineering. */
function guard<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    debug(err instanceof Error ? err.message : String(err));
    return fallback;
  }
}

export class RaindropTelemetry implements Telemetry {
  readonly enabled = true;
  private rd: RaindropClient;
  private runs = new Map<string, Run>();

  constructor(writeKey: string, client?: RaindropClient) {
    this.rd = client ?? new Raindrop({ writeKey, projectId: process.env.RAINDROP_PROJECT_ID || undefined, debugLogs: process.env.RAINDROP_DEBUG === "true" });
    // Identify the worker so Raindrop's Users view shows which rig / model routing produced the events.
    guard(
      () =>
        this.rd.setUserDetails({
          userId: USER,
          traits: { kind: "engineering_worker", rig: process.env.RIG_ID ?? "default", model_strong: process.env.MODEL_STRONG || "claude-opus-5-5", model_fast: process.env.MODEL_FAST || "claude-sonnet-5-5" },
        }),
      undefined,
    );
  }

  beginRun(runId: string, args: BeginRunArgs) {
    return guard(() => {
      const flags: Record<string, FlagValue> = { ...args.featureFlags };
      if (flags.harness_version === undefined && args.properties?.harness_version !== undefined) flags.harness_version = `v${args.properties.harness_version}`;
      let interaction: Interaction;
      let eventId: string;
      if (args.resumeEventId) {
        // Same job, new process: continue the interaction the crashed attempt began.
        eventId = args.resumeEventId;
        interaction = this.rd.resumeInteraction(eventId);
        interaction.setProperties({ run_id: runId, resumed: true, ...args.properties });
      } else {
        eventId = randomUUID();
        interaction = this.rd.begin({ eventId, event: args.event, userId: USER, convoId: runId, input: cut(args.input), properties: { run_id: runId, ...args.properties } });
      }
      if (Object.keys(flags).length) interaction.setFeatureFlags(flags);
      this.runs.set(runId, { interaction, eventId, flags });
      return eventId;
    }, null);
  }

  async finishRun(runId: string, output: string, properties?: Record<string, FlagValue>) {
    const run = this.runs.get(runId);
    if (!run) return;
    this.runs.delete(runId);
    try {
      if (properties) run.interaction.setProperties(properties);
      await run.interaction.finish({ output: cut(output || "(no output)") });
    } catch (err) {
      debug(`finish: ${String(err)}`);
    }
  }

  /** Link a child event to the job interaction as a detached sub-agent (the dispatch span names the child id). */
  private dispatch(run: Run | undefined, name: string, childEventId: string, input: unknown, properties?: Record<string, string>) {
    if (run) guard(() => run.interaction.subagent({ name, childEventId, input, properties }), undefined);
  }

  private flagsOf(run: Run | undefined) {
    return run && Object.keys(run.flags).length ? { featureFlags: run.flags } : {};
  }

  beginAi(args: { agent: string; model: string; runId: string; input: string }): AiSpan {
    const eventId = randomUUID();
    const run = this.runs.get(args.runId);
    this.dispatch(run, args.agent, eventId, { model: args.model, inputChars: args.input.length }, { agent: args.agent });
    // A real span on the job trace covering this model call, ended when the call finishes or fails.
    const span = run ? guard(() => run.interaction.startSpan({ name: `agent:${args.agent}`, properties: { agent: args.agent, model: args.model, child_event_id: eventId } }), null) : null;
    const parent: Record<string, string> = run ? { parent_event_id: run.eventId } : {};
    return {
      finish: (out) =>
        guard(() => {
          span?.end();
          const ret = this.rd.trackAi({
            eventId,
            event: args.agent,
            userId: USER,
            convoId: args.runId,
            model: out.model,
            input: cut(args.input),
            output: cut(out.output || "(empty)"),
            properties: { run_id: args.runId, agent: args.agent, cost_usd: out.costUsd, latency_ms: out.latencyMs, ...parent },
            ...this.flagsOf(run),
            usage: { provider: "anthropic", inputTokens: out.inputTokens, outputTokens: out.outputTokens },
          });
          return typeof ret === "string" ? ret : null;
        }, null),
      fail: (err) =>
        guard(() => {
          const message = err instanceof Error ? err.message : String(err);
          span?.setStatus({ code: 2, message: message.slice(0, 500) }); // SpanStatusCode.ERROR
          span?.end();
          const ret = this.rd.trackAi({
            eventId,
            event: args.agent,
            userId: USER,
            convoId: args.runId,
            model: args.model,
            input: cut(args.input),
            output: `ERROR: ${message}`,
            properties: { run_id: args.runId, agent: args.agent, failed: true, ...parent },
            ...this.flagsOf(run),
          });
          if (typeof ret === "string") this.rd.trackSignal({ eventId, name: "agent_call_failed", sentiment: "NEGATIVE", properties: { agent: args.agent, error: message.slice(0, 500) } });
        }, undefined),
    };
  }

  tool(args: { name: string; runId: string; input: Record<string, unknown> }, result: ToolSpanResult) {
    return guard(() => {
      const run = this.runs.get(args.runId);
      const testId = typeof args.input.testId === "string" || typeof args.input.testId === "number" ? String(args.input.testId) : null;
      const childEventId = testId ? randomUUID() : null;
      if (run) {
        run.interaction.trackTool({
          name: args.name,
          input: args.input,
          output: { summary: result.summary, evidenceIds: result.evidenceIds ?? [] },
          durationMs: result.durationMs,
          startTime: Date.now() - result.durationMs,
          properties: strProps({ ok: result.ok, ...(childEventId && { child_event_id: childEventId }) }),
          ...(result.ok ? {} : { error: result.summary || `${args.name} failed` }),
        });
        if (!childEventId) return run.eventId;
        this.dispatch(run, args.name, childEventId, args.input, { test_id: testId! });
      }
      // Own event: a per-test step, or a tool call with no job interaction (e.g. a CLI script).
      const eventId = childEventId ?? randomUUID();
      const ret = this.rd.trackAi({
        eventId,
        event: `tool:${args.name}`,
        userId: USER,
        convoId: args.runId,
        input: cut(JSON.stringify(args.input)),
        output: cut(`${result.ok ? "OK" : "FAILED"}: ${result.summary}`),
        properties: {
          run_id: args.runId,
          ok: result.ok,
          duration_ms: result.durationMs,
          evidence_ids: (result.evidenceIds ?? []).join(","),
          ...(run && { parent_event_id: run.eventId }),
          ...(testId && { test_id: testId }),
        },
        ...this.flagsOf(run),
      });
      return typeof ret === "string" ? ret : null;
    }, null);
  }

  signal(args: { runId: string; name: string; eventId?: string | null; properties?: Record<string, unknown> }) {
    guard(() => {
      const eventId = args.eventId ?? this.runs.get(args.runId)?.eventId;
      if (!eventId) return;
      this.rd.trackSignal({ eventId, name: args.name, sentiment: NEGATIVE.test(args.name) ? "NEGATIVE" : "POSITIVE", properties: strProps(args.properties) });
    }, undefined);
  }

  attach(runId: string, attachments: RunAttachment[]) {
    const run = this.runs.get(runId);
    if (!run) return;
    guard(
      () =>
        run.interaction.addAttachments(
          attachments
            .filter((a) => a.value)
            .map((a) =>
              a.type === "code"
                ? { type: "code" as const, name: a.name, value: cut(a.value, MAX_ATTACHMENT), role: a.role ?? "output", ...(a.language && { language: a.language }) }
                : { type: "text" as const, name: a.name, value: cut(a.value, MAX_ATTACHMENT), role: a.role ?? "output" },
            ),
        ),
      undefined,
    );
  }

  async span<T>(runId: string, name: string, fn: () => Promise<T>): Promise<T> {
    const run = this.runs.get(runId);
    if (!run) return fn();
    // withSpan activates the span in the OTel context, so startSpan / trackTool / subagent inside fn become its
    // children. fn's own errors propagate unchanged; only a failure to OPEN the span falls back to running fn bare.
    const out: { ran: boolean; ok?: { value: T }; err?: unknown } = { ran: false };
    try {
      await run.interaction.withSpan({ name, properties: { run_id: runId } }, async () => {
        out.ran = true;
        try {
          out.ok = { value: await fn() };
        } catch (err) {
          out.err = err;
          throw err; // marks the span ERROR
        }
      });
    } catch (err) {
      if (!out.ran) debug(`span ${name}: ${String(err)}`);
    }
    if (out.ok) return out.ok.value;
    if (out.ran) throw out.err;
    return fn(); // the span could not be opened: run the work untraced
  }

  async flush() {
    await this.rd.close();
  }
}
