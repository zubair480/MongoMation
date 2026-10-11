// Shared contracts for MongoMation. HarnessConfig, SceneDefinition, TestCase and TestResult are the
// frozen interfaces between the engineering agent, the independent validator and the meta-harness.
// Change them only with both developers' agreement (docs/INTEGRATION_CONTRACT.md).
import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// Scenes: what a real, registered Factory I/O scene offers. Supplied and verified by Developer 1.
// ---------------------------------------------------------------------------------------------

export const TagValue = z.union([z.boolean(), z.number()]);
export type TagValue = z.infer<typeof TagValue>;

export const SceneTag = z
  .object({
    /** Exact Factory I/O tag name, e.g. "Entry conveyor". */
    name: z.string().min(1),
    /** sensor = PLC input (read by the PLC); actuator = PLC output (written by the PLC). */
    role: z.enum(["sensor", "actuator"]),
    dataType: z.enum(["BOOL", "INT", "REAL"]),
    /** Located variable used in Structured Text, e.g. "%IX100.0". Fixed by the rig's Modbus mapping. */
    plcAddress: z.string().regex(/^%[IQM][XWD]\d+(\.\d+)?$/),
    /** Equipment kind, used for capability matching ("photoelectric", "pushbutton", "conveyor", ...). */
    kind: z.string().min(1),
    description: z.string().default(""),
    /** Input that reads FALSE when "active": NC Stop / Emergency stop buttons (FALSE when pressed) and
     *  retroreflective photo-eyes (FALSE when a part blocks the beam). Tests press/activate inputs via this. */
    activeLow: z.boolean().default(false),
    /** Factory I/O tag kind, needed because tag names are not unique (e.g. "FACTORY I/O (Reset)"). */
    fioKind: z.enum(["Input", "Output"]).optional(),
    /** Factory I/O Web API tag id, when Developer 1 has captured it. */
    webApiId: z.string().optional(),
  })
  .strict();
export type SceneTag = z.infer<typeof SceneTag>;

export const FaultScenario = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    kind: z.enum(["stuck_on", "stuck_off", "stuck_value"]),
    tag: z.string(),
    value: TagValue,
    description: z.string(),
  })
  .strict();
export type FaultScenario = z.infer<typeof FaultScenario>;

export const SceneDefinition = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    /** Exact scene name as shown in Factory I/O. */
    factoryIoScene: z.string(),
    title: z.string(),
    description: z.string(),
    capabilities: z.array(z.string()),
    tags: z.array(SceneTag).min(1),
    faults: z.array(FaultScenario).default([]),
    /** Simulator preparation around a test suite, e.g. stop the pre-forced box Emitter and reset the scene so
     *  tests are driven only by their own stimuli; restored afterwards. Tags here may be outside `tags`. */
    setup: z
      .object({
        beforeTests: z.array(z.object({ op: z.enum(["force", "release", "pulse"]), tag: z.string(), kind: z.enum(["Input", "Output"]), value: TagValue.optional(), ms: z.number().optional() }).strict()).default([]),
        afterTests: z.array(z.object({ op: z.enum(["force", "release", "pulse"]), tag: z.string(), kind: z.enum(["Input", "Output"]), value: TagValue.optional(), ms: z.number().optional() }).strict()).default([]),
      })
      .strict()
      .default({ beforeTests: [], afterTests: [] }),
    timing: z
      .object({
        /** How often the validator samples tags during a test. */
        samplePeriodMs: z.number().int().min(10).max(1000).default(50),
        /** Time to let the scene settle after deploy/reset before a test starts. */
        settleMs: z.number().int().min(0).default(1500),
      })
      .strict()
      .default({ samplePeriodMs: 50, settleMs: 1500 }),
    /** True only after Developer 1 confirmed every address on the live rig. Unverified scenes are BLOCKED for validation. */
    verified: z.boolean().default(false),
    verifiedBy: z.string().optional(),
    verifiedAt: z.string().optional(),
  })
  .strict();
export type SceneDefinition = z.infer<typeof SceneDefinition>;

// ---------------------------------------------------------------------------------------------
// Requirements: the agent's structured reading of a natural-language specification.
// ---------------------------------------------------------------------------------------------

export const RequirementKind = z.enum([
  "start_stop", // a start command runs actuators, a stop command stops them; stop dominates
  "run_until_sensor", // an actuator runs until a sensor detects a part
  "sensor_actuator", // when a sensor changes, an actuator follows (optionally after a delay)
  "interlock", // an actuator must be off while a condition holds (e.g. downstream blocked)
  "timer_timeout", // a sensor stuck in one state longer than T raises a fault (jam detection)
  "fault_latch", // a fault indication stays latched after the cause clears, until reset
  "reset_precondition", // reset only clears a fault once its cause is gone
  "no_auto_restart", // after a stop or fault reset, actuators need a new start command
  "sequence", // actuators step through an ordered sequence
  "counter", // count parts and act after N
  "sorting", // route parts to outputs based on sensor classification
  "mode", // manual / automatic modes
  "estop", // emergency stop de-energizes all actuators
  "indicator", // lights reflect machine state
  "other",
]);
export type RequirementKind = z.infer<typeof RequirementKind>;

export const Requirement = z
  .object({
    /** Stable id: R1, R2, ... (stable across spec revisions when the requirement text is unchanged). */
    id: z.string().regex(/^R\d+$/),
    kind: RequirementKind,
    text: z.string().min(1),
    /** Abstract roles named in the spec, e.g. { start: "start button", motor: "upstream conveyor" }. */
    roles: z.record(z.string(), z.string()),
    /** Numeric/boolean parameters, e.g. { timeoutMs: 5000, count: 10 }. */
    params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}),
  })
  .strict();
export type Requirement = z.infer<typeof Requirement>;

export const ControlRequirements = z
  .object({
    summary: z.string(),
    equipment: z.array(z.string()),
    operatingStates: z.array(z.string()),
    requirements: z.array(Requirement).min(1),
    /** Anything the spec asks for that is not a testable control requirement. */
    notes: z.array(z.string()).default([]),
  })
  .strict();
export type ControlRequirements = z.infer<typeof ControlRequirements>;

/** A requirement after matching its roles to real scene tags. */
export const BoundRequirement = Requirement.extend({
  /** role -> exact scene tag name */
  bindings: z.record(z.string(), z.string()),
  support: z.enum(["supported", "unsupported"]),
  unsupportedReason: z.string().optional(),
});
export type BoundRequirement = z.infer<typeof BoundRequirement>;

export interface IoPoint {
  variable: string; // ST identifier, e.g. "S_AtExit"
  tag: string; // scene tag name
  address: string; // %IX100.0
  dataType: "BOOL" | "INT" | "REAL";
  role: "sensor" | "actuator";
  activeLow: boolean;
  comment: string;
}

// ---------------------------------------------------------------------------------------------
// Harness configuration: the versioned document the meta-harness evolves.
// .strict() everywhere: a proposal cannot smuggle in fields (e.g. "skip_tests") the schema lacks.
// ---------------------------------------------------------------------------------------------

export const ModelTier = z.enum(["fast", "strong"]);
export type ModelTier = z.infer<typeof ModelTier>;
export const Verdict = z.enum(["kept", "pending", "rolled_back", "rejected"]);
export type Verdict = z.infer<typeof Verdict>;

export const HarnessBody = z
  .object({
    /** Engineering rules given to the code generator and repairer before they write code. Append-only. */
    rules: z.array(z.string().min(8).max(400)).max(24),
    context: z
      .object({
        lessons_k: z.number().int().min(0).max(8),
        retrieve_similar_failures: z.boolean(),
        failures_k: z.number().int().min(0).max(5),
        include_previous_attempt: z.boolean(),
      })
      .strict(),
    workflow: z
      .object({
        state_machine_before_code: z.boolean(),
        preflight_compile: z.boolean(),
        repair_budget: z.number().int().min(1).max(5),
        module_split_threshold: z.number().int().min(3).max(20),
        /** Immutable: regression tests always run. Kept in the document so the guardrail is visible. */
        run_regression_tests: z.literal(true),
      })
      .strict(),
    repair: z
      .object({
        strategy: z.enum(["full_rewrite", "targeted_patch"]),
        isolate_failing_requirements: z.boolean(),
      })
      .strict(),
    routing: z
      .object({
        requirements: ModelTier,
        codegen: ModelTier,
        critic: ModelTier,
        repair: ModelTier,
        /** Switch the repairer to the strong tier after this many failed repairs on one project (0 = never). */
        escalate_after_failures: z.number().int().min(0).max(5),
      })
      .strict(),
  })
  .strict();
export type HarnessBody = z.infer<typeof HarnessBody>;

export const HarnessScores = z
  .object({
    cases: z.number().int(),
    requirement_satisfaction: z.number(), // mean share of validated requirements with passing evidence
    safety_pass_rate: z.number(), // share of hidden safety tests passed
    compile_first_try: z.number(), // share of cases whose first program compiled
    test_pass_rate: z.number(), // share of all executed tests passed
    repairs_per_case: z.number(),
    cost_usd_per_case: z.number(),
    seconds_per_case: z.number(),
    tests_blocked: z.number().int().optional(), // tests with no evidence (counted as NOT passed in test_pass_rate)
  })
  .strict();
export type HarnessScores = z.infer<typeof HarnessScores>;

export interface HarnessConfig extends HarnessBody {
  version: number;
  parent: number | null;
  verdict: Verdict;
  rationale: string;
  /** Real evidence the proposal was grounded in (Atlas run ids, Raindrop event ids). */
  evidence?: { runIds: string[]; testResultIds: string[]; raindropEventIds: string[] };
  scores?: HarnessScores;
  parentScores?: HarnessScores;
  gateNote?: string;
  createdAt: string;
  decidedAt?: string;
}

// ---------------------------------------------------------------------------------------------
// Independent tests. Steps are data so the same plan is auditable, re-runnable and re-gradable
// from stored measurements.
// ---------------------------------------------------------------------------------------------

export type TestStep =
  /** Press a button: drive the input to its active level for holdMs, then release (activeLow-aware). */
  | { op: "press"; tag: string; holdMs: number }
  /** Activate an input until a later `release`: press a button / block a photo-eye (activeLow-aware). */
  | { op: "hold"; tag: string }
  /** Hold a sensor at a value (a part in front of a photo-eye, a stuck sensor). */
  | { op: "force"; tag: string; value: TagValue }
  | { op: "release"; tag: string }
  | { op: "wait"; ms: number }
  /** The tag must reach `value` within `withinMs`. */
  | { op: "expect"; tag: string; value: TagValue; withinMs: number; label: string }
  /** The tag must hold `value` for the whole window. */
  | { op: "expectStable"; tag: string; value: TagValue; forMs: number; label: string };

export const TestCategory = z.enum([
  "start_stop",
  "sensor_transition",
  "interlock",
  "timer",
  "state_transition",
  "fault_detection",
  "fault_latch",
  "reset_condition",
  "recovery",
  "safety",
]);
export type TestCategory = z.infer<typeof TestCategory>;

export interface TestCase {
  id: string;
  title: string;
  category: TestCategory;
  /** public tests are described to the agent; hidden tests never reach any agent. */
  visibility: "public" | "hidden";
  requirementIds: string[];
  /** Tags sampled during the test (sensors and actuators it touches). */
  observe: string[];
  steps: TestStep[];
}

export interface Sample {
  t: number; // ms since test start
  values: Record<string, TagValue>;
}

export interface StepLog {
  index: number;
  op: TestStep["op"];
  startedAt: number; // ms since test start
  endedAt: number;
  error?: string;
}

export interface AssertionResult {
  stepIndex: number;
  label: string;
  passed: boolean;
  detail: string;
  /** Sample time at which the assertion was satisfied or first violated. */
  atMs?: number;
}

export type TestVerdict = "passed" | "failed" | "blocked";

export interface TestResult {
  testId: string;
  title: string;
  category: TestCategory;
  visibility: "public" | "hidden";
  requirementIds: string[];
  verdict: TestVerdict;
  assertions: AssertionResult[];
  /** Why the test could not run (rig disconnected, scene unverified, ...). Never a pass. */
  blockedReason?: string;
  durationMs: number;
  sampleCount: number;
}

export type RequirementStatus = "verified" | "failed" | "unsupported" | "blocked" | "untested";

export interface RequirementVerdict {
  requirementId: string;
  status: RequirementStatus;
  testIds: string[];
  detail: string;
}

// ---------------------------------------------------------------------------------------------
// Jobs: what the dashboard asks the worker to do (the only collection the web app writes).
// ---------------------------------------------------------------------------------------------

export const JobType = z.enum(["engineer", "fault_and_improve", "evolve", "benchmark", "ablation", "spec_change", "worker_command"]);
export type JobType = z.infer<typeof JobType>;
export const JobStatus = z.enum(["queued", "running", "verifying", "completed", "failed", "blocked", "interrupted"]);
export type JobStatus = z.infer<typeof JobStatus>;

export interface JobRequest {
  type: JobType;
  specText?: string;
  sceneId?: string;
  projectId?: string;
  faultId?: string;
  /** "example" when launched from the Run Example button (same pipeline, prewritten spec). */
  origin: "custom" | "example" | "script";
  /** worker_command only: "interrupt" is handled by the worker, "resume" by the launcher. */
  command?: "interrupt" | "resume";
}

export type PipelineStage =
  | "requirements"
  | "io_design"
  | "state_machine"
  | "plc_code"
  | "preflight"
  | "compile"
  | "deploy"
  | "simulate"
  | "tests"
  | "diagnosis"
  | "repair"
  | "verification"
  | "deliver";

export const PIPELINE_STAGES: PipelineStage[] = [
  "requirements",
  "io_design",
  "state_machine",
  "plc_code",
  "preflight",
  "compile",
  "deploy",
  "simulate",
  "tests",
  "diagnosis",
  "repair",
  "verification",
  "deliver",
];
