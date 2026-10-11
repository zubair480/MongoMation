// Read-only Atlas checks that gate arming: no running worker job, Factory I/O scene not running.
// The URI is taken from the repo .env (MONGODB_URI_WEB) and is never logged or echoed.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';

const here = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = process.env.PLANT_SIM_ENV_FILE || resolve(here, '../../../.env');
const RIG_FRESH_MS = 30_000;

function envFromFile(name) {
  if (process.env[name]) return process.env[name];
  try {
    const line = readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, '') : undefined;
  } catch {
    return undefined;
  }
}

export class AtlasGuard {
  constructor() {
    this.uri = envFromFile('MONGODB_URI_WEB') || envFromFile('MONGODB_URI');
    this.dbName = envFromFile('MONGODB_DB') || 'mongomation';
    this.client = null;
    this.state = { ok: false, checkedAt: 0, busyJob: null, factoryIoActive: false, program: null, error: 'not checked yet' };
  }

  async db() {
    if (!this.uri) throw new Error('MONGODB_URI_WEB not found in .env');
    if (!this.client) {
      this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 5000, appName: 'plant-sim', readPreference: 'primaryPreferred' });
      await this.client.connect();
    }
    return this.client.db(this.dbName);
  }

  /** Refresh the guard state. Never throws; on failure ok=false with a sanitized error (no hosts, no URI). */
  async check() {
    try {
      const db = await this.db();
      const job = await db.collection('jobs').findOne(
        { status: { $in: ['running', 'verifying'] }, type: { $ne: 'worker_command' } },
        { projection: { _id: 1, type: 1, status: 1 } },
      );
      const rig = await db.collection('rig_status').find({}).sort({ checkedAt: -1 }).limit(1).next();
      const fresh = rig?.checkedAt && Date.now() - new Date(rig.checkedAt).getTime() < RIG_FRESH_MS;
      const fioDetail = rig?.factoryio?.detail ?? null;
      const fioTag = rig?.tags?.['FACTORY I/O (Running)'];
      this.state = {
        ok: true,
        checkedAt: Date.now(),
        busyJob: job ? String(job._id) : null,
        factoryIoActive: !!(fresh && (fioDetail === 'scene running' || fioTag === true)),
        rigFresh: !!fresh,
        program: rig?.openplc?.programName ?? null,
        error: null,
      };
    } catch (e) {
      this.client?.close().catch(() => {});
      this.client = null;
      this.state = { ...this.state, ok: false, checkedAt: Date.now(), error: `Atlas check failed (${e?.name || 'Error'})` };
    }
    return this.state;
  }

  async close() {
    await this.client?.close().catch(() => {});
  }
}
