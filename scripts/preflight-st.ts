// Compile a .st file with the local MatIEC preflight (same steps as OpenPLC v3's compile_program.sh front end).
//   npm run preflight -- path/to/program.st
import { readFileSync } from "node:fs";
import { preflight } from "../apps/worker/src/tools/preflight.ts";

const file = process.argv[2];
if (!file) throw new Error("usage: npm run preflight -- <program.st>");
const r = await preflight(readFileSync(file, "utf8"));
console.log(`${r.status.toUpperCase()} in ${r.durationMs} ms\n${r.log}`);
process.exit(r.status === "ok" ? 0 : r.status === "unavailable" ? 2 : 1);
