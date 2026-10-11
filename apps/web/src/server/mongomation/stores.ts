// App-owned data, kept in Modelence's OWN database as Modelence Stores (schema + indexes reconciled by
// Modelence at startup). Worker-owned collections stay on the raw Atlas client (atlas.ts) so Modelence
// never touches the worker's indexes. All collection names are prefixed `mm` to stay clear of both.
import { Store, schema } from 'modelence/server';

/** Operator notes and saved AI explanations on a project. */
export const dbNotes = new Store('mmNotes', {
  schema: {
    projectId: schema.string(),
    kind: schema.enum(['note', 'ai']),
    body: schema.string(),
    authorId: schema.userId(),
    authorHandle: schema.string(),
    provider: schema.string().optional(),
    model: schema.string().optional(),
    simRunId: schema.string().optional(),
    createdAt: schema.date(),
  },
  indexes: [{ key: { projectId: 1, createdAt: -1 } }, { key: { authorId: 1, createdAt: -1 } }],
});

/** Per-user dashboard preferences (followed project, analytics view). */
export const dbPreferences = new Store('mmPreferences', {
  schema: {
    userId: schema.userId(),
    pinnedProjectId: schema.string().optional(),
    analyticsView: schema.enum(['rate', 'cumulative']).optional(),
    updatedAt: schema.date(),
  },
  indexes: [{ key: { userId: 1 }, unique: true }],
});

/** Alerts opened / refreshed / resolved by the ops cron jobs. `key` identifies the condition. */
export const dbOpsAlerts = new Store('mmOpsAlerts', {
  schema: {
    key: schema.string(),
    kind: schema.enum(['rig_stale', 'job_stale', 'worker_silent', 'queue_backlog']),
    severity: schema.enum(['info', 'warn', 'critical']),
    message: schema.string(),
    subjectId: schema.string().optional(),
    openedAt: schema.date(),
    lastSeenAt: schema.date(),
    resolvedAt: schema.date().optional(),
    acknowledgedBy: schema.string().optional(),
  },
  indexes: [{ key: { key: 1, resolvedAt: 1 } }, { key: { lastSeenAt: -1 } }],
});

/** Periodic run summaries written by the `opsDigest` cron job. */
export const dbOpsDigests = new Store('mmOpsDigests', {
  schema: {
    createdAt: schema.date(),
    windowHours: schema.number(),
    jobs: schema.object({
      total: schema.number(),
      completed: schema.number(),
      failed: schema.number(),
      blocked: schema.number(),
      active: schema.number(),
      queued: schema.number(),
    }),
    tests: schema.object({
      total: schema.number(),
      passed: schema.number(),
      failed: schema.number(),
      blocked: schema.number(),
    }),
    samples: schema.number(),
    projects: schema.number(),
  },
  indexes: [{ key: { createdAt: -1 } }],
});

export const appStores = [dbNotes, dbPreferences, dbOpsAlerts, dbOpsDigests];
