// Types for the plain-JS Three.js control room (ported from prototype/ui-redesign/plcroom.js).
export interface CabinetDef {
  id: string;
  machine: string;
  state: string;
  plc: string;
  scene: string;
  ex?: string;
  blank?: boolean;
}
export interface RoomHooks {
  onStage?: (label: string | null) => void;
  onSelect?: (def: CabinetDef | null) => void;
  onOpenPLC?: (def: CabinetDef) => void;
  onClosePLC?: () => void;
  onHover?: (h: { x: number; y: number; def: CabinetDef; part?: string; selected?: boolean } | null) => void;
}
export interface RoomApi {
  selectCabinet(id: string | null): void;
  openPLC(): void;
  backOut(): void;
  readonly mode: string;
  dispose?: () => void;
}
export function createRoom(host: HTMLElement, hooks?: RoomHooks): RoomApi;
