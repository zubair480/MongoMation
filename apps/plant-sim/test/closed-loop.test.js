// End-to-end closed-loop test against the LOCAL mock PLC only (never the real PLC).
// Starts test/mock-plc.js on :5021 and src/server.js on :5196 (PLANT_SIM_MOCK=1), arms over the WebSocket,
// lets the mock sorter run, and checks: tall boxes leave on the LEFT lane, short on the RIGHT, the counter
// matches, presses reach the input coils, and disarm restores the safe rest state.
// Usage: node test/closed-loop.test.js [seconds=60]
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const SECS = Number(process.argv[2] || 60);
const MOCK_PORT = 5021, SIM_PORT = 5196;
const root = new URL('..', import.meta.url).pathname;
const procs = [];
const run = (args, env = {}) => {
  const p = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.stdout.write(`  [${args[0]}] ${d}`));
  p.stderr.on('data', (d) => process.stdout.write(`  [${args[0]} ERR] ${d}`));
  procs.push(p);
  return p;
};
const fail = (msg) => { console.log(`FAIL: ${msg}`); cleanup(1); };
function cleanup(code) { for (const p of procs) p.kill('SIGTERM'); setTimeout(() => process.exit(code), 800); }

run(['test/mock-plc.js', String(MOCK_PORT)]);
await sleep(500);
run(['src/server.js'], { PLANT_SIM_PORT: String(SIM_PORT), PLC_MODBUS_HOST: '127.0.0.1', PLC_MODBUS_PORT: String(MOCK_PORT), PLANT_SIM_MOCK: '1' });
await sleep(1500);

const ws = new WebSocket(`ws://localhost:${SIM_PORT}`);
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
let last = null, n = 0;
const seen = new Map(); // id -> last box
const exits = []; // { id, tall, lane }
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.t !== 'state') return;
  n++;
  const ids = new Set(m.boxes.map((b) => b.id));
  for (const [id, b] of seen) if (!ids.has(id)) { exits.push({ id, tall: b.tall, lane: b.seg }); seen.delete(id); }
  for (const b of m.boxes) seen.set(b.id, b);
  last = m;
});
const send = (o) => ws.send(JSON.stringify(o));
const waitFor = async (pred, ms, what) => { const t = Date.now(); while (Date.now() - t < ms) { if (last && pred(last)) return; await sleep(20); } fail(`timeout waiting for ${what}`); };

await waitFor((s) => s.plc.connected, 5000, 'PLC connected');
if (last.armed) fail('armed at start');
if (last.plc.source !== 'mock') fail(`plc.source should be mock, got ${last.plc.source}`);
console.log('ok: plc.source = mock');
// read-only first: nothing may be written while disarmed
await sleep(500);
if (last.plcInputs['FACTORY I/O (Running)'] || last.plcInputs['Stop']) fail('inputs were written while disarmed');
console.log('ok: read-only at start, no input coils written');

// press while disarmed must be refused
send({ t: 'press', tag: 'Start', ms: 300 });
await waitFor((s) => /not armed/.test(s.error || ''), 1000, 'press refused while disarmed');
console.log('ok: press refused while disarmed');

send({ t: 'arm', on: true });
await waitFor((s) => s.armed && s.mock, 3000, 'armed (mock)');
await waitFor((s) => s.plcInputs['FACTORY I/O (Running)'] && s.plcInputs['Emergency stop'] && s.plcInputs['Stop'], 2000, 'inputs written after arm');
console.log('ok: armed against the mock; coil 113 TRUE, Stop/E-stop TRUE (NC healthy)');

// Stop is NC: a press pulses coil 110 FALSE
send({ t: 'press', tag: 'Stop', ms: 300 });
await waitFor((s) => s.plcInputs['Stop'] === false, 1000, 'Stop pulse FALSE on coil 110');
await waitFor((s) => s.plcInputs['Stop'] === true, 2000, 'Stop released');
console.log('ok: Stop press pulsed coil 110 FALSE then TRUE');

// latched e-stop halts the mock program's actuators
send({ t: 'estop', latched: true });
await waitFor((s) => s.plcInputs['Emergency stop'] === false && s.tags['Stop light'] && !s.tags['Conveyor entry'], 2000, 'e-stop latched halts the plant');
send({ t: 'estop', latched: false });
await waitFor((s) => s.tags['Conveyor entry'], 2000, 'conveyor back after e-stop release');
console.log('ok: E-stop latch stopped the conveyors and lit the Stop light; release restarted');

console.log(`running the closed loop for ${SECS} s ...`);
const t0 = Date.now(); const n0 = n;
await sleep(SECS * 1000);
const hz = (n - n0) / ((Date.now() - t0) / 1000);
const wrong = exits.filter((e) => (e.tall ? 'left' : 'right') !== e.lane);
console.log(`state rate ${hz.toFixed(1)} Hz; boxes exited: ${exits.length} (left ${exits.filter((e) => e.lane === 'left').length}, right ${exits.filter((e) => e.lane === 'right').length}); mis-sorted ${wrong.length}`);
console.log(`PLC counters: Counter=${last.tags.Counter} tall=${last.diag.tall} short=${last.diag.short} fault=${last.diag.fault} state=${last.diag.state}`);
if (exits.length < 3) fail('fewer than 3 boxes sorted');
if (wrong.length) fail(`mis-sorted boxes: ${JSON.stringify(wrong)}`);
if (last.diag.fault) fail(`mock program fault ${last.diag.fault}`);
const tallExits = exits.filter((e) => e.tall).length;
if (last.diag.tall < tallExits || last.diag.short < exits.length - tallExits) fail('PLC counters below exits');

send({ t: 'arm', on: false });
await waitFor((s) => !s.armed, 2000, 'disarmed');
await sleep(300);
const p = last.plcInputs;
const restOk = !p['FACTORY I/O (Running)'] && p['Stop'] && p['Emergency stop'] && p['At left entry'] && p['At left exit'] && p['At right entry'] && p['At right exit'] && !p['High sensor'] && !p['Low sensor'] && !p['Pallet sensor'] && !p['Loaded'] && !p['Start'] && !p['Reset'] && !p['Auto'];
if (!restOk) fail(`rest state wrong: ${JSON.stringify(p)}`);
console.log('ok: disarm restored the rest state (Stop/E-stop TRUE, eyes TRUE, others FALSE, coil 113 FALSE)');
console.log('PASS');
ws.close();
cleanup(0);
