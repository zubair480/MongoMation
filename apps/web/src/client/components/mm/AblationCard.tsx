import * as React from 'react';
import { Download, FlaskConical } from 'lucide-react';
import type { AblationConditionLite, AblationData, HarnessScoresLite } from '@/shared/mongomation';
import { cn } from '@/client/lib/utils';
import { fmtDateTime, pct, shortId, usd } from '@/client/lib/format';
import { downloadText, fileSlug } from '@/client/lib/download';
import { CodeChip, EmptyState, Panel, SectionLabel, StatusPill } from './ui';

type Row = { key: keyof HarnessScoresLite; label: string; fmt: (v: number) => string; better: 'up' | 'down' | null };

const ROWS: Row[] = [
  { key: 'requirement_satisfaction', label: 'Requirement satisfaction', fmt: pct, better: 'up' },
  { key: 'safety_pass_rate', label: 'Hidden safety pass rate', fmt: pct, better: 'up' },
  { key: 'compile_first_try', label: 'Compiles first try', fmt: pct, better: 'up' },
  { key: 'test_pass_rate', label: 'Test pass rate', fmt: pct, better: 'up' },
  { key: 'repairs_per_case', label: 'Repairs / case', fmt: (v) => v.toFixed(2), better: 'down' },
  { key: 'cost_usd_per_case', label: 'Cost / case', fmt: (v) => usd(v), better: 'down' },
  { key: 'seconds_per_case', label: 'Seconds / case', fmt: (v) => `${v.toFixed(0)} s`, better: 'down' },
  { key: 'tests_blocked', label: 'Blocked tests (no evidence)', fmt: (v) => String(v), better: 'down' },
  { key: 'cases', label: 'Cases', fmt: (v) => String(v), better: null },
];

function conditionLabel(c: AblationConditionLite): { title: string; sub: string } {
  if (c.key === 'bare') return { title: 'Bare', sub: 'one-shot, no harness' };
  if (c.key === 'v0') return { title: 'Harness v0', sub: 'baseline harness' };
  return { title: `Evolved ${c.key}`, sub: 'kept by the RSI gate' };
}

function AblationTable({ conditions }: { conditions: AblationConditionLite[] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-plant-700">
      <table className="w-full text-[12px]">
        <thead className="bg-plant-850 font-display text-[10px] uppercase tracking-[0.12em] text-plant-400">
          <tr>
            <th className="px-2.5 py-1.5 text-left font-semibold">Metric</th>
            {conditions.map((c) => {
              const l = conditionLabel(c);
              return (
                <th key={c.key} className="px-2.5 py-1.5 text-right font-semibold" title={l.sub}>
                  {l.title}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {ROWS.map((row) => {
            const values = conditions.map((c) => c.scores?.[row.key]);
            if (values.every((v) => v === undefined)) return null;
            const defined = values.filter((v): v is number => v !== undefined);
            const best =
              row.better && defined.length > 1 && new Set(defined).size > 1
                ? row.better === 'up'
                  ? Math.max(...defined)
                  : Math.min(...defined)
                : undefined;
            return (
              <tr key={row.key} className="border-t border-plant-800">
                <td className="px-2.5 py-1 font-sans text-plant-300">{row.label}</td>
                {values.map((v, i) => (
                  <td
                    key={conditions[i].key}
                    className={cn('px-2.5 py-1 text-right', v !== undefined && v === best ? 'font-semibold text-go-300' : 'text-plant-200')}
                  >
                    {v === undefined ? '—' : row.fmt(v)}
                  </td>
                ))}
              </tr>
            );
          })}
          <tr className="border-t border-plant-800">
            <td className="px-2.5 py-1 font-sans text-plant-400">Rows in benchmark_runs</td>
            {conditions.map((c) => (
              <td key={c.key} className="px-2.5 py-1 text-right text-plant-400">
                {c.rows}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function AblationCard({ data, children }: { data: AblationData | null; children?: React.ReactNode }) {
  const summary = data?.summary ?? null;
  const inProgress = data?.inProgress ?? null;
  const exportJson = () => {
    if (!summary) return;
    downloadText(`ablation-${fileSlug(summary.benchmarkId)}.json`, JSON.stringify(summary, null, 2), 'application/json');
  };
  return (
    <Panel
      index="04b"
      title="Ablation (held-out)"
      icon={<FlaskConical />}
      right={
        summary ? (
          <button
            type="button"
            onClick={exportJson}
            title="Download the ablation summary as JSON"
            className="inline-flex items-center gap-1 rounded-md border border-plant-600 px-2 py-1 text-[11.5px] text-plant-300 hover:bg-plant-800"
          >
            <Download className="size-3.5" aria-hidden /> .json
          </button>
        ) : undefined
      }
      bodyClassName="space-y-4"
    >
      {children ?? (
        <>
          {inProgress && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-flow-400/40 bg-flow-400/[0.06] px-3 py-2">
              {/* No new case row for 10 min means the worker stopped; don't show a stale run as live. */}
              {inProgress.lastRowAt && Date.now() - new Date(inProgress.lastRowAt).getTime() > 10 * 60_000 ? (
                <StatusPill tone="warn">INCOMPLETE</StatusPill>
              ) : (
                <StatusPill tone="active" pulse>
                  RUNNING
                </StatusPill>
              )}
              <span className="font-mono text-[11.5px] text-plant-300">
                ablation {shortId(inProgress.benchmarkId, 10)} · {inProgress.rows} case row(s) so far
              </span>
              <span className="ml-auto font-mono text-[10.5px] text-plant-500">last row {fmtDateTime(inProgress.lastRowAt)}</span>
            </div>
          )}

          {summary ? (
            <div className="space-y-2">
              <SectionLabel right={<span className="font-mono">{data?.summaryCount ?? 0} run(s)</span>}>
                Bare one-shot vs harness v0 vs evolved
              </SectionLabel>
              {summary.conditions.length ? (
                <AblationTable conditions={summary.conditions} />
              ) : (
                <EmptyState tone="warn">Summary row has no scores</EmptyState>
              )}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-plant-500">
                <span>
                  run <CodeChip value={summary.benchmarkId} label={shortId(summary.benchmarkId, 10)} />
                </span>
                {summary.manifestHash && (
                  <span>
                    manifest <CodeChip value={summary.manifestHash} label={shortId(summary.manifestHash, 10)} />
                  </span>
                )}
                {summary.model && (summary.model.fast || summary.model.strong) && (
                  <span>
                    models {summary.model.fast ?? '?'} / {summary.model.strong ?? '?'}
                  </span>
                )}
                <span className="ml-auto">{fmtDateTime(summary.createdAt)}</span>
              </div>
            </div>
          ) : (
            !inProgress && <EmptyState>No ablation run yet · run an ablation job to compare bare vs harness vs evolved</EmptyState>
          )}
        </>
      )}
    </Panel>
  );
}
