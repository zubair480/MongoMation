# MongoMation — submission

Harness Engineering & Model Wrangling Hackathon (MongoDB, SF Tech Week) · Tracks: Long Horizon Engineering, Recursive Harnessing (RSI)

- Repo: https://github.com/zubair480/MongoMation
- Live dashboard (Modelence): https://mongomation-mv43qiu7n6f-prod.cloud.modelence.app
- Video: **TODO: add link**

## 1. Name and pitch

**MongoMation** — describe a machine in plain English and an agent writes, compiles, deploys, tests and repairs its PLC
program on a real OpenPLC runtime driving a Factory I/O plant, while a second loop improves the harness that does the
engineering.

## 2. Description (~150 words)

MongoMation turns a written automation spec into an IEC 61131-3 Structured Text program. The harness, not the model,
writes every I/O address from the scene's verified map, so addresses can't be made up. Each program is built with
STruC++ into an OpenPLC Runtime v4 bundle, compiled and started on the real runtime, and tested on a live Factory I/O
scene that talks to the PLC over Modbus. A separate pure grader decides pass or fail from measured samples; missing
data counts as blocked, never as a pass. Failures feed a repair loop. A second loop reads repeated failures, proposes
at most one change to the harness itself, checks it against fixed guardrails and a frozen benchmark, and keeps it only
if results improve. Every spec, program version, measurement, verdict and harness version lives in MongoDB Atlas, so a
crashed worker resumes from its last checkpoint. Raindrop traces the agent calls. The dashboard runs on Modelence.

## 3. How it uses each sponsor

- **MongoDB Atlas: system of record and control plane** (db `mongomation`)
  - Durable job queue: atomic claim, 3 s heartbeats, stale-job recovery with stage checkpoints.
  - Change streams on `jobs` wake the worker (no polling). Pre/post images feed a `job_transitions` audit and a
    harness-immutability audit.
  - Multi-document transactions write the RSI candidate and its verdict together.
  - Time-series `measurements` collection for plant samples.
  - Failure memory uses hybrid retrieval: Atlas Vector Search with automated embedding (Voyage `voyage-4`) plus Atlas
    Search (fuzzy, autocomplete, facets), fused with `$rankFusion`.
  - `$jsonSchema` validators, for example `harness_versions` requires `run_regression_tests: true`. Also TTL
    lifecycle, a least-privilege web user, and window-function analytics.
  - Live counts (queried 2026-10-11): 30 collections; 17 jobs (8 completed, 6 blocked, 2 failed, 1 running);
    28,937 measurement samples; 20 audited job transitions; `lessons_vec` (autoEmbed, voyage-4) and
    `lessons_search` indexes READY.
- **Raindrop: failures become regression tests**
  - Every agent call, tool step and subagent is traced and tagged with a `harness_version` feature flag. Crashed jobs
    resume the same interaction (`resumeInteraction`). Failures and verdicts emit signals.
  - The Query API reads traces back as cited evidence for the RSI meta-agent.
  - A dashboard and a "MongoMation failing interactions" dataset (11 rows as of 2026-10-11) form the regression set.
    Raindrop holds 201 events from the last 30 days.
  - Raindrop Workshop evals score real jobs by harness version (`npm run raindrop:eval`). The Workshop MCP drives the
    self-healing loop.
- **Modelence: production app**
  - Deployed dashboard with live queries over change streams (no polling), channels, cron jobs (rig/job watch, ops
    digest), Stores, rate limits, roles and verified-email guards, telemetry, and `@modelence/ai` failure explanations.
- **AWS: real rig plus a deterministic gate around the LLM**
  - OpenPLC Runtime v4 and Factory I/O run on EC2. The worker reaches them through the team's HTTPS gateway.
    Factory I/O is OpenPLC's Modbus client.
  - Nothing the model writes is trusted. A hidden grader, regression tests and `rsi/gate.ts` (KEPT / ROLLED BACK)
    decide every outcome.
  - AWS SDK modules (S3 artifacts, CloudWatch metrics/logs/alarms, SSM health probe) and a CloudFormation template
    (`infra/aws/`) are written and flag-gated. They are **not deployed** in this submission.

## 4. Track fit

**Long Horizon Engineering**
- Work is split into stages (requirements, I/O design, code, preflight, compile, simulate, test, repair); each stage's
  output is saved to Atlas before it is marked done.
- Jobs are claimed atomically and heartbeat every 3 s; a job whose worker is silent for 15 s is re-queued with
  `resumedFrom` and reuses finished stages instead of redoing them.
- "Interrupt Worker" kills the worker mid-stage with no cleanup; "Resume from MongoDB" picks up from the checkpoints.
- Real-plant timing is part of the horizon: every deploy waits out Factory I/O's ~60 s Modbus relink before any
  behaviour is judged.

**Recursive Harnessing (RSI)**
- The meta-agent proposes at most one harness change (rules, context, workflow, repair or routing), and only for
  failure patterns seen at least twice on the train split; otherwise the verdict is NO CHANGE.
- Immutable guardrails reject changes that reference hidden tests or the evaluation set, turn off preflight, or delete
  rules. Rejected proposals are stored and never benchmarked.
- A gate runs parent and candidate on a frozen benchmark (same model, scene and grader) and marks the change KEPT or
  ROLLED BACK. `npm run ablation` compares a bare one-shot model, harness v0 and the evolved harness on held-out cases;
  the dashboard's Ablation card shows the result.

## 5. 60-second video script

Recording order and operator steps: `docs/DEMO_RUNBOOK.md`. Anything not run live is labeled "previously measured".

| Time | On screen | Voiceover |
|---|---|---|
| 0:00–0:08 | Dashboard home, Atlas CONNECTED; `npm run rig:smoke` all ✓ | "MongoMation takes a plain-English machine spec and engineers the PLC program for a real runtime." |
| 0:08–0:20 | **Run Example**; Requirements → I/O Design → PLC Code; generated ST with the harness-written I/O block | "The agent writes the logic. The harness writes every I/O address from the scene's map, so the model can't invent one." |
| 0:20–0:32 | OpenPLC compile log, RUNNING; DCV view of Factory I/O with the conveyor moving; test verdicts | "It's compiled and run on OpenPLC and tested on a Factory I/O plant. A separate grader decides from measured data. No data means blocked, not passed." |
| 0:32–0:44 | **Inject Fault & Improve Harness** (High sensor stuck ON): FORCED tag, diagnosis, diff; proposal, guardrails, verdict | "We force a sensor fault. It repairs the program, and a second loop proposes one change to the harness, kept only if a frozen benchmark improves." |
| 0:44–0:54 | Ablation card: bare vs v0 vs evolved | "On held-out cases we compare a bare model, the original harness and the evolved one." |
| 0:54–1:00 | Interrupt / Resume from MongoDB, or `npm run ledger` + Raindrop trace | "Every stage is checkpointed in Atlas, and every claim links to evidence." |

## 6. Results

**TODO: fill from `npm run ablation` (dashboard Ablation card / its JSON download) and `npm run ledger`. Do not enter
numbers that were not measured; mark any replayed row "previously measured" with its date.**

| condition | requirement satisfaction | compile first try | test pass rate | repairs/case | cost/case |
|---|---|---|---|---|---|
| bare one-shot | TODO | TODO | TODO | TODO | TODO |
| harness v0 | TODO | TODO | TODO | TODO | TODO |
| harness vN | TODO | TODO | TODO | TODO | TODO |

RSI verdicts so far (Atlas, 2026-10-11): 5 proposals, all **NO CHANGE**. Only harness v0 exists. KEPT / ROLLED BACK
verdict for the current run: **TODO**, pending the other session's evolve run.

Before/after ablation number: **TODO**. Video link: **TODO**.

## 7. Status (2026-10-11, update before submitting)

- Verified today: `npm test` 98/98 pass (35 suites). STruC++ builds OpenPLC Runtime v4 bundles offline from the
  scene's address map.
- Rig: reached through the team's HTTPS gateway (not SSM port forwarding). The scene's I/O map and polarity were
  checked against the rig owner's live map. **TODO:** record the first full rig run (Run Example → fault → evolve →
  ablation).

## 8. Honest limits

- Small numbers. 17 jobs and 5 RSI proposals so far. No harness change has been KEPT yet, so the self-improvement
  claim is a working mechanism, not a measured gain.
- The ablation results table is still empty. We will not fill it with numbers we did not measure.
- One scene and one rig. Results say nothing about other plants or other PLC vendors.
- The AWS SDK modules and CloudFormation stack are written and tested but not deployed. Today the rig runs on
  team-provided EC2 behind an HTTPS gateway.
- Raindrop is on the free tier, so evals run locally in Raindrop Workshop rather than in hosted Evals.
- The shared rig needs a ~60 s Modbus relink after each deploy, which limits how many runs fit in a day.
