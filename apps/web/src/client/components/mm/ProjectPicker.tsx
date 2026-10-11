import { FolderKanban, Radio } from 'lucide-react';
import type { ProjectListItem } from '@/shared/mongomation';
import { cn } from '@/client/lib/utils';
import { fmtDateTime, shortId, upper, usd } from '@/client/lib/format';
import { projectTone } from '@/client/lib/tones';
import { EmptyState, StatusPill } from './ui';

export function ProjectPicker({
  projects,
  selectedId,
  pinned,
  onSelect,
  onFollowLatest,
}: {
  projects: ProjectListItem[];
  selectedId: string | null;
  pinned: boolean;
  onSelect: (id: string) => void;
  onFollowLatest: () => void;
}) {
  return (
    <section className="panel-surface animate-rise rounded-lg" aria-label="Projects">
      <div className="flex items-center justify-between gap-3 border-b border-plant-700/80 px-4 py-2">
        <div className="flex items-center gap-2 text-plant-300">
          <FolderKanban className="size-4" aria-hidden />
          <h2 className="font-display text-[12px] font-semibold uppercase tracking-[0.14em] text-plant-100">Projects</h2>
          <span className="font-mono text-[11px] text-plant-500">newest first · {projects.length} shown</span>
        </div>
        <button
          type="button"
          onClick={onFollowLatest}
          disabled={!pinned}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] transition-colors',
            pinned
              ? 'border-flow-500/60 text-flow-300 hover:bg-flow-500/10'
              : 'cursor-default border-plant-700 text-plant-500'
          )}
          title={pinned ? 'Switch back to following the newest project' : 'Following the newest project'}
        >
          <Radio className={cn('size-3.5', !pinned && 'text-go-400')} aria-hidden />
          {pinned ? 'Follow newest' : 'Following newest'}
        </button>
      </div>
      <div className="p-3">
        {projects.length === 0 ? (
          <EmptyState>No runs yet · press Generate PLC or Run Example</EmptyState>
        ) : (
          <ul className="flex gap-2.5 overflow-x-auto pb-1" role="listbox" aria-label="Recent projects">
            {projects.map((p) => {
              const selected = p.id === selectedId;
              return (
                <li key={p.id} className="shrink-0">
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => onSelect(p.id)}
                    className={cn(
                      'flex w-64 flex-col gap-1.5 rounded-md border px-3 py-2 text-left transition-colors',
                      selected
                        ? 'border-flow-400/70 bg-flow-500/[0.07] shadow-[inset_0_0_0_1px_var(--color-flow-500)]'
                        : 'border-plant-700 bg-plant-850/70 hover:border-plant-500'
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[11.5px] text-plant-200">{shortId(p.id, 8)}</span>
                      <StatusPill tone={projectTone(p.status)} pulse={p.status === 'running'}>
                        {upper(p.status ?? 'no status')}
                      </StatusPill>
                    </span>
                    <span className="line-clamp-2 min-h-[2.4em] text-[12px] leading-snug text-plant-300">
                      {p.specExcerpt || <span className="text-plant-500">(no spec text)</span>}
                    </span>
                    <span className="flex items-center justify-between gap-2 font-mono text-[10.5px] text-plant-500">
                      <span className="truncate">{p.sceneId ?? 'no scene'}</span>
                      <span className="shrink-0">
                        {p.currentVersion !== undefined ? `v${p.currentVersion}` : ''}
                        {p.costUsd !== undefined ? ` · ${usd(p.costUsd, 2)}` : ''}
                      </span>
                    </span>
                    <span className="font-mono text-[10.5px] text-plant-500">{fmtDateTime(p.createdAt)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
