import { Module } from 'modelence/server';
import { dashboard, plcSource, project, rsi, scenes, testTimeline } from './queries';
import { changeSpec, generate, injectFaultAndImprove, interruptWorker, resumeWorker, runExample } from './mutations';

// No `stores`: worker-owned collections are read through a dedicated MongoClient (./atlas.ts) so that
// Modelence's startup index reconciliation never touches the worker's indexes.
const mongomationModule = new Module('mongomation', {
  configSchema: {
    // Set per environment in the Modelence Cloud dashboard (Application tab). Locally, env vars
    // MONGODB_URI_WEB / MONGODB_DB are used instead (Modelence does not map env vars into module configs).
    atlasUri: { type: 'secret', default: '', isPublic: false },
    dbName: { type: 'string', default: '', isPublic: false },
  },

  // Public, read-only.
  queries: {
    dashboard,
    scenes,
    project,
    plcSource,
    testTimeline,
    rsi,
  },

  // Signed-in users only; each inserts one document into `jobs`.
  mutations: {
    generate,
    runExample,
    injectFaultAndImprove,
    changeSpec,
    interruptWorker,
    resumeWorker,
  },
});

export default mongomationModule;
