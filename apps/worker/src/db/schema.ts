// Atlas data-platform guarantees that live IN the database, not only in worker code:
//   - $jsonSchema validators: a buggy (or compromised) writer cannot store a malformed job, an unknown verdict, or a
//     harness version that switches off regression tests. The harness guardrail `run_regression_tests: true` is
//     enforced by the server itself.
//   - TTL indexes on ephemeral, high-churn collections (event log, rig status, change-stream tokens, job
//     transitions). Evidence collections (test_results, measurements, sim_runs, harness_versions, ...) never expire.
//   - change stream pre/post images on `jobs` and `harness_versions` (status-transition audit, immutability audit).
// Applied by `npm run setup:atlas`; every step is idempotent.
import type { Db, Document } from "mongodb";

const DAY = 86_400;
const days = (env: string | undefined, dflt: number) => Math.max(1, Number(env) || dflt) * DAY;

/** [collection, ttl field, seconds]. Each gets a single-field TTL index (Atlas' TTL monitor runs every ~60 s). */
export const TTL: [string, string, number][] = [
  ["events", "ts", days(process.env.EVENTS_TTL_DAYS, 30)], // stage log lines; the durable evidence lives elsewhere
  ["rig_status", "checkedAt", days(process.env.RIG_STATUS_TTL_DAYS, 14)], // a rig not probed for 2 weeks is not "live"
  ["change_stream_tokens", "at", 7 * DAY], // older than any realistic oplog window -> unusable anyway
  ["job_transitions", "at", days(process.env.JOB_TRANSITIONS_TTL_DAYS, 30)],
];

const int = { bsonType: ["int", "long"] };
const str = { bsonType: "string" };
const date = { bsonType: "date" };

export const JOB_TYPES = ["engineer", "fault_and_improve", "evolve", "benchmark", "ablation", "spec_change", "worker_command"];
export const JOB_STATUSES = ["queued", "running", "verifying", "completed", "failed", "blocked", "interrupted"];

/**
 * validationLevel "strict" = every insert and update is checked; "moderate" = existing documents that already
 * violate the schema can still be updated (used where the dashboard or older code may hold legacy shapes).
 */
export const VALIDATORS: { name: string; level: "strict" | "moderate"; schema: Document }[] = [
  {
    // Versioned harness: never edited in place. The guardrail fields are enforced here, server side.
    name: "harness_versions",
    level: "strict",
    schema: {
      bsonType: "object",
      required: ["version", "verdict", "rules", "context", "workflow", "repair", "routing", "createdAt"],
      properties: {
        version: { ...int, minimum: 0 },
        parent: { bsonType: ["int", "long", "null"] },
        verdict: { enum: ["kept", "pending", "rolled_back", "rejected"] },
        rules: { bsonType: "array", maxItems: 24, items: { bsonType: "string", minLength: 8, maxLength: 400 } },
        context: { bsonType: "object" },
        workflow: {
          bsonType: "object",
          required: ["run_regression_tests"],
          properties: { run_regression_tests: { enum: [true] }, repair_budget: { ...int, minimum: 1, maximum: 5 } },
        },
        repair: { bsonType: "object", properties: { strategy: { enum: ["full_rewrite", "targeted_patch"] } } },
        routing: { bsonType: "object" },
        rationale: str,
        createdAt: str, // ISO string (HarnessConfig.createdAt)
      },
    },
  },
  {
    // The only collection the dashboard writes. Shape + enums; extra fields (specText, requestedBy, result) allowed.
    name: "jobs",
    level: "moderate",
    schema: {
      bsonType: "object",
      required: ["type", "status", "createdAt"],
      properties: {
        type: { enum: JOB_TYPES },
        status: { enum: JOB_STATUSES },
        createdAt: date,
        attempts: { ...int, minimum: 0 },
        heartbeatAt: date,
        claimedBy: str,
        origin: { enum: ["custom", "example", "script"] },
        command: { enum: ["interrupt", "resume"] },
      },
    },
  },
  {
    name: "rsi_proposals",
    level: "moderate",
    schema: {
      bsonType: "object",
      required: ["change", "verdict", "rationale", "createdAt"],
      properties: {
        change: { bsonType: "bool" },
        verdict: { enum: ["no_change", "rejected", "pending", "kept", "rolled_back"] },
        rationale: str,
        createdAt: date,
        fromVersion: int,
        candidateVersion: int,
        provenance: str,
      },
    },
  },
  {
    // Test evidence: a verdict is one of three values and always points at its run, project and harness version.
    name: "test_results",
    level: "moderate",
    schema: {
      bsonType: "object",
      required: ["testId", "verdict", "projectId", "simRunId", "harnessVersion", "startedAt"],
      properties: {
        testId: str,
        verdict: { enum: ["passed", "failed", "blocked"] },
        projectId: str,
        simRunId: str,
        harnessVersion: int,
        startedAt: date,
        visibility: { enum: ["public", "hidden"] },
        sampleCount: { ...int, minimum: 0 },
        durationMs: { ...int, minimum: 0 },
      },
    },
  },
];

type Log = (m: string) => void;

async function ensureCollection(db: Db, name: string) {
  if (!(await db.listCollections({ name }, { nameOnly: true }).toArray()).length) await db.createCollection(name);
}

/** Creates/updates TTL indexes. An existing non-TTL index on the same key is converted via collMod. */
export async function ensureTtl(db: Db, log: Log) {
  for (const [name, field, secs] of TTL) {
    await ensureCollection(db, name);
    const coll = db.collection(name);
    const existing = (await coll.indexes()).find((i) => JSON.stringify(i.key) === JSON.stringify({ [field]: 1 }));
    if (!existing) {
      await coll.createIndex({ [field]: 1 }, { expireAfterSeconds: secs, name: `${field}_ttl` });
      log(`ttl ${name}.${field}: created (${secs / DAY} d)`);
    } else if (existing.expireAfterSeconds !== secs) {
      await db.command({ collMod: name, index: { keyPattern: { [field]: 1 }, expireAfterSeconds: secs } });
      log(`ttl ${name}.${field}: set to ${secs / DAY} d`);
    } else log(`ttl ${name}.${field}: ok (${secs / DAY} d)`);
  }
}

/**
 * Applies the validators. Before "strict", existing documents are checked: if any would fail, the collection gets
 * "moderate" instead (never leaves the DB in a state where legacy docs can no longer be updated) and we say so.
 */
export async function ensureValidators(db: Db, log: Log) {
  const out: Record<string, { level: string; violating: number; total: number }> = {};
  for (const v of VALIDATORS) {
    await ensureCollection(db, v.name);
    const coll = db.collection(v.name);
    const [violating, total] = await Promise.all([coll.countDocuments({ $nor: [{ $jsonSchema: v.schema }] }), coll.countDocuments()]);
    const level = v.level === "strict" && violating > 0 ? "moderate" : v.level;
    await db.command({ collMod: v.name, validator: { $jsonSchema: v.schema }, validationLevel: level, validationAction: "error" });
    out[v.name] = { level, violating, total };
    log(`validator ${v.name}: ${level}/error (${violating}/${total} existing docs violate${level !== v.level ? " -> downgraded from strict" : ""})`);
  }
  return out;
}

/** Pre/post images let change streams see a document before and after an update (status transition audit). */
export async function ensurePrePostImages(db: Db, log: Log, names = ["jobs", "harness_versions"]) {
  for (const name of names) {
    try {
      await ensureCollection(db, name);
      await db.command({ collMod: name, changeStreamPreAndPostImages: { enabled: true } });
      log(`pre/post images ${name}: enabled`);
    } catch (err) {
      log(`pre/post images ${name}: NOT enabled — ${(err as Error).message}`);
    }
  }
}

/** Secondary indexes on the time-series meta fields + supporting indexes for the audit collections. */
export const EXTRA_INDEXES: [string, Document, Document?][] = [
  ["measurements", { "meta.testId": 1, ts: 1 }], // one test across runs (regression drift)
  ["measurements", { "meta.simRunId": 1, ts: 1 }], // whole sim run timeline
  ["job_transitions", { jobId: 1, at: 1 }],
  ["audit_log", { kind: 1, at: -1 }],
  ["trace_refs", { eventId: 1 }],
  ["trace_refs", { evidenceIds: 1 }], // multikey: evidence id -> Raindrop trace
  ["jobs", { type: 1, status: 1, command: 1 }], // pendingCommand() and the dashboard's per-type queue count
  ["jobs", { status: 1, heartbeatAt: 1 }], // recoverStale()
];

export async function ensureExtraIndexes(db: Db, log: Log) {
  for (const [name, keys, opts] of EXTRA_INDEXES) {
    await ensureCollection(db, name);
    await db.collection(name).createIndex(keys, opts ?? {});
  }
  log(`${EXTRA_INDEXES.length} data-platform indexes ensured`);
}
