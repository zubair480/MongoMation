// MongoDB Atlas: the single source of truth for projects, PLC versions, measurements, harness versions and
// RSI decisions. Only the worker writes engineering state (MONGODB_URI = writer user). The dashboard uses a
// reader user plus write access to `jobs` only (docs/INTEGRATION_CONTRACT.md §6).
import { MongoClient, MongoError, ReadPreference, type ClientSession, type Collection, type Db, type Document, type ReadConcernLike } from "mongodb";

const uri = process.env.MONGODB_URI;
export const DB_NAME = process.env.MONGODB_DB || "mongomation";

export const client = new MongoClient(uri ?? "mongodb://127.0.0.1:1/not-configured", {
  appName: "mongomation-worker",
  serverSelectionTimeoutMS: 10_000,
  // Engineering state (jobs, stages, evidence) is read back by other processes (dashboard, other workers, the RSI
  // loop): majority writes cannot be rolled back by a primary failover. NO client-wide readConcern: Atlas
  // $search / $vectorSearch / $searchMeta only accept readConcern "local". Majority reads are applied per call
  // where they matter (transactions = snapshot, causal sessions, analyticsRead).
  retryWrites: true,
  retryReads: true,
  writeConcern: { w: "majority" },
});
export let db: Db = client.db(DB_NAME);
let connected = false;
/** True once connect() succeeded (lets best-effort writers like trace_refs no-op in unit tests). */
export const isConnected = () => connected;

/** Fails fast with the real error when the URI, credentials or IP allowlist are wrong. */
export async function connect() {
  if (!uri) throw new Error("MONGODB_URI is not set (Atlas hackathon sandbox connection string)");
  await client.connect();
  db = client.db(DB_NAME);
  await db.command({ ping: 1 });
  connected = true;
}

const c = <T extends Document = Document>(name: string) => () => db.collection<T>(name);

/** Collection accessors (functions, so they bind to the connected Db). */
export const col = {
  projects: c("projects"),
  jobs: c("jobs"),
  stages: c("stages"),
  events: c("events"),
  requirements: c("requirements"),
  plcVersions: c("plc_versions"),
  compiles: c("compile_results"),
  deployments: c("deployments"),
  simRuns: c("sim_runs"),
  testResults: c("test_results"),
  measurements: c("measurements"),
  faults: c("fault_injections"),
  diagnoses: c("diagnoses"),
  repairs: c("repairs"),
  lessons: c("lessons"),
  harness: c("harness_versions"),
  proposals: c("rsi_proposals"),
  benchmarks: c("benchmark_runs"),
  manifests: c("benchmark_manifests"),
  workers: c("workers"),
  scenes: c("scenes"),
  rigLocks: c("rig_locks"),
  traces: c("trace_refs"),
  rigStatus: c("rig_status"),
  streamTokens: c("change_stream_tokens"),
  /** Job status transitions captured from the jobs change stream (pre-image status -> post-image status). TTL. */
  jobTransitions: c("job_transitions"),
  /** Integrity alerts, e.g. an update to an already-decided (immutable) harness version. Kept (evidence). */
  audit: c("audit_log"),
} satisfies Record<string, () => Collection>;

/**
 * Runs `fn` as one multi-document ACID transaction (snapshot read, majority commit). Uses the driver's
 * `withTransaction`, which retries the whole callback on TransientTransactionError and retries the commit on
 * UnknownTransactionCommitResult. `fn` must pass `{ session }` to every operation and must not swallow errors.
 */
export async function withTxn<T>(fn: (session: ClientSession) => Promise<T>, mongo: Pick<MongoClient, "startSession"> = client): Promise<T> {
  const session = mongo.startSession();
  try {
    return await session.withTransaction(fn, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary" });
  } finally {
    await session.endSession();
  }
}

/** True for errors the server labels as safe to retry as a whole transaction / commit. */
export const isRetryableTxnError = (err: unknown) =>
  err instanceof MongoError && (err.hasErrorLabel("TransientTransactionError") || err.hasErrorLabel("UnknownTransactionCommitResult"));

/**
 * withTxn plus an outer retry: `withTransaction` already retries internally for up to 120 s; if a labelled transient
 * error still escapes (e.g. a long primary election), retry the whole unit up to `retries` more times with backoff.
 * The callback must be idempotent per attempt (it is: everything inside commits or aborts together).
 */
export async function withTxnRetry<T>(fn: (session: ClientSession) => Promise<T>, retries = 2, mongo: Pick<MongoClient, "startSession"> = client): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTxn(fn, mongo);
    } catch (err) {
      if (attempt >= retries || !isRetryableTxnError(err)) throw err;
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
  }
}

/**
 * A causally consistent session: every read inside sees every earlier write made through the same session
 * (read-your-writes, monotonic reads) even if a read is served by a secondary. Causal guarantees need majority
 * read + write concern: writes are majority by client default; reads inside the session should pass
 * `causalRead` (readConcern majority). Do not run $search inside it (search requires readConcern local).
 */
export const causalRead = { readConcern: { level: "majority" } as ReadConcernLike };
export async function withCausalSession<T>(fn: (session: ClientSession) => Promise<T>, mongo: Pick<MongoClient, "startSession"> = client): Promise<T> {
  const session = mongo.startSession({ causalConsistency: true });
  try {
    return await fn(session);
  } finally {
    await session.endSession();
  }
}

/** Read options for dashboard analytics over evidence: offload to a secondary when one is fresh enough. */
export const analyticsRead = {
  readPreference: new ReadPreference("secondaryPreferred", undefined, { maxStalenessSeconds: 90 }),
  readConcern: { level: "majority" } as ReadConcernLike,
};

export const now = () => new Date();
