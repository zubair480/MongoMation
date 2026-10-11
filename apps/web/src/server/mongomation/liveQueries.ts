// Live variants of the dashboard reads (Modelence live queries: the client subscribes over the Modelence
// websocket with `modelenceLiveQuery`, the server pushes a fresh snapshot whenever the shared Atlas change
// stream reports a relevant write). The plain HTTP queries in queries.ts stay for scripts and curl.
import { z } from 'zod';
import type { AnalyticsData } from '@/shared/insights';
import type { Envelope } from '@/shared/mongomation';
import { withAtlas } from './atlas';
import { cached } from './cache';
import { measurementAnalytics } from './analytics';
import { parseArgs } from './errors';
import { forProject, inCollections, liveFromAtlas } from './live';
import { ablation, dashboard, project, rsi, scenes } from './queries';

const projectArgs = z.object({ projectId: z.string().trim().min(1).max(64) });

export function liveDashboard() {
  return liveFromAtlas(dashboard, {
    match: inCollections('jobs', 'workers', 'rig_status', 'projects', 'stages'),
    throttleMs: 300,
  });
}

export function liveScenes() {
  return liveFromAtlas(scenes, { match: inCollections('scenes'), heartbeatMs: 60_000 });
}

export function liveProject(args: unknown) {
  const { projectId } = parseArgs(projectArgs, args);
  return liveFromAtlas(() => project({ projectId }), {
    match: (c) =>
      (c.coll === 'projects' && (!c.projectId || c.projectId === projectId)) ||
      forProject(
        projectId,
        'stages',
        'events',
        'requirements',
        'plc_versions',
        'compile_results',
        'sim_runs',
        'test_results',
        'fault_injections',
        'diagnoses',
      )(c),
  });
}

export function liveRsi() {
  return liveFromAtlas(rsi, { match: inCollections('harness_versions', 'rsi_proposals'), throttleMs: 800 });
}

export function liveAblation() {
  return liveFromAtlas(ablation, { match: inCollections('benchmark_runs'), throttleMs: 1500, heartbeatMs: 60_000 });
}

/** Window-function analytics over the project's newest sim run; refreshes as test results land. */
export function liveAnalytics(args: unknown) {
  const { projectId } = parseArgs(projectArgs, args);
  const read = () =>
    cached(`analytics:${projectId}`, () => withAtlas<AnalyticsData>((db) => measurementAnalytics(db, projectId)), 2000) as Promise<
      Envelope<AnalyticsData>
    >;
  return liveFromAtlas(read, {
    match: forProject(projectId, 'sim_runs', 'test_results'),
    throttleMs: 1500,
    heartbeatMs: 30_000,
  });
}
