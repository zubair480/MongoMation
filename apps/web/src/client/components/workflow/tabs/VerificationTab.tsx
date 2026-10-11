// Verification tab (Ali's PANES.verify): metrics, requirements table, tests list, self-repair and the measured
// timeline of the selected public test (real `testTimeline` samples; hidden tests never expose theirs).
import * as React from 'react';
import { usePlcSource, useTimeline } from '@/client/lib/api';
import type { ProjectData, TestLite } from '@/shared/mongomation';
import { deriveTests, isOk, stagesOf, type RunView, type TestView } from '@/client/plcflow/model';

const isSafety = (kind?: string, text?: string) => /safety|e.?stop|emergency/i.test(`${kind ?? ''} ${text ?? ''}`);

export function Repair({ p }: { p: ProjectData }) {
  const repairs = p.plcVersions.filter((v) => v.createdBy === 'repair');
  const repairing = stagesOf(p.stages, ['diagnosis', 'repair']);
  const cur = repairs[0];
  const src = usePlcSource(cur?.id);
  if (!p.diagnosis && !repairing.length) return null;
  const running = repairing.some((s) => s.status === 'running');
  const diff = src.data && src.data.connected && src.data.found ? (src.data.diff ?? []).filter((l) => l.startsWith('+ ') || l.startsWith('- ')) : [];
  return (<div className="repair" style={{ marginTop: 14 }}>
    <h3>Self-repair · {running ? 'diagnosing from measured samples…' : cur ? `fixed in v${cur.version ?? '—'}` : 'diagnosis'}</h3>
    {p.diagnosis?.summary ? <p>{p.diagnosis.summary}</p> : null}
    {p.diagnosis?.causes.slice(0, 3).map((c, i) => <p key={i}><b className="mono">{c.requirementId}</b> {c.cause}{c.fix ? ` → ${c.fix}` : ''}</p>)}
    {diff.length ? <div className="diff">{diff.slice(0, 14).map((l, i) => <div key={i} className={l[0] === '+' ? 'p' : 'm'}>{l}</div>)}</div> : null}
  </div>);
}

/** "Attempt 3 · v3 · 5 / 16 tests": which attempt of the suite the counts belong to. */
export function AttemptLine({ tv }: { tv: TestView }) {
  if (!tv.simRunId) return null;
  const counts = tv.running ? `${tv.finished}${tv.suite ? ` / ${tv.suite}` : ''} tests${tv.suite ? '' : ' run so far'}` : `${tv.passed} / ${tv.tests.length} passed`;
  return <p className="lbl" data-testid="attempt-line" style={{ margin: '0 0 8px' }}>Attempt {tv.attempt}{tv.version != null ? ` · v${tv.version}` : ''} · {counts}{tv.running ? ' · running' : ''}</p>;
}

export function TestsList({ p, tv, click, sel, onSel, live }: { p: ProjectData; tv?: TestView; click: boolean; sel?: string; onSel?: (t: TestLite) => void; live: boolean }) {
  const view = tv ?? deriveTests(p);
  const tests = view.tests;
  const done = view.finished;
  const denom = view.suite ?? tests.length;
  return (<>
    <AttemptLine tv={view} />
    <div className="progress"><i style={{ width: `${denom ? (done / denom) * 100 : 0}%` }} /></div>
    <div className="tests">{tests.length ? tests.map((t, idx) => {
      const s = t.verdict === 'passed' ? 'pass' : t.verdict === 'failed' || t.verdict === 'blocked' ? 'fail' : live ? 'run' : '';
      const c = click && t.visibility === 'public' && s !== 'run';
      return (<div key={t.id} className={`test ${s} ${t.verdict === 'blocked' ? 'blk' : ''} ${c ? 'click' : ''} ${click && sel === t.id ? 'sel' : ''}`} style={{ '--i': idx } as React.CSSProperties} onClick={c ? () => onSel?.(t) : undefined}>
        <span className="i">{s === 'pass' ? '✓' : t.verdict === 'blocked' ? '!' : s === 'fail' ? '✕' : ''}</span>
        <span className="tt">{t.visibility === 'hidden' ? `🔒 ${t.title}` : <><span className="id">{t.testId}</span>{t.title}</>}{t.verdict === 'blocked' ? <span className="sf">blocked</span> : null}</span>
        <span className="rq">{t.requirementIds.join(' ')}</span></div>);
    }) : <div className="empty" style={{ padding: 24 }}>Tests run on the live simulator after deploy.</div>}</div>
    <Repair p={p} />
  </>);
}

function Timeline({ test, live }: { test: TestLite; live: boolean }) {
  const q = useTimeline(test.simRunId, test.testId, live);
  const d = q.data && q.data.connected ? q.data : null;
  if (!test.verdict && live) return <div className="empty" style={{ padding: 24 }}>Measuring…</div>;
  if (!d) return <div className="empty" style={{ padding: 24 }}>{q.isLoading ? 'Loading measurements…' : '—'}</div>;
  if (d.hidden) return <div className="empty" style={{ padding: 24 }}>Hidden test · its measured stimulus is not exposed</div>;
  if (!d.found || !d.samples.length) return <div className="empty" style={{ padding: 24 }}>—<br />No measurements recorded for this test</div>;
  const keys = Object.keys(d.samples[0].values).slice(0, 4);
  const T = Math.max(1, d.durationMs ?? d.samples[d.samples.length - 1].t);
  const W = 520, L = 86, R = 10, Tp = 14, B = 22, H = Tp + keys.length * 40 + B;
  const x = (t: number) => L + (t / T) * (W - L - R), lane = (i: number) => Tp + i * 40, hi = (i: number) => lane(i) + 4, lo = (i: number) => lane(i) + 26;
  const colors = ['var(--sensor)', 'var(--actuator)', '#c08a00', 'var(--ink3)'];
  const path = (k: string, i: number) => { let dd = ''; d.samples.forEach((s, j) => { const v = !!s.values[k]; dd += j ? ` H${x(s.t)} V${v ? hi(i) : lo(i)}` : `M${x(0)},${v ? hi(i) : lo(i)}`; }); return dd + ` H${x(T)}`; };
  const passed = test.verdict === 'passed';
  const failedAt = d.assertions.find((a) => a.passed === false)?.atMs;
  const note = d.assertions.find((a) => a.passed === false)?.detail ?? d.assertions[d.assertions.length - 1]?.detail ?? test.verdict ?? '';
  return (<><svg viewBox={`0 0 ${W} ${H}`} width="100%">
    {Array.from({ length: 7 }, (_, i) => <g key={i}><line x1={x((T * i) / 6)} x2={x((T * i) / 6)} y1={Tp} y2={H - B} stroke="#ebe8e2" /><text x={x((T * i) / 6)} y={H - 6} fill="#9aa1a8" fontSize="10" fontFamily="var(--mono)" textAnchor="middle">{((T * i) / 6000).toFixed(1)}s</text></g>)}
    {keys.map((k, i) => <text key={k} x={L - 8} y={lane(i) + 19} fill="#67717b" fontSize="10" fontFamily="var(--mono)" textAnchor="end">{k.slice(0, 13)}</text>)}
    {keys.map((k, i) => <path key={k} d={path(k, i)} fill="none" stroke={colors[i]} strokeWidth="2.2" />)}
    {!passed && failedAt != null ? <line x1={x(failedAt)} x2={x(failedAt)} y1={Tp} y2={H - B} stroke="#D7261E" strokeDasharray="3 3" /> : null}
  </svg>
    {d.truncated ? <p className="hint">Showing change points of {d.totalSamples} samples (truncated).</p> : null}
    <div className="note" style={{ color: passed ? 'var(--go)' : 'var(--stop)' }}>{passed ? '✓' : '✕'} {note}</div></>);
}

export default function VerificationTab({ run, p, tv: tvIn }: { run: RunView; p: ProjectData | null; tv?: TestView }) {
  const [selId, setSelId] = React.useState<string | null>(null);
  if (!p || !p.tests.length) return <div className="empty"><b>No tests yet</b>Tests run on the live simulator after the HMI is built.</div>;
  // Latest attempt only: a self-repairing run re-runs the FULL suite, so attempts are never added up.
  const tv = tvIn ?? deriveTests(p);
  const tests = tv.tests;
  const live = !run.finished;
  const ok = p.verdicts.filter((v) => isOk(v.status)).length;
  const reqTotal = p.verdicts.length || p.requirements?.items.length || 0;
  const repairs = p.plcVersions.filter((v) => v.createdBy === 'repair').length;
  const hidden = tests.filter((t) => t.visibility === 'hidden').length;
  const notPassed = tv.failed + tv.blocked;
  const ofTotal = tv.running ? (tv.suite ? `${tv.finished} / ${tv.suite} run · running` : `${tv.finished} run so far · running`) : `of ${tests.length} tests`;
  const ver = (v?: number) => (v != null ? ` · v${v}` : '');
  const sel = tests.find((t) => t.id === selId) ?? tests.find((t) => t.visibility === 'public' && (t.verdict === 'failed' || t.verdict === 'blocked')) ?? tests.find((t) => t.visibility === 'public') ?? null;
  return (<>
    <div className="metrics" style={{ marginBottom: 18 }}>
      <div className="metric"><div className="k">Passed · attempt {tv.attempt}{ver(tv.version)}</div><div className="v t-go">{tv.passed}</div><div className="s">{ofTotal}</div></div>
      <div className="metric"><div className="k">{tv.blocked ? 'Failed / blocked' : 'Failed'}</div><div className={`v ${notPassed ? 't-stop' : ''}`}>{notPassed}</div><div className="s">{[tv.blocked ? `${tv.failed} failed · ${tv.blocked} blocked` : '', repairs ? `${repairs} self-repair${repairs > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ') || '—'}</div></div>
      <div className="metric"><div className="k">Hidden tests</div><div className="v">{hidden}</div><div className="s">never shown to the model</div></div>
      <div className="metric"><div className="k">Requirements</div><div className={`v ${ok === reqTotal && ok ? 't-go' : ''}`}>{ok} / {reqTotal}</div><div className="s">verified with evidence</div></div></div>
    {tv.history.length ? <div className="card" data-testid="attempt-history" style={{ marginBottom: 18 }}><div className="ch"><h3>Attempts</h3><span className="r sub">each self-repair re-runs the full suite · shown per attempt, never added up</span></div>
      <div className="cb" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{tv.history.map((h) => <span key={h.simRunId} className={`pill ${h.failed || h.blocked ? 'stop' : 'go'}`} title={`sim run ${h.simRunId}${h.publicOnly ? ' · only its public tests are known here' : ''}`}>Attempt {h.attempt} · {h.passed}/{h.total}{h.publicOnly ? ' public' : ''}{ver(h.version)}</span>)}
        <span className="pill fl" title={`sim run ${tv.simRunId ?? ''}`}>Attempt {tv.attempt} · {tv.running ? `${tv.finished}${tv.suite ? `/${tv.suite}` : ''} running` : `${tv.passed}/${tests.length}`}{ver(tv.version)} · latest</span></div></div> : null}
    <div className="grid2">
      <div className="card"><div className="ch"><h3>Requirements</h3><span className="r sub">verified only with measured evidence</span></div>
        {p.requirements?.items.length ? <table><thead><tr><th>Id</th><th>Requirement</th><th>Tests</th><th style={{ textAlign: 'right' }}>Status</th></tr></thead><tbody>{p.requirements.items.map((r) => {
          const v = p.verdicts.find((x) => x.requirementId === r.id), s = v?.status;
          const testIds = v?.testIds.length ? v.testIds : tests.filter((t) => t.requirementIds.includes(r.id)).map((t) => t.testId ?? 'hidden');
          const testing = !s && tests.some((t) => t.requirementIds.includes(r.id) && !t.verdict) && live;
          return <tr key={r.id}><td className="m"><span className="idst">{r.id}</span>{isSafety(r.kind, r.text) ? <><br /><span className="sf" style={{ margin: '4px 0 0' }}>safety</span></> : null}</td><td>{r.text}</td><td className="m">{testIds.join(' ')}</td>
            <td style={{ textAlign: 'right' }}>{isOk(s) ? <span className="pill go"><i />verified</span> : s === 'violated' || s === 'failed' ? <span className="pill stop"><i />failed</span> : s === 'blocked' ? <span className="pill ca"><i />blocked</span> : testing ? <span className="pill fl"><i />testing</span> : <span className="pill nt">untested</span>}</td></tr>;
        })}</tbody></table> : <div className="empty" style={{ border: 0 }}>No requirements recorded</div>}</div>
      <div className="stack">
        <div className="card"><div className="ch"><h3>Tests</h3><span className="r sub">click a public test for its timeline</span></div><div className="cb"><TestsList p={p} tv={tv} click sel={sel?.id} onSel={(t) => setSelId(t.id)} live={live} /></div></div>
        <div className="card"><div className="ch"><h3>Measured timeline · {sel?.testId ?? '—'}</h3><span className="r sub">{sel?.title ?? ''}</span></div><div className="cb">{sel ? <Timeline test={sel} live={live} /> : <div className="empty" style={{ padding: 24 }}>—</div>}</div></div>
      </div></div></>);
}
