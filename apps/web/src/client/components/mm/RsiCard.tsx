import * as React from 'react';
import { BrainCircuit, ChevronDown, ChevronRight, ShieldAlert } from 'lucide-react';
import type { HarnessDetail, HarnessScoresLite, ProposalLite, RsiData } from '@/shared/mongomation';
import { cn } from '@/client/lib/utils';
import { fmtDateTime, pct, shortId, upper, usd } from '@/client/lib/format';
import { rsiTone } from '@/client/lib/tones';
import { CodeChip, EmptyState, Panel, SectionLabel, StatusPill } from './ui';

type ScoreRow = {
  key: keyof HarnessScoresLite;
  label: string;
  fmt: (v: number) => string;
  /** Formats the absolute difference (rates as percentage points). */
  fmtDelta: (v: number) => string;
  better: 'up' | 'down' | null;
};

const rate = (key: keyof HarnessScoresLite, label: string): ScoreRow => ({
  key,
  label,
  fmt: (v) => pct(v),
  fmtDelta: (v) => `${(v * 100).toFixed(0)} pp`,
  better: 'up',
});

const SCORE_ROWS: ScoreRow[] = [
  rate('requirement_satisfaction', 'Requirement satisfaction'),
  rate('safety_pass_rate', 'Hidden safety pass rate'),
  rate('compile_first_try', 'Compiles first try'),
  rate('test_pass_rate', 'Test pass rate'),
  { key: 'repairs_per_case', label: 'Repairs / case', fmt: (v) => v.toFixed(2), fmtDelta: (v) => v.toFixed(2), better: 'down' },
  { key: 'cost_usd_per_case', label: 'Cost / case', fmt: (v) => usd(v), fmtDelta: (v) => usd(v), better: 'down' },
  { key: 'seconds_per_case', label: 'Seconds / case', fmt: (v) => `${v.toFixed(0)} s`, fmtDelta: (v) => `${v.toFixed(0)} s`, better: 'down' },
  { key: 'cases', label: 'Cases', fmt: (v) => String(v), fmtDelta: (v) => String(v), better: null },
];

function ScoresTable({ candidate, parentVersion }: { candidate: HarnessDetail; parentVersion?: number }) {
  const { scores, parentScores } = candidate;
  return (
    <div className="overflow-hidden rounded-md border border-plant-700">
      <table className="w-full text-[12px]">
        <thead className="bg-plant-850 font-display text-[10px] uppercase tracking-[0.12em] text-plant-400">
          <tr>
            <th className="px-2.5 py-1.5 text-left font-semibold">Metric</th>
            <th className="px-2.5 py-1.5 text-right font-semibold">Parent{parentVersion !== undefined ? ` v${parentVersion}` : ''}</th>
            <th className="px-2.5 py-1.5 text-right font-semibold">Candidate v{candidate.version}</th>
            <th className="px-2.5 py-1.5 text-right font-semibold">Δ</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {SCORE_ROWS.map((row) => {
            const a = parentScores?.[row.key];
            const b = scores?.[row.key];
            if (a === undefined && b === undefined) return null;
            const delta = a !== undefined && b !== undefined ? b - a : undefined;
            const improved = delta !== undefined && row.better && delta !== 0 ? (row.better === 'up' ? delta > 0 : delta < 0) : undefined;
            return (
              <tr key={row.key} className="border-t border-plant-800">
                <td className="px-2.5 py-1 font-sans text-plant-300">{row.label}</td>
                <td className="px-2.5 py-1 text-right text-plant-300">{a === undefined ? '—' : row.fmt(a)}</td>
                <td className="px-2.5 py-1 text-right text-plant-100">{b === undefined ? '—' : row.fmt(b)}</td>
                <td
                  className={cn(
                    'px-2.5 py-1 text-right',
                    improved === true && 'text-go-300',
                    improved === false && 'text-stop-300',
                    improved === undefined && 'text-plant-500'
                  )}
                >
                  {delta === undefined ? '—' : delta === 0 ? '±0' : `${delta > 0 ? '+' : '−'}${row.fmtDelta(Math.abs(delta))}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DiffLines({ lines }: { lines: string[] }) {
  return (
    <pre className="max-h-56 overflow-auto rounded-md border border-plant-700 bg-plant-950/80 py-1.5 font-mono text-[11px] leading-[1.6]">
      {lines.map((line, i) => {
        const add = line.startsWith('+');
        const del = line.startsWith('-');
        return (
          <div
            key={i}
            className={cn('px-2.5', add && 'bg-go-500/[0.12] text-go-300', del && 'bg-stop-500/[0.12] text-stop-300', !add && !del && 'text-plant-300')}
          >
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

function Provenance({ value }: { value: string | undefined }) {
  if (!value) {
    return (
      <div className="rounded-md border border-plant-600 bg-plant-850 px-3 py-2 font-display text-[12px] font-semibold uppercase tracking-[0.14em] text-plant-300">
        Provenance not recorded
      </div>
    );
  }
  const live = value === 'live';
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md border px-3 py-2',
        live ? 'border-go-500/60 bg-go-500/10' : 'border-caution-400/60 bg-caution-400/10'
      )}
    >
      <span className={cn('size-2.5 rounded-full', live ? 'bg-go-400 animate-pulse-dot' : 'bg-caution-400')} aria-hidden />
      <span className={cn('font-display text-[15px] font-bold uppercase tracking-[0.12em]', live ? 'text-go-300' : 'text-caution-300')}>
        {live ? 'Live' : value === 'previously measured' ? 'Previously measured' : value}
      </span>
      <span className="ml-auto text-[11px] text-plant-300">
        {live ? 'measured in this session' : 'replayed from stored measurements'}
      </span>
    </div>
  );
}

function ProposalView({ proposal, candidate }: { proposal: ProposalLite; candidate: HarnessDetail | null }) {
  const raindrop = candidate?.evidence?.raindropEventIds ?? [];
  const cited = proposal.citedRunIds.length ? proposal.citedRunIds : (candidate?.evidence?.runIds ?? []);
  return (
    <div className="space-y-3">
      <Provenance value={proposal.provenance} />
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={rsiTone(proposal.verdict)} pulse={proposal.verdict === 'pending'} className="px-2 py-1 text-[12px]">
          {upper(proposal.verdict ?? 'no verdict')}
        </StatusPill>
        <span className="font-mono text-[11.5px] text-plant-300">
          {proposal.fromVersion !== undefined ? `v${proposal.fromVersion}` : 'v?'} →{' '}
          {proposal.candidateVersion !== undefined ? `candidate v${proposal.candidateVersion}` : proposal.change === false ? 'no candidate (no change proposed)' : 'no candidate'}
        </span>
        <span className="ml-auto font-mono text-[10.5px] text-plant-500">{fmtDateTime(proposal.createdAt)}</span>
      </div>

      {proposal.rationale && (
        <div>
          <SectionLabel>Failure pattern & rationale</SectionLabel>
          <p className="text-[12.5px] leading-relaxed text-plant-200">{proposal.rationale}</p>
        </div>
      )}
      {proposal.expectedEffect && (
        <p className="text-[12px] text-plant-300">
          <span className="font-display text-[10px] font-semibold uppercase tracking-[0.14em] text-plant-400">Expected effect · </span>
          {proposal.expectedEffect}
        </p>
      )}

      <div>
        <SectionLabel>Harness config diff</SectionLabel>
        {proposal.diff.length ? <DiffLines lines={proposal.diff} /> : <EmptyState>No config change</EmptyState>}
      </div>

      {proposal.guardrailViolations.length > 0 && (
        <div className="rounded-md border border-stop-500/50 bg-stop-500/[0.07] px-3 py-2">
          <div className="mb-1 flex items-center gap-1.5 font-mono text-[11px] font-medium uppercase tracking-wider text-stop-300">
            <ShieldAlert className="size-3.5" aria-hidden /> Guardrail violations
          </div>
          <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-stop-300">
            {proposal.guardrailViolations.map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ul>
        </div>
      )}

      {candidate && (candidate.scores || candidate.parentScores) && (
        <div>
          <SectionLabel>Benchmark gate · parent vs candidate</SectionLabel>
          <ScoresTable candidate={candidate} parentVersion={candidate.parent} />
          {candidate.gateNote && <p className="mt-1.5 font-mono text-[11px] text-plant-400">{candidate.gateNote}</p>}
        </div>
      )}

      <div className="space-y-2">
        <div>
          <SectionLabel>Cited runs</SectionLabel>
          {cited.length ? (
            <div className="flex flex-wrap gap-1.5">
              {cited.map((id) => (
                <CodeChip key={id} value={id} label={shortId(id, 10)} />
              ))}
            </div>
          ) : (
            <EmptyState>No runs cited</EmptyState>
          )}
        </div>
        <div>
          <SectionLabel>Raindrop events</SectionLabel>
          {raindrop.length ? (
            <div className="flex flex-wrap gap-1.5">
              {raindrop.map((id) => (
                <CodeChip key={id} value={id} label={shortId(id, 12)} />
              ))}
            </div>
          ) : (
            <EmptyState>No Raindrop event ids recorded</EmptyState>
          )}
        </div>
        {proposal.benchmarkIds.length > 0 && (
          <p className="font-mono text-[11px] text-plant-400">{proposal.benchmarkIds.length} benchmark run(s) behind this decision</p>
        )}
      </div>
    </div>
  );
}

export function RsiCard({ data, children }: { data: RsiData | null; children?: React.ReactNode }) {
  const [showRules, setShowRules] = React.useState(false);
  const active = data?.active ?? null;
  return (
    <Panel
      index="04"
      title="Self-Improvement (RSI)"
      icon={<BrainCircuit />}
      right={active ? <StatusPill tone="meta">active v{active.version}</StatusPill> : undefined}
      bodyClassName="space-y-5"
    >
      {children ?? (
        <>
          <div>
            <SectionLabel>Active harness</SectionLabel>
            {active ? (
              <div className="rounded-md border border-meta-400/40 bg-meta-400/[0.06] px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-xl font-bold text-meta-300">v{active.version}</span>
                  <StatusPill tone="good">KEPT</StatusPill>
                  {active.parent !== undefined && <span className="font-mono text-[11px] text-plant-400">parent v{active.parent}</span>}
                  <span className="ml-auto font-mono text-[10.5px] text-plant-500">{fmtDateTime(active.decidedAt ?? active.createdAt)}</span>
                </div>
                {active.rationale && <p className="mt-1 line-clamp-3 text-[12px] text-plant-300">{active.rationale}</p>}
                <button
                  type="button"
                  onClick={() => setShowRules((v) => !v)}
                  aria-expanded={showRules}
                  className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] text-meta-300 hover:text-meta-400"
                >
                  {showRules ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
                  {active.rules.length} engineering rule{active.rules.length === 1 ? '' : 's'} · {active.settings.length} setting group(s)
                </button>
                {showRules && (
                  <div className="mt-1.5 space-y-2">
                    {active.rules.length > 0 && (
                      <ol className="list-decimal space-y-1 pl-5 text-[12px] text-plant-200">
                        {active.rules.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ol>
                    )}
                    {active.settings.map((s) => (
                      <div key={s.section} className="font-mono text-[11px]">
                        <span className="text-plant-400">{s.section}:</span>{' '}
                        <span className="text-plant-200">
                          {Object.entries(s.values)
                            .map(([k, v]) => `${k}=${v}`)
                            .join(' · ')}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <EmptyState>No kept harness version in Atlas</EmptyState>
            )}
          </div>

          <div>
            <SectionLabel right={data ? <span className="font-mono">{data.proposalCount} proposal(s)</span> : undefined}>
              Latest proposal
            </SectionLabel>
            {data?.latestProposal ? (
              <ProposalView proposal={data.latestProposal} candidate={data.candidate} />
            ) : (
              <EmptyState>No RSI proposals yet</EmptyState>
            )}
          </div>

          <div>
            <SectionLabel right={data ? <span className="font-mono">{data.versions.length} version(s)</span> : undefined}>
              Harness history
            </SectionLabel>
            {data && data.versions.length ? (
              <ol className="max-h-64 space-y-1 overflow-y-auto pr-1">
                {data.versions.map((v) => (
                  <li key={v.version} className="flex items-start gap-2 rounded border border-plant-800 bg-plant-900/50 px-2 py-1.5">
                    <span className="w-9 shrink-0 font-mono text-[12px] font-medium text-plant-100">v{v.version}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11.5px] text-plant-300" title={v.rationale}>
                        {v.rationale ?? <span className="text-plant-500">(no rationale)</span>}
                      </span>
                      <span className="block font-mono text-[10px] text-plant-500">
                        {v.parent !== undefined ? `from v${v.parent} · ` : 'baseline · '}
                        {v.rulesCount} rules{v.hasScores ? ' · scored' : ''} · {fmtDateTime(v.createdAt)}
                      </span>
                    </span>
                    <StatusPill tone={rsiTone(v.verdict)} pulse={v.verdict === 'pending'}>
                      {upper(v.verdict ?? 'no verdict')}
                    </StatusPill>
                  </li>
                ))}
              </ol>
            ) : (
              <EmptyState>No harness versions in Atlas</EmptyState>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}
