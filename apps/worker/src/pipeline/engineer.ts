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
import { withRig } from "../harness/riglock.ts";
import { BOOT_ID, BlockedError, completedStage, event, runStage, type StageContext } from "../harness/stages.ts";
import { telemetry } from "../telemetry/index.ts";
import { awaitLink, LinkDownError, parseHeartbeat } from "../tools/linkprobe.ts";
import { preflight } from "../tools/preflight.ts";
import type { PlcRuntime, Simulator } from "../tools/rig.ts";
import { assembleProgram, ioTable, lineDiff, lintLogic, type GeneratedLogic } from "./st.ts";
import { buildTestPlan, failureFeedback, publicView, runPlan, type SimRunSummary } from "./validate.ts";

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
}

export interface EngineerResult {
  status: "verified" | "partially_verified" | "failed" | "blocked";
  attempts: number;
  finalPlcVersionId: string | null;
  lastSimRun: SimRunSummary | null;
  firstCompileOk: boolean | null;
  costUsd: number;
  seconds: number;
}

export async function runEngineering(input: EngineerInput, deps: EngineerDeps): Promise<EngineerResult> {
  const started = performance.now();
  const { projectId, jobId, specText, scene, config } = input;
  const revision = input.revision ?? 0;
  const ctx: StageContext = { projectId, jobId, revision, log: (m, d) => event(projectId, jobId, null, "info", m, d) };
  let cost = 0;
  const spend = <T extends { costUsd: number }>(x: T) => ((cost += x.costUsd), x);

  // 1. Requirements (LLM) ----------------------------------------------------------------------
  const reqs = await runStage(ctx, "requirements", 0, { specText, v: config.version, r: config.routing.requirements }, async () => {
    const r = spend(await extractRequirements(specText, config, projectId));
    return { requirements: r.data, traceId: r.traceId };
  });

  // 2. I/O design: bind roles to real scene tags (LLM-proposed, deterministically checked) -----
  const design = await runStage(ctx, "io_design", 0, { reqs: reqs.requirements, scene: scene.id }, async () => {
    const b = spend(await bindRequirements(reqs.requirements, scene, config, projectId));
    const io = ioTable(scene, b.data);
    await col.requirements().updateOne(
      { projectId, revision },
      { $set: { projectId, revision, requirements: b.data, io, sceneId: scene.id, createdAt: new Date() } },
      { upsert: true },
    );
    return { bound: b.data, io, traceId: b.traceId };
  });
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
  const ectx: EngineeringContext = {
    specText,
    requirements: bound,
    io,
    acceptance,
    lessons: await retrieveLessons(query, config.context),
    similarFailures: await similarFailures(query, config.context, scene.id),
    baselineSource: input.baselineSource,
  };

  // 3. Optional state machine, verified before any code ------------------------------------------
  if (config.workflow.state_machine_before_code) {
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
  let logic = (await runStage(ctx, "plc_code", 0, { bound, io, v: config.version, sm: ectx.stateMachine ?? null }, async () => {
    const r = spend(await generateLogic(ectx, config, projectId));
    return { variables: r.data.variables, body: r.data.body, explanation: r.data.explanation, traceId: r.traceId };
  })) as GeneratedLogic & { explanation: string };

  let attempt = 0;
  let previousSource: string | null = null;
  let lastRun: SimRunSummary | null = null;
  let finalVersionId: string | null = null;
  let firstCompileOk: boolean | null = null;
  let failedRepairs = 0;

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
          createdBy: attempt === 0 ? "codegen" : "repair",
          harnessVersion: config.version,
          diffFromPrevious: (previousSource ?? input.baselineSource) ? lineDiff((previousSource ?? input.baselineSource)!, source) : null,
          createdAt: new Date(),
        },
      },
      { upsert: true, returnDocument: "after" },
    );
    const plcVersionId = String(versionDoc!._id);
    telemetry.attach(projectId, [{ name: `program v${version}.st`, value: source, type: "text" }, { name: `diff to v${version}`, value: String(versionDoc?.diffFromPrevious ?? "") }]);
    finalVersionId = plcVersionId;
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
      const doneRun = await completedStage<SimRunSummary>(ctx, "simulate", attempt, { sourceHash, plan: plan.hash });
      const outcome = doneRun ? { kind: "tested" as const, run: doneRun } : await withRig(deps.rigId, jobId, async () => {
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

        const run = await runStage(ctx, "simulate", attempt, { sourceHash, plan: plan.hash }, async () =>
          runPlan({
            sim: deps.sim,
            scene,
            plan,
            requirements: graded,
            projectId,
            plcVersionId,
            sourceHash,
            harnessVersion: config.version,
            faultId: input.faultId,
            split: input.heldOut ? "heldout" : "train",
            onProgress: (m) => event(projectId, jobId, "tests", "info", m),
          }),
        );
        return { kind: "tested" as const, run };
      });

      if (outcome.kind === "compile_failed") feedback = [`OpenPLC compile error: ${outcome.log.slice(-2000)}`];
      else {
        lastRun = outcome.run;
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
      return { variables: r.data.variables, body: r.data.body, explanation: r.data.explanation };
    })) as GeneratedLogic & { explanation: string };
    previousSource = source;
    failedRepairs++;
    attempt++;
  }

  // 11. Verification report -------------------------------------------------------------------------------
  const verdicts = lastRun?.verdicts ?? [];
  const supported = graded.filter((r) => r.support === "supported");
  const verified = verdicts.filter((v) => v.status === "verified").length;
  const status: EngineerResult["status"] = !lastRun ? "failed" : verified === supported.length ? "verified" : verified > 0 ? "partially_verified" : "failed";
  await runStage(ctx, "verification", 0, { finalVersionId, simRunId: lastRun?.simRunId ?? null }, async () => {
    await col.projects().updateOne(
      { _id: projectId as never },
      { $set: { status, verdicts, unsupported: unsupported.map((r) => ({ id: r.id, reason: r.unsupportedReason })), finalPlcVersionId: finalVersionId, lastSimRunId: lastRun?.simRunId ?? null, attempts: attempt + 1, costUsd: cost } },
    );
    return { status, verified, supported: supported.length };
  });
  telemetry.signal({ runId: projectId, name: status === "verified" ? "project_verified" : "project_not_verified", properties: { attempts: attempt + 1 } });
  return { status, attempts: attempt + 1, finalPlcVersionId: finalVersionId, lastSimRun: lastRun, firstCompileOk, costUsd: cost, seconds: Math.round((performance.now() - started) / 1000) };
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
