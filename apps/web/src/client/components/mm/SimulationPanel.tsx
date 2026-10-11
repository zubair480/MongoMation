import * as React from 'react';
import { ExternalLink, Factory, MonitorPlay } from 'lucide-react';
import {
  RIG_FRESH_MS,
  type Disconnected,
  type FaultInjectionLite,
  type RigLite,
  type SceneLite,
  type SceneTagLite,
  type TagValue,
} from '@/shared/mongomation';
import { cn } from '@/client/lib/utils';
import { fmtAge, fmtClock, upper } from '@/client/lib/format';
import { DisconnectedNotice, EmptyState, KeyValue, Panel, SectionLabel, StatusPill, useLiveAge } from './ui';

function ValuePill({ value }: { value: TagValue }) {
  if (typeof value === 'number') {
    return (
      <span className="inline-flex min-w-12 justify-center rounded border border-plant-600 bg-plant-850 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-plant-100">
        {Number.isInteger(value) ? value : value.toFixed(2)}
      </span>
    );
  }
  return value ? (
    <span className="inline-flex min-w-12 items-center justify-center gap-1 rounded border border-go-500/60 bg-go-500/15 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-go-300 shadow-[0_0_10px_-2px_var(--color-go-500)]">
      ON
    </span>
  ) : (
    <span className="inline-flex min-w-12 justify-center rounded border border-plant-700 bg-plant-900 px-1.5 py-0.5 font-mono text-[11px] text-plant-500">
      OFF
    </span>
  );
}

function TagRows({
  title,
  names,
  rig,
  defs,
}: {
  title: string;
  names: string[];
  rig: RigLite;
  defs: Map<string, SceneTagLite>;
}) {
  if (!names.length) return null;
  return (
    <div>
      <SectionLabel right={<span className="font-mono">{names.length}</span>}>{title}</SectionLabel>
      <ul className="divide-y divide-plant-800 overflow-hidden rounded-md border border-plant-700">
        {names.map((name) => {
          const def = defs.get(name);
          const forced = rig.forced.includes(name);
          return (
            <li
              key={name}
              className={cn('flex items-center gap-2 px-2.5 py-1.5', forced ? 'bg-caution-400/[0.07]' : 'bg-plant-900/60')}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-plant-100" title={name}>
                  {name}
                </span>
                <span className="block truncate font-mono text-[10.5px] text-plant-500">
                  {def?.plcAddress ?? 'no address in scene'}
                  {def?.kind ? ` · ${def.kind}` : ''}
                  {def?.normallyClosed ? ' · NC' : ''}
                </span>
              </span>
              {forced && (
                <span className="relative overflow-hidden rounded border border-caution-400/70 px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider text-caution-300">
                  <span className="hazard absolute inset-0 opacity-20" aria-hidden />
                  <span className="relative">FORCED</span>
                </span>
              )}
              <ValuePill value={rig.tags[name]} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function SimulationPanel({
  disconnected,
  rig,
  receivedAt,
  scenes,
  selectedProjectSceneId,
  faults,
}: {
  disconnected: Disconnected | null;
  rig: RigLite | null;
  receivedAt: number;
  scenes: SceneLite[];
  selectedProjectSceneId?: string;
  faults: FaultInjectionLite[];
}) {
  const age = useLiveAge(rig?.ageMs, receivedAt);
  const rigScene = rig?.sceneId ? scenes.find((s) => s.id === rig.sceneId) : undefined;
  const defs = React.useMemo(() => new Map((rigScene?.tags ?? []).map((t) => [t.name, t])), [rigScene]);

  const names = rig ? Object.keys(rig.tags) : [];
  const sensors = names.filter((n) => defs.get(n)?.role === 'sensor');
  const actuators = names.filter((n) => defs.get(n)?.role === 'actuator');
  const unknown = names.filter((n) => !defs.get(n)?.role || !['sensor', 'actuator'].includes(defs.get(n)!.role!));
  const fresh = age !== undefined && age < RIG_FRESH_MS;

  return (
    <Panel
      index="01"
      title="Industrial Simulation"
      icon={<Factory />}
      right={
        rig ? (
          <StatusPill tone={fresh ? 'good' : 'warn'} pulse={fresh}>
            {fresh ? 'live' : 'stale'} · {fmtAge(age)}
          </StatusPill>
        ) : undefined
      }
      bodyClassName="space-y-4"
    >
      {disconnected ? (
        <DisconnectedNotice status={disconnected} what="rig status" />
      ) : !rig ? (
        <EmptyState>No rig status in Atlas · the rig has not reported yet</EmptyState>
      ) : (
        <>
          {rig.dcvUrl ? (
            <a
              href={rig.dcvUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-3 rounded-md border border-flow-500/50 bg-flow-500/[0.08] px-3 py-2.5 transition-colors hover:bg-flow-500/15"
            >
              <MonitorPlay className="size-5 text-flow-300" aria-hidden />
              <span className="flex-1">
                <span className="block font-display text-[13px] font-semibold uppercase tracking-[0.08em] text-flow-300">
                  Open live 3D view (Amazon DCV)
                </span>
                <span className="block truncate font-mono text-[10.5px] text-plant-400">{rig.dcvUrl}</span>
              </span>
              <ExternalLink className="size-4 text-flow-300 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </a>
          ) : (
            <EmptyState>Live 3D view unavailable · rig_status.dcvUrl is not set</EmptyState>
          )}

          <div className="rounded-md border border-plant-700 bg-plant-900/60 px-3 py-1.5">
            <KeyValue label="Rig">
              <span className="font-mono">{rig.id}</span>
            </KeyValue>
            <KeyValue label="Factory I/O">
              <StatusPill tone={rig.factoryio?.reachable ? 'good' : 'bad'}>
                {rig.factoryio?.reachable === undefined ? 'unknown' : rig.factoryio.reachable ? 'reachable' : 'unreachable'}
              </StatusPill>
            </KeyValue>
            {rig.factoryio?.detail && <p className="pb-1 text-right font-mono text-[10.5px] text-plant-400">{rig.factoryio.detail}</p>}
            <KeyValue label="OpenPLC">
              <span className="inline-flex gap-1.5">
                <StatusPill tone={rig.openplc?.reachable ? 'good' : 'bad'}>
                  {rig.openplc?.reachable === undefined ? 'unknown' : rig.openplc.reachable ? 'reachable' : 'unreachable'}
                </StatusPill>
                {rig.openplc?.running !== undefined && (
                  <StatusPill tone={rig.openplc.running ? 'good' : 'warn'}>{rig.openplc.running ? 'running' : 'stopped'}</StatusPill>
                )}
              </span>
            </KeyValue>
            {rig.openplc?.detail && <p className="pb-1 text-right font-mono text-[10.5px] text-plant-400">{rig.openplc.detail}</p>}
            <KeyValue label="Checked">
              <span className="font-mono">
                {fmtClock(rig.checkedAt)} · {fmtAge(age)} ago
              </span>
            </KeyValue>
          </div>

          <div>
            <SectionLabel>Scene on the rig</SectionLabel>
            {rig.sceneId ? (
              <div className="rounded-md border border-plant-700 bg-plant-900/60 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[13px] text-plant-100">{rigScene?.title ?? rig.sceneId}</span>
                  {rigScene ? (
                    <StatusPill tone={rigScene.verified ? 'good' : 'warn'}>{rigScene.verified ? 'verified' : 'unverified'}</StatusPill>
                  ) : (
                    <StatusPill tone="warn">not registered</StatusPill>
                  )}
                </div>
                <div className="mt-0.5 font-mono text-[10.5px] text-plant-500">
                  {rig.sceneId}
                  {rigScene?.factoryIoScene ? ` · ${rigScene.factoryIoScene}` : ''}
                </div>
                {selectedProjectSceneId && selectedProjectSceneId !== rig.sceneId && (
                  <p className="mt-1.5 text-[11.5px] text-caution-300">
                    Selected project uses scene <span className="font-mono">{selectedProjectSceneId}</span>
                  </p>
                )}
              </div>
            ) : (
              <EmptyState>Rig reports no scene</EmptyState>
            )}
          </div>

          <div>
            <SectionLabel>Forced signals</SectionLabel>
            {rig.forced.length ? (
              <div className="flex flex-wrap gap-1.5">
                {rig.forced.map((name) => (
                  <span
                    key={name}
                    className="relative overflow-hidden rounded border border-caution-400/70 bg-caution-400/10 px-2 py-1 font-mono text-[11px] text-caution-300"
                  >
                    <span className="hazard absolute inset-y-0 left-0 w-1.5" aria-hidden />
                    <span className="pl-1.5">FORCED · {name}</span>
                  </span>
                ))}
              </div>
            ) : (
              <EmptyState>No forced signals</EmptyState>
            )}
          </div>

          {names.length === 0 ? (
            <EmptyState>Rig reported no tag values</EmptyState>
          ) : (
            <div className="space-y-3">
              <TagRows title="Sensors · PLC inputs" names={sensors} rig={rig} defs={defs} />
              <TagRows title="Actuators · PLC outputs" names={actuators} rig={rig} defs={defs} />
              <TagRows title={rigScene ? 'Not in scene registry' : 'Tags (scene not registered)'} names={unknown} rig={rig} defs={defs} />
            </div>
          )}
        </>
      )}

      {!disconnected && (
        <div>
          <SectionLabel>Fault injections · selected project</SectionLabel>
          {faults.length === 0 ? (
            <EmptyState>No fault injections recorded</EmptyState>
          ) : (
            <ul className="space-y-1.5">
              {faults.map((f) => (
                <li key={f.id} className="rounded-md border border-plant-700 bg-plant-900/60 px-2.5 py-1.5 text-[12px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-plant-100">{f.faultId ?? 'fault'}</span>
                    <StatusPill tone={f.status === 'released' ? 'muted' : f.status === 'failed' ? 'bad' : 'warn'}>
                      {upper(f.status ?? 'no status')}
                    </StatusPill>
                  </div>
                  <div className="mt-0.5 font-mono text-[10.5px] text-plant-400">
                    {f.tag ?? '?'} := {f.value ?? '?'}
                    {f.readBack !== undefined ? ` · read back ${f.readBack}` : ''}
                    {f.appliedAt ? ` · applied ${fmtClock(f.appliedAt)}` : ''}
                    {f.releasedAt ? ` · released ${fmtClock(f.releasedAt)}` : ''}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Panel>
  );
}
