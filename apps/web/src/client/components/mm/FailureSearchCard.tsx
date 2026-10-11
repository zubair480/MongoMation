import * as React from 'react';
import { Search, X } from 'lucide-react';
import type { FacetBucket } from '@/shared/insights';
import { cn } from '@/client/lib/utils';
import { fmtDateTime, shortId } from '@/client/lib/format';
import { useFailureFacets, useFailureSearch, useFailureSuggest } from '@/client/lib/insights';
import { EmptyState, Loading, Panel, SectionLabel } from './ui';

type Filters = { sceneId?: string; faultId?: string };

function FacetGroup({
  label,
  buckets,
  active,
  onPick,
}: {
  label: string;
  buckets: FacetBucket[];
  active?: string;
  onPick?: (v: string | undefined) => void;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1 font-display text-[10px] font-semibold uppercase tracking-[0.14em] text-plant-400">{label}</div>
      {buckets.length ? (
        <div className="flex flex-wrap gap-1">
          {buckets.map((b) => {
            const on = active === b.value;
            return (
              <button
                key={b.value}
                type="button"
                disabled={!onPick}
                onClick={() => onPick?.(on ? undefined : b.value)}
                className={cn(
                  'inline-flex max-w-full items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono text-[10.5px] transition-colors',
                  on ? 'border-flow-400 bg-flow-500/15 text-flow-300' : 'border-plant-700 text-plant-300',
                  onPick && !on && 'hover:border-plant-500 hover:text-plant-100',
                )}
              >
                <span className="truncate">{b.value}</span>
                <span className="text-plant-500">{b.count}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <span className="font-mono text-[10.5px] text-plant-500">none</span>
      )}
    </div>
  );
}

export function FailureSearchCard({ onOpenProject }: { onOpenProject?: (projectId: string) => void }) {
  const [input, setInput] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [filters, setFilters] = React.useState<Filters>({});
  const [open, setOpen] = React.useState(false);
  const [cursor, setCursor] = React.useState(-1);

  const suggestQ = useFailureSuggest(input);
  const searchQ = useFailureSearch(query, filters);
  const facetsQ = useFailureFacets(query, filters);

  const suggestions = open && input.trim().length >= 2 && suggestQ.data?.connected ? suggestQ.data.suggestions : [];
  const facets = facetsQ.data?.connected ? facetsQ.data : null;
  const results = searchQ.data?.connected ? searchQ.data : null;

  const submit = (text: string) => {
    setInput(text);
    setQuery(text);
    setOpen(false);
    setCursor(-1);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setCursor((c) => Math.min(suggestions.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(-1, c - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      submit(cursor >= 0 && suggestions[cursor] ? suggestions[cursor].summary.replace(/…$/, '').slice(0, 120) : input);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <Panel
      title="Failure search"
      icon={<Search />}
      right={<span className="font-mono text-[10px] text-plant-500">Atlas Search · diagnoses_search</span>}
    >
      <div className="space-y-3">
        <div className="relative">
          <div className="flex items-center gap-2 rounded-md border border-plant-600 bg-plant-850 px-2.5 focus-within:border-flow-400">
            <Search className="size-3.5 shrink-0 text-plant-400" aria-hidden />
            <input
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setOpen(true);
                setCursor(-1);
              }}
              onFocus={() => setOpen(true)}
              onBlur={() => window.setTimeout(() => setOpen(false), 120)}
              onKeyDown={onKey}
              placeholder="Search diagnosed failures: e.g. jam timer, %IX inputs, reset"
              aria-label="Search diagnosed failures"
              role="combobox"
              aria-expanded={suggestions.length > 0}
              aria-autocomplete="list"
              className="h-9 min-w-0 flex-1 bg-transparent text-[13px] text-plant-100 placeholder:text-plant-500 focus:outline-none"
            />
            {input && (
              <button type="button" aria-label="Clear search" onClick={() => submit('')} className="text-plant-400 hover:text-plant-100">
                <X className="size-3.5" />
              </button>
            )}
          </div>
          {suggestions.length > 0 && (
            <ul role="listbox" className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-md border border-plant-600 bg-plant-850 shadow-xl">
              {suggestions.map((s, i) => (
                <li key={s.id} role="option" aria-selected={i === cursor}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      submit(s.summary.replace(/…$/, '').slice(0, 120));
                    }}
                    className={cn(
                      'block w-full truncate px-3 py-1.5 text-left text-[12px] text-plant-200',
                      i === cursor ? 'bg-plant-700 text-plant-50' : 'hover:bg-plant-800',
                    )}
                  >
                    {s.summary}
                  </button>
                </li>
              ))}
              <li className="border-t border-plant-700 px-3 py-1 font-mono text-[9.5px] uppercase tracking-wider text-plant-500">
                autocomplete · edgeGram on summary · 1 typo allowed
              </li>
            </ul>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 rounded-md border border-plant-700 bg-plant-850/50 p-2.5 sm:grid-cols-3">
          <FacetGroup label="Scene" buckets={facets?.byScene ?? []} active={filters.sceneId} onPick={(v) => setFilters((f) => ({ ...f, sceneId: v }))} />
          <FacetGroup label="Fault" buckets={facets?.byFault ?? []} active={filters.faultId} onPick={(v) => setFilters((f) => ({ ...f, faultId: v }))} />
          <FacetGroup label="Split" buckets={facets?.bySplit ?? []} />
          <div className="font-mono text-[10px] text-plant-500 sm:col-span-3">
            {facets ? `${facets.total} diagnosed failure${facets.total === 1 ? '' : 's'}${query ? ` match “${query}”` : ''} · $searchMeta facets` : facetsQ.data && !facetsQ.data.connected ? facetsQ.data.error : 'loading facets…'}
          </div>
        </div>

        {query.trim().length >= 2 ? (
          searchQ.isLoading ? (
            <Loading label="Searching" />
          ) : searchQ.data && !searchQ.data.connected ? (
            <EmptyState tone="bad">{searchQ.data.error}</EmptyState>
          ) : results && results.hits.length ? (
            <div>
              <SectionLabel right={<span className="font-mono text-[10px]">{results.hits.length} hits · {results.tookMs} ms</span>}>Results</SectionLabel>
              <ol className="space-y-2">
                {results.hits.map((h) => (
                  <li key={h.id} className="rounded-md border border-plant-700 bg-plant-850/70 px-3 py-2">
                    <p className="text-[12.5px] leading-relaxed text-plant-200">
                      {h.highlights.length
                        ? h.highlights.map((passage, pi) => (
                            <span key={pi}>
                              {pi > 0 && <span className="text-plant-500"> … </span>}
                              {passage.map(([text, hit], ti) =>
                                hit ? (
                                  <mark key={ti} className="rounded-sm bg-caution-400/25 px-0.5 text-caution-300">
                                    {text}
                                  </mark>
                                ) : (
                                  <span key={ti}>{text}</span>
                                ),
                              )}
                            </span>
                          ))
                        : h.summary}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-plant-500">
                      <span>score {h.score.toFixed(2)}</span>
                      {h.sceneId && <span>{h.sceneId}</span>}
                      {h.faultId && <span>fault {h.faultId}</span>}
                      {h.split && <span>{h.split}</span>}
                      {h.createdAt && <span>{fmtDateTime(new Date(h.createdAt))}</span>}
                      {h.projectId && onOpenProject && (
                        <button type="button" onClick={() => onOpenProject(h.projectId as string)} className="text-flow-300 hover:text-flow-400">
                          open project {shortId(h.projectId)} →
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <EmptyState>No diagnosed failure matches “{query}”</EmptyState>
          )
        ) : (
          <p className="font-mono text-[10.5px] text-plant-500">
            Lexical full-text + fuzzy matching over the worker's diagnoses (summary, causes, fixes). Press Enter to search.
          </p>
        )}
      </div>
    </Panel>
  );
}
