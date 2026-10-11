// Mutations: the ONLY writes the dashboard makes, and they all go to `jobs` (requests for the worker).
// Each one requires a signed-in user, validates its arguments with zod, and re-checks the same
// preconditions the UI shows, so a blocked request is refused on the server even if the UI is bypassed.
import { z } from 'zod';
import { AuthError, ModelenceError, ValidationError } from 'modelence';
import type { UserInfo } from 'modelence/server';
import type { Db, Document } from 'mongodb';
import {
  MAX_QUEUED_PER_TYPE,
  SPEC_MAX_CHARS,
  SPEC_MIN_CHARS,
  faultPreconditionFailures,
  sceneRunBlocker,
  type ExampleCreated,
  type JobCreated,
  type JobType,
} from '@/shared/mongomation';
import { errorMessage, getAtlasDb } from './atlas';
import { invalidate } from './cache';
import { idFilter, idOf, objArr, str, toRig } from './docs';
import { BlockedError, DisconnectedError, parseArgs } from './errors';
import { EXAMPLES } from './examples';

type Ctx = { user: UserInfo | null };

const specText = z
  .string()
  .trim()
  .min(SPEC_MIN_CHARS, `describe the machine in at least ${SPEC_MIN_CHARS} characters`)
  .max(SPEC_MAX_CHARS);
const sceneId = z.string().trim().regex(/^[a-z0-9-]+$/, 'scene ids are lowercase letters, digits and dashes').max(100);
const projectId = z.string().trim().min(1).max(64);

function requireUser(user: UserInfo | null): UserInfo {
  if (!user) throw new AuthError('Sign in to send requests to the MongoMation worker');
  return user;
}

/** Runs a write against Atlas; database failures surface as DISCONNECTED with the real driver message. */
async function withWriteDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  let db: Db;
  try {
    db = await getAtlasDb();
  } catch (err) {
    throw new DisconnectedError(`DISCONNECTED: ${errorMessage(err)}`);
  }
  try {
    return await fn(db);
  } catch (err) {
    if (err instanceof ModelenceError) throw err;
    throw new DisconnectedError(`Atlas request failed: ${errorMessage(err)}`);
  }
}

async function enqueue(db: Db, user: UserInfo, job: { type: JobType; origin: 'custom' | 'example' } & Document): Promise<JobCreated> {
  const jobs = db.collection('jobs');
  const waiting = await jobs.countDocuments({ type: job.type, status: 'queued' });
  if (waiting >= MAX_QUEUED_PER_TYPE) {
    throw new BlockedError(
      `BLOCKED: ${waiting} "${job.type}" jobs are already waiting for a worker. Wait until the worker claims them.`
    );
  }
  const { insertedId } = await jobs.insertOne({
    ...job,
    status: 'queued',
    attempts: 0,
    createdAt: new Date(),
    requestedBy: user.id,
  });
  // The button chips read the newest job of each type: show the new one on the very next poll.
  invalidate('dashboard');
  return { jobId: insertedId.toHexString() };
}

async function requireRunnableScene(db: Db, id: string, context: string) {
  const scene = await db.collection('scenes').findOne({ id }, { projection: { verified: 1 } });
  const blocker = sceneRunBlocker(id, scene ? { verified: scene.verified === true } : null);
  if (blocker) throw new BlockedError(`BLOCKED: ${context}: ${blocker}`);
}

async function requireProject(db: Db, id: string) {
  const doc = await db
    .collection('projects')
    .findOne({ _id: idFilter(id) } as Document, { projection: { sceneId: 1, finalPlcVersionId: 1 } });
  if (!doc) throw new BlockedError(`BLOCKED: project ${id} does not exist in Atlas`);
  return { id: idOf(doc._id), sceneId: str(doc.sceneId), finalPlcVersionId: str(doc.finalPlcVersionId) };
}

// ---- engineering ----------------------------------------------------------------------------------

export async function generate(args: unknown, { user }: Ctx): Promise<JobCreated> {
  const me = requireUser(user);
  const input = parseArgs(z.object({ specText, sceneId }), args);
  return withWriteDb(async (db) => {
    await requireRunnableScene(db, input.sceneId, 'cannot engineer on this scene');
    return enqueue(db, me, { type: 'engineer', origin: 'custom', specText: input.specText, sceneId: input.sceneId });
  });
}

export async function runExample(args: unknown, { user }: Ctx): Promise<ExampleCreated> {
  const me = requireUser(user);
  const { exampleId } = parseArgs(z.object({ exampleId: z.string().trim().min(1).max(64) }), args);
  const example = EXAMPLES.find((e) => e.id === exampleId);
  if (!example) throw new ValidationError(`Unknown example "${exampleId}"`);
  return withWriteDb(async (db) => {
    await requireRunnableScene(db, example.sceneId, `example "${example.title}" needs scene "${example.sceneId}"`);
    const job = await enqueue(db, me, {
      type: 'engineer',
      origin: 'example',
      specText: example.specText,
      sceneId: example.sceneId,
    });
    return { ...job, exampleId: example.id, specText: example.specText, sceneId: example.sceneId };
  });
}

export async function injectFaultAndImprove(args: unknown, { user }: Ctx): Promise<JobCreated> {
  const me = requireUser(user);
  const input = parseArgs(z.object({ projectId, faultId: z.string().trim().min(1).max(100).optional() }), args);
  return withWriteDb(async (db) => {
    const project = await requireProject(db, input.projectId);
    const [sceneDoc, rigDoc] = await Promise.all([
      project.sceneId
        ? db.collection('scenes').findOne({ id: project.sceneId }, { projection: { id: 1, verified: 1, faults: 1 } })
        : Promise.resolve(null),
      db.collection('rig_status').find({}).sort({ checkedAt: -1 }).limit(1).next(),
    ]);
    const rig = rigDoc ? toRig(rigDoc, Date.now()) : null;
    const reasons = faultPreconditionFailures({
      project,
      scene: sceneDoc ? { id: str(sceneDoc.id) ?? project.sceneId ?? '', verified: sceneDoc.verified === true } : null,
      rig: rig
        ? { checkedAgeMs: rig.ageMs, factoryioReachable: rig.factoryio?.reachable, factoryioDetail: rig.factoryio?.detail }
        : null,
    });
    if (reasons.length) throw new BlockedError(`BLOCKED: ${reasons.join('; ')}`);

    if (input.faultId) {
      const known = objArr(sceneDoc?.faults).map((f) => str(f.id));
      if (!known.includes(input.faultId)) {
        throw new ValidationError(`Fault "${input.faultId}" is not defined for scene "${project.sceneId}"`);
      }
    }
    return enqueue(db, me, {
      type: 'fault_and_improve',
      origin: 'custom',
      projectId: project.id,
      sceneId: project.sceneId,
      ...(input.faultId ? { faultId: input.faultId } : {}),
    });
  });
}

export async function changeSpec(args: unknown, { user }: Ctx): Promise<JobCreated> {
  const me = requireUser(user);
  const input = parseArgs(z.object({ projectId, specText }), args);
  return withWriteDb(async (db) => {
    const project = await requireProject(db, input.projectId);
    if (!project.sceneId) throw new BlockedError(`BLOCKED: project ${project.id} has no scene`);
    await requireRunnableScene(db, project.sceneId, 'cannot re-engineer this project');
    return enqueue(db, me, {
      type: 'spec_change',
      origin: 'custom',
      projectId: project.id,
      sceneId: project.sceneId,
      specText: input.specText,
    });
  });
}

// ---- long-horizon worker control -------------------------------------------------------------------

async function workerCommand(user: UserInfo | null, command: 'interrupt' | 'resume'): Promise<JobCreated> {
  const me = requireUser(user);
  return withWriteDb(async (db) => {
    const duplicate = await db
      .collection('jobs')
      .findOne({ type: 'worker_command', command, status: 'queued' }, { projection: { _id: 1 } });
    if (duplicate) {
      throw new BlockedError(`BLOCKED: an "${command}" command (${idOf(duplicate._id)}) is already waiting for the worker`);
    }
    return enqueue(db, me, { type: 'worker_command', origin: 'custom', command });
  });
}

export async function interruptWorker(_args: unknown, { user }: Ctx): Promise<JobCreated> {
  return workerCommand(user, 'interrupt');
}

export async function resumeWorker(_args: unknown, { user }: Ctx): Promise<JobCreated> {
  return workerCommand(user, 'resume');
}
