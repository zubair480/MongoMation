// Landing: the 3D control room. Click a cabinet → the door opens → Open PLC → the camera lands on the PLC
// → dissolve to white → the PLC workflow page for that cabinet (/plc/:cab).
import * as React from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Seo } from '@/client/components/Seo';
import { useDashboard } from '@/client/lib/api';
import { WORKER_STALE_MS, RIG_FRESH_MS } from '@/shared/mongomation';
import { createRoom, type CabinetDef, type RoomApi } from '@/client/plc3d/plcroom.js';
import './room.css';

type Tip = { x: number; y: number; head: string; text: string; sub: string };

export default function RoomPage() {
  const host = React.useRef<HTMLDivElement>(null);
  const room = React.useRef<RoomApi | null>(null);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [sel, setSel] = React.useState<CabinetDef | null>(null);
  const [opened, setOpened] = React.useState<CabinetDef | null>(null);
  const [stage, setStage] = React.useState<string | null>(null);
  const [stageText, setStageText] = React.useState('');
  const [tip, setTip] = React.useState<Tip | null>(null);
  const [leaving, setLeaving] = React.useState(false);

  // Lamps: read-only from the existing dashboard query.
  const dashQ = useDashboard();
  const dash = dashQ.data && dashQ.data.connected ? dashQ.data : null;
  const workerAlive = !!dash?.workers.some((w) => (w.heartbeatAgeMs ?? Infinity) < WORKER_STALE_MS);
  const rigFresh = (dash?.rig?.ageMs ?? Infinity) < RIG_FRESH_MS;

  React.useEffect(() => {
    if (!host.current) return;
    const timers = new Set<number>();
    const later = (fn: () => void, ms: number) => { const id = window.setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
    let stageT = 0;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const r = createRoom(host.current, {
      onStage: (s) => {
        window.clearTimeout(stageT);
        if (!s) { setStage(null); return; }
        setStage(s); setStageText(s);
        stageT = window.setTimeout(() => setStage(null), 3200);
      },
      onSelect: (def) => { setSel(def); if (!def) setOpened(null); },
      // Fires once the camera has landed on the PLC macro shot: dissolve to white, then open the workflow.
      onOpenPLC: (def) => {
        setOpened(def);
        const url = `/plc/${encodeURIComponent(def.id)}${def.ex ? `?ex=${encodeURIComponent(def.ex)}` : ''}`;
        later(() => { setLeaving(true); later(() => navigate(url), reduce ? 0 : 650); }, reduce ? 0 : 250);
      },
      onClosePLC: () => { setLeaving(false); setOpened(null); },
      onHover: (h) => setTip(!h ? null : h.selected && h.part === 'plc'
        ? { x: h.x, y: h.y, head: 'PLC MM-1214', text: ' · click to open', sub: h.def.plc }
        : { x: h.x, y: h.y, head: h.def.id, text: ` ${h.def.machine}`, sub: `${h.def.state} · ${h.def.plc}` }),
    });
    room.current = r;

    // Back from /plc/:cab (← Control room → /?cab=CAB-01): land on that cabinet again.
    const cab = params.get('cab');
    if (cab) later(() => r.selectCabinet(cab), 400);

    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setLeaving(false); r.backOut(); } };
    window.addEventListener('keydown', onKey);
    return () => {
      timers.forEach((id) => window.clearTimeout(id));
      window.clearTimeout(stageT);
      window.removeEventListener('keydown', onKey);
      r.dispose?.();
      room.current = null;
    };
    // Mount once: the room owns its own state; ?cab is only read on entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mmroom">
      <Seo title="Control room" description="MongoMation control room: pick a PLC cabinet" />
      <div id="host" ref={host} />
      <div className="scrim top" />
      <div className={`scrim hero${sel ? ' away' : ''}`} />
      <header>
        <div className="brand">
          <svg viewBox="0 0 24 24" fill="none" stroke="#0B0B0C" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M7 16V8l5 5 5-5v8" /></svg>MongoMation
        </div>
        <div className="crumbs">
          {!sel && <b>Control room</b>}
          {sel && !opened && (<><span>Control room</span><span className="sep">/</span><b>{sel.id}</b></>)}
          {sel && opened && (<><span>Control room</span><span className="sep">/</span><span>{opened.id}</span><span className="sep">/</span><b>PLC MM-1214</b></>)}
        </div>
        <div className="lamps">
          <span><i className={dash ? '' : 'off'} />ATLAS {dash ? dash.db : 'offline'}</span>
          <span><i className={workerAlive ? 'live' : ''} />WORKER {workerAlive ? 'online' : 'offline'}</span>
          <span><i className={rigFresh ? 'live' : ''} />RIG {rigFresh ? 'live' : 'stale'}</span>
          <Link to="/dashboard" className="dashlink">Dashboard →</Link>
        </div>
      </header>
      <div id="stage" className={`${stage ? 'on' : ''}${sel ? ' low' : ''}`}>{stageText}</div>
      <section id="intro" className={sel ? 'away' : ''}>
        <div className="k">CONTROL ROOM · 10 CABINETS · 2 LIVE</div>
        <h1>Pick a cabinet.</h1>
        <p>Every cabinet holds a PLC. Open one to describe its machine, generate code, run it on the rig and watch it improve.</p>
        <button className="btn" onClick={() => room.current?.selectCabinet('CAB-01')}>Open CAB-01 · Sorting station <span>→</span></button>
      </section>
      <aside id="card" className={sel && !opened ? 'on' : ''}>
        <div className="k">{sel ? `${sel.id} · PLC CABINET` : ''}</div>
        <h2>{sel?.machine}</h2>
        <dl>
          <dt>State</dt><dd><span className={`dot ${sel?.state ?? ''}`} style={{ display: 'inline-block', marginRight: 6 }} />{sel?.state}</dd>
          <dt>PLC</dt><dd>{sel?.plc}</dd>
          <dt>Scene</dt><dd>{sel?.scene}</dd>
        </dl>
        <div className="row">
          <button className="btn" disabled={!!sel?.blank} style={{ opacity: sel?.blank ? 0.35 : 1 }} onClick={() => room.current?.openPLC()}>Open PLC →</button>
          <button className="btn ghost" onClick={() => room.current?.backOut()}>Back</button>
        </div>
      </aside>
      {tip && (<div id="tip" style={{ display: 'block', left: tip.x + 14, top: tip.y + 12 }}><b>{tip.head}</b>{tip.text}<small>{tip.sub}</small></div>)}
      <div id="handoff" className={leaving ? 'on' : ''} aria-live="polite">
        <div className="in"><span><b>{opened ? `${opened.id} · PLC MM-1214` : ''}</b> · opening workflow</span><span className="bar"><i /></span></div>
      </div>
      <div className="hint"><kbd>drag</kbd> orbit · <kbd>click</kbd> cabinet · <kbd>Esc</kbd> back</div>
    </div>
  );
}
