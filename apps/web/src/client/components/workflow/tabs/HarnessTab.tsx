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
const condLabel = (key: string) => (key === 'bare' ? 'Bare model, one shot' : key === 'v0' ? 'Harness v0' : `Harness ${key} (evolved)`);

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
      <div className="card"><div className="ch"><h3>Latest change · v{a?.version ?? '—'}</h3><span className="r">{a ? <span className="pill go"><i />{a.verdict ?? 'active'}</span> : null}</span></div><div className="cb">
        {a?.rationale ? <><p className="lbl">Failure pattern</p><p style={{ margin: '0 0 14px', fontSize: 13.5, lineHeight: 1.55, color: 'var(--ink2)' }}>{a.rationale}</p></> : null}
        {prop?.diff.length ? <><p className="lbl">Config change{prop.candidateVersion != null ? ` · proposal v${prop.fromVersion ?? '—'} → v${prop.candidateVersion}` : ''}</p>
          <div className="diff" style={{ marginBottom: 16 }}>{prop.diff.map((l, i) => <div key={i} className={l.startsWith('+') ? 'p' : l.startsWith('-') ? 'm' : 'c'}>{l}</div>)}</div></> : null}
        {s ? <><p className="lbl">Benchmark gate · v{a?.parent ?? '—'} → v{a?.version}{s.cases ? ` · ${s.cases} frozen cases` : ''}</p><table><tbody>
          <tr><td>Requirement satisfaction</td><td className="m">{pct(ps?.requirement_satisfaction)} → {pct(s.requirement_satisfaction)}</td>{delta(ps?.requirement_satisfaction, s.requirement_satisfaction, (n) => String(Math.round(n * 100)))}</tr>
          <tr><td>Safety requirements</td><td className="m">{pct(ps?.safety_pass_rate)} → {pct(s.safety_pass_rate)}</td>{delta(ps?.safety_pass_rate, s.safety_pass_rate, (n) => String(Math.round(n * 100)))}</tr>
          <tr><td>Repairs per case</td><td className="m">{num(ps?.repairs_per_case)} → {num(s.repairs_per_case)}</td>{delta(ps?.repairs_per_case, s.repairs_per_case, undefined, true)}</tr>
          <tr><td>Cost per case</td><td className="m">{usd(ps?.cost_usd_per_case)} → {usd(s.cost_usd_per_case)}</td>{delta(ps?.cost_usd_per_case, s.cost_usd_per_case, (n) => `$${n.toFixed(2)}`, true)}</tr></tbody></table>
          {a?.gateNote ? <p className="hint">{a.gateNote}</p> : null}
          {prop?.guardrailViolations.length ? <p className="hint" style={{ color: 'var(--stop)' }}>Guardrail violations on the latest proposal: {prop.guardrailViolations.join('; ')}</p> : null}</>
          : <div className="empty" style={{ padding: 24 }}>No benchmark scores recorded for the active harness</div>}</div></div>
      <div className="card"><div className="ch"><h3>Does the harness help?</h3><span className="r sub">held-out cases · same model · same grader</span></div><div className="cb">
        {conds.length ? <>
          <div className="bars">{conds.map((c, i) => { const v = c.scores?.requirement_satisfaction;
            return <div key={c.key} className="brow"><div className="top"><span>{condLabel(c.key)}</span><b>{pct(v)}</b></div><div className="btrack"><i style={{ width: `${Math.round((v ?? 0) * 100)}%`, background: i === conds.length - 1 ? 'var(--me)' : i ? '#7d97b5' : '#a9aeb3' }} /></div></div>; })}</div>
          <p className="lbl" style={{ marginTop: 22 }}>Also measured</p>
          <table><tbody>
            <tr><td>Compiles first try</td><td className="m">{conds.map((c) => pct(c.scores?.compile_first_try)).join(' → ')}</td></tr>
            <tr><td>Safety requirements met</td><td className="m">{conds.map((c) => pct(c.scores?.safety_pass_rate)).join(' → ')}</td></tr>
            <tr><td>Repairs per case</td><td className="m">{conds.map((c) => num(c.scores?.repairs_per_case)).join(' → ')}</td></tr></tbody></table></>
          : <div className="empty" style={{ padding: 24 }}>{abl?.inProgress ? `Ablation running · ${abl.inProgress.rows} rows so far` : 'No ablation has finished yet'}</div>}
        {run.finished && p ? <p className="hint">This run: {p.testCounts.failed} failed test{p.testCounts.failed === 1 ? '' : 's'}{p.diagnosis?.lessons.length ? ` · ${p.diagnosis.lessons.length} lesson${p.diagnosis.lessons.length > 1 ? 's' : ''} recorded` : ''}{prop ? ` · latest proposal ${prop.verdict ?? 'pending'}` : ' · no harness proposal'}.</p> : null}
      </div></div>
    </div></div>);
}
