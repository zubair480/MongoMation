import { Module } from 'modelence/server';
import { ablation, dashboard, plcSource, project, rsi, scenes, testTimeline } from './queries';
import { changeSpec, generate, injectFaultAndImprove, interruptWorker, resumeWorker, runExample } from './mutations';
import { liveAblation, liveAnalytics, liveDashboard, liveProject, liveRsi, liveScenes } from './liveQueries';
import { acknowledgeAlert, addNote, deleteNote, explainFailure, liveNotes, liveOps, preferences, savePreferences } from './notes';
import { guarded, rateLimits } from './guards';
import { cronJobs } from './crons';
import { eventsChannel } from './live';
import { appStores } from './stores';
import { failureFacets, searchFailures, suggestFailures } from './search';
import { artifactLinks } from './artifacts';
import { liveRigAws } from './liveQueries';
import { evidenceTimeline, harnessLineage } from './lineage';

// Worker-owned collections are read through a dedicated MongoClient (./atlas.ts) so that Modelence's
// startup index reconciliation never touches the worker's indexes. `stores` are app-owned only
// (notes, preferences, ops alerts / digests), in Modelence's own database.
const mongomationModule = new Module('mongomation', {
  configSchema: {
    // Set per environment in the Modelence Cloud dashboard (Application tab). Locally, env vars
    // MONGODB_URI_WEB / MONGODB_DB are used instead (Modelence does not map env vars into module configs).
    atlasUri: { type: 'secret', default: '', isPublic: false },
    dbName: { type: 'string', default: '', isPublic: false },
    // Auth gates for every mutation (guards.ts).
    requireVerifiedEmail: { type: 'boolean', default: true, isPublic: false },
    requireOperatorRole: { type: 'boolean', default: false, isPublic: false },
    // "Explain this failure" (@modelence/ai). Keys come from Modelence Cloud → AI → Integrations.
    aiProvider: { type: 'string', default: 'google', isPublic: false },
    aiModel: { type: 'string', default: '', isPublic: false },
  },

  stores: appStores,

  // Public, read-only. `live*` are Modelence live queries (LiveData) fed by one shared Atlas change stream.
  queries: {
    dashboard,
    scenes,
    project,
    plcSource,
    testTimeline,
    rsi,
    ablation,
    liveDashboard,
    liveScenes,
    liveProject,
    liveRsi,
    liveAblation,
    liveAnalytics,
    liveNotes,
    liveOps,
    preferences,
    // Atlas Search (lexical) over diagnosed failures.
    searchFailures,
    suggestFailures,
    failureFacets,
    // AWS: presigned S3 artifact links (fail soft) and rig_status.aws (live).
    artifactLinks,
    liveRigAws,
    // $graphLookup harness lineage + $unionWith project evidence timeline (lineage.ts).
    harnessLineage,
    evidenceTimeline,
    simLive: (a: unknown) => import('./simlive').then((m) => m.simLive(a)), // HMI twin during tests (simlive.ts)
  },

  // Signed-in, verified users only (guards.ts), rate limited. Job mutations insert one document into `jobs`.
  mutations: {
    generate: guarded('mm.job', generate),
    runExample: guarded('mm.job', runExample),
    injectFaultAndImprove: guarded('mm.job', injectFaultAndImprove),
    changeSpec: guarded('mm.job', changeSpec),
    interruptWorker: guarded('mm.job', interruptWorker),
    resumeWorker: guarded('mm.job', resumeWorker),
    addNote,
    deleteNote,
    explainFailure,
    acknowledgeAlert,
    savePreferences,
  },

  rateLimits,
  cronJobs,
  channels: [eventsChannel],
});

export default mongomationModule;
