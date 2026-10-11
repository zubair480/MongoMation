// Derives Ali's workflow view (5 run steps, tab unlocks) from the REAL project read model. No invented values:
// a step is only "done" when the worker wrote a finished checkpoint for it.
import { summarizeStages, type ProjectData, type StageLite } from '@/shared/mongomation';

export type StepStatus = 'pending' | 'active' | 'done' | 'warn';
export const STEPS = ['PLC Code', 'Compile & Deploy', 'HMI', 'Test', 'Verified'] as const;
export const STEP_TAB = ['build', 'build', 'hmi', 'verify', 'build'] as const;
export const FINAL_PROJECT = ['verified', 'partially_verified', 'not_verified', 'failed', 'blocked'];

const GROUPS: string[][] = [
  ['requirements', 'io_design', 'state_machine', 'plc_code'],
  ['preflight', 'compile', 'deploy'],
  [], // HMI: generated in the browser from the verified I/O map once the program is deployed
  ['simulate', 'tests', 'diagnosis', 'repair'],
  ['verification', 'deliver'],
];

function toStep(s: string): StepStatus {
  if (s === 'running') return 'active';
  if (s === 'failed' || s === 'blocked') return 'warn';
  if (s === 'done' || s === 'skipped') return 'done';
  return 'pending';
}

export interface RunView {
  status: StepStatus[];
  sub: string[];
  cur: number;
  finished: boolean;
  verified: boolean;
  deployed: boolean;
}

export function stagesOf(stages: StageLite[], names: string[]) {
  return stages.filter((s) => names.includes(s.stage));
}

const label = (d: StageLite) => d.stage.replace(/_/g, ' ') + (d.attempt > 1 ? ` #${d.attempt}` : '');

export function deriveRun(p: ProjectData | null): RunView {
  const stages = p?.stages ?? []; // server sorts by startedAt ascending
  const status: StepStatus[] = STEPS.map(() => 'pending');
  const sub: string[] = STEPS.map(() => '');
  GROUPS.forEach((names, i) => {
    if (!names.length) return;
    const docs = stagesOf(stages, names);
    if (!docs.length) return;
    status[i] = toStep(summarizeStages(docs).status);
    sub[i] = label(docs[docs.length - 1]);
  });

  // Once testing has started, a self-repair loop re-runs codegen/compile/deploy as new attempts. In Ali's flow that
  // loop belongs to the Test step, so earlier steps that finished once stay done and the re-run shows under Test.
  const testing = stagesOf(stages, GROUPS[3]).length > 0;
  if (testing) {
    for (const i of [0, 1]) {
      const docs = stagesOf(stages, GROUPS[i]);
      if (!docs.some((d) => d.status === 'done')) continue;
      const rerun = docs.filter((d) => d.status === 'running' || d.status === 'failed' || d.status === 'blocked');
      const lastRerun = rerun[rerun.length - 1];
      if (lastRerun && status[3] !== 'active') {
        status[3] = lastRerun.status === 'running' ? 'active' : 'warn';
        sub[3] = `repair · ${label(lastRerun)}`;
      }
      status[i] = 'done';
    }
  }

  // HMI has no worker stage: it is generated in the browser from the I/O map once a program was deployed.
  const deployed = stagesOf(stages, ['deploy']).some((d) => d.status === 'done');
  if (deployed) {
    status[2] = 'done';
    const tags = p?.requirements?.io.length;
    sub[2] = tags ? `${tags} tags` : 'from I/O map';
  }

  const newest = p?.plcVersions[0]; // newest first
  if (status[0] === 'done' && newest?.version != null) sub[0] = `v${newest.version}`;

  const tc = p?.testCounts;
  if (tc?.total && !sub[3].startsWith('repair')) sub[3] = `${tc.passed} / ${tc.total}`;
  // Failed or blocked tests on the newest sim run (no repair running): the Test step is not a clean pass.
  if ((tc?.failed || tc?.blocked) && status[3] === 'done') status[3] = 'warn';

  const ps = p?.project?.status;
  const finished = !!ps && FINAL_PROJECT.includes(ps);
  const verified = ps === 'verified';
  if (finished) {
    status[4] = verified ? 'done' : 'warn';
    const ok = p?.verdicts.filter((v) => isOk(v.status)).length ?? 0;
    const total = p?.verdicts.length ?? 0;
    sub[4] = total ? `${ok} / ${total}` : ps!.replace(/_/g, ' ');
    if (verified) for (const i of [0, 1, 3]) if (status[i] === 'warn') status[i] = 'done';
  }

  // Current step: the running one; else the furthest step that has any state (so a failed compile shows its pane).
  const act = status.findIndex((s) => s === 'active');
  let cur = act;
  if (cur < 0) for (let i = status.length - 1; i >= 0; i--) if (status[i] !== 'pending') { cur = i; break; }
  if (finished) cur = 4;
  if (cur < 0) cur = 0;
  return { status, sub, cur, finished, verified, deployed };
}

/** Verdict statuses that count as verified with evidence. */
export function isOk(s?: string) {
  return s === 'verified' || s === 'satisfied' || s === 'passed';
}

/** Ali's example specs (the composer text; the scene is the one registered in Atlas). */
export const EXAMPLES = [
  { id: 'sorting', icon: 'M4 7h10M4 12h7M4 17h4M17 4v16M14 17l3 3 3-3', title: 'Height sorting with jam protection', meta: 'example spec',
    text: 'Automate the sorting station: Start/Stop buttons run the line (Stop always wins, Emergency stop stops everything). Send tall boxes (high sensor) to the right lane and short boxes to the left lane using the chain transfer. If the left exit eye stays blocked for more than 3 seconds, stop the left conveyor and light the Reset light as a fault lamp until Reset is pressed with the eye clear.' },
  { id: 'entry', icon: 'M2 13h20v5H2zM8 13V7h8v6', title: 'Entry conveyor with start/stop & e-stop', meta: 'example spec',
    text: 'Control the entry conveyor of the sorting station. Pressing Start runs the entry conveyor and turns on the Start light; the conveyor keeps running after Start is released until Stop is pressed, and Stop always wins. The Emergency stop must stop the conveyor immediately.' },
  { id: 'count', icon: 'M3 5h18v14H3zM7 15V9l-1.5 1M11 9h3l-3 6h3M17 9v6', title: 'Box counter on the HMI', meta: 'example spec',
    text: 'Count every box that leaves either exit and show the total on the Counter display. Reset sets the counter to zero, but only while the line is stopped.' },
  { id: 'jam', icon: 'M12 3l10 18H2zM12 10v5M12 18v.5', title: 'Pallet jam alarm', meta: 'example spec',
    text: 'If the pallet sensor stays active for more than 5 seconds while the entry conveyor runs, stop the conveyor and latch the Stop light as a fault lamp. Reset clears the fault only once the pallet sensor is clear; the conveyor must not restart until Start is pressed again.' },
];

export const HMI_PARTS: [string, string][] = [
  ['Process mimic · conveyors & transfer', 'process'], ['Sensors · bound to their %QX inputs', 'sensors'], ['Actuators · bound to their %QX outputs', 'actuators'],
  ['Operator panel · Start / Stop / Reset / E-stop', 'panel'], ['Alarm banner & counter', 'alarms'],
];

export const TARGETS: Record<string, { n: string; f: string; file: string; addr: (d: 'in' | 'out', i: number, a: string) => string; notes: string[] }> = {
  siemens: { n: 'Siemens TIA Portal', f: 'S7-1500 · SCL in PLCopen XML', file: 'SortingStation_TIA.xml', addr: (d, i) => (d === 'in' ? `%I0.${i}` : `%Q0.${i}`),
    notes: ['TON becomes an IEC_TIMER instance in a data block', 'Program becomes FB "Main" called from OB1', 'NC contacts (Stop, E-stop) kept as-is — check your wiring'] },
  rockwell: { n: 'Rockwell Studio 5000', f: 'ControlLogix · L5X', file: 'SortingStation.L5X', addr: (d, i) => (d === 'in' ? `Local:1:I.Data.${i}` : `Local:2:O.Data.${i}`),
    notes: ['Structured Text routine in MainProgram / MainTask', 'TON becomes TONR (Rockwell ST timer); PT 3 s → PRE 3000 ms', 'I/O as module tags on slots 1 (DI) and 2 (DO)'] },
  codesys: { n: 'CODESYS 3.5', f: 'PLCopen XML (IEC 61131-3)', file: 'SortingStation_codesys.xml', addr: (d, i) => (d === 'in' ? `%IX0.${i}` : `%QX0.${i}`),
    notes: ['Imports as a PLC_PRG program; standard library TON', 'Works for Beckhoff TwinCAT 3, WAGO, Schneider and other CODESYS-based PLCs', 'Map %IX/%QX to your I/O module in the device tree'] },
  openplc: { n: 'OpenPLC / generic', f: 'IEC 61131-3 .st (as tested)', file: 'main.st', addr: (_d, _i, a) => a,
    notes: ['Exactly the program that passed its tests', 'Addresses unchanged (verified map for this rig)', 'Runs on OpenPLC v3/v4 and any IEC 61131-3 ST compiler'] },
};

export function fmtDur(ms?: number) {
  if (ms == null || !isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}
