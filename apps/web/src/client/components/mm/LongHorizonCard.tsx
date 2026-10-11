import * as React from 'react';
import { toast } from 'react-hot-toast';
import { History, OctagonPause, RotateCcw } from 'lucide-react';
import {
  PIPELINE_STAGES,
  STAGE_LABELS,
  WORKER_STALE_MS,
  summarizeStages,
  type DashboardData,
  type JobCreated,
  type JobLite,
} from '@/shared/mongomation';
import { useJobMutation } from '@/client/lib/api';
import { cn } from '@/client/lib/utils';
import { fmtAge, fmtClock, shortId, upper } from '@/client/lib/format';
import { jobTone, stageTone } from '@/client/lib/tones';
import { CodeChip, EmptyState, KeyValue, Panel, SectionLabel, StatusPill, useLiveAge } from './ui';

function JobBlock({ job, active, receivedAt }: { job: JobLite; active: boolean; receivedAt: number }) {
  const beat = useLiveAge(job.heartbeatAgeMs, receivedAt);
  const stale = active && beat !== undefined && beat > WORKER_STALE_MS;
  return (
    <div className="rounded-md border border-plant-700 bg-plant-900/60 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-display text-[13px] font-semibold uppercase tracking-wide text-plant-100">{job.type.replace(/_/g, ' ')}</span>
        <StatusPill tone={stale ? 'warn' : jobTone(job.status)} pulse={active && !stale}>
          {upper(job.status)}
          {stale ? ' · stale' : ''}
        </StatusPill>
        <span className="ml-auto">
          <CodeChip value={job.id} label={shortId(job.id)} />
        </span>
      </div>
      {job.resumedFrom && (
        <div className="mt-2 flex items-center gap-2 rounded border border-flow-500/50 bg-flow-500/10 px-2 py-1 font-mono text-[11px] text-flow-300">
          <RotateCcw className="size-3.5" aria-hidden />
          RESUMED FROM MONGODB · previous claim by {job.resumedFrom}
          {job.interruptedAt ? ` · interrupted ${fmtClock(job.interruptedAt)}` : ''}
        </div>
      )}
      <div className="mt-1.5">
        <KeyValue label="Claimed by">
          <span className="font-mono">{job.claimedBy ?? '—'}</span>
        </KeyValue>
        <KeyValue label="Heartbeat">
          <span className={cn('font-mono', stale && 'text-caution-300')}>{beat === undefined ? '—' : `${fmtAge(beat)} ago`}</span>
        </KeyValue>
        <KeyValue label="Attempts">
          <span className="font-mono">{job.attempts ?? '—'}</span>
        </KeyValue>
        <KeyValue label="Started · finished">
          <span className="font-mono">
            {fmtClock(job.startedAt)} · {fmtClock(job.finishedAt)}
          </span>
        </KeyValue>
        {job.projectId && (
          <KeyValue label="Project">
            <span className="font-mono">{shortId(job.projectId, 8)}</span>
          </KeyValue>
        )}
      </div>
      {job.error && <p className="mt-1 line-clamp-3 break-words font-mono text-[11px] text-stop-300">{job.error}</p>}
    </div>
  );
}

export function LongHorizonCard({
  dash,
  receivedAt,
  signedIn,
  children,
}: {
  dash: DashboardData | null;
  receivedAt: number;
  signedIn: boolean;
  /** Rendered instead of the content when the dashboard query is loading / disconnected. */
  children?: React.ReactNode;
}) {
  const interrupt = useJobMutation<Record<string, never>, JobCreated>('interruptWorker');
  const resume = useJobMutation<Record<string, never>, JobCreated>('resumeWorker');
  const worker = dash?.workers[0];
  const workerAge = useLiveAge(worker?.heartbeatAgeMs, receivedAt);
  const command = dash?.latestJobs.command ?? null;
  const commandAge = useLiveAge(command?.createdAgeMs, receivedAt);
  const job = dash?.activeJob ?? dash?.lastJob ?? null;
  const active = !!dash?.activeJob;

  const checkpoints = dash?.checkpoints ?? [];
  const rows = PIPELINE_STAGES.map((stage) => ({ stage, summary: summarizeStages(checkpoints.filter((c) => c.stage === stage)) }));
  const done = rows.filter((r) => r.summary.status === 'done').length;

  return (
    <Panel index="05" title="Long-Horizon" icon={<History />} bodyClassName="space-y-4">
      {children ?? (
        <>
          <div>
            <SectionLabel>Worker</SectionLabel>
            {worker ? (
              <div className="rounded-md border border-plant-700 bg-plant-900/60 px-3 py-1.5">
                <KeyValue label="Id">
                  <span className="font-mono">{worker.id}</span>
                </KeyValue>
                <KeyValue label="Host · pid">
                  <span className="font-mono">
                    {worker.host ?? '—'} · {worker.pid ?? '—'}
                  </span>
                </KeyValue>
                <KeyValue label="Heartbeat">
                  <StatusPill
                    tone={workerAge !== undefined && workerAge < WORKER_STALE_MS ? 'good' : 'warn'}
                    pulse={workerAge !== undefined && workerAge < WORKER_STALE_MS}
                  >
                    {workerAge === undefined ? 'none' : `${fmtAge(workerAge)} ago`}
                  </StatusPill>
                </KeyValue>
                <KeyValue label="Current job">
                  <span className="font-mono">{worker.currentJobId ? shortId(worker.currentJobId) : 'idle'}</span>
                </KeyValue>
                {dash && dash.workers.length > 1 && (
                  <p className="pt-1 font-mono text-[10.5px] text-plant-500">+{dash.workers.length - 1} more worker record(s)</p>
                )}
              </div>
            ) : (
              <EmptyState>No worker has registered a heartbeat</EmptyState>
            )}
          </div>

          <div>
            <SectionLabel right={dash ? <span className="font-mono">{dash.queuedCount} queued</span> : undefined}>
              {active ? 'Current job' : 'Last job'}
            </SectionLabel>
            {job ? <JobBlock job={job} active={active} receivedAt={receivedAt} /> : <EmptyState>No jobs yet</EmptyState>}
          </div>

          <div>
            <SectionLabel
              right={
                dash?.checkpointProjectId ? (
                  <span className="font-mono">
                    {done}/{PIPELINE_STAGES.length} done · {shortId(dash.checkpointProjectId, 8)}
                  </span>
                ) : undefined
              }
            >
              Stage checkpoints in Atlas
            </SectionLabel>
            {!dash?.checkpointProjectId ? (
              <EmptyState>No checkpoints · no job has started a project</EmptyState>
            ) : (
              <ol className="overflow-hidden rounded-md border border-plant-700">
                {rows.map(({ stage, summary }) => (
                  <li key={stage} className="flex items-center gap-2 border-b border-plant-800 px-2.5 py-1 last:border-0">
                    <span className="w-32 shrink-0 truncate text-[12px] text-plant-200">{STAGE_LABELS[stage] ?? stage}</span>
                    <StatusPill tone={stageTone(summary.status)} pulse={summary.status === 'running'}>
                      {summary.status === 'pending' ? 'pending' : upper(summary.status)}
                    </StatusPill>
                    <span className="ml-auto truncate text-right font-mono text-[10.5px] text-plant-500">
                      {summary.latestAttempt !== undefined ? `#${summary.latestAttempt} · ` : ''}
                      {summary.startedAt ? fmtClock(summary.startedAt) : ''}
                      {summary.finishedAt ? ` → ${fmtClock(summary.finishedAt)}` : ''}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={!signedIn || interrupt.isPending}
                onClick={() =>
                  interrupt.mutate({}, { onSuccess: (r) => toast.success(`Interrupt requested (job ${shortId(r.jobId)})`) })
                }
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-stop-500/70 bg-stop-500/10 font-display text-[13px] font-semibold uppercase tracking-[0.06em] text-stop-300 transition-colors hover:bg-stop-500/20 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <OctagonPause className="size-4" aria-hidden />
                {interrupt.isPending ? 'Sending…' : 'Interrupt Worker'}
              </button>
              <button
                type="button"
                disabled={!signedIn || resume.isPending}
                onClick={() => resume.mutate({}, { onSuccess: (r) => toast.success(`Resume requested (job ${shortId(r.jobId)})`) })}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-go-500/70 bg-go-500/10 font-display text-[13px] font-semibold uppercase tracking-[0.06em] text-go-300 transition-colors hover:bg-go-500/20 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <RotateCcw className="size-4" aria-hidden />
                {resume.isPending ? 'Sending…' : 'Resume from MongoDB'}
              </button>
            </div>
            {!signedIn && <p className="text-[12px] text-plant-400">Sign in to send worker commands.</p>}
            {command ? (
              <p className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-plant-400">
                last command: <span className="text-plant-200">{command.command ?? 'unknown'}</span>
                <StatusPill tone={jobTone(command.status)} pulse={command.status === 'queued'}>
                  {upper(command.status)}
                </StatusPill>
                {command.handledBy ? `handled by ${command.handledBy}` : ''} · {fmtAge(commandAge)} ago
              </p>
            ) : (
              <p className="font-mono text-[11px] text-plant-500">No worker commands sent yet</p>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}
