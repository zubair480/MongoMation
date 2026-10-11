// Model access for every agent. One function, `complete`, returns schema-validated JSON plus the real usage
// and cost of the call. Model routing (fast vs strong) comes from the harness config, so the meta-harness can
// change it and the gate can measure the effect. No mock fallback: if the API is unavailable the call throws.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ModelTier } from "@mongomation/types";
import type { z } from "zod";
import { telemetry } from "../telemetry/index.ts";

export type AgentName = "requirements" | "binder" | "state_machine" | "codegen" | "critic" | "repair" | "meta" | "lesson";

/** $ per million tokens (input, output). Claude API list prices; update if you route elsewhere. */
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};

export const modelFor = (tier: ModelTier) =>
  tier === "strong" ? process.env.MODEL_STRONG || "claude-opus-5-5" : process.env.MODEL_FAST || "claude-sonnet-5-5";

/** Server-side refusal fallback is available on the first-party API for these models. */
const SUPPORTS_FALLBACKS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

let client: Anthropic | null = null;
const api = () => (client ??= new Anthropic({ maxRetries: 3, timeout: 10 * 60_000 }));

export class LlmRefusal extends Error {}

export interface Completion<T> {
  data: T;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  /** Raindrop event id for this call (evidence link), when telemetry is configured. */
  traceId: string | null;
}

export interface CompleteArgs<S extends z.ZodType> {
  agent: AgentName;
  tier: ModelTier;
  system: string;
  user: string;
  schema: S;
  /** Project / run this call belongs to, for traces and cost attribution. */
  runId: string;
  effort?: "low" | "medium" | "high" | "xhigh";
  maxTokens?: number;
}

export async function complete<S extends z.ZodType>(args: CompleteArgs<S>): Promise<Completion<z.infer<S>>> {
  const model = modelFor(args.tier);
  const started = performance.now();
  const span = telemetry.beginAi({ agent: args.agent, model, runId: args.runId, input: `${args.system}\n\n---\n\n${args.user}` });
  try {
    const res = await api().beta.messages.parse({
      model,
      max_tokens: args.maxTokens ?? 16000,
      system: args.system,
      messages: [{ role: "user", content: args.user }],
      output_config: { effort: args.effort ?? (args.tier === "strong" ? "high" : "medium"), format: zodOutputFormat(args.schema) },
      ...(SUPPORTS_FALLBACKS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
    if (res.stop_reason === "refusal") throw new LlmRefusal(`${model} declined the ${args.agent} request`);
    if (res.stop_reason === "max_tokens") throw new Error(`${args.agent}: output hit max_tokens (${args.maxTokens ?? 16000})`);
    if (res.parsed_output == null) throw new Error(`${args.agent}: response did not match the schema`);
    const [pin, pout] = PRICES[res.model] ?? PRICES[model] ?? [0, 0];
    const inputTokens = res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
    const outputTokens = res.usage.output_tokens;
    const costUsd = (res.usage.input_tokens * pin + (res.usage.cache_read_input_tokens ?? 0) * pin * 0.1 + (res.usage.cache_creation_input_tokens ?? 0) * pin * 1.25 + outputTokens * pout) / 1e6;
    const latencyMs = Math.round(performance.now() - started);
    const traceId = span.finish({ output: JSON.stringify(res.parsed_output), model: res.model, inputTokens, outputTokens, costUsd, latencyMs });
    return { data: res.parsed_output as z.infer<S>, model: res.model, inputTokens, outputTokens, costUsd, latencyMs, traceId };
  } catch (err) {
    span.fail(err);
    throw err;
  }
}
