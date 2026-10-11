// Offline check of the worker's real OpenPLC v4 bundle path (OpenPlcRest.bundleV4), no network.
//   npx tsx scripts/fixtures/build-check.ts [file.st ...] [--mode server|master] [--out dir]
// Run from the repo root (bundleV4 resolves node_modules/strucpp from process.cwd()).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { unzipSync } from "fflate";
import { OpenPlcRest } from "../../apps/worker/src/tools/openplc.ts";

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const mode = (opt("--mode") ?? "server") as "server" | "master";
const out = opt("--out");
const files = args.length ? args : ["scripts/fixtures/minimal.st"];
const scene = JSON.parse(readFileSync("scenes/sorting-by-height-basic.json", "utf8"));

const plc = new OpenPlcRest("https://offline.invalid", "x", "x", "v4",
  { scene: () => scene, host: "127.0.0.1", port: 502, slaveId: 1 }, true,
  { modbusMode: mode, builder: "strucpp", relinkMs: 0 });

let failed = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  try {
    // bundleV4 is TS-private; call it directly to exercise the exact production code path.
    const zip: Uint8Array = await (plc as unknown as { bundleV4(s: string): Promise<Uint8Array> }).bundleV4(src);
    const entries = unzipSync(zip);
    console.log(`OK ${f} -> program.zip ${zip.length} bytes, ${Object.keys(entries).length} entries (mode=${mode})`);
    for (const [n, b] of Object.entries(entries)) if (!n.startsWith("strucpp_runtime/")) console.log(`   ${String(b.length).padStart(8)}  ${n}`);
    console.log(`   (+ ${Object.keys(entries).filter((n) => n.startsWith("strucpp_runtime/")).length} strucpp_runtime/include/* headers)`);
    if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, basename(f, ".st") + ".zip"), zip); }
  } catch (err) {
    failed++;
    console.log(`FAIL ${f}: ${(err as Error).name}: ${(err as Error).message.slice(0, 1500)}`);
  }
}
process.exit(failed ? 1 : 0);
