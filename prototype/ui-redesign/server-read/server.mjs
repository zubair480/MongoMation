// Agent E: READ-ONLY live data service for the ui-redesign prototype.
// Mirrors apps/web/src/server/mongomation/queries.ts (WSL repo /home/zubair/mongomation) over plain HTTP + SSE.
// - Never writes: only find / countDocuments / distinct / aggregate($match,$group) / watch.
// - The Atlas URI is loaded at runtime from the real app's env file (MONGODB_URI_WEB); it is never logged or returned.
// - docs.ts is a verbatim copy of the app's whitelisting mappers (run with Node >= 22.18 type stripping).
import http from 'node:http';
import fs from 'node:fs';
import { MongoClient } from 'mongodb';
import {
  clip, date, idFilter, idOf, num, objArr, str, strArr, tagValue, obj,
  toAssertion, toCompile, toDiagnosis, toEvent, toFaultInjection, toHarnessDetail, toHarnessVersion,
  toIo, toJob, toPlcVersionMeta, toProject, toProjectListItem, toProposal, toRequirement, toRig,
  toScene, toScores, toSimRun, toStage, toTest, toVerdict, toWorker,
} from './docs.ts';

const PORT = Number(process.env.PORT || 5191);
const ALLOWED_ORIGINS = new Set(['http://localhost:5178', 'http://127.0.0.1:5178']);
const ENV_FILES = [
  process.env.MM_ENV_FILE,
  '//wsl.localhost/Ubuntu/home/zubair/mongomation/apps/web/.env',
  '//wsl$/Ubuntu/home/zubair/mongomation/apps/web/.env',
  '/home/zubair/mongomation/apps/web/.env',
].filter(Boolean);

// ---- settings ---------------------------------------------------------------------------------------
function loadEnv() {
  const out = {};
  for (const f of ENV_FILES) {
    try {
      const text = fs.readFileSync(f, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        out[m[1]] = v;
      }
      return { vars: out, file: f };
    } catch { /* try next */ }
  }
  return { vars: out, file: null };
}
const env = loadEnv();
const URI = process.env.MONGODB_URI_WEB?.trim() || env.vars.MONGODB_URI_WEB?.trim() || '';
const DB_NAME = process.env.MONGODB_DB?.trim() || env.vars.MONGODB_DB?.trim() || 'mongomation';
const scrub = (m) => String(m).replace(/(mongodb(?:\+srv)?:\/\/)[^@\s/]+@/gi, '$1***@').slice(0, 1000);
const errMsg = (e) => scrub(e instanceof Error ? e.message || e.name : String(e));

// ---- connection ---------------------------------------------------------------------------------------
let client = null;
let connecting = null;
let lastFailure = null;
async function getDb() {
  if (!URI) throw Object.assign(new Error('MONGODB_URI_WEB not found in env file'), { stage: 'config' });
  if (client) return client.db(DB_NAME);
  if (lastFailure && Date.now() - lastFailure.at < 3000) throw Object.assign(new Error(lastFailure.message), { stage: 'connect' });
  if (!connecting) {
    const c = new MongoClient(URI, { appName: 'mongomation-ui-read', serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, maxPoolSize: 10, readPreference: 'primaryPreferred' });
    connecting = c.connect()
      .then(async () => { await c.db(DB_NAME).command({ ping: 1 }); client = c; lastFailure = null; return c; })
      .catch(async (e) => { lastFailure = { at: Date.now(), message: errMsg(e) }; await c.close().catch(() => {}); throw Object.assign(new Error(errMsg(e)), { stage: 'connect' }); })
      .finally(() => { connecting = null; });
  }
  return (await connecting).db(DB_NAME);
}

async function withAtlas(read) {
  let db;
  try { db = await getDb(); } catch (e) { return { connected: false, error: errMsg(e), stage: e.stage || 'connect' }; }
  try { return { connected: true, db: db.databaseName, ...(await read(db)) }; }
  catch (e) { return { connected: false, error: errMsg(e), stage: /ServerSelection|Network|Topology/i.test(e?.name) ? 'connect' : 'query' }; }
}

// ---- 1s shared cache (same as app cache.ts) ----------------------------------------------------------
const cache = new Map();
async function cached(key, read, ttl = 1000) {
  const now = Date.now();
  let e = cache.get(key);
  if (!e || (e.at !== undefined && now - e.at >= ttl)) {
    const fresh = {};
    fresh.promise = read().then((v) => { fresh.at = Date.now(); return v; }, (err) => { cache.delete(key); throw err; });
    cache.set(key, fresh);
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    e = fresh;
  }
  const v = await e.promise;
  return { ...v, cacheAgeMs: e.at === undefined ? 0 : Math.max(0, Date.now() - e.at) };
}
const invalidate = () => cache.clear();

// ---- queries (mirrors queries.ts) --------------------------------------------------------------------
const NOT_A_COMMAND = { type: { $ne: 'worker_command' } };
const SUPERSEDED_TEST_ID = /~attempt\d+$/;
const JOB_FIELDS = { type: 1, status: 1, origin: 1, command: 1, sceneId: 1, projectId: 1, faultId: 1, claimedBy: 1, handledBy: 1, heartbeatAt: 1, attempts: 1, resumedFrom: 1, interruptedAt: 1, error: 1, requestedBy: 1, createdAt: 1, startedAt: 1, finishedAt: 1, specText: 1 };
const PROJECT_LIST_FIELDS = { specText: 1, sceneId: 1, status: 1, currentVersion: 1, attempts: 1, harnessVersion: 1, costUsd: 1, createdAt: 1 };

async function newestJob(db, filter, now) {
  const d = await db.collection('jobs').find(filter, { projection: JOB_FIELDS }).sort({ createdAt: -1, _id: -1 }).limit(1).next();
  return d ? toJob(d, now) : null;
}
async function projectIdForJob(db, job) {
  if (job.projectId) return job.projectId;
  const byJob = { jobId: idFilter(job.id) };
  const s = await db.collection('stages').findOne(byJob, { projection: { projectId: 1 } });
  if (s && str(s.projectId)) return str(s.projectId);
  const ev = await db.collection('events').findOne(byJob, { projection: { projectId: 1 } });
  return (ev && str(ev.projectId)) || null;
}

const health = () => cached('health', () => withAtlas(async (db) => {
  const now = Date.now();
  const t0 = Date.now();
  await db.command({ ping: 1 });
  const pingMs = Date.now() - t0;
  const [workerDocs, rigDoc, queuedCount, activeDoc] = await Promise.all([
    db.collection('workers').find({}).sort({ heartbeatAt: -1 }).limit(5).toArray(),
    db.collection('rig_status').find({}).sort({ checkedAt: -1 }).limit(1).next(),
    db.collection('jobs').countDocuments({ ...NOT_A_COMMAND, status: 'queued' }),
    db.collection('jobs').find({ ...NOT_A_COMMAND, status: { $in: ['running', 'verifying'] } }, { projection: JOB_FIELDS }).sort({ heartbeatAt: -1, createdAt: -1 }).limit(1).next(),
  ]);
  const workers = workerDocs.map((w) => toWorker(w, now));
  const newest = workers[0];
  return {
    serverTime: new Date(now),
    atlas: { connected: true, db: db.databaseName, pingMs },
    worker: newest ? { id: newest.id, host: newest.host, heartbeatAt: newest.heartbeatAt, heartbeatAgeMs: newest.heartbeatAgeMs, alive: newest.heartbeatAgeMs !== undefined && newest.heartbeatAgeMs < 15_000, currentJobId: newest.currentJobId } : null,
    workers,
    rig: rigDoc ? toRig(rigDoc, now) : null,
    queuedCount,
    activeJob: activeDoc ? toJob(activeDoc, now) : null,
    live: liveStatus(),
  };
}));

const dashboard = () => cached('dashboard', () => withAtlas(async (db) => {
  const now = Date.now();
  const jobs = db.collection('jobs');
  const [workerDocs, rigDoc, generate, example, fault, specChange, command, queuedCount, activeDoc, lastJob, projectDocs] = await Promise.all([
    db.collection('workers').find({}).sort({ heartbeatAt: -1 }).limit(5).toArray(),
    db.collection('rig_status').find({}).sort({ checkedAt: -1 }).limit(1).next(),
    newestJob(db, { type: 'engineer', origin: { $ne: 'example' } }, now),
    newestJob(db, { type: 'engineer', origin: 'example' }, now),
    newestJob(db, { type: 'fault_and_improve' }, now),
    newestJob(db, { type: 'spec_change' }, now),
    newestJob(db, { type: 'worker_command' }, now),
    jobs.countDocuments({ ...NOT_A_COMMAND, status: 'queued' }),
    jobs.find({ ...NOT_A_COMMAND, status: { $in: ['running', 'verifying'] } }, { projection: JOB_FIELDS }).sort({ heartbeatAt: -1, createdAt: -1 }).limit(1).next(),
    newestJob(db, NOT_A_COMMAND, now),
    db.collection('projects').find({}, { projection: PROJECT_LIST_FIELDS }).sort({ createdAt: -1, _id: -1 }).limit(25).toArray(),
  ]);
  const activeJob = activeDoc ? toJob(activeDoc, now) : null;
  const focus = activeJob ?? lastJob;
  const checkpointProjectId = focus ? await projectIdForJob(db, focus) : null;
  const checkpointDocs = checkpointProjectId
    ? await db.collection('stages').find({ projectId: checkpointProjectId }, { projection: { output: 0 } }).sort({ startedAt: 1 }).limit(400).toArray()
    : [];
  return {
    serverTime: new Date(now),
    workers: workerDocs.map((w) => toWorker(w, now)),
    rig: rigDoc ? toRig(rigDoc, now) : null,
    latestJobs: { generate, example, fault, specChange, command },
    queuedCount, activeJob, lastJob, checkpointProjectId,
    checkpoints: checkpointDocs.map((s) => toStage(s, now)),
    projects: projectDocs.map(toProjectListItem),
  };
}));

const projects = (limit) => cached(`projects:${limit}`, () => withAtlas(async (db) => {
  const docs = await db.collection('projects').find({}, { projection: PROJECT_LIST_FIELDS }).sort({ createdAt: -1, _id: -1 }).limit(limit).toArray();
  return { projects: docs.map(toProjectListItem) };
}));

const scenes = () => cached('scenes', () => withAtlas(async (db) => {
  const docs = await db.collection('scenes').find({}, { projection: { id: 1, title: 1, description: 1, factoryIoScene: 1, verified: 1, capabilities: 1, tags: 1, faults: 1 } }).sort({ id: 1 }).limit(100).toArray();
  return { scenes: docs.map(toScene) };
}));

const project = (projectId) => cached(`project:${projectId}`, () => withAtlas(async (db) => {
  const now = Date.now();
  const projectDoc = await db.collection('projects').findOne({ _id: idFilter(projectId) });
  const pid = projectDoc ? idOf(projectDoc._id) : projectId;
  const [reqDoc, stageDocs, eventDocs, versionDocs, simRunDoc, faultDocs, diagnosisDoc, hiddenIdValues] = await Promise.all([
    db.collection('requirements').find({ projectId: pid }).sort({ revision: -1 }).limit(1).next(),
    db.collection('stages').find({ projectId: pid }, { projection: { output: 0 } }).sort({ startedAt: 1 }).limit(500).toArray(),
    db.collection('events').find({ projectId: pid }, { projection: { data: 0 } }).sort({ ts: -1, _id: -1 }).limit(100).toArray(),
    db.collection('plc_versions').find({ projectId: pid }, { projection: { source: 0, diffFromPrevious: 0 } }).sort({ version: -1 }).limit(50).toArray(),
    db.collection('sim_runs').find({ projectId: pid }, { projection: { releasedAtStart: 0 } }).sort({ startedAt: -1 }).limit(1).next(),
    db.collection('fault_injections').find({ projectId: pid }).sort({ appliedAt: -1 }).limit(10).toArray(),
    db.collection('diagnoses').find({ projectId: pid }, { projection: { feedback: 0 } }).sort({ createdAt: -1 }).limit(1).next(),
    db.collection('test_results').distinct('testId', { projectId: pid, visibility: { $ne: 'public' }, superseded: { $ne: true } }),
  ]);
  const hiddenIds = strArr(hiddenIdValues);
  const plcVersions = versionDocs.map(toPlcVersionMeta);
  const latest = plcVersions[0];
  const simRun = simRunDoc ? toSimRun(simRunDoc) : null;
  const [compileDocs, testDocs] = await Promise.all([
    latest ? db.collection('compile_results').find({ plcVersionId: idFilter(latest.id) }).sort({ createdAt: -1 }).limit(10).toArray() : [],
    simRun ? db.collection('test_results').find({ simRunId: idFilter(simRun.id), superseded: { $ne: true }, testId: { $not: SUPERSEDED_TEST_ID } }, { projection: { steps: 0, stepLogs: 0 } }).sort({ startedAt: 1, _id: 1 }).limit(500).toArray() : [],
  ]);
  const tests = testDocs.map(toTest);
  const count = (v) => tests.filter((t) => t.verdict === v).length;
  let verdictRun = simRunDoc && objArr(simRunDoc.verdicts).length ? simRunDoc : null;
  if (!verdictRun && simRunDoc) {
    verdictRun = await db.collection('sim_runs').find({ projectId: pid, 'verdicts.0': { $exists: true } }, { projection: { verdicts: 1, startedAt: 1 } }).sort({ startedAt: -1 }).limit(1).next();
  }
  const projectVerdicts = projectDoc ? objArr(projectDoc.verdicts).map(toVerdict) : [];
  let verdicts = [];
  let verdictSource = null;
  if (verdictRun) {
    verdicts = objArr(verdictRun.verdicts).map(toVerdict);
    verdictSource = { kind: 'sim_run', simRunId: idOf(verdictRun._id), latestRun: verdictRun === simRunDoc };
  } else if (projectVerdicts.length) {
    verdicts = projectVerdicts;
    verdictSource = { kind: 'project', simRunId: projectDoc ? str(projectDoc.lastSimRunId) : undefined };
  }
  return {
    project: projectDoc ? toProject(projectDoc) : null,
    requirements: reqDoc ? { revision: num(reqDoc.revision), sceneId: str(reqDoc.sceneId), items: objArr(reqDoc.requirements).slice(0, 100).map(toRequirement), io: objArr(reqDoc.io).slice(0, 200).map(toIo) } : null,
    stages: stageDocs.map((s) => toStage(s, now, hiddenIds)),
    events: eventDocs.map((e) => toEvent(e, hiddenIds)),
    plcVersions,
    compiles: compileDocs.map(toCompile),
    simRun,
    tests,
    testCounts: { passed: count('passed'), failed: count('failed'), blocked: count('blocked'), total: tests.length },
    verdicts, verdictSource,
    faults: faultDocs.map(toFaultInjection),
    diagnosis: diagnosisDoc ? toDiagnosis(diagnosisDoc) : null,
  };
}));

const plcSource = (id) => cached(`plc:${id}`, () => withAtlas(async (db) => {
  const d = await db.collection('plc_versions').findOne({ _id: idFilter(id) }, { projection: { source: 1, diffFromPrevious: 1, version: 1, createdBy: 1 } });
  if (!d) return { found: false, id, diff: null };
  const raw = d.diffFromPrevious;
  const diff = Array.isArray(raw) ? strArr(raw) : typeof raw === 'string' ? raw.split('\n') : null;
  return { found: true, id: idOf(d._id), version: num(d.version), createdBy: str(d.createdBy), source: clip(str(d.source), 400_000) ?? '', diff: diff ? diff.slice(0, 20_000) : null };
}), 60_000);

function changePoints(docs) {
  const tv = (v) => { const out = {}; for (const [k, x] of Object.entries(obj(v) ?? {})) { const t = tagValue(x); if (t !== undefined) out[k] = t; } return out; };
  const rows = docs.map((d) => ({ t: num(d.t), values: tv(d.values) })).filter((r) => r.t !== undefined).sort((a, b) => a.t - b.t);
  const out = [];
  let prev = '';
  rows.forEach((r, i) => {
    const key = JSON.stringify(Object.entries(r.values).sort(([a], [b]) => a.localeCompare(b)));
    if (key !== prev || i === rows.length - 1) out.push(r);
    prev = key;
  });
  if (out.length <= 2500) return { samples: out, thinned: false };
  const step = Math.ceil(out.length / 2500);
  return { samples: out.filter((_, i) => i % step === 0 || i === out.length - 1), thinned: true };
}

const timeline = (simRunId, testId) => cached(`timeline:${simRunId}:${testId}`, () => withAtlas(async (db) => {
  const empty = { simRunId, testId, samples: [], totalSamples: 0, truncated: false, assertions: [] };
  if (SUPERSEDED_TEST_ID.test(testId)) return { ...empty, found: false, hidden: false };
  const r = await db.collection('test_results').findOne({ simRunId: idFilter(simRunId), testId, superseded: { $ne: true } }, { projection: { visibility: 1, assertions: 1, durationMs: 1 } });
  if (!r) return { ...empty, found: false, hidden: false };
  if (str(r.visibility) !== 'public') return { ...empty, found: true, hidden: true };
  const docs = await db.collection('measurements').find({ 'meta.simRunId': simRunId, 'meta.testId': testId }, { projection: { _id: 0, t: 1, values: 1 } }).sort({ t: 1 }).limit(20_000).toArray();
  const { samples, thinned } = changePoints(docs);
  return { ...empty, found: true, hidden: false, samples, totalSamples: docs.length, truncated: thinned || docs.length >= 20_000, durationMs: num(r.durationMs), assertions: objArr(r.assertions).slice(0, 50).map(toAssertion) };
}), 5000);

const harness = () => cached('harness', () => withAtlas(async (db) => {
  const hv = db.collection('harness_versions');
  const proposals = db.collection('rsi_proposals');
  const [historyDocs, activeDoc, proposalDoc, proposalCount, lessonDocs, lessonCount] = await Promise.all([
    hv.find({}, { projection: { _id: 0, version: 1, parent: 1, verdict: 1, rationale: 1, gateNote: 1, createdAt: 1, decidedAt: 1, scores: 1, rulesCount: { $size: { $ifNull: ['$rules', []] } } } }).sort({ version: -1 }).limit(100).toArray(),
    hv.find({ verdict: 'kept' }, { projection: { _id: 0 } }).sort({ version: -1 }).limit(1).next(),
    proposals.find({}).sort({ createdAt: -1, _id: -1 }).limit(1).next(),
    proposals.countDocuments({}),
    db.collection('lessons').find({}, { projection: { embedding: 0 } }).sort({ createdAt: -1, _id: -1 }).limit(50).toArray(),
    db.collection('lessons').countDocuments({}),
  ]);
  // Lessons proposed by diagnoses (the `lessons` collection only holds verified ones).
  const diagDocs = await db.collection('diagnoses').find({ 'lessons.0': { $exists: true } }, { projection: { lessons: 1, projectId: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(10).toArray();
  const diagnosisLessons = diagDocs.flatMap((d) => objArr(d.lessons).slice(0, 20).map((l) => ({ diagnosisId: idOf(d._id), projectId: str(d.projectId), createdAt: date(d.createdAt), pattern: clip(str(l.pattern), 400), fix: clip(str(l.fix), 400) })));
  const latestProposal = proposalDoc ? toProposal(proposalDoc) : null;
  const candidateDoc = latestProposal?.candidateVersion !== undefined ? await hv.findOne({ version: latestProposal.candidateVersion }, { projection: { _id: 0 } }) : null;
  // Gate table: every decided version with its scores next to its parent's scores.
  const fullScores = await hv.find({}, { projection: { _id: 0, version: 1, parent: 1, verdict: 1, scores: 1, parentScores: 1, gateNote: 1, decidedAt: 1 } }).sort({ version: -1 }).limit(100).toArray();
  const gate = fullScores.map((d) => ({ version: num(d.version), parent: num(d.parent), verdict: str(d.verdict), scores: toScores(d.scores) ?? null, parentScores: toScores(d.parentScores) ?? null, gateNote: clip(str(d.gateNote), 400), decidedAt: date(d.decidedAt) }));
  return {
    active: activeDoc ? toHarnessDetail(activeDoc) : null,
    versions: historyDocs.map(toHarnessVersion),
    latestProposal,
    candidate: candidateDoc ? toHarnessDetail(candidateDoc) : null,
    proposalCount,
    gate,
    lessons: lessonDocs.map((l) => ({ id: idOf(l._id), pattern: clip(str(l.pattern), 400), fix: clip(str(l.fix), 400), verified: l.verified === true, active: l.active === undefined ? undefined : l.active === true, createdAt: date(l.createdAt), updatedAt: date(l.updatedAt), projectId: str(obj(l.lastSource)?.projectId) })),
    lessonCount,
    diagnosisLessons,
  };
}));

const CONDITION_ORDER = (k) => (k === 'bare' ? -2 : k === 'v0' ? -1 : Number(k.slice(1)) || 0);
const ablation = () => cached('ablation', () => withAtlas(async (db) => {
  const runs = db.collection('benchmark_runs');
  const ROW = { condition: { $regex: '^ablation:' } };
  const [summaryDoc, summaryCount, newestRow] = await Promise.all([
    runs.find({ kind: 'ablation_summary' }).sort({ createdAt: -1, _id: -1 }).limit(1).next(),
    runs.countDocuments({ kind: 'ablation_summary' }),
    runs.find(ROW, { projection: { _id: 0, benchmarkId: 1, createdAt: 1 } }).sort({ createdAt: -1, _id: -1 }).limit(1).next(),
  ]);
  let summary = null;
  const summaryId = summaryDoc ? str(summaryDoc.benchmarkId) : undefined;
  if (summaryDoc && summaryId) {
    const counts = await runs.aggregate([{ $match: { benchmarkId: summaryId, ...ROW } }, { $group: { _id: '$condition', n: { $sum: 1 } } }]).toArray();
    const rowsBy = new Map(counts.map((c) => [String(c._id).replace(/^ablation:/, ''), c.n]));
    const scores = obj(summaryDoc.scores) ?? {};
    const conditions = Object.keys(scores).map((key) => ({ key, version: key === 'bare' ? undefined : num(Number(key.replace(/^v/, ''))), scores: toScores(scores[key]), rows: rowsBy.get(key) ?? 0 })).sort((a, b) => CONDITION_ORDER(a.key) - CONDITION_ORDER(b.key));
    const model = obj(summaryDoc.model);
    summary = { benchmarkId: summaryId, manifestHash: str(summaryDoc.manifestHash), createdAt: date(summaryDoc.createdAt), model: model ? { fast: str(model.fast), strong: str(model.strong) } : undefined, conditions };
  }
  let inProgress = null;
  const newestId = newestRow ? str(newestRow.benchmarkId) : undefined;
  if (newestId && newestId !== summaryId) {
    const done = await runs.countDocuments({ kind: 'ablation_summary', benchmarkId: newestId });
    if (!done) inProgress = { benchmarkId: newestId, rows: await runs.countDocuments({ benchmarkId: newestId, ...ROW }), lastRowAt: date(newestRow?.createdAt) };
  }
  return { summary, inProgress, summaryCount };
}));

// ---- live: one shared change stream (fallback: 1s polling) --------------------------------------------
const WATCHED = ['jobs', 'workers', 'rig_status', 'projects', 'stages', 'events', 'requirements', 'plc_versions', 'compile_results', 'sim_runs', 'test_results', 'fault_injections', 'diagnoses', 'scenes', 'harness_versions', 'rsi_proposals', 'benchmark_runs', 'lessons'];
const sseClients = new Set();
let stream = null;
let mode = 'idle'; // 'change_stream' | 'polling' | 'idle'
let changesSeen = 0;
let liveError = null;
let pollTimer = null;
function liveStatus() { return { mode, subscribers: sseClients.size, changesSeen, lastError: liveError }; }

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) { try { res.write(payload); } catch { /* closed */ } }
}

const hiddenCache = new Map();
async function hiddenIdsFor(db, projectId) {
  const hit = hiddenCache.get(projectId);
  if (hit && Date.now() - hit.at < 5000) return hit.ids;
  const ids = strArr(await db.collection('test_results').distinct('testId', { projectId, visibility: { $ne: 'public' }, superseded: { $ne: true } }));
  hiddenCache.set(projectId, { at: Date.now(), ids });
  return ids;
}

function emitChange(change, eventDoc, db) {
  changesSeen++;
  invalidate();
  broadcast('change', change);
  if (eventDoc && change.projectId) {
    hiddenIdsFor(db, change.projectId).catch(() => []).then((hidden) => broadcast('event', { projectId: change.projectId, event: toEvent(eventDoc, hidden) }));
  }
}

async function startLive() {
  if (stream || pollTimer || sseClients.size === 0) return;
  let db;
  try { db = await getDb(); } catch (e) { liveError = errMsg(e); setTimeout(startLive, 3000); return; }
  try {
    const cs = db.watch([
      { $match: { 'ns.coll': { $in: WATCHED }, operationType: { $in: ['insert', 'update', 'replace', 'delete'] } } },
      { $project: { 'fullDocument.data': 0, 'fullDocument.output': 0, 'fullDocument.steps': 0, 'fullDocument.stepLogs': 0, 'fullDocument.source': 0, 'fullDocument.diffFromPrevious': 0, 'fullDocument.rules': 0, 'fullDocument.embedding': 0, updateDescription: 0 } },
    ]);
    stream = cs;
    mode = 'change_stream';
    liveError = null;
    cs.on('change', (ev) => {
      const coll = ev.ns?.coll ?? '';
      const full = ev.fullDocument;
      emitChange({ coll, op: ev.operationType, id: ev.documentKey ? idOf(ev.documentKey._id) : undefined, projectId: str(full?.projectId), simRunId: str(full?.simRunId), jobId: str(full?.jobId), ts: new Date() }, coll === 'events' && ev.operationType === 'insert' ? full : null, db);
    });
    cs.on('error', (e) => {
      liveError = errMsg(e);
      if (stream === cs) stream = null;
      cs.close().catch(() => {});
      startPolling(db);
    });
  } catch (e) {
    liveError = errMsg(e);
    startPolling(db);
  }
}

// Fallback: fingerprint the newest write per collection every 1s.
function startPolling(db) {
  if (pollTimer) return;
  mode = 'polling';
  const last = {};
  const probes = {
    events: { sort: { ts: -1, _id: -1 }, key: (d) => idOf(d._id) },
    jobs: { sort: { heartbeatAt: -1 }, key: (d) => `${idOf(d._id)}:${d.status}:${+date(d.heartbeatAt) || 0}` },
    stages: { sort: { startedAt: -1 }, key: (d) => `${idOf(d._id)}:${d.status}` },
    workers: { sort: { heartbeatAt: -1 }, key: (d) => `${idOf(d._id)}:${+date(d.heartbeatAt) || 0}` },
    rig_status: { sort: { checkedAt: -1 }, key: (d) => `${idOf(d._id)}:${+date(d.checkedAt) || 0}` },
    test_results: { sort: { _id: -1 }, key: (d) => `${idOf(d._id)}:${d.verdict}` },
    sim_runs: { sort: { startedAt: -1 }, key: (d) => `${idOf(d._id)}:${d.status}` },
    projects: { sort: { _id: -1 }, key: (d) => `${idOf(d._id)}:${d.status}:${d.currentVersion}` },
    harness_versions: { sort: { version: -1 }, key: (d) => `${d.version}:${d.verdict}` },
  };
  let busy = false;
  pollTimer = setInterval(async () => {
    if (busy) return;
    if (sseClients.size === 0) { clearInterval(pollTimer); pollTimer = null; mode = 'idle'; return; }
    busy = true;
    try {
      await Promise.all(Object.entries(probes).map(async ([coll, p]) => {
        const d = await db.collection(coll).find({}, { projection: { _id: 1, status: 1, heartbeatAt: 1, checkedAt: 1, verdict: 1, version: 1, currentVersion: 1, projectId: 1, simRunId: 1, jobId: 1, ts: 1, level: 1, stage: 1, message: 1 } }).sort(p.sort).limit(1).next();
        if (!d) return;
        const k = p.key(d);
        if (last[coll] !== undefined && last[coll] !== k) {
          emitChange({ coll, op: 'poll', id: idOf(d._id), projectId: str(d.projectId), simRunId: str(d.simRunId), jobId: str(d.jobId), ts: new Date() }, coll === 'events' ? d : null, db);
        }
        last[coll] = k;
      }));
    } catch (e) { liveError = errMsg(e); }
    busy = false;
  }, 1000);
}

function stopLiveIfIdle() {
  if (sseClients.size) return;
  if (stream) { stream.close().catch(() => {}); stream = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  mode = 'idle';
}

// ---- HTTP ------------------------------------------------------------------------------------------
function cors(req, res) {
  const o = req.headers.origin;
  if (o && (ALLOWED_ORIGINS.has(o) || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(o))) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cache-Control, Last-Event-ID');
}
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body, null, 0));
}
const ID = /^[A-Za-z0-9_.:~-]{1,200}$/;

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method !== 'GET') return send(res, 405, { error: 'read-only service: GET only' });
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (parts[0] !== 'api') {
      if (url.pathname === '/' ) return send(res, 200, { service: 'mongomation read API (Agent E)', endpoints: ['/api/health', '/api/dashboard', '/api/projects', '/api/project/:id', '/api/plc/:versionId', '/api/timeline/:simRunId/:testId', '/api/harness', '/api/ablation', '/api/scenes', '/api/events/stream'] });
      return send(res, 404, { error: 'not found' });
    }
    const [, a, b, c] = parts;
    if (a === 'health' && !b) {
      const h = await health();
      if (!h.connected) return send(res, 503, { ...h, atlas: { connected: false, error: h.error, stage: h.stage }, envFileFound: !!env.file });
      return send(res, 200, h);
    }
    if (a === 'dashboard' && !b) return send(res, 200, await dashboard());
    if (a === 'projects' && !b) {
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 25));
      return send(res, 200, await projects(limit));
    }
    if (a === 'project' && b && !c) { if (!ID.test(b)) return send(res, 400, { error: 'bad projectId' }); return send(res, 200, await project(b)); }
    if (a === 'plc' && b && !c) { if (!ID.test(b)) return send(res, 400, { error: 'bad versionId' }); return send(res, 200, await plcSource(b)); }
    if (a === 'timeline' && b && c) { if (!ID.test(b) || !ID.test(c)) return send(res, 400, { error: 'bad ids' }); return send(res, 200, await timeline(b, c)); }
    if ((a === 'harness' || a === 'rsi') && !b) return send(res, 200, await harness());
    if (a === 'ablation' && !b) return send(res, 200, await ablation());
    if (a === 'scenes' && !b) return send(res, 200, await scenes());
    if (a === 'events' && b === 'stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      sseClients.add(res);
      startLive();
      res.write(`event: hello\ndata: ${JSON.stringify({ serverTime: new Date(), live: liveStatus() })}\n\n`);
      const ping = setInterval(() => res.write(`event: ping\ndata: ${JSON.stringify({ serverTime: new Date(), live: liveStatus() })}\n\n`), 15_000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); stopLiveIfIdle(); });
      return;
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: errMsg(e) });
  }
});

server.listen(PORT, () => {
  console.log(`mongomation read API on http://localhost:${PORT}  db=${DB_NAME}  env=${env.file ? 'loaded' : 'MISSING'}  uri=${URI ? 'set' : 'MISSING'}`);
  getDb().then(() => console.log('atlas: connected')).catch((e) => console.log('atlas: not connected:', errMsg(e)));
});
