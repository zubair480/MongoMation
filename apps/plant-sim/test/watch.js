// Read-only WebSocket client: measures the state rate and prints a sample. Never sends anything.
// Usage: node test/watch.js [seconds=5] [url=ws://localhost:5195]
import WebSocket from 'ws';

const secs = Number(process.argv[2] || 5);
const url = process.argv[3] || 'ws://localhost:5195';
const ws = new WebSocket(url);
let n = 0, first = 0, last = null;
const lastReadAgo = [];
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.t !== 'state') return;
  if (!first) first = Date.now();
  n++;
  last = m;
  if (m.plc.lastReadAgoMs != null) lastReadAgo.push(m.plc.lastReadAgoMs);
});
ws.on('error', (e) => { console.error('ws error', e.message); process.exit(1); });
setTimeout(() => {
  const hz = n / ((Date.now() - first) / 1000);
  const avgAgo = lastReadAgo.length ? Math.round(lastReadAgo.reduce((a, b) => a + b, 0) / lastReadAgo.length) : null;
  console.log(JSON.stringify({ messages: n, hz: +hz.toFixed(1), avgLastReadAgoMs: avgAgo, plc: last?.plc, armed: last?.armed, factoryIoActive: last?.factoryIoActive, busyJob: last?.busyJob, error: last?.error, boxes: last?.boxes?.length }, null, 1));
  console.log('tags:', JSON.stringify(last?.tags));
  console.log('plcInputs:', JSON.stringify(last?.plcInputs), 'diag:', JSON.stringify(last?.diag));
  ws.close();
  process.exit(0);
}, secs * 1000);
