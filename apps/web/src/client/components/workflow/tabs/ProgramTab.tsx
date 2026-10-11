// Program tab (Ali's PANES.program): Code / I/O map / Versions / Compile, every value from the real project read model.
// Also exports the Structured Text editor, compile chain and build log so the Build tab can reuse them.
import * as React from 'react';
import { usePlcSource } from '@/client/lib/api';
import { RIG_FRESH_MS, summarizeStages, type DashboardData, type ProjectData, type SceneLite } from '@/shared/mongomation';
import { stagesOf, type RunView } from '@/client/plcflow/model';

export const ICON_EXPORT = <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>;
export const t8 = (d?: Date | string) => (d ? new Date(d).toTimeString().slice(0, 8) : '--:--:--');

/* ---------- Structured Text highlighting (Ali's hl) ---------- */
export function hl(l: string) {
  return l.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/(\(\*.*?\*\))/g, '<span class="cm">$1</span>')
    .replace(/(%[IQM][XWD]?[\d.]+)/g, '<span class="ad">$1</span>')
    .replace(/\b(PROGRAM|END_PROGRAM|VAR|END_VAR|AT|IF|THEN|ELSE|ELSIF|END_IF|AND|OR|NOT|TRUE|FALSE|CASE|OF|END_CASE)\b/g, '<span class="kw">$1</span>')
    .replace(/\b(BOOL|TON|TOF|INT|DINT|TIME|R_TRIG|F_TRIG|CTU)\b/g, '<span class="ty">$1</span>').replace(/(T#\d+m?s)/g, '<span class="nu">$1</span>');
}

export function Editor({ source, title, stream = false }: { source?: string; title: string; stream?: boolean }) {
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

/* ---------- compile chain + build log (compile_results + deploy/simulate checkpoints) ---------- */
export function Chain({ p }: { p: ProjectData }) {
  const st = (n: string[]) => { const d = stagesOf(p.stages, n); return d.length ? summarizeStages(d).status : 'pending'; };
  const comp = p.compiles.find((c) => c.stage === 'compile');
  const items: [string, string, string][] = [['Preflight', 'MatIEC', st(['preflight'])], ['Compile', comp?.toolchain?.split(' @')[0] || 'STruC++', st(['compile'])], ['Deploy', 'OpenPLC v4', st(['deploy'])], ['Simulator', 'Factory I/O', st(['simulate', 'tests'])]];
  return <div className="chain">{items.map(([k, v, s]) => (
    <div key={k} className={`cn ${s === 'done' ? 'on' : s === 'running' ? 'busy' : ''}`}><div className="k">{k}</div><div className="v">{s === 'done' ? '✓ ' : s === 'running' ? '… ' : s === 'failed' ? '✕ ' : ''}{v}</div></div>))}</div>;
}

export function Term({ p }: { p: ProjectData }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const rows: [string, string][] = [];
  [...p.compiles].reverse().forEach((c) => {
    rows.push(['dim', `$ ${c.stage ?? 'compile'}  ${c.toolchain ?? ''}`]);
    (c.log ?? '').split('\n').filter(Boolean).slice(-12).forEach((l) => rows.push(['', `  ${l}`]));
    rows.push([c.ok ? 'ok' : c.status === 'unavailable' ? 'dim' : 'hi', `${c.ok ? '✓' : c.status === 'unavailable' ? '–' : '✕'} ${c.stage ?? ''} ${c.status ?? ''} (${((c.durationMs ?? 0) / 1000).toFixed(1)} s)`]);
  });
  [...p.events].reverse().filter((e) => e.stage === 'deploy' || e.stage === 'simulate').forEach((e) => rows.push([e.level === 'error' ? 'hi' : '', `${t8(e.ts)}  ${e.stage} · ${e.message}`]));
  React.useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [rows.length]);
  return <div className="term" ref={ref}>{rows.length ? rows.map(([c, t], i) => <div key={i} className={c}>{t.startsWith('$ ') ? <><span className="pr">$</span>{t.slice(1)}</> : t}</div>) : <div className="dim">waiting for program…</div>}<div className="cur"><span className="pr">$</span> <span className="caret" /></div></div>;
}

/* ---------- I/O rows: the project's bound I/O, else the scene's tag map ---------- */
export interface IoRow { tag: string; addr?: string; role?: string; nc?: boolean }
export function ioRowsOf(p: ProjectData | null, scene: SceneLite | null): IoRow[] {
  if (p?.requirements?.io.length) return p.requirements.io.map((x) => ({ tag: x.tag ?? x.variable ?? '', addr: x.address, role: x.role, nc: x.normallyClosed }));
  return (scene?.tags ?? []).map((x) => ({ tag: x.name, addr: x.plcAddress, role: x.role, nc: x.normallyClosed }));
}
export const isInput = (r: IoRow) => r.role === 'sensor' || r.role === 'input' || /^%I|%QX1[234]\./.test(r.addr ?? '');

function VersionCard({ id, version, createdBy, current, at }: { id: string; version?: number; createdBy?: string; current: boolean; at?: Date }) {
  const q = usePlcSource(id);
  const d = q.data && q.data.connected && q.data.found ? q.data : null;
  const diff = (d?.diff ?? []).filter((l) => l.startsWith('+ ') || l.startsWith('- '));
  return (<div className="card"><div className="ch"><h3>v{version ?? '—'} · {createdBy ?? 'codegen'}</h3><span className={`pill ${current ? 'go' : 'nt'}`}>{current ? <><i />current</> : 'superseded'}</span><span className="r sub">{d?.source ? `${d.source.replace(/\n+$/, '').split('\n').length} lines · ` : ''}{at ? new Date(at).toLocaleString() : ''}</span></div>
    {diff.length ? <div className="cb"><div className="diff">{diff.slice(0, 24).map((l, i) => <div key={i} className={l[0] === '+' ? 'p' : 'm'}>{l}</div>)}</div></div>
      : <div className="cb"><p style={{ margin: 0, fontSize: 13.5, color: 'var(--ink2)' }}>{!d ? (q.isLoading ? 'Loading source…' : 'Source not available') : d.diff === null ? 'First version · generated from the requirements.' : 'No line changes recorded.'}</p></div>}</div>);
}

export type ProgSub = 'code' | 'io' | 'versions' | 'compile';

export default function ProgramTab({ run, p, dash, scene, source, curVersionId, onExport, sub: subProp, onSub }: {
  run: RunView; p: ProjectData | null; dash: DashboardData | null; scene: SceneLite | null; source?: string; curVersionId?: string;
  onExport: () => void; sub?: ProgSub; onSub?: (s: ProgSub) => void;
}) {
  const [subState, setSubState] = React.useState<ProgSub>('code');
  const sub = subProp ?? subState;
  const setSub = (s: ProgSub) => { setSubState(s); onSub?.(s); };
  const subs: [ProgSub, string][] = [['code', 'Code'], ['io', 'I/O map'], ['versions', 'Versions'], ['compile', 'Compile']];
  const rig = dash?.rig ?? null;
  const rigFresh = rig?.ageMs != null && rig.ageMs < RIG_FRESH_MS;
  const rows = ioRowsOf(p, scene);
  const canExport = run.verified && !!source;
  return (<>
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16, flexWrap: 'wrap' }}>
      <div className="seg">{subs.map(([k, l]) => <button key={k} className={sub === k ? 'on' : ''} onClick={() => setSub(k)}>{l}</button>)}</div>
      <span className="mono" style={{ fontSize: 12, color: 'var(--ink3)' }}>{p?.project?.sceneId ?? '—'} · OpenPLC v4 · harness v{p?.project?.harnessVersion ?? '—'}</span>
      <button className={`btn ${canExport ? 'pri' : ''} sm`} style={{ marginLeft: 'auto' }} onClick={onExport} disabled={!canExport} title={canExport ? '' : 'Available once every requirement is verified'}>{ICON_EXPORT} Export to PLC</button></div>

    {sub === 'code' ? <Editor source={source} title={`IEC 61131-3 Structured Text · v${p?.project?.currentVersion ?? '—'}`} /> : null}

    {sub === 'io' ? (<>
      <div className="card">{rows.length ? <table><thead><tr><th></th><th>Tag</th><th>PLC address</th><th>Direction</th><th>Note</th></tr></thead><tbody>{rows.map((r) => {
        const v = rig?.tags[r.tag];
        return <tr key={r.tag}><td>{typeof v === 'number' ? <span className="mono t-fl">{v}</span> : v === undefined ? <span className="mono" style={{ color: 'var(--ink4)' }}>—</span> : <span className={`led ${v ? 'on' : ''}`} />}</td>
          <td>{r.tag}{rig?.forced.includes(r.tag) ? <> <span className="pill ca">forced</span></> : null}</td><td className="m">{r.addr ?? '—'}</td>
          <td className="m">{isInput(r) ? 'sensor → PLC' : 'PLC → actuator'}</td><td className="m">{r.nc ? 'NC' : ''}</td></tr>;
      })}</tbody></table> : <div className="empty" style={{ border: 0 }}><b>No I/O map yet</b>It is bound from the verified scene map during code generation.</div>}</div>
      <p className="hint">Values from the live rig ({rig ? (rigFresh ? 'streaming' : `stale · last seen ${rig.checkedAt ? t8(rig.checkedAt) : 'never'}`) : 'no rig status in Atlas'}).</p></>) : null}

    {sub === 'versions' ? <div className="stack">{p?.plcVersions.length ? p.plcVersions.map((v) => <VersionCard key={v.id} id={v.id} version={v.version} createdBy={v.createdBy} current={v.id === curVersionId} at={v.createdAt} />) : <div className="empty"><b>No versions yet</b>A version is written when code generation finishes.</div>}</div> : null}

    {sub === 'compile' ? (p ? <><Chain p={p} /><p className="lbl">Build log</p><Term p={p} /></> : <div className="empty"><b>No build yet</b></div>) : null}
  </>);
}
