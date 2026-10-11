# MongoMation — self-improving autonomous PLC engineer

> Describe the machine. We engineer the control system. The harness gets smarter.

MongoMation turns a natural-language automation spec into an IEC 61131-3 program, compiles it with the real OpenPLC
toolchain, deploys it to an OpenPLC runtime, measures it on a live Factory I/O simulation (AWS), repairs it from measured
failures — and a meta-harness evolves the *engineering harness itself*, keeping a change only when a frozen benchmark
improves without weakening safety. MongoDB Atlas holds every spec, program version, measurement, verdict and harness
version; Raindrop traces every agent call and tool step; the dashboard runs on Modelence.

**Start here:** [`docs/PREP_BRIEF.md`](docs/PREP_BRIEF.md) (status + day plan) · [`docs/INTEGRATION_CONTRACT.md`](docs/INTEGRATION_CONTRACT.md)
(AWS rig contract) · [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`AGENTS.md`](AGENTS.md) (rules for coding agents) ·
[`docs/research/`](docs/research) (verified API notes: OpenPLC v4/v3, Factory I/O, MongoDB, Raindrop, Modelence).

```
apps/worker/     engineering worker: agents/, harness/ (jobs, stages, rig lock, memory, config), pipeline/, rsi/, tools/, telemetry/
apps/web/        Modelence dashboard (reads Atlas, writes only `jobs`)
packages/types/  shared contracts (scene, requirements, harness config, tests)
checks/          independent validator: pure grader, live runner, templates, HIDDEN regression tests
harness/         harness v0
scenes/          Factory I/O scene registry (address maps, faults)
specs/           Run Example specs + frozen benchmark
scripts/         setup-atlas, seed, green, example, evolve, benchmark, ledger, probe generator, isolation check
```

```bash
npm install && npm test && npm run typecheck && npm run verify:isolation
cp .env.example .env   # fill in Atlas, Claude, Raindrop, rig values
npm run setup:atlas && npm run seed && npm run worker
```

Honesty rules: no mocked services in demo paths; missing dependencies show BLOCKED/DISCONNECTED with the real error;
the model never grades its own code; requirements without measured evidence are never reported as verified.
