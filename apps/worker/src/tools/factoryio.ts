// Factory I/O Web API client (Ultimate edition, 2.5.2+; enable with `app.web_server = True`, default port 7410).
// Endpoints per docs/research/factoryio.md + ENDPOINTS.md §5: GET /api/tags, GET /api/tag/values, PUT /api/tag/values,
// PUT /api/tag/values-force/by-name, PUT /api/tag/values-release/by-name. Batch calls return HTTP 200 with per-item {code, error}; every item is checked.
// Rules this client enforces:
//   - Tag names are not unique → ids are resolved by (name, kind); scene sensors are kind Input, actuators Output.
//   - Sensors can't be written, only forced; we never write or force actuators except scene `setup` steps.
//   - releaseAll() only releases INPUT tags we may have forced. Built-in scenes ship Emitter/Remover pre-forced
//     TRUE; a blanket release would silently stop box generation.
//   - HTTP goes through node:http(s), not fetch: Node's fetch silently drops a custom Host header (verified on
//     Node 22), and direct rig access needs `Host: <RIG_FIO_HOST>:7410` (FACTORYIO_HOST_HEADER).
import http from "node:http";
import https from "node:https";
import type { SceneDefinition, TagValue } from "@mongomation/types";
import type { SimTag, Simulator } from "./rig.ts";

/** One Factory I/O Web API request. Shared with scripts/rig-smoke.ts. Rejects on network error / timeout. */
export function fioRequest(
  base: string,
  method: "GET" | "PUT",
  path: string,
  opts: { body?: unknown; timeoutMs?: number; hostHeader?: string; teamKey?: string; insecureTls?: boolean } = {},
): Promise<{ status: number; text: string }> {
  // Gateway base URLs are path-prefixed (https://<gw>/factoryio): string-join, never new URL(path, base) (drops the prefix).
  const url = new URL(base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, ""));
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const headers: Record<string, string> = { accept: "application/json" };
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(payload));
  }
  if (opts.hostHeader) headers.host = opts.hostHeader;
  if (opts.teamKey) headers["x-team-key"] = opts.teamKey;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return new Promise((resolve, reject) => {
    const tls = url.protocol === "https:";
    // The team gateway uses a self-signed certificate; skip verification only when explicitly allowed.
    const req = (tls ? https : http).request(url, { method, headers, ...(tls && opts.insecureTls && { rejectUnauthorized: false }) }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs / 1000}s`)));
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

type Kind = "Input" | "Output";
interface FioTag {
  name: string;
  id: string;
  address: number;
  type: "Bit" | "Int" | "Float";
  kind: Kind;
  value: boolean | number;
  openCircuit: boolean;
  shortCircuit: boolean;
  isForced: boolean;
  forcedValue: boolean | number;
}

export class FactoryIoError extends Error {}

export class FactoryIoWebApi implements Simulator {
  readonly label: string;
  private index: Map<string, FioTag> | null = null;

  constructor(
    private readonly base: string,
    /** Current scene (for name → kind resolution). */
    private readonly scene: () => SceneDefinition | null,
    private readonly timeoutMs = 15_000,
    /** Overrides the HTTP Host header (direct rig access via the public NAT needs `Host: <RIG_FIO_HOST>:7410`). */
    private readonly hostHeader?: string,
    /** Team gateway: X-Team-Key value (TEAM_API_KEY) + self-signed TLS opt-out (FACTORYIO_INSECURE_TLS). */
    private readonly gateway: { teamKey?: string; insecureTls?: boolean } = {},
  ) {
    this.label = `Factory I/O Web API @ ${base}${hostHeader ? ` (Host: ${hostHeader})` : ""}${gateway.teamKey ? " (team key)" : ""}`;
  }

  /**
   * One request with up to `retries` retries (short backoff) on network errors, timeouts and HTTP 5xx.
   * Every Factory I/O call we make is idempotent (GET, or a PUT that sets/forces/releases absolute values).
   * 4xx and per-item errors are not retried.
   */
  private async call<T>(method: "GET" | "PUT", path: string, body?: unknown, retries = 2, timeoutMs = this.timeoutMs): Promise<T> {
    let res: { status: number; text: string };
    for (let attempt = 0; ; attempt++) {
      try {
        // Never send a body with GET; GET /api/tag/values without a body returns every tag.
        res = await fioRequest(this.base, method, path, { body, timeoutMs, hostHeader: this.hostHeader, ...this.gateway });
        if (res.status >= 500 && attempt < retries) throw new Error(`HTTP ${res.status}`);
        break;
      } catch (err) {
        if (attempt >= retries) throw new FactoryIoError(`Factory I/O unreachable at ${this.base}: ${(err as Error).message} (after ${attempt + 1} attempts)`);
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    const text = res.text;
    const ok = res.status >= 200 && res.status < 300;
    let json: unknown = [];
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new FactoryIoError(`Factory I/O ${method} ${path}: non-JSON response (${res.status}) ${text.slice(0, 200)}`);
      }
    }
    if (!ok) throw new FactoryIoError(`Factory I/O ${method} ${path}: HTTP ${res.status} ${(json as { error?: string })?.error ?? text.slice(0, 200)}`);
    const itemErrors = Array.isArray(json) ? (json as { error?: string; code?: number; name?: string; id?: string }[]).filter((i) => i && i.error) : [];
    if (itemErrors.length) throw new FactoryIoError(`Factory I/O ${method} ${path}: ${itemErrors.map((e) => `${e.name ?? e.id}: ${e.code} ${e.error}`).join("; ")}`);
    return json as T;
  }

  private kindOf(name: string, explicit?: Kind): Kind {
    if (explicit) return explicit;
    const t = this.scene()?.tags.find((x) => x.name === name);
    if (t?.fioKind) return t.fioKind;
    return t?.role === "actuator" ? "Output" : "Input";
  }

  private async resolve(name: string, kind?: Kind): Promise<FioTag> {
    const key = `${this.kindOf(name, kind)}:${name}`;
    if (!this.index?.has(key)) await this.refreshIndex();
    const t = this.index!.get(key);
    if (!t) throw new FactoryIoError(`tag "${name}" (${this.kindOf(name, kind)}) not found in the loaded Factory I/O scene`);
    return t;
  }

  private async refreshIndex(opts: { timeoutMs?: number; retries?: number } = {}) {
    const tags = (await this.call<FioTag[]>("GET", "/api/tags", undefined, opts.retries ?? 2, opts.timeoutMs ?? this.timeoutMs)).map((t) => ({ ...t, kind: (String(t.kind).charAt(0).toUpperCase() + String(t.kind).slice(1).toLowerCase()) as FioTag["kind"] }));
    this.index = new Map(tags.map((t) => [`${t.kind}:${t.name}`, t]));
    return tags;
  }

  async health() {
    try {
      const tags = await this.refreshIndex();
      const running = tags.find((t) => t.name === "FACTORY I/O (Running)" && t.kind === "Input");
      const detail = running ? (running.value ? "scene running" : "scene NOT running (Edit/paused)") : "connected (no Running tag)";
      return { reachable: true, detail, tagCount: tags.length };
    } catch (err) {
      return { reachable: false, detail: (err as Error).message };
    }
  }

  /** The live rig monitor polls this every RIG_POLL_MS with {timeoutMs, retries: 0}: fail fast, the next tick retries. */
  async tags(opts: { timeoutMs?: number; retries?: number } = {}): Promise<SimTag[]> {
    const tags = await this.refreshIndex(opts);
    return tags.map((t) => ({ name: t.name, id: t.id, kind: t.kind, type: t.type, forced: t.isForced, forcedValue: t.forcedValue, value: t.value }));
  }

  /**
   * One request per sample: all values, filtered client-side. The test sampler passes {timeoutMs, retries: 0}: a
   * slow read must fail fast instead of retrying with backoff inside one sample (that turned single gateway hiccups
   * into multi-second sampling holes); the sampler's hedge / next tick is the retry.
   */
  async read(names: string[], opts: { timeoutMs?: number; retries?: number } = {}): Promise<Record<string, TagValue>> {
    const wanted = await Promise.all(names.map(async (n) => [n, (await this.resolve(n)).id] as const));
    const values = await this.call<{ id: string; value: TagValue }[]>("GET", "/api/tag/values", undefined, opts.retries ?? 2, opts.timeoutMs ?? this.timeoutMs);
    const byId = new Map(values.map((v) => [v.id, v.value]));
    const out: Record<string, TagValue> = {};
    for (const [n, id] of wanted) if (byId.has(id)) out[n] = byId.get(id)!;
    return out;
  }

  /** True when the name exists as both an Input and an Output tag (e.g. FACTORY I/O (Run)/(Reset)/(Pause)). */
  private ambiguous(name: string) {
    return Boolean(this.index?.has(`Input:${name}`) && this.index?.has(`Output:${name}`));
  }

  // Force/release use the documented /by-name endpoints (ENDPOINTS.md §5). Names that exist twice (Input + Output)
  // can't be addressed by name unambiguously, so only those fall back to the by-id endpoints.
  async force(name: string, value: TagValue, kind?: Kind) {
    const t = await this.resolve(name, kind); // validates the tag exists with the expected kind
    if (this.ambiguous(name)) await this.call("PUT", "/api/tag/values-force", [{ id: t.id, value }]);
    else await this.call("PUT", "/api/tag/values-force/by-name", [{ name: t.name, value }]);
  }

  async release(names: string[], kind?: Kind) {
    if (!names.length) return;
    const tags = await Promise.all(names.map((n) => this.resolve(n, kind)));
    const byId = tags.filter((t) => this.ambiguous(t.name));
    const byName = tags.filter((t) => !this.ambiguous(t.name));
    if (byName.length) await this.call("PUT", "/api/tag/values-release/by-name", byName.map((t) => t.name));
    if (byId.length) await this.call("PUT", "/api/tag/values-release", byId.map((t) => t.id));
  }

  /** Releases forced INPUT tags that belong to the current scene's sensors. Never touches Output-kind forces. */
  async releaseAll(): Promise<string[]> {
    const scene = this.scene();
    const sensorNames = new Set(scene ? scene.tags.filter((t) => t.role === "sensor").map((t) => t.name) : []);
    const forced = (await this.refreshIndex()).filter((t) => t.isForced && t.kind === "Input" && sensorNames.has(t.name));
    if (forced.length) await this.release(forced.map((t) => t.name), "Input");
    return forced.map((t) => t.name);
  }

  /** Scene preparation steps (e.g. stop the pre-forced Emitter, pulse FACTORY I/O (Reset)). */
  async applySetup(steps: SceneDefinition["setup"]["beforeTests"]) {
    for (const s of steps) {
      if (s.op === "force") await this.force(s.tag, s.value ?? true, s.kind);
      else if (s.op === "release") await this.release([s.tag], s.kind);
      else if (s.op === "pulse") {
        // Unmapped Output system tags (Run/Pause/Reset) accept plain writes; a pulse = false → true → false.
        const t = await this.resolve(s.tag, s.kind);
        await this.call("PUT", "/api/tag/values", [{ id: t.id, value: false }]);
        await new Promise((r) => setTimeout(r, 300));
        await this.call("PUT", "/api/tag/values", [{ id: t.id, value: true }]);
        await new Promise((r) => setTimeout(r, s.ms ?? 500));
        await this.call("PUT", "/api/tag/values", [{ id: t.id, value: false }]);
      }
    }
    if (steps.length) await this.ensureRunning();
  }

  /** Tests need the scene in Run mode. `FACTORY I/O (Run)` wants a rising edge (official SDK: false, 500 ms, true). */
  async ensureRunning() {
    const running = async () => (await this.read(["FACTORY I/O (Running)"]).catch(() => ({}) as Record<string, TagValue>))["FACTORY I/O (Running)"] === true;
    if (await running()) return;
    const run = await this.resolve("FACTORY I/O (Run)", "Output");
    await this.call("PUT", "/api/tag/values", [{ id: run.id, value: false }]);
    await new Promise((r) => setTimeout(r, 500));
    await this.call("PUT", "/api/tag/values", [{ id: run.id, value: true }]);
    await new Promise((r) => setTimeout(r, 1000));
    if (!(await running())) throw new FactoryIoError("Factory I/O scene is not in Run mode after a Run rising edge");
  }
}
