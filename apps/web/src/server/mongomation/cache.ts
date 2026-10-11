// Every viewer polls the same reads every 1.5-5 s. A short shared cache (per server process) collapses
// N viewers into ~1 Atlas round per query per second, which matters on a rate-limited sandbox cluster.
// Concurrent callers share one in-flight read. Responses report `cacheAgeMs` so the client can keep
// "x s ago" values exact (it adds that lag to the server-computed ages).
const DEFAULT_TTL_MS = 1000;
const MAX_ENTRIES = 300;

interface Entry {
  promise: Promise<object>;
  /** When the read finished (undefined while in flight). */
  resolvedAt?: number;
}

const entries = new Map<string, Entry>();

function evict(now: number, ttlMs: number) {
  for (const [key, e] of entries) {
    if (e.resolvedAt !== undefined && now - e.resolvedAt >= ttlMs) entries.delete(key);
  }
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

export async function cached<T extends object>(key: string, read: () => Promise<T>, ttlMs = DEFAULT_TTL_MS): Promise<T & { cacheAgeMs: number }> {
  const now = Date.now();
  let entry = entries.get(key);
  if (!entry || (entry.resolvedAt !== undefined && now - entry.resolvedAt >= ttlMs)) {
    evict(now, ttlMs);
    const fresh = {} as Entry;
    fresh.promise = read().then(
      (value) => {
        fresh.resolvedAt = Date.now();
        return value;
      },
      (err: unknown) => {
        if (entries.get(key) === fresh) entries.delete(key);
        throw err;
      }
    );
    entries.set(key, fresh);
    entry = fresh;
  }
  const value = (await entry.promise) as T;
  const cacheAgeMs = entry.resolvedAt === undefined ? 0 : Math.max(0, Date.now() - entry.resolvedAt);
  return { ...value, cacheAgeMs };
}

/** Drops cached reads whose key starts with `prefix` (all when omitted), e.g. after a job was queued. */
export function invalidate(prefix = ''): void {
  for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key);
}
