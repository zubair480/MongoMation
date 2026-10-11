import * as React from 'react';
import { ChevronDown, ChevronRight, ClipboardCheck, EyeOff, Lock } from 'lucide-react';
import type { CompileLite, ProjectData, SceneTagLite, TestLite } from '@/shared/mongomation';
import { cn } from '@/client/lib/utils';
import { fmtDuration, shortId, upper } from '@/client/lib/format';
import { compileTone, projectTone, requirementTone, testTone } from '@/client/lib/tones';
import { CodeChip, EmptyState, Metric, Panel, SectionLabel, StatusPill } from './ui';
import { PlcProgram } from './PlcProgram';
import { TestTimeline } from './TestTimeline';

function CompileRow({ title, result }: { title: string; result: CompileLite | undefined }) {
  const [open, setOpen] = React.useState(false);
  const tone = compileTone(result);
  const label = !result
    ? 'not run'
    : result.status ?? (result.ok === undefined ? 'unknown' : result.ok ? 'ok' : 'failed');
  return (
    <div className="rounded-md border border-plant-700 bg-plant-900/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!result?.log}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left disabled:cursor-default"
        aria-expanded={open}
      >
        {result?.log ? (
          open ? <ChevronDown className="size-3.5 text-plant-400" aria-hidden /> : <ChevronRight className="size-3.5 text-plant-400" aria-hidden />
        ) : (
          <span className="size-3.5" />
        )}
        <span className="flex-1 text-[12.5px] text-plant-100">{title}</span>
        {result?.toolchain && <span className="hidden font-mono text-[10.5px] text-plant-500 sm:inline">{result.toolchain}</span>}
        {result?.durationMs !== undefined && <span className="font-mono text-[11px] text-plant-400">{fmtDuration(result.durationMs)}</span>}
        <StatusPill tone={tone}>{upper(label)}</StatusPill>
      </button>
      {open && result?.log && (
        <pre className="max-h-56 overflow-auto border-t border-plant-700 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-plant-300">
          {result.logTruncated ? '…(earlier output truncated)\n' : ''}
          {result.log}
        </pre>
      )}
    </div>
  );
}

function TestRow({
  test,
  open,
  onToggle,
  simRunId,
  live,
  sceneTags,
}: {
  test: TestLite;
  open: boolean;
  onToggle: () => void;
  simRunId: string | undefined;
  live: boolean;
  sceneTags: SceneTagLite[];
}) {
  const hidden = test.visibility === 'hidden';
  return (
    <li className={cn('rounded-md border', open ? 'border-flow-500/50 bg-plant-900' : 'border-plant-700 bg-plant-900/60')}>
      <button
        type="button"
        onClick={onToggle}
        disabled={hidden || !test.testId}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left disabled:cursor-default"
        title={hidden ? 'Hidden regression test: its steps and measurements are never shown' : 'Show the measured timeline'}
      >
        {hidden ? (
          <Lock className="size-3.5 shrink-0 text-plant-500" aria-hidden />
        ) : open ? (
          <ChevronDown className="size-3.5 shrink-0 text-flow-300" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-plant-400" aria-hidden />
        )}
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-[12.5px]', hidden ? 'text-plant-300 italic' : 'text-plant-100')}>{test.title}</span>
          <span className="block truncate font-mono text-[10.5px] text-plant-500">
            {hidden ? 'hidden' : test.testId}
            {!hidden && test.category ? ` · ${test.category}` : ''}
            {test.requirementIds.length ? ` · ${test.requirementIds.join(', ')}` : ''}
            {test.sampleCount !== undefined ? ` · ${test.sampleCount} samples` : ''}
          </span>
        </span>
        {test.durationMs !== undefined && <span className="font-mono text-[11px] text-plant-400">{fmtDuration(test.durationMs)}</span>}
        <StatusPill tone={testTone(test.verdict)}>{upper(test.verdict ?? 'no verdict')}</StatusPill>
      </button>
      {test.verdict === 'blocked' && test.blockedReason && (
        <p className="px-8 pb-1.5 font-mono text-[11px] text-caution-300">BLOCKED: {test.blockedReason}</p>
      )}
      {open && simRunId && (
        <div className="border-t border-plant-700 p-2.5">
          <TestTimeline test={test} simRunId={simRunId} live={live} sceneTags={sceneTags} />
        </div>
      )}
    </li>
  );
}

export function ResultsCard({
  data,
  sceneTags,
  children,
}: {
  data: ProjectData | null;
  sceneTags: SceneTagLite[];
  /** Rendered instead of the content when the project query is loading / disconnected / absent. */
  children?: React.ReactNode;
}) {
  const [openTest, setOpenTest] = React.useState<string | null>(null);
  const project = data?.project ?? null;

  const preflight = data?.compiles.find((c) => c.stage === 'preflight');
  const compile = data?.compiles.find((c) => c.stage === 'compile');
  const simRun = data?.simRun ?? null;
  const live = simRun?.status === 'running';
  const counts = data?.testCounts;
  const requirementText = new Map((data?.requirements?.items ?? []).map((r) => [r.id, r]));
  const verdictIds = new Set((data?.verdicts ?? []).map((v) => v.requirementId));
  const unsupportedOnly = (project?.unsupported ?? []).filter((u) => u.id && !verdictIds.has(u.id));

  return (
    <Panel
      index="03"
      title="Engineering Results"
      icon={<ClipboardCheck />}
      right={
        project?.status ? (
          <StatusPill tone={projectTone(project.status)} pulse={project.status === 'running'}>
            {upper(project.status)}
          </StatusPill>
        ) : undefined
      }
      bodyClassName="space-y-5"
    >
      {children ?? (
        <>
          {/* PLC program */}
          <div>
            <SectionLabel right={data && data.plcVersions.length > 0 ? <span className="font-mono">{data.plcVersions.length} version(s)</span> : undefined}>
              PLC program · Structured Text
            </SectionLabel>
            <PlcProgram key={project?.id ?? 'none'} versions={data?.plcVersions ?? []} />
          </div>

          {/* Compile */}
          <div>
            <SectionLabel
              right={data?.plcVersions[0] ? <span className="font-mono">for v{data.plcVersions[0].version ?? '?'}</span> : undefined}
            >
              Compilation
            </SectionLabel>
            {data?.plcVersions.length ? (
              <div className="space-y-1.5">
                <CompileRow title="Preflight · MatIEC iec2c" result={preflight} />
                <CompileRow title="OpenPLC compile" result={compile} />
              </div>
            ) : (
              <EmptyState>No program to compile yet</EmptyState>
            )}
          </div>

          {/* Tests */}
          <div>
            <SectionLabel
              right={
                simRun ? (
                  <span className="flex items-center gap-1.5 font-mono">
                    run <CodeChip value={simRun.id} label={shortId(simRun.id)} />
                    <StatusPill tone={live ? 'active' : simRun.status === 'done' ? 'good' : 'muted'} pulse={live}>
                      {upper(simRun.status ?? 'unknown')}
                    </StatusPill>
                  </span>
                ) : undefined
              }
            >
              Independent tests
            </SectionLabel>
            {!simRun ? (
              <EmptyState>No simulation run yet</EmptyState>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-4 gap-2">
                  <Metric label="Passed" value={counts?.passed ?? '—'} tone={counts?.passed ? 'good' : undefined} />
                  <Metric label="Failed" value={counts?.failed ?? '—'} tone={counts?.failed ? 'bad' : undefined} />
                  <Metric label="Blocked" value={counts?.blocked ?? '—'} tone={counts?.blocked ? 'warn' : undefined} />
                  <Metric label="Results" value={counts?.total ?? '—'} />
                </div>
                {simRun.faultId && (
                  <p className="font-mono text-[11px] text-caution-300">Run under injected fault: {simRun.faultId}</p>
                )}
                {data && data.tests.length === 0 ? (
                  <EmptyState>{live ? 'Tests are running · no results stored yet' : 'No test results stored for this run'}</EmptyState>
                ) : (
                  <ul className="space-y-1.5">
                    {data?.tests.map((t) => (
                      <TestRow
                        key={t.id}
                        test={t}
                        open={openTest === t.id}
                        onToggle={() => setOpenTest((cur) => (cur === t.id ? null : t.id))}
                        simRunId={t.simRunId ?? simRun.id}
                        live={live}
                        sceneTags={sceneTags}
                      />
                    ))}
                  </ul>
                )}
                {data?.tests.some((t) => t.visibility === 'hidden') && (
                  <p className="flex items-center gap-1.5 text-[11px] text-plant-500">
                    <EyeOff className="size-3" aria-hidden /> Hidden regression tests show category and verdict only.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Requirement verdicts */}
          <div>
            <SectionLabel
              right={
                data?.verdictSource ? (
                  <span className={cn('font-mono', data.verdictSource.kind === 'sim_run' && !data.verdictSource.latestRun && 'text-caution-300')}>
                    {data.verdictSource.kind === 'project'
                      ? 'final verification'
                      : data.verdictSource.latestRun
                        ? 'from sim run'
                        : 'from previous sim run'}
                    {data.verdictSource.simRunId ? ` ${shortId(data.verdictSource.simRunId)}` : ''}
                    {data.verdictSource.kind === 'sim_run' && !data.verdictSource.latestRun ? ' · newest run in progress' : ''}
                  </span>
                ) : undefined
              }
            >
              Requirement verdicts
            </SectionLabel>
            {data && (data.verdicts.length > 0 || unsupportedOnly.length > 0) ? (
              <div className="overflow-hidden rounded-md border border-plant-700">
                <table className="w-full text-left text-[12px]">
                  <thead className="bg-plant-850 font-display text-[10px] uppercase tracking-[0.12em] text-plant-400">
                    <tr>
                      <th className="px-2.5 py-1.5 font-semibold">Req</th>
                      <th className="px-2.5 py-1.5 font-semibold">Requirement</th>
                      <th className="px-2.5 py-1.5 text-right font-semibold">Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.verdicts.map((v) => {
                      const req = requirementText.get(v.requirementId);
                      return (
                        <tr key={v.requirementId} className="border-t border-plant-800 align-top">
                          <td className="px-2.5 py-1.5 font-mono text-plant-200">{v.requirementId}</td>
                          <td className="px-2.5 py-1.5 text-plant-300">
                            {req?.text ?? <span className="text-plant-500">(requirement text not stored)</span>}
                            {(v.detail || v.testIds.length > 0) && (
                              <span className="mt-0.5 block font-mono text-[10.5px] text-plant-500">
                                {v.testIds.length ? `tests: ${v.testIds.join(', ')}` : ''}
                                {v.detail ? `${v.testIds.length ? ' · ' : ''}${v.detail}` : ''}
                              </span>
                            )}
                          </td>
                          <td className="px-2.5 py-1.5 text-right">
                            <StatusPill tone={requirementTone(v.status)}>{upper(v.status ?? 'no verdict')}</StatusPill>
                          </td>
                        </tr>
                      );
                    })}
                    {unsupportedOnly.map((u) => (
                      <tr key={u.id} className="border-t border-plant-800 align-top">
                        <td className="px-2.5 py-1.5 font-mono text-plant-200">{u.id}</td>
                        <td className="px-2.5 py-1.5 text-plant-300">
                          {requirementText.get(u.id ?? '')?.text ?? ''}
                          {u.reason && <span className="mt-0.5 block font-mono text-[10.5px] text-plant-500">{u.reason}</span>}
                        </td>
                        <td className="px-2.5 py-1.5 text-right">
                          <StatusPill tone="muted">UNSUPPORTED</StatusPill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : data?.requirements?.items.length ? (
              <div className="space-y-1.5">
                <EmptyState>No verdicts yet · requirements extracted, awaiting tests</EmptyState>
                <ul className="space-y-1">
                  {data.requirements.items.map((r) => (
                    <li key={r.id} className="flex items-start gap-2 text-[12px]">
                      <span className="font-mono text-plant-200">{r.id}</span>
                      <span className="flex-1 text-plant-300">{r.text}</span>
                      {r.support === 'unsupported' && <StatusPill tone="muted">UNSUPPORTED</StatusPill>}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <EmptyState>No requirements extracted yet</EmptyState>
            )}
          </div>

          {/* Diagnosis */}
          {data?.diagnosis && (
            <div>
              <SectionLabel
                right={data.diagnosis.traceId ? <CodeChip value={data.diagnosis.traceId} label={`trace ${shortId(data.diagnosis.traceId, 8)}`} /> : undefined}
              >
                Latest diagnosis
              </SectionLabel>
              <div className="space-y-1.5 rounded-md border border-plant-700 bg-plant-900/60 px-3 py-2">
                {data.diagnosis.summary && <p className="text-[12.5px] text-plant-200">{data.diagnosis.summary}</p>}
                {data.diagnosis.causes.map((c, i) => (
                  <p key={i} className="text-[12px] text-plant-300">
                    <span className="font-mono text-plant-100">{c.requirementId ?? '?'}</span>: {c.cause}
                    {c.fix && <span className="text-go-300"> → {c.fix}</span>}
                  </p>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
