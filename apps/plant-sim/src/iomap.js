// Verified I/O map for Factory I/O "Sorting by Height (Basic)" on the OpenPLC v4 Modbus server (unit 1).
// Source: rig kit config/io_mapping.json + docs/ENDPOINTS.md §6, identical to scenes/sorting-by-height-basic.json
// (OpenPLC convention %QXa.b -> coil a*8+b, %QW0 -> holding register 0).

/** Plant -> PLC. These are the ONLY coils this service may ever write (100..113). */
export const INPUTS = [
  { name: 'High sensor', coil: 100, addr: '%QX12.4' },
  { name: 'Low sensor', coil: 101, addr: '%QX12.5' },
  { name: 'Pallet sensor', coil: 102, addr: '%QX12.6' },
  { name: 'Loaded', coil: 103, addr: '%QX12.7' },
  { name: 'At left entry', coil: 104, addr: '%QX13.0', activeLow: true },
  { name: 'At left exit', coil: 105, addr: '%QX13.1', activeLow: true },
  { name: 'At right entry', coil: 106, addr: '%QX13.2', activeLow: true },
  { name: 'At right exit', coil: 107, addr: '%QX13.3', activeLow: true },
  { name: 'Start', coil: 108, addr: '%QX13.4' },
  { name: 'Reset', coil: 109, addr: '%QX13.5' },
  { name: 'Stop', coil: 110, addr: '%QX13.6', nc: true },
  { name: 'Emergency stop', coil: 111, addr: '%QX13.7', nc: true },
  { name: 'Auto', coil: 112, addr: '%QX14.0' },
  // The sorter programs gate every actuator on this coil (Factory I/O sets it while its scene runs).
  // While armed, the simulator IS the plant, so it drives it TRUE.
  { name: 'FACTORY I/O (Running)', coil: 113, addr: '%QX14.1' },
];
export const INPUT_FIRST = 100;
export const INPUT_COUNT = INPUTS.length; // 14 -> coils 100..113

/** PLC -> plant. Read only, never written. */
export const OUTPUTS = [
  { name: 'Conveyor entry', coil: 0, addr: '%QX0.0' },
  { name: 'Load', coil: 1, addr: '%QX0.1' },
  { name: 'Unload', coil: 2, addr: '%QX0.2' },
  { name: 'Transf. left', coil: 3, addr: '%QX0.3' },
  { name: 'Transf. right', coil: 4, addr: '%QX0.4' },
  { name: 'Conveyor left', coil: 5, addr: '%QX0.5' },
  { name: 'Conveyor right', coil: 6, addr: '%QX0.6' },
  { name: 'Start light', coil: 7, addr: '%QX0.7' },
  { name: 'Reset light', coil: 8, addr: '%QX1.0' },
  { name: 'Stop light', coil: 9, addr: '%QX1.1' },
];
export const OUTPUT_COUNT = OUTPUTS.length; // coils 0..9
/** %QW0 Counter, then the sorter diagnostics HR1 state, HR2 tall, HR3 short, HR4 fault. */
export const REGISTERS = ['Counter', 'State', 'Tall count', 'Short count', 'Fault'];

/** Safe rest state (contract): Stop=TRUE, E-stop=TRUE, retro eyes TRUE (clear), everything else FALSE. */
export function restInputs() {
  const r = {};
  for (const i of INPUTS) r[i.name] = !!(i.nc || i.activeLow);
  return r;
}
