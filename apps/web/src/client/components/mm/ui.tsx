import * as React from 'react';
import { Check, Copy, PlugZap, ServerCrash } from 'lucide-react';
import type { Disconnected } from '@/shared/mongomation';
import { cn } from '@/client/lib/utils';
import { liveAge, useNow } from '@/client/lib/now';
import { TONE_DOT, TONE_PILL, type Tone } from '@/client/lib/tones';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/client/components/ui/Tooltip';

export function Panel({
  index,
  title,
  icon,
  right,
  children,
  className,
  bodyClassName,
}: {
  index?: string;
  title: string;
  icon?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn('panel-surface animate-rise rounded-lg', className)} aria-label={title}>
      <header className="flex items-center justify-between gap-3 border-b border-plant-700/80 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          {index && <span className="font-mono text-[10px] text-plant-500">{index}</span>}
          {icon && <span className="text-plant-300 [&_svg]:size-4">{icon}</span>}
          <h2 className="truncate font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-plant-100">
            {title}
          </h2>
        </div>
        {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
      </header>
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

export function SectionLabel({ children, right, className }: { children: React.ReactNode; right?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('mb-2 flex items-center justify-between gap-2', className)}>
      <h3 className="font-display text-[11px] font-semibold uppercase tracking-[0.16em] text-plant-300">{children}</h3>
      {right && <div className="flex items-center gap-2 text-xs text-plant-400">{right}</div>}
    </div>
  );
}

export function StatusPill({
  tone,
  children,
  pulse,
  className,
}: {
  tone: Tone;
  children: React.ReactNode;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded border px-1.5 py-[3px] font-mono text-[10.5px] font-medium uppercase leading-none tracking-wider',
        TONE_PILL[tone],
        className
      )}
    >
      <span className={cn('size-1.5 shrink-0 rounded-full', TONE_DOT[tone], pulse && 'animate-pulse-dot')} aria-hidden />
      {children}
    </span>
  );
}

/** Wraps content in a tooltip (rendered as a span, so it can sit inside buttons and table cells). */
export function Tip({ tip, children, className }: { tip?: React.ReactNode; children: React.ReactNode; className?: string }) {
  if (!tip) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn('inline-flex cursor-help', className)} />}>{children}</TooltipTrigger>
      <TooltipContent className="max-w-sm border border-plant-600 bg-plant-800 text-plant-100">{tip}</TooltipContent>
    </Tooltip>
  );
}

export function CodeChip({ value, className, label }: { value: string; className?: string; label?: string }) {
  const [copied, setCopied] = React.useState(false);
  const copy = React.useCallback(() => {
    if (!navigator.clipboard) return;
    navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => undefined);
  }, [value]);
  return (
    <button
      type="button"
      onClick={copy}
      title={`${value} (click to copy)`}
      className={cn(
        'group inline-flex max-w-full items-center gap-1 rounded border border-plant-600 bg-plant-850 px-1.5 py-0.5 font-mono text-[11px] text-plant-200 transition-colors hover:border-plant-500 hover:text-plant-50',
        className
      )}
    >
      <span className="truncate">{label ?? value}</span>
      {copied ? (
        <Check className="size-3 shrink-0 text-go-400" aria-label="copied" />
      ) : (
        <Copy className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-70" aria-hidden />
      )}
    </button>
  );
}

export function EmptyState({
  children,
  className,
  tone = 'muted',
}: {
  children: React.ReactNode;
  className?: string;
  tone?: 'muted' | 'warn' | 'bad';
}) {
  return (
    <div
      className={cn(
        'rounded-md border border-dashed px-3 py-3 text-center font-mono text-[11.5px] uppercase tracking-wider',
        tone === 'muted' && 'border-plant-700 text-plant-400',
        tone === 'warn' && 'border-caution-400/40 text-caution-300',
        tone === 'bad' && 'border-stop-500/50 text-stop-300',
        className
      )}
    >
      {children}
    </div>
  );
}

/** Age that keeps growing between polls: server-computed age + time since the response arrived. */
export function useLiveAge(ageMs: number | undefined, receivedAt: number): number | undefined {
  const now = useNow();
  return liveAge(ageMs, receivedAt, now);
}

export function Metric({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  tone?: Tone;
  sub?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-md border border-plant-700 bg-plant-850/80 px-2.5 py-2">
      <div className="font-display text-[10px] font-semibold uppercase tracking-[0.14em] text-plant-400">{label}</div>
      <div
        className={cn(
          'mt-0.5 truncate font-mono text-lg font-medium leading-tight text-plant-50',
          tone === 'good' && 'text-go-300',
          tone === 'bad' && 'text-stop-300',
          tone === 'warn' && 'text-caution-300',
          tone === 'active' && 'text-flow-300',
          tone === 'meta' && 'text-meta-300'
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-plant-400">{sub}</div>}
    </div>
  );
}

const STAGE_TEXT: Record<Disconnected['stage'], string> = {
  config: 'DISCONNECTED · NOT CONFIGURED',
  connect: 'DISCONNECTED',
  query: 'READ FAILED',
};

/** The Atlas side of a query failed: show it as such, with the real driver message. */
export function DisconnectedNotice({ status, what, compact }: { status: Disconnected; what?: string; compact?: boolean }) {
  return (
    <div className={cn('rounded-md border border-stop-500/40 bg-stop-500/[0.06] px-3', compact ? 'py-2' : 'py-3')}>
      <div className="flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-wider text-stop-300">
        <PlugZap className="size-3.5" aria-hidden />
        {STAGE_TEXT[status.stage]}
        {what && <span className="text-plant-400 normal-case tracking-normal">· {what}</span>}
      </div>
      <p className="mt-1 break-words font-mono text-[11.5px] leading-relaxed text-plant-300">{status.error}</p>
    </div>
  );
}

/** The dashboard's own server could not be reached (network error, server restart). */
export function ServerUnreachable({ error, what }: { error: unknown; what?: string }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-md border border-caution-400/40 bg-caution-400/[0.06] px-3 py-2">
      <div className="flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-wider text-caution-300">
        <ServerCrash className="size-3.5" aria-hidden />
        Dashboard server unreachable{what ? ` · ${what}` : ''}
      </div>
      <p className="mt-1 break-words font-mono text-[11.5px] text-plant-300">{message}</p>
    </div>
  );
}

export function KeyValue({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 items-baseline justify-between gap-3 py-1 text-[12.5px]', className)}>
      <span className="shrink-0 text-plant-400">{label}</span>
      <span className="min-w-0 truncate text-right text-plant-100">{children}</span>
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-3 font-mono text-[11px] uppercase tracking-wider text-plant-400">
      <span className="relative h-0.5 w-16 overflow-hidden rounded bg-plant-700">
        <span className="animate-sweep absolute inset-y-0 left-0 w-1/3 bg-flow-400" />
      </span>
      {label}
    </div>
  );
}
