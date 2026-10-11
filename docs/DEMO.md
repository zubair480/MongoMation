# Demo: live script and operator checklist

How to show MongoMation against the live rig, as a 3-minute live demo or a recorded video. Everything shown must
be a real run. Anything replayed from Atlas is labeled **"previously measured"** on screen and out loud (the
dashboard shows provenance on RSI rows).

After every upload, Factory I/O re-connects its Modbus link to OpenPLC. The harness proves the link with a heartbeat
it adds to every program (measured link-up 1.2 to 9 s); a program without the heartbeat falls back to the fixed
`FACTORYIO_RELINK_MS` wait. Each compile and deploy still costs tens of seconds. Cut waits in editing; never fake them.

## 1. Prep (about 45 minutes before; not recorded)

Rig access goes through the team HTTPS gateway ([`SETUP.md`](SETUP.md) §5.0). The SSM tunnel path (§5.1 to §5.5)
is the fallback.

```bash
source ~/.nvm/nvm.sh
node -e "import('strucpp/node').then(m=>console.log(m.getVersion()))"   # STruC++ present (re-install after npm ci)
npm run rig:smoke      # read-only: OpenPLC login/ping/status, Factory I/O tags; every row must be ✓
npm run green          # ✓ atlas ✓ claude ✓ raindrop, preflight (unavailable is OK on v4), ✓ openplc ✓ factoryio
npm run seed           # scene sorting-by-height-basic must report VERIFIED, otherwise validation is BLOCKED
npm run launcher       # worker under the launcher (needed for Interrupt / Resume)
```

Open side by side: the dashboard (https://mongomation-mv43qiu7n6f-prod.cloud.modelence.app), the Factory I/O view
(DCV tab in the dashboard), the Raindrop project, and a terminal. Make sure the Factory I/O scene is loaded and running.

**Recording hygiene:** never show `.env`, `.env.rig`, SSM output, the DCV URL bar, instance ids or account ids.
`rig-env.sh` and `rig:smoke` never print the password; keep it that way.

## 2. The 3-minute live demo

| Time | Segment | Action | What viewers see |
|---|---|---|---|
| 0:00–0:35 | Spec-driven engineering | **Run Example** (or type a custom spec) | Spec text; Requirements → I/O Design → PLC Code; generated ST with the harness-written I/O block |
| 0:35–1:15 | Real industrial validation | (same run) | OpenPLC compile log → RUNNING → tests driving Factory I/O; public and hidden verdicts; requirement table |
| 1:15–2:15 | Fault and harness | **Inject Fault & Improve Harness** | Forced tag with read-back confirmed → fault tests → diagnosis, diff, retest → meta-agent proposal → guardrails → verdict |
| 2:15–2:45 | Durability | **Interrupt Worker** mid-simulation, then **Resume from MongoDB** | Job shows `resumedFrom`; "reused checkpoint from Atlas" for finished stages; only the interrupted stage re-runs |
| 2:45–3:00 | Proof | `npm run ledger`, Atlas collections, Raindrop trace | Evidence ids for program version, compile, sim run, samples, verdict, Raindrop events |

## 3. Recorded sequence (operator checklist)

| # | Step | Command / click | Show on screen | Planning estimate |
|---|---|---|---|---|
| 1 | Rig smoke | `npm run rig:smoke` | All rows ✓; read-only, no uploads | 10–30 s |
| 2 | Readiness | `npm run green` | ✓ atlas ✓ claude ✓ raindrop ✓ openplc ✓ factoryio | 10–20 s |
| 3 | Worker | `npm run launcher` | Worker heartbeats; dashboard worker/rig status goes green | 5–15 s |
| 4 | Spec → program → rig | Dashboard: pick an example, click **Run Example** | Stages, ST, compile log, plant moving, test verdicts, requirement table; repairs show diff + retest | 4–10 min |
| 5 | Fault + harness | Pick fault **High sensor stuck ON**, click **Inject Fault & Improve Harness** | FORCED read-back, fault tests, diagnosis, proposal, guardrails, verdict | 4–10 min |
| 6 | Recursive harnessing | `npm run evolve` | Latest proposal: KEPT / ROLLED BACK / REJECTED / NO_CHANGE with rationale; a candidate queues a benchmark job | proposal 1–3 min; benchmark 20–40 min |
| 7 | Ablation | `npm run ablation` | Held-out cases under bare one-shot, v0 and the current kept harness | 15–30 min |
| 8 | Proof (optional) | `npm run ledger`; Raindrop trace | Evidence ids | 30 s |

Notes:
- `npm run evolve` proposes a change only when the same failure pattern appears at least twice under the current
  harness on the train split. Otherwise the honest result is **NO_CHANGE**.
- Steps 6 and 7 are long. Start them before the session, or record the start and the end and cut the middle.
  Never splice results from a different run without labeling them "previously measured".
- CLI equivalents: `npm run example -- --example sorting`, `npm run fault -- --fault high-sensor-stuck-on`.

## 4. If the rig is unavailable

There is **no simulator or mock mode**: `createRig()` throws on missing rig config instead of falling back to a fake
([`apps/worker/src/tools/connect.ts`](../apps/worker/src/tools/connect.ts)). Without the rig, jobs end **BLOCKED**
with the real error. Instead:

1. **Show stored real runs.** The dashboard reads Atlas, so earlier rig runs stay visible. Label them "previously
   measured" with their timestamps.
2. **Show what runs without the rig:** `npm test`, `npm run typecheck`, `npm run verify:isolation`, `npm run green`
   (rig rows red with the real error), and **Run Example** up to the generated ST, which then shows BLOCKED at deploy.
3. **Use a backup recording** made earlier the same day, with its original timestamps visible.

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| `rig:smoke` HTTP 401 | `TEAM_API_KEY` missing: link the kit's `.env` as `.env.rig` ([`SETUP.md`](SETUP.md) §5.0) |
| `ECONNREFUSED` on 8443 / 7410 (tunnel path) | `bash scripts/rig-tunnels.sh status` / `logs`; restart; tunnels must run in WSL |
| `OPENPLC_PASSWORD is not set` | `source scripts/rig-env.sh` in the shell that runs the launcher, then restart it |
| `STruC++ not installed` | Re-run the install in [`SETUP.md`](SETUP.md) §4 (wiped by `npm ci`) |
| Fault button disabled | Rig status stale or scene not VERIFIED: check the worker terminal, `npm run seed`, `npm run green` |
| Tests BLOCKED right after a deploy | Link not up yet: check the deploy event for "Modbus link up", and the Factory I/O view |
| Factory I/O frozen / no boxes | Check the scene is running; test setup pulses `FACTORY I/O (Reset)` before tests |
| Compile fails on the rig | The log is real and goes to the repair loop; on v4 the last good program is restored |
| Atlas timeouts | Atlas → Network Access → add the current IP |
| Worker won't resume | The launcher isn't running: `npm run launcher` |
