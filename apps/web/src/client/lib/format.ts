// Formatting only: every value passed in comes from a query.

export function fmtAge(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 90_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 36 * 3_600_000) return `${Math.round(ms / 3_600_000)} h`;
  return `${Math.round(ms / 86_400_000)} d`;
}

export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function fmtClock(d: Date | undefined, withMs = false): string {
  if (!d) return '—';
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return withMs ? `${base}.${pad(d.getMilliseconds(), 3)}` : base;
}

export function fmtDateTime(d: Date | undefined): string {
  if (!d) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** ObjectIds share their leading timestamp bytes; the tail is what tells recent ids apart. */
export function shortId(id: string | undefined, n = 6): string {
  if (!id) return '—';
  return id.length > n + 2 ? `…${id.slice(-n)}` : id;
}

export function pct(x: number | undefined): string {
  return x === undefined ? '—' : `${(x * 100).toFixed(0)}%`;
}

export function usd(x: number | undefined, digits = 3): string {
  return x === undefined ? '—' : `$${x.toFixed(digits)}`;
}

export function upper(s: string | undefined): string {
  return (s ?? 'unknown').replace(/_/g, ' ').toUpperCase();
}
