// Structured Text assembly and static checks. The harness — not the model — writes every located variable
// declaration from the scene's verified I/O map, so a generated program can never invent an address.
// The model supplies internal variables and the logic body; the harness wraps them in the OpenPLC-compatible
// PROGRAM / CONFIGURATION boilerplate.
import { createHash } from "node:crypto";
import type { BoundRequirement, IoPoint, SceneDefinition } from "@mongomation/types";
import { HEARTBEAT_MARK } from "../tools/linkprobe.ts";

export const PROGRAM_NAME = "mongomation_main";

const ident = (tagName: string, prefix: string) =>
  prefix +
  tagName
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");

/** I/O table for the tags a project actually uses (all bound tags; plus every actuator, so all outputs are driven). */
export function ioTable(scene: SceneDefinition, reqs: BoundRequirement[]): IoPoint[] {
  const used = new Set(reqs.flatMap((r) => Object.values(r.bindings)));
  for (const t of scene.tags) if (t.role === "actuator") used.add(t.name);
  return scene.tags
    .filter((t) => used.has(t.name))
    .map((t) => ({
      variable: ident(t.name, t.role === "sensor" ? "I_" : "Q_"),
      tag: t.name,
      address: t.plcAddress,
      dataType: t.dataType,
      role: t.role,
      activeLow: t.activeLow,
      comment: `${t.name}${t.activeLow ? " (active-low: FALSE when pressed/blocked)" : ""}`,
    }));
}

/** IEC 61131-3 keywords MatIEC rejects as identifiers (STEP is the classic trap, from SFC). */
export const RESERVED = new Set(
  "ABS ACTION AND ANY ARRAY AT BOOL BY BYTE CASE CONFIGURATION CONSTANT DATE DINT DO DT DWORD ELSE ELSIF EN END_ACTION END_CASE END_CONFIGURATION END_FOR END_FUNCTION END_FUNCTION_BLOCK END_IF END_PROGRAM END_REPEAT END_RESOURCE END_STEP END_STRUCT END_TRANSITION END_TYPE END_VAR END_WHILE ENO EXIT FALSE FOR FROM FUNCTION FUNCTION_BLOCK IF INITIAL_STEP INT INTERVAL LINT LREAL LWORD MOD NOT OF ON OR PRIORITY PROGRAM READ_ONLY READ_WRITE REAL REPEAT RESOURCE RETAIN RETURN SINT STEP STRING STRUCT TASK THEN TIME TO TOD TRANSITION TRUE TYPE UDINT UINT ULINT UNTIL USINT VAR VAR_ACCESS VAR_CONFIG VAR_EXTERNAL VAR_GLOBAL VAR_INPUT VAR_IN_OUT VAR_OUTPUT VAR_TEMP WHILE WITH WORD XOR".split(" "),
);

export const ALLOWED_TYPES = ["BOOL", "INT", "DINT", "UINT", "REAL", "TIME", "TON", "TOF", "TP", "R_TRIG", "F_TRIG", "CTU", "CTD", "SR", "RS"] as const;

export interface GeneratedLogic {
  variables: { name: string; type: (typeof ALLOWED_TYPES)[number]; initial?: string | null; comment?: string | null }[];
  body: string;
}

/**
 * Harness-owned Modbus link heartbeat (see tools/linkprobe.ts). Only when the scene exposes an INT output at %QW0
 * and the generated logic does not use it (absent, or only `X := 0;`), so a spec that really uses the counter keeps it.
 */
export function heartbeatFor(io: IoPoint[], logic: GeneratedLogic): { counter: IoPoint; nc?: IoPoint } | null {
  const counter = io.find((p) => p.role === "actuator" && p.address === "%QW0" && p.dataType === "INT");
  if (!counter || logic.variables.some((v) => v.name.toLowerCase() === "mm_hb")) return null;
  const re = new RegExp(`\\b${counter.variable}\\b`);
  const zero = new RegExp(`^\\s*${counter.variable}\\s*:=\\s*0\\s*;\\s*(\\(\\*.*\\*\\))?\\s*$`);
  if (logic.body.split("\n").some((l) => re.test(l) && !zero.test(l))) return null;
  const nc = io.find((p) => p.role === "sensor" && p.activeLow && p.dataType === "BOOL");
  return { counter, ...(nc ? { nc } : {}) };
}

export function assembleProgram(io: IoPoint[], logic: GeneratedLogic, header: string) {
  const located = io.map((p) => `    ${p.variable} AT ${p.address} : ${p.dataType}; (* ${p.comment} *)`).join("\n");
  const hb = heartbeatFor(io, logic);
  const internal = [
    ...logic.variables.map((v) => `    ${v.name} : ${v.type}${v.initial ? ` := ${v.initial}` : ""};${v.comment ? ` (* ${v.comment.replace(/\*\)/g, "")} *)` : ""}`),
    ...(hb ? ["    mm_hb : INT := 0; (* harness: Modbus link heartbeat *)"] : []),
  ].join("\n");
  const heartbeat = hb
    ? [
        `(* ${HEARTBEAT_MARK} counter="${hb.counter.tag}"${hb.nc ? ` nc="${hb.nc.tag}"` : ""} *)`,
        `(* Harness-owned link probe, not control logic: ${hb.counter.tag} = scan counter * 2 + ${hb.nc ? `${hb.nc.tag} input` : "0"} *)`,
        "mm_hb := mm_hb + 1;",
        "IF mm_hb >= 500 THEN",
        "  mm_hb := 0;",
        "END_IF;",
        ...(hb.nc
          ? [`IF ${hb.nc.variable} THEN`, `  ${hb.counter.variable} := mm_hb * 2 + 1;`, "ELSE", `  ${hb.counter.variable} := mm_hb * 2;`, "END_IF;"]
          : [`${hb.counter.variable} := mm_hb * 2;`]),
      ]
    : [];
  const body = [...logic.body.split("\n"), ...heartbeat]
    .map((l) => `  ${l}`)
    .join("\n");
  const source = `(* ${header.replace(/\*\)/g, "")} *)
PROGRAM ${PROGRAM_NAME}
  VAR
${located}
  END_VAR
  VAR
${internal || "    mm_unused : BOOL;"}
  END_VAR
${body}
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : ${PROGRAM_NAME};
  END_RESOURCE
END_CONFIGURATION
`;
  return { source, sourceHash: createHash("sha256").update(source).digest("hex") };
}

/**
 * Static checks that run before any compiler: cheap, deterministic, and they explain themselves.
 * They do not replace compilation — the real OpenPLC toolchain is still the authority.
 */
export function lintLogic(io: IoPoint[], logic: GeneratedLogic): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  const body = logic.body.replace(/\(\*[\s\S]*?\*\)/g, " ").replace(/\/\/.*$/gm, " ");
  for (const v of logic.variables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name)) problems.push(`invalid identifier "${v.name}"`);
    if (RESERVED.has(v.name.toUpperCase())) problems.push(`"${v.name}" is a reserved IEC 61131-3 keyword; rename it`);
    if (names.has(v.name.toUpperCase())) problems.push(`duplicate variable "${v.name}"`);
    names.add(v.name.toUpperCase());
    if (io.some((p) => p.variable.toUpperCase() === v.name.toUpperCase())) problems.push(`"${v.name}" redeclares an I/O point`);
    if (!(ALLOWED_TYPES as readonly string[]).includes(v.type)) problems.push(`type ${v.type} of "${v.name}" is not allowed`);
  }
  for (const p of io.filter((x) => x.role === "sensor")) {
    if (new RegExp(`\\b${p.variable}\\s*:=`, "i").test(body)) problems.push(`writes to input ${p.variable} (${p.tag}); inputs are read-only`);
  }
  for (const p of io.filter((x) => x.role === "actuator")) {
    if (!new RegExp(`\\b${p.variable}\\s*:=`, "i").test(body)) problems.push(`output ${p.variable} (${p.tag}) is never assigned`);
  }
  if (/\b(WHILE|REPEAT)\b/i.test(body)) problems.push("WHILE/REPEAT loops are not allowed in scan logic");
  if (/\bAT\s+%[IQM]/i.test(body)) problems.push("located variables must not be declared in the body");
  if (/\b(PROGRAM|END_PROGRAM|CONFIGURATION|RESOURCE|VAR_GLOBAL)\b/i.test(body)) problems.push("body must contain statements only (no PROGRAM/CONFIGURATION/VAR blocks)");
  return problems;
}

/** Unified-style line diff for the dashboard and the evidence ledger (small programs, so O(n*m) is fine). */
export function lineDiff(a: string, b: string): string {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push(`  ${x[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push(`- ${x[i++]}`);
    else out.push(`+ ${y[j++]}`);
  }
  while (i < n) out.push(`- ${x[i++]}`);
  while (j < m) out.push(`+ ${y[j++]}`);
  return out.join("\n");
}
