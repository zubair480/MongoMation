// Raindrop telemetry wrapper (write side, SDK mocked) and Query API client (read side, fetch mocked).
import assert from "node:assert/strict";
import { test } from "node:test";
import { RaindropTelemetry, type RaindropClient } from "../src/telemetry/raindrop.ts";
import { formatRaindropEvidence, RaindropQuery, raindropEvidence } from "../src/telemetry/raindrop-query.ts";
import { harnessFlags } from "../src/telemetry/index.ts";

type Call = [string, ...unknown[]];

function fakeSdk() {
  const calls: Call[] = [];
  const span = { end: () => calls.push(["span.end"]), setStatus: (s: unknown) => calls.push(["span.setStatus", s]) };
  const interaction = (id: string) => ({
    setProperties: (p: unknown) => calls.push(["setProperties", id, p]),
    setFeatureFlags: (f: unknown) => calls.push(["setFeatureFlags", id, f]),
    addAttachments: (a: unknown) => calls.push(["addAttachments", id, a]),
    trackTool: (t: unknown) => calls.push(["trackTool", id, t]),
    subagent: (o: { childEventId: string }) => (calls.push(["subagent", id, o]), { childEventId: o.childEventId }),
    startSpan: (p: unknown) => (calls.push(["startSpan", id, p]), span),
    finish: async (o: unknown) => void calls.push(["finish", id, o]),
    withSpan: async (p: unknown, fn: () => Promise<unknown>) => (calls.push(["withSpan", id, p]), fn()),
  });
  const client = {
    begin: (ctx: { eventId: string }) => (calls.push(["begin", ctx]), interaction(ctx.eventId)),
    resumeInteraction: (id: string) => (calls.push(["resumeInteraction", id]), interaction(id)),
    trackAi: (e: { eventId: string }) => (calls.push(["trackAi", e]), e.eventId),
    trackSignal: (s: unknown) => void calls.push(["trackSignal", s]),
    setUserDetails: (u: unknown) => void calls.push(["setUserDetails", u]),
    close: async () => void calls.push(["close"]),
  } as unknown as RaindropClient;
  const of = (name: string) => calls.filter((c) => c[0] === name);
  return { client, calls, of };
}

const config = { version: 3, routing: { requirements: "fast", codegen: "strong", critic: "fast", repair: "strong", escalate_after_failures: 1 }, repair: { strategy: "targeted_patch" }, workflow: { repair_budget: 3 } } as never;

test("job interaction: identify, feature flags, sub-agent per model call with a real span, per-test events", async () => {
  const f = fakeSdk();
  const t = new RaindropTelemetry("wk", f.client);
  assert.equal(f.of("setUserDetails").length, 1);

  const jobEvent = t.beginRun("p1", { event: "engineering_job", input: "spec", properties: { harness_version: 3 }, featureFlags: harnessFlags(config) });
  assert.ok(jobEvent);
  assert.deepEqual(f.of("setFeatureFlags")[0][2], { harness_version: "v3", route_requirements: "fast", route_codegen: "strong", route_critic: "fast", route_repair: "strong", repair_strategy: "targeted_patch", repair_budget: 3 });

  // model call → sub-agent dispatch on the job + span + child trackAi event carrying the flags
  const ai = t.beginAi({ agent: "codegen", model: "m", runId: "p1", input: "x" });
  const aiEvent = ai.finish({ output: "{}", model: "m", inputTokens: 10, outputTokens: 5, costUsd: 0.01, latencyMs: 9 });
  const dispatch = f.of("subagent")[0];
  assert.equal(dispatch[1], jobEvent);
  assert.equal((dispatch[2] as { childEventId: string }).childEventId, aiEvent);
  assert.equal(f.of("startSpan").length, 1);
  assert.equal(f.of("span.end").length, 1);
  const aiTrack = f.of("trackAi")[0][1] as { eventId: string; featureFlags: Record<string, unknown>; properties: Record<string, unknown> };
  assert.equal(aiTrack.featureFlags.harness_version, "v3");
  assert.equal(aiTrack.properties.parent_event_id, jobEvent);

  // job-level tool → span on the job, returns the job id
  assert.equal(t.tool({ name: "openplc_compile", runId: "p1", input: { sourceHash: "h" } }, { ok: false, summary: "boom", durationMs: 5 }), jobEvent);
  assert.equal((f.of("trackTool")[0][2] as { error: string }).error, "boom");

  // per-test tool → its own event id, distinct per test, linked as a sub-agent
  const t1 = t.tool({ name: "simulator_test", runId: "p1", input: { testId: "R1" } }, { ok: true, summary: "R1: passed", durationMs: 5, evidenceIds: ["a"] });
  const t2 = t.tool({ name: "simulator_test", runId: "p1", input: { testId: "R2" } }, { ok: false, summary: "R2: failed", durationMs: 5, evidenceIds: ["b"] });
  assert.ok(t1 && t2 && t1 !== t2 && t1 !== jobEvent);
  assert.equal(f.of("subagent").length, 3);

  t.signal({ runId: "p1", name: "simulator_test_failed", eventId: t2, properties: { testId: "R2" } });
  t.signal({ runId: "p1", name: "repair_budget_exhausted" });
  const sigs = f.of("trackSignal").map((c) => c[1] as { eventId: string; sentiment: string; name: string });
  assert.deepEqual(sigs.map((s) => [s.name, s.eventId, s.sentiment]), [["simulator_test_failed", t2, "NEGATIVE"], ["repair_budget_exhausted", jobEvent, "NEGATIVE"]]);

  t.attach("p1", [{ name: "program.st", value: "PROGRAM", type: "code", language: "pascal" }, { name: "empty", value: "" }]);
  assert.deepEqual(f.of("addAttachments")[0][2], [{ type: "code", name: "program.st", value: "PROGRAM", role: "output", language: "pascal" }]);

  await t.finishRun("p1", "verified", { status: "verified" });
  assert.equal(f.of("finish").length, 1);
});

test("a resumed job continues the earlier interaction instead of starting a new one", () => {
  const f = fakeSdk();
  const t = new RaindropTelemetry("wk", f.client);
  const id = t.beginRun("p2", { event: "engineering_job", input: "spec", resumeEventId: "evt-old" });
  assert.equal(id, "evt-old");
  assert.equal(f.of("begin").length, 0);
  assert.deepEqual(f.of("resumeInteraction")[0], ["resumeInteraction", "evt-old"]);
});

test("span wraps work in a job-level span and preserves results and errors", async () => {
  const f = fakeSdk();
  const t = new RaindropTelemetry("wk", f.client);
  assert.equal(await t.span("none", "x", async () => 7), 7); // no run: untraced
  t.beginRun("p4", { event: "e", input: "i" });
  assert.equal(await t.span("p4", "engineering", async () => 42), 42);
  await assert.rejects(t.span("p4", "engineering", async () => { throw new Error("pipeline failure"); }), /pipeline failure/);
  assert.equal(f.of("withSpan").length, 2);
});

test("telemetry never throws into the pipeline", () => {
  const f = fakeSdk();
  const broken = { ...f.client, trackAi: () => { throw new Error("network"); }, begin: () => { throw new Error("down"); } } as unknown as RaindropClient;
  const t = new RaindropTelemetry("wk", broken);
  assert.equal(t.beginRun("p3", { event: "e", input: "i" }), null);
  assert.equal(t.beginAi({ agent: "a", model: "m", runId: "p3", input: "i" }).finish({ output: "o", model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 }), null);
  assert.equal(t.tool({ name: "x", runId: "p3", input: {} }, { ok: true, summary: "", durationMs: 1 }), null);
});

function fakeFetch(routes: Record<string, unknown>, seen: string[] = []) {
  return (async (url: string, init: { headers: Record<string, string> }) => {
    seen.push(url);
    assert.equal(init.headers.authorization, "Bearer qk");
    const path = new URL(url).pathname;
    const body = routes[path];
    return body === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

test("query client builds a compact evidence summary from signals, error spans and failing events", async () => {
  const seen: string[] = [];
  const client = new RaindropQuery(
    "qk",
    "https://q.example",
    fakeFetch(
      {
        "/v1/events/count": { data: { total: 42 } },
        "/v1/signals": { data: [{ id: "s1", name: "Simulator test failed", sentiment: "NEGATIVE" }, { id: "s2", name: "Project verified", sentiment: "POSITIVE" }] },
        "/v1/events/timeseries": { data: { buckets: [{ timestamp: "2026-10-10", count: 2 }, { timestamp: "2026-10-11", count: 3 }], total: 5 } },
        "/v1/events/error-span-facets": { data: [{ span_type: "TOOL_CALL", span_name: "simulator_test", ai_model: null, event_count: 4 }] },
        "/v1/events": { data: [{ id: "e1", event_name: "engineering_job", timestamp: "t", error_spans: [{ span_name: "simulator_test", status: "ERROR", output_payload: '{"summary":"R6-guard: failed"}' }] }] },
      },
      seen,
    ),
  );
  const ev = await raindropEvidence({ client, windowDays: 7 });
  assert.ok(ev);
  assert.equal(ev.totalEvents, 42);
  assert.equal(ev.signals[0].events, 5);
  assert.deepEqual(ev.signals[0].daily, [2, 3]);
  assert.deepEqual(ev.errorSpans, [{ span: "simulator_test", type: "TOOL_CALL", events: 4 }]);
  assert.equal(ev.failureSamples[0].eventId, "e1");
  assert.ok(seen.some((u) => u.includes("timestamp%5Bgte%5D=")), "time window uses timestamp[gte]");
  const text = formatRaindropEvidence(ev);
  assert.match(text, /42 events in the last 7 days/);
  assert.match(text, /Simulator test failed \[NEGATIVE\]: 5 events/);
  assert.match(text, /R6-guard: failed/);
});

test("query evidence fails soft", async () => {
  assert.equal(await raindropEvidence({ client: null }), null);
  const down = new RaindropQuery("qk", "https://q.example", fakeFetch({}));
  const logs: string[] = [];
  assert.equal(await raindropEvidence({ client: down, log: (m) => logs.push(m) }), null);
  assert.match(logs[0], /HTTP 404/);
  assert.match(formatRaindropEvidence(null), /unavailable/);
});

test("meta-agent prompt carries Raindrop telemetry and per-cluster Raindrop event ids", async () => {
  const { metaUserPrompt } = await import("../src/rsi/meta.ts");
  const prompt = metaUserPrompt(
    {
      harnessVersion: 3,
      projects: 2,
      requirementSatisfaction: 0.5,
      repairsPerProject: 1,
      clusters: [{ pattern: "guard: x", count: 2, projects: 2, runIds: ["r1"], testResultIds: ["t1"], diagnoses: ["d"], raindropEventIds: ["evt-a", "evt-a", "evt-b"] }],
      recentLessons: [],
      raindrop: { source: "raindrop-query-api", windowDays: 7, fetchedAt: "now", totalEvents: 9, signals: [{ id: "s", name: "Simulator test failed", sentiment: "NEGATIVE", events: 4, daily: [4] }], errorSpans: [], failureSamples: [] },
    },
    { version: 3, rules: [] } as never,
  );
  assert.match(prompt, /raindrop events: evt-a, evt-b/);
  assert.match(prompt, /## Raindrop production telemetry/);
  assert.match(prompt, /Simulator test failed \[NEGATIVE\]: 4 events/);
});
