// Live plant tab: our software-in-the-loop plant simulator (apps/plant-sim, ws://localhost:5195) rendered in 3D.
// Physics runs on the plant-sim server against the REAL OpenPLC over Modbus; this tab only renders the server's frames
// (factory3d.applyPlant) and sends operator commands. Writes to the PLC happen only while the user arms the link.
import * as React from 'react';
import { createFactory, type FactoryApi, type PlantFrame } from '@/client/plc3d/factory3d.js';

// plant-sim endpoints: ?plantws=ws://host:port overrides; otherwise try :5195 then fall back to :5197, alternating on retry.
const PLANT_URLS: string[] = (() => {
  const q = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('plantws') : null;
  return q && /^wss?:\/\//.test(q) ? [q] : ['ws://localhost:5195', 'ws://localhost:5197'];
})();
const UI_HZ = 8; // React re-render rate for the badge/tag strip; the 3D gets every frame

// Factory I/O "Sorting by Height (Basic)": real tag names and OpenPLC addresses (see PLANT_SIM_CONTRACT.md).
type TagDef = { n: string; a: string; note?: 'NC' | 'active-low' };
const INPUTS: TagDef[] = [
  { n: 'High sensor', a: '%QX12.4' }, { n: 'Low sensor', a: '%QX12.5' }, { n: 'Pallet sensor', a: '%QX12.6' }, { n: 'Loaded', a: '%QX12.7' },
  { n: 'At left entry', a: '%QX13.0', note: 'active-low' }, { n: 'At left exit', a: '%QX13.1', note: 'active-low' },
  { n: 'At right entry', a: '%QX13.2', note: 'active-low' }, { n: 'At right exit', a: '%QX13.3', note: 'active-low' },
  { n: 'Start', a: '%QX13.4' }, { n: 'Reset', a: '%QX13.5' }, { n: 'Stop', a: '%QX13.6', note: 'NC' }, { n: 'Emergency stop', a: '%QX13.7', note: 'NC' },
  { n: 'Auto', a: '%QX14.0' },
];
const OUTPUTS: TagDef[] = [
  { n: 'Conveyor entry', a: '%QX0.0' }, { n: 'Load', a: '%QX0.1' }, { n: 'Unload', a: '%QX0.2' }, { n: 'Transf. left', a: '%QX0.3' },
  { n: 'Transf. right', a: '%QX0.4' }, { n: 'Conveyor left', a: '%QX0.5' }, { n: 'Conveyor right', a: '%QX0.6' },
  { n: 'Start light', a: '%QX0.7' }, { n: 'Reset light', a: '%QX1.0' }, { n: 'Stop light', a: '%QX1.1' },
];

type Conn = 'connecting' | 'open' | 'offline';

function usePlant(onFrame: (s: PlantFrame) => void) {
  const [conn, setConn] = React.useState<Conn>('connecting');
  const [state, setState] = React.useState<PlantFrame | null>(null);
  const [hz, setHz] = React.useState(0);
  const [url, setUrl] = React.useState(PLANT_URLS[0]);
  const [msgErr, setMsgErr] = React.useState<{ text: string; at: number } | null>(null);
  const ws = React.useRef<WebSocket | null>(null);
  const frameCb = React.useRef(onFrame); frameCb.current = onFrame;
  React.useEffect(() => {
    let dead = false, retry = 0, timer = 0, lastUi = 0, count = 0, latest: PlantFrame | null = null, urlIdx = 0;
    const hzT = window.setInterval(() => { setHz(count); count = 0; }, 1000);
    const connect = () => {
      if (dead) return;
      setConn((c) => (c === 'offline' ? c : 'connecting'));
      const target = PLANT_URLS[urlIdx % PLANT_URLS.length];
      let s: WebSocket, opened = false;
      try { s = new WebSocket(target); } catch { urlIdx += 1; schedule(); return; }
      ws.current = s;
      s.onopen = () => { opened = true; retry = 0; setUrl(target); setConn('open'); };
      s.onmessage = (ev) => {
        let m: (PlantFrame & { t?: string; message?: string }) | null = null;
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        if (!m) return;
        if (m.t === 'state') {
          count += 1; latest = m; frameCb.current(m);
          const now = performance.now();
          if (now - lastUi > 1000 / UI_HZ) { lastUi = now; setState(m); }
        } else if (m.error || m.message) {
          setMsgErr({ text: String(m.error ?? m.message), at: Date.now() });
        }
      };
      s.onclose = () => {
        if (ws.current === s) ws.current = null;
        if (dead) return;
        if (!opened) urlIdx += 1; // never opened: try the next endpoint
        const fullCycle = opened || urlIdx % PLANT_URLS.length === 0;
        if (fullCycle) { setConn('offline'); if (latest) setState({ ...latest }); }
        schedule(fullCycle);
      };
      s.onerror = () => { /* onclose follows; the offline banner explains it */ };
    };
    const schedule = (backoff = true) => { if (dead) return; if (backoff) retry = Math.min(retry + 1, 5); timer = window.setTimeout(connect, backoff ? 600 * retry : 80); };
    connect();
    return () => { dead = true; window.clearTimeout(timer); window.clearInterval(hzT); const s = ws.current; ws.current = null; if (s) { s.onclose = null; s.close(); } };
  }, []);
  const send = React.useCallback((msg: object) => {
    const s = ws.current;
    if (!s || s.readyState !== WebSocket.OPEN) return false;
    s.send(JSON.stringify(msg)); return true;
  }, []);
  return { conn, state, hz, msgErr, send, url };
}

function Stage({ apiRef }: { apiRef: React.MutableRefObject<FactoryApi | null> }) {
  const host = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!host.current) return;
    const f = createFactory(host.current, { offset: 0.75, quality: 'high', labels: 'auto', shotScale: 0.85, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
    f.setShot('overview');
    apiRef.current = f;
    return () => { f.dispose(); apiRef.current = null; };
  }, [apiRef]);
  return <div className="plant-3d" ref={host} />;
}

const Led = ({ d, v }: { d: TagDef; v: boolean | number | undefined }) => {
  const on = v === true;
  return (<div className={`plant-led ${on ? 'on' : ''} ${v === undefined ? 'na' : ''}`} title={`${d.n} ${d.a}${d.note ? ` (${d.note})` : ''} = ${v === undefined ? 'unknown' : String(v)}`}>
    <i /><span className="n">{d.n}</span><span className="a">{d.a}{d.note ? ` · ${d.note}` : ''}</span></div>);
};

export default function PlantTab() {
  const f = React.useRef<FactoryApi | null>(null);
  const onFrame = React.useCallback((s: PlantFrame) => { f.current?.applyPlant(s); }, []);
  const { conn, state, hz, msgErr, send, url } = usePlant(onFrame);
  const [armReq, setArmReq] = React.useState<{ on: boolean; at: number } | null>(null);
  const [labels, setLabels] = React.useState<'auto' | 'all'>('auto');
  // Cinematic camera: open on the rotating overview, then hand over to the sensor tour; any click takes manual control.
  type Shot = 'overview' | 'descend' | 'sensors' | 'monitor';
  const [shot, setShotState] = React.useState<Shot>('overview');
  const [autoCam, setAutoCam] = React.useState(true);
  const setShot = (s: Shot) => { setAutoCam(false); setShotState(s); };
  React.useEffect(() => { if (!autoCam) return; const t = window.setTimeout(() => setShotState('sensors'), 7000); return () => window.clearTimeout(t); }, [autoCam]);
  React.useEffect(() => { f.current?.setLabels(labels); }, [labels]);
  React.useEffect(() => { f.current?.setShot(shot); }, [shot]);
  React.useEffect(() => { if (conn === 'offline') f.current?.clearPlant(); }, [conn]);

  const live = conn === 'open' && !!state;
  const armed = live && !!state?.armed;
  const tags = state?.tags ?? {};
  const plc = state?.plc;
  // Server refusals arrive as state.error (or an error message); pending arm requests time out after 4 s.
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 500); return () => window.clearInterval(t); }, []);
  React.useEffect(() => { if (armReq && state && !!state.armed === armReq.on) setArmReq(null); }, [armReq, state]);
  const blockers: string[] = [];
  if (state?.busyJob) blockers.push(`a worker job is running (${state.busyJob})`);
  if (state?.factoryIoActive) blockers.push('Factory I/O is still connected to the PLC; stop the Factory I/O scene first');
  const refusal = armReq && armReq.on && now - armReq.at > 1500
    ? (state?.error ?? (msgErr && msgErr.at >= armReq.at ? msgErr.text : null) ?? (blockers.length ? `refused: ${blockers.join('; ')}` : now - armReq.at > 4000 ? 'the plant-sim did not confirm arming' : null))
    : null;

  const toggleArm = () => {
    if (!live) return;
    if (!armed) {
      if (!window.confirm('Arm the plant simulator?\n\nWhile armed it WRITES the sensor inputs (%QX12.4 … %QX14.0) of the REAL OpenPLC over Modbus, and the operator buttons below press Start / Stop / Reset / E-stop on it.\n\nOutputs are never written and no program is uploaded. Disarming restores the inputs to a safe rest state.')) return;
      setArmReq({ on: true, at: Date.now() }); send({ t: 'arm', on: true });
    } else { setArmReq({ on: false, at: Date.now() }); send({ t: 'arm', on: false }); }
  };
  const press = (tag: 'Start' | 'Stop' | 'Reset') => { if (armed && send({ t: 'press', tag, ms: 300 })) f.current?.pulse(tag); };
  const estopLatched = tags['Emergency stop'] === false;
  const estop = () => { if (armed && send({ t: 'estop', latched: !estopLatched })) f.current?.pulse('Emergency stop'); };

  const counter = typeof tags.Counter === 'number' ? tags.Counter : null;
  const nBoxes = state?.boxes?.length ?? 0;

  let badge: React.ReactNode;
  if (conn === 'offline') badge = <span className="plant-badge off"><i />plant-sim offline · start it with: <code>npm start</code> in apps/plant-sim · retrying</span>;
  else if (!live) badge = <span className="plant-badge wait"><i />connecting to {url}…</span>;
  else if (!plc?.connected) badge = <span className="plant-badge warn"><i />plant-sim up · PLC not connected{plc?.lastReadAgoMs != null ? ` · last read ${(plc.lastReadAgoMs / 1000).toFixed(1)} s ago` : ''}</span>;
  else if (plc.source === 'real') badge = <span className="plant-badge on"><i />Live · real OpenPLC via Modbus · {hz} Hz · rtt {plc.rttMs != null ? Math.round(plc.rttMs) : '—'} ms{plc.program ? ` · ${plc.program}` : ''}</span>;
  // Only the server's plc.source === 'real' may claim the real rig; a mock (or an unreported source) is labelled as such.
  else badge = <span className="plant-badge warn"><i />{plc.source === 'mock' ? 'Simulated PLC (mock) · not the real rig' : 'PLC source not reported · treat as simulated'} · {hz} Hz</span>;

  return (<div className="plant">
    <div className="card plant-head">
      <div className="ch">
        <h2>Live plant</h2>
        <span className="sub">Sorting by Height · physics on the plant-sim server, logic on the PLC</span>
        <span className="r">{badge}</span>
      </div>
    </div>

    <div className="card plant-stagecard">
      <div className="plant-stage">
        <Stage apiRef={f} />
        {live && !armed && nBoxes === 0 ? <div className="plant-idle"><b>Arm to run the line</b><span>The PLC holds the sorter while the plant is disarmed, so no boxes flow yet.</span></div> : null}
        {conn === 'offline' ? <div className="plant-veil"><b>plant-sim offline</b><span>Start it with <code>npm start</code> in <code>apps/plant-sim</code>. This tab reconnects on its own (tries {PLANT_URLS.join(' then ')}).</span></div> : null}
        <div className="plant-hud tl">
          <div className="plant-kv"><span>Boxes</span><b>{live ? nBoxes : '—'}</b></div>
          <div className="plant-kv"><span>Counter %QW0</span><b>{counter != null ? String(counter).padStart(4, '0') : '—'}</b></div>
          <div className="plant-kv"><span>Mode</span><b className={armed ? 't-fl' : ''}>{armed ? 'ARMED · writing' : 'read-only'}</b></div>
        </div>
        <div className="plant-hud tr">
          {(['overview', 'descend', 'sensors', 'monitor'] as const).map((s) => <button key={s} className={shot === s ? 'on' : ''} onClick={() => setShot(s)}>{s}</button>)}
          <button className={labels === 'all' ? 'on' : ''} onClick={() => setLabels(labels === 'all' ? 'auto' : 'all')}>labels</button>
        </div>

        <div className="plant-ops">
          <label className={`plant-arm ${armed ? 'on' : ''} ${!live ? 'dis' : ''}`}>
            <input type="checkbox" checked={armed} disabled={!live || (!!armReq && now - armReq.at < 1500)} onChange={toggleArm} />
            <span className="sw"><i /></span>
            <span className="tx"><b>{armed ? 'Armed' : 'Arm'}</b>Drive the real PLC (writes sensor inputs)</span>
          </label>
          {refusal ? <div className="plant-refuse">Can't arm: {refusal}</div>
            : !armed && live && blockers.length ? <div className="plant-refuse soft">Arming will be refused: {blockers.join('; ')}</div>
            : state?.error && live ? <div className="plant-refuse">{state.error}</div> : null}
          <div className="plant-panel">
            <span className="plant-lbl">Operator</span>
            <div className="plant-btns">
              <button className="pb start" disabled={!armed} onClick={() => press('Start')}><i className={tags['Start light'] ? 'lit' : ''} />Start</button>
              <button className="pb stop" disabled={!armed} onClick={() => press('Stop')}><i className={tags['Stop light'] ? 'lit' : ''} />Stop</button>
              <button className="pb reset" disabled={!armed} onClick={() => press('Reset')}><i className={tags['Reset light'] ? 'lit' : ''} />Reset</button>
              <button className={`pb es ${estopLatched ? 'latched' : ''}`} disabled={!armed} onClick={estop} title={estopLatched ? 'Release the E-stop' : 'Latch the E-stop'}>{estopLatched ? 'E-stop latched · release' : 'E-stop'}</button>
            </div>
            {!armed ? <p className="plant-note">Buttons are disabled until you arm. Read-only mode only listens.</p> : null}
          </div>
        </div>
      </div>
    </div>

    <div className="card plant-tags">
      <div className="ch"><h3>Live tags</h3><span className="sub">{live ? `from the PLC via plant-sim · ${url.replace(/^wss?:\/\//, '')}` : 'no data'}</span></div>
      <div className="cb">
        <p className="lbl">Inputs · plant → PLC</p>
        <div className="plant-strip">{INPUTS.map((d) => <Led key={d.n} d={d} v={live ? tags[d.n] as boolean | undefined : undefined} />)}</div>
        <p className="lbl" style={{ marginTop: 16 }}>Outputs · PLC → plant</p>
        <div className="plant-strip">{OUTPUTS.map((d) => <Led key={d.n} d={d} v={live ? tags[d.n] as boolean | undefined : undefined} />)}
          <div className={`plant-led num ${counter ? 'on' : ''}`}><i /><span className="n">Counter</span><span className="a">%QW0 · {counter ?? '—'}</span></div></div>
      </div>
    </div>
  </div>);
}
