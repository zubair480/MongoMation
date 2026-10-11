// LOCAL mock of the OpenPLC Modbus server for testing the write path without touching the real PLC.
// Runs a JS port of the rig's sorter_v1.st (tall -> LEFT, short -> RIGHT) every 20 ms on its own coil image.
// Exposes the marker "MKOC" at HR 1000..1001 so plant-sim (PLANT_SIM_MOCK=1) knows it is a mock.
// Usage: node test/mock-plc.js [port=5021]
import ModbusRTU from 'modbus-serial';

const PORT = Number(process.argv[2] || process.env.MOCK_PLC_PORT || 5021);
const coils = new Array(256).fill(false);
const hr = new Array(1100).fill(0);
hr[1000] = 0x4d4b; hr[1001] = 0x4f43;
let outputCoilWrites = 0;

const vector = {
  getCoil: (a) => coils[a] ?? false,
  getDiscreteInput: () => false,
  getInputRegister: () => 0,
  getHoldingRegister: (a) => hr[a] ?? 0,
  setCoil: (a, v) => { if (a < 100) outputCoilWrites++; coils[a] = !!v; },
  setRegister: (a, v) => { hr[a] = v; },
};
const server = new ModbusRTU.ServerTCP(vector, { host: '127.0.0.1', port: PORT, unitID: 1 });
server.on('socketError', () => {});

// ---- sorter_v1 port
const I = (c) => coils[c];
const S = { state: 0, isTall: false, palletGone: false, settleMs: 0, transferMs: 0, tall: 0, short: 0, fault: 0 };
setInterval(() => {
  const dt = 20;
  const high = I(100), low = I(101), pallet = I(102), loaded = I(103), le = I(104), re = I(106);
  const reset = I(109), estop = I(111), fio = I(113);
  const q = { ce: coils[0], load: coils[1], unload: false, tl: coils[3], tr: coils[4], cl: coils[5], cr: coils[6], sl: coils[7], stl: coils[9] };
  if (!estop || !fio) {
    Object.assign(q, { ce: false, load: false, unload: false, tl: false, tr: false, cl: false, cr: false, sl: false, stl: !estop });
    S.state = 0;
  } else {
    q.stl = false; q.sl = true; q.cl = true; q.cr = true; q.unload = false;
    switch (S.state) {
      case 0: q.ce = true; q.load = false; q.tl = false; q.tr = false; S.isTall = false; S.palletGone = false; if (pallet && !loaded) S.state = 1; break;
      case 1: q.ce = true; if (high) S.isTall = true; if (S.settleMs >= 1500 && !loaded) S.state = 2; break;
      case 2: q.load = true; if (!pallet) S.palletGone = true; q.ce = !S.palletGone; if (loaded && S.palletGone) { q.load = false; q.ce = false; S.state = 3; } break;
      case 3: q.load = false; q.ce = false; q.tl = S.isTall; q.tr = !S.isTall;
        if ((S.isTall && !le) || (!S.isTall && !re)) S.state = 4;
        if (S.transferMs >= 60000) { S.fault = 2; S.state = 9; } break;
      case 4: q.tl = S.isTall; q.tr = !S.isTall;
        if (!loaded && ((S.isTall && le) || (!S.isTall && re))) { if (S.isTall) S.tall++; else S.short++; q.tl = false; q.tr = false; S.state = 0; }
        if (S.transferMs >= 60000) { S.fault = 2; S.state = 9; } break;
      case 9: q.ce = false; q.load = false; q.tl = false; q.tr = false; if (reset) { S.fault = 0; S.state = 0; } break;
    }
  }
  S.settleMs = S.state === 1 && pallet && low ? S.settleMs + dt : 0;
  S.transferMs = S.state === 3 || S.state === 4 ? S.transferMs + dt : 0;
  [q.ce, q.load, q.unload, q.tl, q.tr, q.cl, q.cr, q.sl, S.state === 9, q.stl].forEach((v, i) => (coils[i] = !!v));
  hr[0] = S.tall + S.short; hr[1] = S.state; hr[2] = S.tall; hr[3] = S.short; hr[4] = S.fault;
}, 20);

setInterval(() => {
  if (outputCoilWrites) { console.error(`VIOLATION: ${outputCoilWrites} writes to output coils 0..99`); }
}, 1000);
console.log(`mock PLC (sorter_v1 port) on 127.0.0.1:${PORT}`);
