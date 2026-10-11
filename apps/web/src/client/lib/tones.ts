// Status -> tone. Colors follow IEC 60073 signal semantics: green = normal / verified, red = fault,
// amber = abnormal / blocked / forced, cyan = in progress, violet = harness (meta level), gray = no data.
export type Tone = 'good' | 'bad' | 'warn' | 'active' | 'info' | 'meta' | 'muted';

export const TONE_PILL: Record<Tone, string> = {
  good: 'border-go-500/45 bg-go-500/10 text-go-300',
  bad: 'border-stop-500/50 bg-stop-500/10 text-stop-300',
  warn: 'border-caution-400/50 bg-caution-400/10 text-caution-300',
  active: 'border-flow-400/50 bg-flow-400/10 text-flow-300',
  info: 'border-plant-500 bg-plant-800 text-plant-200',
  meta: 'border-meta-400/50 bg-meta-400/10 text-meta-300',
  muted: 'border-plant-700 bg-plant-850 text-plant-400',
};

export const TONE_DOT: Record<Tone, string> = {
  good: 'bg-go-400',
  bad: 'bg-stop-400',
  warn: 'bg-caution-400',
  active: 'bg-flow-400',
  info: 'bg-plant-300',
  meta: 'bg-meta-400',
  muted: 'bg-plant-500',
};

export const TONE_TEXT: Record<Tone, string> = {
  good: 'text-go-300',
  bad: 'text-stop-300',
  warn: 'text-caution-300',
  active: 'text-flow-300',
  info: 'text-plant-200',
  meta: 'text-meta-300',
  muted: 'text-plant-400',
};

export function jobTone(status: string | undefined): Tone {
  switch (status) {
    case 'queued':
      return 'info';
    case 'running':
    case 'verifying':
      return 'active';
    case 'completed':
      return 'good';
    case 'failed':
      return 'bad';
    case 'blocked':
    case 'interrupted':
      return 'warn';
    default:
      return 'muted';
  }
}

export function stageTone(status: string | undefined): Tone {
  switch (status) {
    case 'running':
      return 'active';
    case 'done':
      return 'good';
    case 'failed':
      return 'bad';
    case 'blocked':
      return 'warn';
    default:
      return 'muted';
  }
}

export function requirementTone(status: string | undefined): Tone {
  switch (status) {
    case 'verified':
      return 'good';
    case 'failed':
      return 'bad';
    case 'blocked':
      return 'warn';
    default:
      return 'muted'; // unsupported / untested / no verdict
  }
}

export function testTone(verdict: string | undefined): Tone {
  switch (verdict) {
    case 'passed':
      return 'good';
    case 'failed':
      return 'bad';
    case 'blocked':
      return 'warn';
    default:
      return 'muted';
  }
}

export function rsiTone(verdict: string | undefined): Tone {
  switch (verdict) {
    case 'kept':
      return 'good';
    case 'rolled_back':
    case 'rejected':
      return 'bad';
    case 'pending':
      return 'active';
    default:
      return 'muted'; // no_change
  }
}

export function projectTone(status: string | undefined): Tone {
  switch (status) {
    case 'running':
      return 'active';
    case 'verified':
      return 'good';
    case 'partially_verified':
    case 'blocked':
      return 'warn';
    case 'failed':
      return 'bad';
    default:
      return 'muted';
  }
}

export function compileTone(c: { status?: string; ok?: boolean } | undefined): Tone {
  if (!c) return 'muted';
  if (c.status === 'ok' || c.ok === true) return 'good';
  if (c.status === 'failed' || c.ok === false) return 'bad';
  if (c.status === 'unavailable') return 'warn';
  return 'muted';
}
