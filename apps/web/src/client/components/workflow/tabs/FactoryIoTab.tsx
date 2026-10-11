// Factory I/O (live) tab: the real EC2 Factory I/O desktop through the Amazon DCV web client, embedded in an iframe.
// The URL is rig_status.dcvUrl from Atlas (the same value the HMI tab's "open DCV" link uses); nothing is hard-coded.
// The DCV server sends X-Frame-Options: DENY and a self-signed certificate, so the direct URL cannot be framed.
// When the local proxy (apps/web/scripts/dcv-proxy.mjs, port 8444) answers, we frame it instead: it strips the
// framing block and accepts the self-signed cert. Without the proxy we fall back to the direct URL plus a plain note.
import * as React from 'react';
import type { RigLite } from '@/shared/mongomation';

const LOAD_TIMEOUT_MS = 10_000;
const DCV_PROXY_PORT = 8444;
const PROBE_TIMEOUT_MS = 1500;

// Same hostname as the app (localhost or 127.0.0.1) so the proxy stays same-site and DCV cookies are sent in the frame.
function proxyOrigin() {
  const host = typeof window !== 'undefined' ? window.location.hostname : '127.0.0.1';
  return `http://${host.includes(':') ? `[${host}]` : host}:${DCV_PROXY_PORT}`;
}

function viaProxy(url: string) {
  try { const u = new URL(url); return proxyOrigin() + u.pathname + u.search + u.hash; } catch { return null; }
}

function useProxyUp(enabled: boolean, nonce: number) {
  const [up, setUp] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setUp(null);
    const ctl = new AbortController();
    const t = window.setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
    fetch(proxyOrigin() + '/', { mode: 'no-cors', cache: 'no-store', signal: ctl.signal })
      .then(() => { if (alive) setUp(true); }, () => { if (alive) setUp(false); })
      .finally(() => window.clearTimeout(t));
    return () => { alive = false; ctl.abort(); window.clearTimeout(t); };
  }, [enabled, nonce]);
  return up;
}

export default function FactoryIoTab({ rig, connected }: { rig: RigLite | null; connected: boolean }) {
  const url = rig?.dcvUrl;
  const [state, setState] = React.useState<'loading' | 'loaded' | 'timeout'>('loading');
  const [nonce, setNonce] = React.useState(0);
  const proxyUp = useProxyUp(!!url, nonce);
  const proxied = url && proxyUp ? viaProxy(url) : null;
  const src = proxyUp === null ? null : (proxied || url);

  React.useEffect(() => {
    if (!src) return;
    setState('loading');
    const id = window.setTimeout(() => setState((s) => (s === 'loading' ? 'timeout' : s)), LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(id);
  }, [src, nonce]);

  const open = () => { if (url) window.open(url, 'mm-dcv', 'noopener,noreferrer,width=1440,height=900'); };

  if (!url) {
    return (<div className="card"><div className="ch"><h3>Factory I/O on EC2 · live via Amazon DCV</h3></div>
      <div className="empty" style={{ margin: 16, padding: 32 }}><b>No DCV address</b>
        {connected ? 'rig_status.dcvUrl is not set in Atlas, so there is no live simulator screen to show.' : 'Waiting for Atlas…'}</div></div>);
  }

  return (<div className="card fio">
    <div className="ch"><h3>Factory I/O on EC2 · live via Amazon DCV</h3>
      <span className="sub mono">{proxied ? `via local proxy :${DCV_PROXY_PORT}` : url}</span>
      <span className="r" style={{ display: 'flex', gap: 8 }}>
        <button className="btn sm" onClick={() => setNonce((n) => n + 1)}>Reload</button>
        <button className="btn pri sm" onClick={open}>Open in new window ↗</button></span></div>
    {proxied ? (state === 'timeout' ? (
      <div className="fio-note" role="note">
        <b>The embedded view is slow to load.</b> Try Reload, or{' '}
        <a href={url} target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); open(); }}>Open in new window</a>.
      </div>) : null) : proxyUp === false ? (
      <div className="fio-note" role="note">
        <b>{state === 'timeout' ? 'The embedded view did not load.' : 'Blank or error frame below?'}</b>{' '}
        The DCV server refuses to be embedded in another page (X-Frame-Options) and uses a self-signed certificate.
        Start the local DCV proxy (<code>apps/web/scripts/dcv-proxy.mjs</code>) to show it here, or use{' '}
        <a href={url} target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); open(); }}>Open in new window</a>{' '}
        to see the live Factory I/O desktop.
      </div>) : null}
    {src ? (
      <iframe key={`${nonce}:${src}`} className="fio-frame" src={src} title="Factory I/O on EC2 (Amazon DCV)"
        allow="clipboard-read; clipboard-write; fullscreen; autoplay; keyboard-map" referrerPolicy="no-referrer"
        onLoad={() => setState('loaded')} />
    ) : <div className="empty" style={{ margin: 16, padding: 32 }}>Connecting to the DCV view…</div>}
  </div>);
}
