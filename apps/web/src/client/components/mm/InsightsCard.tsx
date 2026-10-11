import * as React from 'react';
import { Activity } from 'lucide-react';
import type { AnalyticsData, AnalyticsSecond, RunTrendPoint } from '@/shared/insights';
import { cn } from '@/client/lib/utils';
import { fmtClock, pct, shortId } from '@/client/lib/format';
import { testTone } from '@/client/lib/tones';
import { EmptyState, Metric, Panel, SectionLabel, StatusPill } from './ui';

const W = 560;
const H = 132;
const PAD = { l: 34, r: 8, t: 8, b: 18 };

type View = 'rate' | 'cumulative';

function SamplesChart({ series, view }: { series: AnalyticsSecond[]; view: View }) {
  const [hover, setHover] = React.useState<number | null>(null);
  const values = series.map((s) => (view === 'rate' ? s.samples : s.cumulative));
  const max = Math.max(1, ...values, ...(view === 'rate' ? series.map((s) => s.avg5s) : []));
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (series.length <= 1 ? iw / 2 : (i / (series.length - 1)) * iw);
  const y = (v: number) => PAD.t + ih - (v / max) * ih;
  const barW = Math.max(1, Math.min(8, iw / Math.max(1, series.length) - 2));
  const avgPath = series.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(s.avg5s).toFixed(1)}`).join('');
  const cumPath = series.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(s.cumulative).toFixed(1)}`).join('');
  const ticks = [0, max / 2, max];

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - PAD.l) / iw) * (series.length - 1));
    setHover(i >= 0 && i < series.length ? i : null);
  };
  const h = hover !== null ? series[hover] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={view === 'rate' ? 'Samples per second with 5 second moving average' : 'Cumulative samples'}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--color-plant-700)" strokeWidth={1} strokeDasharray={t ? '2 3' : undefined} />
            <text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" className="fill-plant-500 font-mono text-[9px]">
              {t >= 100 ? Math.round(t) : t.toFixed(t % 1 ? 1 : 0)}
            </text>
          </g>
        ))}
        {view === 'rate' ? (
          <>
            {series.map((s, i) =>
              s.samples > 0 ? (
                <rect
                  key={i}
                  x={x(i) - barW / 2}
                  y={y(s.samples)}
                  width={barW}
                  height={Math.max(0, PAD.t + ih - y(s.samples))}
                  rx={Math.min(2, barW / 2)}
                  className={cn('fill-flow-500/70', hover === i && 'fill-flow-300')}
                />
              ) : null,
            )}
            <path d={avgPath} fill="none" stroke="var(--color-meta-400)" strokeWidth={2} strokeLinejoin="round" />
          </>
        ) : (
          <>
            <path d={`${cumPath}L${x(series.length - 1)},${PAD.t + ih}L${x(0)},${PAD.t + ih}Z`} className="fill-flow-500/15" />
            <path d={cumPath} fill="none" stroke="var(--color-flow-400)" strokeWidth={2} strokeLinejoin="round" />
          </>
        )}
        {h && hover !== null && (
          <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + ih} stroke="var(--color-plant-300)" strokeWidth={1} />
        )}
        {series.length > 0 && (
          <>
            <text x={PAD.l} y={H - 4} className="fill-plant-500 font-mono text-[9px]">
              {fmtClock(new Date(series[0].ts))}
            </text>
            <text x={W - PAD.r} y={H - 4} textAnchor="end" className="fill-plant-500 font-mono text-[9px]">
              {fmtClock(new Date(series[series.length - 1].ts))}
            </text>
          </>
        )}
      </svg>
      {h && hover !== null && (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded border border-plant-600 bg-plant-850 px-2 py-1 font-mono text-[10.5px] text-plant-200 shadow-lg"
          style={{ left: `${Math.min(70, Math.max(0, (x(hover) / W) * 100 - 10))}%` }}
        >
          <div className="text-plant-400">{fmtClock(new Date(h.ts))}</div>
          <div>{h.samples} samples · avg5s {h.avg5s.toFixed(1)}</div>
          <div>total {h.cumulative}{h.maxGapMs !== undefined ? ` · max gap ${h.maxGapMs} ms` : ''}</div>
        </div>
      )}
      {view === 'rate' && (
        <div className="mt-1 flex items-center gap-4 font-mono text-[10px] text-plant-400">
          <span className="flex items-center gap-1.5"><span className="inline-block size-2 rounded-sm bg-flow-500/70" />samples / s ($dateTrunc + $densify)</span>
          <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-3 bg-meta-400" />5 s moving avg ($setWindowFields)</span>
        </div>
      )}
    </div>
  );
}

function TrendStrip({ trend, current }: { trend: RunTrendPoint[]; current: string | null }) {
  if (!trend.length) return null;
  return (
    <div>
      <SectionLabel right={<span className="font-mono text-[10px]">bar = pass rate · tick = 3-run rolling avg</span>}>Public pass rate by run</SectionLabel>
      <div className="flex h-14 items-end gap-1.5 rounded-md border border-plant-700 bg-plant-850/60 px-2 pb-1 pt-2">
        {trend.map((p) => {
          const h = (p.passRate ?? 0) * 100;
          const r = (p.rolling3 ?? 0) * 100;
          return (
            <div
              key={p.simRunId}
              className="group relative flex h-full flex-1 items-end"
              title={`run ${shortId(p.simRunId)} · ${p.publicPassed}/${p.publicTotal} passed (${pct(p.passRate)}) · rolling ${pct(p.rolling3)}`}
            >
              <div
                className={cn('w-full rounded-t-sm', p.simRunId === current ? 'bg-go-400' : 'bg-go-600/70 group-hover:bg-go-500')}
                style={{ height: `${Math.max(3, h)}%` }}
              />
              <div className="absolute inset-x-0 h-0.5 bg-meta-300" style={{ bottom: `${r}%` }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function InsightsCard({ data, children }: { data: AnalyticsData | null; children?: React.ReactNode }) {
  const [view, setView] = React.useState<View>('rate');
  const right = data ? (
    <div className="flex items-center gap-1 rounded border border-plant-700 p-0.5">
      {(['rate', 'cumulative'] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => setView(v)}
          className={cn(
            'rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors',
            view === v ? 'bg-plant-700 text-plant-50' : 'text-plant-400 hover:text-plant-100',
          )}
        >
          {v}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <Panel title="Signal analytics" icon={<Activity />} right={right}>
      {children ?? (
        data && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 font-mono text-[10.5px] text-plant-400">
              <span>sim run {data.simRunId ? shortId(data.simRunId) : '—'}</span>
              {data.runStatus && <StatusPill tone={data.runStatus === 'running' ? 'active' : 'muted'} pulse={data.runStatus === 'running'}>{data.runStatus}</StatusPill>}
              <span>· Atlas window functions in {data.computedInMs} ms</span>
              {data.hiddenTestsExcluded > 0 && <span>· {data.hiddenTestsExcluded} hidden tests excluded</span>}
            </div>
            {data.series.length ? (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <Metric label="Public samples" value={data.totalSamples.toLocaleString()} />
                  <Metric label="Peak / s" value={Math.max(...data.series.map((s) => s.samples))} tone="active" />
                  <Metric
                    label="Worst gap"
                    value={`${Math.max(0, ...data.tests.map((t) => t.maxGapMs ?? 0))} ms`}
                    tone={Math.max(0, ...data.tests.map((t) => t.maxGapMs ?? 0)) > 1000 ? 'warn' : undefined}
                  />
                </div>
                <SamplesChart series={data.series} view={view} />
              </>
            ) : (
              <EmptyState>No public measurements in the newest sim run yet</EmptyState>
            )}

            {data.tests.length > 0 && (
              <div>
                <SectionLabel right={<span className="font-mono text-[10px]">$shift + $percentile per test</span>}>Sampling quality</SectionLabel>
                <div className="overflow-x-auto rounded-md border border-plant-700">
                  <table className="w-full text-[11.5px]">
                    <thead className="bg-plant-850 font-display text-[10px] uppercase tracking-[0.12em] text-plant-400">
                      <tr>
                        <th className="px-2 py-1 text-left font-semibold">Test</th>
                        <th className="px-2 py-1 text-right font-semibold">Samples</th>
                        <th className="px-2 py-1 text-right font-semibold">Hz</th>
                        <th className="px-2 py-1 text-right font-semibold">p50 gap</th>
                        <th className="px-2 py-1 text-right font-semibold">p95 gap</th>
                        <th className="px-2 py-1 text-right font-semibold">Max</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono tabular-nums text-plant-200">
                      {data.tests.map((t) => (
                        <tr key={t.testId} className="border-t border-plant-800">
                          <td className="px-2 py-1">
                            <StatusPill tone={testTone(t.verdict)} className="mr-1.5">{t.verdict ?? '…'}</StatusPill>
                            {t.testId}
                          </td>
                          <td className="px-2 py-1 text-right">{t.samples}</td>
                          <td className="px-2 py-1 text-right">{t.rateHz?.toFixed(1) ?? '—'}</td>
                          <td className="px-2 py-1 text-right">{t.p50GapMs ?? '—'}</td>
                          <td className={cn('px-2 py-1 text-right', (t.p95GapMs ?? 0) > 500 && 'text-caution-300')}>{t.p95GapMs ?? '—'}</td>
                          <td className={cn('px-2 py-1 text-right', (t.maxGapMs ?? 0) > 1000 && 'text-caution-300')}>{t.maxGapMs ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {data.tags.length > 0 && (
              <div>
                <SectionLabel right={<span className="font-mono text-[10px]">value changes, $objectToArray + $shift</span>}>Most active signals</SectionLabel>
                <div className="space-y-1">
                  {data.tags.map((t) => {
                    const top = data.tags[0]?.transitions || 1;
                    return (
                      <div key={t.tag} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-[11.5px]" title={`${t.transitions} transitions${t.perMinute ? `, ${t.perMinute.toFixed(1)}/min` : ''}`}>
                        <span className="truncate text-plant-300">{t.tag}</span>
                        <span className="h-1.5 rounded-full bg-plant-800">
                          <span className="block h-full rounded-full bg-flow-500" style={{ width: `${Math.max(3, (t.transitions / top) * 100)}%` }} />
                        </span>
                        <span className="font-mono tabular-nums text-plant-200">{t.transitions}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <TrendStrip trend={data.trend} current={data.simRunId} />
          </div>
        )
      )}
    </Panel>
  );
}
