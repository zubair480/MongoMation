// Harness lineage and per-project evidence timeline, computed inside Atlas:
//   $graphLookup  walks harness_versions.parent -> version (ancestors) and version -> parent (descendants)
//   $lookup       public test outcomes per harness version on the chain
//   $unionWith    events + job_transitions + PUBLIC test_results + trace_refs as one time-ordered stream
// Read-only. Hidden tests never enter the timeline (visibility filter inside the $unionWith sub-pipeline).
import type { Document } from "mongodb";
import { analyticsRead, col } from "./index.ts";

/** Pipeline on `harness_versions`: the version (default: newest) with its ancestor chain and descendants. */
export function harnessLineagePipeline(version?: number, maxDepth = 50): Document[] {
  return [
    ...(version === undefined ? [{ $sort: { version: -1 } }, { $limit: 1 }] : [{ $match: { version } }]),
    {
      $graphLookup: {
        from: "harness_versions", startWith: "$parent", connectFromField: "parent", connectToField: "version",
        as: "ancestors", depthField: "depth", maxDepth,
      },
    },
    {
      $graphLookup: {
        from: "harness_versions", startWith: "$version", connectFromField: "version", connectToField: "parent",
        as: "descendants", depthField: "depth", maxDepth,
      },
    },
    {
      $project: {
        _id: 0,
        root: "$version",
        // Chain oldest -> root, then descendants; relation/depth say where each node sits.
        chain: {
          $concatArrays: [
            { $map: { input: { $sortArray: { input: "$ancestors", sortBy: { version: 1 } } }, as: "a", in: { node: "$$a", relation: "ancestor", depth: { $add: ["$$a.depth", 1] } } } },
            [{ node: "$$ROOT", relation: "self", depth: 0 }],
            { $map: { input: { $sortArray: { input: "$descendants", sortBy: { version: 1 } } }, as: "d", in: { node: "$$d", relation: "descendant", depth: { $add: ["$$d.depth", 1] } } } },
          ],
        },
      },
    },
    { $unwind: { path: "$chain", includeArrayIndex: "order" } },
    {
      $lookup: {
        from: "test_results",
        let: { v: "$chain.node.version" },
        pipeline: [
          { $match: { $expr: { $eq: ["$harnessVersion", "$$v"] }, visibility: "public", superseded: { $ne: true } } },
          { $group: { _id: null, tests: { $sum: 1 }, passed: { $sum: { $cond: [{ $eq: ["$verdict", "passed"] }, 1, 0] } }, projects: { $addToSet: "$projectId" } } },
          { $project: { _id: 0, tests: 1, passed: 1, projects: { $size: "$projects" } } },
        ],
        as: "outcomes",
      },
    },
    {
      $project: {
        root: 1, order: 1, relation: "$chain.relation", depth: "$chain.depth",
        version: "$chain.node.version", parent: "$chain.node.parent", verdict: "$chain.node.verdict",
        rationale: "$chain.node.rationale", createdAt: "$chain.node.createdAt",
        rules: { $size: { $ifNull: ["$chain.node.rules", []] } },
        publicTests: { $ifNull: [{ $first: "$outcomes.tests" }, 0] },
        publicPassed: { $ifNull: [{ $first: "$outcomes.passed" }, 0] },
        projects: { $ifNull: [{ $first: "$outcomes.projects" }, 0] },
      },
    },
    { $sort: { order: 1 } },
  ];
}

export interface LineageNode {
  root: number; order: number; relation: "ancestor" | "self" | "descendant"; depth: number;
  version: number; parent: number | null; verdict: string; rationale?: string; createdAt?: string;
  rules: number; publicTests: number; publicPassed: number; projects: number;
}

/** Harness version lineage via $graphLookup (newest version when `version` is omitted). */
export async function harnessLineage(version?: number): Promise<LineageNode[]> {
  return col.harness().aggregate<LineageNode>(harnessLineagePipeline(version), analyticsRead).toArray();
}

/** Pipeline on `events`: one project's evidence stream ($unionWith), newest first. */
export function evidenceTimelinePipeline(projectId: string, jobIds: string[], limit = 200): Document[] {
  return [
    { $match: { projectId } },
    { $project: { _id: 0, at: "$ts", source: "event", kind: "$stage", level: "$level", text: "$message", jobId: "$jobId" } },
    {
      $unionWith: {
        coll: "job_transitions",
        pipeline: [
          { $match: { jobId: { $in: jobIds } } },
          { $project: { _id: 0, at: "$at", source: "job", kind: "$type", text: { $concat: [{ $ifNull: ["$from", "∅"] }, " → ", { $ifNull: ["$to", "∅"] }] }, jobId: "$jobId", by: "$by" } },
        ],
      },
    },
    {
      $unionWith: {
        coll: "test_results",
        pipeline: [
          { $match: { projectId, visibility: "public", superseded: { $ne: true } } },
          { $project: { _id: 0, at: "$startedAt", source: "test", kind: "$category", text: { $concat: ["$testId", ": ", { $ifNull: ["$verdict", "?"] }] }, verdict: "$verdict", simRunId: { $toString: "$simRunId" }, harnessVersion: "$harnessVersion" } },
        ],
      },
    },
    {
      $unionWith: {
        coll: "trace_refs",
        pipeline: [
          { $match: { runId: projectId } },
          { $project: { _id: 0, at: "$at", source: "trace", kind: "$kind", text: "$name", ok: "$ok", eventId: "$eventId" } },
        ],
      },
    },
    { $set: { at: { $convert: { input: "$at", to: "date", onError: null, onNull: null } } } },
    { $sort: { at: -1 } },
    { $limit: limit },
  ];
}

/** Project evidence timeline: events, job transitions, public test results and trace refs, newest first. */
export async function evidenceTimeline(projectId: string, limit = 200) {
  const jobIds = (await col.jobs().find({ projectId }, { projection: { _id: 1 } }).toArray()).map((j) => String(j._id));
  return col.events().aggregate(evidenceTimelinePipeline(projectId, jobIds, limit), analyticsRead).toArray();
}
