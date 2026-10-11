// Harness tab (Ali's PANES.harness): version track, latest change + benchmark gate, "does the harness help?" ablation —
// all from the live RSI and ablation read models; no number is shown that Atlas does not hold.
import * as React from 'react';
import type { AblationData, HarnessScoresLite, ProjectData, RsiData } from '@/shared/mongomation';
import type { RunView } from '@/client/plcflow/model';

const pct = (v?: number) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const usd = (v?: number) => (v == null ? '—' : `$${v.toFixed(2)}`);
const num = (v?: number) => (v == null ? '—' : String(+v.toFixed(2)));
function delta(a?: number, b?: number, fmt: (n: number) => string = (n) => String(+n.toFixed(2)), lowerIsBetter = false) {
  if (a == null || b == null) return <td className="m">—</td>;
  const d = b - a;
  const good = lowerIsBetter ? d < 0 : d > 0;
  return <td className={`m ${d === 0 ? '' : good ? 't-go' : 't-stop'}`}>{d === 0 ? '±0' : `${d > 0 ? '+' : '−'}${fmt(Math.abs(d))}`}</td>;
}
const verdictPill = (v?: string) => (v === 'kept' || v === 'accepted' ? 'go' : v === 'rolled_back' ? 'ca' : v === 'rejected' ? 'stop' : 'nt');
const verdictText = (v?: string) => (v ?? 'pending').replace(/_/g, ' ');
const when = (d?: Date | string) => { if (!d) return '—'; const t = new Date(d); return Number.isNaN(t.getTime()) ? '—' : t.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const DiffBox = ({ lines }: { lines: string[] }) => <div className="diff" style={{ marginBottom: 16 }}>{lines.map((l, i) => <div key={i} className={l.startsWith('+') ? 'p' : l.startsWith('-') ? 'm' : 'c'}>{l}</div>)}</div>;
const condLabel =(key: string) => (key === 'bare' ? 'Bare model, one shot' : key === 'v0' ? 'Harness v0' : `Harness ${key} (evolved)`);

export default function HarnessTab({ run, rsi, abl, p }: { run: RunView; rsi: RsiData | null; abl: AblationData | null; p?: ProjectData | null }) {
  if (!rsi) return <div className="empty"><b>Loading harness</b>from Atlas</div>;
  const vs = [...rsi.versions].reverse(), a = rsi.active;
  const conds = abl?.summary?.conditions ?? [];
  const s: HarnessScoresLite | undefined = a?.scores, ps = a?.parentScores;
  const prop = rsi.latestProposal;
  return (<div className="stack">
    <div className="card"><div className="ch"><h2>Harness versions</h2><span className="r sub">each change must beat a frozen benchmark without weakening safety</span></div>
      <div className="cb"><div className="vtrack">{vs.length ? vs.map((v, i) => {
        const cur = a?.version === v.version, dead = v.verdict === 'rejected' || v.verdict === 'rolled_back';
        return (<React.Fragment key={v.version}>{i ? <span className="varrow">→</span> : null}
          <div className={`vnode ${cur ? 'cur' : dead ? 'dead' : ''}`}><div className={`v ${cur ? 't-me' : ''}`}>v{v.version}</div>
            <div className="d">{(v.rationale ?? v.gateNote ?? `${v.rulesCount} rules`).slice(0, 80)}</div>
            <span className={`pill ${cur ? 'me' : v.verdict === 'kept' || v.verdict === 'accepted' ? 'go' : dead ? 'stop' : 'nt'}`}>{cur ? 'kept · current' : (v.verdict ?? (v.parent == null ? 'seed' : 'pending')).replace(/_/g, ' ')}</span></div></React.Fragment>);
      }) : <div className="empty" style={{ padding: 20, flex: 1 }}>No harness versions in Atlas yet</div>}</div></div></div>
    <div className="grid2">
      <div className="card"><div className="ch"><h3>Latest change · v{a?.version ?? '—'}</h3><span className="r">{a ? <span className={`pill ${verdictPill(a.verdict)}`}><i />{a.verdict ? verdictText(a.verdict) : 'active'}</span> : null}</span></div><div className="cb">
        {a?.rationale ? <><p className="lbl">{a.restoredFrom != null ? 'What changed' : 'Failure pattern'}</p><p style={{ margin: '0 0 14px', fontSize: 13.5, lineHeight: 1.55, color: 'var(--ink2)' }}>{a.rationale}</p></> : null}
        {a ? <><p className="lbl">Config change · v{a.parent ?? '—'} → v{a.version}</p>
          {rsi.activeRuleDiff?.length ? <DiffBox lines={rsi.activeRuleDiff} />
            : <p className="hint" style={{ margin: '0 0 16px' }}>{rsi.activeRuleDiff ? `No rule changes${a.restoredFrom != null ? ` (restore of v${a.restoredFrom})` : ''}` : 'Rule diff vs parent not available'}{a.rulesCount ? ` · ${a.rulesCount} rule${a.rulesCount === 1 ? '' : 's'} in v${a.version}` : ' · rule set is empty'}</p>}</> : null}
        {s ? <><p className="lbl">Benchmark gate · v{a?.parent ?? '—'} → v{a?.version}{s.cases ? ` · ${s.cases} frozen cases` : ''}</p><table><tbody>
          <tr><td>Requirement satisfaction</td><td className="m">{pct(ps?.requirement_satisfaction)} → {pct(s.requirement_satisfaction)}</td>{delta(ps?.requirement_satisfaction, s.requirement_satisfaction, (n) => String(Math.round(n * 100)))}</tr>
          <tr><td>Safety requirements</td><td className="m">{pct(ps?.safety_pass_rate)} → {pct(s.safety_pass_rate)}</td>{delta(ps?.safety_pass_rate, s.safety_pass_rate, (n) => String(Math.round(n * 100)))}</tr>
          <tr><td>Repairs per case</td><td className="m">{num(ps?.repairs_per_case)} → {num(s.repairs_per_case)}</td>{delta(ps?.repairs_per_case, s.repairs_per_case, undefined, true)}</tr>
          <tr><td>Cost per case</td><td className="m">{usd(ps?.cost_usd_per_case)} → {usd(s.cost_usd_per_case)}</td>{delta(ps?.cost_usd_per_case, s.cost_usd_per_case, (n) => `$${n.toFixed(2)}`, true)}</tr></tbody></table>
          {a?.gateNote ? <p className="hint">{a.gateNote}</p> : null}</>
          : <div className="empty" style={{ padding: 24 }}>No benchmark scores recorded for the active harness</div>}</div></div>
      <div className="card"><div className="ch"><h3>Does the harness help?</h3><span className="r sub">held-out cases · same model · same grader</span></div><div className="cb">
        {conds.length ? <>
          <div className="bars">{conds.map((c, i) => { const v = c.scores?.requirement_satisfaction;
            return <div key={c.key} className="brow"><div className="top"><span>{condLabel(c.key)}</span><b>{pct(v)}</b></div><div className="btrack"><i style={{ width: `${Math.round((v ?? 0) * 100)}%`, background: i === conds.length - 1 ? 'var(--sig)' : i ? 'var(--graphite)' : 'var(--line3)' }} /></div></div>; })}</div>
          <p className="lbl" style={{ marginTop: 22 }}>Also measured</p>
          <table><tbody>
            <tr><td>Compiles first try</td><td className="m">{conds.map((c) => pct(c.scores?.compile_first_try)).join(' → ')}</td></tr>
            <tr><td>Safety requirements met</td><td className="m">{conds.map((c) => pct(c.scores?.safety_pass_rate)).join(' → ')}</td></tr>
            <tr><td>Repairs per case</td><td className="m">{conds.map((c) => num(c.scores?.repairs_per_case)).join(' → ')}</td></tr></tbody></table></>
          : <div className="empty" style={{ padding: 24 }}>{abl?.inProgress ? `Ablation running · ${abl.inProgress.rows} rows so far` : 'No ablation has finished yet'}</div>}
        {run.finished && p ? <p className="hint">This run: {p.testCounts.failed} failed test{p.testCounts.failed === 1 ? '' : 's'}{p.diagnosis?.lessons.length ? ` · ${p.diagnosis.lessons.length} lesson${p.diagnosis.lessons.length > 1 ? 's' : ''} recorded` : ''}{prop ? ` · latest proposal ${prop.verdict ?? 'pending'}` : ' · no harness proposal'}.</p> : null}
      </div></div>
    </div>
    <style>{`.hx-sub{margin:0 0 14px;font-size:13.5px;line-height:1.55;color:var(--ink2)}
.hx-viol{margin:0 0 14px;padding:8px 10px;border:1px solid var(--red-line);background:var(--red-bg);color:var(--red);font:500 12px/1.5 var(--mono)}
.hx-list{list-style:none;margin:0 0 14px;padding:0;font-size:13px;line-height:1.5;color:var(--ink2)}
.hx-list li{display:flex;gap:10px;align-items:baseline;padding:4px 0;border-bottom:1px solid var(--line)}
.hx-list li:last-child{border-bottom:0}
.hx-list b{font:600 12px/1 var(--mono);color:var(--ink);min-width:38px}
.hx-runs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
.hx-runs a,.hx-runs span{font:500 11.5px/1 var(--mono);padding:4px 6px;border:1px solid var(--line2);color:var(--ink2);text-decoration:none}
.hx-runs a:hover{border-color:var(--ink);color:var(--ink)}
.hx-meta{font:500 11px/1.4 var(--mono);color:var(--ink3);margin:0 0 14px}`}</style>
    {prop ? (() => {
      const kept = prop.verdict === 'kept' || prop.verdict === 'accepted';
      const ev = prop.evidence, rd = ev?.raindrop;
      return (<div className="card"><div className="ch"><h3>Latest proposal</h3><span className="r"><span className={`pill ${verdictPill(prop.verdict)}`}><i />{verdictText(prop.verdict)}</span></span></div><div className="cb">
        <p className="hx-meta">from v{prop.fromVersion ?? '—'} → {prop.candidateVersion != null ? `v${prop.candidateVersion}` : 'candidate (not created)'} · {when(prop.createdAt)}{prop.trigger ? ` · ${prop.trigger}` : ''}{prop.jobId ? ` · job ${prop.jobId.slice(-8)}` : ''} · proposal {prop.id.slice(-8)}</p>
        {prop.verdict === 'rejected' && prop.guardrailViolations.length ? <div className="hx-viol">Rejected by guardrail: {prop.guardrailViolations.join('; ')}</div> : null}
        {prop.diff.length ? <><p className="lbl">{kept ? 'Proposed change · applied' : 'Proposed — not applied'}</p><DiffBox lines={prop.diff} /></> : <p className="hint" style={{ margin: '0 0 14px' }}>No config change proposed.</p>}
        {prop.rationale ? <><p className="lbl">Rationale</p><p className="hx-sub">{prop.rationale}</p></> : null}
        {ev?.clusters.length ? <><p className="lbl">Evidence clusters{ev.projects != null ? ` · ${ev.projects} projects on v${ev.harnessVersion ?? '—'}` : ''}</p>
          <ul className="hx-list">{ev.clusters.map((c, i) => <li key={i}><b>×{c.count}</b><span>{c.pattern}{c.projects != null ? ` · ${c.projects} project${c.projects === 1 ? '' : 's'}` : ''}</span></li>)}</ul></> : null}
        {rd?.signals.length ? <><p className="lbl">Raindrop evidence{rd.windowDays != null ? ` · last ${rd.windowDays} days` : ''}{rd.totalEvents != null ? ` · ${rd.totalEvents} events` : ''}</p>
          <ul className="hx-list">{rd.signals.map((s, i) => <li key={i}><b>{s.events}</b><span>{s.name}{s.sentiment ? ` · ${s.sentiment.toLowerCase()}` : ''}</span></li>)}</ul></> : null}
        {prop.citedRunIds.length ? <><p className="lbl">Cited runs</p><div className="hx-runs">{prop.citedRunIds.map((id) => {
          const pid = rsi.citedRunProjects?.[id];
          return pid ? <a key={id} href={`/plc/CAB-01?project=${encodeURIComponent(pid)}`} title={`sim run ${id}`}>{id.slice(-8)}</a> : <span key={id} title={`sim run ${id}`}>{id.slice(-8)}</span>;
        })}</div></> : null}
        {rsi.recentProposals && rsi.recentProposals.length > 1 ? <><p className="lbl">Proposal history · last {rsi.recentProposals.length} of {rsi.proposalCount}</p>
          <ul className="hx-list">{rsi.recentProposals.map((r) => <li key={r.id}><span className={`pill ${verdictPill(r.verdict)}`} style={{ flex: 'none' }}>{verdictText(r.verdict)}</span><span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.summary ?? '—'}</span><span className="hx-meta" style={{ margin: 0, flex: 'none' }}>from v{r.fromVersion ?? '—'} · {when(r.createdAt)}</span></li>)}</ul></> : null}
      </div></div>);
    })() : <div className="card"><div className="ch"><h3>Latest proposal</h3></div><div className="cb"><div className="empty" style={{ padding: 24 }}>No harness proposals in Atlas yet</div></div></div>}
  </div>);
}
