// Export modal (Ali's renderExport): 4 targets, I/O address remap and the exported file, built from the REAL PLC source
// of the project's current version and its bound I/O map.
import * as React from 'react';
import type { ProjectData } from '@/shared/mongomation';
import { TARGETS, isOk, type RunView } from '@/client/plcflow/model';
import { ICON_EXPORT, isInput, type IoRow } from './ProgramTab';

const ADDR_RE = /%[IQM][XWD]?[\d.]+/g;

export default function ExportModal({ run, p, source, io, onClose }: { run: RunView; p: ProjectData | null; source: string; io: IoRow[]; onClose: () => void }) {
  const [target, setTarget] = React.useState('siemens');
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const T = TARGETS[target];
  // Only tags the program actually uses (located in the source), in source order, like Ali's usedIo().
  const inSource = new Set(source.match(ADDR_RE) ?? []);
  let ii = 0, oi = 0;
  const used = io.filter((r) => r.addr && inSource.has(r.addr)).map((r) => { const d: 'in' | 'out' = isInput(r) ? 'in' : 'out'; return { ...r, d, idx: d === 'in' ? ii++ : oi++ }; });
  const map: Record<string, string> = Object.fromEntries(used.map((v) => [v.addr!, T.addr(v.d, v.idx, v.addr!)]));
  const code = source.split('\n').map((l) => l.replace(ADDR_RE, (a) => map[a] ?? a)).join('\n');
  const ver = p?.project?.currentVersion;
  const ok = p?.verdicts.filter((v) => isOk(v.status)).length ?? 0, total = p?.verdicts.length ?? 0;
  const reqIds = p?.requirements?.items.map((r) => r.id) ?? [];
  const head = `MongoMation export · project ${p?.project?.id ?? '—'} · program v${ver ?? '—'} · ${ok}/${total} requirements verified on Factory I/O · target ${T.n}`;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const text = target === 'openplc' ? `(* ${head} *)\n${code}\n`
    : target === 'rockwell' ? `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${head.replace(/--/g, '-')} -->\n<RSLogix5000Content SchemaRevision="1.0" TargetName="SortingStation" TargetType="Program">\n <Controller Use="Context" Name="MongoMation">\n  <Programs><Program Name="MainProgram" MainRoutineName="Main">\n   <Routines><Routine Name="Main" Type="ST"><STContent>\n${code.split('\n').map((l, i) => `    <Line Number="${i}"><![CDATA[${l.replace(/]]>/g, ']]]]><![CDATA[>')}]]></Line>`).join('\n')}\n   </STContent></Routine></Routines>\n  </Program></Programs>\n </Controller>\n</RSLogix5000Content>\n`
      : `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${head.replace(/--/g, '-')} -->\n<project xmlns="http://www.plcopen.org/xml/tc6_0201">\n <fileHeader companyName="MongoMation" productName="MongoMation" productVersion="${ver ?? ''}" creationDateTime="${new Date().toISOString()}"/>\n <types><pous>\n  <pou name="${target === 'codesys' ? 'PLC_PRG' : 'Main'}" pouType="${target === 'codesys' ? 'program' : 'functionBlock'}">\n   <body><ST><xhtml xmlns="http://www.w3.org/1999/xhtml">\n${esc(code)}\n   </xhtml></ST></body>\n  </pou>\n </pous></types>\n</project>\n`;
  const download = () => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: target === 'openplc' ? 'text/plain' : 'application/xml' })); a.download = T.file;
    document.body.appendChild(a); a.click(); a.remove(); window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const copy = () => { void navigator.clipboard?.writeText(code).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200); }).catch(() => undefined); };
  return (<div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}><div className="modal" role="dialog" aria-label="Export to PLC">
    <div className="mh">{ICON_EXPORT}<h2>Export to a real PLC</h2><span className={`pill ${run.verified ? 'go' : 'ca'}`}><i />v{ver ?? '—'} · {ok}/{total} verified</span><button className="x" onClick={onClose} aria-label="Close">✕</button></div>
    <div className="mb">
      <p className="lbl">Target platform</p>
      <div className="targets">{Object.entries(TARGETS).map(([k, t]) => <button key={k} className={`tg ${target === k ? 'on' : ''}`} onClick={() => setTarget(k)}><div className="n">{t.n}</div><div className="f">{t.f}</div></button>)}</div>
      <p className="lbl">What's in the export</p>
      <ul className="incl"><li>Program v{ver ?? '—'} (the version that passed its tests)</li><li>{used.length} I/O tags with their addresses</li>
        {reqIds.length ? <li>Requirements covered: {reqIds.length > 1 ? `${reqIds[0]}–${reqIds[reqIds.length - 1]}` : reqIds[0]}</li> : null}
        <li>Test evidence summary ({p?.testCounts.passed ?? 0}/{p?.testCounts.total ?? 0}{p?.simRun ? `, sim run ${p.simRun.id}` : ''})</li>{T.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      <p className="lbl">I/O address remapping</p>
      <div className="card" style={{ boxShadow: 'none', maxHeight: 240, overflow: 'auto' }}>{used.length ? <table><thead><tr><th>Tag</th><th>Tested on (OpenPLC)</th><th>{T.n}</th></tr></thead><tbody>{used.map((v) => <tr key={v.addr}><td className="m" style={{ color: 'var(--ink)' }}>{v.tag}</td><td className="m">{v.addr}</td><td className="m" style={{ color: 'var(--leaf)', fontWeight: 600 }}>{T.addr(v.d, v.idx, v.addr!)}</td></tr>)}</tbody></table>
        : <div className="empty" style={{ border: 0, padding: 24 }}>No located I/O found in the program</div>}</div>
      {target === 'openplc' ? null : <div className="warnbox"><b>Before running on hardware:</b> the logic is verified in simulation only. Match the addresses to your real I/O modules, then do a dry run with outputs disabled and a site acceptance test. Never skip the safety circuit — E-stop must also be hard-wired.</div>}
    </div>
    <div className="mf"><span className="fn">{T.file} · {(text.length / 1024).toFixed(1)} KB</span>
      <span className="r"><button className="btn sm" onClick={copy}>{copied ? 'Copied ✓' : 'Copy code'}</button><button className="btn pri sm" onClick={download}>{ICON_EXPORT} Download</button></span></div>
  </div></div>);
}
