// HMI tab (Ali's PANES.hmi). The 3D machine (factory3d) sits exactly where Ali's flat SVG mimic was, inside the same
// "Operator HMI" card, with Ali's operator panel beside it; the side stack keeps Live simulator + Fault injection.
// Every value is a real rig tag from Atlas. The fault button creates a REAL paid job, so it sits behind a confirm.
import * as React from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { callMethod } from 'modelence/client';
import { useJobMutation } from '@/client/lib/api';
import {
  RIG_FRESH_MS, faultPreconditionFailures,
  type DashboardData, type Envelope, type JobCreated, type ProjectData, type RigLite, type RsiData, type SceneLite, type TagValue,
} from '@/shared/mongomation';
import { HMI_PARTS, type RunView } from '@/client/plcflow/model';
import { createFactory, type FactoryApi } from '@/client/plc3d/factory3d.js';
import { t8 } from './ProgramTab';
import LiveLoop from '@/client/components/workflow/LiveLoop';

/* One factory instance per scene for the whole page session: leaving the HMI tab detaches the canvas instead of disposing
   it, so coming back re-attaches the same running 3D (no rebuild, no intro). Falls back to create/dispose if the factory
   build has no attach/detach. */
type Reusable = FactoryApi & { attach?: (host: HTMLElement) => void; detach?: () => void };
let factoryCache: { key: string; api: Reusable } | null = null;
/** Rig & faults drawer open state; module-level so switching tabs doesn't reset it. Closed by default. */
let drawerOpenCache = false;

/* While a sim run samples, the worker's rig monitor pauses its own reads (worker harness/sampling.ts), so rig_status.tags freeze
   for the whole test phase. During that window the twin is fed from the newest row the test sampler wrote to `measurements`
   (server/mongomation/simlive.ts). Only real sampled values: no row newer than SAMPLE_FRESH_MS -> back to rig_status. */
const SAMPLE_FRESH_MS = 5000;
type SimLive = { live: boolean; simRunId?: string; ts?: Date; ageMs?: number; values?: Record<string, TagValue> };
type Sample = { values: Record<string, TagValue>; ageMs: number };
function useTestSample(projectId: string | undefined, testing: boolean): Sample | null {
  const q = useQuery({
    queryKey: ['mongomation.simLive', projectId],
    queryFn: () => callMethod<Envelope<SimLive>>('mongomation.simLive', { projectId: projectId ?? '' }, { errorHandler: () => undefined }),
    enabled: !!projectId && testing,
    refetchInterval: 400,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const d = q.data;
  if (!testing || !d || !d.connected || !d.live || !d.values || d.ageMs == null) return null;
  const ageMs = d.ageMs + (d.cacheAgeMs ?? 0) + Math.max(0, Date.now() - q.dataUpdatedAt);
  return ageMs < SAMPLE_FRESH_MS ? { values: d.values, ageMs } : null;
}

function Machine({ rig, sceneKey, sample }: { rig: RigLite | null; sceneKey: string; sample: Sample | null }) {
  const host = React.useRef<HTMLDivElement>(null);
  const f = React.useRef<Reusable | null>(null);
  React.useEffect(() => {
    if (!host.current) return;
    const c = factoryCache;
    if (c && c.key === sceneKey && c.api.attach) c.api.attach(host.current);
    else {
      if (c) { c.api.dispose(); factoryCache = null; }
      factoryCache = { key: sceneKey, api: createFactory(host.current, { offset: 0, quality: 'low', labels: 'auto', reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches }) as Reusable };
    }
    const api = factoryCache!.api;
    f.current = api;
    return () => {
      f.current = null;
      if (api.detach) api.detach();
      else { api.dispose(); if (factoryCache?.api === api) factoryCache = null; }
    };
  }, [sceneKey]);
  React.useEffect(() => {
    if (!f.current || !rig) return;
    if (sample) {
      // Test in progress: the sampled tags are newer than rig_status; the rest keep their last real rig_status value.
      const t = { ...rig.tags, ...sample.values };
      f.current.setIO({ tags: t, running: !!t['Start light'], fault: !!t['Reset light'], forced: rig.forced.filter((n) => n in t), online: true, ageMs: sample.ageMs });
      return;
    }
    const t = rig.tags;
    // online/ageMs let the twin go idle (and clear its boxes) when the rig is stale or OpenPLC is unreachable.
    const ageMs = rig.ageMs ?? (rig.checkedAt ? Date.now() - new Date(rig.checkedAt).getTime() : Infinity);
    const snap = { tags: t, running: !!t['Start light'], fault: !!t['Reset light'], forced: rig.forced.filter((n) => n in t), online: ageMs < RIG_FRESH_MS && !!rig.openplc?.reachable, ageMs };
    f.current.setIO(snap);
  }, [rig, sceneKey, sample]);
  return <div className="f3d" ref={host} />;
}

/* Ali's OPERATOR panel (START / STOP / RESET / E-STOP, lamps, COUNT), drawn from the live tags. Operator writes are not
   exposed by the app, so the buttons show the live state of their PLC inputs and stay inert. */
function OperatorPanel({ tags }: { tags: Record<string, boolean | number> }) {
  const lamp = (on: boolean, c: string) => (on ? c : '#CFCCC4');
  const pressed = (n: string) => (tags[n] ? { stroke: '#1b2127', strokeWidth: 2 } : {});
  const cnt = typeof tags.Counter === 'number' ? String(tags.Counter).padStart(4, '0') : '—';
  return (<svg className="oppanel" viewBox="0 0 172 250" aria-label="Operator panel">
    <g style={{ cursor: 'not-allowed' }}><title>Operator writes go through Factory I/O and are not exposed by the app</title>
      <rect x="0.5" y="0.5" width="171" height="249" rx="8" fill="#F6F5F1" stroke="#B9B5AA" />
      <text x="15" y="22" fill="#46505a" fontFamily="var(--display)" fontWeight="800" fontSize="11" letterSpacing="2" style={{ fontStretch: '125%' }}>OPERATOR</text>
      <rect x="15" y="36" width="68" height="36" rx="3" fill="#15171A" {...pressed('Start')} /><text x="49" y="59" fill="#fff" fontWeight="700" fontSize="12" textAnchor="middle">START</text>
      <rect x="91" y="36" width="68" height="36" rx="3" fill="#D7261E" /><text x="125" y="59" fill="#fff" fontWeight="700" fontSize="12" textAnchor="middle">STOP</text>
      <rect x="15" y="82" width="68" height="36" rx="3" fill="#E8A317" {...pressed('Reset')} /><text x="49" y="105" fill="#1b2127" fontWeight="700" fontSize="12" textAnchor="middle">RESET</text>
      <circle cx="125" cy="100" r="22" fill="#D7261E" stroke="#E8A317" strokeWidth="4" /><text x="125" y="104" fill="#fff" fontWeight="700" fontSize="9" textAnchor="middle">E-STOP</text>
      <g fontFamily="var(--mono)" fontSize="9.5" fill="#46505a">
        <circle cx="28" cy="146" r="7" fill={lamp(!!tags['Start light'], '#FF5A1F')} /><text x="41" y="149">RUNNING</text>
        <circle cx="28" cy="168" r="7" fill={lamp(!!tags['Reset light'], '#E8A317')} /><text x="41" y="171">FAULT / RESET</text>
        <circle cx="28" cy="190" r="7" fill={lamp(!!tags['Stop light'], '#D7261E')} /><text x="41" y="193">STOPPED</text>
      </g>
      <rect x="15" y="208" width="142" height="30" rx="4" fill="#fff" stroke="#a9aeb3" />
      <text x="25" y="227" fill="#67717b" fontFamily="var(--mono)" fontSize="9">COUNT</text>
      <text x="147" y="229" fill="#1b2127" fontFamily="var(--mono)" fontSize="17" textAnchor="end">{cnt}</text>
    </g>
  </svg>);
}

export default function HmiTab({ run, p, dash, scene, signedIn, rsi = null }: { run: RunView; p: ProjectData | null; dash: DashboardData | null; scene: SceneLite | null; signedIn: boolean; rsi?: RsiData | null }) {
  const faultM = useJobMutation<{ projectId: string; faultId?: string }, JobCreated>('injectFaultAndImprove');
  const [faultSel, setFaultSel] = React.useState('');
  const [drawer, setDrawerState] = React.useState(drawerOpenCache);
  const setDrawer = React.useCallback((v: boolean) => { drawerOpenCache = v; setDrawerState(v); }, []);
  const closeBtn = React.useRef<HTMLButtonElement>(null);
  // The drawer is position:fixed, but the tab .pane keeps an animation transform, which would trap it; portal it to the .mmw root.
  const tabRoot = React.useRef<HTMLDivElement>(null);
  const [portalHost, setPortalHost] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => { setPortalHost(tabRoot.current?.closest<HTMLElement>('.mmw') ?? document.body); }, []);
  const projectId = p?.project?.id;
  const aj = dash?.activeJob;
  const testing = p?.simRun?.status === 'running' || (!!aj && !!projectId && aj.projectId === projectId && ['running', 'verifying'].includes(aj.status));
  const sample = useTestSample(projectId, testing);
  const faultSelEl = React.useRef<HTMLSelectElement>(null);
  const focusFault = React.useRef(false);
  React.useEffect(() => {
    if (!drawer) return;
    const target = focusFault.current && faultSelEl.current && !faultSelEl.current.disabled ? faultSelEl.current : closeBtn.current;
    focusFault.current = false;
    const t = setTimeout(() => target?.focus(), 60);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false); };
    addEventListener('keydown', onKey);
    return () => { clearTimeout(t); removeEventListener('keydown', onKey); };
  }, [drawer, setDrawer]);
  // Live activity renders even before the HMI exists: early stages are when the agents are busiest.
  const loop = p ? <section className="hmi-loop" aria-label="What the system is doing, live"><h2 className="hmi-loop-h">What the system is doing · live</h2><LiveLoop p={p} dash={dash} rsi={rsi} /></section> : null;
  if (!p || !run.deployed) return <div className="hmi-tab" ref={tabRoot}><div className="empty"><b>HMI not generated yet</b>It's built from the I/O map once the program is deployed.</div>{loop}</div>;
  const rig = dash?.rig ?? null;
  const rigFresh = rig?.ageMs != null && rig.ageMs < RIG_FRESH_MS;
  const t = sample ? { ...(rig?.tags ?? {}), ...sample.values } : rig?.tags ?? {};
  const faults = scene?.faults ?? [];
  const fails = faultPreconditionFailures({
    project: p.project ? { id: p.project.id, sceneId: p.project.sceneId, finalPlcVersionId: p.project.finalPlcVersionId } : null,
    scene: scene ? { id: scene.id, verified: scene.verified } : null,
    rig: rig ? { factoryioReachable: rig.factoryio?.reachable, factoryioDetail: rig.factoryio?.detail, checkedAgeMs: rig.ageMs } : null,
  });
  if (!signedIn) fails.unshift('sign in first');
  const faultId = faultSel || faults[0]?.id;
  const faultTitle = faults.find((f) => f.id === faultId)?.title ?? faultId ?? 'scene default';
  const inject = () => {
    if (!p.project) return;
    if (!window.confirm(`Inject "${faultTitle}"?\n\nThis creates a REAL fault_and_improve job: it forces a sensor on the live rig and calls paid models to diagnose and improve the program.`)) return;
    faultM.mutate({ projectId: p.project.id, faultId });
  };
  const forced = rig?.forced ?? [];
  const alarm = !rigFresh ? `Rig offline · last seen ${rig?.checkedAt ? t8(rig.checkedAt) : 'never'}` : t['Reset light'] ? 'ALARM · fault lamp on' : forced.length ? `${forced.join(', ')} forced` : 'No active alarms';
  const hint = sample ? <><b className="ok">LIVE · TEST IN PROGRESS</b><span>Sampled from the test run: the machine shows the tag values the test harness is reading right now ({Math.round(sample.ageMs)} ms old).</span></>
    : !rigFresh ? <><b className="off">OFFLINE</b><span>The machine shows the last known tag values from Atlas.</span></>
    : forced.length ? <><b>FORCED</b><span>{forced.join(', ')} {forced.length > 1 ? 'are' : 'is'} forced on the rig. Watch the program react.</span></>
      : <><b className="ok">LIVE</b><span>The machine and panel show the real Factory I/O tag values streamed from Atlas.</span></>;
  const station = (scene?.title ?? p.project?.sceneId ?? 'Station').toUpperCase();
  const rigOk = rigFresh && !!rig?.factoryio?.reachable;
  return (<div className="hmi-tab" ref={tabRoot}>
    <div className="card"><div className="ch"><h2>Operator HMI</h2><span className="sub">generated from the I/O map · bound to live PLC tags</span><span className="r">{sample ? <span className="pill go" title="rig_status pauses while tests sample the rig; these values come from the running test's measurements"><i />LIVE · test in progress · sampled from the test run</span> : rigFresh ? <span className="pill go"><i />live</span> : <span className="pill stop"><i />rig offline</span>}
      <button type="button" className={`hmi-dtog ${rigOk ? 'ok' : 'bad'}`} aria-expanded={drawer} aria-controls="hmi-drawer" onClick={() => setDrawer(!drawer)} title="Live simulator status and fault injection"><i />Rig &amp; faults <span aria-hidden="true">▸</span></button>
      <button type="button" className="hmi-dfault" aria-label="Inject fault…" title="Inject fault…" onClick={() => { focusFault.current = true; setDrawer(true); }}><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M9 1 3 9h4l-1 6 6-8H8l1-6z" fill="currentColor" /></svg></button></span></div>
      <div className="cb">
        <div className="hmi"><div className="hmi-bar"><span className="hmi-title" title={station}>{station}</span><span className="hmi-screen">screen 1/1</span>
          <span className={`alarm ${rigFresh && t['Reset light'] ? 'al-on' : rigFresh && forced.length ? 'al-forced' : ''}`} title={alarm} role="status"><span className="alarm-t">{alarm}</span></span></div>
          <div className="hmi-body"><Machine rig={rig} sample={sample} sceneKey={scene?.id ?? p.project?.sceneId ?? 'station'} /><div className="hmi-side"><OperatorPanel tags={t} /></div></div></div>
        <p className="hmi-hint">{hint}</p></div></div>
    {portalHost ? createPortal(<>
    <div className={`hmi-scrim ${drawer ? 'open' : ''}`} onClick={() => setDrawer(false)} aria-hidden="true" />
    <aside id="hmi-drawer" className={`hmi-drawer ${drawer ? 'open' : ''}`} aria-label="Rig and fault injection" aria-hidden={!drawer}>
      <div className="hmi-drawer-h"><span>Rig &amp; faults</span><button type="button" ref={closeBtn} className="hmi-dclose" aria-label="Close" onClick={() => setDrawer(false)}>×</button></div>
      <div className="stack">
      <div className="card"><div className="ch"><h3>Live simulator</h3><span className="r">{rig?.factoryio?.reachable ? <span className="pill go"><i />connected</span> : <span className="pill stop"><i />unreachable</span>}</span></div><div className="cb">
        <div className="kv"><span>OpenPLC</span><span className="mono">{rig?.openplc?.running ? 'RUNNING' : rig?.openplc?.reachable ? 'STOPPED' : 'unreachable'} · v{p.project?.currentVersion ?? '—'}</span></div>
        <div className="kv"><span>Factory I/O</span><span className="mono">{rig?.factoryio?.detail ?? '—'}</span></div>
        <div className="kv"><span>Rig status</span><span className="mono">{rig?.ageMs != null ? `${Math.round(rig.ageMs / 1000)} s ago` : '—'}</span></div>
        {rig?.dcvUrl ? <div className="kv"><span>Simulator view</span><a className="mono" href={rig.dcvUrl} target="_blank" rel="noreferrer">open DCV ↗</a></div> : null}</div></div>
      <div className="card"><div className="ch"><h3>Fault injection</h3></div><div className="cb">
        <select ref={faultSelEl} className="f" value={faultId ?? ''} onChange={(e) => setFaultSel(e.target.value)} disabled={!faults.length}>{faults.length ? faults.map((f) => <option key={f.id} value={f.id}>{f.title ?? f.id}{f.tag ? ` (${f.tag})` : ''}</option>) : <option value="">No faults registered for this scene</option>}</select>
        <button className="btn hz" style={{ width: '100%', marginTop: 10 }} disabled={fails.length > 0 || faultM.isPending || !faults.length} onClick={inject}>{faultM.isPending ? 'Sending…' : 'Inject fault'}</button>
        <p className="hint" style={{ marginTop: 8 }}>{faultM.data ? <>Job <span className="mono">{faultM.data.jobId}</span> queued.</> : fails.length ? `Unavailable: ${fails.join('; ')}.` : 'Forces a sensor through the Factory I/O Web API, then watches the program react.'}</p>
        {p.faults.map((f) => <div key={f.id} className="kv"><span>{faults.find((x) => x.id === f.faultId)?.title ?? f.faultId ?? f.tag}{f.readBack ? <span className="mono" style={{ color: 'var(--ink4)' }}> · read-back {f.readBack}</span> : null}</span><span className={`pill ${f.status === 'released' || f.status === 'handled' ? 'go' : 'ca'}`}>{f.status ?? '—'}</span></div>)}
      </div></div>
    </div></aside></>, portalHost) : null}
    {loop}
  </div>);
}

/** Ali's HMI build checklist (used by the Build tab's step 3 pane). */
export function HmiChecklist({ built, doing }: { built: number; doing: number }) {
  return <div className="checklist">{HMI_PARTS.map(([t], i) => <div key={t} className={`ci ${i < built ? 'done' : i === doing ? 'doing' : ''}`}><span className="b" />{t}</div>)}</div>;
}
