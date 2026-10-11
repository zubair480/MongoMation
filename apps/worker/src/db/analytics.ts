// Time-series analytics over the `measurements` collection (Atlas time series: timeField `ts`, metaField
// `meta` = {simRunId, testId}; each doc = one sample, `values` = {tag: bool | number}). Everything here is computed
// server-side by the aggregation engine — window functions, gap filling, auto-bucketing, faceted summaries — so the
// dashboard can call these directly and render the result. Read-only; reads go to a fresh secondary when one is
// available (analyticsRead). Booleans are treated as 0/1 so a tag's mean is its duty cycle.
import type { Document } from "mongodb";
import { analyticsRead, col } from "./index.ts";

const num = (expr: unknown) => ({ $convert: { input: expr, to: "double", onError: null, onNull: null } });
const runMatch = (simRunId: string, testId?: string) => ({ $match: { "meta.simRunId": simRunId, ...(testId && { "meta.testId": testId }) } });
const agg = <T extends Document = Document>(pipeline: Document[]) => col.measurements().aggregate<T>(pipeline, analyticsRead).toArray();

/** Tags present in a run (or one test of it). */
export async function tagsOf(simRunId: string, testId?: string): Promise<string[]> {
  const r = await agg<{ _id: string }>([
    runMatch(simRunId, testId),
    { $project: { kv: { $objectToArray: "$values" } } },
    { $unwind: "$kv" },
    { $group: { _id: "$kv.k" } },
    { $sort: { _id: 1 } },
  ]);
  return r.map((x) => x._id);
}

export interface SignalPoint {
  ts: Date;
  t: number;
  v: number | null;
  /** Moving average over the last `window` samples (= duty cycle for a boolean). */
  movingAvg: number | null;
  /** d(value)/dt per second ($derivative over the previous sample). */
  rate: number | null;
  /** 1 when the value differs from the previous sample (an edge), else 0. */
  edge: 0 | 1;
}

/** One tag of one test as a series with $setWindowFields: moving average, derivative and edge detection. */
export async function signalSeries(simRunId: string, testId: string, tag: string, window = 5): Promise<SignalPoint[]> {
  return agg<SignalPoint>([
    runMatch(simRunId, testId),
    { $project: { _id: 0, ts: 1, t: 1, v: num({ $getField: { field: tag, input: "$values" } }) } },
    {
      $setWindowFields: {
        sortBy: { ts: 1 },
        output: {
          movingAvg: { $avg: "$v", window: { documents: [-(Math.max(1, window) - 1), 0] } },
          rate: { $derivative: { input: "$v", unit: "second" }, window: { documents: [-1, 0] } },
          prev: { $shift: { output: "$v", by: -1 } },
        },
      },
    },
    { $set: { edge: { $cond: [{ $and: [{ $ne: ["$prev", null] }, { $ne: ["$prev", "$v"] }] }, 1, 0] } } },
    { $unset: "prev" },
  ]);
}

/**
 * Regular-grid timeline for one test: $densify inserts a point every `stepMs`, $fill carries every tag's last
 * observed value forward (LOCF) — what a PLC trend viewer shows. `filled: true` marks synthesized points.
 */
export async function densifiedTimeline(simRunId: string, testId: string, stepMs = 100, maxPoints = 2_000) {
  const tags = await tagsOf(simRunId, testId);
  if (!tags.length) return [];
  // Tag names can contain "." or spaces ("Transf. right"), which are not usable as $fill paths: fill positional
  // fields f0..fN instead and rebuild `values` with $arrayToObject.
  const f = (i: number) => `f${i}`;
  return agg([
    runMatch(simRunId, testId),
    { $set: { filled: false, ...Object.fromEntries(tags.map((tg, i) => [f(i), { $getField: { field: tg, input: "$values" } }])) } },
    { $densify: { field: "ts", range: { step: Math.max(1, Math.round(stepMs)), unit: "millisecond", bounds: "full" } } },
    {
      $fill: {
        sortBy: { ts: 1 },
        output: Object.fromEntries([["filled", { value: true }], ...tags.map((_, i) => [f(i), { method: "locf" }])]),
      },
    },
    { $project: { _id: 0, ts: 1, filled: 1, values: { $arrayToObject: [tags.map((tg, i) => ({ k: tg, v: `$${f(i)}` }))] } } },
    { $limit: maxPoints },
  ]);
}

/** Downsampling for long runs: $bucketAuto splits the test into ~`buckets` equal-population bins over `t`. */
export async function downsample(simRunId: string, testId: string, tag: string, buckets = 50) {
  return agg<{ _id: { min: number; max: number }; n: number; mean: number | null; min: number | null; max: number | null }>([
    runMatch(simRunId, testId),
    { $set: { v: num({ $getField: { field: tag, input: "$values" } }) } },
    { $bucketAuto: { groupBy: "$t", buckets, output: { n: { $sum: 1 }, mean: { $avg: "$v" }, min: { $min: "$v" }, max: { $max: "$v" } } } },
  ]);
}

/**
 * One-call summary of a sim run with $facet: totals, per-test span/sample counts, and per-tag duty cycle plus edge
 * counts (edges computed with a $shift window partitioned by test+tag).
 */
export async function runSummary(simRunId: string) {
  const [r] = await agg<{
    totals: { samples: number; tests: number; first: Date; last: Date }[];
    perTest: { testId: string; samples: number; first: Date; last: Date; spanMs: number }[];
    perTag: { tag: string; dutyCycle: number | null; edges: number; samples: number }[];
  }>([
    runMatch(simRunId),
    {
      $facet: {
        totals: [{ $group: { _id: null, samples: { $sum: 1 }, tests: { $addToSet: "$meta.testId" }, first: { $min: "$ts" }, last: { $max: "$ts" } } }, { $project: { _id: 0, samples: 1, tests: { $size: "$tests" }, first: 1, last: 1 } }],
        perTest: [
          { $group: { _id: "$meta.testId", samples: { $sum: 1 }, first: { $min: "$ts" }, last: { $max: "$ts" } } },
          { $project: { _id: 0, testId: "$_id", samples: 1, first: 1, last: 1, spanMs: { $dateDiff: { startDate: "$first", endDate: "$last", unit: "millisecond" } } } },
          { $sort: { first: 1 } },
        ],
        perTag: [
          { $project: { ts: 1, testId: "$meta.testId", kv: { $objectToArray: "$values" } } },
          { $unwind: "$kv" },
          { $project: { ts: 1, testId: 1, tag: "$kv.k", v: num("$kv.v") } },
          { $setWindowFields: { partitionBy: { test: "$testId", tag: "$tag" }, sortBy: { ts: 1 }, output: { prev: { $shift: { output: "$v", by: -1 } } } } },
          { $group: { _id: "$tag", dutyCycle: { $avg: "$v" }, samples: { $sum: 1 }, edges: { $sum: { $cond: [{ $and: [{ $ne: ["$prev", null] }, { $ne: ["$prev", "$v"] }] }, 1, 0] } } } },
          { $project: { _id: 0, tag: "$_id", dutyCycle: 1, edges: 1, samples: 1 } },
          { $sort: { tag: 1 } },
        ],
      },
    },
  ]);
  return { totals: r?.totals[0] ?? null, perTest: r?.perTest ?? [], perTag: r?.perTag ?? [] };
}

/**
 * Regression drift for one test across runs: sample span per run with a moving average over the last `window`
 * runs and the change vs the previous run ($setWindowFields over runs, ordered by time).
 */
export async function testTrend(testId: string, window = 3, limitRuns = 50) {
  return agg<{ simRunId: string; first: Date; spanMs: number; samples: number; spanMovingAvg: number; spanDelta: number | null }>([
    { $match: { "meta.testId": testId } },
    { $group: { _id: "$meta.simRunId", first: { $min: "$ts" }, last: { $max: "$ts" }, samples: { $sum: 1 } } },
    { $project: { _id: 0, simRunId: "$_id", first: 1, samples: 1, spanMs: { $dateDiff: { startDate: "$first", endDate: "$last", unit: "millisecond" } } } },
    { $sort: { first: -1 } },
    { $limit: limitRuns },
    {
      $setWindowFields: {
        sortBy: { first: 1 },
        output: {
          spanMovingAvg: { $avg: "$spanMs", window: { documents: [-(Math.max(1, window) - 1), 0] } },
          prevSpan: { $shift: { output: "$spanMs", by: -1 } },
        },
      },
    },
    { $set: { spanDelta: { $cond: [{ $eq: ["$prevSpan", null] }, null, { $subtract: ["$spanMs", "$prevSpan"] }] } } },
    { $unset: "prevSpan" },
  ]);
}

/** Recent sim runs that have measurements (newest first) — entry point for a dashboard picker. */
export async function recentRuns(limit = 20) {
  return agg<{ simRunId: string; last: Date; samples: number; tests: number }>([
    { $group: { _id: "$meta.simRunId", last: { $max: "$ts" }, samples: { $sum: 1 }, tests: { $addToSet: "$meta.testId" } } },
    { $sort: { last: -1 } },
    { $limit: limit },
    { $project: { _id: 0, simRunId: "$_id", last: 1, samples: 1, tests: { $size: "$tests" } } },
  ]);
}
