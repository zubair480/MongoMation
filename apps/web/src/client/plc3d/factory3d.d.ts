// Types for the plain-JS Three.js model of the "Sorting by Height (Basic)" line (prototype/ui-redesign/factory3d.js).
export type TagValue = boolean | number;
export interface FactorySnapshot {
  tags: Record<string, TagValue>;
  boxes?: { id: number; seg: string; x: number; z: number; tall?: boolean }[];
  running?: boolean;
  fault?: boolean;
  forced?: string[];
}
export interface FactoryApi {
  setShot(name: 'overview' | 'descend' | 'sensors' | 'monitor'): void;
  focusTag(name: string | null): void;
  setIO(snap: FactorySnapshot): void;
  pulse(name: string): void;
  setLabels(mode: 'auto' | 'all' | 'none' | string[]): void;
  setPaused(paused: boolean): void;
  setBuild(level: number): void;
  dispose(): void;
}
export function createFactory(
  host: HTMLElement,
  opts?: { reducedMotion?: boolean; offset?: number; quality?: 'high' | 'low'; labels?: 'auto' | 'all' | 'none'; focusDistance?: number }
): FactoryApi;
