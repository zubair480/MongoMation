// Active Modbus link readiness probe (replaces a blind fixed sleep after every upload).
// On the rig, Factory I/O is the Modbus CLIENT of OpenPLC and reconnects on its own schedule after each upload
// (measured 6.5 s .. >75 s). Until it has reconnected the PLC reads every input as FALSE (so normally-closed Stop /
// E-stop look PRESSED) and Factory I/O shows stale outputs, so any test would grade a dead link.
// The harness therefore appends a heartbeat to every generated program (pipeline/st.ts):
//   Counter (%QW0) := scanCounter * 2 + (first normally-closed input ? 1 : 0)
// and after start() we poll Factory I/O until the Counter has changed twice (PLC -> Factory I/O path) and its
// parity equals Factory I/O's own value of that NC input (Factory I/O -> PLC path).
import { setTimeout as delay } from "node:timers/promises";

export const HEARTBEAT_MARK = "MM_HEARTBEAT";

export interface Heartbeat {
  counterTag: string; // scene tag of the %QW0 output (e.g. "Counter")
  ncTag?: string; // scene tag of the NC input folded into the parity bit
}

/** Reads the heartbeat descriptor the harness wrote into the program, or null (then the caller keeps the fixed wait). */
export function parseHeartbeat(source: string): Heartbeat | null {
  const m = source.match(/\(\*\s*MM_HEARTBEAT counter="([^"]+)"(?: nc="([^"]+)")?\s*\*\)/);
  return m ? { counterTag: m[1], ...(m[2] ? { ncTag: m[2] } : {}) } : null;
}

export class LinkDownError extends Error {}

type Reader = { read(tags: string[]): Promise<Record<string, boolean | number>> };

export async function awaitLink(
  sim: Reader,
  hb: Heartbeat,
  opts: { timeoutMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<unknown> } = {},
): Promise<{ ms: number; polls: number }> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? delay;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const pollMs = opts.pollMs ?? 500;
  const t0 = now();
  const tags = hb.ncTag ? [hb.counterTag, hb.ncTag] : [hb.counterTag];
  let prev: number | undefined;
  let changes = 0;
  let polls = 0;
  let last = "no reading yet";
  while (now() - t0 <= timeoutMs) {
    polls++;
    try {
      const v = await sim.read(tags);
      const c = Number(v[hb.counterTag]);
      if (prev !== undefined && c !== prev) changes++;
      prev = c;
      const parityOk = !hb.ncTag || c % 2 === (v[hb.ncTag] ? 1 : 0);
      last = `Counter=${c} changes=${changes}${hb.ncTag ? ` ${hb.ncTag}=${v[hb.ncTag]} parity ${parityOk ? "ok" : "mismatch"}` : ""}`;
      if (changes >= 2 && parityOk) return { ms: now() - t0, polls };
    } catch (e) {
      last = `read error: ${(e as Error).message.slice(0, 120)}`;
    }
    await sleep(pollMs);
  }
  throw new LinkDownError(`modbus link not re-established within ${Math.round(timeoutMs / 1000)} s after start (${last})`);
}
