// Types for the plain-JS Three.js model of the "Sorting by Height (Basic)" line (prototype/ui-redesign/factory3d.js).
export type TagValue = boolean | number;
export interface FactorySnapshot {
  tags: Record<string, TagValue>;
  boxes?: { id: number; seg: string; x: number; z: number; tall?: boolean }[];
  running?: boolean;
  fault?: boolean;
  forced?: string[];
  /** false = rig offline: the twin idles (belts stop, boxes cleared). */
  online?: boolean;
  /** Age of the rig snapshot in ms; >= 10000 is treated as offline. */
  ageMs?: number;
}
export interface PlantBox { id: number; x: number; z: number; tall: boolean; seg: 'entry' | 'xfer' | 'left' | 'right' | string }
export interface PlantFrame {
  t?: 'state'; ts?: number;
  tags: Record<string, TagValue>;
  boxes: PlantBox[];
  plc?: { connected: boolean; source?: 'mock' | 'real' | string; host?: string; rttMs?: number; lastReadAgoMs?: number; program?: string | null };
  armed?: boolean; factoryIoActive?: boolean; busyJob?: string | null; error?: string | null;
  geometry?: { heightGateX?: number; [k: string]: unknown };
}
export interface FactoryApi {
  setShot(name: 'overview' | 'descend' | 'sensors' | 'monitor'): void;
  focusTag(name: string | null): void;
  /** Without boxes[], runs the digital twin: boxes reconstructed from the real rig tags. */
  setIO(snap: FactorySnapshot): void;
  pulse(name: string): void;
  setLabels(mode: 'auto' | 'all' | 'none' | string[]): void;
  setPaused(paused: boolean): void;
  setBuild(level: number): void;
  /** External-state mode: render a plant-sim frame (boxes at server positions, interpolated; tags drive belts/beams/lamps/counter). */
  applyPlant(state: PlantFrame): void;
  /** Remove all plant boxes/frames (e.g. on disconnect). */
  clearPlant(): void;
  /** Move the height gate (Low/High eyes) along the entry belt; default x=-1.7 beside the Pallet sensor. */
  setHeightGateX(x: number): void;
  /** Remove the canvas + label layer from the host and stop rendering; all state is kept (twin keeps advancing from setIO). */
  detach(): void;
  /** Re-append the same canvas into newHost, resize and resume with no intro/reveal. */
  attach(host: HTMLElement): void;
  readonly attached: boolean;
  /** Number of live boxes (twin or legacy). */
  readonly boxCount: number;
  dispose(): void;
}
export function createFactory(
  host: HTMLElement,
  opts?: { reducedMotion?: boolean; offset?: number; quality?: 'high' | 'low'; labels?: 'auto' | 'all' | 'none'; focusDistance?: number; heightGateX?: number; localSim?: boolean; shotScale?: number; reveal?: boolean; skipIntro?: boolean }
): FactoryApi;
