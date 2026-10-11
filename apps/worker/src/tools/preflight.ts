// Local preflight with the real OpenPLC compiler front-end: MatIEC `iec2c` (ST -> C) followed by `g++ -c` of the
// generated Config0.c / Res0.c, exactly the first steps of OpenPLC_v3/webserver/scripts/compile_program.sh.
// It catches syntax/type errors in seconds without occupying the shared rig. It is NOT the authoritative
// compile: the OpenPLC runtime on AWS still compiles and runs the program (tools/openplc.ts).
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface PreflightResult {
  status: "ok" | "failed" | "unavailable";
  /** Compiler output, trimmed. For "unavailable", the reason (never treated as a pass). */
  log: string;
  durationMs: number;
}

export function preflightConfigured() {
  return Boolean(process.env.IEC2C_PATH && process.env.IEC_LIB);
}

export async function preflight(source: string): Promise<PreflightResult> {
  const started = performance.now();
  const iec2c = process.env.IEC2C_PATH;
  const iecLib = process.env.IEC_LIB;
  const cLib = process.env.OPENPLC_C_LIB;
  if (!iec2c || !iecLib) return { status: "unavailable", log: "IEC2C_PATH / IEC_LIB not set (build matiec: docs/SETUP.md §3)", durationMs: 0 };
  const dir = await mkdtemp(join(tmpdir(), "mm-preflight-"));
  try {
    await writeFile(join(dir, "program.st"), source);
    try {
      const r = await run(iec2c, ["-f", "-l", "-p", "-r", "-R", "-a", "-I", iecLib, "-T", dir, join(dir, "program.st")], { cwd: dir, timeout: 60_000 });
      if (cLib) {
        for (const f of ["Config0.c", "Res0.c"]) await run("g++", ["-std=gnu++11", "-I", cLib, "-c", f, "-o", f.replace(".c", ".o"), "-w"], { cwd: dir, timeout: 120_000 });
      }
      return { status: "ok", log: (r.stdout + r.stderr).trim().slice(-4000), durationMs: Math.round(performance.now() - started) };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string; code?: number | string; signal?: string };
      const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message;
      return { status: "failed", log: out.replaceAll(dir, "<tmp>").slice(-4000), durationMs: Math.round(performance.now() - started) };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
