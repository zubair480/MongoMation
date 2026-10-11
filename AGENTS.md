# AGENTS.md — rules for coding agents (Claude Code, Cursor, Kiro) working in this repo

MongoMation turns natural-language automation specs into tested IEC 61131-3 programs (OpenPLC + Factory I/O on AWS),
and a meta-harness evolves the harness that does the engineering. Read `docs/ARCHITECTURE.md` first.

## Ownership
| Owner | Area | Paths |
|---|---|---|
| Developer 1 (AWS/simulation) | EC2 Windows GPU host, Factory I/O + Web API, OpenPLC, Modbus, DCV, scene registry values | `scenes/*.json` values, `docs/INTEGRATION_CONTRACT.md` §2–§5 answers |
| Developer 2 (app/agent) | everything else | `apps/`, `packages/`, `checks/`, `harness/`, `scripts/`, `specs/` |
| Both | contracts | `packages/types`, `docs/INTEGRATION_CONTRACT.md` |

## Non-negotiable rules
1. **Everything real.** No mocked services in demo paths. Unit tests may use doubles named `TestDouble*` under `*/test/` only.
   If a dependency is down, show BLOCKED/DISCONNECTED with the real error.
2. **Hidden checks stay hidden.** Nothing under `checks/src/hidden/` may reach a prompt, retrieval, Atlas, MCP or the UI.
   Agents (`apps/worker/src/agents`, `apps/worker/src/rsi`) never import `@mongomation/checks`. `npm run verify:isolation` enforces it.
3. **The LLM never grades itself.** Only `checks/` (pure grader over measured samples) decides pass/fail.
4. **One writer.** Only the worker writes engineering state. The web app writes `jobs` only.
5. **Configs are versioned, never edited in place.** New harness versions go through guardrails → benchmark → gate.
6. **Benchmark is frozen.** `specs/benchmark.json` is hashed into `benchmark_manifests` on first use; a changed file is refused.
7. **No secrets in git.** `.env`, `.mcp.json` are gitignored.
8. **Never force/override anything on physical equipment.** The rig is a simulator; fault injection only via Factory I/O Web API.

## Commands
| Command | Does |
|---|---|
| `npm run typecheck` | all packages |
| `npm test` | validator + RSI unit tests (test doubles only) |
| `npm run green` | live checks: Atlas, model, Raindrop, OpenPLC, Factory I/O, preflight compiler |
| `npm run setup:atlas` / `npm run seed` | collections, indexes, vector indexes / harness v0 + scene registry |
| `npm run worker` | the engineering worker (run inside the AWS VPC) |
| `npm run example` | Run Example from the CLI (same job the button enqueues) |
| `npm run fault` | Inject Fault & Improve Harness from the CLI |
| `npm run evolve` / `npm run benchmark` | RSI rounds / bare vs v0 vs vN on held-out cases |
| `npm run ledger` | evidence ledger (every claim → Atlas ids, Raindrop ids) |
