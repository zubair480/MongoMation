// Read side of Raindrop: a small client for the Raindrop Query API (https://query.raindrop.ai, Bearer
// RAINDROP_QUERY_API_KEY) and the compact summary the RSI meta-agent reads. Endpoints and parameter syntax were
// verified against the live API: GET /v1/signals, /v1/events/count?signal=&timestamp[gte]=,
// /v1/events/timeseries?interval=day, /v1/events/error-span-facets?span_type=TOOL_CALL, /v1/events?signal=&limit=.
// Fail-soft: any error (no key, network, 4xx/5xx, timeout) yields null — the RSI loop then runs on Atlas evidence
// alone and says so in its prompt.

const DEFAULT_URL = "https://query.raindrop.ai";
const TIMEOUT_MS = 10_000;

export interface RaindropSignal {
  id: string;
  name: string;
  type?: string;
  sentiment?: "POSITIVE" | "NEGATIVE" | string;
  group_name?: string | null;
}
export interface RaindropErrorSpanFacet {
  span_type: string;
  span_name: string;
  ai_model: string | null;
  event_count: number;
  user_count?: number;
}
export interface RaindropEventRow {
  id: string;
  event_name: string;
  convo_id?: string;
  timestamp: string;
  signals?: { id: string; name: string }[];
  error_spans?: { span_name: string; status: string; output_payload?: string }[];
  properties?: Record<string, unknown>;
}

export interface RaindropEvidence {
  source: "raindrop-query-api";
  windowDays: number;
  fetchedAt: string;
  totalEvents: number;
  /** Signals with their event counts in the window, most frequent first (negative first on ties). */
  signals: { id: string; name: string; sentiment: string; events: number; daily: number[] }[];
  /** Spans that errored, ranked by number of affected events. */
  errorSpans: { span: string; type: string; events: number }[];
  /** Concrete failing tool outputs from events carrying negative signals: what the failures actually said. */
  failureSamples: { eventId: string; event: string; signal: string; span: string; output: string }[];
}

export class RaindropQuery {
  constructor(
    private apiKey: string,
    private baseUrl = DEFAULT_URL,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  static fromEnv(): RaindropQuery | null {
    const key = process.env.RAINDROP_QUERY_API_KEY;
    return key ? new RaindropQuery(key, process.env.RAINDROP_QUERY_URL || DEFAULT_URL) : null;
  }

  async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
    const url = `${this.baseUrl}${path}${qs.size ? `?${qs}` : ""}`;
    const res = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${this.apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`raindrop query ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async signals(limit = 100) {
    return (await this.get<{ data: RaindropSignal[] }>("/v1/signals", { limit })).data;
  }
  async countEvents(f: { signal?: string; since?: Date; eventName?: string } = {}) {
    return (await this.get<{ data: { total: number } }>("/v1/events/count", { signal: f.signal, event_name: f.eventName, "timestamp[gte]": f.since?.toISOString() })).data.total;
  }
  async timeseries(f: { signal?: string; since?: Date; interval?: "hour" | "day" } = {}) {
    return (await this.get<{ data: { buckets: { timestamp: string; count: number }[]; total: number } }>("/v1/events/timeseries", { signal: f.signal, interval: f.interval ?? "day", "timestamp[gte]": f.since?.toISOString() })).data;
  }
  async errorSpanFacets(spanType: "TOOL_CALL" | "LLM_GENERATION" | "INTERNAL" = "TOOL_CALL") {
    return (await this.get<{ data: RaindropErrorSpanFacet[] }>("/v1/events/error-span-facets", { span_type: spanType })).data;
  }
  async events(f: { signal?: string; limit?: number; since?: Date; eventName?: string } = {}) {
    return (await this.get<{ data: RaindropEventRow[] }>("/v1/events", { signal: f.signal, limit: f.limit ?? 10, event_name: f.eventName, "timestamp[gte]": f.since?.toISOString() })).data;
  }
  async event(id: string) {
    return (await this.get<{ data: RaindropEventRow }>(`/v1/events/${encodeURIComponent(id)}`)).data;
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Compact, prompt-sized summary of what Raindrop observed. Null when the Query API is unavailable. */
export async function raindropEvidence(opts: { windowDays?: number; client?: RaindropQuery | null; log?: (m: string) => void } = {}): Promise<RaindropEvidence | null> {
  const client = opts.client === undefined ? RaindropQuery.fromEnv() : opts.client;
  if (!client) return null;
  const windowDays = opts.windowDays ?? 7;
  const since = new Date(Date.now() - windowDays * 86_400_000);
  try {
    const [total, signals, facets] = await Promise.all([client.countEvents({ since }), client.signals(), client.errorSpanFacets("TOOL_CALL").catch(() => [])]);
    const counted = await Promise.all(
      signals.map(async (s) => {
        const ts = await client.timeseries({ signal: s.id, since }).catch(() => null);
        return { id: s.id, name: s.name, sentiment: String(s.sentiment ?? "OTHER"), events: ts?.total ?? 0, daily: ts?.buckets.map((b) => b.count) ?? [] };
      }),
    );
    counted.sort((a, b) => b.events - a.events || Number(b.sentiment === "NEGATIVE") - Number(a.sentiment === "NEGATIVE"));
    const failureSamples: RaindropEvidence["failureSamples"] = [];
    for (const s of counted.filter((x) => x.sentiment === "NEGATIVE" && x.events > 0).slice(0, 3)) {
      const rows = await client.events({ signal: s.id, limit: 3, since }).catch(() => []);
      for (const e of rows)
        for (const sp of (e.error_spans ?? []).slice(0, 4)) failureSamples.push({ eventId: e.id, event: e.event_name, signal: s.name, span: sp.span_name, output: clip(sp.output_payload ?? "", 240) });
    }
    return {
      source: "raindrop-query-api",
      windowDays,
      fetchedAt: new Date().toISOString(),
      totalEvents: total,
      signals: counted.slice(0, 12),
      errorSpans: facets.slice(0, 10).map((f) => ({ span: f.span_name, type: f.span_type, events: f.event_count })),
      failureSamples: failureSamples.slice(0, 12),
    };
  } catch (err) {
    opts.log?.(`raindrop query unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Prompt section for the meta-agent. */
export function formatRaindropEvidence(r: RaindropEvidence | null | undefined): string {
  if (!r) return "(Raindrop Query API unavailable — no production telemetry in this round)";
  const sig = r.signals.length ? r.signals.map((s) => `- ${s.name} [${s.sentiment}]: ${s.events} events${s.daily.length > 1 ? ` (daily ${s.daily.join(",")})` : ""}`).join("\n") : "- (no signals)";
  const spans = r.errorSpans.length ? r.errorSpans.map((s) => `- ${s.span} (${s.type}): failed in ${s.events} events`).join("\n") : "- (no error spans)";
  const samples = r.failureSamples.length ? r.failureSamples.map((s) => `- [${s.signal}] ${s.span} @ event ${s.eventId}: ${s.output}`).join("\n") : "- (none)";
  return `${r.totalEvents} events in the last ${r.windowDays} days.
Signals:
${sig}
Failing spans:
${spans}
Failure samples:
${samples}`;
}
