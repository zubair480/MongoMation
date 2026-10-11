import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { Document } from "mongodb";
import { insertRepairVersion, type PlcVersionStore } from "../src/pipeline/fault.ts";

/** In-memory plc_versions with the real unique {projectId, version} index behaviour (E11000 on a clash). */
function fakeStore(seed: Document[] = []) {
  const rows = [...seed];
  const store: PlcVersionStore & { rows: Document[]; beforeInsert?: () => void } = {
    rows,
    async findOne(filter) {
      const mine = rows.filter((r) => r.projectId === filter.projectId).sort((a, b) => b.version - a.version);
      return mine[0] ?? null;
    },
    async insertOne(doc) {
      store.beforeInsert?.();
      if (rows.some((r) => r.projectId === doc.projectId && r.version === doc.version)) throw Object.assign(new Error(`E11000 duplicate key { projectId, version: ${doc.version} }`), { code: 11000 });
      rows.push(doc);
      return { insertedId: `id${rows.length}` };
    },
  };
  return store;
}

describe("fault repair version allocation", () => {
  it("two fault repairs on one project get distinct versions (1003, then 1004) instead of E11000", async () => {
    const store = fakeStore([{ projectId: "p1", version: 1 }, { projectId: "p1", version: 2 }, { projectId: "p1", version: 3 }, { projectId: "other", version: 5000 }]);
    const a = await insertRepairVersion(store, "p1", 3, { createdBy: "repair", reason: "fault f1" });
    const b = await insertRepairVersion(store, "p1", 3, { createdBy: "repair", reason: "fault f2" });
    assert.equal(a.version, 1003);
    assert.equal(b.version, 1004);
    assert.notEqual(a.insertedId, b.insertedId);
    assert.deepEqual(store.rows.filter((r) => r.projectId === "p1").map((r) => r.version), [1, 2, 3, 1003, 1004]);
  });

  it("a repair of a fixed repair (base 1003) moves to the next band", async () => {
    const store = fakeStore([{ projectId: "p1", version: 3 }, { projectId: "p1", version: 1003 }]);
    assert.equal((await insertRepairVersion(store, "p1", 1003, {})).version, 2003);
  });

  it("retries once when a concurrent writer takes the number first", async () => {
    const store = fakeStore([{ projectId: "p1", version: 3 }]);
    let raced = false;
    store.beforeInsert = () => {
      if (!raced) (raced = true), store.rows.push({ projectId: "p1", version: 1003 });
    };
    assert.equal((await insertRepairVersion(store, "p1", 3, {})).version, 1004);
  });

  it("does not swallow non-duplicate errors", async () => {
    const store = fakeStore();
    store.beforeInsert = () => { throw Object.assign(new Error("network"), { code: 6 }); };
    await assert.rejects(insertRepairVersion(store, "p1", 3, {}), /network/);
  });
});
