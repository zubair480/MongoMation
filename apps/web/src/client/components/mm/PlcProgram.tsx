import * as React from 'react';
import { FileCode2, GitCompareArrows } from 'lucide-react';
import type { PlcVersionMeta } from '@/shared/mongomation';
import { usePlcSource } from '@/client/lib/api';
import { cn } from '@/client/lib/utils';
import { fmtClock, shortId } from '@/client/lib/format';
import { CodeChip, DisconnectedNotice, EmptyState, Loading, ServerUnreachable, StatusPill } from './ui';

// ---- minimal IEC 61131-3 Structured Text highlighter (display only) ------------------------------

const KEYWORDS = new Set(
  (
    'PROGRAM END_PROGRAM FUNCTION_BLOCK END_FUNCTION_BLOCK FUNCTION END_FUNCTION VAR VAR_INPUT VAR_OUTPUT VAR_IN_OUT ' +
    'VAR_GLOBAL VAR_EXTERNAL VAR_TEMP END_VAR CONSTANT RETAIN AT IF THEN ELSIF ELSE END_IF CASE OF END_CASE FOR TO BY DO ' +
    'END_FOR WHILE END_WHILE REPEAT UNTIL END_REPEAT RETURN EXIT CONFIGURATION END_CONFIGURATION RESOURCE END_RESOURCE ' +
    'ON TASK WITH INTERVAL PRIORITY NOT AND OR XOR MOD'
  ).split(' ')
);
const TYPES = new Set(
  'BOOL INT DINT UINT UDINT SINT USINT LINT REAL LREAL TIME WORD DWORD BYTE STRING TON TOF TP R_TRIG F_TRIG CTU CTD CTUD SR RS'.split(' ')
);
const LITERALS = new Set(['TRUE', 'FALSE']);

const TOKEN =
  /(\(\*[\s\S]*?\*\))|(\/\/[^\n]*)|('(?:[^'$]|\$.)*')|(%[IQM][XWDB]?\d+(?:\.\d+)*)|(\b(?:T|TIME)#[0-9A-Za-z_.]+)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_][A-Za-z0-9_]*\b)|(:=|=>)/g;

type Span = { text: string; cls?: string };

function highlight(source: string): Span[][] {
  const spans: Span[] = [];
  let last = 0;
  for (const m of source.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    if (start > last) spans.push({ text: source.slice(last, start) });
    const [text, comment, lineComment, str, address, time, number, ident, assign] = m;
    let cls: string | undefined;
    if (comment || lineComment) cls = 'text-plant-500 italic';
    else if (str) cls = 'text-go-300';
    else if (address) cls = 'text-caution-300';
    else if (time || number) cls = 'text-meta-300';
    else if (assign) cls = 'text-flow-300';
    else if (ident) {
      const up = ident.toUpperCase();
      cls = KEYWORDS.has(up) ? 'text-flow-300 font-medium' : TYPES.has(up) ? 'text-series-sensor' : LITERALS.has(up) ? 'text-meta-300' : undefined;
    }
    spans.push({ text, cls });
    last = start + text.length;
  }
  if (last < source.length) spans.push({ text: source.slice(last) });

  // Split into lines (multi-line comments span several).
  const lines: Span[][] = [[]];
  for (const span of spans) {
    const parts = span.text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, cls: span.cls });
    });
  }
  return lines;
}

function SourceView({ source }: { source: string }) {
  const lines = React.useMemo(() => highlight(source), [source]);
  return (
    <div className="max-h-[460px] overflow-auto rounded-md border border-plant-700 bg-plant-950/80">
      <pre className="min-w-max py-2 font-mono text-[11.5px] leading-[1.6]">
        {lines.map((line, i) => (
          <div key={i} className="flex hover:bg-plant-850/80">
            <span className="sticky left-0 w-11 shrink-0 select-none bg-plant-950/95 pr-3 text-right tabular-nums text-plant-600">{i + 1}</span>
            <code className="pr-4 text-plant-100">
              {line.length === 0 ? ' ' : line.map((s, j) => (s.cls ? <span key={j} className={s.cls}>{s.text}</span> : <React.Fragment key={j}>{s.text}</React.Fragment>))}
            </code>
          </div>
        ))}
      </pre>
    </div>
  );
}

function DiffView({ diff }: { diff: string[] }) {
  const added = diff.filter((l) => l.startsWith('+ ')).length;
  const removed = diff.filter((l) => l.startsWith('- ')).length;
  return (
    <div className="space-y-1.5">
      <div className="flex gap-3 font-mono text-[11px]">
        <span className="text-go-300">+{added} added</span>
        <span className="text-stop-300">−{removed} removed</span>
      </div>
      <div className="max-h-[460px] overflow-auto rounded-md border border-plant-700 bg-plant-950/80">
        <pre className="min-w-max py-2 font-mono text-[11.5px] leading-[1.6]">
          {diff.map((line, i) => {
            const kind = line.startsWith('+ ') ? 'add' : line.startsWith('- ') ? 'del' : 'ctx';
            return (
              <div
                key={i}
                className={cn(
                  'flex pr-4',
                  kind === 'add' && 'bg-go-500/[0.12] text-go-300',
                  kind === 'del' && 'bg-stop-500/[0.12] text-stop-300',
                  kind === 'ctx' && 'text-plant-300'
                )}
              >
                <span className="w-8 shrink-0 select-none text-center text-plant-500" aria-hidden>
                  {kind === 'add' ? '+' : kind === 'del' ? '−' : ''}
                </span>
                <code>{line.slice(2) || ' '}</code>
              </div>
            );
          })}
        </pre>
      </div>
    </div>
  );
}

export function PlcProgram({ versions }: { versions: PlcVersionMeta[] }) {
  const [pickedId, setPickedId] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<'source' | 'diff'>('source');
  const current = versions.find((v) => v.id === pickedId) ?? versions[0];
  const q = usePlcSource(current?.id);

  if (!current) return <EmptyState>No PLC program generated yet</EmptyState>;
  const data = q.data;
  const previous = versions.find((v) => v.version !== undefined && current.version !== undefined && v.version === current.version - 1);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="PLC version"
          value={current.id}
          onChange={(e) => setPickedId(e.target.value === versions[0]?.id ? null : e.target.value)}
          className="h-8 rounded-md border border-plant-600 bg-plant-900 px-2 font-mono text-[12px] text-plant-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flow-400"
        >
          {versions.map((v, i) => (
            <option key={v.id} value={v.id}>
              v{v.version ?? '?'} · {v.createdBy ?? 'unknown'}
              {i === 0 ? ' · latest' : ''}
            </option>
          ))}
        </select>
        <StatusPill tone={current.createdBy === 'repair' ? 'meta' : 'info'}>{current.createdBy ?? 'unknown origin'}</StatusPill>
        {current.harnessVersion !== undefined && <span className="font-mono text-[11px] text-plant-400">harness v{current.harnessVersion}</span>}
        <span className="font-mono text-[11px] text-plant-500">{fmtClock(current.createdAt)}</span>
        <div className="ml-auto flex overflow-hidden rounded-md border border-plant-600" role="group" aria-label="View">
          <button
            type="button"
            onClick={() => setMode('source')}
            aria-pressed={mode === 'source'}
            className={cn('inline-flex items-center gap-1 px-2 py-1 text-[11.5px]', mode === 'source' ? 'bg-plant-700 text-plant-50' : 'text-plant-300 hover:bg-plant-800')}
          >
            <FileCode2 className="size-3.5" aria-hidden /> Source
          </button>
          <button
            type="button"
            onClick={() => setMode('diff')}
            aria-pressed={mode === 'diff'}
            className={cn('inline-flex items-center gap-1 border-l border-plant-600 px-2 py-1 text-[11.5px]', mode === 'diff' ? 'bg-plant-700 text-plant-50' : 'text-plant-300 hover:bg-plant-800')}
          >
            <GitCompareArrows className="size-3.5" aria-hidden /> Diff{previous ? ` vs v${previous.version}` : ''}
          </button>
        </div>
      </div>
      {current.sourceHash && (
        <div className="flex items-center gap-2 font-mono text-[10.5px] text-plant-500">
          source hash <CodeChip value={current.sourceHash} label={shortId(current.sourceHash, 12)} />
        </div>
      )}

      {q.isError && !data ? (
        <ServerUnreachable error={q.error} what="PLC source" />
      ) : !data ? (
        <Loading label="Loading program" />
      ) : !data.connected ? (
        <DisconnectedNotice status={data} what="PLC source" compact />
      ) : !data.found ? (
        <EmptyState tone="warn">PLC version {current.id} not found in Atlas</EmptyState>
      ) : mode === 'source' ? (
        data.source ? <SourceView source={data.source} /> : <EmptyState>Version has no source text</EmptyState>
      ) : data.diff ? (
        <DiffView diff={data.diff} />
      ) : (
        <EmptyState>First version · nothing to compare against</EmptyState>
      )}
    </div>
  );
}
