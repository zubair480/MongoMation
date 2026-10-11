import assert from "node:assert/strict";
import { test } from "node:test";
import type { IoPoint } from "@mongomation/types";
import { assembleProgram, heartbeatFor } from "../src/pipeline/st.ts";
import { awaitLink, LinkDownError, parseHeartbeat } from "../src/tools/linkprobe.ts";

const io: IoPoint[] = [
  { variable: "I_Stop", tag: "Stop", address: "%QX13.6", dataType: "BOOL", role: "sensor", activeLow: true, comment: "Stop" },
  { variable: "Q_ConveyorEntry", tag: "Conveyor entry", address: "%QX0.0", dataType: "BOOL", role: "actuator", comment: "Conveyor entry" },
  { variable: "Q_Counter", tag: "Counter", address: "%QW0", dataType: "INT", role: "actuator", comment: "Counter" },
] as IoPoint[];

test("harness appends the heartbeat when the counter is unused or only zeroed", () => {
  const { source } = assembleProgram(io, { variables: [], body: "Q_ConveyorEntry := I_Stop;\nQ_Counter := 0;" }, "t");
  assert.deepEqual(parseHeartbeat(source), { counterTag: "Counter", ncTag: "Stop" });
  assert.match(source, /mm_hb : INT := 0;/);
  assert.match(source, /IF I_Stop THEN\s+Q_Counter := mm_hb \* 2 \+ 1;/);
  // the heartbeat is the LAST write to the counter in the scan
  assert.ok(source.lastIndexOf("Q_Counter := mm_hb") > source.indexOf("Q_Counter := 0;"));
});

test("no heartbeat when the spec really uses the counter", () => {
  const logic = { variables: [], body: "Q_Counter := Q_Counter + 1;" };
  assert.equal(heartbeatFor(io, logic), null);
  assert.equal(parseHeartbeat(assembleProgram(io, logic, "t").source), null);
});

test("no heartbeat without a %QW0 INT output", () => {
  assert.equal(heartbeatFor(io.slice(0, 2), { variables: [], body: "" }), null);
});

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

test("probe waits for two counter changes AND NC parity", async () => {
  const clock = fakeClock();
  // link down (stale 0) for 3 polls, then counter moves but parity says NC input FALSE (PLC not seeing FIO), then OK
  const seq = [0, 0, 0, 4, 6, 9, 11];
  let i = 0;
  const sim = { read: async () => ({ Counter: seq[Math.min(i++, seq.length - 1)], Stop: true }) };
  const r = await awaitLink(sim, { counterTag: "Counter", ncTag: "Stop" }, { ...clock, pollMs: 500, timeoutMs: 10_000 });
  assert.equal(r.polls, 6); // 4 and 6 are even (parity mismatch); 9 is odd and the 2nd+ change
  assert.equal(r.ms, 2500);
});

test("probe times out as LinkDownError when the counter never moves", async () => {
  const clock = fakeClock();
  const sim = { read: async () => ({ Counter: 7, Stop: true }) };
  await assert.rejects(awaitLink(sim, { counterTag: "Counter", ncTag: "Stop" }, { ...clock, timeoutMs: 3000 }), LinkDownError);
});

test("probe survives read errors (gateway 502) and still succeeds", async () => {
  const clock = fakeClock();
  let i = 0;
  const sim = {
    read: async () => {
      i++;
      if (i === 2) throw new Error("HTTP 502");
      return { Counter: i * 2 };
    },
  };
  const r = await awaitLink(sim, { counterTag: "Counter" }, { ...clock, timeoutMs: 10_000 });
  assert.ok(r.polls >= 4);
});
