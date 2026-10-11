// Read-only queries. Public on purpose: anyone with the URL can watch the engineering run, nobody can
// change anything without signing in (see mutations.ts). Every query answers with an Envelope, so the
// UI shows DISCONNECTED with the real driver error instead of stale or invented numbers.
import { z } from 'zod';
import { getConfig } from 'modelence/server';
import type { Db, Document } from 'mongodb';
import type {
  AblationConditionLite,
  AblationData,
  DashboardData,
  JobLite,
  PlcSourceData,
  ProjectData,
  RsiData,
  ScenesData,
  TagValue,
  TimelineData,
  VerdictLite,
} from '@/shared/mongomation';
import { withAtlas } from './atlas';
import { cached } from './cache';
import {
  clip,
  date,
  idFilter,
  idOf,
  num,
  objArr,
  str,
  strArr,
  tagValue,
  obj,
  toAssertion,
  toCompile,
  toDiagnosis,
  toEvent,
  toFaultInjection,
  toHarnessDetail,
  toHarnessVersion,
  toIo,
  toJob,
  toPlcVersionMeta,
  toProject,
  toProjectListItem,
  toProposal,
  toRequirement,
  toRig,
  toScene,
  toScores,
  toSimRun,
  toStage,
  toTest,
  toVerdict,
  toWorker,
} from './docs';
import { parseArgs } from './errors';
import { exampleList } from './examples';

const NOT_A_COMMAND = { type: { $ne: 'worker_command' } };

const JOB_FIELDS = {
  type: 1,
  status: 1,
  origin: 1,
  command: 1,
  sceneId: 1,
  projectId: 1,
  faultId: 1,
  claimedBy: 1,
  handledBy: 1,
  heartbeatAt: 1,
  attempts: 1,
  resumedFrom: 1,
  interruptedAt: 1,
  error: 1,
  requestedBy: 1,
  createdAt: 1,
  startedAt: 1,
  finishedAt: 1,
  specText: 1,
};

async function newestJob(db: Db, filter: Document, now: number): Promise<JobLite | null> {
  const doc = await db
    .collection('jobs')
    .find(filter, { projection: JOB_FIELDS })
    .sort({ createdAt: -1, _id: -1 })
    .limit(1)
    .next();
  return doc ? toJob(doc, now) : null;
}

/** The project a job works on: the job's own projectId, else the project its stages / events name. */
async function projectIdForJob(db: Db, job: JobLite): Promise<string | null> {
  if (job.projectId) return job.projectId;
  const byJob = { jobId: idFilter(job.id) };
  const stage = await db.collection('stages').findOne(byJob, { projection: { projectId: 1 } });
  if (stage && str(stage.projectId)) return str(stage.projectId) ?? null;
  const event = await db.collection('events').findOne(byJob, { projection: { projectId: 1 } });
  return (event && str(event.projectId)) || null;
}

// ---- dashboard: header badges, rig, buttons, long-horizon card, project picker ----------------------

export async function dashboard() {
  return cached('dashboard', () =>
    withAtlas<DashboardData>(async (db) => {
      const now = Date.now();
      const jobs = db.collection('jobs');
      const [
        workerDocs,
        rigDoc,
        generate,
        example,
        fault,
        specChange,
        command,
        queuedCount,
        activeDoc,
        lastJob,
        projectDocs,
      ] = await Promise.all([
        db.collection('workers').find({}).sort({ heartbeatAt: -1 }).limit(5).toArray(),
        db.collection('rig_status').find({}).sort({ checkedAt: -1 }).limit(1).next(),
        newestJob(db, { type: 'engineer', origin: { $ne: 'example' } }, now),
        newestJob(db, { type: 'engineer', origin: 'example' }, now),
        newestJob(db, { type: 'fault_and_improve' }, now),
        newestJob(db, { type: 'spec_change' }, now),
        newestJob(db, { type: 'worker_command' }, now),
        jobs.countDocuments({ ...NOT_A_COMMAND, status: 'queued' }),
        jobs
          .find({ ...NOT_A_COMMAND, status: { $in: ['running', 'verifying'] } }, { projection: JOB_FIELDS })
          .sort({ heartbeatAt: -1, createdAt: -1 })
          .limit(1)
          .next(),
        newestJob(db, NOT_A_COMMAND, now),
        db
          .collection('projects')
          .find(
            {},
            {
              projection: {
                specText: 1,
                sceneId: 1,
                status: 1,
                currentVersion: 1,
                attempts: 1,
                harnessVersion: 1,
                costUsd: 1,
                createdAt: 1,
              },
            },
          )
          .sort({ createdAt: -1, _id: -1 })
          .limit(25)
          .toArray(),
      ]);

      const activeJob = activeDoc ? toJob(activeDoc, now) : null;
      const focus = activeJob ?? lastJob;
      const checkpointProjectId = focus ? await projectIdForJob(db, focus) : null;
      const checkpointDocs = checkpointProjectId
        ? await db
            .collection('stages')
            .find({ projectId: checkpointProjectId }, { projection: { output: 0 } })
            .sort({ startedAt: 1 })
            .limit(400)
            .toArray()
        : [];

      return {
        serverTime: new Date(now),
        authDbConfigured: Boolean(getConfig('_system.mongodbUri')),
        workers: workerDocs.map((w) => toWorker(w, now)),
        rig: rigDoc ? toRig(rigDoc, now) : null,
        latestJobs: { generate, example, fault, specChange, command },
        queuedCount,
        activeJob,
        lastJob,
        checkpointProjectId,
        checkpoints: checkpointDocs.map((s) => toStage(s, now)),
        projects: projectDocs.map(toProjectListItem),
      };
    }),
  );
}

// ---- scenes (registry, changes rarely) ------------------------------------------------------------

export async function scenes() {
  return cached('scenes', () =>
    withAtlas<ScenesData>(async (db) => {
      const docs = await db
        .collection('scenes')
        .find(
          {},
          {
            projection: {
              id: 1,
              title: 1,
              description: 1,
              factoryIoScene: 1,
              verified: 1,
              capabilities: 1,
              tags: 1,
              faults: 1,
            },
          },
        )
        .sort({ id: 1 })
        .limit(100)
        .toArray();
      return { scenes: docs.map(toScene), examples: exampleList() };
    }),
  );
}

// ---- one project: stages, events, PLC versions, compile, tests, verdicts -------------------------------

const projectArgs = z.object({ projectId: z.string().trim().min(1).max(64) });

export async function project(args: unknown) {
  const { projectId } = parseArgs(projectArgs, args);
  return cached(`project:${projectId}`, () =>
    withAtlas<ProjectData>(async (db) => {
      const now = Date.now();
      const projectDoc = await db.collection('projects').findOne({ _id: idFilter(projectId) } as Document);
      const pid = projectDoc ? idOf(projectDoc._id) : projectId;

      const [reqDoc, stageDocs, eventDocs, versionDocs, simRunDoc, faultDocs, diagnosisDoc, hiddenIdValues] =
        await Promise.all([
          db.collection('requirements').find({ projectId: pid }).sort({ revision: -1 }).limit(1).next(),
          db
            .collection('stages')
            .find({ projectId: pid }, { projection: { output: 0 } })
            .sort({ startedAt: 1 })
            .limit(500)
            .toArray(),
          db
            .collection('events')
            .find({ projectId: pid }, { projection: { data: 0 } })
            .sort({ ts: -1, _id: -1 })
            .limit(100)
            .toArray(),
          db
            .collection('plc_versions')
            .find({ projectId: pid }, { projection: { source: 0, diffFromPrevious: 0 } })
            .sort({ version: -1 })
            .limit(50)
            .toArray(),
          db
            .collection('sim_runs')
            .find({ projectId: pid }, { projection: { releasedAtStart: 0 } })
            .sort({ startedAt: -1 })
            .limit(1)
            .next(),
          db.collection('fault_injections').find({ projectId: pid }).sort({ appliedAt: -1 }).limit(10).toArray(),
          db
            .collection('diagnoses')
            .find({ projectId: pid }, { projection: { feedback: 0 } })
            .sort({ createdAt: -1 })
            .limit(1)
            .next(),
          // Exact hidden test ids, so free text (events, stage errors) can be scrubbed of them.
          db.collection('test_results').distinct('testId', { projectId: pid, visibility: { $ne: 'public' } }),
        ]);
      const hiddenIds = strArr(hiddenIdValues);

      const plcVersions = versionDocs.map(toPlcVersionMeta);
      const latest = plcVersions[0];
      const simRun = simRunDoc ? toSimRun(simRunDoc) : null;

      const [compileDocs, testDocs] = await Promise.all([
        latest
          ? db
              .collection('compile_results')
              .find({ plcVersionId: idFilter(latest.id) })
              .sort({ createdAt: -1 })
              .limit(10)
              .toArray()
          : Promise.resolve([]),
        simRun
          ? db
              .collection('test_results')
              // Test steps and step logs never leave the server (hidden tests stay hidden).
              .find({ simRunId: idFilter(simRun.id) }, { projection: { steps: 0, stepLogs: 0 } })
              .sort({ startedAt: 1, _id: 1 })
              .limit(500)
              .toArray()
          : Promise.resolve([]),
      ]);

      const tests = testDocs.map(toTest);
      const count = (verdict: string) => tests.filter((t) => t.verdict === verdict).length;

      // Requirement verdicts: the newest sim run that has them (a run in progress has none yet), else the
      // project's final verification.
      let verdictRun: Document | null = simRunDoc && objArr(simRunDoc.verdicts).length ? simRunDoc : null;
      if (!verdictRun && simRunDoc) {
        verdictRun = await db
          .collection('sim_runs')
          .find({ projectId: pid, 'verdicts.0': { $exists: true } }, { projection: { verdicts: 1, startedAt: 1 } })
          .sort({ startedAt: -1 })
          .limit(1)
          .next();
      }
      const projectVerdicts: VerdictLite[] = projectDoc ? objArr(projectDoc.verdicts).map(toVerdict) : [];
      let verdicts: VerdictLite[] = [];
      let verdictSource: ProjectData['verdictSource'] = null;
      if (verdictRun) {
        verdicts = objArr(verdictRun.verdicts).map(toVerdict);
        verdictSource = { kind: 'sim_run', simRunId: idOf(verdictRun._id), latestRun: verdictRun === simRunDoc };
      } else if (projectVerdicts.length) {
        verdicts = projectVerdicts;
        verdictSource = { kind: 'project', simRunId: projectDoc ? str(projectDoc.lastSimRunId) : undefined };
      }

      return {
        project: projectDoc ? toProject(projectDoc) : null,
        requirements: reqDoc
          ? {
              revision: num(reqDoc.revision),
              sceneId: str(reqDoc.sceneId),
              items: objArr(reqDoc.requirements).slice(0, 100).map(toRequirement),
              io: objArr(reqDoc.io).slice(0, 200).map(toIo),
            }
          : null,
        stages: stageDocs.map((s) => toStage(s, now, hiddenIds)),
        events: eventDocs.map((e) => toEvent(e, hiddenIds)),
        plcVersions,
        compiles: compileDocs.map(toCompile),
        simRun,
        tests,
        testCounts: {
          passed: count('passed'),
          failed: count('failed'),
          blocked: count('blocked'),
          total: tests.length,
        },
        verdicts,
        verdictSource,
        faults: faultDocs.map(toFaultInjection),
        diagnosis: diagnosisDoc ? toDiagnosis(diagnosisDoc) : null,
      };
    }),
  );
}

// ---- PLC source of one version (immutable once written) --------------------------------------------

const plcArgs = z.object({ plcVersionId: z.string().trim().min(1).max(64) });

export async function plcSource(args: unknown) {
  const { plcVersionId } = parseArgs(plcArgs, args);
  return cached(`plc:${plcVersionId}`, () =>
    withAtlas<PlcSourceData>(async (db) => {
      const doc = await db.collection('plc_versions').findOne({ _id: idFilter(plcVersionId) } as Document, {
        projection: { source: 1, diffFromPrevious: 1, version: 1, createdBy: 1 },
      });
      if (!doc) return { found: false, id: plcVersionId, diff: null };
      const rawDiff: unknown = doc.diffFromPrevious;
      const diff = Array.isArray(rawDiff) ? strArr(rawDiff) : typeof rawDiff === 'string' ? rawDiff.split('\n') : null;
      return {
        found: true,
        id: idOf(doc._id),
        version: num(doc.version),
        createdBy: str(doc.createdBy),
        source: clip(str(doc.source), 400_000) ?? '',
        diff: diff ? diff.slice(0, 20_000) : null,
      };
    }),
  );
}

// ---- measured timeline of one public test --------------------------------------------------------------

const timelineArgs = z.object({
  simRunId: z.string().trim().min(1).max(64),
  testId: z.string().trim().min(1).max(200),
});

const MAX_SAMPLES_READ = 20_000;
const MAX_POINTS = 2_500;

function tagValues(v: unknown): Record<string, TagValue> {
  const out: Record<string, TagValue> = {};
  for (const [name, value] of Object.entries(obj(v) ?? {})) {
    const tv = tagValue(value);
    if (tv !== undefined) out[name] = tv;
  }
  return out;
}

/** Keeps the first sample, every sample whose values differ from the previous one, and the last sample. */
function changePoints(docs: Document[]) {
  const rows = docs
    .map((d) => ({ t: num(d.t), values: tagValues(d.values) }))
    .filter((r): r is { t: number; values: Record<string, TagValue> } => r.t !== undefined)
    .sort((a, b) => a.t - b.t);
  const out: typeof rows = [];
  let previous = '';
  rows.forEach((row, i) => {
    const key = JSON.stringify(Object.entries(row.values).sort(([a], [b]) => a.localeCompare(b)));
    if (key !== previous || i === rows.length - 1) out.push(row);
    previous = key;
  });
  if (out.length <= MAX_POINTS) return { samples: out, thinned: false };
  const step = Math.ceil(out.length / MAX_POINTS);
  return { samples: out.filter((_, i) => i % step === 0 || i === out.length - 1), thinned: true };
}

export async function testTimeline(args: unknown) {
  const { simRunId, testId } = parseArgs(timelineArgs, args);
  return cached(`timeline:${simRunId}:${testId}`, () =>
    withAtlas<TimelineData>(async (db) => {
      const empty = { simRunId, testId, samples: [], totalSamples: 0, truncated: false, assertions: [] };
      const result = await db
        .collection('test_results')
        .findOne(
          { simRunId: idFilter(simRunId), testId },
          { projection: { visibility: 1, assertions: 1, durationMs: 1 } },
        );
      if (!result) return { ...empty, found: false, hidden: false };
      if (str(result.visibility) !== 'public') return { ...empty, found: true, hidden: true };

      const docs = await db
        .collection('measurements')
        .find({ 'meta.simRunId': simRunId, 'meta.testId': testId }, { projection: { _id: 0, t: 1, values: 1 } })
        .sort({ t: 1 })
        .limit(MAX_SAMPLES_READ)
        .toArray();
      const { samples, thinned } = changePoints(docs);
      return {
        ...empty,
        found: true,
        hidden: false,
        samples,
        totalSamples: docs.length,
        truncated: thinned || docs.length >= MAX_SAMPLES_READ,
        durationMs: num(result.durationMs),
        assertions: objArr(result.assertions).slice(0, 50).map(toAssertion),
      };
    }),
  );
}

// ---- self-improvement (RSI): harness versions and the newest proposal ----------------------------------

export async function rsi() {
  return cached('rsi', () =>
    withAtlas<RsiData>(async (db) => {
      const harness = db.collection('harness_versions');
      const proposals = db.collection('rsi_proposals');
      const [historyDocs, activeDoc, proposalDoc, proposalCount] = await Promise.all([
        harness
          .find(
            {},
            {
              projection: {
                _id: 0,
                version: 1,
                parent: 1,
                verdict: 1,
                rationale: 1,
                gateNote: 1,
                createdAt: 1,
                decidedAt: 1,
                scores: 1,
                rulesCount: { $size: { $ifNull: ['$rules', []] } },
              },
            },
          )
          .sort({ version: -1 })
          .limit(100)
          .toArray(),
        harness
          .find({ verdict: 'kept' }, { projection: { _id: 0 } })
          .sort({ version: -1 })
          .limit(1)
          .next(),
        proposals.find({}).sort({ createdAt: -1, _id: -1 }).limit(1).next(),
        proposals.countDocuments({}),
      ]);
      const latestProposal = proposalDoc ? toProposal(proposalDoc) : null;
      const candidateDoc =
        latestProposal?.candidateVersion !== undefined
          ? await harness.findOne({ version: latestProposal.candidateVersion }, { projection: { _id: 0 } })
          : null;
      return {
        active: activeDoc ? toHarnessDetail(activeDoc) : null,
        versions: historyDocs.map(toHarnessVersion),
        latestProposal,
        candidate: candidateDoc ? toHarnessDetail(candidateDoc) : null,
        proposalCount,
      };
    }),
  );
}

// ---- ablation: bare one-shot vs harness v0 vs evolved vN on the held-out split --------------------------

const CONDITION_ORDER = (key: string) => (key === 'bare' ? -2 : key === 'v0' ? -1 : (Number(key.slice(1)) || 0));

export async function ablation() {
  return cached('ablation', () =>
    withAtlas<AblationData>(async (db) => {
      const runs = db.collection('benchmark_runs');
      const ABLATION_ROW = { condition: { $regex: '^ablation:' } };
      const [summaryDoc, summaryCount, newestRow] = await Promise.all([
        runs.find({ kind: 'ablation_summary' }).sort({ createdAt: -1, _id: -1 }).limit(1).next(),
        runs.countDocuments({ kind: 'ablation_summary' }),
        runs
          .find(ABLATION_ROW, { projection: { _id: 0, benchmarkId: 1, createdAt: 1 } })
          .sort({ createdAt: -1, _id: -1 })
          .limit(1)
          .next(),
      ]);

      let summary: AblationData['summary'] = null;
      const summaryId = summaryDoc ? str(summaryDoc.benchmarkId) : undefined;
      if (summaryDoc && summaryId) {
        const counts = await runs
          .aggregate<{ _id: unknown; n: number }>([
            { $match: { benchmarkId: summaryId, ...ABLATION_ROW } },
            { $group: { _id: '$condition', n: { $sum: 1 } } },
          ])
          .toArray();
        const rowsBy = new Map(counts.map((c) => [String(c._id).replace(/^ablation:/, ''), c.n]));
        const scores = obj(summaryDoc.scores) ?? {};
        const conditions: AblationConditionLite[] = Object.keys(scores)
          .map((key) => ({
            key,
            version: key === 'bare' ? undefined : num(Number(key.replace(/^v/, ''))),
            scores: toScores(scores[key]),
            rows: rowsBy.get(key) ?? 0,
          }))
          .sort((a, b) => CONDITION_ORDER(a.key) - CONDITION_ORDER(b.key));
        const model = obj(summaryDoc.model);
        summary = {
          benchmarkId: summaryId,
          manifestHash: str(summaryDoc.manifestHash),
          createdAt: date(summaryDoc.createdAt),
          model: model ? { fast: str(model.fast), strong: str(model.strong) } : undefined,
          conditions,
        };
      }

      let inProgress: AblationData['inProgress'] = null;
      const newestId = newestRow ? str(newestRow.benchmarkId) : undefined;
      if (newestId && newestId !== summaryId) {
        const done = await runs.countDocuments({ kind: 'ablation_summary', benchmarkId: newestId });
        if (!done) {
          inProgress = {
            benchmarkId: newestId,
            rows: await runs.countDocuments({ benchmarkId: newestId, ...ABLATION_ROW }),
            lastRowAt: date(newestRow?.createdAt),
          };
        }
      }

      return { summary, inProgress, summaryCount };
    }),
  );
}
