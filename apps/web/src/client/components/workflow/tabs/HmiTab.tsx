// HMI tab (Ali's PANES.hmi). The 3D machine (factory3d) sits exactly where Ali's flat SVG mimic was, inside the same
// "Operator HMI" card, with Ali's operator panel beside it; the side stack keeps Live simulator + Fault injection.
// Every value is a real rig tag from Atlas. The fault button creates a REAL paid job, so it sits behind a confirm.
import * as React from 'react';
import { useJobMutation } from '@/client/lib/api';
import {
  RIG_FRESH_MS, faultPreconditionFailures,
  type DashboardData, type JobCreated, type ProjectData, type RigLite, type SceneLite,
} from '@/shared/mongomation';
import { HMI_PARTS, type RunView } from '@/client/plcflow/model';
import { createFactory, type FactoryApi } from '@/client/plc3d/factory3d.js';
import { t8 } from './ProgramTab';

function Machine({ rig }: { rig: RigLite | null }) {
  const host = React.useRef<HTMLDivElement>(null);
  const f = React.useRef<FactoryApi | null>(null);
  React.useEffect(() => {
    if (!host.current) return;
    f.current = createFactory(host.current, { offset: 0, quality: 'low', labels: 'auto', reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
    return () => { f.current?.dispose(); f.current = null; };
  }, []);
  React.useEffect(() => {
    if (!f.current || !rig) return;
    const t = rig.tags;
    f.current.setIO({ tags: t, running: !!t['Start light'], fault: !!t['Reset light'], forced: rig.forced.filter((n) => n in t) });
  }, [rig]);
  return <div className="f3d" ref={host} style={{ flex: 1, minWidth: 0 }} />;
}

/* Ali's OPERATOR panel (START / STOP / RESET / E-STOP, lamps, COUNT), drawn from the live tags. Operator writes are not
   exposed by the app, so the buttons show the live state of their PLC inputs and stay inert. */
function OperatorPanel({ tags }: { tags: Record<string, boolean | number> }) {
  const lamp = (on: boolean, c: string) => (on ? c : '#CFCCC4');
  const pressed = (n: string) => (tags[n] ? { stroke: '#1b2127', strokeWidth: 2 } : {});
  const cnt = typeof tags.Counter === 'number' ? String(tags.Counter).padStart(4, '0') : '—';
  return (<svg viewBox="0 0 172 250" style={{ width: 172, flex: 'none', alignSelf: 'flex-start', margin: 10 }} aria-label="Operator panel">
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

export default function HmiTab({ run, p, dash, scene, signedIn }: { run: RunView; p: ProjectData | null; dash: DashboardData | null; scene: SceneLite | null; signedIn: boolean }) {
  const faultM = useJobMutation<{ projectId: string; faultId?: string }, JobCreated>('injectFaultAndImprove');
  const [faultSel, setFaultSel] = React.useState('');
  if (!p || !run.deployed) return <div className="empty"><b>HMI not generated yet</b>It's built from the I/O map once the program is deployed.</div>;
  const rig = dash?.rig ?? null;
  const rigFresh = rig?.ageMs != null && rig.ageMs < RIG_FRESH_MS;
  const t = rig?.tags ?? {};
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
  const hint = !rigFresh ? 'Rig offline — the machine shows the last known tag values from Atlas.'
    : forced.length ? <><b style={{ color: 'var(--ca)' }}>FORCED</b> — {forced.join(', ')} {forced.length > 1 ? 'are' : 'is'} forced on the rig. Watch the program react.</>
      : 'Live — the machine and panel show the real Factory I/O tag values streamed from Atlas.';
  return (<div className="g-side">
    <div className="card"><div className="ch"><h2>Operator HMI</h2><span className="sub">generated from the I/O map · bound to live PLC tags</span><span className="r">{rigFresh ? <span className="pill go"><i />live</span> : <span className="pill stop"><i />rig offline</span>}</span></div>
      <div className="cb">
        <div className="hmi"><div className="hmi-bar"><span>{(scene?.title ?? p.project?.sceneId ?? 'Station').toUpperCase()}</span><span style={{ color: 'var(--ink4)' }}>screen 1/1</span>
          <span className={`alarm ${rigFresh && t['Reset light'] ? 'on' : rigFresh && forced.length ? 'forced' : ''}`}>{alarm}</span></div>
          <div style={{ display: 'flex', alignItems: 'stretch' }}><Machine rig={rig} /><OperatorPanel tags={t} /></div></div>
        <p className="hint">{hint}</p></div></div>
    <div className="stack">
      <div className="card"><div className="ch"><h3>Live simulator</h3><span className="r">{rig?.factoryio?.reachable ? <span className="pill go"><i />connected</span> : <span className="pill stop"><i />unreachable</span>}</span></div><div className="cb">
        <div className="kv"><span>OpenPLC</span><span className="mono">{rig?.openplc?.running ? 'RUNNING' : rig?.openplc?.reachable ? 'STOPPED' : 'unreachable'} · v{p.project?.currentVersion ?? '—'}</span></div>
        <div className="kv"><span>Factory I/O</span><span className="mono">{rig?.factoryio?.detail ?? '—'}</span></div>
        <div className="kv"><span>Rig status</span><span className="mono">{rig?.ageMs != null ? `${Math.round(rig.ageMs / 1000)} s ago` : '—'}</span></div>
        {rig?.dcvUrl ? <div className="kv"><span>Simulator view</span><a className="mono" href={rig.dcvUrl} target="_blank" rel="noreferrer">open DCV ↗</a></div> : null}</div></div>
      <div className="card"><div className="ch"><h3>Fault injection</h3></div><div className="cb">
        <select className="f" value={faultId ?? ''} onChange={(e) => setFaultSel(e.target.value)} disabled={!faults.length}>{faults.length ? faults.map((f) => <option key={f.id} value={f.id}>{f.title ?? f.id}{f.tag ? ` (${f.tag})` : ''}</option>) : <option value="">No faults registered for this scene</option>}</select>
        <button className="btn hz" style={{ width: '100%', marginTop: 10 }} disabled={fails.length > 0 || faultM.isPending || !faults.length} onClick={inject}>{faultM.isPending ? 'Sending…' : 'Inject fault'}</button>
        <p className="hint" style={{ marginTop: 8 }}>{faultM.data ? <>Job <span className="mono">{faultM.data.jobId}</span> queued.</> : fails.length ? `Unavailable: ${fails.join('; ')}.` : 'Forces a sensor through the Factory I/O Web API, then watches the program react.'}</p>
        {p.faults.map((f) => <div key={f.id} className="kv"><span>{faults.find((x) => x.id === f.faultId)?.title ?? f.faultId ?? f.tag}{f.readBack ? <span className="mono" style={{ color: 'var(--ink4)' }}> · read-back {f.readBack}</span> : null}</span><span className={`pill ${f.status === 'released' || f.status === 'handled' ? 'go' : 'ca'}`}>{f.status ?? '—'}</span></div>)}
      </div></div>
    </div></div>);
}

/** Ali's HMI build checklist (used by the Build tab's step 3 pane). */
export function HmiChecklist({ built, doing }: { built: number; doing: number }) {
  return <div className="checklist">{HMI_PARTS.map(([t], i) => <div key={t} className={`ci ${i < built ? 'done' : i === doing ? 'doing' : ''}`}><span className="b" />{t}</div>)}</div>;
}
