// One Factory I/O scene + one OpenPLC runtime = one rig. Compile/deploy/simulate must never interleave
// between jobs, so they run under a lease-based lock in Atlas (survives worker crashes: a stale lease expires).
import { setTimeout as sleep } from "node:timers/promises";
import { col } from "../db/index.ts";
import { workerId } from "./jobs.ts";

const LEASE_MS = 20_000;

export async function withRig<T>(rigId: string, holder: string, fn: () => Promise<T>, onWait?: () => Promise<void>): Promise<T> {
  const me = `${workerId()}:${holder}`;
  for (;;) {
    const nowD = new Date();
    try {
      const got = await col.rigLocks().findOneAndUpdate(
        { _id: rigId as never, $or: [{ leaseUntil: { $lt: nowD } }, { holder: me }] },
        { $set: { holder: me, leaseUntil: new Date(Date.now() + LEASE_MS), acquiredAt: nowD } },
        { upsert: true, returnDocument: "after" },
      );
      if (got?.holder === me) break;
    } catch (err) {
      // duplicate key on upsert = someone else holds it
      if (!(err instanceof Error && /E11000/.test(err.message))) throw err;
    }
    await onWait?.();
    await sleep(1000);
  }
  const renew = setInterval(() => {
    void col.rigLocks().updateOne({ _id: rigId as never, holder: me }, { $set: { leaseUntil: new Date(Date.now() + LEASE_MS) } }).catch(() => {});
  }, LEASE_MS / 3);
  try {
    return await fn();
  } finally {
    clearInterval(renew);
    await col.rigLocks().updateOne({ _id: rigId as never, holder: me }, { $set: { leaseUntil: new Date(0) }, $unset: { holder: "" } });
  }
}
