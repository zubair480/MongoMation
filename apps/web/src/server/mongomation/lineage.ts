// Harness lineage ($graphLookup) and per-project evidence timeline ($unionWith), computed inside Atlas.
// Same pipelines as apps/worker/src/db/lineage.ts. Public and read-only: hidden tests never enter the
// timeline (visibility filter inside the sub-pipeline), and free text is scrubbed of hidden test ids.
import { z } from 'zod';
import type { Document } from 'mongodb';
import type { Envelope } from '@/shared/mongomation';
import { withAtlas } from './atlas';
import { cached } from './cache';
import { date, idOf, num, redactHidden, str, strArr } from './docs';
import { parseArgs } from './errors';

export interface LineageNodeLite {
  relation: 'ancestor' | 'self' | 'descendant';
  depth: number;
  version: number;
  parent: number | null;
  verdict?: string;
  rationale?: string;
  createdAt?: string;
  rules: number;
  publicTests: number;
  publicPassed: number;
  projects: number;
}
export interface HarnessLineageData {
  root: number | null;
  nodes: LineageNodeLite[];
}

export interface TimelineEntryLite {
  at?: Date;
  source: 'event' | 'job' | 'test' | 'trace';
  kind?: string;
  text: string;
  level?: string;
  verdict?: string;
  ok?: boolean;
  jobId?: string;
}
export interface EvidenceTimelineData {
  projectId: string;
  entries: TimelineEntryLite[];
  counts: Record<string, number>;
}

function lineagePipeline(version: number | undefined, maxDepth: number): Document[] {
  const graph = (startWith: string, from: string, to: string, as: string) => ({
    $graphLookup: { from: 'harness_versions', startWith, connectFromField: from, connectToField: to, as, depthField: 'depth', maxDepth },
  });
  const tag = (input: string, relation: string) => ({
    $map: {
      input: { $sortArray: { input, sortBy: { version: 1 } } },
      as: 'n',
      in: { node: '$$n', relation, depth: { $add: ['$$n.depth', 1] } },
    },
  });
  return [
    ...(version === undefined ? [{ $sort: { version: -1 } }, { $limit: 1 }] : [{ $match: { version } }]),
    graph('$parent', 'parent', 'version', 'ancestors'),
    graph('$version', 'version', 'parent', 'descendants'),
    {
      $project: {
        _id: 0,
        root: '$version',
        chain: { $concatArrays: [tag('$ancestors', 'ancestor'), [{ node: '$$ROOT', relation: 'self', depth: 0 }], tag('$descendants', 'descendant')] },
      },
    },
    { $unwind: { path: '$chain', includeArrayIndex: 'order' } },
    {
      $lookup: {
        from: 'test_results',
        let: { v: '$chain.node.version' },
        pipeline: [
          { $match: { $expr: { $eq: ['$harnessVersion', '$$v'] }, visibility: 'public', superseded: { $ne: true } } },
          {
            $group: {
              _id: null,
              tests: { $sum: 1 },
              passed: { $sum: { $cond: [{ $eq: ['$verdict', 'passed'] }, 1, 0] } },
              projects: { $addToSet: '$projectId' },
            },
          },
          { $project: { _id: 0, tests: 1, passed: 1, projects: { $size: '$projects' } } },
        ],
        as: 'outcomes',
      },
    },
    {
      $project: {
        root: 1,
        order: 1,
        relation: '$chain.relation',
        depth: '$chain.depth',
        version: '$chain.node.version',
        parent: '$chain.node.parent',
        verdict: '$chain.node.verdict',
        rationale: '$chain.node.rationale',
        createdAt: '$chain.node.createdAt',
        rules: { $size: { $ifNull: ['$chain.node.rules', []] } },
        publicTests: { $ifNull: [{ $first: '$outcomes.tests' }, 0] },
        publicPassed: { $ifNull: [{ $first: '$outcomes.passed' }, 0] },
        projects: { $ifNull: [{ $first: '$outcomes.projects' }, 0] },
      },
    },
    { $sort: { order: 1 } },
  ];
}

const lineageArgs = z.object({
  version: z.number().int().min(0).optional(),
  maxDepth: z.number().int().min(1).max(100).optional(),
});

/** Harness version lineage: ancestors (parent chain) and descendants of a version (default: newest). */
export async function harnessLineage(args: unknown): Promise<Envelope<HarnessLineageData>> {
  const { version, maxDepth = 50 } = parseArgs(lineageArgs, args ?? {});
  return cached(`lineage:${version ?? 'latest'}:${maxDepth}`, () =>
    withAtlas<HarnessLineageData>(async (db) => {
      const docs = await db.collection('harness_versions').aggregate(lineagePipeline(version, maxDepth)).toArray();
      return {
        root: num(docs[0]?.root) ?? null,
        nodes: docs.map((d) => ({
          relation: (str(d.relation) ?? 'self') as LineageNodeLite['relation'],
          depth: num(d.depth) ?? 0,
          version: num(d.version) ?? 0,
          parent: num(d.parent) ?? null,
          verdict: str(d.verdict),
          rationale: str(d.rationale),
          createdAt: str(d.createdAt),
          rules: num(d.rules) ?? 0,
          publicTests: num(d.publicTests) ?? 0,
          publicPassed: num(d.publicPassed) ?? 0,
          projects: num(d.projects) ?? 0,
        })),
      };
    }),
  );
}

function timelinePipeline(projectId: string, jobIds: string[], limit: number): Document[] {
  return [
    { $match: { projectId } },
    { $project: { _id: 0, at: '$ts', source: 'event', kind: '$stage', level: '$level', text: '$message', jobId: '$jobId' } },
    {
      $unionWith: {
        coll: 'job_transitions',
        pipeline: [
          { $match: { jobId: { $in: jobIds } } },
          {
            $project: {
              _id: 0,
              at: '$at',
              source: 'job',
              kind: '$type',
              text: { $concat: [{ $ifNull: ['$from', '∅'] }, ' → ', { $ifNull: ['$to', '∅'] }] },
              jobId: '$jobId',
            },
          },
        ],
      },
    },
    {
      $unionWith: {
        coll: 'test_results',
        pipeline: [
          // Public only: hidden tests stay hidden.
          { $match: { projectId, visibility: 'public', superseded: { $ne: true } } },
          {
            $project: {
              _id: 0,
              at: '$startedAt',
              source: 'test',
              kind: '$category',
              text: { $concat: ['$testId', ': ', { $ifNull: ['$verdict', '?'] }] },
              verdict: '$verdict',
            },
          },
        ],
      },
    },
    {
      $unionWith: {
        coll: 'trace_refs',
        pipeline: [
          { $match: { runId: projectId } },
          { $project: { _id: 0, at: '$at', source: 'trace', kind: '$kind', text: '$name', ok: '$ok' } },
        ],
      },
    },
    { $set: { at: { $convert: { input: '$at', to: 'date', onError: null, onNull: null } } } },
    { $sort: { at: -1 } },
    { $limit: limit },
  ];
}

const timelineArgs = z.object({
  projectId: z.string().trim().min(1).max(64),
  limit: z.number().int().min(1).max(500).optional(),
});

/** One project's evidence stream: events + job transitions + public test results + trace refs, newest first. */
export async function evidenceTimeline(args: unknown): Promise<Envelope<EvidenceTimelineData>> {
  const { projectId, limit = 200 } = parseArgs(timelineArgs, args);
  return cached(`evidence:${projectId}:${limit}`, () =>
    withAtlas<EvidenceTimelineData>(async (db) => {
      const [jobs, hiddenIdValues] = await Promise.all([
        db.collection('jobs').find({ projectId }, { projection: { _id: 1 } }).limit(500).toArray(),
        db.collection('test_results').distinct('testId', { projectId, visibility: { $ne: 'public' }, superseded: { $ne: true } }),
      ]);
      const hiddenIds = strArr(hiddenIdValues);
      const docs = await db
        .collection('events')
        .aggregate(timelinePipeline(projectId, jobs.map((j) => idOf(j._id)), limit))
        .toArray();
      const counts: Record<string, number> = {};
      const entries = docs.map((d) => {
        const source = (str(d.source) ?? 'event') as TimelineEntryLite['source'];
        counts[source] = (counts[source] ?? 0) + 1;
        return {
          at: date(d.at),
          source,
          kind: str(d.kind),
          text: (redactHidden(str(d.text), hiddenIds) ?? '').slice(0, 600),
          level: str(d.level),
          verdict: str(d.verdict),
          ok: typeof d.ok === 'boolean' ? d.ok : undefined,
          jobId: str(d.jobId),
        };
      });
      return { projectId, entries, counts };
    }),
  );
}
