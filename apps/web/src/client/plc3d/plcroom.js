// plcroom.js — control room of PLC cabinets. Bird's-eye overview -> click a cabinet -> fly in,
// door swings open -> click the PLC CPU -> macro close-up and the workflow window opens.
// Interaction pattern adapted from ThermalDesk's MCC room (zubair480/crusoe-hackathon, apps/web/public/mcc).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { buildProps, buildHall, mergeStatic } from './plcprops.js';

const ORANGE = 0xff5a1f;
const std = (c, r = .5, m = .1, x = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m, ...x });
const MAT = {
  body: std(0xeceef1, .38, .25), door: std(0xf3f4f6, .32, .25), plinth: std(0x2b2e33, .6, .1),
  backplate: std(0xf2ecd9, .7, .05), rail: std(0xb9c0c7, .28, .9), duct: std(0x9aa0a6, .75, 0),
  ductLid: std(0xa9afb5, .7, 0), plc: std(0x2f3d4c, .45, .15), plcFace: std(0x3d4e60, .4, .15),
  module: std(0x41505f, .45, .12), term: std(0x8c9298, .6, 0), termBlue: std(0x3a7bd5, .55, 0),
  psu: std(0xbfc4c9, .35, .6), handle: std(0x202226, .35, .4), gasket: std(0x111214, .8, 0),
  floor: std(0xf5f6f8, .9, 0), tile: std(0xe9ebee, .9, 0), wire: std(0x1a1b1d, .6, 0),
  wireBlue: std(0x2b5fc2, .55, 0), brkW: std(0xe8e9eb, .45, .05), brkD: std(0x4a4d52, .5, .1), mccB: std(0x50545a, .5, .1), wireRed: std(0xc0241c, .55, 0), cable: std(0x3a3d42, .7, 0),
};
const ledMat = c => std(c, .3, 0, { emissive: c, emissiveIntensity: 0 });

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}

// ---- cabinet dims (metres) ----
const CW = 0.8, CH = 2.0, CD = 0.5, PL = 0.1;

export const CABINETS = [
  { id: 'CAB-01', machine: 'Sorting station', scene: 'sorting-by-height-basic', plc: 'OpenPLC · v4', state: 'running', live: true, ex: 'sorting' },
  { id: 'CAB-02', machine: 'Entry conveyor', scene: 'sorting-by-height-basic', plc: 'OpenPLC · v2', state: 'fault', ex: 'jam' },
  { id: 'CAB-03', machine: 'Box counter', ex: 'count', scene: '—', plc: 'unassigned', state: 'idle' },
  { id: 'CAB-04', machine: 'Pick & place', scene: '—', plc: 'unassigned', state: 'idle' },
  { id: 'CAB-05', machine: 'Buffer lane', scene: '—', plc: 'unassigned', state: 'idle' },
  { id: 'CAB-06', machine: 'Assembler', scene: '—', plc: 'unassigned', state: 'idle' },
  { id: 'CAB-07', machine: 'Separator', scene: '—', plc: 'unassigned', state: 'idle' },
  { id: 'CAB-08', machine: 'Elevator', scene: '—', plc: 'unassigned', state: 'idle' },
  { id: 'MCC-A', machine: 'Motor control', scene: '—', plc: 'none', state: 'running', blank: true },
  { id: 'MCC-B', machine: 'Motor control', scene: '—', plc: 'none', state: 'running', blank: true },
];

export function createRoom(host, hooks = {}) {
  let disposed = false;
  const W = () => host.clientWidth, H = () => host.clientHeight;
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1)); renderer.setSize(W(), H());
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
  host.append(renderer.domElement);
  const css = new CSS2DRenderer(); css.setSize(W(), H());
  Object.assign(css.domElement.style, { position: 'absolute', inset: 0, pointerEvents: 'none' }); host.append(css.domElement);

  const scene = new THREE.Scene();
  const BG = new THREE.Color(0xe6e8eb); scene.background = BG; scene.fog = new THREE.Fog(BG, 26, 80); // soft depth fade into the hall
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), .04).texture; scene.environmentIntensity = .6;

  const camera = new THREE.PerspectiveCamera(36, W() / H(), .02, 200);
  const HOME = { pos: new THREE.Vector3(6.6, 7.4, 8.4), target: new THREE.Vector3(-.4, .9, -.6) };
  camera.position.copy(HOME.pos);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(HOME.target); controls.enableDamping = true; controls.maxPolarAngle = Math.PI * .48;
  controls.minDistance = .25; controls.maxDistance = 22; controls.minAzimuthAngle = -.35; controls.maxAzimuthAngle = 1.9;

  scene.add(new THREE.HemisphereLight(0xffffff, 0xe3e6ea, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 2.0); sun.position.set(-6, 12, 7); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -13, right: 13, top: 13, bottom: -13, near: 1, far: 45 }); sun.target.position.set(1.5, 0, 2); scene.add(sun.target);
  sun.shadow.bias = -.0003; sun.shadow.normalBias = .02; scene.add(sun);

  // ---- room: floor tiles, low walls on two sides, cable ladder overhead ----
  const tileTex = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#f5f6f8'; g.fillRect(0, 0, w, h); g.strokeStyle = '#e1e4e8'; g.lineWidth = 3;
    for (let i = 0; i <= 8; i++) { g.beginPath(); g.moveTo(i * 64, 0); g.lineTo(i * 64, h); g.stroke(); g.beginPath(); g.moveTo(0, i * 64); g.lineTo(w, i * 64); g.stroke(); }
  });
  tileTex.wrapS = tileTex.wrapT = THREE.RepeatWrapping; tileTex.repeat.set(10.625 / 8, 8.325 / 8);
  const tiles = new THREE.Mesh(new THREE.PlaneGeometry(10.625, 8.325), new THREE.MeshStandardMaterial({ map: tileTex, roughness: .9 }));
  tiles.rotation.x = -Math.PI / 2; tiles.position.set(.0875, .003, .6375); tiles.receiveShadow = true; scene.add(tiles);
  const wallM = std(0xffffff, .95, 0, { emissive: 0xffffff, emissiveIntensity: .35 });
  const wallA = new THREE.Mesh(new THREE.PlaneGeometry(10.6, 3.2), wallM); wallA.position.set(.1, 1.6, -3.525); wallA.receiveShadow = true; scene.add(wallA);
  const wallB = new THREE.Mesh(new THREE.BoxGeometry(.15, 3.2, 20), wallM); wallB.position.set(-6.4, 1.6, 0); wallB.receiveShadow = true;
  // safety walkway lines
  const lineM = std(0xf2c230, .7, 0);
  [[0, .9], [0, -.9 + 3.5 - 4.4]].forEach(() => {});
  [[0, -1.55], [0, .75]].forEach(([x, z]) => { const m = new THREE.Mesh(new THREE.BoxGeometry(10.5, .004, .06), lineM); m.position.set(.1, .006, z); scene.add(m); });
  // overhead cable ladder
  [-2.2, 1.4].forEach(lz => { const ladder = new THREE.Group(); ladder.position.set(.2, 2.75, lz);
    [-.2, .2].forEach(z => { const r = new THREE.Mesh(new THREE.BoxGeometry(10, .06, .03), MAT.rail); r.position.z = z; ladder.add(r); });
    for (let i = 0; i < 25; i++) { const s = new THREE.Mesh(new THREE.BoxGeometry(.03, .02, .4), MAT.rail); s.position.x = -4.9 + i * .4; ladder.add(s); }
    for (let i = 0; i < 6; i++) { const c = new THREE.Mesh(new THREE.CylinderGeometry(.018, .018, 10, 8), i % 3 ? MAT.cable : MAT.wireBlue); c.rotation.z = Math.PI / 2; c.position.set(0, .05, -.15 + i * .06); ladder.add(c); }
    [-4, -1, 2, 4.6].forEach(x => { const h = new THREE.Mesh(new THREE.BoxGeometry(.02, .5, .02), MAT.rail); h.position.set(x, .27, 0); ladder.add(h); });
    scene.add(ladder); mergeStatic(ladder); });

  const props = buildProps(scene, { backZ: -3.525, leftX: -5.225 });
  const hall = buildHall(scene); // factory hall + live production line around the room
  window.__room3d = { renderer, scene, camera };
  // ---- cabinets ----
  const pickables = [], cabinets = [];
  const rows = [{ z: -2.2, rot: 0, ids: [0, 1, 2, 3, 8] }, { z: 1.4, rot: Math.PI, ids: [4, 5, 6, 7, 9] }];
  rows.forEach(row => row.ids.forEach((ci, k) => {
    const def = CABINETS[ci]; const x = -1.9 + k * (CW + .04) + (k > 3 ? .45 : 0);
    const cab = buildCabinet(def); cab.group.position.set(row.rot ? -x + .5 : x, 0, row.z); cab.group.rotation.y = row.rot; scene.add(cab.group); cabinets.push(cab);
  }));

  function buildCabinet(def) {
    const g = new THREE.Group();
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(CW, PL, CD), MAT.plinth); plinth.position.y = PL / 2; g.add(plinth);
    // carcass: back, sides, top as thin boxes so the inside is visible when open
    const t = .02;
    const parts = [[CW, CH, t, 0, PL + CH / 2, -CD / 2 + t / 2], [t, CH, CD, -CW / 2 + t / 2, PL + CH / 2, 0], [t, CH, CD, CW / 2 - t / 2, PL + CH / 2, 0],
      [CW, t, CD, 0, PL + CH - t / 2, 0], [CW, t, CD, 0, PL + t / 2, 0]];
    parts.forEach(([w, h, d, x, y, z]) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), MAT.body); m.position.set(x, y, z); g.add(m); });
    // roof cap + lifting eyes
    const cap = new THREE.Mesh(new THREE.BoxGeometry(CW + .02, .03, CD + .02), MAT.body); cap.position.y = PL + CH + .015; g.add(cap);
    [-1, 1].forEach(s => { const e = new THREE.Mesh(new THREE.TorusGeometry(.03, .008, 8, 16), MAT.rail); e.position.set(s * CW * .35, PL + CH + .06, 0); g.add(e); });
    // stack light on roof
    const stackColors = [0x2fb35a, 0xf2c230, 0xe0352b];
    const stack = stackColors.map((c, i) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(.035, .035, .06, 16), ledMat(c)); m.position.set(CW * .3, PL + CH + .07 + i * .062, CD * .2); g.add(m); return m; });
    // interior (always built; hidden behind the closed door)
    const inside = new THREE.Group(); inside.position.set(0, PL, -CD / 2 + .03); g.add(inside);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(CW - .08, CH - .12, .012), MAT.backplate); plate.position.set(0, CH / 2, .006); inside.add(plate);
    const plc = def.blank ? null : buildInterior(inside, def);
    if (def.blank) buildMCCInterior(inside);
    if (plc) { mergeStatic(plc); plc.userData.dynamic = true; }
    inside.traverse(m => { if (m.isMesh) { m.castShadow = false; m.receiveShadow = true; } });
    mergeStatic(inside);
    // door, hinged on the left edge
    const hinge = new THREE.Group(); hinge.position.set(-CW / 2, PL, CD / 2); g.add(hinge);
    const door = new THREE.Mesh(new RoundedBoxGeometry(CW - .01, CH - .01, .025, 2, .006), MAT.door);
    door.position.set(CW / 2, CH / 2, .012); hinge.add(door);
    // door details: handle, nameplate, HMI window / pilot lights, louvres
    const handle = new THREE.Mesh(new RoundedBoxGeometry(.03, .16, .03, 2, .01), MAT.handle); handle.position.set(CW - .07, CH * .52, .04); hinge.add(handle);
    const plateTex = canvasTex(512, 160, (c, w, h) => {
      c.fillStyle = '#fbfbfa'; c.fillRect(0, 0, w, h); c.strokeStyle = '#1b1d21'; c.lineWidth = 6; c.strokeRect(6, 6, w - 12, h - 12);
      c.fillStyle = '#0b0b0c'; c.font = '600 54px "Geist Mono", ui-monospace, monospace'; c.fillText(def.id, 30, 72);
      c.font = '400 34px "Geist", system-ui, sans-serif'; c.fillStyle = '#4a4f57'; c.fillText(def.machine, 30, 124);
    });
    const np = new THREE.Mesh(new THREE.PlaneGeometry(.34, .106), new THREE.MeshStandardMaterial({ map: plateTex, roughness: .5 }));
    np.position.set(CW / 2, CH - .16, .026); hinge.add(np);
    const pilots = [0x2fb35a, 0xf2c230, 0xe0352b].map((c, i) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(.018, .018, .015, 20), ledMat(c)); m.rotation.x = Math.PI / 2;
      m.position.set(CW / 2 - .08 + i * .08, CH - .3, .03); hinge.add(m); return m;
    });
    for (let i = 0; i < 6; i++) { const l = new THREE.Mesh(new THREE.BoxGeometry(.3, .008, .006), MAT.gasket); l.position.set(CW / 2, .18 + i * .025, .027); hinge.add(l); }
    // small HMI window on door (glass)
    if (!def.blank) {
      const hmiTex = canvasTex(256, 160, (c, w, h) => { c.fillStyle = '#0f1419'; c.fillRect(0, 0, w, h); c.fillStyle = '#ff5a1f'; c.font = '600 22px ui-monospace,monospace'; c.fillText(def.state.toUpperCase(), 18, 40); c.fillStyle = '#9aa3ad'; c.font = '18px ui-monospace,monospace'; c.fillText(def.plc, 18, 78); c.fillText(def.scene.slice(0, 20), 18, 108); });
      const hmi = new THREE.Mesh(new THREE.PlaneGeometry(.22, .14), new THREE.MeshStandardMaterial({ map: hmiTex, emissive: 0xffffff, emissiveMap: hmiTex, emissiveIntensity: .5, roughness: .2 }));
      hmi.position.set(CW / 2, CH * .68, .026); hinge.add(hmi);
    }
    // hover outline
    const outline = new THREE.Mesh(new THREE.BoxGeometry(CW + .03, CH + PL + .03, CD + .03), new THREE.MeshBasicMaterial({ color: ORANGE, transparent: true, opacity: 0, wireframe: false, side: THREE.BackSide }));
    outline.position.y = (CH + PL) / 2; g.add(outline);
    // floor badge label
    const el = document.createElement('div'); el.className = 'cab-tag';
    el.innerHTML = `<span class="dot ${def.state}"></span><b>${def.id}</b><span>${def.machine}</span>`;
    const tag = new CSS2DObject(el); tag.position.set(0, PL + CH + .45, 0); g.add(tag);

    g.traverse(m => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
    outline.castShadow = false;
    // collapse carcass + door details into a few meshes per material (draw calls matter on Iris Xe)
    hinge.userData.dynamic = inside.userData.dynamic = outline.userData.dynamic = true; mergeStatic(g);
    hinge.userData.dynamic = false; mergeStatic(hinge);
    inside.traverse(m => { if (m.isMesh) m.castShadow = false; }); // interior never shadows anything visible
    const cab = { def, group: g, hinge, door, outline, inside, stack, pilots, plc, tag, open: 0, openGoal: 0, hover: 0 };
    hinge.traverse(m => { if (m.isMesh) { m.userData.cab = cab; m.userData.part = 'door'; pickables.push(m); } });
    g.traverse(m => { if (m.isMesh && !m.userData.cab) { m.userData.cab = cab; m.userData.part = m.userData.part || 'body'; pickables.push(m); } });
    if (plc) plc.traverse(m => { if (m.isMesh) m.userData.part = 'plc'; });
    return cab;
  }

  function buildInterior(inside, def) {
    const yTop = CH - .32;
    // wire ducts: two horizontal + two vertical
    const duct = (w, h, x, y) => { const d = new THREE.Mesh(new THREE.BoxGeometry(w, h, .06), MAT.duct); d.position.set(x, y, .04); inside.add(d);
      const lid = new THREE.Mesh(new THREE.BoxGeometry(w + .004, h + .004, .006), MAT.ductLid); lid.position.set(x, y, .073); inside.add(lid); };
    duct(CW - .14, .06, 0, yTop + .14); duct(CW - .14, .06, 0, yTop - .27); duct(CW - .14, .06, 0, yTop - .75);
    duct(.06, 1.4, -CW / 2 + .1, yTop - .7); duct(.06, 1.4, CW / 2 - .1, yTop - .7);
    // DIN rails
    const rail = y => { const r = new THREE.Mesh(new THREE.BoxGeometry(CW - .26, .035, .008), MAT.rail); r.position.set(0, y, .02); inside.add(r); };
    rail(yTop); rail(yTop - .45); rail(yTop - 1.0);
    // PLC rack on top rail: PSU, CPU, IO modules
    const plc = new THREE.Group(); plc.position.set(-.2, yTop, .03); inside.add(plc);
    const psu = new THREE.Mesh(new RoundedBoxGeometry(.07, .12, .075, 2, .006), MAT.psu); psu.position.set(-.045, 0, .04); inside.add(psu); psu.position.x = -.29;
    const cpu = new THREE.Mesh(new RoundedBoxGeometry(.12, .13, .08, 2, .006), MAT.plc); cpu.position.set(0, 0, .04); plc.add(cpu);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(.1, .1), new THREE.MeshStandardMaterial({ map: canvasTex(256, 256, (c, w, h) => {
      c.fillStyle = '#3d4e60'; c.fillRect(0, 0, w, h); c.fillStyle = '#e8ecef'; c.font = '600 30px ui-monospace,monospace'; c.fillText('CPU', 18, 44);
      c.font = '20px ui-monospace,monospace'; c.fillStyle = '#b8c2cc'; c.fillText('MM-1214', 18, 76); c.fillText(def.id, 18, 104);
      c.fillStyle = '#20272e'; c.fillRect(18, 150, 220, 70); c.fillStyle = '#8fa0b0'; c.fillRect(26, 158, 40, 54); c.fillRect(76, 158, 40, 54);
    }), roughness: .45 }));
    face.position.set(0, 0, .081); plc.add(face);
    const cpuLeds = ['RUN', 'ERR', 'MAINT'].map((n, i) => { const m = new THREE.Mesh(new THREE.BoxGeometry(.012, .006, .004), ledMat(i === 0 ? 0x2fb35a : i === 1 ? 0xe0352b : 0xf2c230)); m.position.set(.035, .035 - i * .012, .082); plc.add(m); return m; });
    const ioLeds = [], ioMats = [];
    for (let i = 0; i < 4; i++) {
      const mod = new THREE.Mesh(new RoundedBoxGeometry(.045, .13, .075, 2, .005), MAT.module); mod.position.set(.085 + i * .047, 0, .038); plc.add(mod);
      const mm = ledMat(i < 2 ? 0x2fb35a : ORANGE); ioMats.push(mm);
      for (let j = 0; j < 8; j++) { const l = new THREE.Mesh(new THREE.BoxGeometry(.008, .004, .003), mm); l.position.set(.085 + i * .047 - .01 + (j % 2) * .02, .045 - Math.floor(j / 2) * .01, .077); plc.add(l); ioLeds.push(l); }
    }
    // ethernet cable from CPU
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(-.02, -.065, .07), new THREE.Vector3(-.02, -.12, .09), new THREE.Vector3(-.15, -.2, .06), new THREE.Vector3(-.3, -.26, .05)]);
    const eth = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, .004, 8), MAT.wireBlue); plc.add(eth);
    // contactors / breakers on second rail
    for (let i = 0; i < 7; i++) {
      const b = new THREE.Mesh(new RoundedBoxGeometry(.035, .09, .07, 2, .004), i < 3 ? MAT.brkW : MAT.brkD); b.position.set(-.21 + i * .07, yTop - .45, .04); inside.add(b);
    }
    // terminal blocks on bottom rail
    for (let i = 0; i < 26; i++) { const tb = new THREE.Mesh(new THREE.BoxGeometry(.012, .07, .05), i % 6 === 5 ? MAT.termBlue : MAT.term); tb.position.set(-.24 + i * .019, yTop - 1.0, .03); inside.add(tb); }
    // wires dropping into ducts
    for (let i = 0; i < 12; i++) {
      const x = -.2 + i * .04, m = i % 3 === 0 ? MAT.wireRed : i % 3 === 1 ? MAT.wireBlue : MAT.wire;
      const w = new THREE.Mesh(new THREE.CylinderGeometry(.0025, .0025, .16, 6), m); w.position.set(x, yTop - .62, .05); inside.add(w);
    }
    // PLC label
    const el = document.createElement('div'); el.className = 'plc-tag'; el.innerHTML = `<b>PLC</b> MM-1214 · ${def.plc}<i>click to open</i>`;
    const lbl = new CSS2DObject(el); lbl.position.set(0, .12, .08); plc.add(lbl); lbl.visible = false;
    plc.userData = { cpuLeds, ioLeds, ioMats, lbl, psu };
    return plc;
  }
  function buildMCCInterior(inside) {
    for (let r = 0; r < 4; r++) for (let i = 0; i < 4; i++) { const b = new THREE.Mesh(new RoundedBoxGeometry(.13, .2, .1, 2, .01), MAT.mccB); b.position.set(-.24 + i * .16, .4 + r * .38, .06); inside.add(b); }
  }

  // ---- state lamps ----
  function lampsFor(cab, t) {
    const s = cab.def.state, blink = Math.sin(t * 6) > 0;
    const on = [s === 'running', s === 'idle', s === 'fault' && blink];
    cab.stack.forEach((m, i) => m.material.emissiveIntensity = on[i] ? 2.4 : 0);
    cab.pilots.forEach((m, i) => m.material.emissiveIntensity = on[i] ? 2.2 : 0);
    if (cab.plc) {
      const u = cab.plc.userData; u.cpuLeds[0].material.emissiveIntensity = s !== 'idle' ? 2.5 : 0;
      u.cpuLeds[1].material.emissiveIntensity = s === 'fault' && blink ? 2.5 : 0;
      u.ioMats.forEach((m, i) => m.emissiveIntensity = s === 'running' && Math.sin(t * (3 + i * 1.3) + i * 2) > .2 ? 2.2 : 0);
    }
  }

  // ---- camera flights (ThermalDesk pattern: legs with lift, holds, labels) ----
  let flight = null;
  const ease = u => u < .5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
  function flyPath(legs) { flight = { legs, i: 0 }; startLeg(); }
  function startLeg() { const L = flight.legs[flight.i]; flight.t = 0; flight.done = false; flight.fp = camera.position.clone(); flight.ft = controls.target.clone(); L.onStart && L.onStart(); hooks.onStage && hooks.onStage(L.label || ''); }
  function stepFlight(dt) {
    const L = flight.legs[flight.i]; flight.t += dt; const u = Math.min(1, flight.t / L.dur), e = ease(u);
    camera.position.lerpVectors(flight.fp, L.pos, e); camera.position.y += Math.sin(Math.PI * e) * (L.lift || 0);
    controls.target.lerpVectors(flight.ft, L.target, e);
    if (u >= 1 && !flight.done) { flight.done = true; L.onArrive && L.onArrive(); }
    if (flight.t >= L.dur + (L.hold || 0)) { if (++flight.i < flight.legs.length) startLeg(); else flight = null; }
  }

  let selected = null, mode = 'room'; // room | cabinet | plc
  const wp = o => o.getWorldPosition(new THREE.Vector3());
  function selectCabinet(cab) {
    if (selected && selected !== cab) { selected.openGoal = 0; selected.plc && (selected.plc.userData.lbl.visible = false); }
    if (!cab) { selected = null; mode = 'room'; hooks.onSelect && hooks.onSelect(null);
      flyPath([{ pos: HOME.pos.clone(), target: HOME.target.clone(), dur: 2.2, lift: 1.2, label: 'CONTROL ROOM' }]); return; }
    selected = cab; mode = 'cabinet'; hooks.onSelect && hooks.onSelect(cab.def);
    const L = (x, y, z) => cab.group.localToWorld(new THREE.Vector3(x, y, z));
    flyPath([
      { pos: L(1.1, 2.4, 3.2), target: L(0, 1.1, 0), dur: 1.6, lift: .9, hold: .25, label: `1 / 3 · ${cab.def.id} · PLC CABINET` },
      { pos: L(.5, 1.45, 2.75), target: L(0, 1.15, -.1), dur: 1.3, hold: .2, label: `2 / 3 · OPENING ${cab.def.id}`, onStart: () => cab.openGoal = 1,
        onArrive: () => { if (cab.plc) cab.plc.userData.lbl.visible = true; hooks.onStage && hooks.onStage(cab.plc ? `3 / 3 · SELECT THE PLC` : `${cab.def.id} · MOTOR CONTROL — NO PLC`); } },
    ]);
  }
  function openPLC(cab) {
    if (!cab.plc) return; mode = 'plc';
    const p = wp(cab.plc); const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(cab.group.quaternion), side = new THREE.Vector3(1, 0, 0).applyQuaternion(cab.group.quaternion);
    p.add(side.clone().multiplyScalar(.06));
    cab.plc.userData.lbl.visible = false;
    flyPath([{ pos: p.clone().add(fwd.multiplyScalar(.48)).add(side.multiplyScalar(.1)).add(new THREE.Vector3(0, .05, 0)), target: p.clone(), dur: 1.2, label: `${cab.def.id} · PLC MM-1214`, onArrive: () => hooks.onOpenPLC && hooks.onOpenPLC(cab.def) }]);
  }
  function backOut() {
    if (mode === 'plc' && selected) { mode = 'cabinet'; selectCabinet(selected); hooks.onClosePLC && hooks.onClosePLC(); }
    else selectCabinet(null);
  }

  // ---- picking ----
  const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
  function pick(x, y) {
    const r = renderer.domElement.getBoundingClientRect(); ptr.set((x - r.left) / r.width * 2 - 1, -(y - r.top) / r.height * 2 + 1);
    ray.setFromCamera(ptr, camera); const h = ray.intersectObjects(pickables, false)[0];
    return h && h.object.userData.cab ? { cab: h.object.userData.cab, part: h.object.userData.part } : null;
  }
  let down = null, hovered = null;
  renderer.domElement.addEventListener('pointerdown', e => down = { x: e.clientX, y: e.clientY, t: performance.now() });
  renderer.domElement.addEventListener('pointerup', e => {
    if (!down) return; const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), quick = performance.now() - down.t < 450; down = null;
    if (moved > 6 || !quick || flight) return;
    const h = pick(e.clientX, e.clientY); if (!h) return;
    if (h.cab !== selected) selectCabinet(h.cab); else if (h.part === 'plc' || mode === 'cabinet' && h.cab.open > .9 && h.part !== 'door') openPLC(h.cab);
  });
  renderer.domElement.addEventListener('pointermove', e => {
    const h = pick(e.clientX, e.clientY); const hc = h ? h.cab : null;
    hovered = hc; renderer.domElement.style.cursor = h ? 'pointer' : 'grab';
    hooks.onHover && hooks.onHover(h ? { def: h.cab.def, part: h.part, x: e.clientX, y: e.clientY, selected: h.cab === selected } : null);
  });

  // ---- loop ----
  const clock = new THREE.Clock(); let t = 0, idleT = 0;
  function frame() {
    if (disposed) return; requestAnimationFrame(frame); const raw = Math.min(1, clock.getDelta()), dt = Math.min(.05, raw); t += raw;
    if (flight) stepFlight(raw);
    else if (mode === 'room') { idleT += dt; if (idleT > 4) { // slow drift orbit around the room when idle
      const a = Math.atan2(camera.position.z - controls.target.z, camera.position.x - controls.target.x) + dt * .04;
      const r = Math.hypot(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
      camera.position.x = controls.target.x + Math.cos(a) * r; camera.position.z = controls.target.z + Math.sin(a) * r; } }
    props.update(dt, t); hall.update(dt, t);
    controls.update();
    cabinets.forEach(cab => {
      cab.open += (cab.openGoal - cab.open) * (1 - Math.pow(.004, raw));
      cab.hinge.rotation.y = -cab.open * 1.95;
      cab.inside.visible = cab.open > .003 || cab.openGoal > 0; // interior only drawn while the door is (opening) open
      const hv = (hovered === cab && cab !== selected) ? 1 : 0; cab.hover += (hv - cab.hover) * (1 - Math.pow(.001, dt));
      cab.outline.material.opacity = cab.hover * .35;
      cab.tag.element.classList.toggle('hidden', mode !== 'room' || !(cab.def.state !== 'idle' && !cab.def.blank || hovered === cab));
      lampsFor(cab, t);
    });
    renderer.render(scene, camera); css.render(scene, camera);
  }
  renderer.domElement.addEventListener('pointerdown', () => idleT = 0);
  frame();
  addEventListener('resize', () => { camera.aspect = W() / H(); camera.updateProjectionMatrix(); renderer.setSize(W(), H()); css.setSize(W(), H()); });
  // app port: dispose() stops the loop and frees the GL context when the React page unmounts
  const dispose = () => { disposed = true; renderer.dispose(); renderer.forceContextLoss && renderer.forceContextLoss(); host.innerHTML = ""; };
  return { dispose, selectCabinet: id => selectCabinet(cabinets.find(c => c.def.id === id) || null), openPLC: () => selected && openPLC(selected), backOut, get mode() { return mode; } };
}
