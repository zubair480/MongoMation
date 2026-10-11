// Assembles a realistic sorting controller through the worker's own assembleProgram() using every tag of the
// scene, so the build check covers the exact harness-generated shape (located vars from the live I/O map).
//   npx tsx scripts/fixtures/assemble-sorter.ts > /tmp/sorter.st
import { readFileSync } from "node:fs";
import { assembleProgram, ioTable, lintLogic } from "../../apps/worker/src/pipeline/st.ts";

const scene = JSON.parse(readFileSync("scenes/sorting-by-height-basic.json", "utf8"));
const io = ioTable(scene, [{ bindings: Object.fromEntries(scene.tags.map((t: { name: string }) => [t.name, t.name])) } as never]);
const v = (tag: string) => io.find((p) => p.tag === tag)!.variable;
const logic = {
  variables: [
    { name: "Running", type: "BOOL" as const, initial: "FALSE" },
    { name: "IsTall", type: "BOOL" as const },
    { name: "Phase", type: "INT" as const, initial: "0" },
    { name: "Count", type: "INT" as const, initial: "0" },
    { name: "XferTimer", type: "TON" as const },
    { name: "StartEdge", type: "R_TRIG" as const },
  ],
  body: [
    `StartEdge(CLK := ${v("Start")});`,
    `IF StartEdge.Q THEN Running := TRUE; END_IF;`,
    `IF NOT ${v("Stop")} OR NOT ${v("Emergency stop")} THEN Running := FALSE; Phase := 0; END_IF;`,
    `IF ${v("High sensor")} THEN IsTall := TRUE; END_IF;`,
    `IF Phase = 0 AND ${v("Loaded")} THEN Phase := 1; END_IF;`,
    `XferTimer(IN := Phase = 1, PT := T#3s);`,
    `IF Phase = 1 AND XferTimer.Q THEN Phase := 0; IsTall := FALSE; Count := Count + 1; END_IF;`,
    `${v("Conveyor entry")} := Running AND Phase = 0;`,
    `${v("Load")} := Running AND Phase = 0 AND ${v("Pallet sensor")};`,
    `${v("Unload")} := FALSE;`,
    `${v("Transf. left")} := Running AND Phase = 1 AND IsTall;`,
    `${v("Transf. right")} := Running AND Phase = 1 AND NOT IsTall;`,
    `${v("Conveyor left")} := Running;`,
    `${v("Conveyor right")} := Running;`,
    `${v("Start light")} := Running;`,
    `${v("Reset light")} := FALSE;`,
    `${v("Stop light")} := NOT Running;`,
    ...io.filter((p) => p.role === "actuator" && p.dataType !== "BOOL").map((p) => `${p.variable} := Count;`),
  ].join("\n"),
};
const problems = lintLogic(io, logic);
if (problems.length) console.error("lint:", problems);
console.log(assembleProgram(io, logic, "fixture: sorter via assembleProgram").source);
