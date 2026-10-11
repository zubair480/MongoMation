# MongoMation dashboard (`apps/web`)

A [Modelence](https://modelence.com) app that shows what the MongoMation worker is doing: the spec,
the engineering pipeline, the generated IEC 61131-3 program, compile results, independent tests with
measured timelines, requirement verdicts, the self-improving harness (RSI), and long-horizon recovery.

- **Reads** engineering state from MongoDB Atlas (written only by the worker in `apps/worker`).
- **Writes** only to the `jobs` collection (requests for the worker). Nothing else is ever written.
- **No invented data.** Every value on screen comes from a query; missing data is an explicit empty state
  (`No runs yet`, `DISCONNECTED: <driver error>`, `BLOCKED: <reason>`).
- UI refresh is plain polling (react-query `refetchInterval`, 1.5–5 s), no live queries.

This package is **standalone** (own `package.json` / lockfile; not part of the root npm workspaces).
Node **22+** is required (Modelence `engines`).

## Run locally

```bash
cd apps/web
npm install
npm run dev            # http://localhost:3000 (PORT / MODELENCE_PORT to change)
```

Environment variables (export them, or put them in `apps/web/.env`, which is gitignored and loaded at start):

| Variable | Purpose |
|---|---|
| `MONGODB_URI_WEB` | Connection string for the **dashboard Atlas user** (read on `mongomation`, insert on `mongomation.jobs`). Fallback for the `mongomation.atlasUri` secret. |
| `MONGODB_DB` | Database name of the MongoMation data. Default `mongomation`. Fallback for the `mongomation.dbName` config. |
| `MONGODB_URI` | Modelence's **own** database (users, sessions, locks) when the app is *not* connected to Modelence Cloud. Use a separate database, e.g. `mongodb+srv://…/mongomation_web_auth`. Without it the dashboard still renders, but sign-in (and therefore every button) is unavailable. Ignored once the app is connected to Modelence Cloud. |
| `MODELENCE_TRACKING_ENABLED=false` | Stops the start-up ping to `cloud.modelence.com/api/track/app-start`. |

Production build, locally:

```bash
npm run build                     # -> .modelence/build/{app.mjs,client/,ssr/}
NODE_ENV=production npm start     # without NODE_ENV=production Modelence serves through a Vite dev server
```

Smoke test (no login needed; queries are public and read-only):

```bash
curl -s -X POST http://localhost:3000/api/_internal/method/mongomation.dashboard \
  -H 'Content-Type: application/json' -d '{"args":{}}'
# no Atlas configured -> {"data":{"connected":false,"error":"Atlas URI is not configured: …","stage":"config"}, …}
```

Type check: `npx tsc --noEmit` (or `npm run typecheck`).

## Modelence Cloud: set up and deploy

1. Sign up at <https://cloud.modelence.com>, create an **Application**, then an **Environment**
   (type *cloud* hosts the app; type *local* only provisions a database for your machine).
2. Optional, to develop against a Cloud environment: `npx modelence@latest setup` (browser device flow), or
   `npx modelence@latest setup --token <setup-token>` (token from Environment Settings → "Setup Local
   Environment"). It writes `.modelence.env` (gitignored) and records the app in `.modelence/project.json`.
   After this, `MONGODB_URI` is ignored: Modelence uses the environment's own database.
3. Deploy from this directory:

   ```bash
   cd apps/web
   npx modelence@latest deploy                    # browser sign-in, pick or confirm app/env
   npx modelence@latest deploy --app <app> --env <env>
   # CI / headless:
   CI=1 MODELENCE_TOKEN=<token> npx modelence@latest deploy --app <app> --env <env>
   ```

   The CLI builds locally (`modelence build`), uploads `.modelence/build` with `package.json`,
   `package-lock.json` and `modelence.config.ts`, and streams the rollout log until "Live at <url>".
4. In Atlas **Network Access**, allow the Modelence Cloud egress addresses (they are not published; for the
   hackathon this likely means `0.0.0.0/0`).

## The `atlasUri` secret

The module declares two settings (`src/server/mongomation/index.ts`):

| Key | Type | Value |
|---|---|---|
| `mongomation.atlasUri` | secret | the dashboard user's connection string, e.g. `mongodb+srv://mm_web:<password>@<cluster>.mongodb.net/?appName=mongomation-web` |
| `mongomation.dbName` | string | optional; defaults to `MONGODB_DB`, then `mongomation` |

In the Modelence Cloud dashboard open your environment → **Application** tab → module `mongomation` →
set `atlasUri` (and `dbName` if needed). Values sync to running instances about every 10 s and the dashboard
reconnects when the URI changes, so no redeploy is needed. Modelence does not map environment variables onto
module settings, so locally (no Cloud connection) the env fallbacks `MONGODB_URI_WEB` / `MONGODB_DB` are used.
The secret is never sent to browsers (it is not `isPublic`), and driver errors are scrubbed of credentials
before they are shown.

Recommended Atlas user for the dashboard: built-in `read` on the `mongomation` database plus a custom role
with `insert` on `mongomation.jobs` (the dashboard needs nothing else; `.env.example` at the repo root
describes the same split).

## Security notes

- **Template demo access removed.** The scaffold's demo-user migration (`demo@modelence.dev` / `12345678`),
  the public `example.modelenceDemoUsername/Password` configs, the sandbox auto-login, the login-form
  prefill, and the example module/pages are gone. The app registers no migrations.
- **Mutations require a signed-in user** (`AuthError`, HTTP 401), validate their arguments with zod
  (HTTP 400 with a readable message), and re-check every precondition on the server (HTTP 409
  `BLOCKED: …`): runs need a VERIFIED scene; fault injection needs a fresh rig status (< 10 s) with Factory
  I/O reachable, a verified scene and a project with `finalPlcVersionId`.
- **Queue guards.** At most 5 unclaimed jobs per type; a duplicate `interrupt` / `resume` command that is
  still waiting is refused.
- **Read-only queries are public on purpose** (anyone with the URL can watch). They never return test
  `steps` / `stepLogs`, stage `output`, or event `data`. Hidden regression tests are reduced to
  "Hidden regression: <category>" + verdict (no id, title, assertions or measured timeline), and hidden
  test ids are redacted from event messages, stage errors and job errors.
- **Worker collections are not Modelence Stores**, so Modelence's startup index reconciliation never
  touches the worker's indexes; the dashboard reads them through its own `MongoClient`.
- **Clickjacking:** the template allowed framing by `*.modelence.com`; this app keeps the default
  `frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN`.
- **Sign-up is open** (Modelence email/password auth). Anyone who signs up can queue jobs, within the queue
  guards above. Restrict sign-up in Modelence auth settings if the URL is shared widely.
- Reads are shared between viewers for up to 1 s per server process (`src/server/mongomation/cache.ts`), so
  many viewers do not multiply load on the Atlas cluster; a job request invalidates the shared dashboard read.

## Code map

```
src/server/app.ts                 startApp: only the mongomation module, no migrations
src/server/mongomation/
  index.ts      Module 'mongomation': configSchema, queries, mutations
  atlas.ts      dedicated MongoClient (config secret -> env fallback), connection backoff, envelopes
  cache.ts      1 s shared read cache with in-flight de-duplication
  docs.ts       whitelisting mappers for worker documents (+ hidden-test redaction)
  queries.ts    dashboard, scenes, project, plcSource, testTimeline, rsi
  mutations.ts  generate, runExample, injectFaultAndImprove, changeSpec, interruptWorker, resumeWorker
  examples.ts   the prewritten specs behind "Run Example"
src/shared/mongomation.ts         DTO types, stage mapping, precondition checks shared by server and UI
src/client/pages/DashboardPage.tsx
src/client/components/mm/*        header, spec console, project picker, panels, timeline chart
```

Method transport: `POST /api/_internal/method/mongomation.<name>` with `{"args": {...}}`.

| Method | Kind | Args | Writes |
|---|---|---|---|
| `dashboard` | query | – | – |
| `scenes` | query | – | – |
| `project` | query | `{ projectId }` | – |
| `plcSource` | query | `{ plcVersionId }` | – |
| `testTimeline` | query | `{ simRunId, testId }` (public tests only) | – |
| `rsi` | query | – | – |
| `generate` | mutation | `{ specText, sceneId }` | `jobs` `{type:"engineer", origin:"custom"}` |
| `runExample` | mutation | `{ exampleId }` (`sorting` \| `two-conveyors`) | `jobs` `{type:"engineer", origin:"example"}`; returns the spec text |
| `injectFaultAndImprove` | mutation | `{ projectId, faultId? }` | `jobs` `{type:"fault_and_improve"}` |
| `changeSpec` | mutation | `{ projectId, specText }` | `jobs` `{type:"spec_change"}` |
| `interruptWorker` / `resumeWorker` | mutation | – | `jobs` `{type:"worker_command", command:"interrupt" \| "resume"}` |

Every job document is inserted with `status: "queued"`, `attempts: 0`, `createdAt`, and `requestedBy` (user id).
