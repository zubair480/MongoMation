// Presentation-only instrument widgets for the PLC workflow page: count-up readouts, the radial gauge and the ink stamp.
// They only display values they are given; no data is fetched or derived here.
import * as React from 'react';

const reduced = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

/** Renders `text` with every number in it counting up from 0 (or from its previous value) on mount / change. */
export function CountUp({ text, ms = 900 }: { text: string; ms?: number }) {
  const [out, setOut] = React.useState(() => (reduced() ? text : text.replace(/\d+(\.\d+)?/g, (m) => (m.includes('.') ? (0).toFixed(m.split('.')[1].length) : '0'))));
  const prev = React.useRef<number[]>([]);
  React.useEffect(() => {
    const nums = (text.match(/\d+(\.\d+)?/g) ?? []).map(Number);
    const decs = (text.match(/\d+(\.\d+)?/g) ?? []).map((m) => (m.includes('.') ? m.split('.')[1].length : 0));
    if (!nums.length || reduced()) { setOut(text); prev.current = nums; return; }
    const from = nums.map((_, i) => prev.current[i] ?? 0);
    let raf = 0; const t0 = performance.now();
    const step = (now: number) => {
      const k = ease(Math.min(1, (now - t0) / ms)); let j = 0;
      setOut(text.replace(/\d+(\.\d+)?/g, () => { const i = j++; return (from[i] + (nums[i] - from[i]) * k).toFixed(decs[i]); }));
      if (k < 1) raf = requestAnimationFrame(step); else prev.current = nums;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text, ms]);
  return <span className="cu">{out}</span>;
}

/** 270° radial gauge, drawn on mount. */
export function Gauge({ value, total, tone = 'ink', caption }: { value: number; total: number; tone?: 'ink' | 'warn' | 'fail'; caption?: React.ReactNode }) {
  const S = 232, r = 96, c = 2 * Math.PI * r, arc = c * 0.75;
  const frac = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
  const [drawn, setDrawn] = React.useState(reduced());
  React.useEffect(() => { const id = requestAnimationFrame(() => requestAnimationFrame(() => setDrawn(true))); return () => cancelAnimationFrame(id); }, []);
  const ticks = Array.from({ length: 41 }, (_, i) => {
    const a = (135 + (270 * i) / 40) * (Math.PI / 180), big = i % 10 === 0;
    const r1 = r + 14, r2 = r + (big ? 24 : 19);
    return <line key={i} x1={S / 2 + r1 * Math.cos(a)} y1={S / 2 + r1 * Math.sin(a)} x2={S / 2 + r2 * Math.cos(a)} y2={S / 2 + r2 * Math.sin(a)} className={big ? 'tk big' : 'tk'} />;
  });
  const endA = (135 + 270 * (drawn ? frac : 0)) * (Math.PI / 180);
  return (<div className={`gauge g-${tone}`}>
    <svg viewBox={`0 0 ${S} ${S}`} width={S} height={S} aria-hidden="true">
      {ticks}
      <circle cx={S / 2} cy={S / 2} r={r} className="g-track" strokeDasharray={`${arc} ${c}`} transform={`rotate(135 ${S / 2} ${S / 2})`} />
      <circle cx={S / 2} cy={S / 2} r={r} className="g-val" strokeDasharray={`${drawn ? arc * frac : 0} ${c}`} transform={`rotate(135 ${S / 2} ${S / 2})`} />
      {frac > 0 ? <circle className="g-tip" cx={S / 2 + r * Math.cos(endA)} cy={S / 2 + r * Math.sin(endA)} r="5" /> : null}
      <circle cx={S / 2} cy={S / 2} r={r - 22} className="g-face" />
    </svg>
    <div className="g-read"><b><CountUp text={String(value)} /></b><span>/ {total}</span></div>
    {caption ? <div className="g-cap">{caption}</div> : null}
  </div>);
}

/** Rubber-stamp badge. */
export function Stamp({ children, tone = 'ink' }: { children: React.ReactNode; tone?: 'ink' | 'warn' | 'fail' }) {
  return <span className={`stamp s-${tone}`}><span>{children}</span></span>;
}
