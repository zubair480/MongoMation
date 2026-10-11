// Shared "a sim run is sampling right now" flag. pipeline/validate.ts should raise it (try/finally) around each executeTest() (the window in
// which the test harness issues its own sim.read() requests); the rig monitor's fast tag loop in main.ts pauses its
// Factory I/O reads while it is up, so the two never compete for the Factory I/O web API. A counter, not a bool,
// so overlapping runs (should they ever happen) cannot clear each other's window.
let depth = 0;

export function setSampling(on: boolean): void {
  depth = on ? depth + 1 : Math.max(0, depth - 1);
}

export function isSampling(): boolean {
  return depth > 0;
}
