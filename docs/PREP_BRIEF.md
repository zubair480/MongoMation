# MongoMation — prep brief (written before you opened the laptop)

Prepared 2026-10-11 ~08:15–09:15 PT. Nothing was pushed to any GitHub repo (your `random` repo is untouched).
Everything is in this folder / the zip.

## 0. Event facts (from your inbox)

- **The Harness Engineering & Model Wrangling Hackathon (#SFTechWeek)**, today, **Shack 15**; doors 9:00 AM.
- **You must register on Cerebral Valley:** https://cerebralvalley.ai/e/mongodb-sftw-hackathon — and make sure every
  teammate is **approved on the event listing**. Discord for updates: https://discord.gg/YnZj6RDSX
- **Atlas sandbox:** you're invited to the org **"SFTW: Harness Engineering & Model Wrangling Hackathon"**; your project
  **"zubairzafar480@gmail.com's Sandbox Project"** already exists and already built a vector index + a search index in
  `smoke_test.vec` (05:47 and 06:22 UTC today). If the cluster is a Free tier, it allows **3 search/vector indexes total**
  → drop the smoke_test ones before `npm run setup:atlas`.
- Ripple (the reference winner) was built at the **Sept 26** edition of this series; its checklist said "public GitHub
  repo, 1-minute video recorded on site, all work written today, built in the Atlas Hackathon Sandbox". Assume the same
  rules here and **confirm on Discord whether code written this morning counts** (it was all written today, before 9 AM).

## 1. What is ready

| Area | State | Where |
|---|---|---|
| Shared contracts (scene, requirements, harness config, tests, jobs) | done, typechecks | `packages/types` |
| Independent validator: pure grader, live-rig runner, 11 requirement templates, hidden regression tests, plan builder, requirement verdicts | done, **6/6 unit tests pass** (against a labeled in-process test double) | `checks/` |
| RSI guardrails (immutable), gate (KEPT/ROLLED BACK), config diff | done, **9/9 unit tests pass** | `apps/worker/src/rsi/` |
| ST assembly (harness writes all located vars) + static lint + **real MatIEC preflight** | done; an assembled program **compiled with the real OpenPLC v3 toolchain (iec2c + g++)**, a broken one returned the real MatIEC error | `apps/worker/src/pipeline/st.ts`, `tools/preflight.ts` |
| Claude client (structured outputs, cost, refusal fallback) | done, typechecks; not run (no key here) | `apps/worker/src/tools/llm.ts` |
| Agents: requirements, scene binder, state machine, codegen, critic, repair, meta-agent | done (prompts + schemas), not run | `apps/worker/src/agents`, `rsi/meta.ts` |
| Durable jobs (lease/heartbeat/recover), stage checkpoints, rig lock, spec revisions | done, typechecks; needs Atlas to run | `apps/worker/src/harness` |
| Loop 1 pipeline, fault injection flow (A/B/C), evolve + benchmark + frozen manifest | done, typechecks; needs the rig | `apps/worker/src/pipeline`, `rsi/evolve.ts` |
| Raindrop telemetry (interaction per job, trackAi per model call, tool spans with errors, signals) | done against `raindrop-ai@1.0.1` types | `apps/worker/src/telemetry` |
| Atlas setup (indexes, time-series measurements, autoEmbed vector indexes), seed, ledger, probe generator, isolation check | done | `scripts/` |
| Factory I/O Web API client (force/release, active-low inputs, never releases pre-forced emitters) | done, typechecks; not run (no rig here) | `apps/worker/src/tools/factoryio.ts` |
| OpenPLC clients: **v4** (STruC++ bundle + Modbus master config in every ZIP + rollback), **v3 REST**, **v3 web UI** | done, typechecks; the v4 sequence itself was run end-to-end against a real OpenPLC v4.3.0 runtime during research | `apps/worker/src/tools/openplc.ts` |
| Demo scene file **Sorting by Height (Basic)** with real tag names, default Modbus addresses and Web API ids; I/O probe program (compiles with MatIEC) | done, `verified:false` until Developer 1 confirms | `scenes/`, `docs/probe-sorting-by-height-basic.st` |
| Frozen benchmark: 4 train + 2 held-out cases with ground-truth requirements (6 cases → 25 public + 19 hidden tests) | done | `specs/benchmark.json` |
| Modelence dashboard (spec console, 3 demo buttons with state chips, live rig panel, stage progression, PLC code + diff, tests, RSI card, long-horizon card, interrupt/resume) | done: `npm run build` + `tsc` pass; checked against a throwaway local MongoDB seeded with worker-shaped docs; hidden tests never reach the browser; not deployed | `apps/web` (standalone; own `npm install`) |
| Integration contract for Developer 1 | **send it now** | `docs/INTEGRATION_CONTRACT.md` |
| Research notes (APIs verified against packages/source) | done | `docs/research/*.md` |

Nothing above has touched a real service yet — no keys or rig were available. Every live claim must still be earned.

## 2. Do this when you open the laptop (in order, ~45 min)

1. **Register on Cerebral Valley**, join Discord, approve teammates. Ask about pre-written code + submission time.
2. **Send the integration contract to Developer 1:** shareable page https://claude.ai/artifact/MRqsZD3KrTeBzRb312MgFX
   (private until you share it from the page's Share menu) — same content as `docs/INTEGRATION_CONTRACT.md`.
3. **Unpack + install**
   ```bash
   unzip mongomation.zip && cd mongomation && npm install && npm test && npm run typecheck && npm run verify:isolation
   git init && git add -A && git commit -m "MongoMation scaffold"   # then push to a NEW public repo (not `random`)
   ```
4. **Atlas** (cloud.mongodb.com → org "SFTW…" → your Sandbox Project):
   - check the cluster tier (Free/Flex/dedicated); delete the `smoke_test` search indexes if Free;
   - Database Access: create `mm_worker` (readWrite on `mongomation`), `mm_web` (read on `mongomation` + readWrite on
     `mongomation.jobs` — custom role) and `mm_reader` (read) for MCP; Network Access: your IP + AWS worker EIP
     (+ 0.0.0.0/0 for the day if Modelence egress IPs are unknown);
   - put the URIs in `.env` (copy `.env.example`), then `npm run setup:atlas && npm run seed`.
5. **MongoDB MCP + Agent Skills in Claude Code** (official):
   ```bash
   claude mcp add-json mongodb '{"type":"stdio","command":"npx","args":["-y","mongodb-mcp-server@latest","--readOnly"],"env":{"MDB_MCP_CONNECTION_STRING":"<mm_reader URI>"}}'
   claude plugin install mongodb@claude-plugins-official        # MongoDB agent skills + local MCP
   ```
   (`mongodb-atlas@claude-plugins-official` = hosted Atlas MCP, but it needs the org owner to enable AI clients.)
6. **Raindrop:** sign up at raindrop.ai (not raindrop.io), create a project, copy the **write key** and a **Query API key** into `.env`.
   ```bash
   claude mcp add --transport http raindrop https://mcp.raindrop.ai/mcp
   npx skills add raindrop-ai/skills --skill raindrop-setup
   ```
7. **Claude API key** → `ANTHROPIC_API_KEY` (defaults: strong = `claude-opus-5-5`, fast = `claude-sonnet-5-5`).
8. **Modelence:** sign up at cloud.modelence.com, create app + environment (choose *connect to an existing MongoDB*
   → the sandbox URI), then in `apps/web`: `npx modelence@latest setup --token <token>` → `npm run dev` →
   `npx modelence@latest deploy`. Set the `mongomation.atlasUri` secret in the dashboard (the app uses its own Atlas
   client because Modelence ignores `MONGODB_URI` once connected to Cloud). Plugin:
   `claude plugin marketplace add modelence/modelence && claude plugin install modelence@modelence --scope project`.
9. **On the worker host** (from Developer 1): clone, `npm install`, build MatIEC for the preflight (§4), fill `.env`,
   `npm run green`, then `npm run launcher` (runs the worker; needed for the Interrupt/Resume demo).
10. First real run: `npm run example` (or the Run Example button). Then the fault button, then `npm run evolve`.

## 3. Open items (blocked on things only you/Developer 1 have)

| Item | Blocked on | Fallback if it slips |
|---|---|---|
| OpenPLC rig | Developer 1: v4 (or v3), URL, credentials, cert | v3 accepts raw `.st` — simplest if v4 bundling misbehaves |
| Factory I/O rig | **Ultimate edition ≥ 2.5.2** with `app.web_server = True` | without the Web API there is no fault injection / measurement path — contract change needed |
| Scene verification | Developer 1 runs the probe and flips `verified:true` | none — validation stays BLOCKED until verified |
| Dashboard deploy | Modelence account + token | run `npm run dev` locally and screen-share |
| Raindrop traces | write key | telemetry shows DISABLED (honest), pipeline still runs |

## 4. Worker host setup (Linux): MatIEC preflight + STruC++ for OpenPLC v4

```bash
sudo apt-get install -y build-essential flex bison autoconf automake git
git clone --depth 1 https://github.com/thiagoralves/OpenPLC_v3.git ~/OpenPLC_v3
cd ~/OpenPLC_v3/utils/matiec_src && autoreconf -i && ./configure && make      # ~30 s
cat >> ~/mongomation/.env <<EOF2
IEC2C_PATH=$HOME/OpenPLC_v3/utils/matiec_src/iec2c
IEC_LIB=$HOME/OpenPLC_v3/webserver/lib
OPENPLC_C_LIB=$HOME/OpenPLC_v3/webserver/core/lib
EOF2
# OpenPLC v4 only: STruC++ (not on the npm registry; pinned to the version Editor 4.3.2 uses)
cd ~/mongomation && npm i --no-save --ignore-scripts https://github.com/Autonomy-Logic/STruCpp/releases/download/v0.7.0/strucpp-0.7.0.tgz
```

**OpenPLC v4 facts that change the design** (verified on a real v4.3.0 runtime during prep):
v4 rejects `.st` uploads — the worker compiles with STruC++ and uploads a ZIP; every ZIP must carry
`conf/modbus_master.json` (the worker generates it from the scene) or Modbus I/O stops; a failed on-device build wipes
the running program (the worker preflights and re-uploads the last good ZIP); JWTs expire after 15 minutes (re-login on 401).
MatIEC (v3) is stricter than STruC++ (v4) — the generator targets the intersection (no `//` comments, separate VAR
block for located variables, `ELSIF`, typed literals like `80.0`, no keywords such as `STEP`/`ON`/`TIME` as names).

## 5. Hackathon plan (fits the prompt's priorities)

| Time | You | Developer 1 |
|---|---|---|
| 9:30–10:30 | §2 steps 1–8; first `npm run green` (Atlas, model, Raindrop green) | worker host, OpenPLC, Web API |
| 10:30–12:00 | dashboard on Modelence; Run Example wired; first spec→requirements→code→preflight on real Claude | Modbus mapping + probe; scene file |
| 12:00–13:30 | **first real compile/deploy/measured test run** (acceptance #2–#4) | DCV, fault list |
| 13:30–15:00 | fault button end-to-end; interrupt/resume demo; freeze benchmark; run `npm run evolve` (real verdict) | keep rig stable |
| 15:00–16:00 | ablation (bare vs v0 vs vN) if time; evidence ledger; README | — |
| 16:00–17:00 | rehearse, record the 1-minute video, submit | — |

Freeze optional features if the first real measured run isn't done by ~13:30.

## 6. Risks I'd watch

1. **Single rig = slow benchmarks.** ~1–3 min per case per condition. Keep 3–4 train cases, short tests, and
   show previously measured benchmark rows labeled "previously measured" while a live one runs.
2. **Free-tier Atlas** (3 search indexes, 100 ops/s, autoEmbed 3 queries/min): retrieval falls back to recency
   automatically; measurements are batched per test.
3. **OpenPLC v4** needs the STruC++ bundle path (implemented, and the sequence was verified on v4.3.0); if anything about
   the AWS install differs, v3 (raw `.st`) is the fallback with the same REST paths.
4. **Factory I/O Web API needs the Ultimate edition** (trial = Ultimate) and `app.web_server = True` (console/`auto.cfg`).
   Built-in scenes pre-force the box Emitter; our tests stop it and restore it, never blanket-release.
5. **Sensor polarity:** Stop/E-stop and retroreflective eyes are active-low — encoded per tag (`activeLow`) so tests and
   generated code get it right.
6. **Modelence ignores `MONGODB_URI` after `setup`** — handled with a dedicated Atlas client in `apps/web`.
7. **Raindrop drops invalid events silently** (strict validation) — check one event in the Raindrop UI early.
