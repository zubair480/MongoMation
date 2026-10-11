// Builds the real rig clients from the environment (values from Developer 1's hand-off message).
// Missing configuration is an error with a precise message — never a silent fallback to a fake rig.
import type { SceneDefinition } from "@mongomation/types";
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
  const password = need("OPENPLC_PASSWORD");
  const insecure = process.env.OPENPLC_INSECURE_TLS === "true";
  const plc: PlcRuntime =
    flavor === "v3-web"
      ? new OpenPlcV3Web(url, user, password)
      : new OpenPlcRest(url, user, password, flavor, flavor === "v4" ? { scene: () => currentScene, host: need("FACTORYIO_MODBUS_HOST"), port: Number(process.env.FACTORYIO_MODBUS_PORT || 502), slaveId: Number(process.env.FACTORYIO_MODBUS_SLAVE_ID || 1) } : undefined, insecure);
  const sim = new FactoryIoWebApi(need("FACTORYIO_URL"), () => currentScene);
  void refreshScene();
  setInterval(() => void refreshScene().catch(() => {}), 10_000).unref();
  return { plc, sim };
}
