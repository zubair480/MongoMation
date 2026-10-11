// OpenPLC clients (sequences verified in docs/research/openplc.md; v4.3.0 flow was run end-to-end there).
//
//   v4 (Runtime ≥ 4.1, HTTPS :8443, JWT):  ST → STruC++ (in-process, npm tarball) → ZIP bundle incl.
//        conf/modbus_master.json → POST /api/upload-file → poll /api/compilation-status → /api/start-plc →
//        poll /api/status until STATUS:RUNNING. A failed on-device build WIPES the running program, so we
//        keep the last good bundle and re-upload it on failure.
//   v3 REST (HTTPS :8443, JWT): raw program.st upload, same status/start paths.
//   v3 web (HTTP :8080, session cookie): /login → /upload-program → /upload-program-action →
//        /compile-program?file= → poll /compilation-logs → /start_plc.
// JWTs live 15 minutes: every call re-logs-in once on 401.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { SceneDefinition } from "@mongomation/types";
import { zipSync, strToU8 } from "fflate";
import { Agent } from "undici";
import type { CompileOutcome, PlcRuntime, RuntimeStatus } from "./rig.ts";

const COMPILE_TIMEOUT_MS = 5 * 60_000;
const run = promisify(execFile);

export interface V4Options {
  /** "master": OpenPLC polls Factory I/O, so every bundle carries conf/modbus_master.json.
   *  "server": Factory I/O is the Modbus client of OpenPLC's server, so the bundle must NOT carry it. */
  modbusMode: "master" | "server";
  /** "strucpp" (in-process npm build) or "docker:<image>" (the rig's own builder, e.g. docker:plc-builder). */
  builder: string;
  /** Factory I/O drops its Modbus link after every upload and reconnects by itself; wait this long after start. */
  relinkMs: number;
}

// --------------------------------------------------------------------------------------------------------
// v3 + v4 REST (JWT)
// --------------------------------------------------------------------------------------------------------

export class OpenPlcRest implements PlcRuntime {
  readonly label: string;
  private token: string | null = null;
  private lastGoodBundle: Uint8Array | null = null;
  private readonly dispatcher?: Agent;

  constructor(
    private readonly base: string,
    private readonly user: string,
    private readonly password: string,
    private readonly flavor: "v3" | "v4",
    /** v4 only: scene + Factory I/O Modbus endpoint, to generate conf/modbus_master.json for every upload. */
    private readonly modbus?: { scene: () => SceneDefinition | null; host: string; port: number; slaveId: number },
    insecureTls = false,
    private readonly v4: V4Options = { modbusMode: "master", builder: "strucpp", relinkMs: 0 },
  ) {
    this.label = `OpenPLC ${flavor} REST @ ${base}`;
    // The runtime ships a self-signed certificate. Inside the VPC you may skip verification explicitly.
    if (insecureTls) this.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  }

  private async raw(method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}, auth = true): Promise<Response> {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (auth) headers.authorization = `Bearer ${await this.login()}`;
    const res = await fetch(`${this.base}${path}`, { method, body: init.body, headers, signal: AbortSignal.timeout(60_000), ...(this.dispatcher && { dispatcher: this.dispatcher }) } as RequestInit);
    if (res.status === 401 && auth) {
      this.token = null;
      headers.authorization = `Bearer ${await this.login()}`;
      return fetch(`${this.base}${path}`, { method, body: init.body, headers, signal: AbortSignal.timeout(60_000), ...(this.dispatcher && { dispatcher: this.dispatcher }) } as RequestInit);
    }
    return res;
  }

  private async json<T>(method: string, path: string, init?: { body?: BodyInit; headers?: Record<string, string> }): Promise<T> {
    const res = await this.raw(method, path, init);
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`OpenPLC ${method} ${path}: HTTP ${res.status} non-JSON: ${text.slice(0, 200)}`);
    }
  }

  private async login(): Promise<string> {
    if (this.token) return this.token;
    const res = await this.raw("POST", "/api/login", { body: JSON.stringify({ username: this.user, password: this.password }), headers: { "content-type": "application/json" } }, false);
    const body = await res.text();
    if (!res.ok) throw new Error(`OpenPLC login failed (${res.status}): ${body.slice(0, 200)}`);
    this.token = (JSON.parse(body) as { access_token: string }).access_token;
    return this.token;
  }

  async status(): Promise<RuntimeStatus> {
    try {
      const s = await this.json<{ status: string }>("GET", "/api/status");
      return { reachable: true, running: s.status === "STATUS:RUNNING", programName: undefined, detail: s.status };
    } catch (err) {
      return { reachable: false, running: false, detail: (err as Error).message };
    }
  }

  private async bundleV4(source: string): Promise<Uint8Array> {
    if (this.v4.builder.startsWith("docker:")) return this.bundleWithDocker(source, this.v4.builder.slice("docker:".length));
    // STruC++ is not on the npm registry: npm i --ignore-scripts https://github.com/Autonomy-Logic/STruCpp/releases/download/v0.7.0/strucpp-0.7.0.tgz
    const pkg = "strucpp/node"; // loadStlibFromFile is only exported from the node entry (0.7.0)
    const sc = (await import(pkg).catch(() => {
      throw new Error("STruC++ not installed (see docs/SETUP.md: npm i --ignore-scripts <strucpp-0.7.0.tgz>) — required for OpenPLC v4 uploads");
    })) as {
      compile: (src: string, o: Record<string, unknown>) => { success: boolean; errors: unknown[]; cppFiles?: { name: string; content: string }[]; cppCode?: string; headerCode: string; debugTableCpp?: string; debugMap?: unknown };
      loadStlibFromFile: (p: string) => unknown;
      buildSourceMap: (f: { fileName: string; source: string }[]) => unknown;
      formatDiagnostic: (d: unknown, sm: unknown) => string;
    };
    const root = join(process.cwd(), "node_modules", "strucpp");
    const md5 = createHash("md5").update(source).digest("hex");
    const libraries = readdirSync(join(root, "libs")).filter((f) => f.endsWith(".stlib")).sort().map((f) => sc.loadStlibFromFile(join(root, "libs", f)));
    const result = sc.compile(source, { headerFileName: "generated.hpp", fileName: "program.st", debug: true, lineMapping: true, libraries, md5, pouIncludes: [] });
    if (!result.success) {
      const sm = sc.buildSourceMap([{ fileName: "program.st", source }]);
      throw new CompileRejected(result.errors.map((e) => sc.formatDiagnostic(e, sm)).join("\n"));
    }
    const files: Record<string, Uint8Array> = {
      "program.st": strToU8(source),
      "generated.hpp": strToU8(result.headerCode),
      "defines.h": strToU8(`#pragma once\n// Program MD5\n#define PROGRAM_MD5 "${md5}"\n`),
      "c_blocks.h": strToU8("// Empty file\n"),
    };
    if (result.cppFiles?.length) for (const f of result.cppFiles) files[f.name] = strToU8(f.content);
    else files["generated.cpp"] = strToU8(result.cppCode ?? "");
    if (result.debugTableCpp !== undefined) files["generated_debug.cpp"] = strToU8(result.debugTableCpp);
    if (result.debugMap !== undefined) files["debug-map.json"] = strToU8(JSON.stringify(result.debugMap));
    const inc = join(root, "src", "runtime", "include");
    for (const f of readdirSync(inc)) files[`strucpp_runtime/include/${f}`] = readFileSync(join(inc, f));
    if (this.v4.modbusMode === "server") return zipSync(files);
    // Master mode: every upload replaces the plugin config; without conf/modbus_master.json the PLC loses its Factory I/O link.
    const scene = this.modbus?.scene();
    if (!scene || !this.modbus) throw new Error("v4 upload needs the scene + FACTORYIO_MODBUS_HOST to generate conf/modbus_master.json");
    files["conf/modbus_master.json"] = strToU8(JSON.stringify(modbusMasterConfig(scene, this.modbus), null, 2));
    return zipSync(files);
  }

  /** Builds program.zip with the rig's own builder image (docker run --rm -v dir:/work <image> /work/main.st /work/out). */
  private async bundleWithDocker(source: string, image: string): Promise<Uint8Array> {
    const dir = mkdtempSync(join(tmpdir(), "mm-plc-"));
    try {
      writeFileSync(join(dir, "main.st"), source);
      try {
        await run("docker", ["run", "--rm", "-v", `${dir}:/work`, image, "/work/main.st", "/work/out"], { timeout: 180_000, maxBuffer: 8 << 20 });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message: string };
        throw new CompileRejected(`${image}: ${(e.stderr || e.stdout || e.message).slice(-4000)}`);
      }
      return new Uint8Array(readFileSync(join(dir, "out", "program.zip")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async compile(source: string, programName: string): Promise<CompileOutcome> {
    const started = performance.now();
    let body: FormData;
    let bundle: Uint8Array | null = null;
    try {
      body = new FormData();
      if (this.flavor === "v4") {
        bundle = await this.bundleV4(source);
        body.append("file", new Blob([new Uint8Array(bundle)], { type: "application/zip" }), "program.zip");
      } else {
        body.append("file", new Blob([source], { type: "text/plain" }), `${programName}.st`);
      }
    } catch (err) {
      if (err instanceof CompileRejected) return { ok: false, log: `STruC++: ${err.message}`, durationMs: Math.round(performance.now() - started) };
      throw err;
    }
    const up = await this.json<{ UploadFileFail: string; CompilationStatus: string }>("POST", "/api/upload-file", { body });
    if (up.UploadFileFail) return { ok: false, log: `upload rejected: ${up.UploadFileFail}`, durationMs: Math.round(performance.now() - started) };
    const deadline = Date.now() + COMPILE_TIMEOUT_MS;
    let logs: string[] = [];
    for (;;) {
      await sleep(1000);
      const st = await this.json<{ status: string; logs: string[] | string; exit_code?: number | null }>("GET", "/api/compilation-status");
      logs = Array.isArray(st.logs) ? st.logs : String(st.logs ?? "").split("\n");
      if (st.status === "SUCCESS") {
        if (bundle) this.lastGoodBundle = bundle;
        return { ok: true, log: logs.join("").slice(-6000), durationMs: Math.round(performance.now() - started), runtimeProgram: programName };
      }
      if (st.status === "FAILED") {
        if (this.flavor === "v4" && this.lastGoodBundle) await this.restoreLastGood();
        return { ok: false, log: logs.filter((l) => /error|ERROR/.test(l)).join("").slice(-6000) || logs.join("").slice(-6000), durationMs: Math.round(performance.now() - started) };
      }
      if (Date.now() > deadline) return { ok: false, log: `compile timed out after ${COMPILE_TIMEOUT_MS / 1000}s\n${logs.join("").slice(-3000)}`, durationMs: Math.round(performance.now() - started) };
    }
  }

  /** v4 wipes the running program when a build fails; put the last good one back so the rig stays usable. */
  private async restoreLastGood() {
    const body = new FormData();
    body.append("file", new Blob([new Uint8Array(this.lastGoodBundle!)], { type: "application/zip" }), "program.zip");
    await this.json("POST", "/api/upload-file", { body }).catch(() => {});
  }

  async start() {
    const deadline = Date.now() + 5000;
    for (;;) {
      const r = await this.json<{ status: string }>("GET", "/api/start-plc");
      if (r.status === "START:OK" || r.status === "START:ERROR_ALREADY_RUNNING") break;
      if (!/BUSY/.test(r.status) || Date.now() > deadline) throw new Error(`start-plc: ${r.status}`);
      await sleep(150);
    }
    const until = Date.now() + 10_000;
    for (;;) {
      const s = await this.status();
      if (s.running) break;
      if (/EMPTY|ERROR/.test(s.detail) || Date.now() > until) throw new Error(`PLC did not reach RUNNING: ${s.detail}`);
      await sleep(200);
    }
    // The rig's Factory I/O reconnects its Modbus client ~60 s after an upload; measuring earlier would grade a dead link.
    if (this.v4.relinkMs > 0) await sleep(this.v4.relinkMs);
  }

  async stop() {
    await this.json("GET", "/api/stop-plc");
  }
}

class CompileRejected extends Error {}

/** conf/modbus_master.json for OpenPLC v4 from the scene's verified address map (contiguous blocks from 0). */
export function modbusMasterConfig(scene: SceneDefinition, mb: { host: string; port: number; slaveId: number }) {
  const bitIndex = (a: string) => {
    const m = /^%[IQ]X(\d+)\.(\d+)$/.exec(a)!;
    return (Number(m[1]) - 100) * 8 + Number(m[2]);
  };
  const wordIndex = (a: string) => Number(/^%[IQ]W(\d+)$/.exec(a)![1]) - 100;
  const di = scene.tags.filter((t) => t.role === "sensor" && t.dataType === "BOOL").map((t) => bitIndex(t.plcAddress));
  const co = scene.tags.filter((t) => t.role === "actuator" && t.dataType === "BOOL").map((t) => bitIndex(t.plcAddress));
  const ir = scene.tags.filter((t) => t.role === "sensor" && t.dataType !== "BOOL").map((t) => wordIndex(t.plcAddress));
  const hr = scene.tags.filter((t) => t.role === "actuator" && t.dataType !== "BOOL").map((t) => wordIndex(t.plcAddress));
  const points = [
    di.length && { fc: 2, offset: "0", iec_location: "%IX100.0", len: Math.max(...di) + 1, cycle_time_ms: 50, error_handling: "set-to-zero" },
    ir.length && { fc: 4, offset: "0", iec_location: "%IW100", len: Math.max(...ir) + 1, cycle_time_ms: 100, error_handling: "keep-last-value" },
    co.length && { fc: 15, offset: "0", iec_location: "%QX100.0", len: Math.max(...co) + 1, cycle_time_ms: 50, error_handling: "keep-last-value" },
    hr.length && { fc: 16, offset: "0", iec_location: "%QW100", len: Math.max(...hr) + 1, cycle_time_ms: 100, error_handling: "keep-last-value" },
  ].filter(Boolean);
  return [{ name: "factoryio", protocol: "MODBUS", config: { type: "SLAVE", transport: "tcp", host: mb.host, port: mb.port, timeout_ms: 1000, slave_id: mb.slaveId, io_points: points } }];
}

// --------------------------------------------------------------------------------------------------------
// v3 legacy web UI (HTTP :8080, session cookie) — for rigs where only the classic UI is available.
// --------------------------------------------------------------------------------------------------------

export class OpenPlcV3Web implements PlcRuntime {
  readonly label: string;
  private cookie: string | null = null;

  constructor(
    private readonly base: string,
    private readonly user: string,
    private readonly password: string,
  ) {
    this.label = `OpenPLC v3 web @ ${base}`;
  }

  private async login() {
    const res = await fetch(`${this.base}/login`, {
      method: "POST",
      body: new URLSearchParams({ username: this.user, password: this.password }),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const set = res.headers.get("set-cookie");
    if (res.status !== 302 || !set) throw new Error(`OpenPLC v3 login failed (HTTP ${res.status})`);
    this.cookie = set.split(";")[0];
  }

  private async req(path: string, init: RequestInit = {}) {
    if (!this.cookie) await this.login();
    const go = () => fetch(`${this.base}${path}`, { ...init, redirect: "manual", headers: { ...(init.headers as Record<string, string>), cookie: this.cookie! }, signal: AbortSignal.timeout(60_000) });
    let res = await go();
    if (res.status === 302 && /login/.test(res.headers.get("location") ?? "")) {
      await this.login();
      res = await go();
    }
    return res;
  }

  async status(): Promise<RuntimeStatus> {
    try {
      const html = await (await this.req("/dashboard")).text();
      const m = /Status:\s*<\/b>\s*([A-Za-z]+)|Status:\s*([A-Za-z]+)/.exec(html);
      const s = (m?.[1] ?? m?.[2] ?? "unknown").toLowerCase();
      return { reachable: true, running: s === "running", detail: `dashboard status: ${s}` };
    } catch (err) {
      return { reachable: false, running: false, detail: (err as Error).message };
    }
  }

  async compile(source: string, programName: string): Promise<CompileOutcome> {
    const started = performance.now();
    const form = new FormData();
    form.append("file", new Blob([source], { type: "text/plain" }), `${programName}.st`);
    const page = await (await this.req("/upload-program", { method: "POST", body: form })).text();
    const progFile = /value=['"]([^'"]+\.st)['"][^>]*id=['"]prog_file['"]/.exec(page)?.[1] ?? /id=['"]prog_file['"][^>]*value=['"]([^'"]+)['"]/.exec(page)?.[1];
    const epoch = /value=['"](\d+)['"][^>]*name=['"]epoch_time['"]/.exec(page)?.[1] ?? /name=['"]epoch_time['"][^>]*value=['"](\d+)['"]/.exec(page)?.[1] ?? String(Math.floor(Date.now() / 1000));
    if (!progFile) return { ok: false, log: "upload-program: could not find prog_file in the response", durationMs: Math.round(performance.now() - started) };
    await this.req("/upload-program-action", { method: "POST", body: new URLSearchParams({ prog_name: programName, prog_descr: "MongoMation", prog_file: progFile, epoch_time: epoch }) });
    await this.req(`/compile-program?file=${encodeURIComponent(progFile)}`);
    const deadline = Date.now() + COMPILE_TIMEOUT_MS;
    for (;;) {
      await sleep(1000);
      const logs = await (await this.req("/compilation-logs")).text();
      if (logs.includes("Compilation finished successfully!")) return { ok: true, log: logs.slice(-6000), durationMs: Math.round(performance.now() - started), runtimeProgram: progFile };
      if (logs.includes("Compilation finished with errors!")) return { ok: false, log: logs.slice(-6000), durationMs: Math.round(performance.now() - started) };
      if (Date.now() > deadline) return { ok: false, log: `compile timed out\n${logs.slice(-3000)}`, durationMs: Math.round(performance.now() - started) };
    }
  }

  async start() {
    await this.req("/start_plc");
    const until = Date.now() + 10_000;
    for (;;) {
      const s = await this.status();
      if (s.running) return;
      if (Date.now() > until) throw new Error(`PLC did not reach Running: ${s.detail}`);
      await sleep(300);
    }
  }

  async stop() {
    await this.req("/stop_plc");
  }
}
