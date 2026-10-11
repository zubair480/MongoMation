# Modelence developer reference (for MongoMation)

Researched 2026-10-11. Legend: **[verified-code]** = read in the framework source or proved by running the scaffold here; **[docs]** = stated in the official docs source; **[UNVERIFIED]** = could not be confirmed (dashboard-only behaviour, platform internals, or inference).

## 0. TL;DR

```bash
# create (non-interactive; takes exactly one argument, no other flags; runs npm install itself)
npx --yes create-modelence-app@latest mongomation

# dev (Express + Vite on one port: PORT/MODELENCE_PORT, default 3000; tsx watch)
cd mongomation && npm run dev            # = modelence dev

# production build (no network/credentials needed) -> .modelence/build/{app.mjs,client/,ssr/}
npm run build                            # = modelence build
npm start                                # = node .modelence/build/app.mjs

# connect a local checkout to a Modelence Cloud *local* environment (writes .modelence.env)
npx modelence@latest setup               # browser device-flow; or: --token <setup-token> (no browser); --new
# deploy to a Modelence Cloud *cloud* environment
npx modelence@latest deploy [--app <app> --env <env>]
# CI / headless without browser approval:
CI=1 MODELENCE_TOKEN=<token> npx modelence@latest deploy --app <app> --env <env>
```

External Atlas URI:
- **Local, not connected to Cloud:** put `MONGODB_URI="mongodb+srv://user:pass@host/<dbName>?retryWrites=true&w=majority"` in `.modelence.env` (or `.env`). [verified-code]
- **Connected to Cloud (after `setup`, and every Cloud deployment):** the framework **ignores the `MONGODB_URI` env var**. It uses `_system.mongodbUri` delivered by Modelence Cloud. To use the hackathon cluster, choose "Connect to an existing MongoDB instance" when you create the environment in the dashboard [docs, UNVERIFIED UI], or open a second `MongoClient` yourself (pattern in section 6.4). [verified-code]

## 1. Provenance / what could not be fetched

- `https://modelence.com/skill.md`, `docs.modelence.com`, `cloud.modelence.com`, `llms.txt` and `/mcp` were **unreachable from this sandbox**. WebFetch returned `getaddrinfo ENOTFOUND modelence.com`, and the egress proxy refused CONNECT to modelence.com with HTTP 403. **The content of skill.md was NOT read.** Web search did not surface a copy.
- Instead, everything below comes from:
  - **The official repo** https://github.com/modelence/modelence at commit `285410c` (2026-10-10). Its `docs/web/*.mdx` + `docs/web/docs.json` are the Mintlify source of docs.modelence.com (see `.github/workflows/docs.yml`). It also holds the framework source, the CLI, `@modelence/ai` and the Claude Code plugin with its skills.
  - **The starter template** https://github.com/modelence/app-builder-empty-project at commit `6c408ec`, as downloaded by `create-modelence-app`.
  - **Examples** at https://github.com/modelence/examples, commit `f69ee71`.
  - **The npm registry.**
  - **A scaffold that was installed, built and smoke-run here.**
- Local copies:
  - Repo clones: `research/modelence-src/{modelence,modelence-examples}`
  - Scaffold: `research/modelence-probe/`
  - Logs: `research/modelence-logs/`
  - Compile-verified MongoMation snippets: `research/modelence-verified-snippets/`
- Doc page URL = `https://docs.modelence.com/<path>` for `docs/web/<path>.mdx`. Mintlify also serves `<path>.md`.

## 2. Packages (npm view, 2026-10-11)

| package | latest | bin | notes |
|---|---|---|---|
| `create-modelence-app` | 0.3.0 (published 2026-10-09; dist-tag dev 0.3.0-dev.3) | `create-modelence-app` | deps: commander, fs-extra, giget. 10 versions. |
| `modelence` | 0.26.3 (dev 0.27.0-dev.1, next 0.25.1-rc.1) | `modelence` | `engines.node >=22`. Exports: `.`, `./client`, `./server`, `./telemetry`, `./mongodb`, `./types`. Deps include mongodb ^6.8.1, express 4, socket.io 4, vite 6, tsup, tsx, zod 3, elastic-apm-node. Peer: @tanstack/react-query >=5, react >=18. |
| `@modelence/react-query` | 1.2.5 | - | Legacy helpers. Since modelence 0.15 the same helpers live in `modelence/client`. |
| `@modelence/ai` | 0.1.6 | - | Wrapper around Vercel AI SDK v6 `generateText` (section 11). |

The scaffold's lockfile installed **modelence 0.26.0**, @modelence/react-query 1.2.5, @tanstack/react-query 5.100.10, react 19.2.8, mongodb driver 6.21.0 (transitive), vite 6.4.3. Note: `docs/web/quickstart.mdx` says Node 18+, but modelence requires **Node >= 22** (`engines`).

## 3. Creating an app

### 3.1 Command and behaviour [verified-code + ran it]

Source: `packages/create-modelence-app/src/{index,create-app}.ts`.

- `npx create-modelence-app@latest <project-name>`. The only input is the positional name, which must match `/^[a-zA-Z0-9-_]+$/`. There are no prompts and no options besides `--help`. Use `npx --yes` to skip npx's own install prompt.
- It creates `./<project-name>` and **fails if that directory already exists**. It downloads the tarball `https://github.com/modelence/app-builder-empty-project/archive/refs/heads/main.tar.gz` (needs github.com access), rewrites `package.json` `name`, and runs `npm install`. On error it deletes the directory.
- Here: `npx --yes create-modelence-app@latest modelence-probe` finished in **17 s** and added 497 packages. npm audit reported 8 vulnerabilities, which is normal noise. A `postinstall` (`scripts/postinstall.mjs`) runs, and it is a no-op unless `mobile/.modelence-mobile-enabled` exists.
- Docs flow (hackathon page): `npx create-modelence-app@latest my-app && cd my-app && npx modelence@latest setup && npm run dev`, then `npx modelence@latest deploy`.

### 3.2 Generated tree (`node_modules` omitted)

```
.claude/settings.json          # enables Claude Code plugin modelence@modelence (marketplace github:modelence/modelence)
.cursor/mcp.json               # {"mcpServers":{"modelence":{"url":"https://docs.modelence.com/mcp"}}}
.github/workflows/ci.yml       # only checks the modelence dep is a plain semver release
.gitignore  .npmrc  .studio-snapshot.json (App Builder metadata)
AGENTS.md (26 KB, UI/design/structure rules)   DESIGN.md (placeholder "STATUS: NOT ESTABLISHED")
mobile/                        # Expo Router (SDK 54) app, shipped "unhooked"; ignore for web
modelence.config.ts            # { serverDir: './src/server', serverEntry: 'app.ts' }
package.json  package-lock.json  tsconfig.json  vite.config.ts
scripts/postinstall.mjs  scripts/check-mobile-deps.mjs
src/client/
  index.html  index.tsx  index.css  router.tsx  seo.config.ts  types.d.ts
  assets/{favicon.svg,modelence.svg}
  components/{LoadingSpinner,Page,Seo,VerifyEmailNotice}.tsx
  components/ui/{Avatar,Badge,Button,ButtonGroup,Card,Checkbox,Dialog,DropdownMenu,IconButton,Input,Label,RadioGroup,Select,Separator,Spinner,Switch,Tabs,Textarea,Tooltip}.tsx (+ _shared/)
  lib/{autoLogin,utils,verificationStatus}.ts
  pages/{Home,Example,PrivateExample,Login,Signup,Logout,ForgotPassword,ResetPassword,Terms,NotFound}Page.tsx
src/server/
  app.ts
  example/{index,db,cron}.ts
  migrations/createDemoUser.ts
```

There is no `.env` or `.modelence.env` in the template. Both are gitignored, together with `.modelence.backup.env` and `.modelence/{build,dist,cache,temp,tmp}/`. `.modelence/project.json` is meant to be committed: setup and deploy record the app id and deploy target there.

### 3.3 package.json (generated)

```json
{
  "name": "modelence-probe", "private": true, "version": "0.1.0", "type": "module",
  "scripts": {
    "build": "modelence build",
    "start": "node .modelence/build/app.mjs",
    "dev": "modelence dev",
    "dev:mobile": "cd mobile && npm run start",
    "postinstall": "node scripts/postinstall.mjs",
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "dependencies": {
    "@base-ui/react": "^1.5.0", "@modelence/react-query": "^1.2.5", "@tanstack/react-query": "^5.90.21",
    "clsx": "^2.1.1", "lucide-react": "^0.575.0", "modelence": "^0.26.0", "react": "^19.2.7",
    "react-dom": "^19.2.7", "react-hot-toast": "^2.6.0", "react-router": "^8.3.0",
    "tailwind-merge": "^3.4.0", "zod": "^4.1.13"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.1.14", "@types/bcrypt": "^6.0.0", "@types/node": "^20.11.0",
    "@types/react": "^19.2.14", "@types/react-dom": "^19.2.3", "tailwindcss": "^4.1.14", "typescript": "^5.3.3"
  },
  "overrides": { "cookie": "^0.7.2", "brace-expansion": "^5.0.9", "elastic-apm-node": "^4.18.0",
    "tsup": { "esbuild": "^0.28.1" }, "bundle-require": { "esbuild": "^0.28.1" }, "tsx": { "esbuild": "^0.28.1" } }
}
```

`mongodb` is not a direct dependency. It is hoisted from `modelence`. Add `"mongodb": "^6"` explicitly if you import it.

### 3.4 Config files

`modelence.config.ts` is the framework build config. It is read with jiti and validated by zod: `serverDir`, `serverEntry`, optional `postBuildCommand`.
```ts
const modelenceConfig = { serverDir: './src/server', serverEntry: 'app.ts' };
export default modelenceConfig;
```
Do not confuse it with **`modelence.config.json`**, the optional Cloud deploy spec (section 7.4).

`vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
export default defineConfig({
  root: 'src/client',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: { host: "0.0.0.0", allowedHosts: true }
});
```
`tsconfig.json`: ESNext/bundler resolution, `strict`, `noEmit`, `noUnusedLocals`/`noUnusedParameters`, path alias `@/*` -> `./src/*`, excludes `mobile`.

### 3.5 Server entry `src/server/app.ts`

```ts
import { startApp } from 'modelence/server';
import exampleModule from '@/server/example';
import { createDemoUser } from '@/server/migrations/createDemoUser';

startApp({
  modules: [exampleModule /* Add your modules here */],
  email: {
    // Without this the reset link redirects to the site root and dead-ends.
    passwordReset: { redirectUrl: '/reset-password' },
  },
  security: {
    frameAncestors: ['https://modelence.com', 'https://*.modelence.com', 'http://localhost:*', 'https://*.exp.direct'],
  },
  migrations: [{ version: 1, description: 'Create demo user', handler: createDemoUser }],
});
```
Other `startApp` options [verified-code `src/app/index.ts`]: `modules`, `roles`, `migrations`, `email`, `auth`, `security`, `websocket`, `ssr`, `server`.

### 3.6 Example module (generated): `src/server/example/{db,cron,index}.ts`

```ts
// db.ts
import { Store, schema } from 'modelence/server';
export const dbExampleItems = new Store('exampleItems', {
  schema: { title: schema.string(), createdAt: schema.date(), userId: schema.userId() },
  indexes: []
});

// cron.ts
import { time } from 'modelence';
export const dailyTestCron = {
  description: 'Daily cron job example',
  interval: time.days(1),
  handler: async () => { /* runs daily */ },
};

// index.ts
import z from 'zod';
import { AuthError } from 'modelence';
import { Module, ObjectId, UserInfo, getConfig } from 'modelence/server';
import { dbExampleItems } from './db';
import { dailyTestCron } from './cron';

export default new Module('example', {
  configSchema: {
    modelenceDemoUsername: { type: 'string', default: 'demo@modelence.dev', isPublic: true },
    modelenceDemoPassword: { type: 'string', default: '12345678', isPublic: true },
    itemsPerPage: { type: 'number', default: 5, isPublic: false },
  },
  stores: [dbExampleItems],
  queries: {
    getItem: async (args: unknown, { user }: { user: UserInfo | null }) => {
      if (!user) throw new AuthError('Not authenticated');
      const { itemId } = z.object({ itemId: z.string() }).parse(args);
      const exampleItem = await dbExampleItems.requireOne({ _id: new ObjectId(itemId) });
      if (exampleItem.userId.toString() !== user.id) throw new AuthError('Not authorized');
      return { title: exampleItem.title, createdAt: exampleItem.createdAt };
    },
    getItems: async (_args: unknown, { user }: { user: UserInfo | null }) => {
      if (!user) throw new AuthError('Not authenticated');
      const itemsPerPage = getConfig('example.itemsPerPage') as number;
      const exampleItems = await dbExampleItems.fetch({ userId: new ObjectId(user.id) }, { limit: itemsPerPage });
      return exampleItems.map((item) => ({ _id: item._id.toString(), title: item.title, createdAt: item.createdAt }));
    },
  },
  mutations: {
    createItem: async (args: unknown, { user }: { user: UserInfo | null }) => {
      if (!user) throw new AuthError('Not authenticated');
      const { title } = z.object({ title: z.string() }).parse(args);
      await dbExampleItems.insertOne({ title, createdAt: new Date(), userId: new ObjectId(user.id) });
    },
    updateItem: async (args: unknown, { user }: { user: UserInfo | null }) => {
      if (!user) throw new AuthError('Not authenticated');
      const { itemId, title } = z.object({ itemId: z.string(), title: z.string() }).parse(args);
      const exampleItem = await dbExampleItems.requireOne({ _id: new ObjectId(itemId) });
      if (exampleItem.userId.toString() !== user.id) throw new AuthError('Not authorized');
      const { modifiedCount } = await dbExampleItems.updateOne({ _id: new ObjectId(itemId) }, { $set: { title } });
      if (modifiedCount === 0) throw new Error('Item not found');
    },
  },
  cronJobs: { dailyTest: dailyTestCron },
});
```

`src/server/migrations/createDemoUser.ts` inserts `demo@modelence.dev` with password `12345678` (bcrypt) into `dbUsers`. **Remove it, and the public demo-credential configs, before a public deploy.**

### 3.7 Client entry and router (generated)

`src/client/index.tsx`:
```tsx
import { Suspense } from 'react';
import { MethodError, renderApp } from 'modelence/client';
import { toast, Toaster } from 'react-hot-toast';
import { RouterProvider } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { router } from './router';
import favicon from './assets/favicon.svg';
import './index.css';
import LoadingSpinner from './components/LoadingSpinner';
import { Seo } from './components/Seo';
import { useAutoLogin } from './lib/autoLogin';
import { TooltipProvider } from './components/ui/Tooltip';

const queryClient = new QueryClient();

function App() {
  useAutoLogin(); // only acts when _system.env.type === 'sandbox' (App Builder sandboxes)
  return (
    <TooltipProvider delay={150}>
      <Suspense fallback={<LoadingSpinner fullScreen />}>
        <Seo />
        <Toaster position="top-right" />
        <RouterProvider router={router} />
      </Suspense>
    </TooltipProvider>
  );
}

renderApp({
  routesElement: (<QueryClientProvider client={queryClient}><App /></QueryClientProvider>),
  errorHandler: (error) => {
    if (error instanceof MethodError && error.code === 'EMAIL_NOT_VERIFIED') return;
    toast.error(error.message);
  },
  loadingElement: <LoadingSpinner fullScreen />,
  favicon
});
```

`src/client/router.tsx` uses react-router v8 `createBrowserRouter` with lazy pages:
- `RootLayout`
- Public routes: `/`, `/example/:itemId`, `/terms`, `/logout`, `/forgot-password`, `/reset-password`, `*`
- `GuestRoute`: `/login`, `/signup`
- `PrivateRoute`: `/example/private`. It redirects to `/login?_redirect=...` when `useSession().user` is null.

Example page call pattern (generated `pages/ExamplePage.tsx`):
```tsx
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { modelenceQuery, modelenceMutation, createQueryKey } from '@modelence/react-query'; // same API exists in 'modelence/client'
const { data, isLoading, error } = useQuery({ ...modelenceQuery<ExampleItem>('example.getItem', { itemId }), enabled: !!itemId });
const { mutate: createItem, isPending } = useMutation({ ...modelenceMutation('example.createItem') });
queryClient.invalidateQueries({ queryKey: createQueryKey('example.getItem', { itemId }) });
```

### 3.8 Build / run results here [verified]

- `npm run build`: **succeeded offline in 9 s with no credentials and no `.modelence.env`**. Steps: tsup server -> `.modelence/build/app.mjs`, vite client -> `.modelence/build/client`, vite SSR -> `.modelence/build/ssr`. The only warning was a chunk larger than 500 kB.
- `npx tsc --noEmit`: passes. The `docs/web/core-concepts/project-structure.mdx` claim that output goes to `dist/` is outdated: the code writes to `.modelence/build/`.
- `PORT=3999 node .modelence/build/app.mjs` with no DB: starts, serves the SPA (HTTP 200), logs `MongoDB URI is not configured. Skipping cron jobs.` Methods work; `example.getItems` returns 401 `Not authenticated`.
- `npm run dev` with no DB: starts, and `_system.setupStatus` returns `{setupRequired:true}`. The browser shows a setup screen instead of the app, and the log says to run `npx modelence@latest setup`.
- Every `startApp` POSTs to `https://cloud.modelence.com/api/track/app-start`. Failures are ignored. Opt out with `MODELENCE_TRACKING_ENABLED=false`.
- Method transport: `POST /api/_internal/method/<module>.<method>` with JSON `{ "args": {...} }`, returning `{ data, typeMap }`.

## 4. Framework patterns (verified to type-check and build in the scaffold)

All files are in `research/modelence-verified-snippets/`. They were dropped into the scaffold, passed `tsc --noEmit` and `npm run build`, and were then removed again.

### 4.1 Stores (`db.ts`)
```ts
import { Store, schema } from 'modelence/server';

export const dbJobs = new Store('jobs', {           // collection name === 'jobs'
  schema: {
    kind: schema.string(),
    status: schema.enum(['queued', 'running', 'done', 'failed']),
    payload: schema.object({ target: schema.string() }),
    requestedBy: schema.string().optional(),
    claimedBy: schema.string().optional(),
    claimedAt: schema.date().optional(),
    createdAt: schema.date(),
  },
  indexes: [{ key: { status: 1, createdAt: 1 } }],   // created as "_modelence_status_1_createdAt_1"
});

// Worker-owned collection, typed reads only. Must be in some Module's `stores` to be initialized.
export const dbEngineeringState = new Store('engineering_state', {
  schema: { component: schema.string(), health: schema.string(), updatedAt: schema.date() },
  indexes: [],                                        // keep empty: never touch the worker's indexes
});
```
- Schema helpers: `string, number, date, boolean, array, object, enum, embedding, objectId, userId, ref, union, infer`. They are zod-v3 based (`src/data/types.ts`).
- Store methods: `findOne, requireOne, findById, requireById, fetch(query,{sort,limit,skip,projection}), countDocuments, insertOne, create, insertMany, updateOne, upsertOne, updateMany, upsertMany, deleteOne, deleteMany, findOneAndUpdate/Upsert/Delete/Replace, replaceOne, distinct, watch, aggregate, bulkWrite, getDatabase, rawCollection, renameFrom, vectorSearch`, plus static `Store.vectorIndex`, and `extend()`.

### 4.2 Module with queries, mutations, live query, raw access and cron (`index.ts`)
```ts
import z from 'zod';
import { AuthError, time } from 'modelence';
import { Module, LiveData, ObjectId, UserInfo } from 'modelence/server';
import { dbEngineeringState, dbJobs } from './db';
import { getAtlasDb } from './externalDb';

const enqueueArgs = z.object({ kind: z.string().min(1), target: z.string().min(1) });

const mongomationModule = new Module('mongomation', {
  configSchema: {
    leaseMinutes: { type: 'number', default: 10, isPublic: false },
    atlasUri: { type: 'secret', default: '', isPublic: false },
  },
  stores: [dbJobs, dbEngineeringState],
  queries: {
    listJobs: async (_args: unknown, { user }: { user: UserInfo | null }) => {
      if (!user) throw new AuthError('Not authenticated');
      const jobs = await dbJobs.fetch({}, { sort: { createdAt: -1 }, limit: 50 });
      return jobs.map((j) => ({ ...j, _id: j._id.toString() }));
    },
    engineeringState: async () =>                      // live query (must return LiveData)
      new LiveData({
        fetch: async () =>
          (await dbEngineeringState.fetch({}, { sort: { updatedAt: -1 }, limit: 200 }))
            .map((d) => ({ ...d, _id: d._id.toString() })),
        watch: ({ publish }) => {
          const stream = dbEngineeringState.watch();     // MongoDB change stream
          stream.on('change', () => publish());
          return () => { void stream.close(); };
        },
      }),
    recentWorkerEvents: async () => {                  // raw, non-Store collection, same DB
      const db = dbJobs.getDatabase();
      return db.collection('worker_events').find({}).sort({ _id: -1 }).limit(20).toArray();
    },
    externalEngineeringState: async () => {            // separate Atlas connection (6.4, option B)
      const db = await getAtlasDb();
      return db.collection('engineering_state').find({}).limit(50).toArray();
    },
  },
  mutations: {
    enqueueJob: async (args: unknown, { user }: { user: UserInfo | null }) => {
      if (!user) throw new AuthError('Not authenticated');
      const { kind, target } = enqueueArgs.parse(args);
      const { insertedId } = await dbJobs.insertOne({
        kind, status: 'queued', payload: { target }, requestedBy: user.id, createdAt: new Date(),
      });
      return { jobId: insertedId.toString() };
    },
    cancelJob: async (args: unknown, { user }: { user: UserInfo | null }) => {
      if (!user) throw new AuthError('Not authenticated');
      const { jobId } = z.object({ jobId: z.string() }).parse(args);
      await dbJobs.updateOne({ _id: new ObjectId(jobId), status: 'queued' }, { $set: { status: 'failed' } });
    },
  },
  cronJobs: {
    requeueStuckJobs: {
      description: 'Requeue jobs whose worker lease expired',
      interval: time.minutes(1),
      handler: async () => {
        const minutes = mongomationModule.getConfig('leaseMinutes');  // typed number
        const cutoff = new Date(Date.now() - minutes * 60_000);
        await dbJobs.updateMany(
          { status: 'running', claimedAt: { $lt: cutoff } },
          { $set: { status: 'queued' }, $unset: { claimedAt: '', claimedBy: '' } }
        );
      },
    },
  },
});
export default mongomationModule;
// register in src/server/app.ts: startApp({ modules: [mongomationModule, ...] })
```

Notes [verified-code]:
- Method names are `<moduleName>.<key>`.
- The handler context is `{ session, user, roles, clientInfo, connectionInfo, req, res }`. A method may also be `{ handler }`.
- Every query or mutation is publicly callable, and there is no declarative auth or input validation. Check `user` and parse args yourself.
- `user.requireRole('admin')` and `user.hasRole()` work with roles declared in `startApp({ roles })`.
- Module options: `stores, queries, mutations, routes, cronJobs, configSchema, rateLimits, channels`.
- Custom HTTP endpoints (webhooks) go in `routes`:
  ```ts
  routes: [{
    path: '/api/hooks/worker',
    handlers: { post: async ({ body, headers }) => ({ status: 200, data: { ok: true } }) },
  }]
  ```
  `RouteParams` = `{query, body, params, headers, cookies, rawBody?, req, res, next}`. `RouteResponse` = `{data?, status?, headers?, contentType?, redirect?}`.

### 4.3 Client (React + TanStack Query)
```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createQueryKey, modelenceLiveQuery, modelenceMutation, modelenceQuery } from 'modelence/client';

const qc = useQueryClient();
const { data: jobs } = useQuery({ ...modelenceQuery<Job[]>('mongomation.listJobs'), refetchInterval: 5000 }); // polling
const { data: state } = useQuery(modelenceLiveQuery<StateDoc[]>('mongomation.engineeringState'));          // push
const { mutate: enqueue } = useMutation({
  ...modelenceMutation<{ jobId: string }>('mongomation.enqueueJob'),
  onSuccess: () => qc.invalidateQueries({ queryKey: createQueryKey('mongomation.listJobs') }),
});
enqueue({ kind: 'reindex', target: 'orders' });
// imperative: import { callMethod } from 'modelence/client'; await callMethod('mongomation.enqueueJob', {...})
// typed: export const mm = createClientModule<typeof mongomationModule>('mongomation'); useQuery(mm.query('listJobs', {}))
```
- `modelenceQuery(name, args)` returns `{ queryKey: [name, args], queryFn }`.
- Live keys are `['live', name, args]`. They use `staleTime: Infinity` and `gcTime: 0`.

**Required change to the generated `index.tsx` for live queries** [verified-code]. The scaffold mounts its own `QueryClientProvider`, which shadows the provider `renderApp` injects. The first snapshot still loads, but live updates are written to the other client and the UI never refreshes. Add this before `renderApp`:
```ts
import { connectModelenceQueryClient } from 'modelence/client';
const queryClient = new QueryClient();
connectModelenceQueryClient(queryClient);
```
Do not mix `modelenceLiveQuery` from `@modelence/react-query` with `modelence/client`. Each keeps its own connected-client state.

### 4.4 Config (`configSchema`)
- Types: `string | text | number | boolean | secret`. `secret` cannot be `isPublic`.
- Server: `module.getConfig('key')` (typed) or `getConfig('module.key')` (untyped).
- Client: `createClientModule<typeof m>('m').getConfig('key')`, for public keys only.
- Values are set per environment in the Cloud dashboard (**Application** tab) and sync about every 10 s [docs].
- **[verified-code] Env vars do NOT feed module configs.** The docs claim that environment variables override everything. In the code, only the hard-wired `_system.*` variables are mapped (list in 6.2). With no Cloud connection, a module config only ever has its `default`. The official Voyage example uses `getConfig('voyage.apiKey') || process.env.VOYAGE_API_KEY`. Use the same fallback when you also run locally without Cloud.

### 4.5 Cron jobs [verified-code `src/cron/jobs.ts`]
- `cronJobs: { alias: { description?, interval /* ms, >= 5 s */, timeout? /* ms, <= 1 day */, handler: async () => {} } }`. The `time` helpers are `time.seconds/minutes/hours/days/weeks`.
- Scheduling is **interval-based**, not cron expressions. The next run is `lastStart + interval`, persisted in `_modelenceCronJobs`. A 1 s ticker runs in the web process. A DB lock `cron` in `_modelenceLocks` makes **only one instance run all crons**.
- The default timeout is `clamp(interval, 1 min, 1 day)`. **The timeout is not enforced** (`// TODO: enforce job timeout`). When it passes, the job is only marked not-running and an error is captured, so a slow handler can overlap with its next run.
- Crons are skipped entirely when no MongoDB URI is configured. Migrations and crons can run concurrently at startup.

### 4.6 Migrations
- `startApp({ migrations: [{ version, description, handler }] })`.
- They run once at startup under a `migrations` lock and are recorded in `_modelenceMigrations`.
- They are forward-only. A failed version is never retried automatically. There is no CLI to run them.

## 5. Real-time / live data

- **Live queries** [docs + verified-code]: the server query returns `new LiveData({ fetch, watch })`, and the client calls `useQuery(modelenceLiveQuery(...))`. Transport is Socket.IO, websocket-only, authenticated with the session token. `publish()` triggers a re-fetch and is coalesced while a fetch is in flight.
  - Change streams need a replica set. Atlas provides one. Check that your hackathon tier and DB user allow `changeStream`; `readWrite` does. [UNVERIFIED for the sandbox tier]
  - `watch` runs **once per client subscription**, so N dashboards means N change streams. The default pool is 10 (`_system.mongodbPoolSize`, env `MONGODB_POOL_SIZE` locally). For many viewers, filter with a pipeline or share one stream. [inference]
  - A change stream fires on any writer, including the external AWS worker. This is the natural way to surface worker state.
  - Multi-instance fan-out uses the `@socket.io/mongo-adapter` (`_modelenceSocketio`) when `_system.multiInstance` / `MODELENCE_MULTI_INSTANCE=true`.
- **Polling**: `useQuery({ ...modelenceQuery(...), refetchInterval: 5000 })`. It is simplest and needs no change streams.
- **Channels** (custom push): `new ServerChannel('jobs')` in a module's `channels`, `channel.broadcast(id, payload)` on the server, and `ClientChannel` on the client (docs/web/websockets.mdx).

## 6. MongoDB

### 6.1 Collection naming and schema [verified-code `src/data/store.ts`]
- A Store binds with `client.db().collection(name)`. **The Store name is the exact collection name**, in the database named in the URI path. With no DB name in the URI, the driver default is `test` (setup.mdx: "otherwise it will default to `test`"). Put the same DB name in the URI for the app and the worker.
- **No runtime validation.** `insertOne` and `updateOne` pass documents straight to the driver. The schema gives TypeScript types, defaults for `create()`, and a serialized schema sent to Cloud for the dashboard. Worker-written documents that don't match the schema will not error. They will simply be mistyped.
- Framework collections, all prefixed: `_modelenceUsers, _modelenceSessions, _modelenceLocks, _modelenceCronJobs, _modelenceMigrations, _modelenceRateLimits, _modelenceSocketio, _modelenceLinkNonces, _modelenceOAuthExchangeCodes, _modelenceDisposableEmailDomains, _modelenceEmailVerificationTokens, _modelenceResetPasswordTokens, _modelenceMagicLinkTokens`. The template also adds `exampleItems`.
- **Index reconciliation runs at startup for every registered Store.** It creates `_modelence_`-prefixed indexes and drops orphaned `_modelence_*` ones. It also **drops any existing index with the same key pattern but a different name** ("code wins on conflicts"). If you register a worker-owned collection as a Store, keep `indexes: []` or let a single side own its indexes.

### 6.2 Which URI is used: precedence [verified-code `src/app/index.ts`, `src/config/{local,sync}.ts`]
1. `startApp` runs `dotenv.config()` on `.env`, then on `.modelence.env`. Neither overrides an existing `process.env` value, so real env vars win over `.env`, which wins over `.modelence.env`.
2. If `MODELENCE_SERVICE_ENDPOINT` is **unset** (no Cloud), these env vars map to `_system.*`:
   `MONGODB_URI, MONGODB_POOL_SIZE, MODELENCE_AUTH_GOOGLE_*, MODELENCE_AUTH_GITHUB_*, MODELENCE_AUTH_MOBILE_REDIRECT_URLS, MODELENCE_EMAIL_{RESEND,AWS_SES,SMTP}_*, MODELENCE_SITE_URL, MODELENCE_ENV_TYPE, MODELENCE_MULTI_INSTANCE`.
3. If `MODELENCE_SERVICE_ENDPOINT` is **set**, all configs come from `POST {endpoint}/api/connect` and are re-synced every 10 s. That is the case after `modelence setup` writes `.modelence.env`, and in every Cloud deployment. **Only `MODELENCE_SITE_URL` is still taken from env; `MONGODB_URI` is ignored.**
4. `getMongodbUri()` = `getConfig('_system.mongodbUri')`. When it is empty, the app runs without a DB: stores are uninitialized and crons are skipped.

Docs/source mismatch: the docs say "Environment Variables - Highest priority, overrides everything". The code shows that is true only without a Cloud connection.

### 6.3 Pointing at the hackathon Atlas cluster: options

**A. Make the hackathon cluster Modelence's own DB everywhere.** This is the best fit for "Atlas is the source of truth".
- docs/web/data-api.mdx says: "MongoDB is configured when you create an environment. During environment creation, you can choose to: Create a new MongoDB database, or Connect to an existing MongoDB instance".
- Create the **local** environment (dev) and the **cloud** environment (hosting) with "connect existing", and give the sandbox URI including `/<dbName>`.
- Supporting statements: setup.mdx ("You can also connect to an external MongoDB database instead of using Modelence's provisioned database") and the plugin rules ("If the user wants to connect a different MongoDB database, direct them to their Modelence dashboard").
- **[UNVERIFIED: dashboard UI not seen. Whether the setting can be changed after creation is unknown.]**
- Atlas Network Access must allow Modelence Cloud egress. The IPs are unknown, so you likely need `0.0.0.0/0` for the hackathon.
- All `_modelence*` collections and your Stores then live in the sandbox DB, and the worker's collections are reachable via Stores or `getDatabase()`.

**B. Keep Modelence's provisioned DB for framework internals and open a second client to the sandbox cluster for MongoMation data.** This works regardless of dashboard features. It is the pattern used by the official `examples/data-api` (`src/server/data-api/mongoClient.ts`):
```ts
import { MongoClient, type Db } from 'mongodb';
import { getConfig } from 'modelence/server';
let client: MongoClient | null = null;
export async function getAtlasDb(): Promise<Db> {
  const uri =
    (getConfig('mongomation.atlasUri') as string | undefined) || // configSchema secret, set in Cloud dashboard
    process.env.ATLAS_URI ||                                      // env var (local .env / dashboard env var)
    (getConfig('_system.mongodbUri') as string);                  // fall back to Modelence's DB
  if (!client) { client = new MongoClient(uri); await client.connect(); }
  return client.db();                                             // DB name from the URI path
}
```
Live queries can watch `(await getAtlasDb()).collection('engineering_state').watch()` in the same way.

**C. Local only, no Cloud.** Put `MONGODB_URI="mongodb+srv://USER:PASS@CLUSTER/<db>?retryWrites=true&w=majority"` in `.modelence.env` (gitignored) and do **not** run `setup`. This is verified to be the path the code takes. You cannot deploy this way, and configSchema values stay at their defaults.

### 6.4 Raw access to non-Store collections [verified-code]
- `anyStore.getDatabase()` returns the raw `Db` of Modelence's connection, so you can call `.collection('worker_events')`. `anyStore.rawCollection()` returns the raw `Collection`. Both need the store to be initialized: it must be registered in a module and the DB connected.
- `getClient()` is internal and **not exported**. You can also open your own `MongoClient` (6.3 B).
- The plugin's agent rules say "NEVER use raw MongoDB drivers". That is a style rule for coding agents, not a technical limit. The official data-api example uses the raw driver.

## 7. Deploying to Modelence Cloud

### 7.1 Account, app and environments [docs: setup.mdx, hackathon/mongodb-2026.mdx]
- Sign up at https://cloud.modelence.com.
- Create an **Application**, then an **Environment**.
- There are two environment types:
  - **local**: provisions only a remote MongoDB for your dev machine.
  - **cloud**: provisions and hosts the app, with a MongoDB Atlas DB.
- Hackathon page `docs.modelence.com/hackathon/mongodb-2026` ("MongoDB x Cerebral Valley, Shack15, Oct 11 2026"): credits amount and redemption steps are still `[TODO]` placeholders in the source. Ask the Modelence table on site or email support@modelence.com.

### 7.2 Linking a local project [verified-code `src/bin/setup.ts`]
- `npx modelence@latest setup` runs a browser device flow. It prints `Please visit <url>` and `Code: <code>`, then polls for up to 10 min, and works headless. In the browser you pick or create a local environment.
- `npx modelence@latest setup --token <token>` uses the token from Environment Settings -> "Setup Local Environment". There is no browser and no Claude-plugin prompt.
- `--new` always creates a new environment. `--host` sets the Studio host.
- It writes `.modelence.env`, keeping any existing keys:
  ```
  MODELENCE_TELEMETRY_ENABLED="false"
  MODELENCE_ENVIRONMENT_ID="..."
  MODELENCE_SERVICE_ENDPOINT="https://cloud.modelence.com"
  MODELENCE_SERVICE_TOKEN="..."
  MODELENCE_CONTAINER_ID="..."
  MODELENCE_RUNTIME="local"
  ```
  It also records the appId in `.modelence/project.json`, which you commit. It merges the plugin declaration into `.claude/settings.json` and, only with a TTY, offers to install the Claude Code plugin.
- **Gotchas:**
  - If `.modelence.env` already exists, setup asks `overwrite? (y/N)` on stdin and makes `.modelence.backup.env`. Non-interactive runs block or cancel.
  - Only **one running dev instance per environment**. A second gets 409 "another instance already holds this environment". Use `npm run dev -- --takeover`, or give each teammate their own local environment.
- Once connected, the dev server's status in the dashboard goes inactive -> active. You also get Cloud logs, metrics and a free DB [docs].

### 7.3 Deploy [verified-code `src/bin/deploy*.ts`; docs setup.mdx, deploy/setup.mdx]
- Run `npx modelence@latest deploy [--app <alias> --env <alias>]`.
- The browser opens. Headless, it prints the URL and code instead. You sign in, pick or confirm the target (or create an app or environment there), and enter any required variables. The target is saved in `.modelence/project.json`.
- **Path for a framework app with no `modelence.config.json`** ("bundle"): it builds locally (`modelence build`) and zips `.modelence/build`, `package.json`, `package-lock.json` and `modelence.config.ts`, plus `public/`, `server/` and `scripts/` if present.
  - It waits for environment provisioning, for up to 10 min.
  - It uploads to a signed URL and starts the deploy.
  - It streams the build log ("Building image...", "Image built. Deploying containers...", "Rolling out new containers...", "Deployed successfully.", "Live at <siteUrl>"), polling every 3 s for up to 30 min. The exit code is non-zero on failure, with container output printed.
- If `modelence.config.json` exists, deploy uploads the git-tracked source and builds remotely ("source"). Force the local build with `--prebuilt`.
- **CI / non-interactive:** set env `CI` (any value) and `MODELENCE_TOKEN`, and pass `--app/--env` (or a saved target). A missing required variable fails the deploy unless you pass `--skip-env-check`. How to mint a long-lived `MODELENCE_TOKEN` is not documented. Browser-issued deploy tokens last about 1 hour and are cached in `~/.modelence/` (`MODELENCE_HOME`). [UNVERIFIED]
- Other commands: `modelence init` writes a `modelence.config.json` template, and `modelence logout`.
- **Deploy time**: there is no official number. Docs tell agents to allow ">= 15 minutes". The local build takes about 10 s. Image build and rollout are unknown. [UNVERIFIED]
- **GitHub integration**: no documented git-push deploy for CLI projects. App Builder environments have a "connected repository". The supported path is CLI deploy or CI with `MODELENCE_TOKEN`. [UNVERIFIED]
- **Logs/metrics**:
  - The deploy CLI streams build logs (CloudWatch).
  - The dashboard has logs, metrics and APM [docs].
  - App stdout/stderr is collected by the platform [code comment].
  - The `modelence` MCP server (`https://cloud.modelence.com/mcp`) exposes environment DB queries plus status and logs for App Builder sandboxes.
- **Custom domain**: only "You can share it immediately or connect a custom domain" (quickstart.mdx). Configure it in the dashboard. [UNVERIFIED] App URLs are on `*.prod.modelence.app`. The docs' demo link is `https://voyage-ai-mg8435n3pj5-sandbox.prod.modelence.app`, and the exact naming scheme is unverified.

### 7.4 Runtime contract and env vars on Cloud [docs: deploy/setup.mdx]
- One Docker image built on an official Node image (default `node-22-slim`). **One web process.** It must listen on `PORT`, which modelence does: `MODELENCE_PORT || PORT || 3000`.
- Injected env vars:
  - `MONGODB_URI` = `MONGO_URL`: the environment's Atlas DB
  - `SITE_URL` = `ROOT_URL`
  - `PORT`
  - variables you define in the dashboard under **Environment variables**
  - managed Postgres/Redis outputs (paid plans)
- Names starting with `MODELENCE_`, and `PORT`, are reserved.
- For framework apps, the URI the framework uses is `_system.mongodbUri` from the Cloud config (6.2). Plain dashboard env vars such as `ATLAS_URI` are visible to your own code via `process.env`. [UNVERIFIED for the bundle path, but documented for the generic runtime] For module settings, prefer `configSchema` values (Application tab).
- `modelence.config.json` (optional for framework apps) fields:
  - `resources`: `{name: {type: 'service', image, root, build.commands, start.commands, static}}` plus `postgres`/`redis`.
  - `env`: `{NAME: {type: text|secret|resource, scopes: [build|runtime], value?, required?}}`.
  - `$schema`: `https://cloud.modelence.com/schema/modelence.config.json?version=1`.

## 8. Long-running background work

- **Not supported on Modelence Cloud as a separate process** [docs: deploy/setup.mdx]. The guide says to report a project as "not compatible" when "It requires a second long-running process: a separate worker or queue consumer, a scheduler process..." because only "One web process is run". It also says: "Do not move a worker, queue consumer or scheduled job into the web process. The web process can run as several replicas... each job needs a lock held in the database".
- What is available in-process:
  - cron jobs (section 4.5; interval >= 5 s, single-runner lock, unenforced timeout up to 1 day)
  - migrations (startup only)
  - queries and mutations (HTTP request/response)
- **Execution limits:**
  - The framework sets no per-method timeout. Node keep-alive is set to 65 s. A code comment explains that this is to exceed AWS ALB's 60 s default, which suggests the Cloud sits behind an ALB-like load balancer with an idle timeout of about 60 s. [UNVERIFIED] Keep methods short and enqueue instead.
  - Body limit is 16 MB JSON.
- **Recommended MongoMation shape:**
  - The AWS worker stays the long-running consumer and writes engineering state to Atlas.
  - The Modelence app only reads that state (live query or polling) and inserts `jobs` documents (`status: 'queued'`).
  - The worker claims jobs atomically with `findOneAndUpdate({status:'queued'}, {$set:{status:'running', claimedBy, claimedAt: new Date()}}, {sort:{createdAt:1}})`, or watches a change stream on `jobs`.
  - An optional Modelence cron requeues expired leases (snippet in 4.2).

## 9. Agent skills / MCP (official)

- `https://modelence.com/skill.md`: **not retrievable here (blocked)**. Its content is unknown.
- **Claude Code plugin** in the repo (`.claude-plugin/marketplace.json`, `claude-plugins/modelence/`, v0.3.1, MIT). Install with:
  ```bash
  claude plugin marketplace add modelence/modelence
  claude plugin install modelence@modelence --scope project
  ```
  `npx modelence setup` offers this. The scaffold already ships `.claude/settings.json` enabling it. The plugin needs Claude Code >= 2.1.195. It contains:
  - skill `modelence-patterns`: Module/Store/query/mutation/config/cron/page reference implementations, identical to the template example.
  - skill `expo-router`
  - output style `Modelence` (always-on rules). Notable rules:
    - "NEVER use raw MongoDB drivers or mongoose"
    - "NEVER use process.env for app configuration" (use `configSchema`)
    - run `npx tsc --noEmit` before finishing
    - never edit or create `.modelence.env`
    - keep one dev server
  - MCP servers:
    - `modelence-docs` (`https://docs.modelence.com/mcp`, no auth; tools `search_modelence`, `query_docs_filesystem_modelence`, `submit_feedback`)
    - `modelence` (`https://cloud.modelence.com/mcp`, OAuth via `/mcp` -> Authenticate; read access to your org's environments and DBs, using `MODELENCE_ENVIRONMENT_ID` from `.modelence.env`)
- Plain-text docs for other agents: `https://docs.modelence.com/llms.txt`, `/llms-full.txt`. The deploy agent prompt is "Use https://docs.modelence.com/deploy/setup.md to set up Modelence deployment for this project".
- The scaffold's `AGENTS.md` (26 KB) covers the design system, UI components, routing and the mobile app.

## 10. Auth (for the dashboard UI)

- Built-in email/password, sessions (`_modelenceSessions`, 7-day inactivity expiry), email verification, reset, magic link, Google/GitHub OAuth (configured in the dashboard), and roles.
- Client: `useSession()`, `loginWithPassword`, `signupWithPassword`, `logout` from `modelence/client`.
- Email defaults to a managed provider when connected to Cloud.

## 11. Built-in AI and observability, and Raindrop

- **`@modelence/ai` 0.1.6** [verified-code `packages/ai/src/index.ts`]:
  - `generateText({ provider: 'openai'|'anthropic'|'google', model: '<id>', ...aiSdkOptions })` wraps `ai@6` `generateText`. There is no streaming wrapper.
  - API keys come from Cloud config `_system.openai.apiKey` / `_system.anthropic.apiKey` / `_system.gemini.apiKey` (dashboard **AI > Integrations**). **They are not mapped from env vars**, so `@modelence/ai` only works when connected to Modelence Cloud. Otherwise call the AI SDK or provider SDK directly.
  - It records an APM transaction of type `ai`, with token usage.
- **Telemetry** [verified-code `src/telemetry`, `src/app/metrics.ts`]:
  - Elastic APM (`elastic-apm-node`), enabled per environment by Cloud, which supplies `_system.elastic.apmEndpoint/apiKey`.
  - The framework records transactions for `method`, `route`, `cron`, `ai` and `custom`, plus `captureError`.
  - The public API is in `modelence/telemetry`: `startTransaction(type, name, ctx).end(result)`, `captureError(err)`, `logInfo/logError/logDebug(msg, obj)`.
  - Console verbosity is set with `MODELENCE_LOG_LEVEL` (`debug|info|error`). The code defaults to `info`; the docs table differs slightly.
  - Data is viewed in the Modelence Cloud dashboard. This is infra-level APM (latency, errors, throughput). There is no prompt/response capture, evals or user-feedback signals.
- **Raindrop** (raindrop.ai) is complementary: it gives AI-product observability (events, traces, issue detection).
  - npm `raindrop-ai` 1.0.1 is the core SDK: `Raindrop` with a write key, begin/finish interactions.
  - `@raindrop-ai/ai-sdk` 0.3.5 wraps the Vercel AI SDK: `createRaindropAISDK({ writeKey }).wrap(ai, ...)` returns wrapped `generateText` and `streamText`.
  - `@modelence/ai` imports `generateText` from `ai` internally, so Raindrop's `wrap` cannot reach it. Either call the AI SDK directly (wrapped by Raindrop) or log events with `raindrop-ai` around `@modelence/ai` calls.
  - Store the Raindrop write key as a `configSchema` `secret`, with an env fallback for local runs.
  - Raindrop details come from web search of raindrop.ai docs. [UNVERIFIED versus current SDK]
- **Vector search**: `schema.embedding()` and `Store.vectorIndex({ field, dimensions, similarity })` in `searchIndexes` (Atlas Vector Search). There is an official Voyage AI tutorial (`docs.modelence.com/voyage-ai`, `examples/voyage-ai`).

## 12. Top caveats

1. **`MONGODB_URI` is ignored once the project is connected to Modelence Cloud.** That happens after `setup`, and in every Cloud deploy. The DB comes from the environment's DB setting. Use option A or B in 6.3 to keep the hackathon Atlas as the source of truth.
2. **Env vars don't set `configSchema` values.** Only the dashboard does. Locally without Cloud you get defaults, so add `process.env` fallbacks for secrets.
3. **The scaffold breaks live-query updates.** Its own `QueryClientProvider` must be connected with `connectModelenceQueryClient(queryClient)`. Use `modelence/client` imports consistently.
4. **No separate worker processes on Modelence Cloud** (one web process, possibly several replicas). Keep the worker on AWS. Crons are in-process, interval-based (>= 5 s), single-runner and run without an enforced timeout.
5. **Stores don't validate at runtime.** Index reconciliation can drop same-key indexes created by someone else (the worker). Use `indexes: []` on worker-owned collections.
6. **Template security**:
   - demo user `demo@modelence.dev / 12345678` (migration)
   - public configs exposing those credentials
   - `frameAncestors` allowing `*.modelence.com`
   - every query and mutation is public unless you check `user`

   Strip the `example` module and migration before deploying.
7. **One dev instance per environment.** Use a separate local environment per teammate, or `--takeover`. `setup` prompts interactively if `.modelence.env` exists.
8. **Node >= 22 required.** Each app start phones home to `cloud.modelence.com/api/track/app-start` (`MODELENCE_TRACKING_ENABLED=false` to stop it).
9. **Live queries open one change stream per subscriber.** The pool default is 10. Atlas tier limits apply.
10. **Several things are unverified**, because modelence.com, skill.md and the dashboard were unreachable here:
    - the "connect existing MongoDB" dashboard option
    - custom domains
    - deploy duration
    - long-lived CI tokens
    - credits

## 13. Sources

Framework repo (commit 285410c):
- https://github.com/modelence/modelence (docs source `docs/web/`, docs config `docs/web/docs.json`)
- Docs pages (`https://docs.modelence.com/<path>`, source `docs/web/<path>.mdx`): `quickstart`, `setup`, `deploy/setup`, `ai-coding-agents`, `hackathon/mongodb-2026`, `core-concepts/{project-structure,modules,queries,mutations,migrations,environment-and-setup}`, `configuration`, `stores`, `indexes`, `live-queries`, `websockets`, `telemetry`, `data-api`, `voyage-ai`, `roles`, `authentication/index`
- Code:
  - `packages/modelence/src/app/index.ts` (startApp)
  - `src/config/{local,sync,server}.ts` (env -> config mapping)
  - `src/db/client.ts`
  - `src/data/{store,types}.ts`
  - `src/cron/jobs.ts`
  - `src/live-query/*`
  - `src/client/{query,renderApp,queryProvider}.tsx?`
  - `src/app/{server,backendApi,metrics}.ts`
  - `src/telemetry/index.ts`
  - `src/bin/{modelence,setup,deploy,deployKind,deploySession,deployStatus,deployUpload,auth,build,dev,start,init}.ts`
- `packages/create-modelence-app/src/{index,create-app}.ts`
- `packages/ai/{README.md,src/index.ts}`
- Claude plugin: `claude-plugins/modelence/{README.md,.mcp.json,output-styles/modelence.md,skills/modelence-patterns/SKILL.md}`, `.claude-plugin/marketplace.json`

Other repos and registries:
- Template: https://github.com/modelence/app-builder-empty-project (commit 6c408ec)
- Examples: https://github.com/modelence/examples (commit f69ee71), especially `data-api/src/server/data-api/mongoClient.ts` and `voyage-ai/`
- npm: https://www.npmjs.com/package/create-modelence-app, https://www.npmjs.com/package/modelence, https://www.npmjs.com/package/@modelence/ai, https://www.npmjs.com/package/@modelence/react-query, https://www.npmjs.com/package/raindrop-ai, https://www.npmjs.com/package/@raindrop-ai/ai-sdk
- Raindrop docs (web search): https://www.raindrop.ai/docs/sdk/typescript.md, https://www.raindrop.ai/docs/integrations/vercel-ai-sdk.md

Not reachable from the sandbox: https://modelence.com/skill.md, https://docs.modelence.com, https://cloud.modelence.com
