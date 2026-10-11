// MongoDB Atlas: the single source of truth for projects, PLC versions, measurements, harness versions and
// RSI decisions. Only the worker writes engineering state (MONGODB_URI = writer user). The dashboard uses a
// reader user plus write access to `jobs` only (docs/INTEGRATION_CONTRACT.md §6).
import { MongoClient, type ClientSession, type Collection, type Db, type Document } from "mongodb";

const uri = process.env.MONGODB_URI;
export const DB_NAME = process.env.MONGODB_DB || "mongomation";

export const client = new MongoClient(uri ?? "mongodb://127.0.0.1:1/not-configured", {
  appName: "mongomation-worker",
  serverSelectionTimeoutMS: 10_000,
});
export let db: Db = client.db(DB_NAME);

/** Fails fast with the real error when the URI, credentials or IP allowlist are wrong. */
export async function connect() {
  if (!uri) throw new Error("MONGODB_URI is not set (Atlas hackathon sandbox connection string)");
  await client.connect();
  db = client.db(DB_NAME);
  await db.command({ ping: 1 });
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

export const now = () => new Date();
