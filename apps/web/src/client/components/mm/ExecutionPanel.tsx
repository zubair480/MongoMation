import * as React from 'react';
import { Workflow } from 'lucide-react';
import { DISPLAY_STAGES, STAGE_LABELS, summarizeStages, type EventLite, type ProjectDetail, type StageLite } from '@/shared/mongomation';
import { cn } from '@/client/lib/utils';
import { fmtClock, fmtDuration, shortId, upper } from '@/client/lib/format';
import { liveAge, useNow } from '@/client/lib/now';
import { TONE_DOT, projectTone, stageTone } from '@/client/lib/tones';
import { CodeChip, EmptyState, Panel, SectionLabel, StatusPill } from './ui';

const NODE: Record<string, string> = {
  running: 'border-flow-400 bg-flow-400/20 text-flow-300 shadow-[0_0_14px_-2px_var(--color-flow-400)]',
  done: 'border-go-500 bg-go-500/20 text-go-300',
  failed: 'border-stop-500 bg-stop-500/20 text-stop-300',
  blocked: 'border-caution-400 bg-caution-400/15 text-caution-300',
  pending: 'border-plant-600 bg-plant-900 text-plant-500',
};

function StageRow({ index, label, raw, docs, receivedAt, last }: { index: number; label: string; raw: string[]; docs: StageLite[]; receivedAt: number; last: boolean }) {
  const now = useNow();
  const s = summarizeStages(docs);
  // Running stages: duration keeps growing between polls.
  const duration = s.status === 'running' ? liveAge(s.durationMs, receivedAt, now) : s.durationMs;
  const node = NODE[s.status] ?? NODE.pending;
  return (
    <li className="relative flex gap-3 pb-3">
      {!last && (
        <span
          className={cn('absolute left-[13px] top-7 h-[calc(100%-1.5rem)] w-px', s.status === 'done' ? 'bg-go-500/50' : 'bg-plant-700')}
          aria-hidden
        />
      )}
      <span
        className={cn(
          'relative z-10 mt-0.5 flex size-[27px] shrink-0 items-center justify-center rounded-full border font-mono text-[11px] font-semibold',
          node,
          s.status === 'running' && 'animate-pulse-dot'
        )}
      >
        {String(index + 1).padStart(2, '0')}
      </span>
      <div className="min-w-0 flex-1 rounded-md border border-plant-700/80 bg-plant-900/50 px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-display text-[13.5px] font-semibold tracking-wide text-plant-50">{label}</span>
          <StatusPill tone={stageTone(s.status)} pulse={s.status === 'running'}>
            {s.status === 'pending' ? 'not started' : upper(s.status)}
          </StatusPill>
          <span className="ml-auto flex items-center gap-3 font-mono text-[11px] tabular-nums text-plant-400">
            {s.attempts > 0 && (
              <span title={`${s.runs} execution(s) incl. resumes; latest attempt #${s.latestAttempt}`}>
                {s.attempts === 1 ? '1 attempt' : `${s.attempts} attempts`}
              </span>
            )}
            {duration !== undefined && <span>{fmtDuration(duration)}</span>}
            {s.startedAt && <span className="hidden sm:inline">{fmtClock(s.startedAt)}</span>}
          </span>
        </div>
        {raw.length > 1 && (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {raw.map((r) => {
              const sub = summarizeStages(docs.filter((d) => d.stage === r));
              return (
                <span key={r} className="inline-flex items-center gap-1 font-mono text-[10.5px] text-plant-400">
                  <span className={cn('size-1.5 rounded-full', TONE_DOT[stageTone(sub.status)])} aria-hidden />
                  {STAGE_LABELS[r] ?? r}
                  {sub.status !== 'pending' ? ` · ${sub.status}` : ' · not run'}
                </span>
              );
            })}
          </div>
        )}
        {s.error && (
          <p className="mt-1.5 line-clamp-4 break-words rounded border border-stop-500/30 bg-stop-500/[0.06] px-2 py-1 font-mono text-[11px] leading-snug text-stop-300" title={s.error}>
            {s.error}
          </p>
        )}
      </div>
    </li>
  );
}

const LEVEL_STYLE: Record<string, string> = {
  info: 'text-plant-400',
  warn: 'text-caution-300',
  error: 'text-stop-300',
};

type LevelFilter = 'all' | 'warn' | 'error';

function EventLog({ events }: { events: EventLite[] }) {
  const [filter, setFilter] = React.useState<LevelFilter>('all');
  const shown = events.filter((e) =>
    filter === 'all' ? true : filter === 'warn' ? e.level === 'warn' || e.level === 'error' : e.level === 'error'
  );
  return (
    <div>
      <SectionLabel
        right={
          <span className="flex items-center gap-1" role="group" aria-label="Filter events by level">
            {(['all', 'warn', 'error'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                className={cn(
                  'rounded px-1.5 py-0.5 font-mono text-[10.5px] uppercase',
                  filter === f ? 'bg-plant-700 text-plant-50' : 'text-plant-400 hover:text-plant-200'
                )}
              >
                {f === 'all' ? 'all' : f === 'warn' ? 'warn+' : 'errors'}
              </button>
            ))}
          </span>
        }
      >
        Event log · latest {events.length}
      </SectionLabel>
      {shown.length === 0 ? (
        <EmptyState>{events.length ? 'No events at this level' : 'No events yet for this project'}</EmptyState>
      ) : (
        <ol className="max-h-[440px] overflow-y-auto rounded-md border border-plant-700 bg-plant-950/70 font-mono text-[11.5px]">
          {shown.map((e) => (
            <li key={e.id} className="grid grid-cols-[4.6rem_3.2rem_minmax(0,1fr)] gap-2 border-b border-plant-800/80 px-2.5 py-1 last:border-0">
              <span className="tabular-nums text-plant-500">{fmtClock(e.ts)}</span>
              <span className={cn('uppercase', LEVEL_STYLE[e.level ?? 'info'] ?? 'text-plant-400')}>{e.level ?? '—'}</span>
              <span className="min-w-0 break-words text-plant-200">
                {e.stage && <span className="mr-1.5 text-flow-300/80">[{e.stage}]</span>}
                {e.message}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function ExecutionPanel({
  projectId,
  project,
  stages,
  events,
  receivedAt,
  children,
}: {
  projectId: string | null;
  project: ProjectDetail | null;
  stages: StageLite[];
  events: EventLite[];
  receivedAt: number;
  /** Rendered instead of the pipeline when the project query is loading / disconnected. */
  children?: React.ReactNode;
}) {
  return (
    <Panel
      index="02"
      title="Engineering Execution"
      icon={<Workflow />}
      right={
        projectId ? (
          <>
            <CodeChip value={projectId} label={shortId(projectId, 8)} />
            {project?.status && (
              <StatusPill tone={projectTone(project.status)} pulse={project.status === 'running'}>
                {upper(project.status)}
              </StatusPill>
            )}
          </>
        ) : undefined
      }
      bodyClassName="space-y-5"
    >
      {children ? (
        children
      ) : !projectId ? (
        <EmptyState>No runs yet · the pipeline appears here when the worker starts a project</EmptyState>
      ) : (
        <>
          <div>
            <SectionLabel
              right={
                project ? (
                  <span className="font-mono">
                    {project.harnessVersion !== undefined ? `harness v${project.harnessVersion}` : ''}
                    {project.attempts !== undefined ? ` · ${project.attempts} attempt(s)` : ''}
                  </span>
                ) : (
                  <span className="font-mono text-caution-300">project document not found</span>
                )
              }
            >
              Pipeline · stage checkpoints in Atlas
            </SectionLabel>
            <ol>
              {DISPLAY_STAGES.map((d, i) => (
                <StageRow
                  key={d.key}
                  index={i}
                  label={d.label}
                  raw={d.raw}
                  docs={stages.filter((s) => d.raw.includes(s.stage))}
                  receivedAt={receivedAt}
                  last={i === DISPLAY_STAGES.length - 1}
                />
              ))}
            </ol>
          </div>
          <EventLog events={events} />
        </>
      )}
    </Panel>
  );
}
