# MongoMation live bridge API (Agent C)

Status: v0.2. The server is running and was checked against real Atlas data. Fields may be added, but existing ones will not be renamed.

- Base URL: `http://localhost:5190`
- CORS allows `http://localhost:5178` and `http://127.0.0.1:5178`.
- All responses are JSON with `Cache-Control: no-store`.
- Errors return HTTP 4xx or 5xx with `{ "error": "human message", "code": "VALIDATION" | "BLOCKED" | "NOT_FOUND" | "DISCONNECTED" }`.
  - 400: VALIDATION
  - 404: NOT_FOUND
  - 409: BLOCKED (a precondition failed; show `error` verbatim)
  - 503: DISCONNECTED (Atlas unreachable)

The server is a thin bridge to the REAL MongoMation system in the WSL repo `/home/zubair/mongomation`:
- **Writes:** it inserts job documents into Atlas `mongomation.jobs`, using the same shape and preconditions as the Modelence mutations `mongomation.generate` and `mongomation.injectFaultAndImprove`.
- **Reads:** it reads what the real worker (`apps/worker`) writes.

Nothing here is simulated. If the worker or the rig is offline, the API says so. **The UI must show that state and must not invent progress.**

Start it in WSL: `bash /mnt/c/Users/zubai/mongomation/prototype/ui-redesign/server/start.sh`. See server/README section at the bottom.

---

## GET /api/health
Check this first, and every ~5 s, to drive the Live/Offline badges.
```json
{ "ok": true, "atlas": "connected", "db": "mongomation",
  "worker": { "online": false, "id": "laptop-worker", "lastBeatAgeMs": 330194, "currentJobId": "6acbe9dac9f28d84f6ffb5d3" },
  "rig": { "live": false, "checkedAgeMs": 331908, "sceneId": "sorting-by-height-basic",
           "openplc":   { "reachable": true, "running": true, "detail": "STATUS:RUNNING" },
           "factoryio": { "reachable": true, "detail": "scene running" } },
  "queued": 0 }
```
- `worker.online`: the worker heartbeated within the last 15 s. If it is false, a new run stays `queued`.
- `rig.live`: the worker's rig monitor wrote `rig_status` within the last 15 s AND Factory I/O was reachable. The rig monitor runs inside the worker, so `rig.live` is false whenever the worker is offline. In that case `openplc`/`factoryio` show the LAST KNOWN state.

## GET /api/scenes
```json
{ "scenes": [ { "id": "sorting-by-height-basic", "title": "Sorting by Height (Basic)", "verified": true, "runnable": true, "blocker": null,
                "description": "Entry conveyor feeding a chain transfer …",
                "tags":   [ { "name": "High sensor", "kind": "diffuse_sensor", "address": null, "direction": null } ],
                "faults": [ { "id": "left-exit-blocked", "title": "…", "description": "…" } ] } ] }
```
Use a scene with `runnable:true` as `sceneId` for `/api/run`. Currently the only scene is `sorting-by-height-basic`.

## GET /api/projects?limit=20
```json
{ "projects": [ { "id": "6acbe2767550671c1f130075", "sceneId": "sorting-by-height-basic",
                  "status": "running|verified|partially_verified|not_verified|failed|blocked",
                  "specText": "…", "origin": "custom|example|benchmark", "createdAt": "2026-10-11T19:24:39.013Z",
                  "currentVersion": 3, "finalPlcVersionId": "6acbe428482eb537db8f4909", "error": null } ] }
```

## POST /api/run   (creates a REAL engineering job)
Request:
```json
{ "specText": "Start/Stop control the entry conveyor. Stop always wins.", "sceneId": "sorting-by-height-basic" }
```
`specText` must be 20 to 8000 characters (trimmed). `sceneId` must match `[a-z0-9-]+`.

Response `201`:
```json
{ "jobId": "6acbf0c1e2a4b5c6d7e8f901", "status": "queued", "worker": { "online": true, "id": "laptop-worker", "lastBeatAgeMs": 900, "currentJobId": null } }
```

Errors:
```json
{ "error": "describe the machine in at least 20 characters", "code": "VALIDATION" }
{ "error": "BLOCKED: cannot engineer on this scene: scene \"no-such-scene\" is not registered in Atlas", "code": "BLOCKED" }
{ "error": "BLOCKED: 5 \"engineer\" jobs are already waiting for a worker. Wait until the worker claims them.", "code": "BLOCKED" }
```

Cost and timing: each run makes real Claude calls (about $0.2 per job) and real rig runs (about 15 min with repairs). Put a confirm step in front of the button.

## GET /api/run/:jobId   (poll every 1.5 to 2 s; stop when `done:true`)
Works for any job id, including ones created by the Modelence UI or scripts. A typical completed job returns about 130 KB, so poll with `?since=` (below) where you can.

Real example, abridged, from job `6acbe2538852650f180417ab`:
```json
{
  "job": { "id": "6acbe2538852650f180417ab", "type": "engineer", "status": "completed", "origin": "example",
           "sceneId": "sorting-by-height-basic", "specText": "Automate the sorting station: …",
           "createdAt": "2026-10-11T19:24:03.058Z", "startedAt": "…", "finishedAt": "…", "claimedBy": "laptop-worker",
           "attempts": 1, "projectId": "6acbe2767550671c1f130075", "error": null,
           "result": { "projectId": "6acbe2767550671c1f130075", "status": "partially_verified", "attempts": 3,
                       "finalPlcVersionId": "6acbe428482eb537db8f4909", "firstCompileOk": true, "costUsd": 0.23, "seconds": 908,
                       "lastSimRun": { "simRunId": "6acbe4847550671c1f131139", "passed": 8, "failed": 1, "blocked": 3 } } },
  "worker": { "online": false, "id": "laptop-worker", "lastBeatAgeMs": 330194, "currentJobId": null },
  "project": { "id": "6acbe2767550671c1f130075", "status": "partially_verified", "sceneId": "sorting-by-height-basic", "specText": "…",
               "revision": 0, "currentVersion": 3, "currentPlcVersionId": "6acbe428…", "finalPlcVersionId": "6acbe428…",
               "harnessVersion": 0, "error": null, "createdAt": "…" },
  "stages": [
    { "stage": "requirements", "attempt": 0, "revision": 0, "status": "done", "runs": 1, "startedAt": "…", "finishedAt": "…", "error": null, "dependsOn": [], "output": { } },
    { "stage": "compile", "attempt": 1, "status": "done", "…": "…" },
    { "stage": "verification", "attempt": 0, "status": "done", "…": "…" } ],
  "requirements": [ { "id": "R1", "kind": "start_stop", "text": "Pressing the Start button runs the line …",
                      "roles": { "start": "Start button" }, "bindings": { "start": "Start", "actuator": "Conveyor entry" }, "support": "supported" } ],
  "io": [ { "variable": "I_HighSensor", "tag": "High sensor", "address": "%QX12.4", "dataType": "BOOL", "role": "sensor", "activeLow": false, "comment": "High sensor" } ],
  "plc": { "versionId": "6acbe428482eb537db8f4909", "version": 3, "sourceHash": "…",
           "source": "(* MongoMation … v3 *)\nPROGRAM mongomation_main\n  VAR\n    I_HighSensor AT %QX12.4 : BOOL; …\nEND_PROGRAM" },
  "plcVersions": [ { "versionId": "…", "version": 1, "createdBy": "codegen|repair", "sourceHash": "…", "createdAt": "…", "diffFromPrevious": "unified-ish line diff or null" } ],
  "compiles": [
    { "plcVersionId": "…", "stage": "preflight", "ok": false, "status": "unavailable", "toolchain": "matiec-iec2c", "log": "IEC2C_PATH / IEC_LIB not set …", "durationMs": 0, "createdAt": "…" },
    { "plcVersionId": "…", "stage": "compile", "ok": true, "status": "ok", "toolchain": "OpenPLC v4 REST @ <rig-url>", "log": "[WARNING] The PLC was running; stopped it before the upload …", "durationMs": 21000, "createdAt": "…" } ],
  "deployments": [ { "plcVersionId": "…", "status": { "reachable": true, "running": true, "detail": "STATUS:RUNNING" }, "runtime": "OpenPLC v4 REST @ <rig-url>", "linkUpMs": 1225, "createdAt": "…" } ],
  "simRuns": [ { "id": "6acbe2987550671c1f130088", "plcVersionId": "…", "status": "done", "passed": 11, "failed": 1, "blocked": 0,
                 "startedAt": "…", "finishedAt": "…", "split": "train", "verdicts": [ { "requirementId": "R1", "status": "verified" } ] } ],
  "tests": [ { "testId": "R6-guard", "title": "Reset does not clear Reset light while the cause is still present", "category": "reset_condition",
               "requirementIds": ["R6"], "verdict": "passed|failed|blocked", "simRunId": "…", "plcVersionId": "…", "split": "train",
               "visibility": "public|hidden", "attempt": 1, "durationMs": 11480, "sampleCount": 191,
               "assertions": [ { "label": "Reset light on", "passed": false, "atMs": 7266, "detail": "Reset light never reached true within 4500 ms" } ],
               "detail": "joined failing assertion details or null", "startedAt": "…" } ],
  "events": [ { "ts": "2026-10-11T19:56:10.0Z", "stage": "requirements", "level": "info", "message": "requirements#0: started" } ],
  "done": true
}
```
Notes:
- `project`, `plc`, and all arrays stay null or empty until the worker claims the job and writes them. A job that is `queued` while `worker.online:false` will not move. Show that state honestly.
- `job.status` takes these values: `queued` → `running` → (`verifying`) → `completed`, `failed`, `blocked`, or `interrupted`.
  - `done` = the status is one of the final four.
  - The verification verdict is in `project.status` / `job.result.status`: `verified`, `partially_verified`, or `not_verified`.
- `stages[]` is ordered by start time. One stage can appear several times with an increasing `attempt` (repair loop: `preflight` → `compile` → `deploy` → `simulate` → `tests` → `diagnosis` → `repair`, then again).
- `tests[]` covers every test the project has ever run, including later fault-and-improve runs. Group the tests by `simRunId`.
- `?since=<ISO ts>` returns only `events` newer than that timestamp. All other fields are always returned in full.
- Private rig URLs are replaced with `<rig-url>`.

## GET /api/io
Live tag values that the worker's rig monitor writes to `rig_status` every 1.5 s.
```json
{ "live": false, "checkedAt": "2026-10-11T19:56:24.518Z", "ageMs": 332992, "sceneId": "sorting-by-height-basic",
  "tags": { "Conveyor entry": false, "Transf. left": false, "Transf. right": false, "Conveyor left": false, "Conveyor right": false,
            "High sensor": true, "Low sensor": true, "Pallet sensor": true, "At left entry": true, "At left exit": true,
            "At right entry": true, "At right exit": true, "Start": false, "Stop": true, "Reset": false, "Emergency stop": true,
            "Auto": false, "Start light": true, "Stop light": false, "Reset light": false, "Loaded": false, "Load": false, "Unload": false,
            "Counter": 117 },
  "forced": ["Emitter", "Remover left", "Remover right"],
  "openplc": { "reachable": true, "running": true, "detail": "STATUS:RUNNING" },
  "factoryio": { "reachable": true, "detail": "scene running" } }
```
- If `live` is false, the values are the LAST KNOWN snapshot from `checkedAt`. Label them stale, for example "last seen 5 min ago".
- Values are booleans, except `Counter`, which is a number.

## POST /api/fault
Request: `{ "projectId": "6acbe2767550671c1f130075", "faultId": "optional, from /api/scenes faults[].id" }`

This creates a real `fault_and_improve` job, with the same preconditions as the Modelence mutation:
- the project exists and has a `finalPlcVersionId`;
- its scene is verified;
- the rig is live (the worker must be running).

Response `201`: `{ "jobId": "…", "status": "queued", "worker": { … } }`. Poll the job with `GET /api/run/:jobId`. Its `result` holds the fault outcome.

Example BLOCKED response:
```json
{ "error": "BLOCKED: project has no final PLC version yet (run engineering to completion first); rig is not live (Factory I/O reachable but status stale; last check 369 s ago)", "code": "BLOCKED" }
```

---

## Running it (for humans)
```
# 1. bridge (WSL; reads Atlas creds from /home/zubair/mongomation/.env, never prints them)
wsl -d Ubuntu -- bash /mnt/c/Users/zubai/mongomation/prototype/ui-redesign/server/start.sh
# 2. the real worker (needed for runs to progress and for live IO), documented in the repo README:
wsl -d Ubuntu -- bash -lc "cd /home/zubair/mongomation && npm run worker"
# 3. static UI
python -m http.server 5178   (in prototype/ui-redesign)
```
