// App-owned features backed by Modelence Stores: operator notes, saved AI explanations, ops alerts /
// digests (written by crons.ts) and per-user preferences. Reads are live queries driven by Store change
// streams; writes go through guards.ts (auth, verified email, roles, rate limits).
import { z } from 'zod';
import { generateText } from '@modelence/ai';
import { ValidationError } from 'modelence';
import { LiveData, ObjectId, getConfig, type UserInfo } from 'modelence/server';
import { logInfo, startTransaction } from 'modelence/telemetry';
import type { ProjectData } from '@/shared/mongomation';
import { NOTE_MAX_CHARS, type NoteLite, type NotesData, type OpsData } from '@/shared/insights';
import { errorMessage } from './atlas';
import { cronList } from './crons';
import { BlockedError, parseArgs } from './errors';
import { guard, hasAnyRole, isVerified, type MethodCtx } from './guards';
import { project as projectQuery } from './queries';
import { dbNotes, dbOpsAlerts, dbOpsDigests, dbPreferences } from './stores';

const projectId = z.string().trim().min(1).max(64);

function storesAvailable(): { ok: true } | { ok: false; reason: string } {
  return getConfig('_system.mongodbUri')
    ? { ok: true }
    : { ok: false, reason: "Modelence's own database is not configured (MONGODB_URI locally, or connect the app to Modelence Cloud)" };
}

/** Wakes a LiveData on any write to the given Stores; falls back to a slow interval if watching fails. */
function watchStores(stores: { watch: typeof dbNotes.watch }[], publish: () => void, intervalMs = 30_000) {
  const streams = stores.map((s) => {
    try {
      const cs = s.watch([], {});
      cs.on('change', () => publish());
      cs.on('error', () => undefined);
      return cs;
    } catch {
      return null;
    }
  });
  const beat = setInterval(publish, intervalMs);
  return () => {
    clearInterval(beat);
    for (const cs of streams) void cs?.close().catch(() => undefined);
  };
}

// ---- AI provider (non-Claude: the worker's Claude usage is untouched) ----------------------------------

type AiProvider = 'openai' | 'google';
const PROVIDER_KEY: Record<AiProvider, string> = { openai: '_system.openai.apiKey', google: '_system.gemini.apiKey' };

function aiSettings() {
  const raw = String(getConfig('mongomation.aiProvider') || 'google').toLowerCase();
  const provider: AiProvider = raw === 'openai' ? 'openai' : 'google';
  const model = String(getConfig('mongomation.aiModel') || (provider === 'openai' ? 'gpt-4o-mini' : 'gemini-2.5-flash'));
  const configured = Boolean(getConfig(PROVIDER_KEY[provider]));
  return { provider, model, configured };
}

// ---- notes ---------------------------------------------------------------------------------------------

function toNote(d: typeof dbNotes.Doc, viewer: UserInfo | null): NoteLite {
  return {
    id: d._id.toString(),
    projectId: d.projectId,
    kind: d.kind,
    body: d.body,
    authorHandle: d.authorHandle,
    createdAt: d.createdAt,
    provider: d.provider,
    model: d.model,
    mine: !!viewer && d.authorId.toString() === viewer.id,
  };
}

async function readNotes(pid: string, user: UserInfo | null): Promise<NotesData> {
  const ai = aiSettings();
  const avail = storesAvailable();
  const viewer = {
    signedIn: !!user,
    verified: avail.ok && user ? await isVerified(user).catch(() => false) : false,
    roles: user?.roles ?? [],
  };
  const aiInfo = { configured: ai.configured, provider: ai.provider, model: ai.model };
  if (!avail.ok) return { available: false, reason: avail.reason, items: [], ai: aiInfo, viewer };
  const docs = await dbNotes.fetch({ projectId: pid }, { sort: { createdAt: -1 }, limit: 50 });
  return { available: true, items: docs.map((d) => toNote(d, user)), ai: aiInfo, viewer };
}

export function liveNotes(args: unknown, { user }: MethodCtx) {
  const { projectId: pid } = parseArgs(z.object({ projectId }), args);
  return new LiveData<NotesData>({
    fetch: () => readNotes(pid, user),
    watch: ({ publish }) => (storesAvailable().ok ? watchStores([dbNotes], publish) : undefined),
  });
}

export async function addNote(args: unknown, ctx: MethodCtx) {
  const me = await guard('mm.note', ctx);
  const input = parseArgs(z.object({ projectId, body: z.string().trim().min(1).max(NOTE_MAX_CHARS) }), args);
  const { insertedId } = await dbNotes.insertOne({
    projectId: input.projectId,
    kind: 'note',
    body: input.body,
    authorId: new ObjectId(me.id),
    authorHandle: me.handle,
    createdAt: new Date(),
  });
  return { noteId: insertedId.toString() };
}

export async function deleteNote(args: unknown, ctx: MethodCtx) {
  const me = await guard('mm.note', ctx);
  const { noteId } = parseArgs(z.object({ noteId: z.string().regex(/^[0-9a-f]{24}$/i) }), args);
  const doc = await dbNotes.findById(noteId);
  if (!doc) throw new ValidationError('Note not found');
  if (doc.authorId.toString() !== me.id && !hasAnyRole(me, ['admin'])) {
    throw new BlockedError('BLOCKED: only the author or an admin can delete this note');
  }
  await dbNotes.deleteOne({ _id: doc._id });
  return { deleted: true };
}

/** Builds the prompt ONLY from what the dashboard already shows publicly (hidden tests stay hidden). */
function failureBrief(data: ProjectData): string | null {
  const failed = data.tests.filter((t) => t.visibility === 'public' && t.verdict && t.verdict !== 'passed');
  const hiddenFailed = data.tests.filter((t) => t.visibility === 'hidden' && t.verdict && t.verdict !== 'passed').length;
  const stageErrors = data.stages.filter((s) => s.error).map((s) => `- ${s.stage} (attempt ${s.attempt}): ${s.error}`);
  if (!failed.length && !hiddenFailed && !stageErrors.length && !data.diagnosis) return null;
  const lines = [
    `Machine spec: ${(data.project?.specText ?? '').slice(0, 1500)}`,
    `Latest sim run: ${data.simRun?.status ?? 'unknown'}; tests passed ${data.testCounts.passed}, failed ${data.testCounts.failed}, blocked ${data.testCounts.blocked} of ${data.testCounts.total}.`,
    hiddenFailed ? `${hiddenFailed} hidden safety test(s) also did not pass (details are confidential).` : '',
    failed.length ? 'Failing public tests:' : '',
    ...failed.slice(0, 12).map((t) => {
      const bad = t.assertions.filter((a) => a.passed === false).slice(0, 4);
      return `- ${t.testId ?? t.title} [${t.verdict}] ${t.title}${t.blockedReason ? ` (blocked: ${t.blockedReason})` : ''}${
        bad.length ? `\n  failed assertions: ${bad.map((a) => `${a.label ?? '?'}${a.detail ? ` (${a.detail})` : ''}`).join('; ')}` : ''
      }`;
    }),
    stageErrors.length ? 'Stage errors:' : '',
    ...stageErrors.slice(0, 8),
    data.diagnosis?.summary ? `Worker diagnosis: ${data.diagnosis.summary}` : '',
  ];
  return lines.filter(Boolean).join('\n').slice(0, 6000);
}

export async function explainFailure(args: unknown, ctx: MethodCtx) {
  const me = await guard('mm.ai', ctx);
  const { projectId: pid } = parseArgs(z.object({ projectId }), args);
  const ai = aiSettings();
  if (!ai.configured) {
    throw new BlockedError(
      `BLOCKED: no ${ai.provider === 'google' ? 'Gemini' : 'OpenAI'} key. Add it in Modelence Cloud → AI → Integrations (or set mongomation.aiProvider).`,
    );
  }
  const data = await projectQuery({ projectId: pid });
  if (!data.connected) throw new BlockedError(`BLOCKED: Atlas unavailable: ${data.error}`);
  const brief = failureBrief(data);
  if (!brief) throw new BlockedError('BLOCKED: nothing has failed in this project yet');

  const tx = startTransaction('ai', 'mongomation.explainFailure', { provider: ai.provider, model: ai.model });
  try {
    const res = await generateText({
      provider: ai.provider,
      model: ai.model,
      system:
        'You explain PLC automation test failures to an operator in plain language. Be concrete and brief: at most 5 bullet points, ' +
        'naming the likely cause and the next thing to check. Never invent test names or data not given.',
      prompt: brief,
      maxOutputTokens: 500,
    });
    const text = res.text.trim().slice(0, 4000);
    const { insertedId } = await dbNotes.insertOne({
      projectId: pid,
      kind: 'ai',
      body: text || '(empty answer)',
      authorId: new ObjectId(me.id),
      authorHandle: me.handle,
      provider: ai.provider,
      model: ai.model,
      simRunId: data.simRun?.id,
      createdAt: new Date(),
    });
    tx.end('success');
    logInfo('mongomation explainFailure', { projectId: pid, provider: ai.provider });
    return { noteId: insertedId.toString() };
  } catch (err) {
    tx.end('error', { error: errorMessage(err) });
    throw new BlockedError(`AI request failed: ${errorMessage(err)}`);
  }
}

// ---- ops (alerts + digests written by the cron jobs) ------------------------------------------------------

async function readOps(user: UserInfo | null): Promise<OpsData> {
  const canAcknowledge = hasAnyRole(user, ['admin', 'operator']);
  const avail = storesAvailable();
  if (!avail.ok) return { available: false, reason: avail.reason, alerts: [], digest: null, canAcknowledge, crons: cronList };
  const [alerts, digests] = await Promise.all([
    dbOpsAlerts.fetch({}, { sort: { lastSeenAt: -1 }, limit: 20 }),
    dbOpsDigests.fetch({}, { sort: { createdAt: -1 }, limit: 1 }),
  ]);
  const d = digests[0];
  return {
    available: true,
    alerts: alerts.map((a) => ({
      id: a._id.toString(),
      kind: a.kind,
      severity: a.severity,
      message: a.message,
      subjectId: a.subjectId,
      openedAt: a.openedAt,
      lastSeenAt: a.lastSeenAt,
      resolvedAt: a.resolvedAt,
      acknowledgedBy: a.acknowledgedBy,
    })),
    digest: d
      ? { createdAt: d.createdAt, windowHours: d.windowHours, jobs: d.jobs, tests: d.tests, samples: d.samples, projects: d.projects }
      : null,
    canAcknowledge,
    crons: cronList,
  };
}

export function liveOps(_args: unknown, { user }: MethodCtx) {
  return new LiveData<OpsData>({
    fetch: () => readOps(user),
    watch: ({ publish }) => (storesAvailable().ok ? watchStores([dbOpsAlerts, dbOpsDigests], publish) : undefined),
  });
}

export async function acknowledgeAlert(args: unknown, ctx: MethodCtx) {
  const me = await guard('mm.ops', ctx, { roles: ['admin', 'operator'] });
  const { alertId } = parseArgs(z.object({ alertId: z.string().regex(/^[0-9a-f]{24}$/i) }), args);
  const res = await dbOpsAlerts.updateOne({ _id: new ObjectId(alertId) }, { $set: { acknowledgedBy: me.handle } });
  if (!res.matchedCount) throw new ValidationError('Alert not found');
  return { acknowledged: true };
}

// ---- preferences ---------------------------------------------------------------------------------------------

export async function preferences(_args: unknown, { user }: MethodCtx) {
  if (!user || !storesAvailable().ok) return { pinnedProjectId: null, analyticsView: 'rate' as const };
  const doc = await dbPreferences.findOne({ userId: new ObjectId(user.id) });
  return { pinnedProjectId: doc?.pinnedProjectId ?? null, analyticsView: doc?.analyticsView ?? 'rate' };
}

export async function savePreferences(args: unknown, ctx: MethodCtx) {
  const me = await guard('mm.note', ctx);
  const input = parseArgs(
    z.object({ pinnedProjectId: projectId.nullable().optional(), analyticsView: z.enum(['rate', 'cumulative']).optional() }),
    args,
  );
  const set: { updatedAt: Date; pinnedProjectId?: string; analyticsView?: 'rate' | 'cumulative' } = { updatedAt: new Date() };
  if (input.pinnedProjectId) set.pinnedProjectId = input.pinnedProjectId;
  if (input.analyticsView) set.analyticsView = input.analyticsView;
  await dbPreferences.upsertOne(
    { userId: new ObjectId(me.id) },
    { $set: set, ...(input.pinnedProjectId === null ? { $unset: { pinnedProjectId: '' } } : {}) },
  );
  return { saved: true };
}
