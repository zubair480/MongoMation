# MongoMation — submission

Harness Engineering & Model Wrangling Hackathon (MongoDB, SF Tech Week) · Track 1: Recursive Harnessing (RSI), with
long-horizon engineering on a real plant

- Repo: https://github.com/zubair480/MongoMation
- Live dashboard (Modelence): https://mongomation-mv43qiu7n6f-prod.cloud.modelence.app
- Raindrop dashboard "MongoMation — RSI learning curve":
  https://app.raindrop.ai/dashboards/817fd0ec-a165-4d1b-a45e-669750fe91c7?org=c4886d11&project=default
- Raindrop experiment "Experience recall ON vs OFF":
  https://app.raindrop.ai/experiments/a1ddf994-d802-480a-a9ab-fca2e4f401ef?org=c4886d11&project=default
- Video: **TODO: add video link**

## 1. Name and pitch

**MongoMation** — describe a machine in plain English and an agent writes, compiles, deploys, tests and repairs its PLC
program on a real OpenPLC runtime driving a Factory I/O plant. MongoDB Atlas remembers what worked, so the next run
can reuse it, and a second loop proposes changes to the harness itself.

## 2. Description (≤150 words)

MongoMation turns a plain-English machine spec into a PLC program proven on a real plant. Claude writes IEC 61131-3
Structured Text; the harness compiles it with STruC++, deploys it to an OpenPLC v4 runtime on AWS driving a Factory
I/O plant, and grades it with hidden tests on measured plant behaviour. A cold run passed 25/25 tests first try
(290 s, $0.07). Failures trigger targeted repair: Atlas failure history re-runs only the failed test (9.7 s vs 146 s
for a full pass). MongoDB Atlas is the memory: time-series plant samples, change streams that turn successful repairs
into lessons, transactions for harness-evolution writes, and Voyage-embedded Vector Search fused with Atlas Search via
$rankFusion to recall proven programs. A meta-agent proposes harness changes from real evidence behind a benchmark
gate; it has declined every time, once correctly blaming a flawed test. Raindrop traces every run; Modelence hosts the
dashboard.

## 3. What actually runs

1. **Spec → requirements → I/O binding.** Claude (Opus 5.5 / Sonnet 5.5) extracts requirements. The harness, not the
   model, writes every I/O address from the scene's verified map, so the model cannot invent one.
2. **Code → build → deploy.** Claude writes IEC 61131-3 ST. STruC++ builds an OpenPLC Runtime v4 bundle, which is
   deployed and started on the real runtime (AWS, reached through the team's HTTPS gateway).
3. **Active link probe.** Instead of a blind 65 s wait for Factory I/O's Modbus client to reconnect, the harness adds a
   heartbeat it owns and polls the plant until it echoes. Measured link-up after deploy: 1.2–4.7 s.
4. **Hidden tests on the real plant.** A pure grader decides pass or fail from measured samples. Missing data counts as
   BLOCKED, never as a pass. Three new hidden edge-case tests (held reset, timer re-arm, single count) were each proven
   to catch a wrong implementation that passes every public test.
5. **Repair.** Tests are ordered by Atlas failure history; a repair round first re-runs only the failed tests, then a
   full pass. "Verified" is only ever granted by a full pass.
6. **Experience recall.** Before writing code, the harness looks in Atlas for a proven program (see §4).
7. **RSI.** A meta-agent reads repeated failures and may propose one harness change; guardrails and a frozen benchmark
   gate decide KEPT or ROLLED BACK (see §5).

## 4. How it uses each sponsor

- **MongoDB Atlas: memory, system of record and control plane** (db `mongomation`)
  - Time-series `measurements` collection for plant samples: 76,369 real samples (Atlas count, 2026-10-11).
  - Change streams with resume tokens: `jobs` wake the worker (no polling); a lesson writer on `sim_runs` turns
    repairs that fixed real failures into lessons (7 mined today: 2 active and rig-verified, 5 candidates).
  - Multi-document transactions write RSI candidate harness, benchmark job and proposal together, and the verdict on
    `harness_versions` + `rsi_proposals` together.
  - Experience recall stack: Atlas Automated Embedding (`voyage-code-4`) vector index `verified_programs_vec` plus Atlas
    Search, fused with `$rankFusion` (hybrid retrieval, ~260 ms in run 2); a spec-hash index (`scene_spechash`) for
    exact-spec recall and an fp3 requirement-fingerprint index (`scene_fingerprint`). A program is reused **without**
    a rig run only when the stored test-plan hash matches the current plan; such a project is marked
    `verified-by-reuse` and is never claimed as tested.
  - Lessons and failure diagnoses: `lessons_vec` / `diagnoses_vec` (autoEmbed, Voyage) + `lessons_search` /
    `diagnoses_search`.
  - `$jsonSchema` validators (validation action warn, e.g. on `verified_programs`), atomic job claim, heartbeats and
    stage checkpoints so a crashed worker resumes.
- **Raindrop: observability and measured learning**
  - Every engineering job is one Raindrop interaction with Claude sub-agents (requirements, binder, codegen, critic,
    repair) and rig tool spans (compile, per-test simulator runs) nested in one trace. Outcomes and failures are
    signals that feed the RSI meta-agent.
  - Job-level properties (seconds, repairs, cost, recall kind, run index) are charted on the "RSI learning curve"
    dashboard; the "Experience recall ON vs OFF" experiment compares cohorts (links at the top).
- **AWS: the real rig**
  - OpenPLC Runtime v4 and Factory I/O run on EC2; the worker reaches them through the team's HTTPS gateway. Factory
    I/O is OpenPLC's Modbus client.
  - AWS SDK modules (S3, CloudWatch, SSM) and a CloudFormation template exist in `infra/aws/` but are **not deployed**.
- **Modelence: production app**
  - Deployed dashboard with live queries over change streams, cron jobs, roles and telemetry (link at the top).

## 5. Track fit: Recursive Harnessing

Two loops improve future runs, and we report both honestly.

**Loop 1, experience (works on real evidence today).** Verified programs, failure history and lessons are written back
to Atlas and read by the next run: recall of proven programs, failure-history test ordering, targeted re-tests, and
lessons mined from repairs.

**Loop 2, harness self-modification (mechanism works; no change kept yet).**
- The meta-agent proposes at most one harness change, and only for failure patterns seen at least twice; otherwise
  NO CHANGE. Guardrails reject changes that touch hidden tests or the evaluation set, disable preflight or delete
  rules. A gate runs parent vs candidate on a frozen benchmark and marks KEPT or ROLLED BACK; any blocked test on
  either side means ROLLED BACK (no evidence, no keep).
- Atlas holds 7 RSI proposals from today's real rig evidence, all **NO CHANGE**. In one case the meta-agent found that
  the repeated failures came from a flawed test oracle (a fault lamp tested as a run lamp), not from the generated
  code, and declined to bend the harness to it. The oracle was then fixed outside the harness, and the oscillating
  failures disappeared.
- **No harness rule was KEPT by the gate today.**

## 6. Results (real rig, spec `sorting-plausibility-v2`, 2026-10-11)

Source: Atlas (`scripts/learning-curve.ts`, read-only) and the team board. Times are claim → verified.

| run | recall | status | tests | time | Claude cost | repairs |
|---|---|---|---|---|---|---|
| 1 cold (memory off), project `6acc077046845cd7abc6ea90` | none | VERIFIED first try | 25/25 | 290 s (tests 226 s = 78%) | $0.073 | 0 |
| 2 (memory on) | NEAR: fuzzy match to a different spec | VERIFIED | 16/16 | 381 s | $0.181 | 1 |
| 3 exact-spec recall (same spec, zero Claude calls, proven program reused), project `6acc0e1816da31e31e8b981b` | trusted-spec, source = run 1 | VERIFIED-BY-REUSE (not re-tested; cites run 1's 25/25) | – | **1 s** | **$0** | 0 |
| 4 repeat of run 3, project `6acc0e4c16da31e31e8b9825` | trusted-spec (75 ms lookup) | VERIFIED-BY-REUSE | – | **0 s** | **$0** | 0 |

Honest reading:
- Run 2 was slower and dearer than run 1. The fuzzy (NEAR) recall did not help: it matched a different spec, codegen
  still ran, and requirement-extraction drift on the same spec text caused the one failure (fixed by repair). This is
  why we added spec-level exact recall (run 3).
- What did help in run 2: the targeted re-test of only the failed test took **9.7 s vs 146 s** for a full pass, a
  15× faster repair round, driven by Atlas failure history and experience-ordered tests.
- Run 3: the same spec text was recognised in Atlas by spec hash in 291 ms; zero Claude calls; the rig-proven program
  from run 1 was reused, but only because its stored test-plan hash matched today's plan. Status is `verified-by-reuse`
  (it was not re-tested in that job). Learning curve on this spec: **290 s → 1 s, $0.073 → $0**.
- RSI rule proposals: after the oracle fix, the meta-agent proposed a new engineering rule twice from a repeated
  failure (4× across 2 projects: stop/E-stop-named transfer actuators gated by a sensor instead of run/enable). Both
  proposals were rejected by the guardrail for exceeding the 400-character rule limit, a prompt bug we then fixed. No
  rule has yet been KEPT by the gate.

The planned bare-model vs harness ablation produced no scores: gateway sampling gaps blocked whole cases, and we chose
not to report numbers we did not measure.

## 7. 60-second video script

| Time | On screen | Voiceover |
|---|---|---|
| 0:00–0:08 | Dashboard home, Atlas connected, rig green | "MongoMation takes a plain-English machine spec and engineers the PLC program on a real plant." |
| 0:08–0:20 | Requirements → I/O → generated ST with the harness-written I/O block | "Claude writes the logic. The harness writes every I/O address, so the model can't invent one." |
| 0:20–0:32 | STruC++ build, OpenPLC RUNNING, link probe up in seconds, Factory I/O moving, test verdicts | "It's built, deployed to OpenPLC on AWS and tested on Factory I/O with hidden tests. No data means blocked, not passed." |
| 0:32–0:44 | Repair round: targeted re-test 9.7 s vs full pass 146 s; lessons from the change stream | "Atlas failure history re-runs only what failed, and successful repairs become lessons." |
| 0:44–0:54 | Run 3 exact-spec recall: 1 s, $0, 0 Claude calls (vs 290 s cold); Raindrop learning-curve dashboard | "Same spec again: Atlas recalls the proven program instead of regenerating it." |
| 0:54–1:00 | RSI card: proposals, all NO CHANGE, oracle diagnosis | "The harness can rewrite itself, but only if a benchmark proves it. Today it rightly declined." |

## 8. Status (2026-10-11, update before submitting)

- Rig: OpenPLC v4 + Factory I/O on AWS, reached through the team's HTTPS gateway; smoke checks green during today's
  runs.
- Tests: the repo's unit suite passed on the latest board reports (183/183).
- **TODO:** video link (top).

## 9. Honest limits

- Small numbers: two completed runs on the learning-curve spec so far, one scene, one rig. Results say nothing about
  other plants or PLC vendors.
- No harness change has been KEPT, so harness self-improvement is a working mechanism, not a measured gain.
- Fuzzy (NEAR) recall did not speed anything up in our one measured case.
- Requirement extraction is not deterministic on identical spec text; spec-level recall works around this rather than
  fixing it.
- Gateway sampling gaps can BLOCK tests; blocked tests are reported as blocked and never count as passed.
- AWS SDK modules and the CloudFormation stack are written but not deployed.
