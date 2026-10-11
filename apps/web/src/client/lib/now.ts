import { useSyncExternalStore } from 'react';

// One shared 1 s ticker for every live "age" on screen. Ages are computed as
// (server-computed age at query time) + (time since that response arrived), so a stalled
// connection makes them keep growing instead of freezing at a reassuring value.
const listeners = new Set<() => void>();
let current = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    current = Date.now();
    timer = setInterval(() => {
      current = Date.now();
      listeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useNow(): number {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => current
  );
}

export function liveAge(ageMs: number | undefined, receivedAt: number, now: number): number | undefined {
  if (ageMs === undefined) return undefined;
  return ageMs + Math.max(0, now - receivedAt);
}
