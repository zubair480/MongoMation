// PLC workflow page: Ali's mongomation-tabs flow 1:1 (Build · HMI · Program · Verification · Harness · Log, run stepper,
// one Build pane per run step, tabs unlocking as the run reaches them), restyled white/ink/orange. Every value comes
// from the app's Modelence live queries; Generate is the real `generate` mutation, then the page follows that project.
import * as React from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useSession } from 'modelence/client';
import { useAblation, useDashboard, useJobMutation, usePlcSource, useProject, useRsi, useScenes } from '@/client/lib/api';
import { Seo } from '@/client/components/Seo';
import {
  RIG_FRESH_MS, SPEC_MIN_CHARS, WORKER_STALE_MS, summarizeStages,
  type JobCreated, type JobLite, type DashboardData, type ProjectData, type RsiData, type AblationData, type SceneLite,
} from '@/shared/mongomation';
import { EXAMPLES, HMI_PARTS, STEPS, STEP_TAB, deriveRun, deriveTests, fmtDur, isOk, projectStatusText, readAttempts, rememberAttempt, stagesOf, type AttemptSummary, type RunView, type TestView } from '@/client/plcflow/model';
import { useAnalytics } from '@/client/lib/insights';
import './plcflow.css';
import HmiTab from '@/client/components/workflow/tabs/HmiTab';
import ProgramTab, { ioRowsOf } from '@/client/components/workflow/tabs/ProgramTab';
import VerificationTab, { TestsList } from '@/client/components/workflow/tabs/VerificationTab';
import HarnessTab from '@/client/components/workflow/tabs/HarnessTab';
import LogTab from '@/client/components/workflow/tabs/LogTab';
import ExportModal from '@/client/components/workflow/tabs/ExportModal';
import FactoryIoTab from '@/client/components/workflow/tabs/FactoryIoTab';
import PlantTab from '@/client/components/workflow/tabs/PlantTab';
import { CountUp, Gauge, Stamp } from '@/client/components/workflow/tabs/Instruments';

type Tab = 'build' | 'hmi' | 'plant' | 'fio' | 'program' | 'verify' | 'harness' | 'log';
const TABS: [Tab, string][] = [['build', 'Build'], ['hmi', 'HMI'], ['plant', 'Live plant'], ['fio', 'Factory I/O (live)'], ['program', 'Program'], ['verify', 'Verification'], ['harness', 'Harness'], ['log', 'Log']];
const ICON_EXPORT = <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>;
const LOCK = <svg className="lk" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;
const t8 = (d?: Date | string) => (d ? new Date(d).toTimeString().slice(0, 8) : '--:--:--');

/* ---------- Structured Text highlighting (Ali's hl) ---------- */
function hl(l: string) {
  return l.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/(\(\*.*?\*\))/g, '<span class="cm">$1</span>')
    .replace(/(%[IQM][XWD]?[\d.]+)/g, '<span class="ad">$1</span>')
    .replace(/\b(PROGRAM|END_PROGRAM|VAR|END_VAR|AT|IF|THEN|ELSE|ELSIF|END_IF|AND|OR|NOT|TRUE|FALSE|CASE|OF|END_CASE)\b/g, '<span class="kw">$1</span>')
    .replace(/\b(BOOL|TON|TOF|INT|DINT|TIME|R_TRIG|F_TRIG|CTU)\b/g, '<span class="ty">$1</span>').replace(/(T#\d+m?s)/g, '<span class="nu">$1</span>');
}
function Editor({ source, title, stream }: { source?: string; title: string; stream: boolean }) {
  const lines = React.useMemo(() => (source ?? '').replace(/\n+$/, '').split('\n'), [source]);
  const [shown, setShown] = React.useState(stream ? 0 : lines.length);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!stream) { setShown(lines.length); return; }
    setShown(0); let n = 0;
    const id = window.setInterval(() => { n += 1; setShown(n); if (n >= lines.length) window.clearInterval(id); }, 28);
    return () => window.clearInterval(id);
  }, [source, stream, lines.length]);
  React.useEffect(() => { if (ref.current && stream) ref.current.scrollTop = ref.current.scrollHeight; }, [shown, stream]);
  return (<>
    <div className="editor"><div className="etabs"><span className="f">main.st</span><span>{title}</span><span className="r">{source ? `${lines.length} lines` : ''}</span></div>
      <div className="code" ref={ref}>{source ? lines.slice(0, shown).map((l, i) => (
        <div key={i} className={`ln ${/\bAT\s+%/.test(l) ? 'hw' : ''}`}><b>{i + 1}</b><span dangerouslySetInnerHTML={{ __html: hl(l) + (i === shown - 1 && shown < lines.length ? '<span class="caret"></span>' : '') }} /></div>
      )) : <div className="empty" style={{ margin: 16, padding: 24 }}>No PLC program written yet</div>}</div></div>
    <div className="note"><span className="sq" />Highlighted lines are written by the harness from the verified I/O map — the model only writes logic, so it can't invent addresses.</div>
  </>);
}

// Ali's pill: done / repairing / running, and "worker down" (his PAUSED) when the worker heartbeat is stale.
const statusPill = (st: string, workerDown = false) => st === 'done' ? <span className="pill go"><i />done</span> : st === 'warn' ? <span className="pill ca"><i />repairing</span> : st === 'pending' ? <span className="pill nt">pending</span> : workerDown ? <span className="pill stop"><i />worker down</span> : <span className="pill fl"><i />running</span>;

/* ---------- compile chain + build log (from compile_results + deploy/simulate checkpoints) ---------- */
function Chain({ p }: { p: ProjectData }) {
  const st = (n: string[]) => { const d = stagesOf(p.stages, n); return d.length ? summarizeStages(d).status : 'pending'; };
  const comp = p.compiles.find((c) => c.stage === 'compile');
  const items: [string, string, string][] = [['Preflight', 'MatIEC', st(['preflight'])], ['Compile', comp?.toolchain?.split(' @')[0] || 'STruC++', st(['compile'])], ['Deploy', 'OpenPLC v4', st(['deploy'])], ['Simulator', 'Factory I/O', st(['simulate', 'tests'])]];
  return <div className="chain">{items.map(([k, v, s]) => (
    <div key={k} className={`cn ${s === 'done' ? 'on' : s === 'running' ? 'busy' : ''}`}><div className="k">{k}</div><div className="v">{s === 'done' ? '✓ ' : s === 'running' ? '… ' : s === 'failed' ? '✕ ' : ''}{v}</div></div>))}</div>;
}
function Term({ p }: { p: ProjectData }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const rows: [string, string][] = [];
  [...p.compiles].reverse().forEach((c) => {
    rows.push(['dim', `$ ${c.stage ?? 'compile'}  ${c.toolchain ?? ''}`]);
    (c.log ?? '').split('\n').filter(Boolean).slice(-12).forEach((l) => rows.push(['', `  ${l}`]));
    rows.push([c.ok ? 'ok' : c.status === 'unavailable' ? 'dim' : 'hi', `${c.ok ? '✓' : c.status === 'unavailable' ? '–' : '✕'} ${c.stage} ${c.status ?? ''} (${((c.durationMs ?? 0) / 1000).toFixed(1)} s)`]);
  });
  [...p.events].reverse().filter((e) => e.stage === 'deploy' || e.stage === 'simulate').forEach((e) => rows.push([e.level === 'error' ? 'hi' : '', `${t8(e.ts)}  ${e.stage} · ${e.message}`]));
  React.useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [rows.length]);
  return <div className="term" ref={ref}>{rows.length ? rows.map(([c, t], i) => <div key={i} className={c}>{t.startsWith('$ ') ? <><span className="pr">$</span>{t.slice(1)}</> : t}</div>) : <div className="dim">waiting for program…</div>}<div className="cur"><span className="pr">$</span> <span className="caret" /></div></div>;
}

/* ---------- tests + self-repair: shared, attempt-aware TestsList from VerificationTab ---------- */

/* ================================================================================================= */
export default function PlcWorkflowPage() {
  const { cab = 'CAB-01' } = useParams();
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project');
  const { user } = useSession();
  const dashQ = useDashboard(), scenesQ = useScenes(), projQ = useProject(projectId), rsiQ = useRsi(), ablQ = useAblation();
  const dash = dashQ.data && dashQ.data.connected ? dashQ.data : null;
  const scenes: SceneLite[] = scenesQ.data && scenesQ.data.connected ? scenesQ.data.scenes : [];
  const p: ProjectData | null = projQ.data && projQ.data.connected ? projQ.data : null;
  const rsi: RsiData | null = rsiQ.data && rsiQ.data.connected ? rsiQ.data : null;
  const abl: AblationData | null = ablQ.data && ablQ.data.connected ? ablQ.data : null;
  // Test counts everywhere = the LATEST sim run only (a self-repairing run re-runs the full suite per attempt).
  const anaQ = useAnalytics(projectId);
  const trend = anaQ.data && anaQ.data.connected ? anaQ.data.trend : [];
  const [known, setKnown] = React.useState<AttemptSummary[]>(() => readAttempts(projectId));
  React.useEffect(() => { setKnown(readAttempts(projectId)); }, [projectId]);
  const tv: TestView = deriveTests(p, known, trend);
  React.useEffect(() => { if (projectId && tv.simRunId && !tv.running && tv.tests.length) setKnown(rememberAttempt(projectId, tv)); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, tv.simRunId, tv.running, tv.tests.length]);
  const run: RunView = deriveRun(p, tv);
  const started = !!projectId;
  const curVersion = p ? (p.project?.currentPlcVersionId ?? p.plcVersions[0]?.id) : undefined;
  const srcQ = usePlcSource(curVersion);
  const source = srcQ.data && srcQ.data.connected && srcQ.data.found ? srcQ.data.source : undefined;
  const scene = scenes.find((s) => s.id === (p?.project?.sceneId ?? 'sorting-by-height-basic')) ?? scenes.find((s) => s.verified) ?? null;

  // ?tab=plant (etc.) opens a tab directly
  const [tab, setTabState] = React.useState<Tab>(() => { const q = params.get('tab'); return TABS.some(([k]) => k === q) ? q as Tab : 'build'; });
  // an explicit ?tab= on first load wins: follow-live starts off so the auto-advance can't override it
  const [follow, setFollow] = React.useState(() => { const q = params.get('tab'); return !TABS.some(([k]) => k === q); });
  const [progSub, setProgSub] = React.useState<'code' | 'io' | 'versions' | 'compile'>('code');
  const [logSub, setLogSub] = React.useState<'lessons' | 'traces' | 'durability'>('lessons');
  const [exportOpen, setExportOpen] = React.useState(false);
  const [seen, setSeen] = React.useState<Set<Tab>>(new Set(['build', 'fio', 'plant']));
  const [spec, setSpec] = React.useState('');
  const [sceneSel, setSceneSel] = React.useState('');
  const [pendingJob, setPendingJobState] = React.useState<string | null>(() => { try { return sessionStorage.getItem('mm.pendingJob'); } catch { return null; } });
  const setPendingJob = (id: string | null) => { setPendingJobState(id); try { if (id) sessionStorage.setItem('mm.pendingJob', id); else sessionStorage.removeItem('mm.pendingJob'); } catch { /* storage unavailable */ } };

  /* unlocks follow the run, exactly like Ali's */
  // every tab is always open; tabs without data yet show their own empty state
  const unlocked = new Set<Tab>(TABS.map(([k]) => k));
  const setTab = (k: Tab, user?: boolean) => { if (!unlocked.has(k)) return; if (user && started && !run.finished) setFollow(false); setTabState(k); setSeen((s) => new Set(s).add(k)); window.scrollTo({ top: 0 });
    if (user) setParams((prev) => { const n = new URLSearchParams(prev); n.set('tab', k); return n; }, { replace: true }); };
  React.useEffect(() => { if (follow && started) { const k = STEP_TAB[run.cur] as Tab; if (unlocked.has(k)) { setTabState(k); setSeen((s) => new Set(s).add(k)); } } // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.cur, follow, started, run.deployed, p?.tests.length]);

  /* Generate → real job → follow its project as soon as the worker creates it */
  const generateM = useJobMutation<{ specText: string; sceneId: string }, JobCreated>('generate');
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);
  const [dismissedJob, setDismissedJob] = React.useState<string | null>(null);
  const jobPool: JobLite[] = dash ? [dash.latestJobs.generate, dash.latestJobs.example, dash.activeJob, dash.lastJob].filter((x): x is JobLite => !!x) : [];
  // Returning to /plc/<cab>: surface this user's newest engineer job that is still queued or running.
  const myId = (user as { id?: string } | null | undefined)?.id;
  const g = dash?.latestJobs.generate ?? null;
  void g;
  // Any of this user's engineer jobs that is still queued / running (newest generate, the active job, the last job).
  const resumeJob = !projectId && myId
    ? jobPool.find((j) => j.type === 'engineer' && LIVE_JOB.includes(j.status) && j.requestedBy === myId && j.id !== dismissedJob) ?? null
    : null;
  const trackedId = pendingJob ?? resumeJob?.id ?? null;
  const tracked = trackedId ? jobPool.find((j) => j.id === trackedId) ?? null : null;
  // The job that works on the project being shown (for the live status card in the Build pane).
  const projJob = projectId ? jobPool.find((j) => j.projectId === projectId) ?? null : null;
  React.useEffect(() => {
    if (!pendingJob || !tracked?.projectId) return;
    setParams({ project: tracked.projectId }, { replace: true }); setPendingJob(null); setFollow(true); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingJob, tracked?.projectId, setParams]);
  // A pending job id from an earlier session that the dashboard no longer lists as live: stop waiting on it.
  React.useEffect(() => { if (pendingJob && tracked && !LIVE_JOB.includes(tracked.status) && !tracked.projectId) setPendingJob(null); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingJob, tracked?.status, tracked?.projectId]);
  const workerAlive = !!dash?.workers.some((w) => (w.heartbeatAgeMs ?? Infinity) < WORKER_STALE_MS);
  const rigFresh = (dash?.rig?.ageMs ?? Infinity) < RIG_FRESH_MS;
  const sceneId = sceneSel || scene?.id || '';
  const generate = () => {
    if (!user) { window.location.href = `/login?_redirect=${encodeURIComponent(location.pathname)}`; return; }
    if (!window.confirm(`Create a REAL engineering job on the MongoMation worker?\n\nScene: ${sceneId}\nWorker: ${workerAlive ? 'online' : 'OFFLINE (the job waits in the queue)'}\n\nThis calls real models and drives the real rig.`)) return;
    generateM.mutate({ specText: spec.trim(), sceneId }, { onSuccess: (r) => { setPendingJob(r.jobId); setFollow(true); } });
  };
  // Ali's example typing: a new click cancels the previous one, focuses the composer, then nudges Generate.
  const typeRun = React.useRef(0);
  const promptRef = React.useRef<HTMLTextAreaElement>(null);
  const [nudge, setNudge] = React.useState(0);
  const typeExample = async (text: string) => {
    const my = ++typeRun.current; setSpec(''); setNudge(0); promptRef.current?.focus();
    for (let i = 0; i <= text.length; i += 6) { if (my !== typeRun.current) return; setSpec(text.slice(0, i)); await new Promise((r) => setTimeout(r, 8)); }
    if (my !== typeRun.current) return; setSpec(text); setNudge(my);
  };
  const workerDown = !!dash && !workerAlive;
  // Ali's jumpStep: code/compile steps open the Build pane while live, else Program › Code / Compile.
  const jumpStep = (i: number) => {
    if (i === 0) { setProgSub('code'); setTab(run.cur === 0 ? 'build' : 'program', true); }
    else if (i === 1) { setProgSub('compile'); setTab(run.cur === 1 ? 'build' : 'program', true); }
    else setTab(STEP_TAB[i] as Tab, true);
  };
  React.useEffect(() => { const ex = EXAMPLES.find((e) => e.id === params.get('ex')); if (ex && !projectId) void typeExample(ex.text); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const newSpec = () => { setDismissedJob(projJob?.id ?? trackedId); setParams({}); setTabState('build'); setFollow(true); setSpec(''); setPendingJob(null); };

  const dots: Partial<Record<Tab, string>> = {};
  TABS.forEach(([k]) => { if (unlocked.has(k) && !seen.has(k) && k !== tab) dots[k] = k === 'verify' && (tv.failed || tv.blocked) ? 'red' : 'new'; });

  /* ================= panes ================= */
  const buildPane = () => {
    if (!started) return (<section className="hero">
      <div className="kicker">Autonomous PLC engineer</div>
      <h1>Describe the machine.<br /><em>We engineer the control system.</em></h1>
      <p className="lede">Write what the machine should do. MongoMation writes the PLC program, builds the operator HMI, and proves both on a live Factory I/O simulation.</p>
      <div className="composer"><textarea ref={promptRef} value={spec} onChange={(e) => { typeRun.current += 1; setSpec(e.target.value); }} placeholder="e.g. When Start is pressed, run the conveyor until the box reaches the end sensor. Stop always wins…" />
        <div className="cbar"><span className="mono" style={{ fontSize: 12, color: 'var(--ink3)' }}>Scene</span>
          <select value={sceneId} onChange={(e) => setSceneSel(e.target.value)}>{scenes.length ? scenes.map((s) => <option key={s.id} value={s.id} disabled={!s.verified}>{s.title ?? s.id}{s.verified ? '' : ' (unverified)'}</option>) : <option>loading scenes…</option>}</select>
          {scene ? <span className={`pill ${scene.verified ? 'go' : 'stop'}`}>{scene.verified ? 'verified' : 'unverified'}</span> : null}
          <button key={nudge} className={`btn pri gen${nudge ? ' nudge' : ''}`} disabled={spec.trim().length < SPEC_MIN_CHARS || !sceneId || generateM.isPending || !!pendingJob} onClick={generate}>{pendingJob ? (tracked?.status === 'running' ? 'Running…' : 'Queued…') : generateM.isPending ? 'Sending…' : 'Generate →'}</button></div></div>
      {trackedId ? <JobCard id={trackedId} job={tracked} dash={dash} now={now} workerAlive={workerAlive} mine={!!pendingJob}
        onFollow={tracked?.projectId ? () => { setParams({ project: tracked.projectId! }, { replace: true }); setFollow(true); } : undefined}
        onDismiss={pendingJob ? undefined : () => setDismissedJob(trackedId)} /> : null}
      {!user ? <p className="hint">Generate creates a real job — <Link to={`/login?_redirect=${encodeURIComponent(`/plc/${cab}`)}`}>sign in</Link> first.</p> : null}
      <p className="lbl" style={{ marginTop: 34 }}>Or start from an example</p>
      <div className="examples">{EXAMPLES.map((e) => (
        <button key={e.id} className="ex" onClick={() => void typeExample(e.text)}><div className="t"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={e.icon} /></svg>{e.title}</div>
          <p>{e.text.slice(0, 118)}…</p><div className="m">{e.meta} · {scene?.id ?? 'sorting-by-height-basic'}</div></button>))}</div>
    </section>);
    if (!p) return <div className="empty"><b>Loading project</b>{projectId}</div>;
    if (!p.project && !p.stages.length) return <div className="empty"><b>Project not found</b>No project <span className="mono">{projectId}</span> in Atlas. <a href="#" onClick={(e) => { e.preventDefault(); newSpec(); }}>Start a new spec →</a></div>;
    const c = run.cur;
    const live = <LiveNow p={p} tv={tv} job={projJob} dash={dash} now={now} workerAlive={workerAlive} />;
    const inner = buildInner(c);
    const recall = c === 4 ? null : <RecallBadge p={p} cab={cab} />;
    return <>{recall}{live}{inner}</>;
  };
  const buildInner = (c: number): React.ReactNode => {
    if (!p) return null;
    if (c === 0) return (<div className="card"><div className="ch"><h2>1 · PLC code generation</h2><span className="sub">spec → requirements → I/O binding → Structured Text</span><span className="r">{statusPill(run.status[0], workerDown)}</span></div>
      <div className="cb g-left"><div><p className="lbl">Requirements extracted</p><div className="reqs">{p.requirements?.items.length ? p.requirements.items.map((r) => <div key={r.id} className="req"><b>{r.id}</b><span>{r.text}{/safety|e.?stop|emergency/i.test(`${r.kind} ${r.text}`) ? <span className="sf">safety</span> : null}</span></div>) : <div className="empty" style={{ padding: 24 }}>Reading the spec…</div>}</div></div>
        <div><p className="lbl">Program</p><Editor source={source} title="IEC 61131-3 Structured Text" stream={run.status[0] === 'active' || run.status[0] === 'done'} /></div></div></div>);
    if (c === 1) return (<div className="card"><div className="ch"><h2>2 · Compile &amp; deploy</h2><span className="sub">local preflight, then the real OpenPLC toolchain</span><span className="r">{statusPill(run.status[1], workerDown)}</span></div>
      <div className="cb"><Chain p={p} /><p className="lbl">Build log</p><Term p={p} /></div></div>);
    if (c === 2) return (<div className="card"><div className="ch"><h2>3 · Building the operator HMI</h2><span className="r">{statusPill(run.status[2], workerDown)}</span></div>
      <div className="cb" style={{ maxWidth: 560 }}><Checklist built={run.deployed ? HMI_PARTS.length : 0} doing={run.deployed ? -1 : 0} />
        <p className="hint">The HMI is being generated in the <a href="#" onClick={(e) => { e.preventDefault(); setTab('hmi', true); }}>HMI tab →</a></p></div></div>);
    if (c === 3) return (<div className="card"><div className="ch"><h2>4 · Testing on simulation</h2><span className="r">{statusPill(run.status[3], workerDown)}</span></div>
      <div className="cb" style={{ maxWidth: 720 }}><TestsList p={p} tv={tv} click={false} live={!run.finished} /><p className="hint">Full results and measured timelines in <a href="#" onClick={(e) => { e.preventDefault(); setTab('verify', true); }}>Verification →</a></p></div></div>);
    // 5 · done card (real numbers only)
    const ok = p.verdicts.filter((v) => isOk(v.status)).length, repairs = p.plcVersions.filter((v) => v.createdBy === 'repair').length;
    const t0 = p.project?.createdAt ? +new Date(p.project.createdAt) : NaN;
    const t1 = Math.max(...p.stages.map((s) => (s.finishedAt ? +new Date(s.finishedAt) : 0)));
    const verified = run.verified;
    const reqTotal = p.verdicts.length || p.requirements?.items.length || 0;
    const tone: 'ink' | 'warn' | 'fail' = verified ? 'ink' : ok > 0 ? 'warn' : 'fail';
    // Experience recall: "verified-by-reuse" is final + successful but was NOT compiled, deployed or tested here.
    const reused = run.reused;
    const srcId = p.project?.reusedFrom?.projectId ?? p.project?.recall?.sourceProjectId;
    const srcTests = p.project?.reusedFrom?.tests;
    const curMeta = p.plcVersions.find((v) => v.id === p.project?.currentPlcVersionId) ?? p.plcVersions[0];
    const recalledV = curMeta?.createdBy === 'recall' ? ' (recalled)' : '';
    return (<div className="card panel">
      <RecallBadge p={p} cab={cab} />
      <div className="panel-head">
        {reused
          ? <div><h2>Verified by reuse (recalled from project {srcId ? <ProjLink id={srcId} cab={cab} /> : '—'})</h2><p>{`Program v${p.project?.currentVersion ?? '—'}${recalledV} was NOT compiled, deployed or tested on the rig in this project; the evidence is the source project's own rig run${srcTests?.total ? ` (${srcTests.passed ?? 0} / ${srcTests.total} tests passed there)` : ''}.`}</p></div>
          : <div><h2>{ok} / {reqTotal} requirements verified</h2><p>{verified ? `Program v${p.project?.currentVersion ?? '—'}${recalledV} is running on OpenPLC; the HMI is live and bound to the PLC tags.` : `Project ${projectStatusText(p.project?.status)} — see Verification for the evidence.`}</p></div>}
        <Stamp tone={tone}>{reused ? 'Reused' : verified ? 'Verified' : ok > 0 ? 'Partial' : (projectStatusText(p.project?.status) || 'Not verified')}</Stamp></div>
      <div className="panel-body">
        {reused && srcTests?.total ? <Gauge value={srcTests.passed ?? 0} total={srcTests.total} tone={tone} caption="source rig tests" /> : <Gauge value={ok} total={reqTotal} tone={tone} caption="requirements" />}
        <div className="metrics">
          <div className="metric"><div className="k">Tests{tv.attempt > 1 ? ` · attempt ${tv.attempt}` : ''}</div><div className={`v ${tv.passed === tv.tests.length && tv.tests.length ? 't-go' : ''}`}><CountUp text={tv.tests.length ? `${tv.passed} / ${tv.tests.length}` : '—'} /></div><div className="s">{tv.tests.filter((t) => t.visibility === 'public').length} public · {tv.tests.filter((t) => t.visibility === 'hidden').length} hidden{tv.version != null ? ` · v${tv.version}` : ''}</div></div>
          <div className="metric"><div className="k">Self-repairs</div><div className="v"><CountUp text={String(repairs)} /></div><div className="s">{p.diagnosis?.causes[0]?.requirementId ? ((s) => (s.length > 40 ? `${s.slice(0, 39).trimEnd()}…` : s))(`${p.diagnosis.causes[0].requirementId} · ${p.diagnosis.causes[0].fix ?? p.diagnosis.causes[0].cause ?? ''}`) : repairs ? 'see Program › Versions' : 'none needed'}</div></div>
          <div className="metric"><div className="k">Time</div><div className="v"><CountUp text={fmtDur(t1 > 0 && t0 ? t1 - t0 : undefined)} /></div><div className="s">spec → {reused ? 'verified by reuse' : verified ? 'verified' : projectStatusText(p.project?.status)}</div></div>
          <div className="metric"><div className="k">Model cost</div><div className="v"><CountUp text={p.project?.costUsd != null ? `$${p.project.costUsd.toFixed(2)}` : '—'} /></div><div className="s">harness v{p.project?.harnessVersion ?? '—'}</div></div></div></div>
      <div className="panel-foot"><p className="lbl">What next</p>
      <div className="next"><button className="btn pri" onClick={() => setExportOpen(true)} disabled={!verified || !source}>{ICON_EXPORT} Export to PLC</button><button className="btn" onClick={() => setTab('hmi', true)}>Operate the HMI</button><button className="btn hz" onClick={() => setTab('hmi', true)}>Inject a fault</button>
        <button className="btn" onClick={() => setTab('harness', true)}>What the harness learned</button><button className="btn" onClick={newSpec}>New spec</button></div></div></div>);
  };

  const panes: Record<Tab, () => React.ReactNode> = {
    build: buildPane,
    hmi: () => <HmiTab run={run} p={p} dash={dash} scene={scene} signedIn={!!user} rsi={rsi} />,
    program: () => <ProgramTab run={run} p={p} dash={dash} scene={scene} source={source} curVersionId={curVersion} onExport={() => setExportOpen(true)} sub={progSub} onSub={setProgSub} />,
    plant: () => <PlantTab />,
    fio: () => <FactoryIoTab rig={dash?.rig ?? null} connected={!!dash} />,
    verify: () => <VerificationTab run={run} p={p} tv={tv} />,
    harness: () => <HarnessTab run={run} rsi={rsi} abl={abl} p={p} />,
    log: () => <LogTab run={run} p={p} dash={dash} rsi={rsi} signedIn={!!user} sub={logSub} onSub={setLogSub} />,
  };
  const lampCls = (ok: boolean) => `lamp${ok ? '' : ' bad'}`;
  // presentation only: sliding indicator under the active tab
  const navRef = React.useRef<HTMLElement>(null);
  const [ind, setInd] = React.useState<{ x: number; w: number } | null>(null);
  const measure = React.useCallback(() => {
    const nav = navRef.current; if (nav) nav.classList.toggle('fits', nav.scrollLeft + nav.clientWidth >= nav.scrollWidth - 1);
    const el = nav?.querySelector<HTMLElement>('.tab.on'); if (!el) return;
    const x = el.offsetLeft, w = el.offsetWidth;
    setInd((o) => (o && o.x === x && o.w === w ? o : { x, w }));
  }, []);
  React.useLayoutEffect(() => { measure(); });
  React.useEffect(() => { window.addEventListener('resize', measure); void document.fonts?.ready.then(measure); return () => window.removeEventListener('resize', measure); }, [measure]);

  return (
    <div className="mmw">
      <Seo title={`${cab} · PLC`} description="MongoMation PLC workflow" />
      <div className="mock">{dash ? `Live · every value comes from MongoDB Atlas (${dash.db})` : dashQ.data && !dashQ.data.connected ? `Atlas disconnected · ${dashQ.data.error}` : 'Connecting to Atlas…'}</div>
      <header className="top">
        <div className="bar">
          <Link className="back" to={`/?cab=${encodeURIComponent(cab)}`}>← Control room</Link>
          <button className="brand" onClick={() => setTab('build', true)}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0B0B0C" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M7 16V8l5 5 5-5v8" /></svg><span>Mongo<b>Mation</b></span></button>
          <nav className="tabs" role="tablist" ref={navRef} onScroll={measure}>{ind ? <span className="tab-ind" style={{ width: ind.w, transform: `translateX(${ind.x}px)` }} /> : null}{TABS.map(([k, l]) => { const lock = !unlocked.has(k);
            return <button key={k} className={`tab ${tab === k ? 'on' : ''}`} role="tab" aria-selected={tab === k} disabled={lock} title={lock ? 'Unlocks as the run reaches it' : ''} onClick={() => setTab(k, true)}>{l}{lock ? LOCK : null}{dots[k] ? <span className={`nd ${dots[k] === 'red' ? 'red' : ''}`} /> : null}</button>; })}</nav>
          <div className="lamps"><span title={`Atlas ${dash ? 'connected' : 'disconnected'}`}><i className={lampCls(!!dash)} /><em>Atlas</em></span><span title={`Worker ${workerAlive ? 'alive' : 'down'}`}><i className={lampCls(workerAlive)} /><em>Worker</em></span><span title={`Rig ${rigFresh ? 'fresh' : 'stale'}`}><i className={lampCls(rigFresh)} /><em>Rig</em></span></div>
        </div>
        {started ? <div className="runbar"><div className="in">
          <div className="spec"><div className="k">Spec</div><div className="q">{p?.project?.specText ?? '…'}</div></div>
          <div className="steps">{STEPS.map((l, i) => (<React.Fragment key={l}>
            <button className={`sn ${workerDown && run.status[i] === 'active' ? 'paused' : run.status[i]}`} disabled={run.status[i] === 'pending'} onClick={() => jumpStep(i)}>
              <span className="c">{run.status[i] === 'done' ? '✓' : run.status[i] === 'warn' ? '!' : i + 1}</span><span><span className="t">{l}</span><br /><span className="s">{run.sub[i] || ' '}</span></span></button>
            {i < STEPS.length - 1 ? <span className={`conn ${run.status[i] === 'active' && !workerDown ? 'live' : ''}`}><i style={{ width: run.status[i] === 'done' ? '100%' : 0 }} /></span> : null}</React.Fragment>))}</div>
          <button className={`follow ${follow ? 'on' : ''}`} onClick={() => setFollow(!follow)}><span className="d" /><span>{follow ? 'Following live' : 'Follow live'}</span></button>
        </div></div> : null}
      </header>
      <main><div className="pane" key={tab}>{panes[tab]()}</div></main>
      {exportOpen && source ? <ExportModal run={run} p={p} source={source} io={ioRowsOf(p, scene)} onClose={() => setExportOpen(false)} /> : null}
    </div>
  );
}

// Experience recall badge (Build pane header + done card). Real fields only: projects.recall, metrics.runIndex.
const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id);
function ProjLink({ id, cab }: { id: string; cab: string }) {
  return <Link className="mono" to={`/plc/${encodeURIComponent(cab)}?project=${encodeURIComponent(id)}`} title={id}>{shortId(id)}</Link>;
}
function RecallBadge({ p, cab }: { p: ProjectData; cab: string }) {
  const rc = p.project?.recall;
  if (!rc?.kind || rc.kind === 'none') return null;
  const hit = rc.kind === 'near' ? `near hit${rc.score != null ? ` (score ${rc.score.toFixed(2)})` : ''}` : rc.kind === 'trusted' ? 'exact hit, trusted' : 'exact hit';
  const runIdx = p.project?.runIndex;
  const reused = p.project?.status === 'verified-by-reuse';
  return (<div className="mono" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, margin: '0 0 14px', padding: '9px 12px', border: '1px solid var(--graphite)', borderLeft: '3px solid var(--sig)', borderRadius: 3, background: 'var(--graphite)', color: '#E9EAEC', fontSize: 11.5, letterSpacing: '.03em' }}>
    <span className="pill me" style={{ height: 22 }}><i />Experience recall</span>
    <span>{hit}{rc.sourceProjectId ? <> from <ProjLinkLight id={rc.sourceProjectId} cab={cab} /></> : null}</span>
    {rc.msSaved != null ? <span>· saved ~{Math.round(rc.msSaved / 1000)} s</span> : null}
    {runIdx != null ? <span>· run #{runIdx + 1}</span> : null}
    {reused ? <span style={{ color: 'var(--sig)' }}>· verified by reuse, not re-tested on the rig</span> : rc.confirmed ? <span>· confirmed by a full rig pass</span> : null}
  </div>);
}
function ProjLinkLight({ id, cab }: { id: string; cab: string }) {
  return <Link to={`/plc/${encodeURIComponent(cab)}?project=${encodeURIComponent(id)}`} title={id} style={{ color: '#fff', textDecorationColor: 'var(--sig)' }}>{shortId(id)}</Link>;
}

function Checklist({ built, doing }: { built: number; doing: number }) {
  return <div className="checklist">{HMI_PARTS.map(([t], i) => <div key={t} className={`ci ${i < built ? 'done' : i === doing ? 'doing' : ''}`}><span className="b" />{t}</div>)}</div>;
}


/* ---------- live job / run status ---------- */
const LIVE_JOB = ['queued', 'running', 'verifying'];
const ago = (now: number, d?: Date | string, end?: Date | string) => (d ? fmtDur(Math.max(0, (end ? +new Date(end) : now) - +new Date(d))) : '—');
const jobTone = (s?: string) => (s === 'completed' ? 'go' : s === 'failed' || s === 'cancelled' ? 'stop' : 'warn');
const jobName = (j: JobLite) => `${j.type}${j.origin ? ` · ${j.origin}` : ''}`;
const KV = ({ k, children }: { k: string; children: React.ReactNode }) => <div><div className="lbl" style={{ margin: 0 }}>{k}</div><div className="mono" style={{ fontSize: 13 }}>{children}</div></div>;

function JobCard({ id, job, dash, now, workerAlive, mine, onFollow, onDismiss }: { id: string; job: JobLite | null; dash: DashboardData | null; now: number; workerAlive: boolean; mine: boolean; onFollow?: () => void; onDismiss?: () => void }) {
  const st = job?.status ?? 'queued';
  const ahead = dash?.activeJob && dash.activeJob.id !== id ? dash.activeJob : null;
  return (<div className="card" data-testid="job-card" style={{ marginTop: 18, textAlign: 'left' }}>
    <div className="ch"><h2>{job && !LIVE_JOB.includes(job.status) ? `Your job ${job.status}` : mine ? 'Your job' : 'Your job is still in progress'}</h2><span className="sub mono">{id}</span><span className="r"><span className={`pill ${jobTone(st)}`}>{st}</span></span></div>
    <div className="cb" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 14 }}>
      <KV k="Status">{st === 'queued' ? `queued${dash ? ` · ${dash.queuedCount} in queue` : ''}` : st}</KV>
      <KV k="Worker">{job?.claimedBy ?? (workerAlive ? 'not claimed yet' : 'worker offline')}</KV>
      <KV k="Elapsed">{ago(now, job?.createdAt, job?.finishedAt)}{job?.startedAt ? ` · ${job.finishedAt ? 'ran' : 'running'} ${ago(now, job.startedAt, job.finishedAt)}` : ''}</KV>
      <KV k="Project">{job?.projectId ?? 'created when the worker claims it'}</KV>
      {st === 'queued' ? <div style={{ gridColumn: '1 / -1' }}><KV k="Worker is running now">{ahead ? <>{jobName(ahead)} · <span>{ahead.id}</span>{ahead.projectId ? ` · project ${ahead.projectId}` : ''} · {ago(now, ahead.startedAt ?? ahead.createdAt)}</> : workerAlive ? 'nothing — yours starts next' : 'no worker online'}</KV></div> : null}
      {job?.error ? <div style={{ gridColumn: '1 / -1', color: 'var(--stop)' }}>{job.error}</div> : null}
      {!job ? <div style={{ gridColumn: '1 / -1' }} className="hint">Waiting for the live job record…</div> : null}
      <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
        {onFollow ? <button className="btn pri" onClick={onFollow}>Follow live →</button> : null}
        {onDismiss ? <button className="btn" onClick={onDismiss}>Hide</button> : null}</div>
    </div></div>);
}

function LiveNow({ p, tv, job, dash, now, workerAlive }: { p: ProjectData; tv: TestView; job: JobLite | null; dash: DashboardData | null; now: number; workerAlive: boolean }) {
  const runningStages = p.stages.filter((s) => s.status === 'running');
  const stage = runningStages[runningStages.length - 1] ?? null;
  const simLive = !!p.simRun && !p.simRun.finishedAt && (!p.simRun.status || p.simRun.status === 'running');
  const pending = tv.tests.filter((t) => !t.verdict);
  const current = simLive ? pending[0] ?? null : null;
  const done = tv.tests.filter((t) => t.verdict);
  const jobLive = job ? LIVE_JOB.includes(job.status) : false;
  if (!jobLive && !stage && !simLive) return null;
  const ahead = job?.status === 'queued' && dash?.activeJob && dash.activeJob.id !== job.id ? dash.activeJob : null;
  return (<div className="card" data-testid="live-now" style={{ marginBottom: 16 }}>
    <div className="ch"><h2>Live</h2><span className="sub mono">{job ? `job ${job.id}` : ''}</span><span className="r">{job ? <span className={`pill ${jobTone(job.status)}`}>{job.status}</span> : null}</span></div>
    <div className="cb" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14 }}>
      <KV k="Stage now">{stage ? `${stage.stage}${stage.attempt > 1 ? ` · attempt ${stage.attempt}` : ''} · ${fmtDur(stage.durationMs)}` : job?.status === 'queued' ? 'waiting in queue' : 'between stages'}</KV>
      <KV k="Worker">{job?.claimedBy ?? (workerAlive ? '—' : 'offline')}</KV>
      <KV k="Elapsed">{ago(now, job?.createdAt ?? p.project?.createdAt)}</KV>
      {ahead ? <KV k="Ahead in queue">{jobName(ahead)} · {ahead.id}</KV> : null}
      {tv.tests.length ? <div style={{ gridColumn: '1 / -1' }}>
        <KV k={`Tests · attempt ${tv.attempt}${tv.version != null ? ` (v${tv.version})` : ''} · ${done.length}${tv.running ? (tv.suite ? ` / ${tv.suite}` : '') : ` / ${tv.tests.length}`} finished`}>{current ? <>Running now: <b>{current.title}</b></> : simLive ? 'starting…' : 'not running'}</KV>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>{tv.tests.map((t) => <span key={t.id} className={`pill ${t.verdict ? (isOk(t.verdict) ? 'go' : 'stop') : t === current ? 'warn' : ''}`} title={t.title}>{t.title.length > 28 ? `${t.title.slice(0, 27)}…` : t.title} · {t.verdict ?? (t === current ? 'running' : 'pending')}</span>)}</div>
      </div> : null}
    </div></div>);
}
