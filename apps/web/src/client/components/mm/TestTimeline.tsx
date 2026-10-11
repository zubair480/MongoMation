import * as React from 'react';
import { CheckCircle2, Table2, XCircle } from 'lucide-react';
import type { AssertionLite, SceneTagLite, TagValue, TestLite } from '@/shared/mongomation';
import { useTimeline } from '@/client/lib/api';
import { cn } from '@/client/lib/utils';
import { fmtDuration } from '@/client/lib/format';
import { DisconnectedNotice, EmptyState, Loading, ServerUnreachable } from './ui';

// Measured timeline of one public test: one small-multiple row per tag (step chart), shared time axis,
// assertion markers, a crosshair whose readout is the value column, and a table-view twin.
// Series colors: categorical slots 1-2 (sensor / actuator), validated on the panel surface.

type Sample = { t: number; values: Record<string, TagValue> };
type Series = { name: string; kind: 'bool' | 'num'; role?: string; points: { t: number; v: TagValue }[]; min: number; max: number };

const VIEW_W = 1000;
const ROW_H = 26;
const Y_ON = 6;
const Y_OFF = 20;

const ROLE_RANK: Record<string, number> = { sensor: 0, actuator: 1 };
const roleColor = (role?: string) =>
  role === 'sensor' ? 'var(--color-series-sensor)' : role === 'actuator' ? 'var(--color-series-actuator)' : 'var(--color-plant-300)';

function niceStep(durationMs: number): number {
  const candidates = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000];
  return candidates.find((c) => durationMs / c <= 6) ?? 600_000;
}

const fmtTick = (ms: number) => (ms === 0 ? '0' : ms < 1000 ? `${ms} ms` : `${+(ms / 1000).toFixed(2)} s`);

function buildSeries(samples: Sample[], sceneTags: SceneTagLite[]): Series[] {
  const byName = new Map<string, Series>();
  for (const s of samples) {
    for (const [name, v] of Object.entries(s.values)) {
      let series = byName.get(name);
      if (!series) {
        series = {
          name,
          kind: typeof v === 'boolean' ? 'bool' : 'num',
          role: sceneTags.find((t) => t.name === name)?.role,
          points: [],
          min: Infinity,
          max: -Infinity,
        };
        byName.set(name, series);
      }
      series.points.push({ t: s.t, v });
      if (typeof v === 'number') {
        series.min = Math.min(series.min, v);
        series.max = Math.max(series.max, v);
      }
    }
  }
  return [...byName.values()].sort((a, b) => (ROLE_RANK[a.role ?? ''] ?? 2) - (ROLE_RANK[b.role ?? ''] ?? 2));
}

/** Value in effect at time t (step semantics: the last change point at or before t). */
function valueAt(series: Series, t: number): TagValue | undefined {
  let lo = 0;
  let hi = series.points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series.points[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 ? series.points[found].v : undefined;
}

function yOf(series: Series, v: TagValue): number {
  if (typeof v === 'boolean') return v ? Y_ON : Y_OFF;
  if (series.max === series.min) return (Y_ON + Y_OFF) / 2;
  return Y_OFF - ((v - series.min) / (series.max - series.min)) * (Y_OFF - Y_ON);
}

function StepRow({ series, duration, ticks, assertions }: { series: Series; duration: number; ticks: number[]; assertions: AssertionLite[] }) {
  const x = (t: number) => (Math.min(Math.max(t, 0), duration) / duration) * VIEW_W;
  const color = roleColor(series.role);
  let d = '';
  const washes: { x0: number; x1: number }[] = [];
  series.points.forEach((p, i) => {
    const next = series.points[i + 1];
    const x0 = x(p.t);
    const x1 = x(next ? next.t : duration);
    const y = yOf(series, p.v);
    d += i === 0 ? `M${x0},${y}` : `V${y}`;
    d += `H${x1}`;
    if (p.v === true) washes.push({ x0, x1 });
  });
  return (
    <svg viewBox={`0 0 ${VIEW_W} ${ROW_H}`} preserveAspectRatio="none" className="block h-[26px] w-full" aria-hidden>
      {ticks.map((t) => (
        <line key={t} x1={x(t)} x2={x(t)} y1={0} y2={ROW_H} stroke="var(--color-plant-800)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      ))}
      <line x1={0} x2={VIEW_W} y1={Y_OFF} y2={Y_OFF} stroke="var(--color-plant-700)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      {washes.map((w, i) => (
        <rect key={i} x={w.x0} width={Math.max(0, w.x1 - w.x0)} y={Y_ON} height={Y_OFF - Y_ON} fill={color} opacity={0.12} />
      ))}
      {assertions.map((a, i) =>
        a.atMs === undefined ? null : (
          <line
            key={i}
            x1={x(a.atMs)}
            x2={x(a.atMs)}
            y1={0}
            y2={ROW_H}
            stroke={a.passed ? '#0ca30c' : '#d03b3b'}
            strokeOpacity={0.55}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )
      )}
      <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function fmtValue(v: TagValue | undefined): string {
  if (v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'ON' : 'OFF';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

export function TestTimeline({
  test,
  simRunId,
  live,
  sceneTags,
}: {
  test: TestLite;
  simRunId: string;
  live: boolean;
  sceneTags: SceneTagLite[];
}) {
  const q = useTimeline(simRunId, test.testId, live);
  const [cursor, setCursor] = React.useState<number | null>(null);
  const [showTable, setShowTable] = React.useState(false);

  const data = q.data;
  const samples = React.useMemo<Sample[]>(() => (data?.connected ? data.samples : []), [data]);
  const series = React.useMemo(() => buildSeries(samples, sceneTags), [samples, sceneTags]);
  const changeTimes = React.useMemo(() => [...new Set(samples.map((s) => s.t))].sort((a, b) => a - b), [samples]);

  if (q.isError && !data) return <ServerUnreachable error={q.error} what="measurements" />;
  if (!data) return <Loading label="Loading measurements" />;
  if (!data.connected) return <DisconnectedNotice status={data} what="measurements" compact />;
  if (!data.found) return <EmptyState tone="warn">Test result not found in Atlas</EmptyState>;
  if (data.hidden) return <EmptyState>Hidden regression test · measurements withheld</EmptyState>;
  if (!samples.length) return <EmptyState>No measurements stored for this test</EmptyState>;

  const assertions = data.assertions.length ? data.assertions : test.assertions;
  const lastT = samples[samples.length - 1].t;
  const duration = Math.max(data.durationMs ?? 0, lastT, 1);
  const step = niceStep(duration);
  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += step) ticks.push(t);
  const pct = (t: number) => `${(Math.min(Math.max(t, 0), duration) / duration) * 100}%`;

  const moveCursor = (dir: 1 | -1) => {
    const current = cursor ?? (dir === 1 ? -1 : duration + 1);
    const next = dir === 1 ? changeTimes.find((t) => t > current) : [...changeTimes].reverse().find((t) => t < current);
    if (next !== undefined) setCursor(next);
  };

  const transitions = series
    .flatMap((s) => s.points.map((p, i) => ({ t: p.t, name: s.name, v: p.v, first: i === 0 })))
    .sort((a, b) => a.t - b.t);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-plant-400">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded" style={{ background: 'var(--color-series-sensor)' }} aria-hidden /> sensor (PLC input)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded" style={{ background: 'var(--color-series-actuator)' }} aria-hidden /> actuator (PLC output)
        </span>
        <span className="font-mono">
          {data.totalSamples} samples · {samples.length} change points{data.truncated ? ' · downsampled' : ''}
          {live ? ' · run in progress' : ''}
        </span>
        <button
          type="button"
          onClick={() => setShowTable((v) => !v)}
          aria-pressed={showTable}
          className="ml-auto inline-flex items-center gap-1 rounded border border-plant-600 px-1.5 py-0.5 text-[11px] text-plant-300 hover:bg-plant-800"
        >
          <Table2 className="size-3" aria-hidden /> {showTable ? 'Chart' : 'Table'}
        </button>
      </div>

      {showTable ? (
        <div className="max-h-72 overflow-auto rounded-md border border-plant-700">
          <table className="w-full font-mono text-[11px]">
            <thead className="sticky top-0 bg-plant-850 text-left text-plant-400">
              <tr>
                <th className="px-2 py-1 font-medium">t (ms)</th>
                <th className="px-2 py-1 font-medium">tag</th>
                <th className="px-2 py-1 font-medium">value</th>
              </tr>
            </thead>
            <tbody>
              {transitions.slice(0, 500).map((r, i) => (
                <tr key={i} className="border-t border-plant-800">
                  <td className="px-2 py-0.5 tabular-nums text-plant-400">{r.t}</td>
                  <td className="px-2 py-0.5 text-plant-200">{r.name}</td>
                  <td className="px-2 py-0.5 text-plant-100">
                    {fmtValue(r.v)}
                    {r.first ? <span className="text-plant-500"> (initial)</span> : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative rounded-md border border-plant-700 bg-plant-950/70 py-1.5">
          {series.map((s) => (
            <div key={s.name} className="grid grid-cols-[9.5rem_minmax(0,1fr)_4.5rem] items-center">
              <div className="truncate px-2 text-[11.5px] text-plant-200" title={s.name}>
                {s.name}
                {s.kind === 'num' && (
                  <span className="block font-mono text-[9.5px] text-plant-500">
                    {fmtValue(s.min)}…{fmtValue(s.max)}
                  </span>
                )}
              </div>
              <StepRow series={s} duration={duration} ticks={ticks} assertions={assertions} />
              <div className="px-2 text-right font-mono text-[11px] tabular-nums text-plant-100">
                {fmtValue(cursor === null ? s.points[s.points.length - 1]?.v : valueAt(s, cursor))}
              </div>
            </div>
          ))}

          {/* time axis + assertion markers */}
          <div className="grid grid-cols-[9.5rem_minmax(0,1fr)_4.5rem] pt-1">
            <div className="px-2 font-mono text-[10px] text-plant-500">{cursor === null ? 'end values →' : ''}</div>
            <div className="relative h-8">
              {ticks.map((t, i) => (
                <span
                  key={t}
                  className={cn(
                    'absolute top-0 whitespace-nowrap font-mono text-[10px] text-plant-500',
                    // keep the edge labels inside the plot instead of wrapping or overflowing
                    i === 0 ? 'translate-x-0' : t / duration > 0.92 ? '-translate-x-full' : '-translate-x-1/2'
                  )}
                  style={{ left: pct(t) }}
                >
                  {fmtTick(t)}
                </span>
              ))}
              {assertions.map((a, i) =>
                a.atMs === undefined ? null : (
                  <span
                    key={i}
                    className={cn('absolute top-4 size-2.5 -translate-x-1/2 rotate-45 border', a.passed ? 'border-go-400 bg-go-500/60' : 'border-stop-400 bg-stop-500/70')}
                    style={{ left: pct(a.atMs) }}
                    title={`${a.passed ? 'PASS' : 'FAIL'} @ ${a.atMs} ms · ${a.label ?? ''}${a.detail ? ` · ${a.detail}` : ''}`}
                  />
                )
              )}
            </div>
            <div />
          </div>

          {/* crosshair overlay (plot column only) */}
          <div
            className="absolute bottom-9 left-[9.5rem] right-[4.5rem] top-1.5 cursor-crosshair outline-none focus-visible:ring-1 focus-visible:ring-flow-400"
            tabIndex={0}
            role="slider"
            aria-label="Timeline cursor: use left and right arrows to step through value changes"
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={cursor ?? undefined}
            aria-valuetext={cursor === null ? 'end of test' : `${Math.round(cursor)} ms`}
            onPointerMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const frac = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
              setCursor(frac * duration);
            }}
            onPointerLeave={() => setCursor(null)}
            onBlur={() => setCursor(null)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') {
                e.preventDefault();
                moveCursor(1);
              } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                moveCursor(-1);
              } else if (e.key === 'Escape') setCursor(null);
            }}
          >
            {cursor !== null && (
              <>
                <span className="pointer-events-none absolute inset-y-0 w-px bg-plant-100/70" style={{ left: pct(cursor) }} aria-hidden />
                <span
                  className="pointer-events-none absolute -top-1 -translate-x-1/2 -translate-y-full rounded border border-plant-500 bg-plant-800 px-1.5 py-0.5 font-mono text-[10.5px] text-plant-50"
                  style={{ left: pct(cursor) }}
                >
                  {fmtDuration(cursor)}
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {assertions.length > 0 && (
        <ul className="space-y-1">
          {assertions.map((a, i) => (
            <li key={i} className="flex items-start gap-2 text-[12px]">
              {a.passed ? (
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-go-400" aria-label="passed" />
              ) : (
                <XCircle className="mt-0.5 size-3.5 shrink-0 text-stop-400" aria-label="failed" />
              )}
              <span className="min-w-0">
                <span className="text-plant-100">{a.label ?? 'assertion'}</span>
                {a.atMs !== undefined && <span className="ml-1.5 font-mono text-[10.5px] text-plant-500">@ {a.atMs} ms</span>}
                {a.detail && <span className="block font-mono text-[11px] text-plant-400">{a.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
