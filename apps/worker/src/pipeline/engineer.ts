// Loop 1 — engineering repair. Spec → requirements → I/O design → (state machine) → ST → preflight →
// OpenPLC compile → deploy → Factory I/O tests → diagnosis → repair → … → verification → delivery.
// Every stage is checkpointed in Atlas (harness/stages.ts) so an interrupted job resumes where it stopped.
import type { BoundRequirement, HarnessConfig, IoPoint, SceneDefinition } from "@mongomation/types";
import { ObjectId } from "mongodb";
import { bindRequirements } from "../agents/binder.ts";
import { checkStateMachine, designStateMachine, diagnose, generateLogic, repairLogic, type EngineeringContext, type StateMachine } from "../agents/codegen.ts";
import { extractRequirements } from "../agents/requirements.ts";
import { col } from "../db/index.ts";
import { addLesson, retrieveLessons, similarFailures } from "../harness/memory.ts";
import { buildVerifiedProgram, fullyPassing, memoryEnabled, recordRetrieval, requirementFingerprint, retrieveVerifiedPrograms, specHash, upsertVerifiedProgram, type ProgramRetrieval } from "../harness/programs.ts";
import { atlasRecallStore, decideRecall, decideSpecRecall, isReuseKind, isTrustedKind, recallEnabled, recallSignal, recallSkipped, trustEnabled, type RecallDecision } from "../harness/recall.ts";
import { withRig } from "../harness/riglock.ts";
import { BOOT_ID, BlockedError, completedStage, event, runStage, type StageContext } from "../harness/stages.ts";
import { telemetry } from "../telemetry/index.ts";
import { awaitLink, LinkDownError, parseHeartbeat } from "../tools/linkprobe.ts";
import { preflight } from "../tools/preflight.ts";
import type { PlcRuntime, Simulator } from "../tools/rig.ts";
import { assembleProgram, ioTable, lineDiff, lintLogic, type GeneratedLogic } from "./st.ts";
import { earlyStopN, targetedRetestEnabled, testProgram, type RetestMode, type RetestRound, type TestProgramResult } from "./retest.ts";
import { buildTestPlan, failedTestIdsOf, failureFeedback, failureHistory, mergeTargeted, publicView, runPlan, subsetPlan, type SimRunSummary } from "./validate.ts";

export interface EngineerDeps {
  plc: PlcRuntime;
  sim: Simulator;
  rigId: string;
}

export interface EngineerInput {
  projectId: string;
  jobId: string;
  specText: string;
  scene: SceneDefinition;
  config: HarnessConfig;
  /** Benchmark runs on held-out cases: no memory writes, category-only feedback for hidden failures. */
  heldOut?: boolean;
  faultId?: string;
  /** Mid-project spec change: new revision number and the last verified program to evolve from. */
  revision?: number;
  baselineSource?: string;
  /** Benchmark cases grade against ground-truth requirements (same plan for every condition). */
  evaluationRequirements?: BoundRequirement[];
  /**
   * Set ONLY by benchmark/ablation runCase (rsi/evolve.ts). A run whose tests are blocked (no evidence) but none
   * failed ends the case with that run kept as its result (blocked tests count as NOT passed) instead of throwing
   * BlockedError, so one condition's missing evidence does not discard its other results or abort the benchmark.
   * User jobs never set it and keep throwing BlockedError (never repair a program on missing evidence).
   */
  evaluation?: boolean;
  /** Verified Program Memory read path for codegen (job option `memory`; falls back to MEMORY_PROGRAMS=1). */
  memory?: boolean;
  /** Targeted re-test in repair rounds (job option `targetedRetest`; default on, TARGETED_RETEST=0 disables). */
  targetedRetest?: boolean;
  /** Experience recall (job option `recall`, alias `fastpath`); absent -> on whenever program memory is on. */
  recall?: boolean;
}

export interface EngineerResult {
  /** "verified-by-reuse": RECALL_TRUST=1 exact recall, NOT re-tested on the rig in this job (evidence is the source project's). */
  status: "verified" | "partially_verified" | "failed" | "blocked" | "verified-by-reuse";
  attempts: number;
  finalPlcVersionId: string | null;
  lastSimRun: SimRunSummary | null;
  firstCompileOk: boolean | null;
  costUsd: number;
  seconds: number;
}

/** One attempt's rig outcome (targeted re-test aware). */
type TestOutcome =
  | { kind: "compile_failed"; log: string }
  | { kind: "tested"; run: SimRunSummary; mode: RetestMode; rounds: RetestRound[]; regressions: string[] };

export async function runEngineering(input: EngineerInput, deps: EngineerDeps): Promise<EngineerResult> {
  const started = performance.now();
  const startedAt = new Date();
  const { projectId, jobId, specText, scene, config } = input;
  const revision = input.revision ?? 0;
  const ctx: StageContext = { projectId, jobId, revision, log: (m, d) => event(projectId, jobId, null, "info", m, d) };
  let cost = 0;
  const spend = <T extends { costUsd: number }>(x: T) => ((cost += x.costUsd), x);

  // 0. Spec-level exact recall (tier 1, harness/recall.ts) -------------------------------------------
  // Requirement extraction is nondeterministic on identical text, so a repeat spec is recognised by its specHash
  // (normalized spec text + scene + I/O map version) BEFORE any Claude call. A hit replays the source's stored
  // requirements, I/O binding and verified program; the stages are still written (marked recalled).
  // Never for benchmark/eval, held-out, fault or spec-change runs: those must build (or evolve) for real.
  const recallStore = atlasRecallStore();
  const recallOn = recallEnabled(input.recall, input.memory) && !input.heldOut && !input.evaluation && !input.evaluationRequirements && !input.faultId && !input.baselineSource && revision === 0;
  const sHash = specHash(specText, scene);
  let specRecall: RecallDecision | null = null;
  if (recallOn) {
    try {
      specRecall = await decideSpecRecall({ sceneId: scene.id, specHash: sHash, projectId, store: recallStore, trust: trustEnabled(), planHashOf: (b) => buildTestPlan(b, scene, { includeHidden: true }).hash });
    } catch (err) {
      await event(projectId, jobId, "requirements", "warn", `spec-level recall failed, extracting normally: ${(err as Error).message.slice(0, 200)}`);
    }
  }
  const replay = specRecall?.replay ?? null;
  const recalledMark = specRecall ? { recalled: true, sourceProjectId: specRecall.sourceProjectId, specHash: sHash } : {};
  const replayKey = specRecall ? { recalledFrom: specRecall.sourceProjectId, specHash: sHash } : null;

  // 1. Requirements (LLM, or replayed by spec-level recall) -------------------------------------
  type Extracted = Awaited<ReturnType<typeof extractRequirements>>["data"];
  const reqs = await runStage(ctx, "requirements", 0, replayKey ?? { specText, v: config.version, r: config.routing.requirements }, async () => {
    if (replay) return { requirements: replay.requirements as unknown as Extracted, traceId: null as string | null, ...recalledMark };
    const r = spend(await extractRequirements(specText, config, projectId));
    return { requirements: r.data, traceId: r.traceId as string | null };
  });
  // Per-stage timestamps (ms since job start) so cold vs recalled runs can be shown side by side.
  const stageMs: Record<string, number> = { requirements: Math.round(performance.now() - started) };

  // 2. I/O design: bind roles to real scene tags (LLM-proposed, deterministically checked) -----
  const design = await runStage(ctx, "io_design", 0, replayKey ? { ...replayKey, scene: scene.id } : { reqs: reqs.requirements, scene: scene.id }, async () => {
    if (replay) {
      await col.requirements().updateOne(
        { projectId, revision },
        { $set: { projectId, revision, requirements: replay.bound, io: replay.io, sceneId: scene.id, createdAt: new Date(), recalledFrom: specRecall!.sourceProjectId } },
        { upsert: true },
      );
      return { bound: replay.bound, io: replay.io, traceId: null as string | null, ...recalledMark };
    }
    const b = spend(await bindRequirements(reqs.requirements, scene, config, projectId));
    // Self Diagnostics: the binder itself reports which requirements it cannot realize on this scene (a known gap).
    for (const r of b.data.filter((x) => x.support !== "supported"))
      telemetry.selfDiagnose({ runId: projectId, eventId: b.traceId, category: "capability_gap", source: "binder", description: `${r.id}: ${r.unsupportedReason ?? "unsupported"}`, properties: { requirement_id: r.id, scene: scene.id } });
    const io = ioTable(scene, b.data);
    await col.requirements().updateOne(
      { projectId, revision },
      { $set: { projectId, revision, requirements: b.data, io, sceneId: scene.id, createdAt: new Date() } },
      { upsert: true },
    );
    return { bound: b.data, io, traceId: b.traceId as string | null };
  });
  stageMs.io_design = Math.round(performance.now() - started);
  const bound: BoundRequirement[] = design.bound;
  const io: IoPoint[] = design.io;
  const unsupported = bound.filter((r) => r.support !== "supported");
  if (unsupported.length)
    await event(projectId, jobId, "io_design", "warn", `UNSUPPORTED on scene ${scene.id}: ${unsupported.map((r) => `${r.id} (${r.unsupportedReason})`).join("; ")}`);
  if (unsupported.length === bound.length) throw new BlockedError(`no requirement can be realized on scene ${scene.id}`);

  // The validator builds the plan; agents only ever see the public titles. Benchmark runs grade against the
  // case's ground-truth requirements so every condition faces the identical plan.
  const graded = input.evaluationRequirements ?? bound;
  const plan = buildTestPlan(graded, scene, { includeHidden: true });
  const acceptance = publicView(plan).tests.map((t) => `${t.id}: ${t.title}`);

  const query = `${specText}\n${bound.map((r) => r.text).join("\n")}`;

  // Experience recall, tier 2 (harness/recall.ts): requirement fingerprint, for different spec text -------------
  // The fingerprint is stamped on every project (cold ones too) so runIndex / the learning curve count all runs.
  const fingerprint = requirementFingerprint(scene.id, bound);
  let recall: RecallDecision | null = null;
  let runIndex = 0;
  if (recallOn) {
    try {
      recall = specRecall ?? (await decideRecall({ sceneId: scene.id, fingerprint, query, projectId, io, store: recallStore, trust: trustEnabled(), planHash: plan.hash }));
      runIndex = recall.runIndex;
    } catch (err) {
      await event(projectId, jobId, "plc_code", "warn", `experience recall failed, building normally: ${(err as Error).message.slice(0, 200)}`);
    }
  } else runIndex = await recallStore.priorRuns(scene.id, fingerprint, projectId).catch(() => 0);
  stageMs.recall_lookup = Math.round(performance.now() - started);
  const recallKind = recall?.kind ?? "none";
  const reuse = recall && isReuseKind(recall.kind) && recall.exact && recall.logic ? { exact: recall.exact, logic: recall.logic } : null;
  const recallInfo = recall
    ? { kind: recall.kind, enabled: true, sourceProjectId: recall.sourceProjectId, score: recall.score, lookupMs: recall.lookupMs, runIndex, fingerprint, reason: recall.reason, skipped: recallSkipped(recall.kind), sourceTests: reuse?.exact.tests ?? null, sourcePlcVersionId: reuse?.exact.plcVersionId ?? null, sourceVerifiedAt: reuse?.exact.verifiedAt ?? null, trust: trustEnabled(), trustDowngraded: recall.trustDowngraded ?? false, specHash: sHash, originProjectId: reuse ? (reuse.exact.originProjectId ?? reuse.exact.projectId) : null }
    : { kind: "none" as const, enabled: recallOn, runIndex, fingerprint, specHash: sHash };
  await col.projects().updateOne({ _id: projectId as never }, { $set: { fingerprint, recall: recallInfo } }).catch(() => undefined);
  if (recall) {
    recallSignal(projectId, recall);
    const skipped = recallSkipped(recall.kind);
    await event(projectId, jobId, "plc_code", "info", `experience recall: ${recall.kind.toUpperCase()} in ${recall.lookupMs} ms (run #${runIndex + 1} of these requirements on ${scene.id}): ${recall.reason}${skipped.length ? `; skipping ${skipped.join(", ")}` : ""}`, { recall: recallInfo });
  }

  const ectx: EngineeringContext = {
    specText,
    requirements: bound,
    io,
    acceptance,
    // A recalled program is not regenerated, so lesson / failure retrieval (codegen context) is skipped.
    lessons: reuse ? [] : await retrieveLessons(query, config.context),
    similarFailures: reuse ? [] : await similarFailures(query, config.context, scene.id),
    baselineSource: input.baselineSource,
  };
  // Verified Program Memory (explicit flag, or a NEAR recall): closest programs that passed ALL their rig tests.
  const memoryRequested = memoryEnabled(input.memory) || recallKind === "near";
  let programMemory: ProgramRetrieval = { memoryUsed: false, hits: [], retrievalMs: 0, references: [] };
  if (memoryRequested && !reuse) {
    // Recall already ran the same hybrid search: reuse its result instead of querying twice.
    programMemory = recall && (recall.retrieval.references.length || recall.retrieval.error) ? recall.retrieval : await retrieveVerifiedPrograms(query, scene.id, { k: 2, excludeProjectId: projectId });
    ectx.referencePrograms = programMemory.references;
    await event(projectId, jobId, "plc_code", programMemory.error && !programMemory.memoryUsed ? "warn" : "info", `program memory: ${programMemory.hits.length} verified reference(s) in ${programMemory.retrievalMs} ms via ${programMemory.via ?? "none"}${programMemory.error ? ` (${programMemory.error.slice(0, 200)})` : ""}`, { hits: programMemory.hits });
  }
  const memoryInfo = { memoryRequested, memoryUsed: programMemory.memoryUsed, hits: programMemory.hits, retrievalMs: programMemory.retrievalMs, via: programMemory.via ?? null };

  // 3. Optional state machine, verified before any code (not for a recalled program) ---------------
  if (config.workflow.state_machine_before_code && !reuse) {
    const sm = await runStage(ctx, "state_machine", 0, { bound, io, v: config.version }, async () => {
      for (let i = 0; i < 2; i++) {
        const r = spend(await designStateMachine(ectx, config, projectId));
        const problems = checkStateMachine(r.data, bound, io);
        if (!problems.length) return r.data;
        await event(projectId, jobId, "state_machine", "warn", `state machine rejected: ${problems.join("; ")}`);
      }
      throw new Error("state machine failed verification twice");
    });
    ectx.stateMachine = sm as StateMachine;
  }

  // 4. Code generation ------------------------------------------------------------------------------
  // Memory refs are part of the stage input, so a warm run never reuses a cold checkpoint (and vice versa).
  const memKey = memoryRequested ? { mem: programMemory.hits.map((h) => h.projectId) } : {};
  // A recalled program is keyed by its source, so a recall checkpoint is never confused with a codegen one.
  const recallKey = reuse ? { recall: reuse.exact.projectId, recallVersion: reuse.exact.plcVersionId } : {};
  let logic = (await runStage(ctx, "plc_code", 0, { bound, io, v: config.version, sm: ectx.stateMachine ?? null, ...memKey, ...recallKey }, async () => {
    if (reuse)
      return {
        variables: reuse.logic.variables,
        body: reuse.logic.body,
        explanation: `Experience recall: verbatim program of project ${reuse.exact.projectId} (${reuse.exact.tests.passed}/${reuse.exact.tests.total} rig tests passed there). No code generation in this job.`,
        traceId: null,
        memory: memoryInfo,
        recall: recallInfo,
        recalled: true,
        sourceProjectId: reuse.exact.projectId,
      };
    const r = spend(await generateLogic(ectx, config, projectId));
    return { variables: r.data.variables, body: r.data.body, explanation: r.data.explanation, traceId: r.traceId, memory: memoryInfo };
  })) as GeneratedLogic & { explanation: string };
  stageMs.plc_code = Math.round(performance.now() - started);
  await recordRetrieval({ projectId, revision }, programMemory, memoryRequested).catch(() => undefined);

  // RECALL_TRUST=1 exact recall: deliver the recalled program WITHOUT compiling, deploying or testing it in this job.
  // Labelled "verified-by-reuse" (never "verified"); the evidence cited is the source project's own rig run.
  if (reuse && isTrustedKind(recallKind)) {
    const { source, sourceHash } = assembleProgram(io, logic, `MongoMation ${projectId} v1 (harness v${config.version}, scene ${scene.id}) recalled from ${reuse.exact.projectId}`);
    const version = revision * 100 + 1;
    const v = await col.plcVersions().findOneAndUpdate(
      { projectId, version },
      { $setOnInsert: { projectId, version, revision, source, sourceHash, createdBy: "recall", recalledFrom: { projectId: reuse.exact.projectId, plcVersionId: reuse.exact.plcVersionId }, harnessVersion: config.version, diffFromPrevious: null, createdAt: new Date() } },
      { upsert: true, returnDocument: "after" },
    );
    const plcVersionId = String(v!._id);
    const elapsedMs = performance.now() - started;
    const seconds = Math.round(elapsedMs / 1000);
    stageMs.done = Math.round(elapsedMs);
    const recallDone = { ...recallInfo, msSaved: recall!.sourceBuildMs != null ? Math.max(0, Math.round(recall!.sourceBuildMs - elapsedMs)) : null, msSavedIsEstimate: true };
    const reusedFrom = { projectId: reuse.exact.projectId, plcVersionId: reuse.exact.plcVersionId, tests: reuse.exact.tests, verifiedAt: reuse.exact.verifiedAt, note: "NOT compiled, deployed or tested on the rig in this job; the rig evidence is the source project's" };
    const metrics = { memoryRequested, memoryUsed: false, memoryHits: [], retrievalMs: 0, repairs: 0, attempts: 0, firstPass: null, firstCompileOk: null, costUsd: cost, startedAt, finishedAt: new Date(), seconds, timeToVerifiedSec: null, timeToReuseSec: seconds, tests: null, runIndex, stageMs, recall: recallDone };
    await col.projects().updateOne(
      { _id: projectId as never },
      { $set: { status: "verified-by-reuse", currentPlcVersionId: plcVersionId, currentVersion: version, finalPlcVersionId: plcVersionId, lastSimRunId: null, attempts: 0, costUsd: cost, unsupported: unsupported.map((r) => ({ id: r.id, reason: r.unsupportedReason })), recall: recallDone, reusedFrom, metrics } },
    );
    await event(projectId, jobId, "verification", "warn", `VERIFIED-BY-REUSE (RECALL_TRUST=1, ${recallKind}): program recalled from ${reuse.exact.projectId} (${reuse.exact.tests.passed}/${reuse.exact.tests.total} rig tests there). NOT compiled, deployed or tested in this job.`, { reusedFrom });
    telemetry.signal({ runId: projectId, name: "project_verified_by_reuse", properties: { source_project: reuse.exact.projectId, seconds } });
    return { status: "verified-by-reuse", attempts: 0, finalPlcVersionId: plcVersionId, lastSimRun: null, firstCompileOk: null, costUsd: cost, seconds };
  }

  let attempt = 0;
  let previousSource: string | null = null;
  let lastRun: SimRunSummary | null = null;
  let finalVersionId: string | null = null;
  let finalSource: string | null = null;
  let firstCompileOk: boolean | null = null;
  let failedRepairs = 0;
  // Raindrop event of the model call that wrote the current program (codegen, then each repair): critic verdicts are
  // feedback signals on it, and the next repair is an edit signal on it.
  let producerTraceId: string | null = (logic as { traceId?: string | null }).traceId ?? null;
  let pendingEdit: { target: string | null; repairTraceId: string | null } | null = null;
  // Targeted re-test + experience-ordered testing (pipeline/retest.ts): after a repair, re-run only the previous
  // round's failed/blocked tests (ids read from Atlas test_results), then ONE full pass before "verified".
  const retestOn = targetedRetestEnabled(input.targetedRetest);
  let targetIds = null as string[] | null;
  let lastFull: SimRunSummary | null = null;
  const rounds: RetestRound[] = [];

  for (;;) {
    const { source, sourceHash } = assembleProgram(io, logic, `MongoMation ${projectId} v${attempt + 1} (harness v${config.version}, scene ${scene.id})`);
    const version = revision * 100 + attempt + 1;
    const versionDoc = await col.plcVersions().findOneAndUpdate(
      { projectId, version },
      {
        $setOnInsert: {
          projectId,
          version,
          revision,
          source,
          sourceHash,
          createdBy: attempt === 0 ? (reuse ? "recall" : "codegen") : "repair",
          harnessVersion: config.version,
          diffFromPrevious: (previousSource ?? input.baselineSource) ? lineDiff((previousSource ?? input.baselineSource)!, source) : null,
          createdAt: new Date(),
        },
      },
      { upsert: true, returnDocument: "after" },
    );
    const plcVersionId = String(versionDoc!._id);
    telemetry.attach(projectId, [{ name: `program v${version}.st`, value: source, type: "text" }, { name: `diff to v${version}`, value: String(versionDoc?.diffFromPrevious ?? "") }]);
    if (pendingEdit) {
      // The repair as an edit of the previous program: `after` is the repaired program, the diff is a property.
      telemetry.signal({ runId: projectId, name: "repair_edit", type: "edit", sentiment: "NEGATIVE", eventId: pendingEdit.target, after: source, properties: { version, diff: String(versionDoc?.diffFromPrevious ?? "").slice(0, 4000), repair_event_id: pendingEdit.repairTraceId ?? "" } });
      pendingEdit = null;
    }
    finalVersionId = plcVersionId;
    finalSource = source;
    await col.projects().updateOne({ _id: projectId as never }, { $set: { currentPlcVersionId: plcVersionId, currentVersion: version } });

    // 5. Static checks + local preflight (real MatIEC) --------------------------------------------
    let feedback: string[] = lintLogic(io, logic).map((p) => `static check: ${p}`);
    if (!feedback.length && config.workflow.preflight_compile) {
      const pf = await runStage(ctx, "preflight", attempt, { sourceHash }, async () => {
        const r = await preflight(source);
        await col.compiles().insertOne({ plcVersionId, stage: "preflight", toolchain: "matiec-iec2c", ...r, createdAt: new Date() });
        telemetry.tool({ name: "preflight_compile", runId: projectId, input: { sourceHash } }, { ok: r.status === "ok", skipped: r.status === "unavailable", summary: r.status, durationMs: r.durationMs });
        return r;
      });
      if (pf.status === "failed") feedback = [`MatIEC compile error: ${pf.log}`];
      if (pf.status === "unavailable") await event(projectId, jobId, "preflight", "warn", `preflight skipped: ${pf.log}`);
    }

    if (!feedback.length) {
      // 6-8. Real compile, deploy and simulation under the rig lock ---------------------------------
      // A simulation that already completed for this exact program and plan is evidence: reuse it after a restart.
      // Targeted rounds first re-run only the previous round's failed/blocked tests (pipeline/retest.ts).
      const subset: ReturnType<typeof subsetPlan> | null = retestOn && targetIds?.length ? subsetPlan(plan, targetIds) : null;
      const doneFull = await completedStage<SimRunSummary>(ctx, "simulate", attempt, { sourceHash, plan: plan.hash });
      const doneTargeted: SimRunSummary | null = !doneFull && subset ? await completedStage<SimRunSummary>(ctx, "simulate", attempt, { sourceHash, plan: subset.hash }) : null;
      const reused: SimRunSummary | null = doneFull ?? (doneTargeted && doneTargeted.failed > 0 ? doneTargeted : null);
      // Experience-ordered testing: the scene's failure history from Atlas orders every run (most failure-prone first).
      const history = retestOn && !reused ? await failureHistory(scene.id) : undefined;
      const outcome: TestOutcome = reused
        ? { kind: "tested" as const, run: reused, mode: (reused === doneFull ? "full" : "targeted") as RetestMode, rounds: [] as RetestRound[], regressions: [] as string[] }
        : await withRig(deps.rigId, jobId, async (): Promise<TestOutcome> => {
        const comp = await runStage(ctx, "compile", attempt, { sourceHash, boot: BOOT_ID }, async () => {
          const r = await deps.plc.compile(source, `mm_${projectId.slice(-6)}_v${attempt + 1}`).catch((e: unknown) => {
            // Only a dead/unreachable rig is BLOCKED; STruC++ rejections and OpenPLC build FAILED come back as ok:false.
            throw rigUnreachable(e) ? new BlockedError(`rig unreachable at OpenPLC upload: ${redactRigHost((e as Error).message)}`) : e;
          });
          const doc = await col.compiles().insertOne({ plcVersionId, stage: "compile", toolchain: deps.plc.label, ...r, createdAt: new Date() });
          const traceId = telemetry.tool({ name: "openplc_compile", runId: projectId, input: { sourceHash } }, { ok: r.ok, summary: r.ok ? "compiled" : r.log.slice(-300), durationMs: r.durationMs, evidenceIds: [String(doc.insertedId)] });
          if (!r.ok) telemetry.signal({ runId: projectId, name: "plc_compile_failed", eventId: traceId });
          if (!r.ok) telemetry.attach(projectId, [{ name: `OpenPLC compile log v${version}`, value: r.log }]);
          return { ...r, compileId: String(doc.insertedId) };
        });
        if (firstCompileOk === null) firstCompileOk = comp.ok;
        if (!comp.ok) return { kind: "compile_failed" as const, log: comp.log };

        await runStage(ctx, "deploy", attempt, { sourceHash, boot: BOOT_ID }, async () => {
          await deps.plc.start();
          const st = await deps.plc.status();
          if (!st.running) throw new Error(`runtime not running after start: ${st.detail}`);
          const link = await linkGate(deps.sim, source, (m) => event(projectId, jobId, "deploy", "info", m));
          await col.deployments().insertOne({ plcVersionId, sourceHash, runtime: deps.plc.label, status: st, ...(link && { linkUpMs: link.ms }), createdAt: new Date() });
          return { running: true };
        });
        await new Promise((r) => setTimeout(r, scene.timing.settleMs));

        const exec = (mode: RetestMode, ids: string[] | null) => {
          const p = mode === "targeted" && ids ? subsetPlan(plan, ids) : plan;
          return runStage(ctx, "simulate", attempt, { sourceHash, plan: p.hash }, async () =>
            runPlan({
              sim: deps.sim,
              scene,
              plan: p,
              requirements: graded,
              projectId,
              plcVersionId,
              sourceHash,
              harnessVersion: config.version,
              faultId: input.faultId,
              split: input.heldOut ? "heldout" : "train",
              onProgress: (m) => event(projectId, jobId, "tests", "info", m),
              mode,
              history,
              // repair rounds stop at the first N failures; the full pass always runs every test
              stopAfterFailures: mode === "targeted" ? earlyStopN() : undefined,
            }),
          );
        };
        const tp: TestProgramResult<SimRunSummary> = await testProgram({ attempt, targetIds: subset ? subset.tests.map((t) => t.id) : null, previousFull: lastFull, exec });
        return { kind: "tested" as const, run: tp.run, mode: tp.mode, rounds: tp.rounds, regressions: tp.regressions };
      });

      if (outcome.kind === "compile_failed") feedback = [`OpenPLC compile error: ${outcome.log.slice(-2000)}`];
      else {
        lastRun = outcome.run;
        if (outcome.mode === "full") lastFull = outcome.run;
        if (outcome.rounds.length) {
          rounds.push(...outcome.rounds);
          await col.projects().updateOne({ _id: projectId as never }, { $set: { rounds } }).catch(() => undefined);
          for (const r of outcome.rounds)
            await event(projectId, jobId, "tests", "info", `${r.mode} round: ${r.passed}/${r.tests} passed, ${r.failed} failed, ${r.blocked} blocked in ${(r.ms / 1000).toFixed(1)} s (order: ${r.orderSource}${r.earlyStop ? `, early stop, ${r.skipped} deferred` : ""})`);
        }
        if (outcome.regressions.length)
          await event(projectId, jobId, "tests", "warn", `full pass regression: ${outcome.regressions.join(", ")} passed before and fail now; counted as failure`);
        await runStage(ctx, "tests", attempt, { simRunId: outcome.run.simRunId }, async () => ({ passed: outcome.run.passed, failed: outcome.run.failed, blocked: outcome.run.blocked }));
        if (outcome.run.blocked && !outcome.run.failed && input.evaluation) {
          await event(projectId, jobId, "tests", "warn", `${outcome.run.blocked} test(s) blocked (no evidence); evaluation run: recorded as not passed, no repair on missing evidence`);
          break;
        }
        if (outcome.run.blocked && !outcome.run.failed) throw new BlockedError(`${outcome.run.blocked} test(s) could not produce evidence (rig / measurement problem); not retrying the program`);
        if (!outcome.run.failed) {
          if (attempt > 0) await verifyLessons(projectId);
          break;
        }
        feedback = failureFeedback(outcome.run.results, input.heldOut ? "category" : "observed");
        // Next round re-tests what failed/was blocked here (read back from Atlas test_results) + early-stop leftovers.
        targetIds = retestOn ? await failedTestIdsOf(outcome.run) : null;
      }
    }

    if (attempt >= config.workflow.repair_budget) {
      telemetry.signal({ runId: projectId, name: "repair_budget_exhausted", properties: { attempts: attempt + 1, budget: config.workflow.repair_budget, feedback: feedback.join(" | ").slice(0, 500) } });
      break;
    }

    // 9. Diagnosis (critic) ---------------------------------------------------------------------------
    const diag = await runStage(ctx, "diagnosis", attempt, { sourceHash, feedback }, async () => {
      const d = spend(await diagnose(ectx, source, feedback, config, projectId));
      const doc = await col.diagnoses().insertOne({
        projectId,
        plcVersionId,
        sceneId: scene.id,
        split: input.heldOut ? "heldout" : "train",
        feedback,
        summary: d.data.summary,
        text: `${d.data.summary} ${d.data.causes.map((c) => `${c.cause} -> ${c.fix}`).join(" ")}`,
        causes: d.data.causes,
        lessons: d.data.lessons,
        traceId: d.traceId,
        harnessVersion: config.version,
        createdAt: new Date(),
      });
      // Critic verdict = feedback on the event that wrote the failing program; its root causes are the critic's own
      // report of what is wrong (Self Diagnostics on the critic event).
      const critique = `${d.data.summary}\n${d.data.causes.map((c) => `${c.requirementId}: ${c.cause} -> ${c.fix}`).join("\n")}`;
      telemetry.signal({ runId: projectId, name: "critic_verdict", type: "feedback", sentiment: "NEGATIVE", eventId: producerTraceId, comment: critique, properties: { attempt, causes: d.data.causes.length, critic_event_id: d.traceId ?? "" } });
      telemetry.selfDiagnose({ runId: projectId, eventId: d.traceId, category: "root_cause", source: "critic", description: critique, properties: { attempt, requirement_ids: d.data.causes.map((c) => c.requirementId).join(",") } });
      return { diagnosisId: String(doc.insertedId), summary: d.data.summary, causes: d.data.causes };
    });

    // 10. Repair -----------------------------------------------------------------------------------------
    const escalate = config.routing.escalate_after_failures > 0 && failedRepairs >= config.routing.escalate_after_failures;
    const tier = escalate ? "strong" : config.routing.repair;
    const failing = [...new Set((lastRun?.results ?? []).filter((r) => r.verdict === "failed").flatMap((r) => r.requirementIds))];
    logic = (await runStage(ctx, "repair", attempt, { sourceHash, feedback, tier }, async () => {
      const r = spend(
        await repairLogic(
          ectx,
          { previousSource: source, feedback, diagnosis: diag.summary + "\n" + diag.causes.map((c) => `${c.requirementId}: ${c.cause} -> ${c.fix}`).join("\n"), failingRequirementIds: failing },
          config,
          tier,
          projectId,
        ),
      );
      await col.repairs().insertOne({ projectId, fromVersionId: plcVersionId, diagnosisId: diag.diagnosisId, tier, traceId: r.traceId, createdAt: new Date() });
      return { variables: r.data.variables, body: r.data.body, explanation: r.data.explanation, traceId: r.traceId };
    })) as GeneratedLogic & { explanation: string };
    const repairTraceId = (logic as { traceId?: string | null }).traceId ?? null;
    pendingEdit = { target: producerTraceId, repairTraceId };
    producerTraceId = repairTraceId;
    previousSource = source;
    failedRepairs++;
    attempt++;
  }

  // 11. Verification report -------------------------------------------------------------------------------
  // Budget ran out on a targeted round: report it merged into the last full pass (it has failures, never verified).
  const endedTargeted = lastRun?.mode === "targeted";
  if (lastRun && endedTargeted && lastFull) lastRun = mergeTargeted(plan, graded, lastFull, lastRun);
  const verdicts = lastRun?.verdicts ?? [];
  const supported = graded.filter((r) => r.support === "supported");
  const verified = verdicts.filter((v) => v.status === "verified").length;
  // "verified" only ever comes from a full pass on the final program.
  const status: EngineerResult["status"] = !lastRun ? "failed" : verified === supported.length && !endedTargeted ? "verified" : verified > 0 ? "partially_verified" : "failed";
  const allPassed = !endedTargeted && fullyPassing(lastRun);
  const seconds = Math.round((performance.now() - started) / 1000);
  // Cold vs warm metrics (Verified Program Memory): one queryable sub-document per project.
  const metrics = {
    memoryRequested,
    memoryUsed: programMemory.memoryUsed,
    memoryHits: programMemory.hits,
    retrievalMs: programMemory.retrievalMs,
    repairs: attempt,
    attempts: attempt + 1,
    firstPass: allPassed && attempt === 0,
    firstCompileOk,
    costUsd: cost,
    startedAt: startedAt,
    finishedAt: new Date(),
    seconds,
    timeToVerifiedSec: allPassed ? seconds : null,
    tests: lastRun ? { passed: lastRun.passed, total: lastRun.passed + lastRun.failed + lastRun.blocked } : null,
    targetedRetest: retestOn,
    rounds,
    testMs: rounds.reduce((a, r) => a + r.ms, 0),
    // Experience recall: learning-curve x axis (prior runs of these requirements on this scene), stage timeline, and
    // the recall outcome. An exact recall is "confirmed" only if the one full rig pass passed with no repair.
    runIndex,
    stageMs: { ...stageMs, done: Math.round(performance.now() - started) },
    recall: {
      ...recallInfo,
      ...(reuse && { confirmed: allPassed && attempt === 0, fellBackToLoop: !(allPassed && attempt === 0) }),
      msSaved: recall?.sourceBuildMs != null && allPassed && (recallKind === "near" || (reuse && attempt === 0)) ? Math.max(0, Math.round(recall.sourceBuildMs - seconds * 1000)) : null,
      msSavedIsEstimate: true,
    },
  };
  await col.projects().updateOne({ _id: projectId as never }, { $set: { recall: metrics.recall } }).catch(() => undefined);
  await runStage(ctx, "verification", 0, { finalVersionId, simRunId: lastRun?.simRunId ?? null }, async () => {
    await col.projects().updateOne(
      { _id: projectId as never },
      { $set: { status, verdicts, unsupported: unsupported.map((r) => ({ id: r.id, reason: r.unsupportedReason })), finalPlcVersionId: finalVersionId, lastSimRunId: lastRun?.simRunId ?? null, attempts: attempt + 1, costUsd: cost, metrics, rounds } },
    );
    return { status, verified, supported: supported.length };
  });
  // Write path: a program that passed EVERY test on the rig becomes verified memory (never from held-out/eval runs).
  if (allPassed && lastRun && finalSource && finalVersionId && !input.heldOut && !input.evaluation) {
    try {
      await upsertVerifiedProgram(
        buildVerifiedProgram({
          projectId, sceneId: scene.id, specText, requirements: bound, stSource: finalSource, plcVersionId: finalVersionId, run: lastRun, harnessVersion: config.version,
          specHash: sHash,
          planHash: plan.hash,
          // Lineage: a recall run's copy points at the ORIGINAL build so msSaved never shrinks recall-to-recall.
          originProjectId: reuse ? (reuse.exact.originProjectId ?? reuse.exact.projectId) : projectId,
          replay: { requirements: reqs.requirements, bound, io },
        }),
      );
      await event(projectId, jobId, "verification", "info", `verified program stored in program memory (${lastRun.passed}/${lastRun.passed + lastRun.failed + lastRun.blocked} tests)`);
    } catch (err) {
      await event(projectId, jobId, "verification", "warn", `program memory write failed: ${(err as Error).message}`);
    }
  }
  telemetry.signal({ runId: projectId, name: status === "verified" ? "project_verified" : "project_not_verified", properties: { attempts: attempt + 1 } });
  return { status, attempts: attempt + 1, finalPlcVersionId: finalVersionId, lastSimRun: lastRun, firstCompileOk, costUsd: cost, seconds };
}

/** Lessons from diagnoses that preceded a measured fix become "verified" and enter retrieval. */
async function verifyLessons(projectId: string) {
  const diags = await col.diagnoses().find({ projectId, split: "train" }).toArray();
  for (const d of diags) for (const l of (d.lessons as { pattern: string; fix: string }[]) ?? []) await addLesson(l, { projectId, diagnosisId: String(d._id), verifiedBy: "measured_fix" });
}

export const newProjectId = () => new ObjectId().toHexString();

/**
 * After start(): wait until the PLC <-> Factory I/O Modbus link is proven by the harness heartbeat (tools/linkprobe.ts).
 * No heartbeat in the program -> null (OpenPlcRest.start() already did the fixed FACTORYIO_RELINK_MS wait).
 * A link that never comes back is the rig's fault, so it is BLOCKED, never FAILED.
 */
export async function linkGate(sim: Simulator, source: string, log: (m: string) => unknown): Promise<{ ms: number } | null> {
  const hb = parseHeartbeat(source);
  if (!hb) return null;
  try {
    const r = await awaitLink(sim, hb, { timeoutMs: Number(process.env.FACTORYIO_LINK_TIMEOUT_MS || 180_000) });
    await log(`Modbus link up ${(r.ms / 1000).toFixed(1)} s after RUNNING (heartbeat on "${hb.counterTag}"${hb.ncTag ? `, NC input "${hb.ncTag}" echoed` : ""})`);
    return { ms: r.ms };
  } catch (e) {
    if (e instanceof LinkDownError) throw new BlockedError(e.message);
    throw e;
  }
}

/** Stored errors are shown on the public dashboard: never echo the rig's URL or IP/host:port. */
export function redactRigHost(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/'")]+/gi, "<rig>").replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<rig>");
}

/** Network/timeout/login-transport failures talking to the rig (not compile verdicts). */
function rigUnreachable(e: unknown): boolean {
  const err = e as { name?: string; message?: string; code?: string; cause?: { code?: string; name?: string } };
  const codes = /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|ECONNRESET|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET/;
  return (
    err?.name === "AbortError" ||
    err?.name === "TimeoutError" ||
    err?.cause?.name === "ConnectTimeoutError" ||
    codes.test(String(err?.code ?? "")) ||
    codes.test(String(err?.cause?.code ?? "")) ||
    /fetch failed|rig unreachable|OpenPLC login failed/.test(String(err?.message ?? ""))
  );
}
