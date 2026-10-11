import * as React from 'react';
import { BellRing, MessageSquareText, Radio, Sparkles, Trash2 } from 'lucide-react';
import { NOTE_MAX_CHARS, type NotesData, type OpsData } from '@/shared/insights';
import { cn } from '@/client/lib/utils';
import { fmtAge, fmtClock, fmtDateTime } from '@/client/lib/format';
import { useAppMutation, useLiveEvents } from '@/client/lib/insights';
import { useNow } from '@/client/lib/now';
import { EmptyState, Metric, Panel, SectionLabel, StatusPill } from './ui';

// ---- ops: alerts + digest written by Modelence cron jobs -----------------------------------------------

export function OpsCard({ data, children }: { data: OpsData | null; children?: React.ReactNode }) {
  const ack = useAppMutation<{ alertId: string }>('acknowledgeAlert');
  const now = useNow();
  const open = data?.alerts.filter((a) => !a.resolvedAt) ?? [];
  return (
    <Panel
      title="Ops watch"
      icon={<BellRing />}
      right={
        data?.available ? (
          <StatusPill tone={open.some((a) => a.severity === 'critical') ? 'bad' : open.length ? 'warn' : 'good'}>
            {open.length ? `${open.length} open` : 'all clear'}
          </StatusPill>
        ) : undefined
      }
    >
      {children ??
        (data && !data.available ? (
          <EmptyState tone="warn">Cron jobs and stores are off · {data.reason}</EmptyState>
        ) : data ? (
          <div className="space-y-4">
            {data.alerts.length ? (
              <ul className="space-y-1.5">
                {data.alerts.slice(0, 8).map((a) => (
                  <li
                    key={a.id}
                    className={cn('rounded-md border px-2.5 py-1.5 text-[12px]', a.resolvedAt ? 'border-plant-800 opacity-60' : 'border-plant-700 bg-plant-850/70')}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <StatusPill tone={a.resolvedAt ? 'muted' : a.severity === 'critical' ? 'bad' : a.severity === 'warn' ? 'warn' : 'info'}>
                        {a.resolvedAt ? 'resolved' : a.severity} · {a.kind.replace('_', ' ')}
                      </StatusPill>
                      <span className="font-mono text-[10px] text-plant-500">
                        {a.resolvedAt ? `closed ${fmtClock(new Date(a.resolvedAt))}` : `seen ${fmtAge(now - new Date(a.lastSeenAt).getTime())} ago`}
                      </span>
                    </div>
                    <p className="mt-1 text-plant-200">{a.message}</p>
                    {!a.resolvedAt && (
                      <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-plant-500">
                        <span>opened {fmtDateTime(new Date(a.openedAt))}</span>
                        {a.acknowledgedBy ? (
                          <span className="text-go-300">· ack by {a.acknowledgedBy}</span>
                        ) : data.canAcknowledge ? (
                          <button
                            type="button"
                            disabled={ack.isPending}
                            onClick={() => ack.mutate({ alertId: a.id })}
                            className="text-flow-300 hover:text-flow-400"
                          >
                            · acknowledge
                          </button>
                        ) : null}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState>No alerts · rig heartbeat, job heartbeats and queue are healthy</EmptyState>
            )}

            {data.digest && (
              <div>
                <SectionLabel right={<span className="font-mono text-[10px]">digest {fmtClock(new Date(data.digest.createdAt))}</span>}>
                  Last {data.digest.windowHours} h
                </SectionLabel>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Metric label="Jobs" value={data.digest.jobs.total} sub={`${data.digest.jobs.completed} done · ${data.digest.jobs.failed} failed`} />
                  <Metric
                    label="Tests"
                    value={data.digest.tests.total}
                    tone={data.digest.tests.failed ? 'warn' : 'good'}
                    sub={`${data.digest.tests.passed} passed`}
                  />
                  <Metric label="Samples" value={data.digest.samples.toLocaleString()} tone="active" />
                  <Metric label="Projects" value={data.digest.projects} />
                </div>
              </div>
            )}

            <div className="font-mono text-[10px] leading-relaxed text-plant-500">
              Modelence cron jobs: {data.crons.map((c) => `${c.alias.replace('mongomation.', '')} every ${Math.round(c.intervalMs / 1000)} s`).join(' · ')}
            </div>
          </div>
        ) : null)}
    </Panel>
  );
}

// ---- notes + AI explanation (Modelence Store + @modelence/ai) ------------------------------------------

export function NotesCard({ projectId, data, children }: { projectId: string | null; data: NotesData | null; children?: React.ReactNode }) {
  const [draft, setDraft] = React.useState('');
  const add = useAppMutation<{ projectId: string; body: string }>('addNote');
  const del = useAppMutation<{ noteId: string }>('deleteNote');
  const explain = useAppMutation<{ projectId: string }>('explainFailure');
  const canWrite = !!data?.available && data.viewer.signedIn;

  return (
    <Panel
      title="Operator notes"
      icon={<MessageSquareText />}
      right={
        data?.available && projectId ? (
          <button
            type="button"
            disabled={!canWrite || !data.ai.configured || explain.isPending}
            onClick={() => explain.mutate({ projectId })}
            title={
              !data.ai.configured
                ? `AI not configured: add a ${data.ai.provider === 'google' ? 'Gemini' : 'OpenAI'} key in Modelence Cloud → AI → Integrations`
                : !canWrite
                  ? 'Sign in to ask for an explanation'
                  : `Explain the failures with ${data.ai.provider} ${data.ai.model}`
            }
            className="inline-flex items-center gap-1.5 rounded border border-meta-500/50 px-2 py-1 font-mono text-[10.5px] uppercase tracking-wider text-meta-300 transition-colors enabled:hover:bg-meta-500/10 disabled:opacity-40"
          >
            <Sparkles className="size-3.5" aria-hidden />
            {explain.isPending ? 'Thinking…' : 'Explain failures'}
          </button>
        ) : undefined
      }
    >
      {children ??
        (data && !data.available ? (
          <EmptyState tone="warn">Notes are off · {data.reason}</EmptyState>
        ) : data ? (
          <div className="space-y-3">
            {canWrite ? (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!projectId || !draft.trim()) return;
                  add.mutate({ projectId, body: draft.trim() }, { onSuccess: () => setDraft('') });
                }}
              >
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value.slice(0, NOTE_MAX_CHARS))}
                  placeholder="Add a note for the team (shared live)"
                  aria-label="New note"
                  className="h-8 min-w-0 flex-1 rounded-md border border-plant-600 bg-plant-850 px-2.5 text-[12.5px] text-plant-100 placeholder:text-plant-500 focus:border-flow-400 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={add.isPending || !draft.trim()}
                  className="rounded-md border border-flow-500/60 px-3 text-[12px] text-flow-300 transition-colors enabled:hover:bg-flow-500/10 disabled:opacity-40"
                >
                  Post
                </button>
              </form>
            ) : (
              <p className="font-mono text-[10.5px] text-plant-500">Sign in with a verified email to add notes.</p>
            )}
            {data.items.length ? (
              <ul className="space-y-1.5">
                {data.items.map((n) => (
                  <li
                    key={n.id}
                    className={cn(
                      'rounded-md border px-2.5 py-1.5 text-[12.5px]',
                      n.kind === 'ai' ? 'border-meta-500/40 bg-meta-500/[0.06]' : 'border-plant-700 bg-plant-850/70',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-plant-500">
                      <span>
                        {n.kind === 'ai' ? `${n.provider} ${n.model} · asked by ` : ''}
                        {n.authorHandle} · {fmtDateTime(new Date(n.createdAt))}
                      </span>
                      {n.mine && (
                        <button type="button" aria-label="Delete note" onClick={() => del.mutate({ noteId: n.id })} className="hover:text-stop-300">
                          <Trash2 className="size-3" />
                        </button>
                      )}
                    </div>
                    <p className="mt-0.5 whitespace-pre-wrap text-plant-200">{n.body}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState>No notes on this project yet</EmptyState>
            )}
          </div>
        ) : null)}
    </Panel>
  );
}

// ---- live worker events over the Modelence channel ------------------------------------------------------

export function LiveEventStrip({ projectId }: { projectId: string | null }) {
  const { events, joined } = useLiveEvents(projectId);
  if (!projectId) return null;
  return (
    <div className="panel-surface flex min-w-0 items-center gap-3 rounded-lg px-3 py-2">
      <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-wider text-flow-300">
        <Radio className={cn('size-3.5', joined && 'animate-pulse-dot')} aria-hidden />
        worker push
      </span>
      <div className="min-w-0 flex-1 overflow-hidden">
        {events.length ? (
          <ul className="flex min-w-0 gap-4 overflow-x-auto whitespace-nowrap text-[12px]">
            {events.map((e, i) => (
              <li key={e.id} className={cn('flex items-center gap-1.5', i === 0 ? 'animate-rise text-plant-100' : 'text-plant-400')}>
                <span className="font-mono text-[10px] text-plant-500">{e.ts ? fmtClock(new Date(e.ts)) : ''}</span>
                {e.stage && <span className="font-mono text-[10px] uppercase text-meta-300">{e.stage}</span>}
                <span className="max-w-[38ch] truncate">{e.message}</span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="font-mono text-[10.5px] text-plant-500">
            Joined channel mm-events:{projectId.slice(-6)} · new worker events appear here the moment Atlas records them
          </span>
        )}
      </div>
    </div>
  );
}
