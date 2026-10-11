// Arms a RUNNING plant-sim that is connected to the LOCAL mock PLC, checks that boxes flow and sort and that
// the Counter rises within N seconds, then DISARMS. Refuses to arm unless plc.source === 'mock'.
// Usage: node test/arm-mock-demo.js [url=ws://localhost:5197] [seconds=20]
import WebSocket from 'ws';
import { setTimeout as sleep } from 'node:timers/promises';

const url = process.argv[2] || 'ws://localhost:5197';
const SECS = Number(process.argv[3] || 20);
const ws = new WebSocket(url);
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
let last = null;
const seen = new Map(), exits = [];
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.t !== 'state') return;
  const ids = new Set(m.boxes.map((b) => b.id));
  for (const [id, b] of seen) if (!ids.has(id)) { exits.push({ id, tall: b.tall, lane: b.seg }); seen.delete(id); }
  for (const b of m.boxes) seen.set(b.id, b);
  last = m;
});
await sleep(500);
if (last?.plc?.source !== 'mock') { console.log(`REFUSED: plc.source is ${last?.plc?.source}, not mock`); process.exit(1); }
const c0 = last.tags.Counter;
ws.send(JSON.stringify({ t: 'arm', on: true }));
const t0 = Date.now();
let armedAt = null, firstBoxAt = null, firstCountAt = null, maxBoxes = 0;
while (Date.now() - t0 < SECS * 1000) {
  await sleep(50);
  if (last.armed && !armedAt) armedAt = Date.now() - t0;
  if (last.boxes.length && !firstBoxAt) firstBoxAt = Date.now() - t0;
  if (last.tags.Counter > c0 && !firstCountAt) firstCountAt = Date.now() - t0;
  maxBoxes = Math.max(maxBoxes, last.boxes.length);
}
const err = last.error;
ws.send(JSON.stringify({ t: 'arm', on: false }));
await sleep(600);
const wrong = exits.filter((e) => (e.tall ? 'left' : 'right') !== e.lane);
console.log(JSON.stringify({
  armedAtMs: armedAt, firstBoxAtMs: firstBoxAt, firstCounterRiseAtMs: firstCountAt,
  counterBefore: c0, counterAfter: last.tags.Counter, diag: last.diag,
  exited: exits.length, left: exits.filter((e) => e.lane === 'left').length, right: exits.filter((e) => e.lane === 'right').length,
  misSorted: wrong.length, maxBoxesOnPlant: maxBoxes, errorWhileArmed: err, armedAfterDisarm: last.armed,
}, null, 1));
ws.close();
process.exit(0);
