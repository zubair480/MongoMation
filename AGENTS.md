# AGENTS.md: rules for coding agents working in this repo

MongoMation turns natural-language machine specs into tested IEC 61131-3 Structured Text programs (OpenPLC Runtime v4
+ Factory I/O on AWS EC2), and a meta-harness proposes changes to the harness that does the engineering.
Read [`README.md`](README.md) (overview, one real run, repo map) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first.

## Entry points

| What | Path |
|---|---|
| Worker job loop | `apps/worker/src/main.ts` (supervised by `apps/worker/src/launcher.ts`) |
| Loop 1: engineer + repair | `apps/worker/src/pipeline/engineer.ts` |
| Loop 2: harness self-improvement | `apps/worker/src/rsi/evolve.ts`, `meta.ts`, `guardrails.ts`, `gate.ts` |
| Validator (the only pass/fail authority) | `checks/src/grader.ts`, `checks/src/runner.ts`, `checks/src/hidden/` |
| Shared types (zod) | `packages/types/src/index.ts` |
| Dashboard (separate package) | `apps/web/src/server/app.ts`, `apps/web/src/server/mongomation/`, `apps/web/src/client/` |
| Atlas schema and indexes | `scripts/setup-atlas.ts`, `scripts/setup-search.ts`, `apps/worker/src/db/schema.ts` |

## Non-negotiable rules

1. **Everything real.** No mocked services in demo paths. Unit tests may use doubles named `TestDouble*` under
   `*/test/` only. If a dependency is down, show BLOCKED or DISCONNECTED with the real error.
2. **Hidden checks stay hidden.** Nothing under `checks/src/hidden/` may reach a prompt, retrieval, Atlas memory, MCP or
   the UI. Agents (`apps/worker/src/agents`, `apps/worker/src/rsi`) never import `@mongomation/checks`.
   `npm run verify:isolation` enforces it.
3. **The LLM never grades itself.** Only `checks/` (a pure grader over measured samples) decides pass/fail. Missing
   samples mean `blocked`, never `passed`.
4. **The harness owns I/O addresses.** Located variables come from the scene's verified map
   (`apps/worker/src/pipeline/st.ts`); the model writes logic only.
5. **One writer.** Only the worker writes engineering state. The dashboard only inserts into `jobs`.
6. **Configs are versioned, never edited in place.** New harness versions go through guardrails → benchmark → gate.
   Harness versions are append-only.
7. **Benchmark is frozen.** `specs/benchmark.json` is hashed into `benchmark_manifests` on first use; a changed file
   is refused.
8. **Label reuse honestly.** A project verified from recalled evidence without a rig run is `verified-by-reuse`, never
   `verified`.
9. **No secrets in git.** `.env`, `.env.*` (except `.env.example`) and `.mcp.json` are gitignored. Never print or
   commit URIs, keys, passwords, rig hosts or IPs.
10. **Never force anything on physical equipment.** The rig is a simulator; fault injection only via the Factory I/O
    Web API.
11. **Sponsor scope.** Only MongoDB Atlas (Voyage via Atlas), Raindrop, Modelence and AWS, plus Claude as the model.
    Do not add other services.

## Commands

| Command | Does |
|---|---|
| `npm install` | Root workspace (worker, checks, types, scripts); Node >= 22.13 |
| `npm run typecheck` | tsc over all root packages |
| `npm test` | Validator, RSI, memory, telemetry and AWS unit tests (test doubles only) |
| `npm run verify:isolation` | Fails if agents or RSI can reach the validator or hidden tests |
| `npm run green` | Live checks: Atlas, model, Raindrop, preflight, OpenPLC, Factory I/O |
| `npm run setup:atlas` / `npm run setup:search` / `npm run seed` | Collections, indexes, validators / search indexes / harness v0 + scene registry |
| `npm run worker` / `npm run launcher` | The engineering worker (plain / under the Interrupt-Resume supervisor) |
| `npm run example` / `npm run fault` | Run Example / Inject Fault & Improve Harness from the CLI |
| `npm run evolve` / `npm run benchmark` / `npm run ablation` | One RSI round / gate benchmark (train cases) / held-out ablation |
| `npm run ledger` | Evidence ledger: every claim mapped to Atlas ids and Raindrop ids |
| `cd apps/web && npm install && npm run dev` | Dashboard locally |

Env var names are in [`.env.example`](.env.example) and the README's "Environment variables" section.

## Ownership

| Owner | Area | Paths |
|---|---|---|
| Developer 1 (AWS / simulation) | EC2 hosts, Factory I/O + Web API, OpenPLC, Modbus, DCV, scene registry values | `scenes/*.json` values, `docs/INTEGRATION_CONTRACT.md` §2–§5 |
| Developer 2 (app / agent) | Everything else | `apps/`, `packages/`, `checks/`, `harness/`, `scripts/`, `specs/` |
| Both | Contracts | `packages/types`, `docs/INTEGRATION_CONTRACT.md` |
