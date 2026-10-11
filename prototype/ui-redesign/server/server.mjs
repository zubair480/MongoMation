// MongoMation live bridge (Agent C). Thin HTTP API over the REAL MongoMation Atlas database.
// Writes: only job documents into `jobs`, with the exact shape apps/web/src/server/mongomation/mutations.ts uses.
// Reads: what the real worker (apps/worker) writes. Nothing here is simulated.
//
// Run INSIDE WSL (it reuses the repo's mongodb driver and .env; secrets never leave the process):
//   node --env-file=/home/zubair/mongomation/.env /mnt/c/Users/zubai/mongomation/prototype/ui-redesign/server/server.mjs
// or just: bash /mnt/c/Users/zubai/mongomation/prototype/ui-redesign/server/start.sh
import http from 'node:http';
import { createRequire } from 'node:module';

const REPO = process.env.MONGOMATION_REPO || '/home/zubair/mongomation';
const require = createRequire(`${REPO}/apps/web/package.json`);
const { MongoClient, ObjectId } = require('mongodb');

const PORT = Number(process.env.BRIDGE_PORT || 5190);
const ALLOWED_ORIGINS = new Set(['http://localhost:5178', 'http://127.0.0.1:5178']);
const URI = process.env.MONGODB_URI_WEB || process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'mongomation';
const LIVE_MS = 15_000; // worker STALE_MS in apps/worker/src/harness/jobs.ts
const MAX_QUEUED_PER_TYPE = 5; // apps/web/src/shared/mongomation.ts
const SPEC_MIN_CHARS = 20;
const SPEC_MAX_CHARS = 8000;
const FINAL = new Set(['completed', 'failed', 'blocked', 'interrupted']);
const REQUESTED_BY = 'ui-redesign-bridge';

if (!URI) {
  console.error('MONGODB_URI_WEB / MONGODB_URI not set: start with --env-file=<repo>/.env');
  process.exit(1);
}

const client = new MongoClient(URI, { serverSelectionTimeoutMS: 8000, appName: 'mongomation-ui-bridge' });
let dbPromise = null;
const getDb = () => (dbPromise ??= client.connect().then((c) => c.db(DB_NAME)).catch((e) => { dbPromise = null; throw e; }));

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

// ---- helpers -------------------------------------------------------------------------------------------
const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);
const idStr = (v) => (v == null ? null : String(v));
const ageMs = (d) => (d instanceof Date ? Date.now() - d.getTime() : null);
// Strip anything that could carry a host/URL of the private rig or credentials before it goes to the browser.
const redact = (s) => (typeof s === 'string' ? s.replace(/https?:\/\/[^\s"')]+/g, '<rig-url>') : s);
function idFilter(id) {
  return ObjectId.isValid(id) && String(new ObjectId(id)) === id ? { $in: [id, new ObjectId(id)] } : id;
}
function clean(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  if (doc instanceof Date) return doc.toISOString();
  if (doc instanceof ObjectId) return String(doc);
  if (Array.isArray(doc)) return doc.map(clean);
  const out = {};
  for (const [k, v] of Object.entries(doc)) out[k === '_id' ? 'id' : k] = typeof v === 'string' ? redact(v) : clean(v);
  return out;
}

async function workerStatus(db) {
  const w = await db.collection('workers').find({}).sort({ heartbeatAt: -1 }).limit(1).next();
  if (!w) return { online: false, id: null, lastBeatAgeMs: null, currentJobId: null };
  const age = ageMs(w.heartbeatAt);
  return { online: age != null && age < LIVE_MS, id: idStr(w._id), lastBeatAgeMs: age, currentJobId: idStr(w.currentJobId) };
}

async function rigDoc(db) {
  return db.collection('rig_status').find({}).sort({ checkedAt: -1 }).limit(1).next();
}
function rigSummary(r) {
  if (!r) return { live: false, checkedAgeMs: null, openplc: null, factoryio: null, sceneId: null };
  const age = ageMs(r.checkedAt);
  return {
    live: age != null && age < LIVE_MS && r.factoryio?.reachable === true,
    checkedAgeMs: age,
    sceneId: r.sceneId ?? null,
    openplc: r.openplc ? { reachable: !!r.openplc.reachable, running: !!r.openplc.running, detail: redact(r.openplc.detail ?? null) } : null,
    factoryio: r.factoryio ? { reachable: !!r.factoryio.reachable, detail: redact(r.factoryio.detail ?? null) } : null,
  };
}

function sceneBlocker(id, scene) {
  if (!scene) return `scene "${id}" is not registered in Atlas`;
  if (scene.verified !== true) return `scene "${id}" is UNVERIFIED (unverified scenes cannot produce test evidence)`;
  return null;
}

async function enqueue(db, job) {
  const jobs = db.collection('jobs');
  const waiting = await jobs.countDocuments({ type: job.type, status: 'queued' });
  if (waiting >= MAX_QUEUED_PER_TYPE) {
    throw new HttpError(409, 'BLOCKED', `BLOCKED: ${waiting} "${job.type}" jobs are already waiting for a worker. Wait until the worker claims them.`);
  }
  const { insertedId } = await jobs.insertOne({ ...job, status: 'queued', attempts: 0, createdAt: new Date(), requestedBy: REQUESTED_BY });
  return insertedId.toHexString();
}

// ---- handlers ------------------------------------------------------------------------------------------
async function health() {
  const db = await getDb();
  const [worker, rig, queued] = await Promise.all([workerStatus(db), rigDoc(db), db.collection('jobs').countDocuments({ status: 'queued' })]);
  return { ok: true, atlas: 'connected', db: DB_NAME, worker, rig: rigSummary(rig), queued };
}

async function scenes() {
  const db = await getDb();
  const docs = await db.collection('scenes').find({}).toArray();
  return {
    scenes: docs.map((s) => {
      const blocker = sceneBlocker(s.id, s);
      return {
        id: s.id, title: s.title ?? s.name ?? s.id, verified: s.verified === true, runnable: !blocker, blocker,
        description: s.description ?? null,
        tags: (s.tags ?? []).map((t) => ({ name: t.name, kind: t.kind ?? t.type ?? null, address: t.address ?? null, direction: t.direction ?? null })),
        faults: (s.faults ?? []).map((f) => ({ id: f.id, title: f.title ?? f.name ?? f.id, description: f.description ?? null })),
      };
    }),
  };
}

async function projects(url) {
  const db = await getDb();
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  const docs = await db.collection('projects').find({}).sort({ createdAt: -1 }).limit(limit).toArray();
  return {
    projects: docs.map((p) => ({
      id: idStr(p._id), sceneId: p.sceneId ?? null, status: p.status ?? null, specText: p.specText ?? null, origin: p.origin ?? null,
      createdAt: iso(p.createdAt), currentVersion: p.currentVersion ?? null, finalPlcVersionId: idStr(p.finalPlcVersionId), error: redact(p.error ?? null),
    })),
  };
}

async function postRun(body) {
  const specText = typeof body.specText === 'string' ? body.specText.trim() : '';
  const sceneId = typeof body.sceneId === 'string' ? body.sceneId.trim() : '';
  if (specText.length < SPEC_MIN_CHARS) throw new HttpError(400, 'VALIDATION', `describe the machine in at least ${SPEC_MIN_CHARS} characters`);
  if (specText.length > SPEC_MAX_CHARS) throw new HttpError(400, 'VALIDATION', `spec is longer than ${SPEC_MAX_CHARS} characters`);
  if (!/^[a-z0-9-]+$/.test(sceneId) || sceneId.length > 100) throw new HttpError(400, 'VALIDATION', 'scene ids are lowercase letters, digits and dashes');
  const db = await getDb();
  const scene = await db.collection('scenes').findOne({ id: sceneId }, { projection: { verified: 1 } });
  const blocker = sceneBlocker(sceneId, scene);
  if (blocker) throw new HttpError(409, 'BLOCKED', `BLOCKED: cannot engineer on this scene: ${blocker}`);
  const jobId = await enqueue(db, { type: 'engineer', origin: 'custom', specText, sceneId });
  return { status: 201, body: { jobId, status: 'queued', worker: await workerStatus(db) } };
}

async function postFault(body) {
  const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
  const faultId = typeof body.faultId === 'string' && body.faultId.trim() ? body.faultId.trim() : undefined;
  if (!projectId || projectId.length > 64) throw new HttpError(400, 'VALIDATION', 'projectId is required');
  const db = await getDb();
  const project = await db.collection('projects').findOne({ _id: idFilter(projectId) }, { projection: { sceneId: 1, finalPlcVersionId: 1 } });
  if (!project) throw new HttpError(409, 'BLOCKED', `BLOCKED: project ${projectId} does not exist in Atlas`);
  const reasons = [];
  if (!project.finalPlcVersionId) reasons.push('project has no final PLC version yet (run engineering to completion first)');
  const scene = project.sceneId ? await db.collection('scenes').findOne({ id: project.sceneId }, { projection: { verified: 1, faults: 1 } }) : null;
  const sb = sceneBlocker(project.sceneId, scene);
  if (sb) reasons.push(sb);
  const rig = rigSummary(await rigDoc(db));
  if (!rig.live) reasons.push(`rig is not live (Factory I/O ${rig.factoryio?.reachable ? 'reachable but status stale' : 'unreachable'}; last check ${rig.checkedAgeMs == null ? 'never' : Math.round(rig.checkedAgeMs / 1000) + ' s ago'})`);
  if (reasons.length) throw new HttpError(409, 'BLOCKED', `BLOCKED: ${reasons.join('; ')}`);
  if (faultId && !(scene?.faults ?? []).some((f) => f.id === faultId)) throw new HttpError(400, 'VALIDATION', `Fault "${faultId}" is not defined for scene "${project.sceneId}"`);
  const jobId = await enqueue(db, { type: 'fault_and_improve', origin: 'custom', projectId: idStr(project._id), sceneId: project.sceneId, ...(faultId ? { faultId } : {}) });
  return { status: 201, body: { jobId, status: 'queued', worker: await workerStatus(db) } };
}

async function getRun(jobId, url) {
  if (!ObjectId.isValid(jobId)) throw new HttpError(400, 'VALIDATION', 'jobId must be a 24-hex ObjectId');
  const db = await getDb();
  const job = await db.collection('jobs').findOne({ _id: new ObjectId(jobId) });
  if (!job) throw new HttpError(404, 'NOT_FOUND', `job ${jobId} not found`);
  const projectId = job.projectId ?? job.result?.projectId ?? null;
  const out = {
    job: {
      id: jobId, type: job.type, status: job.status, origin: job.origin ?? null, sceneId: job.sceneId ?? null, specText: job.specText ?? null,
      createdAt: iso(job.createdAt), startedAt: iso(job.startedAt), finishedAt: iso(job.finishedAt), claimedBy: job.claimedBy ?? null,
      attempts: job.attempts ?? 0, projectId: projectId ? String(projectId) : null, error: redact(job.error ?? null), result: clean(job.result ?? null),
    },
    worker: await workerStatus(db),
    project: null, stages: [], requirements: [], io: [], plc: null, plcVersions: [], compiles: [], deployments: [], simRuns: [], tests: [], events: [],
    done: FINAL.has(job.status),
  };
  if (!projectId) return out;
  const pid = String(projectId);
  const since = url.searchParams.get('since');
  const evFilter = { projectId: pid, ...(since && !Number.isNaN(Date.parse(since)) ? { ts: { $gt: new Date(since) } } : {}) };
  const [project, stages, reqDoc, versions, events, simRuns, tests] = await Promise.all([
    db.collection('projects').findOne({ _id: idFilter(pid) }),
    db.collection('stages').find({ projectId: pid }).sort({ startedAt: 1 }).toArray(),
    db.collection('requirements').find({ projectId: pid }).sort({ revision: -1 }).limit(1).next(),
    db.collection('plc_versions').find({ projectId: pid }).sort({ version: 1 }).toArray(),
    db.collection('events').find(evFilter).sort({ ts: 1 }).limit(500).toArray(),
    db.collection('sim_runs').find({ projectId: pid }).sort({ _id: 1 }).toArray(),
    db.collection('test_results').find({ projectId: pid }).sort({ startedAt: 1 }).toArray(),
  ]);
  const versionIds = versions.map((v) => String(v._id));
  const [compiles, deployments] = versionIds.length
    ? await Promise.all([
        db.collection('compile_results').find({ plcVersionId: { $in: versionIds } }).sort({ createdAt: 1 }).toArray(),
        db.collection('deployments').find({ plcVersionId: { $in: versionIds } }).sort({ createdAt: 1 }).toArray(),
      ])
    : [[], []];
  const latest = versions[versions.length - 1];
  out.project = project && {
    id: pid, status: project.status ?? null, sceneId: project.sceneId ?? null, specText: project.specText ?? null, revision: project.revision ?? 0,
    currentVersion: project.currentVersion ?? null, currentPlcVersionId: idStr(project.currentPlcVersionId), finalPlcVersionId: idStr(project.finalPlcVersionId),
    harnessVersion: project.harnessVersion ?? null, error: redact(project.error ?? null), createdAt: iso(project.createdAt),
  };
  out.stages = stages.map((s) => ({
    stage: s.stage, attempt: s.attempt ?? 0, revision: s.revision ?? 0, status: s.status, runs: s.runs ?? 1, startedAt: iso(s.startedAt), finishedAt: iso(s.finishedAt),
    error: redact(s.error ?? null), dependsOn: s.dependsOn ?? [], output: clean(s.output ?? null),
  }));
  out.requirements = clean(reqDoc?.requirements ?? []);
  out.io = clean(reqDoc?.io ?? []);
  out.plcVersions = versions.map((v) => ({ versionId: String(v._id), version: v.version, createdBy: v.createdBy ?? null, sourceHash: v.sourceHash ?? null, createdAt: iso(v.createdAt), diffFromPrevious: v.diffFromPrevious ?? null }));
  out.plc = latest ? { versionId: String(latest._id), version: latest.version, source: latest.source ?? '', sourceHash: latest.sourceHash ?? null } : null;
  out.compiles = compiles.map((c) => ({
    plcVersionId: c.plcVersionId, stage: c.stage, ok: c.ok ?? c.status === 'ok', status: c.status ?? (c.ok ? 'ok' : 'error'), toolchain: redact(c.toolchain ?? null),
    log: redact(String(c.log ?? '')).slice(-8000), durationMs: c.durationMs ?? null, createdAt: iso(c.createdAt),
  }));
  out.deployments = deployments.map((d) => ({ plcVersionId: d.plcVersionId, status: d.status ?? null, runtime: redact(d.runtime ?? null), linkUpMs: d.linkUpMs ?? null, createdAt: iso(d.createdAt) }));
  out.simRuns = simRuns.map((r) => clean({ ...r, samples: undefined, measurements: undefined }));
  out.tests = tests.map((t) => ({
    testId: t.testId, title: t.title ?? null, category: t.category ?? null, requirementIds: t.requirementIds ?? [], verdict: t.verdict,
    simRunId: t.simRunId, plcVersionId: t.plcVersionId ?? null, split: t.split ?? null, visibility: t.visibility ?? null, attempt: t.attempt ?? null,
    durationMs: t.durationMs ?? null, sampleCount: t.sampleCount ?? null,
    assertions: (t.assertions ?? []).map((a) => ({ label: a.label ?? null, passed: a.passed ?? null, atMs: a.atMs ?? null, detail: redact(a.detail ?? null) })),
    detail: redact((t.assertions ?? []).filter((a) => a.passed === false).map((a) => a.detail).join('; ') || null), startedAt: iso(t.startedAt),
  }));
  out.events = events.map((e) => ({ ts: iso(e.ts), stage: e.stage ?? null, level: e.level, message: redact(e.message) }));
  return out;
}

async function io() {
  const db = await getDb();
  const r = await rigDoc(db);
  const s = rigSummary(r);
  return { live: s.live, checkedAt: iso(r?.checkedAt), ageMs: s.checkedAgeMs, sceneId: s.sceneId, tags: clean(r?.tags ?? {}), forced: r?.forced ?? [], openplc: s.openplc, factoryio: s.factoryio };
}

// ---- HTTP plumbing -------------------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 64_000) reject(new HttpError(413, 'VALIDATION', 'body too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new HttpError(400, 'VALIDATION', 'body must be JSON')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  try {
    const p = url.pathname.replace(/\/+$/, '');
    let m;
    if (req.method === 'GET' && p === '/api/health') return send(200, await health());
    if (req.method === 'GET' && p === '/api/scenes') return send(200, await scenes());
    if (req.method === 'GET' && p === '/api/projects') return send(200, await projects(url));
    if (req.method === 'GET' && p === '/api/io') return send(200, await io());
    if (req.method === 'GET' && (m = p.match(/^\/api\/run\/([^/]+)$/))) return send(200, await getRun(m[1], url));
    if (req.method === 'POST' && p === '/api/run') { const r = await postRun(await readBody(req)); return send(r.status, r.body); }
    if (req.method === 'POST' && p === '/api/fault') { const r = await postFault(await readBody(req)); return send(r.status, r.body); }
    return send(404, { error: `no route ${req.method} ${url.pathname}`, code: 'NOT_FOUND' });
  } catch (err) {
    if (err instanceof HttpError) return send(err.status, { error: err.message, code: err.code });
    console.error(`${req.method} ${url.pathname}: ${err?.name ?? 'Error'}: ${redact(String(err?.message ?? err)).replace(/mongodb(\+srv)?:\/\/[^\s]+/g, '<uri>')}`);
    return send(503, { error: `Atlas request failed: ${err?.name ?? 'Error'}`, code: 'DISCONNECTED' });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`mongomation bridge on http://localhost:${PORT} (db ${DB_NAME})`));
