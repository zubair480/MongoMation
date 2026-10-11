import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ClientSession, MongoClient } from "mongodb";
import { withTxn } from "../src/db/index.ts";
import { Wakeup } from "../src/harness/jobwatch.ts";

/** A stand-in session that records what withTxn asked the driver for (no Atlas needed). */
function fakeClient() {
  const calls = { ended: 0, options: undefined as unknown };
  const session = {
    async withTransaction<T>(fn: (s: ClientSession) => Promise<T>, options: unknown) {
      calls.options = options;
      return fn(session as unknown as ClientSession);
    },
    async endSession() {
      calls.ended++;
    },
  };
  return { calls, session, client: { startSession: () => session } as unknown as Pick<MongoClient, "startSession"> };
}

describe("withTxn", () => {
  it("runs the callback in one session with snapshot read + majority commit, and returns its value", async () => {
    const f = fakeClient();
    let seen: unknown;
    const out = await withTxn(async (s) => ((seen = s), 42), f.client);
    assert.equal(out, 42);
    assert.equal(seen, f.session);
    assert.deepEqual(f.calls.options, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary" });
    assert.equal(f.calls.ended, 1);
  });
  it("propagates a failing write (so the driver aborts) and still ends the session", async () => {
    const f = fakeClient();
    await assert.rejects(withTxn(async () => { throw new Error("E11000 duplicate key"); }, f.client), /E11000/);
    assert.equal(f.calls.ended, 1);
  });
});

describe("change-stream wakeup", () => {
  it("fire() ends a pending wait immediately; otherwise the poll timeout ends it", async () => {
    const w = new Wakeup();
    const t0 = Date.now();
    const p = w.wait(5_000);
    w.fire();
    await p;
    assert.ok(Date.now() - t0 < 1_000);
    const t1 = Date.now();
    await w.wait(30);
    assert.ok(Date.now() - t1 >= 25);
  });
});
