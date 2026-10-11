// Live system activity: the multi-agent loop (Spec → Claude agents → OpenPLC + Factory I/O → MongoDB Atlas → Raindrop →
// Harness RSI gate → Claude) drawn from the REAL project read model. Every ticker line is an Atlas `events` doc or a
// Raindrop signal the worker emits for an outcome Atlas holds (signal names copied from apps/worker: validate.ts,
// engineer.ts, rsi/evolve.ts). Nothing is invented: a node without data says so.
import * as React from 'react';
import type { DashboardData, EventLite, ProjectData, RsiData, StageLite } from '@/shared/mongomation';

type Comp = 'spec' | 'claude' | 'rig' | 'atlas' | 'raindrop' | 'harness';

const STAGE_COMP: Record<string, Comp> = {
  requirements: 'claude', io_design: 'claude', state_machine: 'claude', plc_code: 'claude', diagnosis: 'claude', repair: 'claude',
  preflight: 'rig', compile: 'rig', deploy: 'rig', simulate: 'rig', tests: 'rig',
  verification: 'atlas', deliver: 'atlas',
};
/** Who did it, as shown on the ticker chip. */
const STAGE_WHO: Record<string, string> = {
  requirements: 'Claude · requirements', io_design: 'Claude · I/O design', state_machine: 'Claude · state machine',
  plc_code: 'Claude · codegen', diagnosis: 'Claude · critic', repair: 'Claude · repair',
  preflight: 'OpenPLC · preflight', compile: 'OpenPLC', deploy: 'OpenPLC', simulate: 'Factory I/O', tests: 'Factory I/O',
  verification: 'Atlas', deliver: 'Atlas',
};

// Geometry in viewBox units (900 × 252): four columns of 196-wide boxes with 36-unit gaps, two rows.
const NW = 196, NH = 76, COL = [100, 332, 564, 796], ROW = [44, 206];
const NODES: { id: Comp; x: number; y: number; title: string }[] = [
  { id: 'spec', x: COL[0], y: ROW[0], title: 'SPEC' },
  { id: 'claude', x: COL[1], y: ROW[0], title: 'CLAUDE AGENTS' },
  { id: 'rig', x: COL[2], y: ROW[0], title: 'OPENPLC + FACTORY I/O' },
  { id: 'atlas', x: COL[3], y: ROW[0], title: 'MONGODB ATLAS' },
  { id: 'raindrop', x: COL[3], y: ROW[1], title: 'RAINDROP' },
  { id: 'harness', x: COL[1], y: ROW[1], title: 'HARNESS · RSI GATE' },
];
const at = (id: Comp) => NODES.find((n) => n.id === id)!;
function edgePath(from: Comp, to: Comp) {
  const a = at(from), b = at(to);
  if (a.y === b.y) { const dir = Math.sign(b.x - a.x); return `M${a.x + (dir * NW) / 2} ${a.y} L${b.x - (dir * NW) / 2} ${b.y}`; }
  const dir = Math.sign(b.y - a.y);
  return `M${a.x} ${a.y + (dir * NH) / 2} L${b.x} ${b.y - (dir * NH) / 2}`;
}
const EDGES: { from: Comp; to: Comp; d: string }[] = (
  [['spec', 'claude'], ['claude', 'rig'], ['rig', 'atlas'], ['atlas', 'raindrop'], ['raindrop', 'harness'], ['harness', 'claude']] as [Comp, Comp][]
).map(([from, to]) => ({ from, to, d: edgePath(from, to) }));

const toMs = (d?: Date | string) => (d == null ? NaN : new Date(d as Date).getTime());
const hms = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '--:--:--');
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const ageTxt = (ms?: number) => (ms == null || !Number.isFinite(ms) ? '—' : ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`);

type Tone = 'live' | 'warn' | 'fail' | 'ok' | 'mute';
interface Item { key: string; ts: number; who: string; comp: Comp | null; text: string; tone: Tone; raindrop?: boolean }

function eventComp(e: EventLite): Comp | null {
  if (/^(program memory|experience recall)/.test(e.message)) return 'atlas';
  return e.stage ? STAGE_COMP[e.stage] ?? null : null;
}
function eventWho(e: EventLite): string {
  if (/^(program memory|experience recall)/.test(e.message)) return 'Atlas · memory';
  return e.stage ? STAGE_WHO[e.stage] ?? e.stage.replace(/_/g, ' ') : 'Worker';
}

function eventItem(e: EventLite, running: Set<string>): Item {
  const ts = toMs(e.ts);
  const m = /^([a-z_]+)#(\d+): (started|done|reused checkpoint from Atlas|BLOCKED|failed)(?::\s*(.*))?$/s.exec(e.message);
  let text = e.message, tone: Tone = e.level === 'error' ? 'fail' : e.level === 'warn' ? 'warn' : 'mute';
  if (m) {
    const [, st, att, what, rest] = m;
    const name = st.replace(/_/g, ' ');
    if (what === 'started') { text = `${name} started · attempt ${att}`; tone = running.has(`${st}#${att}`) ? 'live' : 'mute'; }
    else if (what === 'done') { text = `${name} done · attempt ${att}`; tone = 'ok'; }
    else if (what.startsWith('reused')) { text = `${name} · attempt ${att} reused its checkpoint from Atlas`; tone = 'ok'; }
    else { text = `${name} ${what === 'BLOCKED' ? 'blocked' : 'failed'} · attempt ${att}${rest ? ` — ${rest}` : ''}`; tone = 'fail'; }
  } else {
    const r = /round: (\d+)\/(\d+) passed, (\d+) failed, (\d+) blocked/.exec(e.message);
    if (r) { text = `tests ${r[1]}/${r[2]} passed · ${r[3]} failed · ${r[4]} blocked`; tone = +r[3] || +r[4] ? 'warn' : 'ok'; }
  }
  return { key: `e:${e.id}`, ts, who: eventWho(e), comp: eventComp(e), text: short(text, 200), tone };
}

/** Raindrop signals the worker sends for outcomes Atlas holds. Names are the worker's; times are the outcome's. */
function raindropItems(p: ProjectData, rsi: RsiData | null): Item[] {
  const out: Item[] = [];
  const add = (key: string, ts: number, name: string, detail: string, tone: Tone) =>
    Number.isFinite(ts) && out.push({ key: `r:${key}`, ts, who: 'Raindrop', comp: 'raindrop', text: `${name}${detail ? ` · ${detail}` : ''}`, tone, raindrop: true });
  // One Raindrop trace (interaction) per engineering job: opened when the job's first event was written.
  const firstByJob = new Map<string, number>();
  for (const e of p.events) if (e.jobId) { const t = toMs(e.ts); const f = firstByJob.get(e.jobId); if (f == null || t < f) firstByJob.set(e.jobId, t); }
  firstByJob.forEach((t, job) => add(`trace:${job}`, t, 'trace opened', `job ${job.slice(-6)}`, 'mute'));
  for (const s of p.stages) {
    if (s.status !== 'done') continue;
    if (s.stage === 'diagnosis') add(`critic:${s.attempt}`, toMs(s.finishedAt), 'critic_verdict', `attempt ${s.attempt}`, 'warn');
    if (s.stage === 'repair') add(`repair:${s.attempt}`, toMs(s.finishedAt), 'repair_edit', `attempt ${s.attempt}`, 'warn');
  }
  for (const c of p.compiles) if (c.ok === false && c.stage !== 'preflight') add(`cf:${c.id}`, toMs(c.createdAt), 'plc_compile_failed', '', 'fail');
  const failed = p.tests.filter((t) => t.verdict === 'failed').length;
  if (failed) {
    const testsDone = [...p.stages].reverse().find((s) => s.stage === 'tests' && s.finishedAt);
    add(`tf:${p.simRun?.id ?? ''}`, toMs(p.simRun?.finishedAt ?? testsDone?.finishedAt), 'simulator_test_failed', `× ${failed} (one per failed test, newest run)`, 'fail');
  }
  const st = p.project?.status;
  const ver = p.stages.find((s) => s.stage === 'verification' && s.status === 'done');
  if (ver && (st === 'verified' || st === 'not_verified' || st === 'partially_verified'))
    add('verdict', toMs(ver.finishedAt), st === 'verified' ? 'project_verified' : 'project_not_verified', '', st === 'verified' ? 'ok' : 'fail');
  const a = rsi?.active;
  if (a?.verdict === 'kept' && a.parent != null) add(`gate:${a.version}`, toMs(a.decidedAt), 'harness_change_kept', `v${a.version} · RSI gate`, 'ok');
  const prop = rsi?.latestProposal;
  if (prop?.guardrailViolations.length) add(`prop:${prop.id}`, toMs(prop.createdAt), 'harness_proposal_rejected', 'guardrail', 'warn');
  return out;
}

function incomingEdge(to: Comp | null, from: Comp | null, stage?: string) {
  if (!to) return null;
  const direct = from && from !== to ? EDGES.find((e) => e.from === from && e.to === to) : undefined;
  if (direct) return direct;
  if (to === 'claude') return EDGES.find((e) => e.from === (stage === 'requirements' ? 'spec' : 'harness') && e.to === 'claude') ?? null;
  return EDGES.find((e) => e.to === to) ?? null;
}

const CSS = `
.ll{--ll-paper:#F6F5F1;--ll-graphite:#15171A;--ll-ink:#2A2E33;--ll-ink3:#6B7178;--ll-ink4:#9AA0A6;--ll-line:#DEDAD1;--ll-sig:#FF5A1F;--ll-amber:#E8A317;--ll-red:#D7261E;
  background:var(--ll-paper);border:1px solid var(--ll-line);border-radius:6px;padding:18px 20px 16px;color:var(--ll-ink);font-family:"Instrument Sans",ui-sans-serif,system-ui,sans-serif;min-width:0}
.ll-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.ll-title{margin:0;font:800 13px/1.2 "Archivo",ui-sans-serif,system-ui,sans-serif;font-stretch:125%;letter-spacing:.12em;text-transform:uppercase;color:var(--ll-graphite)}
.ll-sub{font:500 10.5px/1.4 "Martian Mono",ui-monospace,monospace;letter-spacing:.04em;color:var(--ll-ink3)}
.ll-state{margin-left:auto;display:inline-flex;align-items:center;gap:7px;font:600 10.5px/1 "Martian Mono",ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--ll-ink3)}
.ll-state i{width:8px;height:8px;border-radius:50%;background:var(--ll-ink4)}
.ll-state.on{color:var(--ll-sig)} .ll-state.on i{background:var(--ll-sig);animation:ll-blink 1.2s ease-in-out infinite}
.ll-body{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(0,1fr);gap:18px;align-items:start}
@media (max-width:980px){.ll-body{grid-template-columns:minmax(0,1fr)}}
.ll-svg{width:100%;height:auto;display:block;overflow:visible}
.ll-node rect.box{fill:#fff;stroke:#C9C5BB;stroke-width:1}
.ll-node .t{font:800 11.5px "Archivo",ui-sans-serif,sans-serif;font-stretch:105%;letter-spacing:.07em;fill:var(--ll-graphite)}
.ll-node .s{font:500 11px "Martian Mono",ui-monospace,monospace;fill:var(--ll-ink3)}
.ll-node.run rect.box{stroke:var(--ll-sig);stroke-width:2}
.ll-node.run .t{fill:var(--ll-sig)}
.ll-halo{fill:none;stroke:var(--ll-sig);stroke-width:2;opacity:0;transform-box:fill-box;transform-origin:center}
.ll-node.run .ll-halo{animation:ll-pulse 1.6s ease-out infinite}
.ll-node.flash rect.box{animation:ll-flash .9s ease-out}
.ll-edge{fill:none;stroke:#B9B5AA;stroke-width:1.4}
.ll-edge.hot{stroke:var(--ll-sig)}
.ll-dot{fill:var(--ll-sig)}
.ll-elab{font:500 10.5px "Martian Mono",ui-monospace,monospace;fill:var(--ll-ink4);letter-spacing:.04em}
.ll-tick{min-width:0}
.ll-tick-h{display:flex;justify-content:space-between;gap:10px;font:500 10px/1.3 "Martian Mono",ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--ll-ink3);padding:0 2px 8px;border-bottom:1px solid var(--ll-line)}
.ll-list{list-style:none;margin:0;padding:0;max-height:300px;overflow-y:auto;overflow-x:hidden}
.ll-row{display:grid;grid-template-columns:58px minmax(0,1fr);gap:10px;padding:8px 2px;border-bottom:1px solid #ECE9E2;font-size:12.5px;line-height:1.45}
.ll-row.ll-new{animation:ll-in .45s cubic-bezier(.2,.7,.2,1)}
.ll-time{font:500 10px/1.9 "Martian Mono",ui-monospace,monospace;color:var(--ll-ink4)}
.ll-txt{min-width:0;overflow-wrap:anywhere;color:var(--ll-ink)}
.ll-chip{display:inline-block;margin:0 7px 2px 0;padding:2px 6px;border-radius:3px;font:600 9.5px/1.3 "Martian Mono",ui-monospace,monospace;letter-spacing:.04em;background:#ECE9E2;color:var(--ll-graphite);vertical-align:1px}
.ll-chip.rd{background:var(--ll-graphite);color:#F6F5F1}
.ll-sent{display:inline-block;margin-left:6px;font:500 9.5px "Martian Mono",ui-monospace,monospace;color:var(--ll-ink3)}
.ll-row.live .ll-txt{color:var(--ll-sig);font-weight:600}
.ll-row.warn .ll-txt{color:#9A6A00}
.ll-row.fail .ll-txt{color:var(--ll-red)}
.ll-row.mute .ll-txt{color:var(--ll-ink3)}
.ll-mono{font-family:"Martian Mono",ui-monospace,monospace;font-size:11.5px}
.ll-empty{padding:18px 4px;color:var(--ll-ink3);font-size:12.5px}
.ll-foot{display:flex;flex-wrap:wrap;gap:8px 22px;margin-top:14px;padding-top:12px;border-top:1px solid var(--ll-line);font:500 10.5px/1.5 "Martian Mono",ui-monospace,monospace;color:var(--ll-ink3)}
.ll-foot b{font-weight:600;color:var(--ll-graphite)}
@keyframes ll-pulse{0%{opacity:.75;transform:scale(1)}100%{opacity:0;transform:scale(1.12,1.3)}}
@keyframes ll-flash{0%{fill:#FFF0E8}100%{fill:#fff}}
@keyframes ll-in{from{opacity:0;transform:translateX(-14px)}to{opacity:1;transform:none}}
@keyframes ll-blink{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){
  .ll-node.run .ll-halo,.ll-row.ll-new,.ll-state.on i,.ll-node.flash rect.box{animation:none}
  .ll-node.run .ll-halo{opacity:.5}
  .ll-dot{display:none}
}`;

export default function LiveLoop({ p, dash, rsi }: { p: ProjectData | null; dash: DashboardData | null; rsi: RsiData | null }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  // Rig poll age: the server's age at query time plus the time since this snapshot arrived.
  const rig = dash?.rig ?? null;
  const rigAt = React.useMemo(() => Date.now(), [rig]);

  const pid = p?.project?.id;
  const job = dash?.activeJob ?? null;
  const live = !!job && !!pid && (job.projectId === pid || dash?.checkpointProjectId === pid);
  const stages = p?.stages ?? [];
  const runningStages = live ? stages.filter((s) => s.status === 'running') : [];
  const running = new Set(runningStages.map((s) => `${s.stage}#${s.attempt}`));
  const runComp: Comp | null = runningStages.length ? STAGE_COMP[runningStages[runningStages.length - 1].stage] ?? null : null;

  const items = React.useMemo(() => {
    if (!p) return [] as Item[];
    const ev = p.events.map((e) => eventItem(e, running));
    return [...ev, ...raindropItems(p, rsi)].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p, rsi, [...running].join()]);

  // New arrivals: slide in + a dot along the edge into the node that acted + an Atlas write flash.
  const seen = React.useRef<Set<string> | null>(null);
  const fresh = React.useMemo(() => {
    const prev = seen.current;
    const f = new Set<string>();
    if (prev) for (const it of items) if (!prev.has(it.key)) f.add(it.key);
    seen.current = new Set([...(prev ?? []), ...items.map((i) => i.key)]);
    return f;
  }, [items]);
  const newest = p?.events[0];
  const [pulse, setPulse] = React.useState<{ id: string; edge: (typeof EDGES)[number] | null } | null>(null);
  const lastEv = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    if (!newest) return;
    if (lastEv.current !== undefined && lastEv.current !== newest.id) {
      const prevE = p?.events[1];
      setPulse({ id: newest.id, edge: incomingEdge(eventComp(newest), prevE ? eventComp(prevE) : null, newest.stage) });
    }
    lastEv.current = newest.id;
  }, [newest?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!p) return null;

  // Node detail lines — real values only.
  const lastOf = (comp: Comp) => [...stages].reverse().find((s) => STAGE_COMP[s.stage] === comp);
  const stLine = (s?: StageLite) => (s ? `${s.stage.replace(/_/g, ' ')} #${s.attempt} · ${s.status ?? '—'}` : 'no stage yet');
  const reqN = p.requirements?.items.length;
  const tc = p.testCounts;
  const lessons = p.diagnosis?.lessons.length ?? 0;
  const signals = items.filter((i) => i.raindrop && !i.key.startsWith('r:trace'));
  const hasTrace = p.tests.some((t) => !!t.traceId) || !!p.diagnosis?.traceId;
  const lines: Record<Comp, [string, string]> = {
    spec: [reqN != null ? `${reqN} requirements` : 'no requirements yet', p.project?.sceneId ?? '—'],
    claude: [stLine(lastOf('claude')), `${p.plcVersions.length} program version${p.plcVersions.length === 1 ? '' : 's'}`],
    rig: [stLine(lastOf('rig')), tc.total ? `tests ${tc.passed}/${tc.total} passed` : rig?.openplc?.running ? 'OpenPLC running' : 'no test results'],
    atlas: [`${p.events.length} events · ${stages.length} ckpts`, `${tc.total} tests · ${lessons} lesson${lessons === 1 ? '' : 's'}`],
    raindrop: [hasTrace ? 'trace ids in Atlas' : '1 trace per job', signals[0] ? signals[0].text.split(' · ')[0] : 'no signal yet'],
    harness: [rsi?.active ? `active v${rsi.active.version} · ${rsi.active.verdict ?? 'seed'}` : 'no harness yet', p.project?.harnessVersion != null ? `this run used v${p.project.harnessVersion}` : 'run harness —'],
  };
  const worker = dash?.workers.find((w) => job && w.currentJobId === job.id) ?? dash?.workers[0];
  const rigAge = rig?.ageMs != null ? rig.ageMs + (now - rigAt) : undefined;
  const hotEdge = pulse?.edge ?? null;

  return (<section className="ll" aria-label="Live system activity">
    <style>{CSS}</style>
    <div className="ll-head">
      <h3 className="ll-title">System activity</h3>
      <span className="ll-sub">agents · rig · Atlas · Raindrop · RSI — from Atlas, live</span>
      <span className={`ll-state ${live ? 'on' : ''}`}><i />{live ? `running · ${runningStages.length ? runningStages[runningStages.length - 1].stage.replace(/_/g, ' ') : job?.status ?? ''}` : 'idle'}</span>
    </div>
    <div className="ll-body">
      <svg className="ll-svg" viewBox="0 0 900 252" role="img" aria-label="Agent loop: spec, Claude agents, OpenPLC and Factory I/O rig, MongoDB Atlas, Raindrop, harness RSI gate">
        <defs><marker id="ll-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" fill="#B9B5AA" /></marker></defs>
        {EDGES.map((e) => <path key={`${e.from}-${e.to}`} className={`ll-edge ${hotEdge === e ? 'hot' : ''}`} d={e.d} markerEnd="url(#ll-arrow)" />)}
        <text className="ll-elab" x={COL[2]} y={ROW[1] - 9} textAnchor="middle">signals feed the RSI gate</text>
        <text className="ll-elab" x={COL[1] + 12} y={(ROW[0] + ROW[1]) / 2 + 4}>next run</text>
        <text className="ll-elab" x={COL[3] + 12} y={(ROW[0] + ROW[1]) / 2 + 4}>traces</text>
        {NODES.map((n) => {
          const run = live && runComp === n.id;
          const flash = n.id === 'atlas' && pulse;
          return (<g key={n.id + (flash ? pulse!.id : '')} className={`ll-node ${run ? 'run' : ''} ${flash ? 'flash' : ''}`}>
            <rect className="ll-halo" x={n.x - NW / 2} y={n.y - NH / 2} width={NW} height={NH} rx="6" />
            <rect className="box" x={n.x - NW / 2} y={n.y - NH / 2} width={NW} height={NH} rx="6" />
            <text className="t" x={n.x - NW / 2 + 12} y={n.y - 13}>{n.title}</text>
            <text className="s" x={n.x - NW / 2 + 12} y={n.y + 8}>{short(lines[n.id][0], 23)}</text>
            <text className="s" x={n.x - NW / 2 + 12} y={n.y + 25}>{short(lines[n.id][1], 23)}</text>
            <title>{`${n.title}\n${lines[n.id][0]}\n${lines[n.id][1]}`}</title>
          </g>);
        })}
        {hotEdge ? <circle key={pulse!.id} className="ll-dot" r="4.5">
          <animateMotion dur="0.9s" fill="freeze" path={hotEdge.d} />
          <animate attributeName="opacity" values="1;1;0" keyTimes="0;0.8;1" dur="1.1s" fill="freeze" />
        </circle> : null}
      </svg>
      <div className="ll-tick">
        <div className="ll-tick-h"><span>Live events</span><span>newest first</span></div>
        {items.length ? <ul className="ll-list">{items.map((it) => (
          <li key={it.key} className={`ll-row ${it.tone} ${fresh.has(it.key) ? 'll-new' : ''}`}>
            <span className="ll-time">{hms(it.ts)}</span>
            <span className="ll-txt"><span className={`ll-chip ${it.raindrop ? 'rd' : ''}`}>{it.who}</span>
              {it.raindrop ? <span className="ll-mono">{it.text}</span> : it.text}
              {it.raindrop ? <span className="ll-sent">{hasTrace ? 'sent to Raindrop' : 'Raindrop signal'}</span> : null}</span>
          </li>))}</ul>
          : <div className="ll-empty">No events in Atlas for this project yet.</div>}
      </div>
    </div>
    <div className="ll-foot">
      <span>harness <b>{p.project?.harnessVersion != null ? `v${p.project.harnessVersion}` : '—'}</b> this run · active <b>{rsi?.active ? `v${rsi.active.version}` : '—'}</b></span>
      <span>worker <b>{worker?.id ?? 'none'}</b>{worker?.heartbeatAgeMs != null ? ` · heartbeat ${ageTxt(worker.heartbeatAgeMs)} ago` : ''}</span>
      <span>rig poll <b>{rigAge != null ? `${ageTxt(rigAge)} ago` : 'never'}</b></span>
      {job ? <span>job <b>{job.id.slice(-6)}</b> · {job.type} · {job.status}</span> : null}
    </div>
  </section>);
}
