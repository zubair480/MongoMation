// Plant simulator service: physics on the server, closed-loop with OpenPLC over Modbus TCP,
// WebSocket state stream on ws://localhost:5195 (+ GET /health). See README.md and
// prototype/ui-redesign/PLANT_SIM_CONTRACT.md for the protocol and the safety rules.
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { setTimeout as sleep } from 'node:timers/promises';
import { Plant, GEOMETRY } from './physics.js';
import { PlcLink } from './plc.js';
import { AtlasGuard } from './guard.js';
import { INPUTS, OUTPUTS, restInputs } from './iomap.js';

const PORT = Number(process.env.PLANT_SIM_PORT || 5195);
const PLC_HOST = process.env.PLC_MODBUS_HOST || '127.0.0.1';
const PLC_PORT = Number(process.env.PLC_MODBUS_PORT || 5020); // default: the SSM port-forward of the rig's :502
const PLC_UNIT = Number(process.env.PLC_MODBUS_UNIT || 1);
const READ_MS = 50, PHYS_MS = 20, PUSH_MS = 50, GUARD_MS = 5000, REFRESH_WRITE_MS = 1000;
const MOCK_ALLOWED = process.env.PLANT_SIM_MOCK === '1';
const MOCK_MARKER = [0x4d4b, 0x4f43]; // "MKOC" at HR 1000..1001, only the bundled mock server exposes it
const isLoopback = /^(127\.|localhost$|::1$)/.test(PLC_HOST);
const hostLabel = isLoopback ? `localhost:${PLC_PORT}` : '<redacted>';

const log = (...a) => console.log(new Date().toISOString(), ...a);

const plant = new Plant(GEOMETRY);
const plc = new PlcLink({ host: PLC_HOST, port: PLC_PORT, unitId: PLC_UNIT });
const guard = new AtlasGuard();

let armed = false;
let mockTarget = false; // Atlas guard skipped (PLANT_SIM_MOCK=1 + loopback + marker)
let plcSource = null; // 'mock' | 'real', from the marker, probed on every (re)connect
let estopLatched = false;
const presses = new Map(); // tag -> release time (ms)
let lastWritten = null, lastWrittenAt = 0, mismatchReads = 0;
let error = null, errorAt = 0;
let arming = false;

function setError(msg) { error = msg; errorAt = Date.now(); log('error:', msg); }

/** Operator panel values as the PLC should see them (NC buttons pulse FALSE). */
function operatorInputs(now = Date.now()) {
  const held = (t) => (presses.get(t) ?? 0) > now;
  return {
    Start: held('Start'),
    Reset: held('Reset'),
    Stop: !held('Stop'),
    'Emergency stop': !(estopLatched || held('Emergency stop')),
    Auto: process.env.PLANT_SIM_AUTO === '1',
  };
}

function desiredInputs() {
  return { ...plant.sensors(), ...operatorInputs(), 'FACTORY I/O (Running)': armed };
}

const same = (a, b) => a && b && INPUTS.every((t) => !!a[t.name] === !!b[t.name]);

// ---------------------------------------------------------------- physics (20 ms)
let lastPhys = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastPhys) / 1000);
  lastPhys = now;
  // read-only mirror when disarmed: the boxes still follow the PLC's real outputs
  const out = plc.connected ? plc.outputs : {};
  plant.step(dt, out);
}, PHYS_MS);

// ---------------------------------------------------------------- Modbus loop (~50 ms)
async function plcLoop() {
  for (;;) {
    if (!plc.connected) {
      try {
        await plc.connect();
        plcSource = (await hasMockMarker()) ? 'mock' : 'real';
        log(`PLC connected (${hostLabel}, unit ${PLC_UNIT}, source ${plcSource})`);
      } catch (e) {
        plc.lastError = e?.code || e?.message || 'connect failed';
        await sleep(2000);
        continue;
      }
    }
    const t0 = Date.now();
    try {
      await plc.read();
      if (armed) {
        // another writer on coils 100..113 (Factory I/O reconnecting) -> stop fighting it
        if (lastWritten && Date.now() - lastWrittenAt > 150 && plc.inputsOnPlc && !same(plc.inputsOnPlc, lastWritten)) mismatchReads++;
        else mismatchReads = 0;
        if (mismatchReads >= 8) {
          await disarm('another Modbus client is writing the plant inputs (is Factory I/O connected again?) — disarmed');
        } else {
          const want = desiredInputs();
          if (!same(want, lastWritten) || Date.now() - lastWrittenAt > REFRESH_WRITE_MS) {
            await plc.writeInputs(want);
            lastWritten = want;
            lastWrittenAt = Date.now();
          }
        }
      }
    } catch (e) {
      const wasArmed = armed;
      armed = false;
      plc.connected = false;
      plc.lastError = e?.code || e?.message || 'read failed';
      setError(`PLC link lost (${plc.lastError})${wasArmed ? ' — disarmed; inputs could not be restored until the link is back' : ''}`);
      await plc.close().catch(() => {});
      await sleep(1000);
      continue;
    }
    await sleep(Math.max(0, READ_MS - (Date.now() - t0)));
  }
}

// ---------------------------------------------------------------- Atlas guard (5 s)
async function guardLoop() {
  for (;;) {
    if (!mockTarget) {
      const s = await guard.check();
      if (armed && (!s.ok || s.busyJob || s.factoryIoActive)) {
        await disarm(!s.ok ? `${s.error} — disarmed for safety` : s.busyJob ? `worker job ${s.busyJob} is running — disarmed` : 'Factory I/O scene is running — disarmed');
      }
    }
    await sleep(GUARD_MS);
  }
}

// ---------------------------------------------------------------- arm / disarm
async function isMockTarget() {
  if (!MOCK_ALLOWED || !isLoopback) return false;
  return hasMockMarker();
}

async function hasMockMarker() {
  if (!isLoopback) return false;
  try {
    const r = await plc.readRegisters(1000, 2);
    return r[0] === MOCK_MARKER[0] && r[1] === MOCK_MARKER[1];
  } catch { return false; }
}

async function arm() {
  if (armed || arming) return;
  arming = true;
  try {
    if (!plc.connected) return setError('cannot arm: PLC Modbus link is down');
    mockTarget = await isMockTarget();
    if (!mockTarget) {
      const s = await guard.check();
      if (!s.ok) return setError(`cannot arm: ${s.error}`);
      if (s.busyJob) return setError(`cannot arm: worker job ${s.busyJob} is running — wait for it to finish`);
      if (s.factoryIoActive) return setError('cannot arm: Factory I/O scene is running (rig_status) — stop the Factory I/O scene first');
    }
    if (plc.inputsOnPlc?.['FACTORY I/O (Running)']) return setError('cannot arm: coil 113 "FACTORY I/O (Running)" is TRUE, so Factory I/O is still connected to the PLC — stop the Factory I/O scene first');
    armed = true;
    mismatchReads = 0;
    lastWritten = null;
    error = null;
    log(`ARMED${mockTarget ? ' (mock PLC)' : ''}`);
  } finally {
    arming = false;
  }
}

async function disarm(reason = null) {
  const was = armed;
  armed = false;
  presses.clear();
  if (reason) setError(reason);
  if (!was) return;
  log('DISARMED', reason ? `(${reason})` : '');
  if (plc.connected) {
    try {
      await plc.writeInputs(restInputs());
      lastWritten = null;
      log('inputs restored to the safe rest state');
    } catch (e) {
      setError(`disarmed, but restoring the rest state failed (${e?.code || e?.message})`);
    }
  }
}

// ---------------------------------------------------------------- state + WebSocket
function stateMsg() {
  const now = Date.now();
  if (error && now - errorAt > 15_000) error = null;
  const inputs = desiredInputs();
  const tags = {};
  for (const t of INPUTS) if (t.coil <= 112) tags[t.name] = inputs[t.name];
  for (const o of OUTPUTS) tags[o.name] = !!plc.outputs[o.name];
  tags.Counter = plc.registers.Counter;
  const g = guard.state;
  const fioByCoil = !armed && !!plc.inputsOnPlc?.['FACTORY I/O (Running)'];
  return {
    t: 'state',
    ts: now,
    tags,
    boxes: plant.snapshot(),
    plc: {
      connected: plc.connected,
      host: hostLabel,
      rttMs: plc.rttMs,
      lastReadAgoMs: plc.lastReadAt ? now - plc.lastReadAt : null,
      source: plcSource, // 'mock' = local test server, 'real' = the OpenPLC; null until connected
      program: plcSource === 'mock' ? 'mock sorter (local)' : g.program,
    },
    armed,
    factoryIoActive: !!(g.factoryIoActive || fioByCoil),
    busyJob: g.busyJob,
    error,
    // extras (not required by the contract)
    plcInputs: plc.inputsOnPlc,
    diag: { state: plc.registers.State, tall: plc.registers['Tall count'], short: plc.registers['Short count'], fault: plc.registers.Fault },
    sorted: plant.sorted,
    estopLatched,
    mock: plcSource === 'mock',
    atlas: { ok: g.ok, checkedAgoMs: g.checkedAt ? now - g.checkedAt : null },
    geometry: { heightGateX: GEOMETRY.heightGateX, palletX: GEOMETRY.palletX, speed: GEOMETRY.speed },
  };
}

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ ok: true, plcConnected: plc.connected, plcSource, armed, mock: plcSource === 'mock', clients: wss.clients.size, boxes: plant.boxes.length, uptimeS: Math.round(process.uptime()) }));
    return;
  }
  res.writeHead(404).end();
});
const wss = new WebSocketServer({ server: http });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify(stateMsg()));
  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m?.t === 'arm') return m.on ? arm() : disarm();
    if (m?.t === 'press') {
      if (!['Start', 'Stop', 'Reset', 'Emergency stop'].includes(m.tag)) return setError(`unknown press tag ${String(m.tag).slice(0, 40)}`);
      if (!armed) return setError(`press ${m.tag} ignored: not armed (writes to the PLC only happen while armed)`);
      const ms = Math.min(3000, Math.max(50, Number(m.ms) || 300));
      presses.set(m.tag, Date.now() + Math.max(ms, 2 * READ_MS + 20)); // long enough for at least one write + PLC scan
      return;
    }
    if (m?.t === 'estop') { estopLatched = !!m.latched; return; }
    if (m?.t === 'spawn') { plant.spawn(m.tall === true ? true : m.tall === false ? false : null); }
  });
});

setInterval(() => {
  if (!wss.clients.size) return;
  const s = JSON.stringify(stateMsg());
  for (const c of wss.clients) if (c.readyState === 1 && c.bufferedAmount < 1 << 20) c.send(s);
}, PUSH_MS);

async function shutdown(sig) {
  log(`${sig}: shutting down`);
  await disarm(null).catch(() => {});
  await plc.close().catch(() => {});
  await guard.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

http.listen(PORT, () => log(`plant-sim on ws://localhost:${PORT} (GET /health); PLC ${hostLabel}; READ-ONLY until armed from the UI`));
plcLoop();
guardLoop();
