// Time-series analytics over `measurements` (an Atlas time-series collection: timeField `ts`, metaField
// `meta` = { simRunId, testId }), computed inside Atlas with window functions:
//   $setWindowFields + $shift   gap between consecutive samples of a test, tag value transitions
//   $percentile                 p50 / p95 sampling gap per test
//   $dateTrunc + $densify + $fill   per-second sample counts with idle seconds filled as 0
//   $setWindowFields range window   5 s moving average and running total
//   $setWindowFields documents window  3-run rolling public pass rate (test_results)
// Only PUBLIC tests are analysed: hidden test ids and their measurements never reach the browser.
import type { Db, Document } from 'mongodb';
import type { AnalyticsData, AnalyticsSecond, AnalyticsTag, AnalyticsTest, RunTrendPoint } from '@/shared/insights';
import { date, idFilter, idOf, num, str } from './docs';

const SUPERSEDED_TEST_ID = /~attempt\d+$/;
const MAX_SECONDS = 1800;
const MAX_TAGS = 12;

async function latestSimRun(db: Db, projectId: string) {
  return db
    .collection('sim_runs')
    .find({ projectId }, { projection: { _id: 1, status: 1, startedAt: 1 } })
    .sort({ startedAt: -1 })
    .limit(1)
    .next();
}

/** Public, non-superseded tests of one sim run (id -> verdict) and how many hidden ones were skipped. */
async function testsOf(db: Db, simRunId: string) {
  const docs = await db
    .collection('test_results')
    .find(
      { simRunId: idFilter(simRunId), superseded: { $ne: true } },
      { projection: { testId: 1, visibility: 1, verdict: 1 } },
    )
    .limit(1000)
    .toArray();
  const publicTests = new Map<string, string | undefined>();
  let hidden = 0;
  for (const d of docs) {
    const id = str(d.testId);
    if (!id || SUPERSEDED_TEST_ID.test(id)) continue;
    if (str(d.visibility) === 'public') publicTests.set(id, str(d.verdict));
    else hidden++;
  }
  return { publicTests, hidden };
}

/** Per-sample gap to the previous sample of the same test ($shift inside a partition). */
function withGaps(simRunId: string, testIds: string[]): Document[] {
  return [
    { $match: { 'meta.simRunId': simRunId, 'meta.testId': { $in: testIds } } },
    {
      $setWindowFields: {
        partitionBy: '$meta.testId',
        sortBy: { ts: 1 },
        output: { prevTs: { $shift: { output: '$ts', by: -1 } } },
      },
    },
    {
      $set: {
        gapMs: {
          $cond: [{ $eq: ['$prevTs', null] }, null, { $dateDiff: { startDate: '$prevTs', endDate: '$ts', unit: 'millisecond' } }],
        },
      },
    },
  ];
}

export function perSecondPipeline(simRunId: string, testIds: string[]): Document[] {
  return [
    ...withGaps(simRunId, testIds),
    {
      $group: {
        _id: { $dateTrunc: { date: '$ts', unit: 'second' } },
        samples: { $sum: 1 },
        maxGapMs: { $max: '$gapMs' },
      },
    },
    { $project: { _id: 0, ts: '$_id', samples: 1, maxGapMs: 1 } },
    { $densify: { field: 'ts', range: { step: 1, unit: 'second', bounds: 'full' } } },
    { $fill: { output: { samples: { value: 0 } } } },
    {
      $setWindowFields: {
        sortBy: { ts: 1 },
        output: {
          avg5s: { $avg: '$samples', window: { range: [-4, 0], unit: 'second' } },
          cumulative: { $sum: '$samples', window: { documents: ['unbounded', 'current'] } },
        },
      },
    },
    { $limit: MAX_SECONDS },
  ];
}

export function perTestPipeline(simRunId: string, testIds: string[]): Document[] {
  return [
    ...withGaps(simRunId, testIds),
    {
      $group: {
        _id: '$meta.testId',
        samples: { $sum: 1 },
        first: { $min: '$ts' },
        last: { $max: '$ts' },
        maxGapMs: { $max: '$gapMs' },
        gapPct: { $percentile: { input: '$gapMs', p: [0.5, 0.95], method: 'approximate' } },
      },
    },
    { $sort: { first: 1 } },
  ];
}

/** Value changes per tag: unwind the `values` object and compare each value with the previous sample's. */
export function tagTransitionsPipeline(simRunId: string, testIds: string[]): Document[] {
  return [
    { $match: { 'meta.simRunId': simRunId, 'meta.testId': { $in: testIds } } },
    { $project: { _id: 0, ts: 1, testId: '$meta.testId', kv: { $objectToArray: '$values' } } },
    { $unwind: '$kv' },
    {
      $setWindowFields: {
        partitionBy: { test: '$testId', tag: '$kv.k' },
        sortBy: { ts: 1 },
        output: { prev: { $shift: { output: '$kv.v', by: -1 } } },
      },
    },
    {
      $group: {
        _id: '$kv.k',
        transitions: { $sum: { $cond: [{ $and: [{ $ne: ['$prev', null] }, { $ne: ['$prev', '$kv.v'] }] }, 1, 0] } },
        first: { $min: '$ts' },
        last: { $max: '$ts' },
      },
    },
    { $sort: { transitions: -1, _id: 1 } },
    { $limit: MAX_TAGS },
  ];
}

/** Public pass rate per sim run of a project, with a 3-run rolling mean. */
export function trendPipeline(projectId: string): Document[] {
  return [
    { $match: { projectId, visibility: 'public', superseded: { $ne: true } } },
    {
      $group: {
        _id: '$simRunId',
        startedAt: { $min: '$startedAt' },
        publicTotal: { $sum: 1 },
        publicPassed: { $sum: { $cond: [{ $eq: ['$verdict', 'passed'] }, 1, 0] } },
      },
    },
    { $set: { passRate: { $cond: [{ $gt: ['$publicTotal', 0] }, { $divide: ['$publicPassed', '$publicTotal'] }, null] } } },
    {
      $setWindowFields: {
        sortBy: { startedAt: 1 },
        output: { rolling3: { $avg: '$passRate', window: { documents: [-2, 'current'] } } },
      },
    },
    { $sort: { startedAt: 1 } },
    { $limit: 50 },
  ];
}

export async function measurementAnalytics(db: Db, projectId: string, requestedSimRunId?: string): Promise<AnalyticsData> {
  const t0 = Date.now();
  const run = requestedSimRunId
    ? await db.collection('sim_runs').findOne({ _id: idFilter(requestedSimRunId) } as Document, { projection: { status: 1 } })
    : await latestSimRun(db, projectId);
  const trendDocs = await db.collection('test_results').aggregate(trendPipeline(projectId)).toArray();
  const trend: RunTrendPoint[] = trendDocs.map((d) => ({
    simRunId: idOf(d._id),
    startedAt: date(d.startedAt),
    publicPassed: num(d.publicPassed) ?? 0,
    publicTotal: num(d.publicTotal) ?? 0,
    passRate: num(d.passRate),
    rolling3: num(d.rolling3),
  }));

  const empty: AnalyticsData = {
    simRunId: run ? idOf(run._id) : null,
    runStatus: run ? str(run.status) : undefined,
    series: [],
    tests: [],
    tags: [],
    hiddenTestsExcluded: 0,
    totalSamples: 0,
    trend,
    computedInMs: 0,
  };
  if (!run) return { ...empty, computedInMs: Date.now() - t0 };

  const simRunId = idOf(run._id);
  const { publicTests, hidden } = await testsOf(db, simRunId);
  const ids = [...publicTests.keys()];
  if (!ids.length) return { ...empty, hiddenTestsExcluded: hidden, computedInMs: Date.now() - t0 };

  const m = db.collection('measurements');
  const [secondDocs, testDocs, tagDocs] = await Promise.all([
    m.aggregate(perSecondPipeline(simRunId, ids), { allowDiskUse: true }).toArray(),
    m.aggregate(perTestPipeline(simRunId, ids), { allowDiskUse: true }).toArray(),
    m.aggregate(tagTransitionsPipeline(simRunId, ids), { allowDiskUse: true }).toArray(),
  ]);

  const series: AnalyticsSecond[] = secondDocs
    .map((d) => ({
      ts: date(d.ts) as Date,
      samples: num(d.samples) ?? 0,
      avg5s: num(d.avg5s) ?? 0,
      cumulative: num(d.cumulative) ?? 0,
      maxGapMs: num(d.maxGapMs),
    }))
    .filter((s) => s.ts);

  const tests: AnalyticsTest[] = testDocs.map((d) => {
    const first = date(d.first);
    const last = date(d.last);
    const durationMs = first && last ? last.getTime() - first.getTime() : 0;
    const samples = num(d.samples) ?? 0;
    const pct = Array.isArray(d.gapPct) ? d.gapPct.map((x: unknown) => num(x)) : [];
    const testId = idOf(d._id);
    return {
      testId,
      samples,
      durationMs,
      rateHz: durationMs > 0 ? samples / (durationMs / 1000) : undefined,
      p50GapMs: pct[0],
      p95GapMs: pct[1],
      maxGapMs: num(d.maxGapMs),
      verdict: publicTests.get(testId),
    };
  });

  const tags: AnalyticsTag[] = tagDocs.map((d) => {
    const first = date(d.first);
    const last = date(d.last);
    const minutes = first && last ? (last.getTime() - first.getTime()) / 60_000 : 0;
    const transitions = num(d.transitions) ?? 0;
    return { tag: idOf(d._id), transitions, perMinute: minutes > 0 ? transitions / minutes : undefined };
  });

  return {
    ...empty,
    simRunId,
    series,
    tests,
    tags,
    hiddenTestsExcluded: hidden,
    totalSamples: series.length ? series[series.length - 1].cumulative : 0,
    computedInMs: Date.now() - t0,
  };
}
