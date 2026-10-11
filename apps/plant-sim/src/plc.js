// Modbus TCP link to the OpenPLC v4 Modbus server.
// Reads: coils 0..9 (outputs), holding registers 0..4, coils 100..113 (inputs as the PLC currently holds them).
// Writes: ONLY coils 100..113 (plant inputs), and only when the caller says it is armed. Output coils are never written.
import ModbusRTU from 'modbus-serial';
import { INPUTS, INPUT_FIRST, INPUT_COUNT, OUTPUTS, OUTPUT_COUNT, REGISTERS } from './iomap.js';

const MIN_WRITABLE = INPUT_FIRST;
const MAX_WRITABLE = INPUT_FIRST + INPUT_COUNT - 1;

export class PlcLink {
  constructor({ host, port, unitId = 1, timeoutMs = 1000 }) {
    this.host = host;
    this.port = port;
    this.unitId = unitId;
    this.timeoutMs = timeoutMs;
    this.client = null;
    this.connected = false;
    this.outputs = Object.fromEntries(OUTPUTS.map((o) => [o.name, false]));
    this.registers = Object.fromEntries(REGISTERS.map((r) => [r, 0]));
    this.inputsOnPlc = null; // what the PLC currently holds in coils 100..113
    this.rttMs = null;
    this.lastReadAt = 0;
    this.lastError = null;
    this.reads = 0;
    this.writes = 0;
    this._lock = Promise.resolve();
  }

  /** Serialize Modbus transactions (read loop, arm/disarm and shutdown may overlap). */
  _excl(fn) {
    const run = this._lock.then(fn, fn);
    this._lock = run.catch(() => {});
    return run;
  }

  async connect() {
    this.client?.close?.(() => {});
    const c = new ModbusRTU();
    await c.connectTCP(this.host, { port: this.port });
    c.setID(this.unitId);
    c.setTimeout(this.timeoutMs);
    this.client = c;
    this.connected = true;
    this.lastError = null;
  }

  async close() {
    this.connected = false;
    await new Promise((r) => (this.client ? this.client.close(() => r()) : r()));
  }

  /** One read cycle. Throws on failure (the caller marks the link down and reconnects). */
  read() { return this._excl(() => this._read()); }

  async _read() {
    const t0 = performance.now();
    const out = await this.client.readCoils(0, OUTPUT_COUNT);
    this.rttMs = Math.round((performance.now() - t0) * 10) / 10;
    OUTPUTS.forEach((o, i) => (this.outputs[o.name] = !!out.data[i]));
    const hr = await this.client.readHoldingRegisters(0, REGISTERS.length);
    REGISTERS.forEach((r, i) => (this.registers[r] = hr.data[i] << 16 >> 16)); // INT is signed
    const inp = await this.client.readCoils(INPUT_FIRST, INPUT_COUNT);
    this.inputsOnPlc = Object.fromEntries(INPUTS.map((t, i) => [t.name, !!inp.data[i]]));
    this.lastReadAt = Date.now();
    this.reads++;
  }

  /** Read any holding registers (used only for the mock-server marker check). */
  readRegisters(addr, n) {
    return this._excl(async () => (await this.client.readHoldingRegisters(addr, n)).data);
  }

  /** Write the full plant-input block 100..113 (FC15). `values` is by tag name. */
  writeInputs(values) { return this._excl(() => this._writeInputs(values)); }

  async _writeInputs(values) {
    const bits = INPUTS.map((t) => {
      if (!(t.name in values)) throw new Error(`missing input ${t.name}`);
      return !!values[t.name];
    });
    if (INPUT_FIRST < MIN_WRITABLE || INPUT_FIRST + bits.length - 1 > MAX_WRITABLE) throw new Error('refusing to write outside coils 100..113');
    await this.client.writeCoils(INPUT_FIRST, bits);
    this.writes++;
  }
}
