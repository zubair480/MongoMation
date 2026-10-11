# Demo recording runbook

Exact order for recording the submission video against the live rig. `docs/DEMO.md` is the 3-minute live pitch;
this file is the operator checklist behind it. Everything shown must be a real run. Anything replayed from Atlas
is labeled **"previously measured"** on screen and in the voiceover.

Durations are planning estimates, not measurements. The fixed cost is the **~65 s Modbus relink wait after every
upload** (`FACTORYIO_RELINK_MS=65000`): Factory I/O drops its Modbus link to OpenPLC after each deploy and the worker
waits before judging plant behaviour. Every compile+deploy therefore costs at least ~1.5 min (STruC++ build, OpenPLC
compile, start, relink). Cut those waits in editing; do not fake them.

## 0. Prep (T-45 min; not recorded)

Preferred: **the team gateway** (any network, no AWS, no tunnels; `docs/SETUP.md` §5.0). `.env` holds
`OPENPLC_URL=https://<GATEWAY>/openplc`, `FACTORYIO_URL=https://<GATEWAY>/factoryio`, `OPENPLC_INSECURE_TLS=true`,
`FACTORYIO_INSECURE_TLS=true`, `FACTORYIO_HOST_HEADER=` (empty). `TEAM_API_KEY` + `OPENPLC_PASSWORD` come from
`.env.rig` (gitignored symlink to the kit `.env`, loaded after `.env` by every npm script). Check:
`npm run rig:smoke` must show all rows ✓ (login, ping, STATUS:RUNNING, 41 tags, scene running, 24/24 tags);
skip the `aws`/`rig-tunnels`/`rig-env` lines below. Never show `.env.rig` on screen.

Fallback (SSM tunnels): the rig steps (AWS login, tunnels, password) are done by the teammate who has AWS access to
the rig, on their machine. Alternative: run the worker on the Linux rig host itself with `OPENPLC_BUILDER=docker:plc-builder` (no tunnels;
URLs `https://127.0.0.1:8443` and `http://<RIG_FIO_HOST>:7410`).

All in **one WSL shell** at `~/mongomation` (tunnels and worker must share WSL; see `docs/SETUP.md` §5).

```bash
source ~/.nvm/nvm.sh
aws sts get-caller-identity                 # logged in? (you log in yourself: aws login --remote)
bash scripts/rig-tunnels.sh start           # 8443 + 7410 "ready"
source scripts/rig-env.sh                   # exports OPENPLC_PASSWORD (value never printed)
node -e "import('strucpp/node').then(m=>console.log(m.getVersion()))"   # STruC++ present (re-install after npm ci)
npm run seed                                # scene sorting-by-height-basic must be VERIFIED
```

Open, side by side: the dashboard https://mongomation-mv43qiu7n6f-prod.cloud.modelence.app, the Amazon DCV 3D view
(URL from the private handoff; your IP must be allowlisted), the Raindrop project page, and a terminal.
In DCV make sure the Factory I/O scene is loaded and running.

Recording hygiene: never show `.env`, `aws ssm get-parameter` output, the DCV URL bar, the instance id or account id.
`rig-env.sh` and `rig:smoke` never print the password; keep it that way (no `echo $OPENPLC_PASSWORD`, no `env`).

## 1. Recorded sequence

| # | Step | Command / click | Show on screen | Expected time |
|---|---|---|---|---|
| 1 | Rig smoke | `npm run rig:smoke` | ✓ openplc login / ping / status, ✓ factoryio tags, scene tags all present, tag values. Read-only: no uploads, no writes | ~10–30 s |
| 2 | Readiness | `npm run green` | ✓ atlas ✓ claude ✓ raindrop, preflight (`unavailable` is OK on v4: say "authoritative compile is on OpenPLC"), ✓ openplc ✓ factoryio | ~10–20 s |
| 3 | Worker | `npm run launcher` (leave running, terminal visible) | worker starts, heartbeats; dashboard rig/worker status goes green | ~5–15 s |
| 4 | Spec → program → rig | Dashboard: in "Example for Run Example" pick **Height sorting with lane jam protection** (the default is the conveyor-jam example), click **Run Example** | Spec text; Requirements → I/O Design → PLC Code stages; generated ST with the harness-written I/O block; OpenPLC compile log, RUNNING; DCV: conveyor moving; test verdicts + requirement table. Repairs (if any) show diff + retest | ~4–10 min (≥ 1 deploy + 65 s relink per repair round) |
| 5 | Fault + harness | Dashboard: pick fault **High sensor stuck ON** in the fault selector, click **Inject Fault & Improve Harness** | Worker reloads the project's program (another 65 s relink), forces `High sensor` via the Factory I/O Web API, FORCED read-back confirmed (DCV/SimulationPanel), fault tests, diagnosis + before/after diff if it failed, meta-agent proposal, guardrails, verdict | ~4–10 min |
| 6 | Recursive harnessing | `npm run evolve` | `evolve job … queued`, then the job result and `latest proposal: KEPT / ROLLED BACK / REJECTED / NO_CHANGE — rationale` + config diff; dashboard RSI card. A candidate queues a benchmark job (parent vs candidate on the 4 frozen train cases) before the gate verdict | proposal ~1–3 min; gate benchmark ~8 case runs, ~20–40 min |
| 7 | Ablation | `npm run ablation` | `ablation job … queued` and the final scores JSON. Runs the 2 held-out cases under bare one-shot, harness v0 and (if a newer version was KEPT) vN | ~6 case runs, ~15–30 min |
| 8 | Ablation card | Dashboard: **Ablation (held-out)** card (under the RSI card) | Bare vs Harness v0 vs Evolved vN columns; download JSON. Say which numbers are from this recording vs previously measured | ~15 s |
| 9 | Proof (optional) | `npm run ledger`; Raindrop trace | Evidence ids: program version, compile, sim run, measurements, harness verdict, Raindrop events | ~30 s |

Notes:
- `npm run evolve` only proposes a change when the same failure pattern appears at least twice under the current
  harness on the train split; otherwise the honest result is **NO_CHANGE**. If you need evidence first, run
  `npm run benchmark` (train cases, baseline rows) before step 6, off camera.
- Steps 6–7 are long. Start them before the recording session (≈15:00 at the latest) or record the start and the
  end and cut the middle. Never splice results from a different run without labeling them "previously measured".
- Interrupt/Resume (from `docs/DEMO.md`) can be added after step 4: **Interrupt Worker** mid-simulation, then
  **Resume from MongoDB** (requires `npm run launcher`, not `npm run worker`).
- CLI equivalents: `npm run example -- --example sorting`, `npm run fault -- --fault high-sensor-stuck-on`.

## 2. Fallback if the rig or AWS is unavailable

There is **no simulator or mock mode** in this codebase: the only `Simulator` implementation is
`FactoryIoWebApi` (real Factory I/O Web API), and `createRig()` throws on missing rig config instead of falling back
to a fake (`apps/worker/src/tools/connect.ts`). The unit-test double (`TestDoubleRig` in `checks/test/`) is not wired
into the worker. Do not add one for the demo.

Without the rig, jobs that need it end **BLOCKED** with the real error. That is honest, but it isn't a demo. Do this instead:

1. **Show stored real runs.** The dashboard reads Atlas, so earlier rig runs (projects, compile logs, sim runs,
   verdicts, RSI proposals, ablation rows) are still visible. Label them **"previously measured"** with their timestamps.
2. **Show what runs without the rig** live: `npm test` (unit tests incl. the grader against the test double),
   `npm run typecheck`, `npm run verify:isolation`, `npm run green` (atlas/claude/raindrop rows green, rig rows red
   with the real error), and **Run Example** up to the stages before the rig (requirements, I/O binding, generated ST),
   which then shows BLOCKED at deploy. Say so on screen.
3. **Use a backup recording** of steps 4–8 made earlier the same day, if one exists. Keep its original timestamps visible.
4. Partial outages:

| Symptom | Fix |
|---|---|
| `rig:smoke` timed out (direct access) | not on the team Wi-Fi / rig stopped / IP not allowlisted; check `curl -s https://checkip.amazonaws.com`, ask the rig owner |
| `rig:smoke` ECONNREFUSED on 8443/7410 | `bash scripts/rig-tunnels.sh status` / `logs`; restart with `stop` + `start`; tunnels must run in WSL |
| `aws sts get-caller-identity` fails | session expired: the operator logs in again (`aws login --remote`) |
| `OPENPLC_PASSWORD is not set` | `source scripts/rig-env.sh` in the shell that runs the launcher, then restart the launcher |
| `STruC++ not installed` | re-run the install in `docs/SETUP.md` §4 (wiped by `npm ci`) |
| Fault button disabled | rig status stale or scene not VERIFIED: check the worker terminal, `npm run seed`, `npm run green` |
| Tests BLOCKED right after a deploy | relink not finished: keep `FACTORYIO_RELINK_MS=65000`; check DCV that Factory I/O shows the PLC outputs |
| Factory I/O frozen / no boxes | in DCV check the scene is running; the worker's test setup pulses `FACTORY I/O (Reset)` before tests |
| Atlas timeouts | Atlas → Network Access → add the current IP |
| Worker won't resume | the launcher isn't running: `npm run launcher` |

After recording: `bash scripts/rig-tunnels.sh stop`.
