# MongoMation — submission draft

Harness Engineering & Model Wrangling Hackathon (MongoDB, SF Tech Week) · Tracks: Long Horizon Engineering, Recursive Harnessing (RSI)

- Repo: https://github.com/zubair480/MongoMation
- Live dashboard (Modelence): https://mongomation-mv43qiu7n6f-prod.cloud.modelence.app
- Video: _add link_

## 1. Name and pitch

**MongoMation** — describe a machine in plain English and an agent writes, compiles, tests and repairs its PLC program, while a second loop improves the harness that does the engineering.

## 2. Description (150 words)

MongoMation turns a written automation spec into an IEC 61131-3 Structured Text program. The harness, not the model, writes every I/O address from the scene's verified map, so addresses can't be made up. Each program goes through a local MatIEC preflight, then the real OpenPLC compiler, then tests on a Factory I/O simulation. A separate pure grader decides pass or fail from measured samples, and missing data counts as blocked, never as a pass. Failures feed a repair loop. A second loop reads repeated failures, proposes at most one change to the harness itself, checks it against fixed guardrails and a frozen benchmark, and keeps it only if results improve without weakening safety. Every spec, program version, measurement, verdict and harness version lives in MongoDB Atlas, so a crashed worker resumes from its last checkpoint. Raindrop traces the agent calls. The dashboard runs on Modelence.

## 3. How it uses each sponsor

- **MongoDB Atlas** — the hackathon sandbox holds the `mongomation` database: job queue with leases and heartbeats, stage checkpoints, program versions, verdicts and harness versions, plus a time-series collection for measurements and 2 vector indexes for memory retrieval (26 indexes total). Harness v0 is seeded there.
- **Raindrop** — traces each agent call and tool step; events are confirmed arriving. The RSI loop cites Raindrop event ids as evidence for the failures behind a harness change.
- **Modelence** — hosts the dashboard. It reads Atlas and only writes to `jobs`; the live deployment shows Atlas as CONNECTED.
- **AWS** — designed to host the worker, the OpenPLC runtime and Factory I/O (viewed through Amazon DCV) in one VPC. This rig is not connected yet.

## 4. Track fit

**Long Horizon Engineering**
- Work is split into stages (requirements, I/O design, code, preflight, compile, simulate, test, repair), and each stage's output is saved to Atlas before it is marked done.
- Jobs are claimed atomically and send heartbeats every 3 s; a job whose worker goes quiet for 15 s is re-queued with `resumedFrom` and reuses finished stages instead of redoing them.
- "Interrupt Worker" kills the worker mid-stage with no cleanup; "Resume from MongoDB" picks up from the checkpoints, so recovery is shown, not described.

**Recursive Harnessing (RSI)**
- The meta-agent proposes at most one harness change (rules, context, workflow, repair or routing) and only for failure patterns seen at least twice on the train split.
- Immutable guardrails reject changes that touch hidden tests or benchmarks, turn off preflight, or delete rules. Rejected proposals are stored and never benchmarked.
- A gate compares parent and candidate on a frozen benchmark (same model, scene and grader) and marks the change KEPT or ROLLED BACK. `npm run ablation` then compares a bare one-shot model, harness v0 and the evolved harness on held-out cases.

## 5. 60-second video script

Follows the order in `docs/DEMO.md`, cut down. Anything not run live is labeled "previously measured" on screen.

| Time | On screen | Voiceover |
|---|---|---|
| 0:00–0:08 | Dashboard home, Atlas badge CONNECTED | "MongoMation takes a plain-English machine spec and engineers the PLC program for it." |
| 0:08–0:20 | Click **Run Example**; Requirements → I/O Design → PLC Code stages light up; generated Structured Text with the harness-written I/O block | "The agent writes the logic. The harness writes every I/O address from the scene's map, so the model can't invent one." |
| 0:20–0:32 | Preflight and OpenPLC compile log, RUNNING; Factory I/O view with the conveyor moving; test verdicts and requirement table | "It compiles with the real OpenPLC toolchain and is tested on a Factory I/O simulation. A separate grader decides from measured data. No data means blocked, not passed." |
| 0:32–0:44 | Click **Inject Fault & Improve Harness**; FORCED tag, diagnosis, diff; meta-agent proposal, guardrails, verdict | "When tests fail, it repairs the program. A second loop proposes one change to the harness itself and keeps it only if a frozen benchmark improves." |
| 0:44–0:54 | Click **Interrupt Worker**, heartbeat goes stale; **Resume from MongoDB**, "reused checkpoint from Atlas" events | "Every stage is checkpointed in MongoDB Atlas. Kill the worker and it resumes where it stopped." |
| 0:54–1:00 | `npm run ledger` output, then the Raindrop trace | "Every claim links to evidence in Atlas and Raindrop." |

## 6. Results

| condition | requirement satisfaction | compile first try | test pass rate | repairs/case | cost/case |
|---|---|---|---|---|---|
| bare one-shot | | | | | |
| harness v0 | | | | | |
| harness vN | | | | | |

Fill from `npm run ablation` / `npm run ledger` output — do not enter numbers that were not measured.

Current status (2026-10-11): 15/15 unit tests and the isolation check pass. No end-to-end runs have been measured yet, because the Claude key is not set and the AWS rig (OpenPLC / Factory I/O) is not connected.
