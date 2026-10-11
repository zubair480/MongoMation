import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { BoundRequirement, IoPoint } from "@mongomation/types";
import { buildVerifiedProgram, findSpecProgram, ioMapVersion, normalizeSpec, programsValidator, requirementFingerprint, specHash, type ExactProgram, type ProgramRetrieval } from "../src/harness/programs.ts";
import { decideRecall, decideSpecRecall, logicFromSource, recallEnabled, recallSkipped, reproducesVerbatim, trustEnabled, type RecallStore } from "../src/harness/recall.ts";
import { assembleProgram, type GeneratedLogic } from "../src/pipeline/st.ts";

const ENV = ["MEMORY_PROGRAMS", "RECALL_TRUST", "FASTPATH_TRUST", "RECALL_NEAR_SCORE"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
beforeEach(() => ENV.forEach((k) => delete process.env[k]));
afterEach(() => ENV.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))));

const R = (over: Partial<BoundRequirement> = {}) =>
  ({ id: "R1", kind: "start_stop", text: "Start runs the line", roles: {}, params: { timeoutMs: 5000 }, bindings: { start: "Start", stop: "Stop", motor: "Conveyor" }, support: "supported", ...over }) as BoundRequirement;
const reqs = [R(), R({ id: "R2", kind: "estop", text: "E-stop stops all", params: {}, bindings: { estop: "Emergency stop" } })];

describe("experience recall: requirement fingerprint", () => {
  it("is deterministic and insensitive to requirement order, ids, texts and binding key order", () => {
    const a = requirementFingerprint("sorting", reqs);
    const reordered = [{ ...reqs[1], id: "R7", text: "different words" }, { ...reqs[0], bindings: { motor: "Conveyor", stop: "Stop", start: "Start" } }];
    assert.equal(requirementFingerprint("sorting", reordered), a);
    assert.equal(requirementFingerprint("sorting", reqs), a);
    // free-text params and numeric strings: wording drift does not change the key
    assert.equal(requirementFingerprint("sorting", [R({ params: { timeoutMs: "5000", note: "any words" } as never }), reqs[1]]), a);
    assert.match(a, /^fp3:[0-9a-f]{64}$/);
  });
  it("changes with the scene, a bound I/O tag, a role, a parameter value, or the kind", () => {
    const a = requirementFingerprint("sorting", reqs);
    const variants = [
      requirementFingerprint("two-conveyors", reqs),
      requirementFingerprint("sorting", [R({ bindings: { start: "Start", stop: "Stop", motor: "Conveyor 2" } }), reqs[1]]),
      requirementFingerprint("sorting", [R({ bindings: { start: "Start", halt: "Stop", motor: "Conveyor" } }), reqs[1]]),
      requirementFingerprint("sorting", [R({ params: { timeoutMs: 6000 } }), reqs[1]]),
      requirementFingerprint("sorting", [R({ params: { timeoutMs: 5000, count: 3 } }), reqs[1]]),
      requirementFingerprint("sorting", [R({ kind: "sequence" as BoundRequirement["kind"] }), reqs[1]]),
      requirementFingerprint("sorting", [reqs[0]]),
    ];
    for (const v of variants) assert.notEqual(v, a);
    assert.equal(new Set(variants).size, variants.length);
  });
  it("is stored on verified programs, which still hold only test COUNTS (never test definitions)", () => {
    const doc = buildVerifiedProgram({ projectId: "p1", sceneId: "sorting", specText: "s", requirements: reqs, stSource: "X", plcVersionId: "v1", run: { passed: 9, failed: 0, blocked: 0 }, harnessVersion: 3 });
    assert.equal(doc.fingerprint, requirementFingerprint("sorting", reqs));
    assert.deepEqual(Object.keys(doc.tests).sort(), ["passed", "total"]);
    assert.ok(!/hidden|testId|expect/i.test(JSON.stringify(doc)));
    assert.ok("fingerprint" in programsValidator.$jsonSchema.properties);
  });
});

const io: IoPoint[] = [
  { variable: "I_Start", tag: "Start", address: "%IX100.0", dataType: "BOOL", role: "sensor", activeLow: false, comment: "Start" },
  { variable: "I_Stop", tag: "Stop", address: "%IX100.1", dataType: "BOOL", role: "sensor", activeLow: true, comment: "Stop (active-low)" },
  { variable: "Q_Conveyor", tag: "Conveyor", address: "%QX100.0", dataType: "BOOL", role: "actuator", activeLow: false, comment: "Conveyor" },
  { variable: "Q_Counter", tag: "Counter", address: "%QW0", dataType: "INT", role: "actuator", activeLow: false, comment: "Counter" },
];
const logic: GeneratedLogic = {
  variables: [
    { name: "Running", type: "BOOL", initial: "FALSE", comment: "latched run" },
    { name: "T1", type: "TON" },
  ],
  body: "IF I_Start AND I_Stop THEN\n  Running := TRUE;\nEND_IF;\nIF NOT I_Stop THEN\n  Running := FALSE;\nEND_IF;\nQ_Conveyor := Running;",
};
const source = assembleProgram(io, logic, "MongoMation src v3").source;

describe("experience recall: verbatim reuse of a harness-assembled program", () => {
  it("parses the program back and re-assembles it byte for byte (header aside, heartbeat re-added by the harness)", () => {
    const parsed = logicFromSource(source)!;
    assert.ok(parsed);
    assert.equal(parsed.body, logic.body);
    assert.deepEqual(parsed.variables.map((v) => v.name), ["Running", "T1"]);
    assert.ok(reproducesVerbatim(io, parsed, source));
  });
  it("refuses reuse when the I/O map differs (not verbatim)", () => {
    const parsed = logicFromSource(source)!;
    assert.equal(reproducesVerbatim(io.map((p) => (p.tag === "Conveyor" ? { ...p, address: "%QX100.3" } : p)), parsed, source), false);
    assert.equal(logicFromSource("PROGRAM x\nEND_PROGRAM"), null);
  });
});

const exactDoc: ExactProgram = { projectId: "src1", sceneId: "sorting", fingerprint: "fp", stSource: source, plcVersionId: "v9", tests: { passed: 12, total: 12 }, verifiedAt: new Date("2026-10-11T20:00:00Z"), planHash: "plan1" };
const retrieval = (score: number | null): ProgramRetrieval =>
  score === null ? { memoryUsed: false, hits: [], retrievalMs: 3, references: [] } : { memoryUsed: true, hits: [{ projectId: "near1", score }], retrievalMs: 3, via: "rank", references: [{ projectId: "near1", score, specText: "s", requirementsSummary: "r", stSource: "X", tests: { passed: 5, total: 5 } }] };
const fakeStore = (o: { exact?: ExactProgram | null; spec?: ExactProgram | null; specs?: ExactProgram[]; score?: number | null; prior?: number; buildMs?: Record<string, number> }): RecallStore & { retrieveCalls: number; buildMsAsked: string[] } => {
  const s = {
    retrieveCalls: 0,
    buildMsAsked: [] as string[],
    findExact: async () => o.exact ?? null,
    findSpec: async () => o.specs ?? (o.spec ? [o.spec] : []),
    retrieve: async () => (s.retrieveCalls++, retrieval(o.score ?? null)),
    priorRuns: async () => o.prior ?? 0,
    sourceBuildMs: async (pid: string) => (s.buildMsAsked.push(pid), o.buildMs?.[pid] ?? 600_000),
  };
  return s;
};
const decide = (store: RecallStore, trust?: boolean, planHash = "plan1") => decideRecall({ sceneId: "sorting", fingerprint: "fp", query: "q", projectId: "me", io, store, trust, threshold: 0.025, planHash });

describe("experience recall: branching", () => {
  it("EXACT: same fingerprint + scene reuses the verified program, no search, confirmation still required", async () => {
    const store = fakeStore({ exact: exactDoc, score: 0.03, prior: 4 });
    const d = await decide(store);
    assert.equal(d.kind, "exact");
    assert.equal(d.sourceProjectId, "src1");
    assert.equal(d.runIndex, 4);
    assert.equal(d.sourceBuildMs, 600_000);
    assert.equal(store.retrieveCalls, 0);
    assert.deepEqual(d.logic?.variables.map((v) => v.name), ["Running", "T1"]);
    assert.ok(recallSkipped("exact").every((x) => !/test/.test(x) || /unless/.test(x)), "exact never skips the confirmation tests");
  });
  it("TRUSTED only with the trust flag; it says it skipped the rig tests", async () => {
    const d = await decide(fakeStore({ exact: exactDoc }), true);
    assert.equal(d.kind, "trusted");
    assert.ok(recallSkipped("trusted").includes("rig confirmation tests"));
  });
  it("an exact hit that does not re-assemble verbatim is NOT reused (falls to near/none)", async () => {
    const d = await decide(fakeStore({ exact: { ...exactDoc, stSource: "garbage" }, score: null }));
    assert.equal(d.kind, "none");
    assert.match(d.reason, /not reused/);
  });
  it("NEAR when the best hybrid score reaches the threshold; NONE below it or with no hits", async () => {
    const near = await decide(fakeStore({ score: 0.0328 }));
    assert.equal(near.kind, "near");
    assert.equal(near.sourceProjectId, "near1");
    assert.equal((await decide(fakeStore({ score: 0.016 }))).kind, "none");
    const none = await decide(fakeStore({ score: null }));
    assert.equal(none.kind, "none");
    assert.equal(none.sourceProjectId, null);
  });
});

describe("experience recall: flags", () => {
  it("trust is OFF by default; RECALL_TRUST=1 (or FASTPATH_TRUST=1) turns it on", () => {
    assert.equal(trustEnabled(), false);
    process.env.RECALL_TRUST = "1";
    assert.equal(trustEnabled(), true);
    delete process.env.RECALL_TRUST;
    process.env.FASTPATH_TRUST = "true";
    assert.equal(trustEnabled(), true);
  });
  it("recall follows program memory unless the job option says otherwise (cold --no-memory runs stay cold)", () => {
    assert.equal(recallEnabled(), false);
    assert.equal(recallEnabled(undefined, true), true);
    assert.equal(recallEnabled(undefined, false), false);
    process.env.MEMORY_PROGRAMS = "1";
    assert.equal(recallEnabled(), true);
    assert.equal(recallEnabled(undefined, false), false);
    assert.equal(recallEnabled(false, true), false);
    assert.equal(recallEnabled(true, false), true);
  });
});

describe("experience recall: fp3 keeps the params the validator keys on", () => {
  const lamp = (when: string) => R({ id: "L1", kind: "indicator" as BoundRequirement["kind"], params: { when }, bindings: { lamp: "Light" } });
  it("a run-lamp and a fault-lamp on the same tag get different fingerprints", () => {
    assert.notEqual(requirementFingerprint("sorting", [lamp("running")]), requirementFingerprint("sorting", [lamp("fault")]));
    assert.equal(requirementFingerprint("sorting", [lamp("Running ")]), requirementFingerprint("sorting", [lamp("running")]));
  });
  it("boolean actuatorValue / classifierValue are part of the key (string 'false' == false); free text is not", () => {
    const a = (p: Record<string, unknown>) => requirementFingerprint("sorting", [R({ params: { timeoutMs: 5000, ...p } as never })]);
    assert.notEqual(a({ actuatorValue: false }), a({ actuatorValue: true }));
    assert.notEqual(a({ classifierValue: false }), a({}));
    assert.equal(a({ classifierValue: "false" }), a({ classifierValue: false }));
    assert.equal(a({ note: "anything" }), a({}));
  });
});

describe("experience recall: trust requires the same test plan", () => {
  it("RECALL_TRUST with a different or missing planHash is downgraded to an exact confirmation pass", async () => {
    const d = await decide(fakeStore({ exact: exactDoc }), true, "other-plan");
    assert.equal(d.kind, "exact");
    assert.equal(d.trustDowngraded, true);
    assert.equal((await decide(fakeStore({ exact: { ...exactDoc, planHash: undefined } }), true)).kind, "exact");
  });
  it("msSaved follows lineage to the original non-recall build", async () => {
    const store = fakeStore({ exact: { ...exactDoc, originProjectId: "origin0" }, buildMs: { origin0: 900_000 } });
    const d = await decide(store);
    assert.equal(d.sourceBuildMs, 900_000);
    assert.deepEqual(store.buildMsAsked, ["origin0"]);
  });
  it("a recall run's verified copy is tagged with the original build", () => {
    const vp = buildVerifiedProgram({ projectId: "p2", sceneId: "sorting", specText: "s", requirements: reqs, stSource: source, plcVersionId: "v1", run: { passed: 3, failed: 0, blocked: 0 }, harnessVersion: 1, originProjectId: "origin0" });
    assert.equal(vp.originProjectId, "origin0");
    assert.equal(buildVerifiedProgram({ projectId: "p3", sceneId: "sorting", specText: "s", requirements: reqs, stSource: source, plcVersionId: "v1", run: { passed: 3, failed: 0, blocked: 0 }, harnessVersion: 1 }).originProjectId, "p3");
  });
});

const scene = { id: "sorting", tags: [{ name: "Start", plcAddress: "%IX100.0", kind: "pushbutton", activeLow: false }, { name: "Conveyor", plcAddress: "%QX100.0", kind: "conveyor", activeLow: false }] } as never;
describe("spec-level exact recall: specHash", () => {
  it("normalizes whitespace, case and surrounding space; changes with text, scene or I/O map", () => {
    assert.equal(normalizeSpec("  Start the\n\tConveyor   NOW "), "start the conveyor now");
    const h = specHash("Start the conveyor.\nStop on E-stop.", scene);
    assert.match(h, /^sh1:[0-9a-f]{64}$/);
    assert.equal(specHash("  start THE conveyor.   stop on e-stop. ", scene), h);
    assert.notEqual(specHash("Start the conveyor. Stop on E-stop!", scene), h);
    assert.notEqual(specHash("Start the conveyor.\nStop on E-stop.", { ...(scene as object), id: "other" } as never), h);
    const moved = { id: "sorting", tags: [{ name: "Start", plcAddress: "%IX100.1", kind: "pushbutton", activeLow: false }, { name: "Conveyor", plcAddress: "%QX100.0", kind: "conveyor", activeLow: false }] } as never;
    assert.notEqual(ioMapVersion(moved), ioMapVersion(scene));
    assert.notEqual(specHash("Start the conveyor.\nStop on E-stop.", moved), h);
  });
});

const replay = { requirements: { summary: "s", requirements: [] }, bound: reqs, io };
const specDoc: ExactProgram = { ...exactDoc, projectId: "cold1", specHash: "sh1:x", replay };
const decideSpec = (store: RecallStore, trust?: boolean, plan = "plan1") => decideSpecRecall({ sceneId: "sorting", specHash: "sh1:x", projectId: "me", store, trust, planHashOf: () => plan });
describe("spec-level exact recall: branching", () => {
  it("EXACT-SPEC: replays requirements, I/O and program of the source; no search; says it skipped the Claude stages", async () => {
    const store = fakeStore({ spec: specDoc, score: 0.03, prior: 2 });
    const d = (await decideSpec(store))!;
    assert.equal(d.kind, "exact-spec");
    assert.equal(d.sourceProjectId, "cold1");
    assert.deepEqual(d.replay, replay);
    assert.equal(d.fingerprint, requirementFingerprint("sorting", reqs));
    assert.equal(d.runIndex, 2);
    assert.equal(store.retrieveCalls, 0);
    const sk = recallSkipped("exact-spec");
    assert.ok(sk.includes("requirements extraction (Claude)") && sk.includes("I/O binding (Claude)") && sk.includes("Claude codegen"));
    assert.ok(sk.every((x) => !/test/.test(x) || /unless/.test(x)), "exact-spec never skips the confirmation tests");
  });
  it("TRUSTED-SPEC only with trust AND a matching plan hash", async () => {
    assert.equal((await decideSpec(fakeStore({ spec: specDoc }), true))!.kind, "trusted-spec");
    const down = (await decideSpec(fakeStore({ spec: specDoc }), true, "changed"))!;
    assert.equal(down.kind, "exact-spec");
    assert.equal(down.trustDowngraded, true);
    assert.ok(recallSkipped("trusted-spec").includes("rig confirmation tests"));
  });
  it("falls back to the fingerprint tier: no spec hit, no replay, or a non-verbatim program -> null", async () => {
    assert.equal(await decideSpec(fakeStore({})), null);
    assert.equal(await decideSpec(fakeStore({ spec: { ...specDoc, replay: undefined } })), null);
    assert.equal(await decideSpec(fakeStore({ spec: { ...specDoc, stSource: "garbage" } })), null);
    // ...and the fingerprint tier then decides as before
    const d = await decide(fakeStore({ exact: exactDoc }));
    assert.equal(d.kind, "exact");
  });
  it("findSpecProgram only returns all-passing docs with a complete replay", async () => {
    const docs = [{ ...specDoc, tests: { passed: 11, total: 12 } }, { ...specDoc, projectId: "noReplay", replay: undefined }, { ...specDoc, projectId: "good" }];
    let q: unknown = null;
    const coll = { find: (f: unknown) => ((q = f), { toArray: async () => docs }) } as never;
    const hit = await findSpecProgram("sorting", "sh1:x", "me", coll);
    assert.equal(hit?.projectId, "good");
    assert.deepEqual(q, { sceneId: "sorting", specHash: "sh1:x", projectId: { $ne: "me" } });
  });
});

describe("spec-level exact recall: candidate preference", () => {
  it("prefers the candidate whose planHash matches this job's plan over a more recent one", async () => {
    const recent = { ...specDoc, projectId: "run2copy", planHash: undefined, verifiedAt: new Date("2026-10-11T22:00:00Z") };
    const cold = { ...specDoc, projectId: "cold1", planHash: "plan1" };
    const d = (await decideSpec(fakeStore({ specs: [recent, cold] }), true))!;
    assert.equal(d.sourceProjectId, "cold1");
    assert.equal(d.kind, "trusted-spec");
    // no plan match anywhere -> most recent usable, confirmation pass
    const e = (await decideSpec(fakeStore({ specs: [recent, cold] }), true, "nomatch"))!;
    assert.equal(e.sourceProjectId, "run2copy");
    assert.equal(e.kind, "exact-spec");
    // a non-verbatim recent candidate is skipped
    const f = (await decideSpec(fakeStore({ specs: [{ ...recent, stSource: "garbage" }, { ...cold, planHash: "x" }] })))!;
    assert.equal(f.sourceProjectId, "cold1");
  });
});
