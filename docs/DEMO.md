# Demo runbook (3 minutes live, 1-minute video)

Everything below is a real run. If a step can't run live, show the stored result **labeled "previously measured"**
(the dashboard shows provenance on RSI rows) and say so out loud.

## 30 minutes before
```bash
npm run green          # ✓ atlas ✓ claude ✓ raindrop ✓ preflight ✓ openplc ✓ factoryio
npm run seed           # scene VERIFIED? (must say VERIFIED, else validation is BLOCKED)
npm run launcher       # starts the worker under the launcher (needed for Interrupt/Resume)
```
Open: the Modelence dashboard, the DCV 3D view, and the Raindrop project page.

## The 3 minutes
| Time | Segment | Action | What the judges see |
|---|---|---|---|
| 0:00–0:35 | Spec-driven engineering | **Run Example** | Spec text appears in the input; Requirements → I/O Design → PLC Code stages light up; generated ST with harness-written I/O block |
| 0:35–1:15 | Real industrial validation | (same run) | Preflight (MatIEC) → OpenPLC compile log → RUNNING → tests driving Factory I/O (DCV shows the conveyor/lights move); public + hidden test verdicts; requirement table VERIFIED/UNTESTED |
| 1:15–2:15 | Fault & harness | **Inject Fault & Improve Harness** | Forced tag shows FORCED (read-back confirmed) → fault tests → (if failed) diagnosis, before/after diff, retest → meta-agent proposal + config diff → guardrails → verdict KEPT / ROLLED BACK / REJECTED / NO CHANGE (benchmark rows labeled live or previously measured) |
| 2:15–2:45 | Durability | **Interrupt Worker** mid-simulation, then **Resume from MongoDB** | Worker heartbeat goes stale; job shows `resumedFrom`; events "reused checkpoint from Atlas" for finished stages; only the interrupted stage re-runs |
| 2:45–3:00 | Proof | `npm run ledger` / Atlas collections / Raindrop trace | Evidence ids for the program version, compile, sim run, measurements, harness verdict, Raindrop events |

## Before freeze (≈15:00)
1. `npm run benchmark` — baseline scores of the current harness on the frozen train cases (stored, labeled).
2. `npm run evolve` — at least one real proposal + verdict (a ROLLED BACK or REJECTED verdict is valid evidence).
3. Optional ablation on held-out cases: bare one-shot vs v0 vs vN (same model).
4. Record a full backup run.

## If something breaks live
| Symptom | Do this |
|---|---|
| Fault button disabled | rig_status stale or scene unverified — check worker logs and `npm run green` |
| Compile fails on the rig | the log is real and goes to the repair loop; on v4 the last good program is restored automatically |
| Tests BLOCKED | measurement gap (Web API unreachable) — it's reported, never counted as a pass |
| Atlas timeouts | Atlas → Network Access → add current IP |
| Worker won't resume | the launcher isn't running: `npm run launcher` |
