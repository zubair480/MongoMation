// Builds the real rig clients from the environment (values from Developer 1's hand-off message).
// Missing configuration is an error with a precise message — never a silent fallback to a fake rig.
import type { SceneDefinition } from "@mongomation/types";
import { connect as netConnect } from "node:net";
import { col } from "../db/index.ts";
import { FactoryIoWebApi } from "./factoryio.ts";
import { OpenPlcRest, OpenPlcV3Web } from "./openplc.ts";
import type { PlcRuntime, Simulator } from "./rig.ts";

let currentScene: SceneDefinition | null = null;

/** Keeps the clients' view of the scene (tag kinds, address map) in sync with Atlas. */
export async function refreshScene() {
  const id = process.env.SCENE_ID;
  const doc = id ? await col.scenes().findOne({ id }) : null;
  if (doc) {
    const { _id, ...scene } = doc;
    currentScene = scene as unknown as SceneDefinition;
  }
  return currentScene;
}

export function createRig(): { plc: PlcRuntime; sim: Simulator } {
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`${k} is not set — get it from Developer 1 (docs/INTEGRATION_CONTRACT.md §2 hand-off)`);
    return v;
  };
  const flavor = (process.env.OPENPLC_FLAVOR || "v4") as "v3" | "v4" | "v3-web";
  const url = need("OPENPLC_URL");
  const user = need("OPENPLC_USER");
  // ALLOW_NO_RIG=1 (opt-in, default off): start without the rig password so the LLM/codegen stages run; rig stages go BLOCKED.
  const allowNoRig = process.env.ALLOW_NO_RIG === "1";
  const password = allowNoRig ? (process.env.OPENPLC_PASSWORD ?? "") : need("OPENPLC_PASSWORD");
  const insecure = process.env.OPENPLC_INSECURE_TLS === "true";
  // TEAM_API_KEY: the rig's HTTPS gateway (path-prefixed URLs) requires X-Team-Key on every OpenPLC + Factory I/O call.
  const teamKey = process.env.TEAM_API_KEY || undefined;
  // OPENPLC_MODBUS_MODE=server: Factory I/O is the Modbus client of OpenPLC (the AWS rig); master: OpenPLC polls Factory I/O.
  const modbusMode = (process.env.OPENPLC_MODBUS_MODE || "server") as "master" | "server";
  if (modbusMode !== "master" && modbusMode !== "server") throw new Error(`OPENPLC_MODBUS_MODE must be master or server, got ${modbusMode}`);
  const v4 = { modbusMode, builder: process.env.OPENPLC_BUILDER || "strucpp", relinkMs: Number(process.env.FACTORYIO_RELINK_MS ?? (modbusMode === "server" ? 65_000 : 0)) };
  const master = flavor === "v4" && modbusMode === "master" ? { scene: () => currentScene, host: need("FACTORYIO_MODBUS_HOST"), port: Number(process.env.FACTORYIO_MODBUS_PORT || 502), slaveId: Number(process.env.FACTORYIO_MODBUS_SLAVE_ID || 1) } : undefined;
  const runtime: PlcRuntime =
    flavor === "v3-web"
      ? new OpenPlcV3Web(url, user, password)
      : new OpenPlcRest(url, user, password, flavor, master, insecure, v4, teamKey);
  const plc = allowNoRig ? failFastWhenUnreachable(runtime, url, Number(process.env.OPENPLC_CONNECT_TIMEOUT_MS || 3000)) : runtime;
  // FACTORYIO_HOST_HEADER: only for direct NAT access (leave unset with the gateway). FACTORYIO_INSECURE_TLS: self-signed gateway cert.
  const sim = new FactoryIoWebApi(need("FACTORYIO_URL"), () => currentScene, Number(process.env.FACTORYIO_TIMEOUT_MS || 15000), process.env.FACTORYIO_HOST_HEADER || undefined, {
    teamKey,
    insecureTls: process.env.FACTORYIO_INSECURE_TLS === "true",
  });
  void refreshScene();
  setInterval(() => void refreshScene().catch(() => {}), 10_000).unref();
  return { plc, sim };
}

/** TCP connect probe; resolves to null when reachable, else the error code (ETIMEDOUT, ECONNREFUSED, ...). */
function probe(url: string, timeoutMs: number): Promise<string | null> {
  const u = new URL(url);
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  return new Promise((resolve) => {
    const s = netConnect({ host: u.hostname, port });
    const done = (r: string | null) => (s.destroy(), resolve(r));
    s.setTimeout(timeoutMs, () => done("ETIMEDOUT"));
    s.once("connect", () => done(null));
    s.once("error", (e: NodeJS.ErrnoException) => done(e.code ?? "ECONNREFUSED"));
  });
}

/** ALLOW_NO_RIG only: probe OpenPLC with a short TCP timeout before talking to it, so a dead host fails in seconds
 *  (with an ETIMEDOUT/ECONNREFUSED error the pipeline maps to BLOCKED) instead of waiting 60 s per request.
 *  The local STruC++ build still runs first: a genuine compile rejection stays a compile failure (ok:false). */
function failFastWhenUnreachable(plc: PlcRuntime, url: string, timeoutMs: number): PlcRuntime {
  // Never put the host/IP in this text: it is stored in Atlas and shown on the public dashboard.
  const down = async () => {
    const code = await probe(url, timeoutMs);
    return code ? `rig unreachable: TCP connect to OpenPLC (OPENPLC_URL) failed (${code}, ${timeoutMs} ms probe)` : null;
  };
  return {
    label: plc.label,
    async status() {
      const d = await down();
      return d ? { reachable: false, running: false, detail: d } : plc.status();
    },
    async compile(source, programName) {
      const d = await down();
      if (!d) return plc.compile(source, programName);
      const started = performance.now();
      const local = (plc as unknown as { bundleV4?: (s: string) => Promise<Uint8Array> }).bundleV4;
      let built = "no local build for this flavor";
      if (local) {
        try {
          built = `local STruC++ build OK (${(await local.call(plc, source)).length} bytes)`;
        } catch (err) {
          if ((err as Error).constructor?.name === "CompileRejected") return { ok: false, log: `STruC++: ${(err as Error).message}`, durationMs: Math.round(performance.now() - started) };
          throw err;
        }
      }
      throw new Error(`${d}; ${built}; upload skipped`);
    },
    async start() {
      const d = await down();
      if (d) throw new Error(d);
      return plc.start();
    },
    async stop() {
      const d = await down();
      if (d) throw new Error(d);
      return plc.stop();
    },
  };
}
