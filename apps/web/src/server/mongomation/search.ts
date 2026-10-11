// Failure search over the worker's diagnosed failures (`diagnoses`), using the Atlas Search index
// `diagnoses_search` (lexical + autocomplete on `summary`). Lexical only: no embedding call, so the
// automated-embedding rate limit is never touched. Mirrors apps/worker/src/harness/memory.ts
// (searchDiagnoses / suggestDiagnoses / failureFacets) without importing across workspaces.
//
// Search stages must run with readConcern "local": Atlas rejects $search / $searchMeta under "majority".
// Free text is scrubbed of hidden test ids, and only `summary` is highlighted / returned.
import { z } from 'zod';
import type { AggregateOptions, Document } from 'mongodb';
import type { Envelope } from '@/shared/mongomation';
import type { FailureFacetsData, FailureSearchData, FailureSuggestData } from '@/shared/insights';
import { withAtlas } from './atlas';
import { cached } from './cache';
import { clip, date, idOf, redactHidden, str } from './docs';
import { parseArgs } from './errors';

const SEARCH_INDEX = 'diagnoses_search';
const SEARCH_READ: AggregateOptions = { readConcern: { level: 'local' } };

function lexicalQuery(text: string, maxTerms = 48): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[^\p{L}\p{N}%._-]+/u)) {
    const t = raw.replace(/^[._-]+|[._-]+$/g, '');
    if (t.length < 3 || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= maxTerms) break;
  }
  return out.join(' ');
}

const sceneId = z.string().trim().regex(/^[a-z0-9-]+$/).max(100).optional();
const faultId = z.string().trim().max(100).optional();

function filters(opts: { sceneId?: string; faultId?: string }): Document[] {
  const f: Document[] = [];
  if (opts.sceneId) f.push({ equals: { path: 'sceneId', value: opts.sceneId } });
  if (opts.faultId) f.push({ equals: { path: 'faultId', value: opts.faultId } });
  return f;
}

type Highlight = { texts?: { value?: string; type?: string }[] };

export async function searchFailures(args: unknown): Promise<Envelope<FailureSearchData>> {
  const input = parseArgs(z.object({ query: z.string().trim().min(2).max(200), sceneId, faultId }), args);
  const lexical = lexicalQuery(input.query) || input.query;
  return cached(`search:${input.query}:${input.sceneId ?? ''}:${input.faultId ?? ''}`, () =>
    withAtlas<FailureSearchData>(async (db) => {
      const t0 = Date.now();
      const docs = await db
        .collection('diagnoses')
        .aggregate(
          [
            {
              $search: {
                index: SEARCH_INDEX,
                compound: {
                  should: [
                    { text: { query: lexical, path: ['summary', 'text', 'causes.cause', 'causes.fix'], fuzzy: { maxEdits: 1, prefixLength: 1 } } },
                    { autocomplete: { query: input.query.slice(0, 60), path: 'summary', fuzzy: { maxEdits: 1 } } },
                  ],
                  minimumShouldMatch: 1,
                  filter: filters(input),
                },
                highlight: { path: 'summary' },
              },
            },
            { $limit: 10 },
            {
              $project: {
                summary: 1,
                sceneId: 1,
                faultId: 1,
                projectId: 1,
                split: 1,
                createdAt: 1,
                score: { $meta: 'searchScore' },
                highlights: { $meta: 'searchHighlights' },
              },
            },
          ],
          SEARCH_READ,
        )
        .toArray();
      return {
        query: input.query,
        tookMs: Date.now() - t0,
        hits: docs.map((d) => ({
          id: idOf(d._id),
          summary: clip(redactHidden(str(d.summary)), 600) ?? '',
          sceneId: str(d.sceneId),
          faultId: str(d.faultId),
          projectId: str(d.projectId),
          split: str(d.split),
          createdAt: date(d.createdAt),
          score: typeof d.score === 'number' ? d.score : 0,
          // [text, isHit][] segments, so the client renders <mark> without HTML injection.
          highlights: ((d.highlights ?? []) as Highlight[]).slice(0, 2).map((h) =>
            (h.texts ?? []).map((t) => [redactHidden(t.value ?? '') ?? '', t.type === 'hit'] as [string, boolean]),
          ),
        })),
      };
    }),
  );
}

export async function suggestFailures(args: unknown): Promise<Envelope<FailureSuggestData>> {
  const { prefix } = parseArgs(z.object({ prefix: z.string().trim().max(60) }), args);
  if (prefix.length < 2) return withAtlas<FailureSuggestData>(async () => ({ suggestions: [] }));
  return cached(`suggest:${prefix.toLowerCase()}`, () =>
    withAtlas<FailureSuggestData>(async (db) => {
      const docs = await db
        .collection('diagnoses')
        .aggregate(
          [
            {
              $search: {
                index: SEARCH_INDEX,
                autocomplete: { query: prefix, path: 'summary', tokenOrder: 'sequential', fuzzy: { maxEdits: 1, prefixLength: 1 } },
              },
            },
            { $limit: 6 },
            { $project: { summary: 1 } },
          ],
          SEARCH_READ,
        )
        .toArray();
      return { suggestions: docs.map((d) => ({ id: idOf(d._id), summary: clip(redactHidden(str(d.summary)), 160) ?? '' })) };
    }),
    5000,
  );
}

export async function failureFacets(args: unknown): Promise<Envelope<FailureFacetsData>> {
  const input = parseArgs(z.object({ query: z.string().trim().max(200).optional(), sceneId, faultId }), args ?? {});
  const lexical = input.query ? lexicalQuery(input.query) || input.query : '';
  return cached(`facets:${lexical}:${input.sceneId ?? ''}:${input.faultId ?? ''}`, () =>
    withAtlas<FailureFacetsData>(async (db) => {
      const must: Document[] = lexical
        ? [{ text: { query: lexical, path: ['summary', 'text', 'causes.cause'], fuzzy: { maxEdits: 1 } } }]
        : [{ exists: { path: 'summary' } }];
      const [meta] = await db
        .collection('diagnoses')
        .aggregate(
          [
            {
              $searchMeta: {
                index: SEARCH_INDEX,
                facet: {
                  operator: { compound: { must, filter: filters(input) } },
                  facets: {
                    scene: { type: 'string', path: 'sceneId', numBuckets: 20 },
                    fault: { type: 'string', path: 'faultId', numBuckets: 20 },
                    split: { type: 'string', path: 'split' },
                  },
                },
                count: { type: 'total' },
              },
            },
          ],
          SEARCH_READ,
        )
        .toArray();
      const buckets = (name: string) =>
        ((meta?.facet?.[name]?.buckets ?? []) as { _id: unknown; count: unknown }[]).map((b) => ({
          value: String(b._id),
          count: Number(b.count) || 0,
        }));
      return {
        total: Number(meta?.count?.total ?? meta?.count?.lowerBound ?? 0),
        byScene: buckets('scene'),
        byFault: buckets('fault'),
        bySplit: buckets('split'),
      };
    }),
    3000,
  );
}
