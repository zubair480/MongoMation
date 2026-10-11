import * as React from 'react';
import { Link } from 'react-router';
import { useSession } from 'modelence/client';
import { Cpu, Database, Factory, LogIn, LogOut } from 'lucide-react';
import type { UseQueryResult } from '@tanstack/react-query';
import { RIG_FRESH_MS, WORKER_STALE_MS, type DashboardData, type Envelope } from '@/shared/mongomation';
import { receivedAtOf } from '@/client/lib/api';
import { cn } from '@/client/lib/utils';
import { displayName, fmtAge } from '@/client/lib/format';
import { TONE_DOT, TONE_TEXT, type Tone } from '@/client/lib/tones';
import { Tip, useLiveAge } from './ui';
import { BrandMark } from './BrandMark';

function Lamp({
  icon,
  label,
  value,
  tone,
  tip,
  pulse,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  tone: Tone;
  tip?: React.ReactNode;
  pulse?: boolean;
}) {
  const body = (
    <span className="flex min-w-0 items-center gap-2.5 rounded-md border border-plant-700 bg-plant-900/80 py-1.5 pl-2.5 pr-3">
      <span className={cn('relative flex size-2.5 shrink-0 rounded-full', TONE_DOT[tone])} aria-hidden>
        {pulse && <span className={cn('absolute inset-0 rounded-full animate-ping opacity-60', TONE_DOT[tone])} />}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="flex items-center gap-1 font-display text-[10px] font-semibold uppercase tracking-[0.16em] text-plant-400 [&_svg]:size-3">
          {icon}
          {label}
        </span>
        <span className={cn('truncate font-mono text-[11.5px] font-medium uppercase', TONE_TEXT[tone])}>{value}</span>
      </span>
    </span>
  );
  return tip ? <Tip tip={tip}>{body}</Tip> : body;
}

export function HeaderBar({ dashboardQ }: { dashboardQ: UseQueryResult<Envelope<DashboardData>> }) {
  const { user } = useSession();
  const data = dashboardQ.data;
  const receivedAt = receivedAtOf(dashboardQ);
  const connected = data?.connected ? data : null;

  const worker = connected?.workers[0];
  const workerAge = useLiveAge(worker?.heartbeatAgeMs, receivedAt);
  const rig = connected?.rig ?? null;
  const rigAge = useLiveAge(rig?.ageMs, receivedAt);

  // Atlas
  let atlas: { tone: Tone; value: React.ReactNode; tip?: React.ReactNode; pulse?: boolean };
  if (dashboardQ.isError) {
    // A failed refetch keeps the previous answer in the cache; do not keep calling it "connected".
    atlas = {
      tone: 'warn',
      value: 'Server unreachable',
      tip: `${(dashboardQ.error as Error)?.message ?? ''}${data ? ' · showing the last answer received' : ''}`,
    };
  } else if (!data) {
    atlas = { tone: 'muted', value: 'Connecting…' };
  } else if (data.connected) {
    atlas = { tone: 'good', value: `Connected · ${data.db}`, tip: `MongoDB Atlas database "${data.db}"` };
  } else {
    atlas = { tone: 'bad', value: 'Disconnected', tip: data.error };
  }

  // Worker heartbeat
  let workerLamp: { tone: Tone; value: React.ReactNode; tip?: React.ReactNode; pulse?: boolean };
  if (!connected) workerLamp = { tone: 'muted', value: 'Unknown', tip: 'Atlas is not connected' };
  else if (!worker) workerLamp = { tone: 'muted', value: 'No worker registered', tip: 'The workers collection is empty' };
  else if (workerAge === undefined) workerLamp = { tone: 'warn', value: 'No heartbeat', tip: `Worker ${worker.id} has no heartbeatAt` };
  else {
    const fresh = workerAge < WORKER_STALE_MS;
    workerLamp = {
      tone: fresh ? 'good' : 'warn',
      pulse: fresh,
      value: `${fresh ? 'Heartbeat' : 'Last beat'} ${fmtAge(workerAge)} ago`,
      tip: (
        <span className="font-mono text-[11px]">
          {worker.id}
          {worker.host ? ` · ${worker.host}` : ''}
          {worker.pid !== undefined ? ` · pid ${worker.pid}` : ''}
          {worker.currentJobId ? ` · job ${worker.currentJobId}` : ''}
        </span>
      ),
    };
  }

  // Rig (Factory I/O + OpenPLC)
  let rigLamp: { tone: Tone; value: React.ReactNode; tip?: React.ReactNode };
  if (!connected) rigLamp = { tone: 'muted', value: 'Unknown', tip: 'Atlas is not connected' };
  else if (!rig) rigLamp = { tone: 'muted', value: 'No rig status', tip: 'The rig_status collection is empty' };
  else {
    const fio = rig.factoryio?.reachable === true;
    const plc = rig.openplc?.reachable === true;
    const fresh = rigAge !== undefined && rigAge < RIG_FRESH_MS;
    const tone: Tone = !fio || !plc ? 'bad' : fresh ? 'good' : 'warn';
    rigLamp = {
      tone,
      value: `FIO ${fio ? 'up' : 'down'} · PLC ${plc ? (rig.openplc?.running ? 'running' : 'up') : 'down'} · ${fmtAge(rigAge)}`,
      tip: (
        <span className="block space-y-0.5 text-[11px]">
          <span className="block">Rig {rig.id}{rig.sceneId ? ` · scene ${rig.sceneId}` : ''}</span>
          {rig.factoryio?.detail && <span className="block">Factory I/O: {rig.factoryio.detail}</span>}
          {rig.openplc?.detail && <span className="block">OpenPLC: {rig.openplc.detail}</span>}
        </span>
      ),
    };
  }

  return (
    <header className="z-30 border-b border-plant-700/80 bg-plant-950/85 backdrop-blur-md lg:sticky lg:top-0">
      <div className="mx-auto flex max-w-[1800px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 lg:px-6">
        <Link to="/" className="flex min-w-0 items-center gap-3">
          <BrandMark className="size-10 shrink-0" />
          <span className="flex min-w-0 flex-col">
            <span className="font-display text-2xl font-bold leading-none tracking-tight text-plant-50">
              Mongo<span className="text-leaf-400">Mation</span>
            </span>
            <span className="mt-1 truncate text-[12.5px] text-plant-300">
              Describe the machine. We engineer the control system. The harness gets smarter.
            </span>
          </span>
        </Link>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Lamp icon={<Database />} label="Atlas" {...atlas} />
          <Lamp icon={<Cpu />} label="Worker" {...workerLamp} />
          <Lamp icon={<Factory />} label="Rig" {...rigLamp} />

          {user ? (
            <span className="flex items-center gap-2 rounded-md border border-plant-700 bg-plant-900/80 py-1.5 pl-3 pr-1.5">
              <span className="max-w-40 truncate text-[12.5px] text-plant-200">{displayName(user.handle)}</span>
              <Link
                to="/logout"
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-[12px] text-plant-300 transition-colors hover:bg-plant-800 hover:text-plant-50"
              >
                <LogOut className="size-3.5" aria-hidden /> Sign out
              </Link>
            </span>
          ) : (
            <Tip
              tip={
                connected && !connected.authDbConfigured
                  ? 'Sign-in needs Modelence’s own database (MONGODB_URI locally, or a Modelence Cloud environment).'
                  : 'Watching is public. Sign in to send jobs to the worker.'
              }
            >
              <Link
                to="/login"
                className="inline-flex items-center gap-1.5 rounded-md border border-plant-600 bg-plant-100 px-3 py-2 text-[12.5px] font-medium text-plant-950 transition-colors hover:bg-white"
              >
                <LogIn className="size-3.5" aria-hidden /> Sign in
              </Link>
            </Tip>
          )}
        </div>
      </div>
    </header>
  );
}
