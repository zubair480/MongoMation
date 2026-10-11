import * as React from 'react';
import { toast } from 'react-hot-toast';
import { Cpu, FileDiff, FlaskConical, PlayCircle, Undo2 } from 'lucide-react';
import {
  ACTIVE_JOB_STATUSES,
  SPEC_MAX_CHARS,
  SPEC_MIN_CHARS,
  WORKER_STALE_MS,
  faultPreconditionFailures,
  sceneRunBlocker,
  type ChangeSpecArgs,
  type DashboardData,
  type ExampleCreated,
  type ExampleLite,
  type GenerateArgs,
  type InjectFaultArgs,
  type JobCreated,
  type JobLite,
  type ProjectDetail,
  type RunExampleArgs,
  type SceneLite,
} from '@/shared/mongomation';
import { useJobMutation } from '@/client/lib/api';
import { cn } from '@/client/lib/utils';
import { fmtAge, shortId, upper } from '@/client/lib/format';
import { liveAge, useNow } from '@/client/lib/now';
import { jobTone, type Tone } from '@/client/lib/tones';
import { StatusPill, Tip } from './ui';

/** `precondition` = BLOCKED by current state (the request would be refused), not a job outcome. */
type Chip = { label: string; tone: Tone; pulse?: boolean; detail?: string; precondition?: boolean };

/** Chip for an action: the latest job of its kind, or BLOCKED when a precondition fails. */
function chipFor(job: JobLite | null, blockers: string[], queuedCount: number | undefined, receivedAt: number, now: number): Chip {
  if (job && ACTIVE_JOB_STATUSES.includes(job.status)) {
    if (job.status === 'queued') {
      return {
        label: 'Queued',
        tone: 'info',
        pulse: true,
        detail: `waiting for a worker${queuedCount ? ` (${queuedCount} queued)` : ''}`,
      };
    }
    const beat = liveAge(job.heartbeatAgeMs, receivedAt, now);
    if (beat !== undefined && beat > WORKER_STALE_MS) {
      return {
        label: `${job.status} · stale`,
        tone: 'warn',
        detail: `no worker heartbeat for ${fmtAge(beat)}; the job is re-queued when a worker recovers it`,
      };
    }
    return { label: job.status, tone: 'active', pulse: true };
  }
  if (blockers.length) return { label: 'Blocked', tone: 'warn', detail: blockers.join('; '), precondition: true };
  if (job) return { label: job.status, tone: jobTone(job.status), detail: job.error };
  return { label: 'Available', tone: 'info' };
}

function ActionTile({
  icon,
  label,
  onClick,
  disabled,
  pending,
  chip,
  job,
  receivedAt,
  variant,
  disabledReason,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled: boolean;
  pending: boolean;
  chip: Chip;
  job: JobLite | null;
  receivedAt: number;
  variant: 'go' | 'neutral' | 'hazard';
  disabledReason?: string;
  children?: React.ReactNode;
}) {
  const now = useNow();
  const age = liveAge(job?.createdAgeMs, receivedAt, now);
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-plant-700 bg-plant-850/70 p-3">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || pending}
        className={cn(
          'relative inline-flex h-12 w-full items-center justify-center gap-2.5 overflow-hidden rounded-md px-4 font-display text-[15px] font-semibold uppercase tracking-[0.08em] transition-all',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flow-400 focus-visible:ring-offset-2 focus-visible:ring-offset-plant-900',
          'disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:size-5',
          variant === 'go' &&
            'bg-go-500 text-plant-950 shadow-[0_0_0_1px_rgb(0_0_0/0.3),0_8px_24px_-12px_var(--color-go-500)] hover:bg-go-400 enabled:active:translate-y-px',
          variant === 'neutral' && 'border border-plant-500 bg-plant-100 text-plant-950 hover:bg-white enabled:active:translate-y-px',
          variant === 'hazard' &&
            'border border-caution-400/70 bg-plant-900 text-caution-300 hover:bg-plant-800 enabled:active:translate-y-px'
        )}
      >
        {variant === 'hazard' && <span className="hazard absolute inset-y-0 left-0 w-2.5 opacity-80" aria-hidden />}
        {icon}
        {pending ? 'Sending…' : label}
      </button>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <Tip tip={chip.detail}>
          <StatusPill tone={chip.tone} pulse={chip.pulse}>
            {upper(chip.label)}
          </StatusPill>
        </Tip>
        <span className="truncate font-mono text-[11px] text-plant-400">
          {job ? (
            <>
              job {shortId(job.id)} · {fmtAge(age)} ago
            </>
          ) : (
            'no job yet'
          )}
        </span>
      </div>
      {chip.detail &&
        (chip.precondition ? (
          <p className="text-[12px] leading-snug text-caution-300">
            <span className="font-mono font-medium">BLOCKED:</span> {chip.detail}
          </p>
        ) : (
          <p
            className={cn(
              'line-clamp-3 break-words font-mono text-[11.5px] leading-snug',
              chip.tone === 'bad' ? 'text-stop-300' : chip.tone === 'warn' ? 'text-caution-300' : 'text-plant-400'
            )}
          >
            {chip.detail}
          </p>
        ))}
      {disabledReason && <p className="text-[12px] text-plant-400">{disabledReason}</p>}
      {children}
    </div>
  );
}

const selectClass =
  'h-9 w-full min-w-0 rounded-md border border-plant-600 bg-plant-900 px-2.5 text-[13px] text-plant-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flow-400 disabled:opacity-50';

export function SpecConsole({
  connected,
  scenesStatus,
  scenes,
  examples,
  dash,
  receivedAt,
  project,
  projectId,
  signedIn,
}: {
  connected: boolean;
  /** State of the scenes query (scene registry + example list). */
  scenesStatus: 'loading' | 'ready' | 'unavailable';
  scenes: SceneLite[];
  examples: ExampleLite[];
  dash: DashboardData | null;
  receivedAt: number;
  project: ProjectDetail | null;
  projectId: string | null;
  signedIn: boolean;
}) {
  const now = useNow();
  const [specText, setSpecText] = React.useState('');
  const [sceneId, setSceneId] = React.useState('');
  const [exampleId, setExampleId] = React.useState('');
  const [faultId, setFaultId] = React.useState('');

  // Defaults come from the registry once it loads: the first VERIFIED scene, the first example.
  React.useEffect(() => {
    if (!sceneId) {
      const firstVerified = scenes.find((s) => s.verified);
      if (firstVerified) setSceneId(firstVerified.id);
    }
  }, [scenes, sceneId]);
  React.useEffect(() => {
    if (!exampleId && examples[0]) setExampleId(examples[0].id);
  }, [examples, exampleId]);

  const generateM = useJobMutation<GenerateArgs, JobCreated>('generate');
  const exampleM = useJobMutation<RunExampleArgs, ExampleCreated>('runExample');
  const faultM = useJobMutation<InjectFaultArgs, JobCreated>('injectFaultAndImprove');
  const specM = useJobMutation<ChangeSpecArgs, JobCreated>('changeSpec');

  const sceneById = (id: string | undefined) => (id ? scenes.find((s) => s.id === id) : undefined);
  const selectedScene = sceneById(sceneId);
  const example = examples.find((e) => e.id === exampleId);
  const projectScene = sceneById(project?.sceneId);
  const trimmed = specText.trim();

  const signInNote = signedIn ? undefined : 'Sign in to send this request.';
  const offline = !connected;
  const emptyRegistryText = (none: string) =>
    scenesStatus === 'loading' ? 'Loading…' : scenesStatus === 'unavailable' ? 'Atlas disconnected' : none;

  // ---- Generate PLC
  const generateBlockers: string[] = [];
  if (connected && !sceneId) generateBlockers.push(scenes.length ? 'no verified scene available' : 'no scenes registered in Atlas');
  if (connected && sceneId) {
    const blocker = sceneRunBlocker(sceneId, selectedScene);
    if (blocker) generateBlockers.push(blocker);
  }
  const specTooShort = trimmed.length < SPEC_MIN_CHARS;
  const specTooLong = trimmed.length > SPEC_MAX_CHARS;
  const generateChip = chipFor(dash?.latestJobs.generate ?? null, generateBlockers, dash?.queuedCount, receivedAt, now);

  // ---- Run Example
  const exampleBlockers: string[] = [];
  if (connected && example) {
    const blocker = sceneRunBlocker(example.sceneId, sceneById(example.sceneId));
    if (blocker) exampleBlockers.push(`example "${example.title}" needs ${blocker}`);
  }
  const exampleChip = chipFor(dash?.latestJobs.example ?? null, exampleBlockers, dash?.queuedCount, receivedAt, now);

  // ---- Inject Fault & Improve Harness (same checks as the server)
  const rig = dash?.rig ?? null;
  const faultBlockers = !connected
    ? []
    : projectId && !project
      ? [`project ${shortId(projectId)} is not loaded yet (or its document is missing in Atlas)`]
      : faultPreconditionFailures({
        project: project ? { id: project.id, sceneId: project.sceneId, finalPlcVersionId: project.finalPlcVersionId } : null,
        scene: projectScene ? { id: projectScene.id, verified: projectScene.verified } : null,
        rig: rig
          ? {
              checkedAgeMs: liveAge(rig.ageMs, receivedAt, now),
              factoryioReachable: rig.factoryio?.reachable,
              factoryioDetail: rig.factoryio?.detail,
            }
          : null,
      });
  const faultChip = chipFor(dash?.latestJobs.fault ?? null, faultBlockers, dash?.queuedCount, receivedAt, now);
  const faults = React.useMemo(() => projectScene?.faults ?? [], [projectScene]);
  // A fault picked for another project's scene would be refused by the server: reset it.
  React.useEffect(() => {
    if (faultId && !faults.some((f) => f.id === faultId)) setFaultId('');
  }, [faults, faultId]);

  // ---- Spec change on the selected project
  const specChangeChip = chipFor(dash?.latestJobs.specChange ?? null, [], dash?.queuedCount, receivedAt, now);
  const canChangeSpec = !!projectId && !!project && !specTooShort && !specTooLong && trimmed !== (project.specText ?? '').trim();

  const queued = (what: string) => (r: JobCreated) => toast.success(`${what} queued as job ${shortId(r.jobId)}`);

  return (
    <section className="panel-surface animate-rise rounded-lg" aria-label="Specification console">
      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Spec input */}
        <div className="min-w-0">
          <div className="mb-2 flex items-center justify-between gap-2">
            <label htmlFor="spec" className="font-display text-[11px] font-semibold uppercase tracking-[0.16em] text-plant-300">
              Machine specification
            </label>
            <span className={cn('font-mono text-[11px] tabular-nums', trimmed.length > SPEC_MAX_CHARS ? 'text-stop-300' : 'text-plant-500')}>
              {trimmed.length} / {SPEC_MAX_CHARS}
            </span>
          </div>
          <textarea
            id="spec"
            value={specText}
            onChange={(e) => setSpecText(e.target.value)}
            rows={6}
            maxLength={SPEC_MAX_CHARS + 500}
            placeholder="Describe the machine in plain language: what starts and stops it, which sensors drive which actuators, interlocks, timeouts, faults and how they reset."
            className="block min-h-36 w-full resize-y rounded-md border border-plant-600 bg-plant-950/70 px-3.5 py-3 text-[14px] leading-relaxed text-plant-50 placeholder:text-plant-500 focus-visible:border-flow-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flow-400/40"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!project?.specText}
              onClick={() => project?.specText && setSpecText(project.specText)}
              className="inline-flex items-center gap-1.5 rounded-md border border-plant-600 px-2.5 py-1.5 text-[12px] text-plant-200 transition-colors hover:bg-plant-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Undo2 className="size-3.5" aria-hidden /> Load selected project’s spec
            </button>
            <button
              type="button"
              disabled={!signedIn || offline || !canChangeSpec || specM.isPending}
              onClick={() => projectId && specM.mutate({ projectId, specText: trimmed }, { onSuccess: queued('Spec change') })}
              className="inline-flex items-center gap-1.5 rounded-md border border-flow-500/60 px-2.5 py-1.5 text-[12px] text-flow-300 transition-colors hover:bg-flow-500/10 disabled:cursor-not-allowed disabled:opacity-40"
              title={projectId ? `Re-engineer project ${projectId} with this text (job type spec_change)` : 'Select a project first'}
            >
              <FileDiff className="size-3.5" aria-hidden />
              {specM.isPending ? 'Sending…' : `Apply as spec change to ${projectId ? shortId(projectId) : 'project'}`}
            </button>
            {dash?.latestJobs.specChange && (
              <Tip tip={specChangeChip.detail}>
                <StatusPill tone={specChangeChip.tone} pulse={specChangeChip.pulse}>
                  spec change {upper(specChangeChip.label)}
                </StatusPill>
              </Tip>
            )}
          </div>
        </div>

        {/* Scene + example */}
        <div className="flex min-w-0 flex-col gap-3">
          <div>
            <label htmlFor="scene" className="mb-1.5 block font-display text-[11px] font-semibold uppercase tracking-[0.16em] text-plant-300">
              Factory I/O scene
            </label>
            <select id="scene" value={sceneId} onChange={(e) => setSceneId(e.target.value)} disabled={offline || !scenes.length} className={selectClass}>
              {!scenes.length && <option value="">{emptyRegistryText('No scenes registered')}</option>}
              {scenes.length > 0 && !sceneId && <option value="">Select a verified scene</option>}
              {scenes.map((s) => (
                <option key={s.id} value={s.id} disabled={!s.verified}>
                  {s.title ?? s.id}
                  {s.verified ? '' : ' — UNVERIFIED'}
                </option>
              ))}
            </select>
            {selectedScene && (
              <p className="mt-1.5 line-clamp-2 text-[12px] leading-snug text-plant-400">
                <span className="font-mono text-plant-300">{selectedScene.id}</span>
                {selectedScene.factoryIoScene ? ` · ${selectedScene.factoryIoScene}` : ''}
                {selectedScene.tags.length ? ` · ${selectedScene.tags.length} tags` : ''}
                {selectedScene.faults.length ? ` · ${selectedScene.faults.length} faults` : ''}
              </p>
            )}
            {scenes.some((s) => !s.verified) && (
              <p className="mt-1 text-[11.5px] text-plant-500">Unverified scenes are listed but cannot be selected for runs.</p>
            )}
          </div>
          <div>
            <label htmlFor="example" className="mb-1.5 block font-display text-[11px] font-semibold uppercase tracking-[0.16em] text-plant-300">
              Example for “Run Example”
            </label>
            <select id="example" value={exampleId} onChange={(e) => setExampleId(e.target.value)} className={selectClass}>
              {examples.length === 0 && <option value="">{emptyRegistryText('No examples')}</option>}
              {examples.map((ex) => {
                const scene = sceneById(ex.sceneId);
                return (
                  <option key={ex.id} value={ex.id}>
                    {ex.title}
                    {connected && !scene?.verified ? ` — scene ${scene ? 'UNVERIFIED' : 'not registered'}` : ''}
                  </option>
                );
              })}
            </select>
            {example && <p className="mt-1.5 font-mono text-[11.5px] text-plant-400">scene {example.sceneId}</p>}
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="grid gap-3 border-t border-plant-700/80 p-4 md:grid-cols-3">
        <ActionTile
          variant="go"
          icon={<Cpu aria-hidden />}
          label="Generate PLC"
          job={dash?.latestJobs.generate ?? null}
          receivedAt={receivedAt}
          chip={generateChip}
          pending={generateM.isPending}
          disabled={!signedIn || offline || generateBlockers.length > 0 || specTooShort || specTooLong || !sceneId}
          disabledReason={
            signInNote ??
            (connected && generateBlockers.length === 0 && (specTooShort || specTooLong)
              ? specTooShort
                ? `Write at least ${SPEC_MIN_CHARS} characters of specification.`
                : `The specification is limited to ${SPEC_MAX_CHARS} characters.`
              : undefined)
          }
          onClick={() => generateM.mutate({ specText: trimmed, sceneId }, { onSuccess: queued('Engineering run') })}
        />
        <ActionTile
          variant="neutral"
          icon={<PlayCircle aria-hidden />}
          label="Run Example"
          job={dash?.latestJobs.example ?? null}
          receivedAt={receivedAt}
          chip={exampleChip}
          pending={exampleM.isPending}
          disabled={!signedIn || offline || !example || exampleBlockers.length > 0}
          disabledReason={signInNote}
          onClick={() =>
            example &&
            exampleM.mutate(
              { exampleId: example.id },
              {
                onSuccess: (r) => {
                  setSpecText(r.specText);
                  setSceneId(r.sceneId);
                  queued(`Example “${example.title}”`)(r);
                },
              }
            )
          }
        />
        <ActionTile
          variant="hazard"
          icon={<FlaskConical aria-hidden />}
          label="Inject Fault & Improve Harness"
          job={dash?.latestJobs.fault ?? null}
          receivedAt={receivedAt}
          chip={faultChip}
          pending={faultM.isPending}
          disabled={!signedIn || offline || !projectId || faultBlockers.length > 0}
          disabledReason={signInNote}
          onClick={() =>
            projectId &&
            faultM.mutate({ projectId, ...(faultId ? { faultId } : {}) }, { onSuccess: queued('Fault injection + harness improvement') })
          }
        >
          <div className="flex items-center gap-2">
            <label htmlFor="fault" className="shrink-0 font-display text-[10px] font-semibold uppercase tracking-[0.14em] text-plant-400">
              Fault
            </label>
            <select id="fault" value={faultId} onChange={(e) => setFaultId(e.target.value)} disabled={!faults.length} className={cn(selectClass, 'h-8 text-[12px]')}>
              <option value="">{faults.length ? 'Worker chooses from the scene' : 'No faults defined for this scene'}</option>
              {faults.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.title ?? f.id}
                  {f.tag ? ` (${f.tag})` : ''}
                </option>
              ))}
            </select>
          </div>
        </ActionTile>
      </div>
    </section>
  );
}
