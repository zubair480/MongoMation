# MongoMation READ API (Agent E) — http://localhost:5191

Live, **read-only** data from the real MongoDB Atlas database (`mongomation`) that the real worker writes to.
Logic and shapes mirror `apps/web/src/server/mongomation/queries.ts` + `docs.ts` in the WSL repo
(`docs.ts` is copied verbatim into `server-read/`, so every DTO is the same whitelisted shape the real app renders).
The WRITE side (create runs/jobs) is Agent C's API on :5190, see `API.md`. C also exposes a small /api/health + /api/scenes for write preconditions; use :5191 for all detailed/live reads (project, PLC, timeline, harness, ablation, SSE).

- Start: `cd prototype/ui-redesign/server-read && npm start` (Node >= 22.18, uses built-in TS type stripping; `npm i` once).
- Secrets: the Atlas URI is read at runtime from the real app's env file
  (`\\wsl.localhost\Ubuntu\home\zubair\mongomation\apps\web\.env`, var `MONGODB_URI_WEB`; optional `MONGODB_DB`,
  override path with `MM_ENV_FILE`). It is never logged or returned.
- CORS: `http://localhost:5178` (and any `http://localhost:<port>` / `127.0.0.1:<port>`). GET/OPTIONS only; anything else → 405.
- Caching: 1 s shared cache per query (PLC source 60 s, timeline 5 s), cleared on every change-stream event.
  Every response carries `cacheAgeMs`.
- Dates are ISO strings. Fields the worker did not write are **omitted** (not null) — render an empty state.

## Envelope (every JSON endpoint)

```ts
// success
{ connected: true, db: "mongomation", cacheAgeMs: number, ...data }
// Atlas down / misconfigured / query failed (HTTP 200, except /api/health → 503)
{ connected: false, error: string, stage: "config" | "connect" | "query" }
```
Always check `connected` and show DISCONNECTED + `error` instead of stale numbers.

## Endpoints

| Method/Path | Returns |
|---|---|
| `GET /api/health` | Atlas ping, newest worker heartbeat + age, rig status, queue, active job, live-stream status |
| `GET /api/dashboard` | full mirror of `queries.dashboard` (workers, rig, latestJobs, activeJob, lastJob, checkpoints, projects) |
| `GET /api/projects?limit=25` | recent projects (1..100) |
| `GET /api/project/:id` | mirror of `queries.project`: project, requirements, stages, events, plcVersions, compiles, simRun, tests, verdicts, faults, diagnosis |
| `GET /api/plc/:versionId` | PLC Structured Text source + diff |
| `GET /api/timeline/:simRunId/:testId` | measured tag timeline of one PUBLIC test (change points) |
| `GET /api/harness` (alias `/api/rsi`) | RSI: active harness, versions, latest proposal, candidate, gate table, lessons |
| `GET /api/ablation` | ablation summary (bare vs v0 vs vN) / in-progress benchmark |
| `GET /api/scenes` | Factory I/O scene registry (tags with PLC addresses, injectable faults) |
| `GET /api/events/stream` | SSE: pushes every DB change (change stream; falls back to 1 s polling) |

Hidden regression tests are reduced to `{visibility:"hidden", category, verdict}` and their ids are scrubbed
from free text (`[hidden test]`), exactly like the real app.

---

### GET /api/health
```ts
{
  connected: true, db: "mongomation", serverTime: string,
  atlas: { connected: true, db: string, pingMs: number },
  worker: { id, host?, heartbeatAt?, heartbeatAgeMs?, alive: boolean /* heartbeat < 15 s, same rule as C :5190 worker.online */, currentJobId? } | null,
  workers: WorkerLite[],            // { id, host?, pid?, heartbeatAt?, heartbeatAgeMs?, currentJobId? }
  rig: RigLite | null,              // see below
  queuedCount: number,
  activeJob: JobLite | null,
  live: { mode: "change_stream" | "polling" | "idle", subscribers: number, changesSeen: number, lastError: string | null },
  cacheAgeMs: number
}
// on failure: HTTP 503 { connected:false, error, stage, atlas:{connected:false,error,stage}, envFileFound }
```
Real example (2026-10-11):
```json
{"connected":true,"db":"mongomation","serverTime":"2026-10-11T20:02:33.147Z",
 "atlas":{"connected":true,"db":"mongomation","pingMs":38},
 "worker":{"id":"laptop-worker","host":"Zubair","heartbeatAt":"2026-10-11T19:56:25.424Z","heartbeatAgeMs":367723,"alive":false,"currentJobId":"6acbe9dac9f28d84f6ffb5d3"},
 "workers":[{"id":"laptop-worker","host":"Zubair","pid":177825,"heartbeatAt":"2026-10-11T19:56:25.424Z","heartbeatAgeMs":367723,"currentJobId":"6acbe9dac9f28d84f6ffb5d3"}],
 "rig":{"id":"rig-1","checkedAt":"2026-10-11T19:56:24.518Z","ageMs":368629,"sceneId":"sorting-by-height-basic",
   "openplc":{"reachable":true,"running":true,"detail":"STATUS:RUNNING"},
   "factoryio":{"reachable":true,"detail":"scene running"},
   "forced":["Emitter","Remover left","Remover right"],
   "tags":{"Transf. right":false,"Transf. left":false,"Unload":false,"Load":false,"Conveyor entry":false,"Conveyor left":false,"Conveyor right":false,
           "High sensor":true,"Low sensor":true,"Pallet sensor":true,"At left entry":true,"At right entry":true,"At right exit":true,"At left exit":true,
           "Start light":true,"Start":false,"Stop light":false,"Stop":true,"Reset light":false,"Reset":false,"Emergency stop":true,"Loaded":false,"Auto":false,"Counter":117},
   "dcvUrl":"https://<redacted>:8443/"},
 "queuedCount":0,
 "activeJob":{"id":"6acbe9dac9f28d84f6ffb5d3","type":"engineer","status":"running","origin":"example","sceneId":"sorting-by-height-basic","projectId":"6acbe9dad1ddf164b497ee16","claimedBy":"laptop-worker","heartbeatAt":"2026-10-11T19:56:25.384Z","heartbeatAgeMs":367763,"attempts":1,"createdAt":"2026-10-11T19:56:10.062Z","createdAgeMs":383085,"startedAt":"2026-10-11T19:56:10.117Z","specExcerpt":"Automate the sorting station: Start/Stop buttons run the line ..."},
 "live":{"mode":"idle","subscribers":0,"changesSeen":0,"lastError":null},"cacheAgeMs":0}
```
`rig.tags` is the **live IO image** (tag name → boolean/number) — use it for the dashboard IO panel.
Map tag names to PLC addresses via `/api/scenes` → `scenes[].tags[].plcAddress`.

### Shared types
```ts
JobLite = { id, type /* engineer | fault_and_improve | spec_change | worker_command */, status /* queued|running|verifying|done|failed|... */,
  origin?, command?, sceneId?, projectId?, faultId?, claimedBy?, handledBy?, heartbeatAt?, heartbeatAgeMs?, attempts?,
  resumedFrom?, interruptedAt?, error?, requestedBy?, createdAt?, createdAgeMs?, startedAt?, finishedAt?, specExcerpt? }
RigLite = { id, checkedAt?, ageMs?, sceneId?, openplc?: {reachable?, running?, detail?}, factoryio?: {reachable?, detail?},
  forced: string[], tags: Record<string, boolean|number>, dcvUrl? }
StageLite = { stage /* requirements|codegen|compile|deploy|tests|verification|diagnosis|repair|... */, attempt, status? /* running|done|failed|skipped */,
  startedAt?, finishedAt?, durationMs?, error?, runs?, dependsOn: string[], jobId? }
ProjectListItem = { id, specExcerpt, sceneId?, status?, currentVersion?, attempts?, harnessVersion?, costUsd?, createdAt? }
```

### GET /api/dashboard
```ts
{ connected, db, serverTime, workers: WorkerLite[], rig: RigLite|null,
  latestJobs: { generate: JobLite|null, example: JobLite|null, fault: JobLite|null, specChange: JobLite|null, command: JobLite|null },
  queuedCount, activeJob: JobLite|null, lastJob: JobLite|null,
  checkpointProjectId: string|null, checkpoints: StageLite[] /* stages of the active/last job's project = live workflow */,
  projects: ProjectListItem[] /* 25 newest */, cacheAgeMs }
```
(`authDbConfigured` from the real app is omitted — Modelence-only.)

### GET /api/projects?limit=25
```json
{"connected":true,"db":"mongomation","projects":[
 {"id":"6acbe9dad1ddf164b497ee16","specExcerpt":"Automate the sorting station: Start/Stop buttons run the line (Stop always wins, ...","sceneId":"sorting-by-height-basic","status":"running","currentVersion":0,"attempts":0,"harnessVersion":0,"createdAt":"2026-10-11T19:56:10.1Z"},
 {"id":"6acbe2767550671c1f130075","specExcerpt":"Automate the sorting station: ...","sceneId":"sorting-by-height-basic","status":"partially_verified","currentVersion":3,"attempts":3,"harnessVersion":0,"costUsd":0.230256,"createdAt":"2026-10-11T19:24:39.013Z"}
],"cacheAgeMs":0}
```
Project `status` values seen: `running`, `partially_verified`, `blocked` (also `verified`, `failed` per worker).

### GET /api/project/:id
```ts
{
  connected, db,
  project: { id, specText?, sceneId?, status?, harnessVersion?, currentPlcVersionId?, currentVersion?, finalPlcVersionId?,
             lastSimRunId?, attempts?, costUsd?, createdAt?, unsupported: {id?, reason?}[] } | null,
  requirements: { revision?, sceneId?, items: {id, kind?, text?, bindings: Record<role,tag>, support?, unsupportedReason?}[],
                  io: {variable?, tag?, address?, dataType?, role?, normallyClosed?}[] } | null,
  stages: StageLite[],                    // ascending by startedAt (workflow / checkpoints)
  events: {id, ts?, level?, stage?, message, jobId?}[],  // newest first, max 100
  plcVersions: {id, version?, createdBy? /* codegen|repair */, harnessVersion?, sourceHash?, createdAt?}[],  // newest first
  compiles: {id, plcVersionId?, stage?, toolchain?, status?, ok?, durationMs?, log? /* last 4000 chars */, logTruncated, createdAt?}[],
  simRun: {id, status?, plcVersionId?, sceneId?, faultId?, planHash?, harnessVersion?, startedAt?, finishedAt?, passed?, failed?, blocked?} | null,
  tests: TestLite[],   // of the latest simRun
  testCounts: { passed, failed, blocked, total },
  verdicts: { requirementId, status? /* satisfied|violated|blocked */, testIds: string[], detail? }[],
  verdictSource: { kind: "sim_run", simRunId, latestRun: boolean } | { kind: "project", simRunId? } | null,
  faults: { id, faultId?, tag?, value?, readBack?, status?, appliedAt?, releasedAt? }[],
  diagnosis: { id, plcVersionId?, summary?, causes: {requirementId?, cause?, fix?}[], lessons: {pattern?, fix?}[], traceId?, createdAt? } | null,
  cacheAgeMs
}
TestLite (public) = { id, simRunId?, category?, requirementIds, verdict? /* passed|failed|blocked */, blockedReason?, durationMs?, sampleCount?, traceId?,
                      visibility: "public", testId, title, assertions: {label?, passed?, detail?, atMs?}[] }
TestLite (hidden) = { ...same base, visibility: "hidden", title: "Hidden regression: <category>", assertions: [] }   // no testId
```
Real example (trimmed to 1 item per array) — `GET /api/project/6acbe2767550671c1f130075`:
```json
{"connected":true,"db":"mongomation",
 "project":{"id":"6acbe2767550671c1f130075","specText":"Automate the sorting station: Start/Stop buttons run the line (Stop always wins, Emergency stop stops everything). Send tall boxes (high sensor) to the right lane and short boxes to the left lane using the chain transfer. If the left exit eye stays blocked for more than 3 seconds, stop the left conveyor and light the Reset light as a fault lamp until Reset is pressed with the eye clear.","sceneId":"sorting-by-height-basic","status":"partially_verified","harnessVersion":0,"currentPlcVersionId":"6acbe428482eb537db8f4909","currentVersion":3,"finalPlcVersionId":"6acbe428482eb537db8f4909","lastSimRunId":"6acbe4847550671c1f131139","attempts":3,"costUsd":0.230256,"createdAt":"2026-10-11T19:24:39.013Z","unsupported":[]},
 "requirements":{"revision":0,"sceneId":"sorting-by-height-basic",
   "items":[{"id":"R1","kind":"start_stop","text":"Pressing the Start button runs the line and it stays running via seal-in; pressing the Stop button stops the line and Stop dominates Start.","bindings":{"start":"Start","stop":"Stop","actuator":"Conveyor entry"},"support":"supported"}],
   "io":[{"variable":"I_HighSensor","tag":"High sensor","address":"%QX12.4","dataType":"BOOL","role":"sensor"}]},
 "stages":[{"stage":"requirements","attempt":0,"status":"done","startedAt":"2026-10-11T19:24:39.056Z","finishedAt":"2026-10-11T19:24:45.756Z","durationMs":6700,"runs":1,"dependsOn":[],"jobId":"6acbe2538852650f180417ab"}],
 "events":[{"id":"6acbe880d1ddf164b497e835","ts":"2026-10-11T19:50:24.940Z","level":"info","stage":"verification","message":"fault left-exit-blocked handled correctly: 2/5 fault tests passed","jobId":"6acbe7c849692bcadd127975"}],
 "plcVersions":[{"id":"6acbe428482eb537db8f4909","version":3,"createdBy":"repair","harnessVersion":0,"sourceHash":"e508cf6d...","createdAt":"2026-10-11T19:31:54.335Z"}],
 "compiles":[{"id":"6acbe4307550671c1f131133","plcVersionId":"6acbe428482eb537db8f4909","stage":"compile","toolchain":"OpenPLC v4 REST @ https://<redacted>/openplc","ok":true,"durationMs":5979,"log":"...","logTruncated":true,"createdAt":"2026-10-11T19:32:00.671Z"}],
 "simRun":{"id":"6acbe821d1ddf164b497e577","status":"done","plcVersionId":"6acbe428482eb537db8f4909","sceneId":"sorting-by-height-basic","faultId":"left-exit-blocked","planHash":"4c7e...:fault:left-exit-blocked","harnessVersion":0,"startedAt":"2026-10-11T19:48:49.164Z","finishedAt":"2026-10-11T19:50:24.822Z","passed":2,"failed":0,"blocked":3},
 "tests":[
  {"id":"6acbe82bd1ddf164b497e5d4","simRunId":"6acbe821d1ddf164b497e577","category":"timer","requirementIds":["R4"],"verdict":"passed","durationMs":9684,"sampleCount":91,"traceId":"dd31f964-...","visibility":"public","testId":"R4-jam","title":"A At left exit blocked longer than 3000 ms stops Conveyor left and lights Reset light","assertions":[{"label":"Conveyor left running","passed":true,"detail":"Conveyor left = true after 21 ms (limit 1500 ms)","atMs":6096}]},
  {"id":"6acbe844d1ddf164b497e611","simRunId":"6acbe821d1ddf164b497e577","category":"timer","requirementIds":["R4"],"verdict":"blocked","blockedReason":"insufficient measurements for at least one assertion","durationMs":8168,"sampleCount":58,"traceId":"dd31f964-...","visibility":"hidden","title":"Hidden regression: timer","assertions":[]}],
 "testCounts":{"passed":2,"failed":0,"blocked":3,"total":5},
 "verdicts":[{"requirementId":"R1","status":"blocked","testIds":[],"detail":"0/0 planned tests produced results"}],
 "verdictSource":{"kind":"sim_run","simRunId":"6acbe821d1ddf164b497e577","latestRun":true},
 "faults":[{"id":"6acbe820d1ddf164b497e575","faultId":"left-exit-blocked","tag":"At left exit","value":"false","readBack":"false","appliedAt":"2026-10-11T19:48:48.813Z","releasedAt":"2026-10-11T19:48:49.023Z"}],
 "diagnosis":{"id":"6acbe41b7550671c1f131129","plcVersionId":"6acbe34e482eb537db8f4901","summary":"R5 failed because the Reset light was not on when the left-exit cause cleared. ...","causes":[{"requirementId":"R5","cause":"...","fix":"Debounce the eye before the timer ..."}],"lessons":[{"pattern":"A jam or timeout timer is fed directly from a raw sensor, ...","fix":"Condition the sensor with a short off-delay or debounce ..."}],"traceId":"42324e31-...","createdAt":"2026-10-11T19:31:39.431Z"},
 "cacheAgeMs":0}
```
Good demo ids: `6acbe2767550671c1f130075` (partially_verified, 3 PLC versions, 97 events), `6acbd8d6ccb22d8b6c1391b4` (13 tests).
An unknown id returns `connected:true, project:null` and empty arrays.

### GET /api/plc/:versionId
```ts
{ connected, db, found: true, id, version?, createdBy?, source: string /* IEC 61131-3 ST */, diff: string[] | null, cacheAgeMs }
| { connected, db, found: false, id, diff: null, cacheAgeMs }
```
```json
{"connected":true,"db":"mongomation","found":true,"id":"6acbe428482eb537db8f4909","version":3,"createdBy":"repair",
 "source":"(* MongoMation 6acbe2767550671c1f130075 v3 (harness v0, scene sorting-by-height-basic) *)\nPROGRAM mongomation_main\n  VAR\n    I_HighSensor AT %QX12.4 : BOOL; (* High sensor *)\n    I_AtLeftExit AT %QX13.1 : BOOL; ...",
 "diff":["..."],"cacheAgeMs":0}
```

### GET /api/timeline/:simRunId/:testId
`testId` is the public test id (`tests[].testId`, URL-encode it). Samples are change points of the tag values over the test (ms from test start).
```ts
{ connected, db, simRunId, testId, found: boolean, hidden: boolean,
  samples: { t: number, values: Record<tag, boolean|number> }[], totalSamples: number, truncated: boolean,
  durationMs?: number, assertions: {label?, passed?, detail?, atMs?}[], cacheAgeMs }
```
```json
{"connected":true,"db":"mongomation","simRunId":"6acbe821d1ddf164b497e577","testId":"R4-jam",
 "samples":[{"t":76,"values":{"At left exit":true,"Conveyor left":false,"Reset light":true,"Start":false}},
            {"t":5031,"values":{"At left exit":true,"Conveyor left":false,"Reset light":false,"Start":true}},
            {"t":5685,"values":{"At left exit":true,"Conveyor left":true,"Reset light":false,"Start":true}},
            {"t":9567,"values":{"At left exit":false,"Conveyor left":false,"Reset light":true,"Start":false}}],
 "totalSamples":91,"truncated":false,"found":true,"hidden":false,"durationMs":9684,
 "assertions":[{"label":"Conveyor left running","passed":true,"detail":"Conveyor left = true after 21 ms (limit 1500 ms)","atMs":6096}],"cacheAgeMs":0}
```

### GET /api/harness  (alias /api/rsi)
```ts
{ connected, db,
  active: HarnessDetail | null,              // newest version with verdict "kept"
  versions: HarnessVersionLite[],            // { version, parent?, verdict? /* kept|rejected|pending */, rationale?, gateNote?, createdAt?, decidedAt?, rulesCount, hasScores }
  latestProposal: { id, createdAt?, fromVersion?, candidateVersion?, change?, rationale?, expectedEffect?, citedRunIds: string[],
                    diff: string[], guardrailViolations: string[], verdict?, benchmarkIds: string[], provenance? } | null,
  candidate: HarnessDetail | null,           // the proposal's candidate version
  proposalCount: number,
  gate: { version?, parent?, verdict?, scores: Scores|null, parentScores: Scores|null, gateNote?, decidedAt? }[],   // gate table, newest first
  lessons: { id, pattern?, fix?, verified: boolean, active?, createdAt?, updatedAt?, projectId? }[],   // `lessons` collection (verified memory)
  lessonCount: number,
  diagnosisLessons: { diagnosisId, projectId?, createdAt?, pattern?, fix? }[],   // lessons proposed by the 10 newest diagnoses
  cacheAgeMs }
HarnessDetail = HarnessVersionLite & { rules: string[], scores?: Scores, parentScores?: Scores,
  evidence?: {runIds, testResultIds, raindropEventIds}, settings: { section: "context"|"workflow"|"repair"|"routing", values: Record<string,string> }[] }
Scores = { cases?, requirement_satisfaction?, safety_pass_rate?, compile_first_try?, test_pass_rate?, repairs_per_case?, cost_usd_per_case?, seconds_per_case? }
```
Real data today: only v0 (kept, no scores), 3 proposals (latest `no_change`), `lessons` collection empty, 15 `diagnosisLessons`.
```json
{"connected":true,"db":"mongomation",
 "active":{"version":0,"verdict":"kept","rationale":"Baseline (v0): engineering loop with independent tests, no learned rules.","createdAt":"2026-10-11T00:00:00.000Z","rulesCount":0,"hasScores":false,"rules":[],
   "settings":[{"section":"context","values":{"lessons_k":"3","retrieve_similar_failures":"false","failures_k":"0","include_previous_attempt":"true"}},
               {"section":"workflow","values":{"state_machine_before_code":"false","preflight_compile":"true","repair_budget":"2","module_split_threshold":"8","run_regression_tests":"true"}},
               {"section":"repair","values":{"strategy":"full_rewrite","isolate_failing_requirements":"false"}},
               {"section":"routing","values":{"requirements":"fast","codegen":"fast","critic":"strong","repair":"fast","escalate_after_failures":"0"}}]},
 "versions":[{"version":0,"verdict":"kept","rationale":"Baseline (v0): ...","createdAt":"2026-10-11T00:00:00.000Z","rulesCount":0,"hasScores":false}],
 "latestProposal":{"id":"6acbe881d1ddf164b497e836","createdAt":"2026-10-11T19:50:25.190Z","fromVersion":0,"change":false,"rationale":"No repeated failure pattern under v0 (0 distinct failures, none seen 2+ times). No justified harness change.","citedRunIds":[],"diff":[],"guardrailViolations":[],"verdict":"no_change","benchmarkIds":[],"provenance":"live"},
 "candidate":null,"proposalCount":3,
 "gate":[{"version":0,"verdict":"kept","scores":null,"parentScores":null}],
 "lessons":[],"lessonCount":0,
 "diagnosisLessons":[{"diagnosisId":"6acbe41b7550671c1f131129","projectId":"6acbe2767550671c1f130075","createdAt":"2026-10-11T19:31:39.431Z","pattern":"A jam or timeout timer is fed directly from a raw sensor, so a single-scan dropout silently restarts the count and the fault never trips.","fix":"Condition the sensor with a short off-delay or debounce before the timeout timer, so brief flickers do not reset the accumulated time."}],
 "cacheAgeMs":0}
```

### GET /api/ablation
```ts
{ connected, db,
  summary: { benchmarkId, manifestHash?, createdAt?, model?: {fast?, strong?},
             conditions: { key /* "bare" | "v0" | "vN" */, version?, scores?: Scores, rows: number }[] } | null,
  inProgress: { benchmarkId, rows: number, lastRowAt? } | null,
  summaryCount: number, cacheAgeMs }
```
Real today: `{"connected":true,"db":"mongomation","summary":null,"inProgress":null,"summaryCount":0,"cacheAgeMs":0}` (no ablation run yet — render empty state).

### GET /api/scenes
```ts
{ connected, db, scenes: { id, title?, description?, factoryIoScene?, verified: boolean, capabilities: string[],
    tags: { name, role? /* sensor|actuator|... */, dataType?, plcAddress?, kind?, normallyClosed? }[],
    faults: { id, title?, kind?, tag?, value?, description? }[] }[], cacheAgeMs }
```
```json
{"connected":true,"db":"mongomation","scenes":[{"id":"sorting-by-height-basic","title":"Sorting by Height (Basic)","description":"Entry conveyor feeding a chain transfer ...","factoryIoScene":"Sorting by Height (Basic)","verified":true,
  "capabilities":["conveyor","chain_transfer","diffuse_sensor","retroreflective_sensor","pushbutton","emergency_stop","selector","light","counter_display"],
  "tags":[{"name":"High sensor","role":"sensor","dataType":"BOOL","plcAddress":"%QX12.4","kind":"diffuse_sensor"},{"name":"Low sensor","role":"sensor","dataType":"BOOL","plcAddress":"%QX12.5","kind":"diffuse_sensor"}],
  "faults":[{"id":"pallet-sensor-stuck-on","title":"Pallet sensor stuck ON","kind":"stuck_on","tag":"Pallet sensor","value":true,"description":"A box (or a dirty lens) keeps the pallet sensor active: a jam at the transfer."}]}],"cacheAgeMs":0}
```

### GET /api/events/stream  (Server-Sent Events)
One shared MongoDB change stream on the whole `mongomation` db (watched collections: jobs, workers, rig_status, projects,
stages, events, requirements, plc_versions, compile_results, sim_runs, test_results, fault_injections, diagnoses, scenes,
harness_versions, rsi_proposals, benchmark_runs, lessons). If the change stream fails, it falls back to polling every 1 s.
Events:
```
event: hello   data: { serverTime, live: {mode, subscribers, changesSeen, lastError} }
event: change  data: { coll, op: "insert"|"update"|"replace"|"delete"|"poll", id?, projectId?, simRunId?, jobId?, ts }
event: event   data: { projectId, event: { id, ts?, level?, stage?, message, jobId? } }   // each new worker log line (hidden ids scrubbed)
event: ping    data: { serverTime, live }   // every 15 s
```
Note: on `update` events `projectId` is usually absent (no full document) — treat "no projectId" as "may concern any project".
Client pattern:
```js
const es = new EventSource('http://localhost:5191/api/events/stream');
es.addEventListener('change', (e) => { const c = JSON.parse(e.data); if (['rig_status','workers','jobs'].includes(c.coll)) refetchHealth(); if (!c.projectId || c.projectId === currentId) refetchProject(); });
es.addEventListener('event', (e) => appendLog(JSON.parse(e.data).event));
```
`measurements` (time series) cannot be watched; `test_results`/`sim_runs` writes accompany them, so refetch the timeline on those.
