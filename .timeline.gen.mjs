// READ-ONLY timing log generator. Reads Atlas, writes TIMELINE.md. No writes to Atlas.
import { MongoClient, ObjectId } from 'mongodb';
import { writeFileSync, renameSync } from 'node:fs';

const OUT = process.argv[2] || '/mnt/c/Users/zubai/mongomation/TIMELINE.md';
const TZ_OFFSET_H = -7; // user's local time = UTC-7
const off = TZ_OFFSET_H * 3600e3;

const D = (v) => (v == null ? null : v instanceof Date ? v : new Date(v));
const local = (d) => { d = D(d); if (!d || isNaN(d)) return 'n/a'; return new Date(d.getTime() + off).toISOString().slice(11, 19); };
const secs = (a, b) => { a = D(a); b = D(b); if (!a || !b) return null; return (b - a) / 1000; };
const fs = (s) => (s == null || isNaN(s) ? 'n/a' : `${s.toFixed(1)}s`);
const mss = (s) => { if (s == null || isNaN(s)) return 'n/a'; s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const hms = (s) => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`; };
const short = (id) => (id ? String(id).slice(-6) : '-');
const clean = (t, n = 70) => String(t ?? '')
  .replace(/[a-z]+(\+srv)?:\/\/\S+/gi, '<url>')
  .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, '<host>')
  .replace(/[|\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const KIND = { engineer: 'engineer', fault_and_improve: 'fault', benchmark: 'benchmark', evolve: 'evolve', ablation: 'ablation' };

const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
await client.connect();
const db = client.db(process.env.MONGODB_DB);
const col = (n) => db.collection(n);

const now = new Date();
const localNow = new Date(now.getTime() + off);
const dayStartUtc = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()) - off);

const jobs = await col('jobs').find({ $or: [{ createdAt: { $gte: dayStartUtc } }, { startedAt: { $gte: dayStartUtc } }, { status: { $in: ['running', 'claimed', 'queued', 'pending'] } }] }).sort({ createdAt: 1 }).toArray();
const jobIds = jobs.map((j) => String(j._id));
const projIds = [...new Set(jobs.map((j) => j.projectId).filter(Boolean).map(String))];

const [stages, events, simRuns, compiles, deploys, plcVersions, repairs, diagnoses, proposals, projects, workers] = await Promise.all([
  col('stages').find({ jobId: { $in: jobIds } }).sort({ startedAt: 1 }).toArray(),
  col('events').find({ ts: { $gte: dayStartUtc } }).sort({ ts: 1 }).toArray(),
  col('sim_runs').find({ startedAt: { $gte: dayStartUtc } }).sort({ startedAt: 1 }).toArray(),
  col('compile_results').find({ createdAt: { $gte: dayStartUtc } }).toArray(),
  col('deployments').find({ createdAt: { $gte: dayStartUtc } }).sort({ createdAt: 1 }).toArray(),
  col('plc_versions').find({ createdAt: { $gte: dayStartUtc } }, { projection: { source: 0, diffFromPrevious: 0 } }).toArray(),
  col('repairs').find({ createdAt: { $gte: dayStartUtc } }).toArray(),
  col('diagnoses').find({ createdAt: { $gte: dayStartUtc } }, { projection: { projectId: 1, createdAt: 1 } }).toArray(),
  col('rsi_proposals').find({ createdAt: { $gte: dayStartUtc } }, { projection: { jobId: 1, createdAt: 1, verdict: 1, status: 1, gate: 1 } }).toArray(),
  col('projects').find({ _id: { $in: projIds.filter((p) => /^[0-9a-f]{24}$/.test(p)).map((p) => new ObjectId(p)) } }, { projection: { verdicts: 1, status: 1 } }).toArray(),
  col('workers').find({}).toArray(),
]);
await client.close();

const pvById = new Map(plcVersions.map((v) => [String(v._id), v]));
const projById = new Map(projects.map((p) => [String(p._id), p]));
const simById = new Map(simRuns.map((s) => [String(s._id), s]));
const inWin = (t, a, b) => { t = D(t); return t && t >= D(a) && t <= (D(b) || now); };

// ---- averages collectors
const avg = { requirements: [], io_design: [], plc_code: [], 'compile (stage)': [], 'compile (toolchain)': [], deploy: [], 'link-up': [], 'test round': [], diagnosis: [], repair: [], 'repair round (repair start -> re-test done)': [] };
const push = (k, v) => { if (v != null && !isNaN(v) && v >= 0) avg[k].push(v); };

function note(j) {
  const r = j.result || {};
  if (j.status === 'blocked' || j.status === 'failed') {
    const e = String(j.error || '');
    let tag = /modbus|link/i.test(e) ? 'link' : /unreachable|ETIMEDOUT|502/i.test(e) ? 'rig' : /evidence|measure/i.test(e) ? 'no evidence' : /cancel/i.test(e) ? 'cancelled' : /harness/i.test(e) ? 'harness' : /E11000|duplicate/i.test(e) ? 'dup key' : 'error';
    return `${j.status}: ${tag} (${clean(e, 60)})`;
  }
  if (j.type === 'engineer') {
    const p = projById.get(String(j.projectId));
    const v = p?.verdicts || [];
    const ok = v.filter((x) => x.status === 'verified').length;
    const ls = r.lastSimRun;
    return `${v.length ? `${ok}/${v.length} verified` : r.status || ''}${ls ? `; last run ${ls.passed}p/${ls.failed}f/${ls.blocked}b` : ''}${r.attempts ? `; ${r.attempts} attempt(s)` : ''}`;
  }
  if (j.type === 'fault_and_improve') return `${r.fault || j.faultId}: ${r.outcome || '?'}${r.rsi?.verdict ? `; rsi ${r.rsi.verdict}` : ''}`;
  if (r.verdict) return r.verdict;
  return clean(JSON.stringify(r), 60) || '';
}

const rows = [];
const details = [];
let rigSecs = 0;
let lastJobEnd = null;
for (const j of jobs) {
  const start = j.startedAt, end = j.finishedAt;
  const dur = start ? secs(start, end || now) : null;
  if (dur) rigSecs += dur;
  const kind = KIND[j.type] || j.type;
  const running = !end && start;
  const resumed = j.interruptedAt ? ` (resumed; created ${local(j.createdAt)})` : '';
  rows.push(`| ${local(start || j.createdAt)} | ${end ? local(end) : running ? '_running_' : 'n/a'} | ${start ? mss(dur) + (running ? '+' : '') : 'n/a (never started)'} | ${kind} | ${j.status} | ${short(j._id)} | ${short(j.projectId)} | ${note(j)}${resumed} |`);

  // ---- detail
  const id = String(j._id);
  const js = stages.filter((s) => s.jobId === id);
  const jev = events.filter((e) => e.jobId === id);
  const wEnd = end || now;
  const lines = [];
  const linkEv = jev.filter((e) => /link up ([\d.]+) s/i.test(e.message || ''));
  const linkMsFromEv = linkEv.map((e) => parseFloat(e.message.match(/link up ([\d.]+) s/i)[1]));
  const wStart = start ? new Date(Math.min(D(start), ...js.filter((s) => s.startedAt).map((s) => D(s.startedAt)))) : null;
  const jDeploys = !wStart ? [] : deploys.filter((d) => inWin(d.createdAt, wStart, wEnd) && (!j.projectId || String(pvById.get(String(d.plcVersionId))?.projectId) === String(j.projectId)));
  const jCompiles = !wStart ? [] : compiles.filter((c) => c.stage !== 'preflight' && inWin(c.createdAt, wStart, wEnd) && (!j.projectId || String(pvById.get(String(c.plcVersionId))?.projectId) === String(j.projectId)));
  const jSims = !wStart ? [] : simRuns.filter((s) => inWin(s.startedAt, wStart, wEnd) && (!j.projectId || String(s.projectId) === String(j.projectId)));

  if (js.length) {
    lines.push('| stage | attempt | start | end | dur | status | detail |', '|---|---|---|---|---|---|---|');
    let deployIdx = 0, linkIdx = 0;
    for (const s of js) {
      const d = secs(s.startedAt, s.finishedAt);
      let det = '';
      const o = s.output || {};
      if (s.stage === 'tests' && o.passed != null) det = `${o.passed} pass / ${o.failed} fail / ${o.blocked} blocked`;
      else if (s.stage === 'verification' && o.status) det = `${o.status}${o.verified != null ? ` (${o.verified}/${o.supported ?? '?'})` : ''}`;
      else if (s.stage === 'simulate' && o.simRunId) { const sr = simById.get(String(o.simRunId)); det = sr ? `sim_run ${short(sr._id)}: ${sr.passed ?? '?'}p/${sr.failed ?? '?'}f/${sr.blocked ?? '?'}b, ${fs(secs(sr.startedAt, sr.finishedAt))}` : `sim_run ${short(o.simRunId)}`; }
      else if (s.stage === 'deploy') {
        const t0 = D(s.startedAt), t1 = new Date(D(s.finishedAt || now).getTime() + 3000);
        const dep = jDeploys.find((d) => D(d.createdAt) >= t0 && D(d.createdAt) <= t1);
        const ev = linkEv.find((e) => D(e.ts) >= t0 && D(e.ts) <= t1);
        const lu = dep?.linkUpMs != null ? dep.linkUpMs / 1000 : ev ? parseFloat(ev.message.match(/link up ([\d.]+) s/i)[1]) : null;
        det = `link-up ${lu != null ? fs(lu) : 'n/a'}`;
        push('link-up', lu);
      }
      if (s.error) det = (det ? det + '; ' : '') + clean(s.error, 60);
      lines.push(`| ${s.stage} | ${s.attempt ?? 0} | ${local(s.startedAt)} | ${s.finishedAt ? local(s.finishedAt) : '_running_'} | ${fs(d)} | ${s.status} | ${det} |`);
      const key = { requirements: 'requirements', io_design: 'io_design', plc_code: 'plc_code', compile: 'compile (stage)', deploy: 'deploy', diagnosis: 'diagnosis', repair: 'repair' }[s.stage];
      // skip requirements stage durations that span an interruption (> 5 min)
      if (key && s.status === 'done' && !(s.stage === 'requirements' && d > 300)) push(key, d);
      if (s.stage === 'repair' && s.startedAt) {
        const nextSim = js.find((x) => x.stage === 'tests' && (x.attempt ?? 0) === (s.attempt ?? 0) + 1 && x.finishedAt);
        if (nextSim) push('repair round (repair start -> re-test done)', secs(s.startedAt, nextSim.finishedAt));
      }
    }
  } else {
    // No stages docs: derive per-stage spans from events (first..last event per stage)
    const spans = [];
    for (const e of jev) {
      const k = e.stage || '(job)';
      const last = spans[spans.length - 1];
      if (last && last.stage === k) { last.end = e.ts; last.n++; if (e.level !== 'info') last.msg = e.message; }
      else spans.push({ stage: k, start: e.ts, end: e.ts, n: 1, msg: e.level !== 'info' ? e.message : '' });
    }
    if (spans.length) {
      lines.push('_No `stages` docs for this job; spans below are from `events` (first..last event of each consecutive stage run; approximate, lower bound)._', '', '| stage (events) | start | last event | span | events | note |', '|---|---|---|---|---|---|');
      for (const sp of spans) lines.push(`| ${sp.stage} | ${local(sp.start)} | ${local(sp.end)} | ${fs(secs(sp.start, sp.end))} | ${sp.n} | ${clean(sp.msg, 60)} |`);
    } else lines.push('_No `stages` or `events` recorded for this job._');
  }

  // test rounds from sim_runs
  if (jSims.length) {
    lines.push('', '| test round (sim_runs) | start | end | dur | pass | fail | blocked | fault |', '|---|---|---|---|---|---|---|---|');
    jSims.forEach((s, i) => {
      const d = secs(s.startedAt, s.finishedAt);
      if (s.finishedAt) push('test round', d);
      lines.push(`| #${i + 1} ${short(s._id)} | ${local(s.startedAt)} | ${s.finishedAt ? local(s.finishedAt) : end ? 'unfinished' : '_running_'} | ${fs(d)} | ${s.passed ?? 'n/a'} | ${s.failed ?? 'n/a'} | ${s.blocked ?? 'n/a'} | ${s.faultId || '-'} |`);
    });
  }
  // compile/deploy records (toolchain level)
  if (jCompiles.length || jDeploys.length) {
    const parts = [];
    for (const c of jCompiles) { push('compile (toolchain)', c.durationMs != null ? c.durationMs / 1000 : null); parts.push(`compile ${local(c.createdAt)} ${c.ok ? 'ok' : 'FAIL'} ${c.durationMs != null ? fs(c.durationMs / 1000) : 'n/a'}`); }
    for (const d of jDeploys) { if (!js.length && d.linkUpMs != null) push('link-up', d.linkUpMs / 1000); parts.push(`deploy ${local(d.createdAt)} link-up ${d.linkUpMs != null ? fs(d.linkUpMs / 1000) : 'n/a'}`); }
    lines.push('', `Toolchain records: ${parts.join(' · ')}`);
  }
  if (!js.length) {
    const jRep = repairs.filter((r) => inWin(r.createdAt, start || j.createdAt, wEnd) && (!j.projectId || String(r.projectId) === String(j.projectId)));
    for (const r of jRep) {
      const after = simById.get(String(r.afterSimRunId));
      const diag = diagnoses.find((d) => String(d._id) === String(r.diagnosisId));
      lines.push('', `Repair ${short(r._id)}: diagnosis saved ${diag ? local(diag.createdAt) : 'n/a'} → new version ${local(r.createdAt)}${diag ? ` (${fs(secs(diag.createdAt, r.createdAt))} codegen)` : ''} → re-test done ${after?.finishedAt ? local(after.finishedAt) : 'n/a'}${after?.finishedAt ? ` (${fs(secs(r.createdAt, after.finishedAt))})` : ''}; outcome ${r.outcome || 'n/a'}`);
      if (after?.finishedAt) push('repair round (repair start -> re-test done)', secs(diag?.createdAt || r.createdAt, after.finishedAt));
    }
  }
  const jProp = proposals.filter((p) => p.jobId === id);
  for (const p of jProp) lines.push('', `Evolve/gate: proposal ${short(p._id)} at ${local(p.createdAt)}${p.verdict ? `, verdict ${p.verdict}` : ''}${j.result?.verdict || j.result?.rsi?.verdict ? ` (job verdict ${j.result?.verdict || j.result?.rsi?.verdict})` : ''}`);

  details.push(`### ${local(start || j.createdAt)} ${kind} ${short(j._id)} (${j.status}, ${start ? mss(dur) : 'n/a'})\n\n${lines.join('\n')}\n`);
  if (end && (!lastJobEnd || D(end) > lastJobEnd)) lastJobEnd = D(end);
}

const runningJobs = jobs.filter((j) => j.startedAt && !j.finishedAt);
const wk = workers.map((w) => `${w._id}: ${w.currentJobId ? 'busy on ' + short(w.currentJobId) : 'idle'} (heartbeat ${local(w.heartbeatAt)})`).join('; ');
const runningLine = runningJobs.length
  ? runningJobs.map((j) => `${KIND[j.type] || j.type} ${short(j._id)} since ${local(j.startedAt)} (${mss(secs(j.startedAt, now))})`).join('; ')
  : `nothing (last job ended ${lastJobEnd ? local(lastJobEnd) : 'n/a'})`;

const stat = (a) => { if (!a.length) return ['n/a', 'n/a', 'n/a', 0]; const s = [...a].sort((x, y) => x - y); const mean = a.reduce((x, y) => x + y, 0) / a.length; const med = s[Math.floor((s.length - 1) / 2)]; return [fs(mean), fs(med), `${fs(s[0])}–${fs(s[s.length - 1])}`, a.length]; };
const avgRows = Object.entries(avg).map(([k, a]) => { const [m, md, r, n] = stat(a); return `| ${k} | ${m} | ${md} | ${r} | ${n} |`; });
const cg = ['requirements', 'io_design', 'plc_code'].map((k) => avg[k]).every((a) => a.length) ? ['requirements', 'io_design', 'plc_code'].reduce((s, k) => s + avg[k].reduce((x, y) => x + y, 0) / avg[k].length, 0) : null;

const byKind = {};
for (const j of jobs) { const k = KIND[j.type] || j.type; byKind[k] = (byKind[k] || 0) + 1; }
const md = `# MongoMation timeline

Updated ${local(now).slice(0, 5)} local (UTC-7) · auto-refreshes every 3 min · read-only from Atlas

- **Jobs today:** ${jobs.length} (${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(', ')}); ${jobs.filter((j) => j.status === 'completed').length} completed, ${jobs.filter((j) => j.status === 'blocked').length} blocked, ${jobs.filter((j) => j.status === 'failed').length} failed
- **Total rig time:** ${hms(rigSecs)} (sum of job start→end)
- **Running now:** ${runningLine}${wk ? ` · worker ${wk}` : ''}

## Jobs today (oldest first)

| start | end | dur | kind | status | job | project | note |
|---|---|---|---|---|---|---|---|
${rows.join('\n')}

## Averages (today, from data)

| stage | mean | median | range | n |
|---|---|---|---|---|
${avgRows.join('\n')}

Codegen (requirements + io_design + plc_code, sum of means): ${cg != null ? fs(cg) : 'n/a'}. Requirements durations > 5 min are excluded (they span a worker interruption). "test round" = one \`sim_runs\` doc start→finish; "link-up" = \`deployments.linkUpMs\` or the "Modbus link up X s" deploy event.

## Stage breakdown per job

${details.join('\n')}
`;

const tmp = OUT + '.tmp';
writeFileSync(tmp, md);
renameSync(tmp, OUT);
console.log(`wrote ${OUT} at ${local(now)} (${jobs.length} jobs)`);
