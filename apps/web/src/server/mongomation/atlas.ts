// Dedicated connection to the hackathon Atlas cluster (research notes, option B).
//
// Modelence keeps its own database (_system.mongodbUri) for users and sessions. MongoMation's engineering
// state lives in the Atlas cluster the worker writes to, so the dashboard opens a second MongoClient:
//   URI     : module secret `mongomation.atlasUri`  -> env MONGODB_URI_WEB
//   DB name : module config `mongomation.dbName`    -> env MONGODB_DB -> "mongomation"
// (Modelence does not map env vars into module configs, hence the explicit env fallbacks.)
//
// Worker-owned collections are NOT declared as Modelence Stores: Store index reconciliation at startup
// could drop the worker's indexes. Everything goes through raw collections on this client.
import { MongoClient, type Db } from 'mongodb';
import { getConfig } from 'modelence/server';
import type { AtlasErrorStage, Disconnected, Envelope } from '@/shared/mongomation';

const CONNECT_TIMEOUT_MS = 5000;
/** After a failed connect, callers get the same error for this long instead of hammering the cluster. */
const RETRY_AFTER_MS = 3000;

export class AtlasUnavailableError extends Error {
  constructor(
    message: string,
    readonly stage: AtlasErrorStage
  ) {
    super(message);
    this.name = 'AtlasUnavailableError';
  }
}

interface Settings {
  uri: string;
  dbName: string;
}

function readSettings(): Settings {
  const configuredUri = getConfig('mongomation.atlasUri');
  const uri =
    (typeof configuredUri === 'string' && configuredUri.trim()) || process.env.MONGODB_URI_WEB?.trim() || '';
  const configuredDb = getConfig('mongomation.dbName');
  const dbName =
    (typeof configuredDb === 'string' && configuredDb.trim()) || process.env.MONGODB_DB?.trim() || 'mongomation';
  return { uri, dbName };
}

let client: MongoClient | null = null;
let clientUri: string | null = null;
let pending: { uri: string; promise: Promise<MongoClient> } | null = null;
let lastFailure: { uri: string; at: number; message: string } | null = null;

/** Removes credentials from anything that looks like a connection string before it reaches a browser. */
export function scrubSecrets(message: string): string {
  return message.replace(/(mongodb(?:\+srv)?:\/\/)[^@\s/]+@/gi, '$1***@');
}

export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message || err.name : String(err);
  return scrubSecrets(raw).slice(0, 1000);
}

/** Connection-level driver errors vs. a read that failed on a live connection (e.g. not authorized). */
export function classifyError(err: unknown): AtlasErrorStage {
  if (err instanceof AtlasUnavailableError) return err.stage;
  const name = err instanceof Error ? err.name : '';
  if (/ServerSelection|Network|Topology|NotConnected|PoolClosed|ClientClosed|ParseError/i.test(name)) return 'connect';
  return 'query';
}

function connect(uri: string, dbName: string): Promise<MongoClient> {
  if (pending && pending.uri === uri) return pending.promise;

  let candidate: MongoClient;
  try {
    candidate = new MongoClient(uri, {
      appName: 'mongomation-web',
      serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
      connectTimeoutMS: CONNECT_TIMEOUT_MS,
      maxPoolSize: 10,
    });
  } catch (err) {
    // Malformed URI (MongoParseError) - a configuration problem, not an outage.
    return Promise.reject(new AtlasUnavailableError(`Invalid Atlas URI: ${errorMessage(err)}`, 'config'));
  }

  const promise = candidate
    .connect()
    .then(async () => {
      await candidate.db(dbName).command({ ping: 1 });
      if (readSettings().uri !== uri) {
        // The secret changed while we were connecting; drop this client.
        await candidate.close().catch(() => undefined);
        throw new AtlasUnavailableError('Atlas URI changed while connecting; retrying', 'connect');
      }
      const previous = client;
      client = candidate;
      clientUri = uri;
      lastFailure = null;
      if (previous && previous !== candidate) void previous.close().catch(() => undefined);
      return candidate;
    })
    .catch(async (err: unknown) => {
      lastFailure = { uri, at: Date.now(), message: errorMessage(err) };
      await candidate.close().catch(() => undefined);
      throw err instanceof AtlasUnavailableError ? err : new AtlasUnavailableError(errorMessage(err), 'connect');
    })
    .finally(() => {
      if (pending?.promise === promise) pending = null;
    });

  pending = { uri, promise };
  return promise;
}

/** Returns the MongoMation database, connecting on first use. Throws AtlasUnavailableError. */
export async function getAtlasDb(): Promise<Db> {
  const { uri, dbName } = readSettings();
  if (!uri) {
    throw new AtlasUnavailableError(
      'Atlas URI is not configured: set the mongomation.atlasUri secret in the Modelence dashboard or MONGODB_URI_WEB in the environment',
      'config'
    );
  }
  if (client && clientUri === uri) return client.db(dbName);

  if (lastFailure && lastFailure.uri === uri && Date.now() - lastFailure.at < RETRY_AFTER_MS) {
    throw new AtlasUnavailableError(lastFailure.message, 'connect');
  }
  const connected = await connect(uri, dbName);
  return connected.db(dbName);
}

export function disconnected(err: unknown): Disconnected {
  return { connected: false, error: errorMessage(err), stage: classifyError(err) };
}

/** Runs a read against Atlas and wraps the outcome; never throws for database problems. */
export async function withAtlas<T extends object>(read: (db: Db) => Promise<T>): Promise<Envelope<T>> {
  let db: Db;
  try {
    db = await getAtlasDb();
  } catch (err) {
    return disconnected(err);
  }
  try {
    const data = await read(db);
    return { connected: true, db: db.databaseName, ...data };
  } catch (err) {
    return disconnected(err);
  }
}
