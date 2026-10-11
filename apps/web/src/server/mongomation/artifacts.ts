// Presigned S3 download links for run artifacts the AWS side of the worker archived. Atlas documents carry
// small references `{ bucket, key, bytes, sha256 }`:
//   plc_versions.artifact            ST source        -> "Download ST"
//   compile_results.artifact         compile log      -> "Compile log"
//   sim_runs.artifacts.testReport    test report      -> "Test report"   (public tests only, see report.ts)
//   jobs.artifact                    job record       -> "Job record"
// sim_runs.artifacts.measurements is deliberately NOT presigned: that NDJSON holds every sample of the run,
// including hidden tests' measurements, which must never reach the browser.
//
// Fail soft: without MM_AWS_ARTIFACTS_BUCKET or AWS credentials every url is null (no error). Only keys in
// the configured bucket are signed, and links are looked up by document id, never by a client-supplied key.
import { z } from 'zod';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Document } from 'mongodb';
import type { ArtifactLink, ArtifactLinksData, RigAwsData } from "@/shared/insights";
import type { Envelope } from '@/shared/mongomation';
import { withAtlas } from './atlas';
import { cached } from './cache';
import { clip, date, idFilter, idOf, num, obj, str } from './docs';
import { parseArgs } from './errors';

const TTL_S = 15 * 60;

let client: S3Client | null = null;
let credsChecked: { at: number; ok: boolean } | null = null;

function settings() {
  return {
    region: process.env.MM_AWS_REGION?.trim() || process.env.AWS_REGION?.trim() || '',
    bucket: process.env.MM_AWS_ARTIFACTS_BUCKET?.trim() || '',
  };
}

/** S3 client when region, bucket and credentials are all available; null otherwise (checked once a minute). */
async function s3(): Promise<S3Client | null> {
  const { region, bucket } = settings();
  if (!region || !bucket) return null;
  if (credsChecked && Date.now() - credsChecked.at < 60_000) return credsChecked.ok ? client : null;
  try {
    client ??= new S3Client({ region });
    const creds = await Promise.race([
      client.config.credentials(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    credsChecked = { at: Date.now(), ok: !!creds?.accessKeyId };
  } catch {
    credsChecked = { at: Date.now(), ok: false };
  }
  return credsChecked.ok ? client : null;
}

async function link(ref: unknown, label: string): Promise<ArtifactLink | null> {
  const r = obj(ref);
  const key = str(r?.key);
  if (!r || !key) return null;
  const base = { label, key, bytes: num(r.bytes), sha256: str(r.sha256), url: null as string | null };
  const { bucket } = settings();
  const c = await s3();
  if (!c || str(r.bucket) !== bucket) return base;
  try {
    base.url = await getSignedUrl(c, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: TTL_S });
  } catch {
    base.url = null;
  }
  return base;
}

export async function artifactLinks(args: unknown): Promise<Envelope<ArtifactLinksData>> {
  const { projectId } = parseArgs(z.object({ projectId: z.string().trim().min(1).max(64) }), args);
  // Presigned URLs live 15 min; sharing them for 60 s between viewers is safe.
  return cached(
    `artifacts:${projectId}`,
    () =>
      withAtlas<ArtifactLinksData>(async (db) => {
        const [version, simRun, job] = await Promise.all([
          db
            .collection('plc_versions')
            .find({ projectId }, { projection: { version: 1, artifact: 1 } })
            .sort({ version: -1 })
            .limit(1)
            .next(),
          db
            .collection('sim_runs')
            .find({ projectId }, { projection: { 'artifacts.testReport': 1, status: 1 } })
            .sort({ startedAt: -1 })
            .limit(1)
            .next(),
          db
            .collection('jobs')
            .find({ projectId, artifact: { $exists: true } }, { projection: { artifact: 1, type: 1 } })
            .sort({ createdAt: -1 })
            .limit(1)
            .next(),
        ]);
        const compile: Document | null = version
          ? await db
              .collection('compile_results')
              .find({ plcVersionId: idFilter(idOf(version._id)), artifact: { $exists: true } }, { projection: { artifact: 1 } })
              .sort({ createdAt: -1 })
              .limit(1)
              .next()
          : null;
        const [st, compileLog, testReport, jobRecord] = await Promise.all([
          link(version?.artifact, `ST v${num(version?.version) ?? '?'}`),
          link(compile?.artifact, 'Compile log'),
          link(obj(simRun?.artifacts)?.testReport, 'Test report'),
          link(job?.artifact, 'Job record'),
        ]);
        return {
          s3Configured: !!(await s3()),
          ttlSeconds: TTL_S,
          plcVersionId: version ? idOf(version._id) : undefined,
          simRunId: simRun ? idOf(simRun._id) : undefined,
          links: { st, compileLog, testReport, jobRecord },
        };
      }),
    60_000,
  );
}

// ---- rig_status.aws: SSM Run Command health probe of the rig hosts ----------------------------------------

function toChecks(v: unknown): { name: string; ok: boolean | null }[] {
  return Object.entries(obj(v) ?? {})
    .slice(0, 20)
    .map(([name, val]) => {
      const o = obj(val);
      const b = typeof val === "boolean" ? val : typeof o?.ok === "boolean" ? (o.ok as boolean) : null;
      return { name, ok: b };
    });
}

export async function rigAws(): Promise<Envelope<RigAwsData>> {
  return cached("rigAws", () =>
    withAtlas<RigAwsData>(async (db) => {
      const doc = await db
        .collection("rig_status")
        .find({ aws: { $exists: true } }, { projection: { aws: 1 } })
        .sort({ "aws.checkedAt": -1 })
        .limit(1)
        .next();
      const aws = obj(doc?.aws);
      if (!aws) return { aws: null };
      const checkedAt = date(aws.checkedAt);
      return {
        aws: {
          checkedAt,
          ageMs: checkedAt ? Math.max(0, Date.now() - checkedAt.getTime()) : undefined,
          via: str(aws.via),
          healthy: typeof aws.healthy === "boolean" ? aws.healthy : undefined,
          hosts: Object.entries(obj(aws.hosts) ?? {})
            .slice(0, 6)
            .map(([role, h]) => {
              const host = obj(h) ?? {};
              return {
                role,
                ok: typeof host.ok === "boolean" ? host.ok : undefined,
                status: str(host.status),
                detail: clip(str(host.detail), 300),
                checks: toChecks(host.checks),
              };
            }),
        },
      };
    }),
  );
}
