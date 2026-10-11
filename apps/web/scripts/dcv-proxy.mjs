#!/usr/bin/env node
// Local reverse proxy for the Amazon DCV web client so it can be iframed inside the app's "Factory I/O (live)" tab.
// - Listens on 127.0.0.1:8444 (PORT / HOST env override), plain HTTP.
// - Proxies every request and WebSocket upgrade to the DCV origin from DCV_URL (env, or /home/zubair/mongomation/.env).
// - Accepts the DCV server's self-signed certificate for this upstream only.
// - Strips X-Frame-Options and CSP frame-ancestors, rewrites Location to the proxy, relaxes cookies for http.
// Node built-ins only. Never logs the upstream address.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8444);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILES = [path.resolve(HERE, '../../../.env'), path.resolve(HERE, '../.env'), path.resolve(HERE, '../.env.local')];
function envVal(name) {
  if (process.env[name] && process.env[name].trim()) return process.env[name].trim();
  for (const p of ENV_FILES) {
    try {
      const m = fs.readFileSync(p, 'utf8').match(new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*["']?([^"'\\s#]+)`, 'm'));
      if (m && m[1]) return m[1].trim();
    } catch {}
  }
  return null;
}

// DCV origin: DCV_URL (env / .env) first, else the latest Atlas rig_status.dcvUrl (the same value the app iframes).
async function readDcvUrl() {
  const fromEnv = envVal('DCV_URL');
  if (fromEnv) return fromEnv;
  const uri = envVal('MONGODB_URI_WEB') || envVal('MONGODB_URI');
  if (!uri) return null;
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    const doc = await client.db(envVal('MONGODB_DB') || 'mongomation').collection('rig_status')
      .find({ dcvUrl: { $exists: true, $nin: ['', null] } }).sort({ checkedAt: -1 }).limit(1).next();
    return doc?.dcvUrl || null;
  } finally { await client.close().catch(() => {}); }
}

const raw = await readDcvUrl().catch((e) => {
  console.error('[dcv-proxy] Atlas lookup failed:', String(e?.message).replace(/\/\/[^@\s]+@/g, '//***@'));
  return null;
});
if (!raw) { console.error('[dcv-proxy] no DCV origin: set DCV_URL or rig_status.dcvUrl in Atlas'); process.exit(1); }
const up = new URL(raw);
const upOrigin = up.origin;
const upPort = Number(up.port || (up.protocol === 'https:' ? 443 : 80));
const isTls = up.protocol === 'https:';
const agent = isTls ? new https.Agent({ rejectUnauthorized: false, keepAlive: true }) : new http.Agent({ keepAlive: true });
const redact = (s) => String(s).split(up.hostname).join('<dcv-host>');

function upstreamHeaders(req) {
  const h = { ...req.headers };
  h.host = up.host;
  if (h.origin) h.origin = upOrigin;
  if (h.referer) { try { const r = new URL(h.referer); h.referer = upOrigin + r.pathname + r.search; } catch { delete h.referer; } }
  delete h['accept-encoding']; // keep bodies untouched; we only edit headers, but avoid surprises
  return h;
}

function fixResponseHeaders(headers, proxyOrigin) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (key === 'x-frame-options') continue;
    if (key === 'strict-transport-security') continue;
    if (key === 'content-security-policy' || key === 'content-security-policy-report-only') {
      const vals = (Array.isArray(v) ? v : [v]).map((s) => s.split(';').map((d) => d.trim())
        .filter((d) => d && !/^frame-ancestors\b/i.test(d) && !/^upgrade-insecure-requests\b/i.test(d)).join('; ')).filter(Boolean);
      if (vals.length) out[k] = vals;
      continue;
    }
    if (key === 'location') {
      const s = String(v);
      out[k] = s.startsWith(upOrigin) ? proxyOrigin + s.slice(upOrigin.length) : s;
      continue;
    }
    if (key === 'set-cookie') {
      out[k] = (Array.isArray(v) ? v : [v]).map((c) => c.split(';').map((p) => p.trim())
        .filter((p, i) => i === 0 || !/^(secure|domain=.*|samesite=none|partitioned)$/i.test(p)).join('; '));
      continue;
    }
    out[k] = v;
  }
  return out;
}

const proxyOriginOf = (req) => `http://${req.headers.host || `${HOST}:${PORT}`}`;

const server = http.createServer((req, res) => {
  const mod = isTls ? https : http;
  const preq = mod.request({ host: up.hostname, port: upPort, method: req.method, path: req.url,
    headers: upstreamHeaders(req), agent, servername: net.isIP(up.hostname) ? undefined : up.hostname }, (pres) => {
    res.writeHead(pres.statusCode || 502, fixResponseHeaders(pres.headers, proxyOriginOf(req)));
    pres.pipe(res);
  });
  preq.on('error', (e) => {
    console.error('[dcv-proxy] upstream error', req.method, req.url, redact(e.message));
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('DCV upstream unreachable');
  });
  req.pipe(preq);
});

server.on('upgrade', (req, socket, head) => {
  const lines = [`${req.method} ${req.url} HTTP/1.1`];
  const h = upstreamHeaders(req);
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const k = req.rawHeaders[i]; const lk = k.toLowerCase();
    let v = req.rawHeaders[i + 1];
    if (lk === 'host' || lk === 'origin' || lk === 'referer') v = h[lk];
    if (v !== undefined) lines.push(`${k}: ${v}`);
  }
  const connectOpts = { host: up.hostname, port: upPort, servername: net.isIP(up.hostname) ? undefined : up.hostname, rejectUnauthorized: false };
  const usock = isTls ? tls.connect(connectOpts) : net.connect(connectOpts);
  const onReady = () => { usock.write(lines.join('\r\n') + '\r\n\r\n'); if (head && head.length) usock.write(head); usock.pipe(socket); socket.pipe(usock); };
  usock.once(isTls ? 'secureConnect' : 'connect', onReady);
  const kill = (e) => { if (e) console.error('[dcv-proxy] ws error', req.url, redact(e.message)); socket.destroy(); usock.destroy(); };
  usock.on('error', kill); socket.on('error', kill);
  usock.on('close', () => socket.destroy()); socket.on('close', () => usock.destroy());
});


server.listen(PORT, HOST, () => console.log(`[dcv-proxy] listening on http://${HOST}:${PORT} -> <dcv-host>:${upPort} (${up.protocol})`));
