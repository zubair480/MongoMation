// Ports to the real rig on AWS. Concrete clients: tools/openplc.ts and tools/factoryio.ts.
// No implementation in this repo fakes these for demo paths; unit tests use TestDouble* classes under test/.
import type { SimRig } from "@mongomation/checks";

export interface RuntimeStatus {
  reachable: boolean;
  running: boolean;
  programName?: string;
  detail: string;
}

export interface CompileOutcome {
  ok: boolean;
  log: string;
  durationMs: number;
  /** Identifier the runtime gave the uploaded program (file name / id), for reconciliation. */
  runtimeProgram?: string;
}

export interface PlcRuntime {
  readonly label: string; // "OpenPLC v3 @ http://10.0.1.20:8080"
  status(): Promise<RuntimeStatus>;
  /** Upload + compile the program on the runtime (the authoritative OpenPLC toolchain). */
  compile(source: string, programName: string): Promise<CompileOutcome>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface SimTag {
  name: string;
  id: string;
  kind: string; // as reported by Factory I/O
  type: string;
  forced: boolean;
  forcedValue?: boolean | number;
  value?: boolean | number;
}

export interface Simulator extends SimRig {
  readonly label: string;
  health(): Promise<{ reachable: boolean; detail: string; tagCount?: number }>;
  tags(opts?: { timeoutMs?: number; retries?: number }): Promise<SimTag[]>;
  /** Releases forced scene SENSOR tags (never pre-forced outputs). Called on worker start and before every run. */
  releaseAll(): Promise<string[]>;
  /** Scene setup steps around a test suite (stop/restore the box emitter, reset the scene). */
  applySetup(steps: { op: "force" | "release" | "pulse"; tag: string; kind: "Input" | "Output"; value?: boolean | number; ms?: number }[]): Promise<void>;
}
