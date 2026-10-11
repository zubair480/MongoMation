// Factory I/O Web API client (Ultimate edition, 2.5.2+; enable with `app.web_server = True`, default port 7410).
// Endpoints per docs/research/factoryio.md: GET /api/tags, GET /api/tag/values, PUT /api/tag/values-force,
// PUT /api/tag/values-release. Batch calls return HTTP 200 with per-item {code, error}; every item is checked.
// Rules this client enforces:
//   - Tag names are not unique → ids are resolved by (name, kind); scene sensors are kind Input, actuators Output.
//   - Sensors can't be written, only forced; we never write or force actuators except scene `setup` steps.
//   - releaseAll() only releases INPUT tags we may have forced. Built-in scenes ship Emitter/Remover pre-forced
//     TRUE; a blanket release would silently stop box generation.
import type { SceneDefinition, TagValue } from "@mongomation/types";
import type { SimTag, Simulator } from "./rig.ts";

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
    private readonly timeoutMs = 3000,
  ) {
    this.label = `Factory I/O Web API @ ${base}`;
  }

  private async call<T>(method: "GET" | "PUT", path: string, body?: unknown): Promise<T> {
    const ctrl = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      // Never send a body with GET (fetch refuses); GET /api/tag/values without a body returns every tag.
      res = await fetch(this.base + path, { method, signal: ctrl, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    } catch (err) {
      throw new FactoryIoError(`Factory I/O unreachable at ${this.base}: ${(err as Error).message}`);
    }
    const text = await res.text();
    let json: unknown = [];
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new FactoryIoError(`Factory I/O ${method} ${path}: non-JSON response (${res.status}) ${text.slice(0, 200)}`);
      }
    }
    if (!res.ok) throw new FactoryIoError(`Factory I/O ${method} ${path}: HTTP ${res.status} ${(json as { error?: string })?.error ?? text.slice(0, 200)}`);
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

  private async refreshIndex() {
    const tags = await this.call<FioTag[]>("GET", "/api/tags");
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

  async tags(): Promise<SimTag[]> {
    const tags = await this.refreshIndex();
    return tags.map((t) => ({ name: t.name, id: t.id, kind: t.kind, type: t.type, forced: t.isForced, forcedValue: t.forcedValue, value: t.value }));
  }

  /** One request per sample: all values, filtered client-side. */
  async read(names: string[]): Promise<Record<string, TagValue>> {
    const wanted = await Promise.all(names.map(async (n) => [n, (await this.resolve(n)).id] as const));
    const values = await this.call<{ id: string; value: TagValue }[]>("GET", "/api/tag/values");
    const byId = new Map(values.map((v) => [v.id, v.value]));
    const out: Record<string, TagValue> = {};
    for (const [n, id] of wanted) if (byId.has(id)) out[n] = byId.get(id)!;
    return out;
  }

  async force(name: string, value: TagValue, kind?: Kind) {
    const t = await this.resolve(name, kind);
    await this.call("PUT", "/api/tag/values-force", [{ id: t.id, value }]);
  }

  async release(names: string[], kind?: Kind) {
    if (!names.length) return;
    const ids = await Promise.all(names.map(async (n) => (await this.resolve(n, kind)).id));
    await this.call("PUT", "/api/tag/values-release", ids);
  }

  /** Releases forced INPUT tags that belong to the current scene's sensors. Never touches Output-kind forces. */
  async releaseAll(): Promise<string[]> {
    const scene = this.scene();
    const sensorNames = new Set(scene ? scene.tags.filter((t) => t.role === "sensor").map((t) => t.name) : []);
    const forced = (await this.refreshIndex()).filter((t) => t.isForced && t.kind === "Input" && sensorNames.has(t.name));
    if (forced.length) await this.call("PUT", "/api/tag/values-release", forced.map((t) => t.id));
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
