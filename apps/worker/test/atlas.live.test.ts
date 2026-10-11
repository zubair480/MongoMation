// Live Atlas tests for the data-platform layer. Skipped unless MONGODB_URI is set:
//   node --env-file=.env --import tsx --test apps/worker/test/atlas.live.test.ts
// Writes ONLY to the scratch collection `_txn_selftest` and deletes only the docs it wrote (tagged with `run`).
// Validator probes against real collections run inside a transaction that is always aborted, so nothing persists.
import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import type { ChangeStreamDocument, Document } from "mongodb";
import { transitionDoc } from "../src/harness/jobwatch.ts";

describe("transitionDoc (pure)", () => {
  it("maps a pre/post-image update event to a from->to transition", () => {
    const d = transitionDoc({
      _id: { _data: "8263abc" },
      operationType: "update",
      documentKey: { _id: "j1" },
      fullDocument: { _id: "j1", type: "engineer", status: "running", claimedBy: "w1", attempts: 2 },
      fullDocumentBeforeChange: { _id: "j1", status: "queued" },
      updateDescription: { updatedFields: { status: "running" } },
    });
    assert.equal(d._id, "8263abc");
    assert.deepEqual([d.jobId, d.from, d.to, d.by, d.attempts], ["j1", "queued", "running", "w1", 2]);
  });
  it("an insert has no `from`", () => {
    const d = transitionDoc({ _id: { _data: "x" }, operationType: "insert", fullDocument: { _id: "j2", type: "evolve", status: "queued" } });
    assert.equal(d.from, null);
    assert.equal(d.to, "queued");
  });
});

const live = !!process.env.MONGODB_URI;

describe("Atlas live: transactions, causal sessions, validators, TTL, pre/post images, analytics", { skip: !live && "MONGODB_URI not set" }, () => {
  const run = `selftest-${process.pid}-${Date.now()}`;
  let m: typeof import("../src/db/index.ts");

  before(async () => {
    m = await import("../src/db/index.ts");
    await m.connect();
    if (!(await m.db.listCollections({ name: "_txn_selftest" }, { nameOnly: true }).toArray()).length) await m.db.createCollection("_txn_selftest");
  });
  after(async () => {
    await m.db.collection("_txn_selftest").deleteMany({ run });
    await m.client.close();
  });

  it("withTxnRetry commits two writes atomically", async () => {
    const s = m.db.collection("_txn_selftest");
    const ids = await m.withTxnRetry(async (session) => {
      const a = await s.insertOne({ run, k: "a" }, { session });
      const b = await s.insertOne({ run, k: "b", ref: a.insertedId }, { session });
      return [a.insertedId, b.insertedId];
    });
    assert.equal(await s.countDocuments({ run, _id: { $in: ids } }), 2);
  });

  it("an error inside the transaction aborts every write in it", async () => {
    const s = m.db.collection("_txn_selftest");
    await assert.rejects(
      m.withTxnRetry(async (session) => {
        await s.insertOne({ run, k: "doomed" }, { session });
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(await s.countDocuments({ run, k: "doomed" }), 0);
  });

  it("a causally consistent session reads its own majority write", async () => {
    const s = m.db.collection("_txn_selftest");
    const seen = await m.withCausalSession(async (session) => {
      await s.updateOne({ run, k: "causal" }, { $inc: { n: 1 } }, { upsert: true, session });
      return s.findOne({ run, k: "causal" }, { session, readPreference: "secondaryPreferred", ...m.causalRead });
    });
    assert.equal(seen?.n, 1);
  });

  it("server-side validators reject a malformed job and a harness version without regression tests", async () => {
    const session = m.client.startSession();
    try {
      session.startTransaction();
      await assert.rejects(m.col.jobs().insertOne({ type: "engineer", status: "bogus", createdAt: new Date(), run }, { session }), /Document failed validation/);
    } finally {
      await session.abortTransaction().catch(() => {});
    }
    const s2 = m.client.startSession();
    try {
      s2.startTransaction();
      const bad = {
        version: 999_999, parent: 0, verdict: "pending", rationale: "selftest", createdAt: new Date().toISOString(), rules: [],
        context: {}, repair: { strategy: "targeted_patch" }, routing: {},
        workflow: { run_regression_tests: false, repair_budget: 2 },
      };
      await assert.rejects(m.col.harness().insertOne(bad, { session: s2 }), /Document failed validation/);
    } finally {
      await s2.abortTransaction().catch(() => {});
      await s2.endSession();
      await session.endSession();
    }
    assert.equal(await m.col.harness().countDocuments({ version: 999_999 }), 0);
  });

  it("TTL indexes exist on the ephemeral collections and none on evidence", async () => {
    const { TTL } = await import("../src/db/schema.ts");
    for (const [name, field, secs] of TTL) {
      const ix = (await m.db.collection(name).indexes()).find((i) => i.key[field] === 1 && Object.keys(i.key).length === 1);
      assert.equal(ix?.expireAfterSeconds, secs, `${name}.${field}`);
    }
    for (const name of ["test_results", "harness_versions", "sim_runs"]) {
      assert.ok(!(await m.db.collection(name).indexes()).some((i) => i.expireAfterSeconds != null), name);
    }
  });

  it("a change stream with pre/post images delivers the exact before and after of an update", async () => {
    await m.db.command({ collMod: "_txn_selftest", changeStreamPreAndPostImages: { enabled: true } });
    const s = m.db.collection("_txn_selftest");
    const { insertedId } = await s.insertOne({ run, k: "img", status: "queued" });
    const stream = s.watch([{ $match: { operationType: "update", "documentKey._id": insertedId } }], { fullDocument: "required", fullDocumentBeforeChange: "required" });
    const next = (async () => {
      for await (const ch of stream) return ch as ChangeStreamDocument<Document> & { fullDocument: Document; fullDocumentBeforeChange: Document };
    })();
    await new Promise((r) => setTimeout(r, 500)); // let the cursor open
    await s.updateOne({ _id: insertedId }, { $set: { status: "running" } });
    const ch = await Promise.race([next, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no change event in 15 s")), 15_000))]);
    await stream.close();
    assert.equal(ch?.fullDocumentBeforeChange.status, "queued");
    assert.equal(ch?.fullDocument.status, "running");
  });

  it("the hot queue queries are index scans", async () => {
    const { explainQueueQueries } = await import("../../../scripts/atlas-explain.ts");
    for (const e of await explainQueueQueries(m.db)) assert.equal(e.stage, "IXSCAN", `${e.name} uses ${e.stage}`);
  });

  it("time-series analytics run on real measurements", async () => {
    const a = await import("../src/db/analytics.ts");
    const runs = await a.recentRuns(5);
    assert.ok(runs.length > 0, "no measurements in Atlas");
    const sum = await a.runSummary(runs[0]!.simRunId);
    assert.equal(sum.totals?.samples, runs[0]!.samples);
    const testId = sum.perTest[0]!.testId;
    const tag = sum.perTag[0]!.tag;
    const series = await a.signalSeries(runs[0]!.simRunId, testId, tag, 5);
    assert.ok(series.length > 0 && series.every((p) => p.edge === 0 || p.edge === 1));
    const dense = await a.densifiedTimeline(runs[0]!.simRunId, testId, 100, 500);
    assert.ok(dense.length > 0);
    const tags = (await a.tagsOf(runs[0]!.simRunId, testId)).sort();
    for (const p of dense) assert.deepEqual(Object.keys(p.values as Document).sort(), tags); // incl. tags with "." in the name
    const ds = await a.downsample(runs[0]!.simRunId, testId, tag, 10);
    assert.ok(ds.length > 0 && ds.length <= 10);
    const trend = await a.testTrend(testId, 3);
    assert.ok(trend.length > 0);
  });
});
