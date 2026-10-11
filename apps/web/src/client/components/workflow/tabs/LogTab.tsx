// Log tab (Ali's PANES.log): Lessons learned / Traces / Durability from the real project, RSI and dashboard read models.
// Interrupt / Resume are real worker commands, so both sit behind a confirm.
import * as React from 'react';
import { useJobMutation } from '@/client/lib/api';
import { WORKER_STALE_MS, type DashboardData, type JobCreated, type ProjectData, type RsiData } from '@/shared/mongomation';
import { STEPS, fmtDur, type RunView } from '@/client/plcflow/model';
import { t8 } from './ProgramTab';

export type LogSub = 'lessons' | 'traces' | 'durability';

export default function LogTab({ run, p, dash, rsi, signedIn, sub: subProp, onSub }: {
  run: RunView; p: ProjectData | null; dash: DashboardData | null; rsi: RsiData | null; signedIn: boolean; sub?: LogSub; onSub?: (s: LogSub) => void;
}) {
  const [subState, setSubState] = React.useState<LogSub>('lessons');
  const sub = subProp ?? subState;
  const setSub = (s: LogSub) => { setSubState(s); onSub?.(s); };
  const interruptM = useJobMutation<Record<string, never>, JobCreated>('interruptWorker');
  const resumeM = useJobMutation<Record<string, never>, JobCreated>('resumeWorker');
  const subs: [LogSub, string][] = [['lessons', 'Lessons learned'], ['traces', 'Traces'], ['durability', 'Durability']];
  const stages = p?.stages ?? [];
  let body: React.ReactNode = null;

  if (sub === 'lessons') {
    const lessons = p?.diagnosis?.lessons ?? [];
    const rules = rsi?.active?.rules ?? [];
    body = (<div className="card"><div className="ch"><h3>Lessons learned</h3><span className="r sub">stored in Atlas · retrieved into the next run</span></div><div className="cb">
      {lessons.map((l, i) => <div key={`l${i}`} className="lesson new"><span className="n">new</span><span>{l.pattern}{l.fix ? ` — ${l.fix}` : ''}</span><span className="src">this run<br /><span className="pill me">from diagnosis</span></span></div>)}
      {rules.map((r, i) => <div key={`r${i}`} className="lesson"><span className="n">#{String(rules.length - i).padStart(2, '0')}</span><span>{r}</span><span className="src">harness v{rsi?.active?.version}</span></div>)}
      {!lessons.length && !rules.length ? <div className="empty" style={{ padding: 24 }}>No lessons recorded yet</div> : null}</div></div>);
  }

  if (sub === 'traces') {
    const spans = stages.filter((s) => s.durationMs), total = spans.reduce((a, s) => a + (s.durationMs ?? 0), 0) || 1; let off = 0;
    body = (<div className="card"><div className="ch"><h3>Stage trace</h3><span className="r sub">{spans.length} spans · from stage checkpoints in Atlas</span></div><div className="cb">
      {spans.length ? <><div className="wf">{spans.map((s, i) => { const l = (off / total) * 100, w = Math.max(1, ((s.durationMs ?? 0) / total) * 100); off += s.durationMs ?? 0;
        const err = s.status === 'failed';
        const c = err ? 'var(--stop)' : /requirements|plc_code|state_machine|io_design|diagnosis|repair/.test(s.stage) ? 'var(--me)' : /tests|simulate/.test(s.stage) ? 'var(--sensor)' : 'var(--fl)';
        return <div key={i} className={`wfr ${err ? 'err' : ''}`}><span className="nm" title={s.error ?? s.stage}>{s.stage.replace(/_/g, ' ')} <span>#{s.attempt}</span></span><span className="bar"><i style={{ left: `${l}%`, width: `${w}%`, background: c }} /></span><span className="ms">{(s.durationMs ?? 0) >= 1000 ? fmtDur(s.durationMs) : `${s.durationMs}ms`}</span></div>; })}</div>
        <div className="mono" style={{ fontSize: 11, display: 'flex', gap: 16, marginTop: 14, flexWrap: 'wrap' }}><span className="t-me">■ model call</span><span className="t-fl">■ tool</span><span style={{ color: 'var(--sensor)' }}>■ test</span><span className="t-stop">■ error</span></div></>
        : <div className="empty" style={{ padding: 24 }}>No spans yet</div>}</div></div>);
  }

  if (sub === 'durability') {
    const workers = dash?.workers ?? [];
    const w = workers.find((x) => x.currentJobId) ?? workers[0];
    const alive = workers.some((x) => (x.heartbeatAgeMs ?? Infinity) < WORKER_STALE_MS);
    const job = dash?.activeJob ?? null;
    const resumed = !!job?.resumedFrom;
    const inProgress = !!job && !run.finished;
    body = (<div className="grid2">
      <div className="card"><div className="ch"><h3>Worker</h3><span className="r">{alive ? <span className="pill go"><i />alive</span> : <span className="pill stop"><i />down</span>}</span></div><div className="cb">
        <div className="kv"><span>Worker</span><span className="mono">{w ? `${w.id}${w.host ? ' · ' + w.host : ''}` : '—'}</span></div>
        <div className="kv"><span>Heartbeat</span><span className="mono">{w?.heartbeatAgeMs != null ? (alive ? `${Math.round(w.heartbeatAgeMs / 1000)} s ago` : 'stale') : '—'}</span></div>
        <div className="kv"><span>Job</span><span className="mono">{job ? `${job.id} · attempt ${job.attempts ?? 1}${resumed ? ' (resumed)' : ''}` : 'none running'}</span></div>
        <p className="lbl" style={{ marginTop: 16 }}>Stage checkpoints in Atlas</p>
        <div className="ck">{STEPS.map((l, i) => { const st = run.status[i];
          return <span key={l} className={`pill ${st === 'done' ? (resumed ? 'me' : 'go') : st === 'pending' ? 'nt' : st === 'warn' ? 'ca' : 'fl'}`}>{st === 'done' && resumed ? '↺ ' : ''}{l}</span>; })}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 18 }}>
          <button className="btn red sm" disabled={!signedIn || !alive || !inProgress || interruptM.isPending}
            onClick={() => { if (window.confirm('Interrupt the REAL worker? It exits mid-stage with no cleanup.')) interruptM.mutate({}); }}>Interrupt worker</button>
          <button className="btn sm" disabled={!signedIn || resumeM.isPending}
            onClick={() => { if (window.confirm('Resume the REAL worker from its Atlas checkpoints?')) resumeM.mutate({}); }}>Resume from MongoDB</button></div>
        <p className="hint">{!signedIn ? 'Sign in to send worker commands. ' : ''}{run.finished ? 'Interrupt is available while a run is in progress.' : 'Interrupt kills the worker mid-stage. Resume reuses finished stages from Atlas; only the interrupted stage re-runs.'}</p></div></div>
      <div className="card"><div className="ch"><h3>Events</h3></div><div className="cb" style={{ maxHeight: 420, overflow: 'auto' }}>
        {p?.events.length ? p.events.map((e) => <div key={e.id} className={`ev ${e.level === 'error' ? 'err' : e.level === 'warn' || e.level === 'meta' ? 'meta' : ''}`}><span>{t8(e.ts)}</span><span>{e.stage ? `${e.stage} · ` : ''}{e.message}</span></div>) : <div className="empty" style={{ padding: 24 }}>No events</div>}</div></div></div>);
  }

  return (<><div style={{ marginBottom: 16 }}><div className="seg">{subs.map(([k, l]) => <button key={k} className={sub === k ? 'on' : ''} onClick={() => setSub(k)}>{l}</button>)}</div></div>{body}</>);
}
