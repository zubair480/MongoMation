// plcmacro.js: high-fidelity 3D PLC rack component ("MM-1214"), three@0.160.0
// createPLC(host, opts) -> { setIO, setState, pulse, focusModule, measure, dispose, modules }
// Units: 1 world unit = 1 cm. Modules left->right: 0 PSU, 1 CM, 2 CPU, 3 DI, 4 DO, 5 AI.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Factory I/O "Sorting by Height (Basic)" tag map
export const INPUTS = [
  ['High sensor', '%QX12.4'], ['Low sensor', '%QX12.5'], ['Pallet sensor', '%QX12.6'], ['Loaded', '%QX12.7'],
  ['At left entry', '%QX13.0'], ['At left exit', '%QX13.1'], ['At right entry', '%QX13.2'], ['At right exit', '%QX13.3'],
  ['Start', '%QX13.4'], ['Reset', '%QX13.5'], ['Stop', '%QX13.6'], ['Emergency stop', '%QX13.7'], ['Auto', '%QX14.0'],
];
export const OUTPUTS = [
  ['Conveyor entry', '%QX0.0'], ['Load', '%QX0.1'], ['Unload', '%QX0.2'], ['Transf. left', '%QX0.3'], ['Transf. right', '%QX0.4'],
  ['Conveyor left', '%QX0.5'], ['Conveyor right', '%QX0.6'], ['Start light', '%QX0.7'], ['Reset light', '%QX1.0'], ['Stop light', '%QX1.1'],
];

const ORANGE = '#FF5A1F';
const S = 80;                       // atlas px per cm
const FT = 3.3, FB = -3.1, FH = FT - FB; // faceplate y-range
const GAP = 0.12;
const MONO = '"Geist Mono", ui-monospace, Menlo, Consolas, monospace';

const MODS = [
  { id: 'PSU', tag: '-U1', title: 'PSU 24V', w: 7.0, fz: 7.0, pitch: 0.9 },
  { id: 'CM', tag: '-A2', title: 'CM 485', w: 3.5, fz: 7.3, pitch: 0.42 },
  { id: 'CPU', tag: '-A3', title: 'CPU 1214', w: 11.0, fz: 7.8, pitch: 0.42 },
  { id: 'DI', tag: '-A4', title: 'DI 16', w: 4.5, fz: 7.3, pitch: 0.42 },
  { id: 'DO', tag: '-A5', title: 'DO 16', w: 4.5, fz: 7.3, pitch: 0.42 },
  { id: 'AI', tag: '-A6', title: 'AI 4', w: 4.5, fz: 7.3, pitch: 0.42 },
];
const BZ = 0.35;          // module back
const Y_TOPDUCT = 10.5, Y_MIDDUCT = -10.5, Y_BOTDUCT = -24, Y_TBRAIL = -17;
const DUCT_L = 58, SLOT0 = -DUCT_L / 2 + 1.1;
const snapSlot = (x) => Math.round(x - SLOT0) + SLOT0;

const CSS = `
.pm-host{position:relative;overflow:hidden}
.pm-host canvas{display:block;width:100%;height:100%;outline:none}
.pm-ov{position:absolute;inset:0;pointer-events:none;overflow:hidden;font:500 11px/1.35 ${MONO};color:#0B0B0C}
.pm-ov svg{position:absolute;inset:0;width:100%;height:100%}
.pm-tip{position:absolute;left:0;top:0;background:rgba(255,255,255,.95);backdrop-filter:blur(10px);border:1px solid #E7E7E9;border-radius:6px;padding:8px 10px;box-shadow:0 10px 30px rgba(16,24,40,.12);white-space:nowrap;opacity:0;transition:opacity .12s;min-width:170px}
.pm-tip .r{display:flex;justify-content:space-between;gap:16px}
.pm-tip .k{color:#8A8F98;font-size:10px}
.pm-tip .val{font-size:13px}
.pm-tip .val.on{color:${ORANGE}}
.pm-tip .fb{margin-top:5px;display:inline-block;font-size:9.5px;letter-spacing:.06em;color:${ORANGE};border:1px solid ${ORANGE};border-radius:3px;padding:0 5px;background:repeating-linear-gradient(135deg,rgba(255,90,31,.14) 0 3px,transparent 3px 6px)}
.pm-stack{position:absolute;left:0;top:0;display:flex;flex-direction:column;gap:3px;opacity:0;transition:opacity .25s}
.pm-stack .hd{font-size:10px;letter-spacing:.08em;color:#8A8F98;padding:0 2px 4px;text-transform:uppercase}
.pm-lab{display:flex;align-items:center;gap:8px;height:19px;white-space:nowrap;background:rgba(255,255,255,.92);border:1px solid #E7E7E9;border-radius:4px;padding:0 7px;font-size:10.5px;transition:border-color .2s,background .4s}
.pm-lab .c{color:#8A8F98;width:30px}.pm-lab .n{flex:1;min-width:96px}.pm-lab .v{min-width:28px;text-align:right}
.pm-lab .d{width:6px;height:6px;border-radius:50%;background:#D5D8DD}
.pm-lab.on .d{background:#0B0B0C}.pm-lab.on .v{font-weight:600}
.pm-lab.flash{background:rgba(255,90,31,.12)}
.pm-lab.forced{border-color:${ORANGE};background:repeating-linear-gradient(135deg,rgba(255,90,31,.10) 0 3px,rgba(255,255,255,.92) 3px 7px)}
.pm-lab.forced .v{color:${ORANGE}}
`;

export function createPLC(host, opts = {}) {
  const o = Object.assign({ background: null, pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5), autoOrbit: true,
    inputs: INPUTS, outputs: OUTPUTS, analog: [null, null, null, null], onFocus: null, title: 'CP-01 · SORTING BY HEIGHT' }, opts);

  if (!document.getElementById('plcmacro-css')) {
    const st = document.createElement('style'); st.id = 'plcmacro-css'; st.textContent = CSS; document.head.appendChild(st);
  }
  if (!document.querySelector('link[href*="Geist+Mono"]')) {
    const l = document.createElement('link'); l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600&display=swap'; document.head.appendChild(l);
  }
  host.classList.add('pm-host');
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

  // ---------- renderer / scene ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: o.background == null, powerPreference: 'high-performance' });
  renderer.setPixelRatio(o.pixelRatio);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  if (o.background != null) renderer.setClearColor(o.background, 1); else renderer.setClearColor(0xffffff, 0);
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
  scene.environment = envTex;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(30, 1, 1, 600);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xdfe3e8, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(-28, 42, 60); key.target.position.set(0, -6, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -36, right: 36, top: 26, bottom: -34, near: 20, far: 140 });
  key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02; key.shadow.radius = 4;
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(0xf4f6ff, 0.45); fill.position.set(40, 10, 50); scene.add(fill);

  // ---------- materials ----------
  const disposables = [];
  const T = (t) => (disposables.push(t), t);
  const noiseTex = T(makeNoiseTex());
  const mat = {
    body: new THREE.MeshStandardMaterial({ color: 0x2b2f34, roughness: 0.52, metalness: 0.05 }),
    strip: new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.62, metalness: 0.04 }),
    metal: new THREE.MeshStandardMaterial({ color: 0xcfd3d7, roughness: 0.28, metalness: 1.0 }),
    rail: new THREE.MeshStandardMaterial({ color: 0xd8dade, roughness: 0.34, metalness: 0.95 }),
    plate: new THREE.MeshStandardMaterial({ color: 0xd9dcdf, roughness: 0.5, metalness: 0.55, map: noiseTex }),
    duct: new THREE.MeshStandardMaterial({ color: 0xd2d5d9, roughness: 0.72, metalness: 0.0 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x0d0f11, roughness: 0.85, metalness: 0.0 }),
    block: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.0 }),
    wire: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.0 }),
    ferrule: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.0 }),
    plug: new THREE.MeshStandardMaterial({ color: 0xe6ecef, roughness: 0.18, metalness: 0.0, transparent: true, opacity: 0.82 }),
    cable: new THREE.MeshStandardMaterial({ color: 0x178a66, roughness: 0.45, metalness: 0.0 }),
    sd: new THREE.MeshStandardMaterial({ color: 0x24303d, roughness: 0.4, metalness: 0.2 }),
  };
  Object.values(mat).forEach((m) => disposables.push(m));

  // static geometry buckets, merged per material at end
  const buckets = {};
  const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), V = new THREE.Vector3(), SC = new THREE.Vector3();
  function mtx(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    return new THREE.Matrix4().compose(V.set(x, y, z), Q.setFromEuler(E.set(rx, ry, rz)), SC.set(sx, sy, sz));
  }
  function add(k, geo, m) {
    if (m) geo.applyMatrix4(m);
    let g = geo.index ? geo.toNonIndexed() : geo; if (g !== geo) geo.dispose();
    for (const a of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(a)) g.deleteAttribute(a);
    g.clearGroups(); g.morphAttributes = {};
    (buckets[k] ||= []).push(g);
  }
  const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

  // ---------- layout ----------
  const totalW = MODS.reduce((s, m) => s + m.w, 0) + GAP * (MODS.length - 1);
  let cx = -totalW / 2 - 2.5;
  let ax = 4;
  MODS.forEach((m, i) => {
    m.i = i; m.cx = cx + m.w / 2; cx += m.w + GAP;
    m.fw = m.w - 0.5; m.ax = ax; ax += Math.ceil(m.fw * S) + 8;
  });
  const ATLAS_W = ax, ATLAS_H = Math.ceil(FH * S);

  // backplate, wall-shadow catcher, rails, ducts
  add('plate', new RoundedBoxGeometry(62, 45, 0.3, 2, 0.4), mtx(0, -6.5, 0.15));
  const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(400, 300), new THREE.ShadowMaterial({ opacity: 0.09 }));
  shadowCatcher.position.z = -1.2; shadowCatcher.receiveShadow = true; scene.add(shadowCatcher);
  disposables.push(shadowCatcher.geometry, shadowCatcher.material);

  function dinRail(y, x0, x1) {
    const L = x1 - x0, xc = (x0 + x1) / 2;
    add('rail', box(L, 2.7, 0.1, xc, y, BZ + 0.7));
    add('rail', box(L, 0.1, 0.75, xc, y + 1.3, BZ + 0.37));
    add('rail', box(L, 0.1, 0.75, xc, y - 1.3, BZ + 0.37));
    add('rail', box(L, 0.45, 0.1, xc, y + 1.55, BZ + 0.05));
    add('rail', box(L, 0.45, 0.1, xc, y - 1.55, BZ + 0.05));
    for (let x = x0 + 1.25; x < x1 - 1; x += 2.5) add('dark', box(1.5, 0.52, 0.02, x, y, BZ + 0.76));
  }
  dinRail(0, -27, 27);
  dinRail(Y_TBRAIL, -10, 18);

  function duct(yc) {
    add('duct', box(DUCT_L, 4, 0.12, 0, yc, BZ + 0.06));
    for (const s of [-1, 1]) {
      const yw = yc + s * 1.89;
      add('duct', box(DUCT_L, 0.22, 0.9, 0, yw, BZ + 0.45));
      for (let x = -DUCT_L / 2 + 0.3; x < DUCT_L / 2 - 0.3; x += 1.0) add('duct', box(0.6, 0.22, 3.05, x + 0.3, yw, BZ + 0.9 + 1.52));
    }
    add('duct', new RoundedBoxGeometry(DUCT_L + 0.2, 4.3, 0.24, 1, 0.08), mtx(0, yc, BZ + 4.12));
  }
  duct(Y_TOPDUCT); duct(Y_MIDDUCT); duct(Y_BOTDUCT);

  // ---------- modules ----------
  const screwPos = [], openPos = [], ferrules = [], wires = [];
  const leds = [];   // {m, lx, ly, kind, key, tag, addr, chan, label}
  const C = {
    DI: '#2a5bd7', DO: '#1c1f24', AI: '#8d939a', P24: '#c8322b', M0: '#9cc3ea', PE: '#3f9b4a', L: '#6b3e26', N: '#2b5fb8',
  };
  const ferruleColor = { DI: '#f2f2f0', DO: '#f2f2f0', AI: '#9aa0a6', P24: '#d63a2f', M0: '#d63a2f', PE: '#d63a2f', L: '#3a3d42', N: '#3a3d42' };

  function wireUp(x, y0, z0, fn, dir) { // dir +1 to top duct, -1 to mid duct (from module strips)
    const yD = dir > 0 ? Y_TOPDUCT : Y_MIDDUCT;
    const sx = snapSlot(x + (Math.random() - 0.5) * 0.6);
    const pts = [
      [x, y0, z0], [x, y0 + dir * 0.9, z0 + 0.05], [x * 0.6 + sx * 0.4, yD - dir * 3.6, z0 - 0.9],
      [sx, yD - dir * 2.05, 3.0], [sx, yD - dir * 0.6, 1.9], [sx + (x < 0 ? -1.4 : 1.4), yD + dir * 0.4, 1.3],
    ];
    wires.push({ pts, color: C[fn] });
    ferrules.push({ x, y: y0 + dir * 0.22, z: z0, c: ferruleColor[fn] });
  }

  MODS.forEach((m) => {
    const d = m.fz - BZ, zc = (m.fz + BZ) / 2;
    add('body', new RoundedBoxGeometry(m.w - 0.06, 10, d, 2, 0.22), mtx(m.cx, 0, zc));
    // terminal strips top/bottom
    for (const s of [-1, 1]) {
      add('strip', new RoundedBoxGeometry(m.w - 0.3, 1.5, 0.6, 1, 0.08), mtx(m.cx, s * 4.15, m.fz + 0.06));
      const n = Math.floor((m.w - 0.5) / m.pitch);
      for (let i = 0; i < n; i++) {
        const tx = m.cx - ((n - 1) * m.pitch) / 2 + i * m.pitch;
        screwPos.push([tx, s * 4.0, m.fz + 0.37, m.pitch > 0.6 ? 1.6 : 1]);
        openPos.push([tx, s * 4.9, m.fz + 0.08, m.pitch > 0.6 ? 1.6 : 1]);
      }
      m['tx' + (s > 0 ? 'T' : 'B')] = (i) => m.cx - ((n - 1) * m.pitch) / 2 + i * m.pitch;
    }
    const L = (lx, ly, kind, k, extra = {}) => leds.push(Object.assign({ m, lx, ly, kind, key: k }, extra));
    if (m.id === 'DI' || m.id === 'DO') {
      const list = m.id === 'DI' ? o.inputs : o.outputs, pre = m.id === 'DI' ? 'I' : 'Q';
      for (let ch = 0; ch < 16; ch++) {
        const col = ch < 8 ? 0 : 1, row = ch % 8, t = list[ch];
        L(col ? 0.35 : -1.45, 2.25 - row * 0.6, 'io', `${m.id}${ch}`, { tag: t ? t[0] : null, addr: t ? t[1] : null, chan: `${pre}${col}.${row}`, label: `${col}.${row}`, io: m.id });
        if (t) wireUp(m[col ? 'txB' : 'txT'](row + 1), col ? -4.9 : 4.9, m.fz + 0.08, m.id, col ? -1 : 1);
      }
      wireUp(m.txT(0), 4.9, m.fz + 0.08, m.id === 'DI' ? 'M0' : 'P24', 1);
      L(1.55, 2.85, 'status', 'DIAG');
    } else if (m.id === 'AI') {
      for (let ch = 0; ch < 4; ch++) {
        L(-1.45, 2.25 - ch * 0.6, 'io', `AI${ch}`, { tag: o.analog[ch], addr: `%IW${64 + 2 * ch}`, chan: `IW${64 + 2 * ch}`, label: `AI${ch}`, io: 'AI' });
        wireUp(m.txT(ch + 1), 4.9, m.fz + 0.08, 'AI', 1);
      }
      wireUp(m.txT(0), 4.9, m.fz + 0.08, 'M0', 1);
      L(1.55, 2.85, 'status', 'DIAG');
    } else if (m.id === 'CPU') {
      L(-4.65, 2.55, 'status', 'RUN', { label: 'RUN/STOP' });
      L(-4.65, 1.95, 'status', 'ERR', { label: 'ERROR' });
      L(-4.65, 1.35, 'status', 'MAINT', { label: 'MAINT' });
      L(-4.45, -1.5, 'status', 'LINK', { label: 'LINK' });
      L(-3.35, -1.5, 'status', 'RXTX', { label: 'RX/TX' });
      wireUp(m.txT(0), 4.9, m.fz + 0.08, 'P24', 1); wireUp(m.txT(1), 4.9, m.fz + 0.08, 'M0', 1); wireUp(m.txT(2), 4.9, m.fz + 0.08, 'PE', 1);
      // RJ45 jack + plug + cable
      const jx = m.cx - 3.9, jy = -2.45;
      add('metal', box(1.45, 1.25, 0.36, jx, jy, m.fz + 0.18));
      add('dark', box(1.12, 0.92, 0.38, jx, jy - 0.04, m.fz + 0.19));
      add('plug', box(1.06, 0.86, 1.5, jx, jy - 0.04, m.fz + 0.95));
      add('cable', new RoundedBoxGeometry(0.95, 0.8, 1.1, 1, 0.12), mtx(jx, jy - 0.04, m.fz + 2.15));
      const cable = new THREE.CatmullRomCurve3([
        [jx, jy - 0.04, m.fz + 2.6], [jx, jy - 0.2, m.fz + 3.8], [jx - 0.8, -5.6, m.fz + 3.6], [jx - 1.4, -7.9, 5.0],
        [snapSlot(jx - 1.6), Y_MIDDUCT + 2.05, 3.0], [snapSlot(jx - 1.6), Y_MIDDUCT + 0.5, 1.8], [snapSlot(jx - 1.6) - 2, Y_MIDDUCT, 1.4],
      ].map((p) => new THREE.Vector3(...p)), false, 'centripetal');
      add('cable', new THREE.TubeGeometry(cable, 48, 0.24, 10, false));
      // SD slot + card edge
      add('dark', box(1.75, 0.22, 0.1, m.cx + 3.9, 2.15, m.fz + 0.03));
      add('sd', box(1.5, 0.1, 0.22, m.cx + 3.9, 2.15, m.fz + 0.05));
    } else if (m.id === 'PSU') {
      L(2.5, 2.6, 'status', 'DCOK', { label: 'DC OK' });
      add('metal', new THREE.CylinderGeometry(0.22, 0.22, 0.2, 20), mtx(m.cx + 2.5, 1.55, m.fz + 0.08, Math.PI / 2));
      add('dark', box(0.05, 0.32, 0.02, m.cx + 2.5, 1.55, m.fz + 0.19));
      ['P24', 'P24', 'M0', 'M0'].forEach((fn, i) => wireUp(m.txT(i), 4.9, m.fz + 0.08, fn, 1));
      ['L', 'N', 'PE'].forEach((fn, i) => wireUp(m.txB(i), -4.9, m.fz + 0.08, fn, -1));
    } else if (m.id === 'CM') {
      L(-1.0, 1.5, 'status', 'DIAG'); L(-1.0, 0.95, 'status', 'CMTX', { label: 'TX' }); L(-1.0, 0.4, 'status', 'CMRX', { label: 'RX' });
      add('metal', new RoundedBoxGeometry(1.35, 2.35, 0.45, 1, 0.12), mtx(m.cx + 0.3, -1.6, m.fz + 0.2));
      add('dark', new RoundedBoxGeometry(0.95, 1.95, 0.5, 1, 0.1), mtx(m.cx + 0.3, -1.6, m.fz + 0.22));
      add('metal', new THREE.CylinderGeometry(0.12, 0.12, 0.3, 10), mtx(m.cx + 0.3, -0.15, m.fz + 0.3, Math.PI / 2));
      add('metal', new THREE.CylinderGeometry(0.12, 0.12, 0.3, 10), mtx(m.cx + 0.3, -3.05, m.fz + 0.3, Math.PI / 2));
    }
  });

  // terminal blocks (field side), one per wired channel
  const blocks = [];
  o.inputs.forEach((t) => blocks.push({ fn: 'DI', name: t[0] }));
  o.outputs.forEach((t) => blocks.push({ fn: 'DO', name: t[0] }));
  for (let i = 0; i < 4; i++) blocks.push({ fn: 'AI', name: o.analog[i] || `AI${i}` });
  blocks.push({ fn: 'M0', name: '0V' }, { fn: 'M0', name: '0V' }, { fn: 'PE', name: 'PE' });
  const BW = 0.62, bx0 = -7.5;
  const blockGeo = mergeGeometries([box(BW - 0.04, 5.2, 3.0, 0, 0, 2.6), box(BW - 0.04, 2.0, 1.2, 0, 0, 4.7), box(BW - 0.04, 1.2, 0.6, 0, 1.9, 4.3), box(BW - 0.04, 1.2, 0.6, 0, -1.9, 4.3)]);
  const blockInst = new THREE.InstancedMesh(blockGeo, mat.block, blocks.length + 2);
  const blockCol = { DI: '#b9bdc2', DO: '#b9bdc2', AI: '#b9bdc2', M0: '#3b6fd8', PE: '#4f9e3c' };
  blocks.forEach((b, i) => {
    b.x = bx0 + i * BW;
    blockInst.setMatrixAt(i, mtx(b.x, Y_TBRAIL, 0));
    blockInst.setColorAt(i, new THREE.Color(blockCol[b.fn]).convertSRGBToLinear());
    openPos.push([b.x, Y_TBRAIL + 2.6, 3.3, 1], [b.x, Y_TBRAIL - 2.6, 3.3, 1]);
    const sx = snapSlot(b.x);
    wires.push({ color: C[b.fn], pts: [[b.x, Y_TBRAIL + 2.6, 3.3], [b.x, Y_TBRAIL + 3.3, 3.4], [sx, Y_MIDDUCT - 2.05, 3.0], [sx, Y_MIDDUCT - 0.6, 1.9], [sx + 1.2, Y_MIDDUCT + 0.3, 1.3]] });
    wires.push({ color: C[b.fn], pts: [[b.x, Y_TBRAIL - 2.6, 3.3], [b.x, Y_TBRAIL - 3.3, 3.4], [sx, Y_BOTDUCT + 2.05, 3.0], [sx, Y_BOTDUCT + 0.6, 1.9], [sx - 1.2, Y_BOTDUCT - 0.3, 1.3]] });
    ferrules.push({ x: b.x, y: Y_TBRAIL + 2.8, z: 3.3, c: ferruleColor[b.fn] }, { x: b.x, y: Y_TBRAIL - 2.8, z: 3.3, c: ferruleColor[b.fn] });
  });
  [bx0 - BW * 1.1, bx0 + blocks.length * BW + 0.08].forEach((x, k) => {
    blockInst.setMatrixAt(blocks.length + k, mtx(x, Y_TBRAIL, 0, 0, 0, 0, 1.6, 1.05, 1.05));
    blockInst.setColorAt(blocks.length + k, new THREE.Color('#5d636b').convertSRGBToLinear());
  });
  blockInst.castShadow = blockInst.receiveShadow = true; scene.add(blockInst);
  disposables.push(blockGeo);

  // wires merged with vertex colours
  const wireGeos = wires.map((w) => {
    const curve = new THREE.CatmullRomCurve3(w.pts.map((p) => new THREE.Vector3(...p)), false, 'centripetal');
    const g = new THREE.TubeGeometry(curve, 20, 0.075, 6, false);
    const c = new THREE.Color(w.color).convertSRGBToLinear(), n = g.attributes.position.count, arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.toArray(arr, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  });
  const wireMesh = new THREE.Mesh(mergeGeometries(wireGeos), mat.wire);
  wireGeos.forEach((g) => g.dispose());
  wireMesh.castShadow = true; scene.add(wireMesh); disposables.push(wireMesh.geometry);

  // merge static buckets
  for (const [k, list] of Object.entries(buckets)) {
    const g = mergeGeometries(list); list.forEach((x) => x.dispose());
    const mesh = new THREE.Mesh(g, mat[k]);
    mesh.castShadow = k !== 'plate'; mesh.receiveShadow = true;
    scene.add(mesh); disposables.push(g);
  }

  // instanced screws, openings, ferrules
  function instanced(geo, material, list, f, shadow = false) {
    const im = new THREE.InstancedMesh(geo, material, list.length);
    list.forEach((p, i) => f(im, p, i));
    im.castShadow = shadow; im.receiveShadow = true; scene.add(im); disposables.push(geo); return im;
  }
  instanced(new THREE.CylinderGeometry(0.13, 0.13, 0.06, 14), mat.metal, screwPos, (im, p, i) => im.setMatrixAt(i, mtx(p[0], p[1], p[2], Math.PI / 2, 0, 0, p[3], 1, p[3])));
  instanced(new THREE.BoxGeometry(0.26, 0.03, 0.26), mat.dark, openPos, (im, p, i) => im.setMatrixAt(i, mtx(p[0], p[1], p[2], 0, 0, 0, p[3], 1, p[3])));
  instanced(new THREE.CylinderGeometry(0.12, 0.105, 0.42, 10), mat.ferrule, ferrules, (im, p, i) => {
    im.setMatrixAt(i, mtx(p.x, p.y, p.z)); im.setColorAt(i, new THREE.Color(p.c).convertSRGBToLinear());
  }, true);

  // ---------- faceplate atlas ----------
  const atlas = document.createElement('canvas'); atlas.width = ATLAS_W; atlas.height = ATLAS_H;
  const actx = atlas.getContext('2d');
  const atlasTex = T(new THREE.CanvasTexture(atlas));
  atlasTex.colorSpace = THREE.SRGBColorSpace; atlasTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const faceMat = new THREE.MeshStandardMaterial({ map: atlasTex, roughness: 0.58, metalness: 0.02 }); disposables.push(faceMat);
  const faceGeos = MODS.map((m) => {
    const g = new THREE.PlaneGeometry(m.fw, FH);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, (m.ax + uv.getX(i) * m.fw * S) / ATLAS_W);
    return g.translate(m.cx, (FT + FB) / 2, m.fz + 0.006);
  });
  const faceMesh = new THREE.Mesh(mergeGeometries(faceGeos), faceMat); faceGeos.forEach((g) => g.dispose());
  faceMesh.receiveShadow = true; scene.add(faceMesh); disposables.push(faceMesh.geometry);

  // duct label strips + terminal markers (transparent canvases)
  const stripTop = labelStrip(DUCT_L, 1.0, (ctx, X) => {
    MODS.forEach((m) => tagLabel(ctx, X(m.cx), `${m.tag}  ${m.title}`));
    tagLabel(ctx, X(DUCT_L / 2 - 6.5), o.title, true);
  });
  stripTop.position.set(0, Y_TOPDUCT, BZ + 4.25); scene.add(stripTop);
  const stripMid = labelStrip(DUCT_L, 1.0, (ctx, X) => { tagLabel(ctx, X(bx0 + (blocks.length * BW) / 2 - 0.3), '-X1  FIELD TERMINALS  1–' + blocks.length); tagLabel(ctx, X(-20), '-W1  ETH  X1.P1'); });
  stripMid.position.set(0, Y_MIDDUCT, BZ + 4.25); scene.add(stripMid);
  const markers = markerStrip();
  markers.position.set(bx0 + ((blocks.length - 1) * BW) / 2, Y_TBRAIL, 5.31); scene.add(markers);

  // ---------- LEDs / halos / forced markers ----------
  leds.forEach((l, i) => { l.i = i; l.pos = new THREE.Vector3(l.m.cx + l.lx, l.ly, l.m.fz + 0.03); l.flash = 0; l.pulse = 0; });
  const ledGeo = new THREE.BoxGeometry(0.3, 0.18, 0.05);
  const ledMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  const ledIM = new THREE.InstancedMesh(ledGeo, ledMat, leds.length);
  leds.forEach((l, i) => { const s = l.kind === 'status' ? 1.15 : 1; ledIM.setMatrixAt(i, mtx(l.pos.x, l.pos.y, l.pos.z, 0, 0, 0, s, s, 1)); ledIM.setColorAt(i, new THREE.Color(0)); });
  scene.add(ledIM); disposables.push(ledGeo, ledMat);

  const haloTex = T(makeHaloTex());
  const haloMat = new THREE.MeshBasicMaterial({ map: haloTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const haloGeo = new THREE.PlaneGeometry(1, 1);
  const haloIM = new THREE.InstancedMesh(haloGeo, haloMat, leds.length);
  haloIM.renderOrder = 2; haloIM.frustumCulled = false; scene.add(haloIM); disposables.push(haloMat, haloGeo);
  leds.forEach((l, i) => haloIM.setColorAt(i, new THREE.Color(0)));

  const ioLeds = leds.filter((l) => l.kind === 'io');
  const hatchTex = T(makeHatchTex());
  const hatchMat = new THREE.MeshBasicMaterial({ map: hatchTex, transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -1 });
  const hatchGeo = new THREE.PlaneGeometry(1.02, 0.46);
  const hatchIM = new THREE.InstancedMesh(hatchGeo, hatchMat, ioLeds.length);
  hatchIM.renderOrder = 1; hatchIM.frustumCulled = false; scene.add(hatchIM); disposables.push(hatchMat, hatchGeo);

  // deploy sweep over CPU faceplate
  const cpu = MODS[2];
  const sweepMat = new THREE.ShaderMaterial({
    uniforms: { uT: { value: 0 }, uAmt: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: `uniform float uT,uAmt; varying vec2 vUv;
      void main(){ float p=fract(uT*0.42)*1.5-0.25; float d=vUv.x-p;
        float band=exp(-d*d*90.0)*0.55; float trail=d<0.0?exp(d*6.0)*0.16:0.0;
        float edge=smoothstep(0.0,0.06,vUv.y)*smoothstep(1.0,0.94,vUv.y);
        float bar=step(vUv.y,0.025)*step(vUv.x,clamp(p,0.0,1.0))*0.9;
        vec3 c=vec3(1.0,0.353,0.122);
        gl_FragColor=vec4(c*((band+trail)*edge+bar)*uAmt,1.0); }`,
  });
  const sweep = new THREE.Mesh(new THREE.PlaneGeometry(cpu.fw, FH), sweepMat);
  sweep.position.set(cpu.cx, (FT + FB) / 2, cpu.fz + 0.02); sweep.renderOrder = 3; sweep.visible = false; scene.add(sweep);
  disposables.push(sweep.geometry, sweepMat);

  // ---------- state ----------
  const state = { mode: 'STOP', version: '—', scanMs: null, deploying: false, tags: {}, forced: new Set(), lastIO: -1e9 };
  let focus = -1, hoverLed = null, t = 0;
  const modBoxes = MODS.map((m) => new THREE.Box3(new THREE.Vector3(m.cx - m.w / 2, -5.2, BZ), new THREE.Vector3(m.cx + m.w / 2, 5.2, m.fz + 0.6)));

  const isOn = (v) => v === true || (typeof v === 'number' && v !== 0);
  function fmt(v) { if (v === undefined || v === null) return '—'; if (typeof v === 'boolean') return v ? '1' : '0'; if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2); return String(v); }

  // ---------- faceplate drawing ----------
  function drawAtlas() { actx.clearRect(0, 0, ATLAS_W, ATLAS_H); MODS.forEach(drawFace); atlasTex.needsUpdate = true; }
  function drawFace(m) {
    const c = actx, X = (lx) => m.ax + (lx + m.fw / 2) * S, Y = (ly) => (FT - ly) * S;
    c.save(); c.beginPath(); c.rect(m.ax, 0, m.fw * S, FH * S); c.clip();
    const g = c.createLinearGradient(0, 0, 0, FH * S); g.addColorStop(0, '#363a40'); g.addColorStop(1, '#2a2e33');
    c.fillStyle = g; c.fillRect(m.ax, 0, m.fw * S, FH * S);
    c.strokeStyle = 'rgba(255,255,255,.07)'; c.lineWidth = 2; c.strokeRect(m.ax + 3, 3, m.fw * S - 6, FH * S - 6);
    const txt = (s, lx, ly, size, col = '#c7ccd2', align = 'left', wt = 500) => {
      c.font = `${wt} ${Math.round(size * S)}px ${MONO}`; c.fillStyle = col; c.textAlign = align; c.textBaseline = 'middle'; c.fillText(s, X(lx), Y(ly));
    };
    const win = (lx, ly, w = 0.44, h = 0.3) => { rr(c, X(lx) - (w * S) / 2, Y(ly) - (h * S) / 2, w * S, h * S, 4); c.fillStyle = '#121518'; c.fill(); c.strokeStyle = '#4b5158'; c.lineWidth = 1.5; c.stroke(); };
    leds.filter((l) => l.m === m).forEach((l) => win(l.lx, l.ly, l.kind === 'status' ? 0.5 : 0.44, l.kind === 'status' ? 0.34 : 0.3));
    const L = -m.fw / 2 + 0.3;
    if (m.id === 'DI' || m.id === 'DO' || m.id === 'AI') {
      txt(m.id === 'AI' ? 'AI 4' : `${m.id} 16`, L, 2.85, 0.32, '#eef0f2', 'left', 600);
      txt('DIAG', 1.15, 2.85, 0.17, '#8a929b', 'right');
      leds.filter((l) => l.m === m && l.kind === 'io').forEach((l) => txt(l.label, l.lx + 0.3, l.ly, 0.22, l.tag ? '#c7ccd2' : '#6b737c'));
      if (m.id === 'AI') { txt('0–10 V', 0.1, 1.65, 0.2, '#8a929b'); txt('13 bit', 0.1, 1.25, 0.2, '#8a929b'); }
      txt(m.id === 'DI' ? '24 V DC SINK' : m.id === 'DO' ? '24 V DC 0.5 A' : 'ANALOG IN', L, -2.45, 0.19, '#8a929b');
      txt(`MM 22${m.id === 'DO' ? 2 : m.id === 'DI' ? 1 : 1}-${m.id === 'AI' ? '4HF' : '1BH'}32`, L, -2.8, 0.17, '#6b737c');
      matrix(c, X(m.fw / 2 - 0.85), Y(-2.2), 0.6 * S, m.i);
    } else if (m.id === 'CPU') {
      ['RUN/STOP', 'ERROR', 'MAINT'].forEach((s, k) => txt(s, -4.3, 2.55 - k * 0.6, 0.2, '#c7ccd2'));
      txt('MM-1214', -2.4, 2.45, 0.78, '#f2f3f5', 'left', 600);
      txt('CPU 1214C · DC/DC/DC', -2.35, 1.6, 0.25, '#9aa2ab');
      txt('X50 · SD', 3.9, 2.62, 0.17, '#8a929b', 'center');
      // display
      rr(c, X(-2.4), Y(0.95), 6.9 * S, 1.75 * S, 8); c.fillStyle = '#0b0d0f'; c.fill(); c.strokeStyle = '#4b5158'; c.lineWidth = 2; c.stroke();
      const run = state.deploying ? 'LOADING' : state.mode;
      txt(run, -2.05, 0.5, 0.4, state.mode === 'FAULT' ? '#ff6b5a' : state.deploying ? ORANGE : '#e9fff1', 'left', 600);
      txt(`v ${state.version}`, 4.15, 0.5, 0.26, '#aeb6be', 'right');
      txt(state.scanMs != null ? `SCAN ${Number(state.scanMs).toFixed(1)} ms` : 'SCAN — ms', -2.05, -0.25, 0.24, '#8fa2b0');
      txt(`${state.forced.size ? 'FORCE ' + state.forced.size : 'NO FORCE'}`, 4.15, -0.25, 0.22, state.forced.size ? ORANGE : '#6b7a86', 'right');
      txt('LINK', -4.45, -1.1, 0.15, '#8a929b', 'center'); txt('RX/TX', -3.35, -1.1, 0.15, '#8a929b', 'center');
      txt('X1 P1 · ETH 100M', -2.85, -2.55, 0.2, '#9aa2ab');
      txt('MM 214-1AG40-0XB0', -2.85, -2.9, 0.17, '#6b737c');
      matrix(c, X(4.1), Y(-2.15), 0.72 * S, 7);
    } else if (m.id === 'PSU') {
      txt('MM-PS', L, 2.65, 0.5, '#f2f3f5', 'left', 600);
      txt('24 V DC · 2.5 A', L, 1.95, 0.28, '#c7ccd2');
      txt('IN 100–240 V AC 50/60 Hz', L, 1.45, 0.18, '#8a929b');
      txt('DC OK', 2.5, 2.2, 0.15, '#8a929b', 'center'); txt('ADJ', 2.5, 1.05, 0.15, '#8a929b', 'center');
      c.fillStyle = '#16191c';
      for (let k = 0; k < 13; k++) { rr(c, X(-2.85 + k * 0.45), Y(0.55), 0.2 * S, 2.6 * S, 6); c.fill(); }
      txt('-U1 · L N PE', L, -2.65, 0.18, '#6b737c');
    } else if (m.id === 'CM') {
      txt('CM', L, 2.75, 0.4, '#f2f3f5', 'left', 600); txt('RS-485', L, 2.2, 0.2, '#9aa2ab');
      ['DIAG', 'TX', 'RX'].forEach((s, k) => txt(s, -0.68, 1.5 - k * 0.55, 0.16, '#8a929b'));
      txt('X20', 0.3, -2.95, 0.16, '#8a929b', 'center');
    }
    c.restore();
  }

  function labelStrip(len, h, draw) {
    const PX = 40, cv = document.createElement('canvas'); cv.width = Math.round(len * PX); cv.height = Math.round(h * PX);
    const ctx = cv.getContext('2d'); const X = (x) => (x + len / 2) * PX;
    const tex = T(new THREE.CanvasTexture(cv)); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(len, h), new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.55 }));
    disposables.push(mesh.geometry, mesh.material);
    mesh.userData.redraw = () => { ctx.clearRect(0, 0, cv.width, cv.height); draw(ctx, X); tex.needsUpdate = true; };
    mesh.userData.redraw(); return mesh;
  }
  function tagLabel(ctx, x, s, dark = false) {
    ctx.font = `500 20px ${MONO}`; const w = ctx.measureText(s).width + 20;
    rr(ctx, x - w / 2, 6, w, 28, 3); ctx.fillStyle = dark ? '#1b1e22' : '#fbfbfa'; ctx.fill();
    ctx.strokeStyle = dark ? '#1b1e22' : '#c3c7cc'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = dark ? '#f1f2f4' : '#202327'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(s, x, 21);
  }
  function markerStrip() {
    const PX = 100, len = blocks.length * BW, h = 2.0, cv = document.createElement('canvas');
    cv.width = Math.round(len * PX); cv.height = h * PX; const ctx = cv.getContext('2d');
    const tex = T(new THREE.CanvasTexture(cv)); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(len, h), new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.6 }));
    disposables.push(mesh.geometry, mesh.material);
    mesh.userData.redraw = () => {
      ctx.clearRect(0, 0, cv.width, cv.height);
      blocks.forEach((b, i) => {
        const x = (i + 0.5) * BW * PX;
        rr(ctx, x - 26, 6, 52, 40, 4); ctx.fillStyle = '#fdfdfb'; ctx.fill();
        ctx.fillStyle = '#16181b'; ctx.font = `600 24px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i + 1), x, 27);
        ctx.save(); ctx.translate(x, 56); ctx.rotate(Math.PI / 2);
        ctx.font = `500 19px ${MONO}`; ctx.textAlign = 'left'; ctx.fillStyle = b.fn === 'M0' || b.fn === 'PE' ? '#f4f6f8' : '#2a2e33';
        ctx.fillText(b.name.length > 13 ? b.name.slice(0, 12) + '.' : b.name, 0, 0); ctx.restore();
      });
      tex.needsUpdate = true;
    };
    mesh.userData.redraw(); return mesh;
  }

  // ---------- overlay (tooltip + focus labels) ----------
  const ov = document.createElement('div'); ov.className = 'pm-ov'; host.appendChild(ov);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); ov.appendChild(svg);
  const tip = document.createElement('div'); tip.className = 'pm-tip'; ov.appendChild(tip);
  const stack = document.createElement('div'); stack.className = 'pm-stack'; ov.appendChild(stack);
  let stackItems = [];

  function buildStack(i) {
    stack.innerHTML = ''; svg.innerHTML = ''; stackItems = [];
    if (i < 0) { stack.style.opacity = 0; return; }
    const m = MODS[i];
    const hd = document.createElement('div'); hd.className = 'hd'; hd.textContent = `${m.tag} · ${m.title}`; stack.appendChild(hd);
    const list = leds.filter((l) => l.m === m && (l.kind === 'io' ? (l.tag || m.id === 'AI') : true));
    list.forEach((l) => {
      const el = document.createElement('div'); el.className = 'pm-lab';
      el.innerHTML = `<span class="d"></span><span class="c"></span><span class="n"></span><span class="v"></span>`;
      el.querySelector('.c').textContent = l.chan || '';
      el.querySelector('.n').textContent = l.tag || l.label || l.key;
      stack.appendChild(el);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      line.setAttribute('fill', 'none'); line.setAttribute('stroke', 'rgba(11,11,12,.28)'); line.setAttribute('stroke-width', '1');
      svg.appendChild(line);
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); dot.setAttribute('r', '2.2'); dot.setAttribute('fill', '#0B0B0C'); svg.appendChild(dot);
      stackItems.push({ l, el, line, dot, v: el.querySelector('.v') });
    });
    stack.style.opacity = 1;
  }

  function statusText(l) {
    switch (l.key) {
      case 'RUN': return state.deploying ? 'LOADING' : state.mode;
      case 'ERR': return state.mode === 'FAULT' ? 'ON' : 'off';
      case 'MAINT': return state.forced.size ? `FORCE ${state.forced.size}` : 'off';
      case 'LINK': return 'UP 100M';
      case 'RXTX': return performance.now() - state.lastIO < 400 ? 'ACT' : 'idle';
      case 'DCOK': return '24.1 V';
      case 'CMTX': case 'CMRX': return performance.now() - state.lastIO < 400 ? 'ACT' : 'idle';
      case 'DIAG': return state.mode === 'FAULT' ? 'FAULT' : 'OK';
    }
    return '';
  }

  // ---------- LED colours ----------
  const COL = {
    off: new THREE.Color('#1a211c'), green: new THREE.Color('#45ff7a'), amber: new THREE.Color('#ffb21f'), red: new THREE.Color('#ff3326'),
    offAmber: new THREE.Color('#2a2016'), offRed: new THREE.Color('#2a1614'), orange: new THREE.Color(ORANGE),
  };
  const tmpC = new THREE.Color(), tmpH = new THREE.Color();
  function ledState(l, now) {
    // returns [color, haloStrength]
    const blink = (hz) => Math.sin(now * 0.001 * Math.PI * 2 * hz) > 0;
    if (l.kind === 'io') {
      const v = l.tag != null ? state.tags[l.tag] : undefined;
      if (l.io === 'AI') { const on = typeof v === 'number' ? v > 0 : isOn(v); return on ? [COL.green, 0.6] : [COL.off, 0]; }
      return isOn(v) ? [COL.green, 0.85] : [COL.off, 0];
    }
    switch (l.key) {
      case 'RUN':
        if (state.deploying) return blink(2.2) ? [COL.green, 1] : [COL.amber, 0.8];
        if (state.mode === 'RUN') return [COL.green, 0.9];
        return [COL.amber, 0.8];
      case 'ERR': return state.mode === 'FAULT' ? (blink(1.6) ? [COL.red, 1] : [COL.offRed, 0]) : [COL.offRed, 0];
      case 'MAINT': return state.forced.size ? [COL.amber, 0.8] : [COL.offAmber, 0];
      case 'LINK': return [COL.green, 0.55 + 0.15 * Math.sin(now * 0.003)];
      case 'RXTX': case 'CMTX': case 'CMRX': {
        const act = now - state.lastIO < 400 || state.deploying;
        return act && Math.random() > 0.35 ? [COL.amber, 0.6] : [COL.offAmber, 0];
      }
      case 'DCOK': return [COL.green, 0.7];
      case 'DIAG': return state.mode === 'FAULT' ? (blink(1.6) ? [COL.red, 0.8] : [COL.offRed, 0]) : [COL.green, 0.5];
    }
    return [COL.off, 0];
  }
  function updateLeds(now, dt) {
    let hi = 0;
    for (const l of leds) {
      const [c, h] = ledState(l, now);
      l.flash = Math.max(0, l.flash - dt * 2.2); l.pulse = Math.max(0, l.pulse - dt * 1.3);
      tmpC.copy(c); if (l.pulse > 0) tmpC.lerp(COL.orange, l.pulse * 0.6);
      ledIM.setColorAt(l.i, tmpC);
      const s = Math.max(h, l.flash * 0.8, l.pulse) * (l.kind === 'status' ? 1.15 : 1);
      const sz = s > 0 ? 0.85 + s * 0.75 + l.pulse * 1.8 : 0.0001;
      haloIM.setMatrixAt(l.i, mtx(l.pos.x, l.pos.y, l.pos.z + 0.03, 0, 0, 0, sz, sz * 0.8, 1));
      tmpH.copy(l.pulse > 0.05 ? tmpC.copy(c).lerp(COL.orange, Math.min(1, l.pulse * 1.4)) : c).multiplyScalar(0.55 * Math.min(1, s + 0.2));
      haloIM.setColorAt(l.i, tmpH);
    }
    ledIM.instanceColor.needsUpdate = true; haloIM.instanceMatrix.needsUpdate = true; haloIM.instanceColor.needsUpdate = true;
    ioLeds.forEach((l, i) => {
      const f = l.tag && state.forced.has(l.tag);
      hatchIM.setMatrixAt(i, f ? mtx(l.pos.x + 0.22, l.pos.y, l.pos.z - 0.018) : mtx(0, -999, 0, 0, 0, 0, 0.0001, 0.0001, 1));
      if (f) hi++;
    });
    hatchIM.instanceMatrix.needsUpdate = true;
  }

  // ---------- camera ----------
  const camTarget = new THREE.Vector3(0, -6.5, 3), camPos = new THREE.Vector3(0, 0, 150);
  const goalT = new THREE.Vector3(), goalP = new THREE.Vector3();
  let fitDist = 120, first = true;
  function computeFit() {
    const vf = THREE.MathUtils.degToRad(camera.fov) / 2, a = camera.aspect;
    const W = 64, H = 47;
    fitDist = Math.max(H / 2 / Math.tan(vf), W / 2 / (Math.tan(vf) * a)) * 1.04 + 6;
  }
  function updateCamera(dt) {
    let az, el, d;
    if (focus < 0) {
      goalT.set(0, -6.5, 3);
      az = o.autoOrbit ? -0.1 + 0.2 * Math.sin(t * 0.05) : -0.1;
      el = 0.1 + 0.05 * Math.sin(t * 0.037 + 1);
      d = fitDist * (o.autoOrbit ? 1 + 0.035 * Math.sin(t * 0.031) : 1);
    } else {
      const m = MODS[focus], vf = THREE.MathUtils.degToRad(camera.fov) / 2;
      const span = Math.max(13, (m.w + 14) / camera.aspect);
      d = (span / 2) / Math.tan(vf) + m.fz;
      goalT.set(m.cx + Math.min(6, 2.4 + 9 / camera.aspect) * (camera.aspect > 1 ? 1 : 0.2), 0, m.fz);
      az = 0.16 + 0.04 * Math.sin(t * 0.08); el = 0.07 + 0.02 * Math.sin(t * 0.06);
    }
    goalP.set(goalT.x + d * Math.sin(az) * Math.cos(el), goalT.y + d * Math.sin(el), goalT.z + d * Math.cos(az) * Math.cos(el));
    const k = first ? 1 : 1 - Math.exp(-dt * (focus < 0 ? 1.6 : 2.4)); first = false;
    camTarget.lerp(goalT, k); camPos.lerp(goalP, k);
    camera.position.copy(camPos); camera.lookAt(camTarget);
  }

  // ---------- overlay update ----------
  const pv = new THREE.Vector3();
  let W = 1, H = 1;
  function project(v) { pv.copy(v).project(camera); return [(pv.x * 0.5 + 0.5) * W, (-pv.y * 0.5 + 0.5) * H]; }
  function updateOverlay() {
    if (focus >= 0 && stackItems.length) {
      const m = MODS[focus];
      const [rx] = project(new THREE.Vector3(m.cx + m.w / 2, 0, m.fz));
      const [, cy] = project(new THREE.Vector3(m.cx, 0.2, m.fz));
      const sh = stack.offsetHeight, sw = stack.offsetWidth;
      let sx = rx + 56; if (sx + sw > W - 12) sx = Math.max(12, W - sw - 12);
      const sy = Math.min(Math.max(12, cy - sh / 2), Math.max(12, H - sh - 12));
      stack.style.transform = `translate(${sx}px,${sy}px)`;
      const now = performance.now();
      stackItems.forEach((it) => {
        const l = it.l, [lx, ly] = project(l.pos);
        const r = it.el.offsetTop + it.el.offsetHeight / 2 + sy;
        const mx = sx - 22;
        it.line.setAttribute('d', `M${lx.toFixed(1)},${ly.toFixed(1)} C${(lx + mx) / 2},${ly.toFixed(1)} ${(lx + mx) / 2},${r} ${mx},${r} L${sx},${r}`);
        it.dot.setAttribute('cx', lx.toFixed(1)); it.dot.setAttribute('cy', ly.toFixed(1));
        let txt, on, forced = false;
        if (l.kind === 'io') { const v = l.tag != null ? state.tags[l.tag] : undefined; txt = fmt(v); on = isOn(v); forced = l.tag && state.forced.has(l.tag); }
        else { txt = statusText(l); on = /RUN|ON|ACT|OK|UP|V$|FORCE|LOADING/.test(txt) && txt !== 'off'; }
        if (it.v.textContent !== txt) it.v.textContent = txt;
        it.el.classList.toggle('on', !!on); it.el.classList.toggle('forced', !!forced); it.el.classList.toggle('flash', l.flash > 0.3 || l.pulse > 0.3);
      });
    }
    if (hoverLed) {
      const [x, y] = project(hoverLed.pos);
      const l = hoverLed; let html;
      if (l.kind === 'io') {
        const v = l.tag != null ? state.tags[l.tag] : undefined, f = l.tag && state.forced.has(l.tag);
        html = `<div class="r"><span>${l.tag || 'spare'}</span><span class="val ${isOn(v) ? 'on' : ''}">${fmt(v)}</span></div>
          <div class="r k"><span>${l.addr || '—'}</span><span>${l.m.tag} ${l.chan}</span></div>${f ? '<span class="fb">FORCED</span>' : ''}`;
      } else html = `<div class="r"><span>${l.label || l.key}</span><span class="val">${statusText(l)}</span></div><div class="r k"><span>${l.m.tag} · ${l.m.title}</span></div>`;
      if (tip._h !== html) { tip.innerHTML = html; tip._h = html; }
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      const tx = x + 16 + tw > W ? x - tw - 16 : x + 16;
      tip.style.transform = `translate(${tx}px,${Math.max(6, y - th / 2)}px)`; tip.style.opacity = 1;
    } else tip.style.opacity = 0;
  }

  // ---------- input ----------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let mouse = null;
  function onMove(e) {
    const r = renderer.domElement.getBoundingClientRect(); mouse = [e.clientX - r.left, e.clientY - r.top];
    let best = null, bd = 18 * 18;
    for (const l of leds) { const [x, y] = project(l.pos); const d = (x - mouse[0]) ** 2 + (y - mouse[1]) ** 2; if (d < bd) { bd = d; best = l; } }
    hoverLed = best;
    renderer.domElement.style.cursor = best || pickModule(e) >= 0 ? 'pointer' : 'default';
  }
  function pickModule(e) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    let hit = -1, hd = Infinity;
    modBoxes.forEach((b, i) => { const p = ray.ray.intersectBox(b, V); if (p) { const d = p.distanceTo(ray.ray.origin); if (d < hd) { hd = d; hit = i; } } });
    return hit;
  }
  let downAt = null;
  const onDown = (e) => { downAt = [e.clientX, e.clientY]; };
  function onUp(e) {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
    const i = hoverLed ? hoverLed.m.i : pickModule(e);
    focusModule(i === focus ? -1 : i);
  }
  const onLeave = () => { hoverLed = null; };
  const onKey = (e) => { if (e.key === 'Escape' && focus >= 0) focusModule(-1); };
  renderer.domElement.addEventListener('pointermove', onMove);
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointerup', onUp);
  renderer.domElement.addEventListener('pointerleave', onLeave);
  window.addEventListener('keydown', onKey);

  // ---------- sizing / loop / visibility ----------
  function resize() {
    W = Math.max(1, host.clientWidth); H = Math.max(1, host.clientHeight);
    renderer.setSize(W, H, false); camera.aspect = W / H; camera.updateProjectionMatrix(); computeFit();
  }
  const ro = new ResizeObserver(resize); ro.observe(host); resize();
  let inView = true, raf = 0, last = performance.now(), disposed = false;
  const io = new IntersectionObserver((en) => { inView = en[0].isIntersecting; kick(); }); io.observe(host);
  const onVis = () => kick(); document.addEventListener('visibilitychange', onVis);
  function running() { return !disposed && inView && !document.hidden; }
  function kick() { if (running() && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  function frame(now) {
    raf = 0; if (!running()) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt;
    updateCamera(dt); updateLeds(now, dt);
    sweepMat.uniforms.uT.value = t;
    const tgt = state.deploying ? 1 : 0; sweepMat.uniforms.uAmt.value += (tgt - sweepMat.uniforms.uAmt.value) * Math.min(1, dt * 3);
    sweep.visible = sweepMat.uniforms.uAmt.value > 0.01;
    renderer.render(scene, camera);
    updateOverlay();
    raf = requestAnimationFrame(frame);
  }

  drawAtlas(); stripTop.userData.redraw(); stripMid.userData.redraw(); markers.userData.redraw();
  renderer.shadowMap.needsUpdate = true;
  if (document.fonts) document.fonts.load(`500 20px "Geist Mono"`).then(() => document.fonts.ready).then(() => {
    if (disposed) return; drawAtlas(); stripTop.userData.redraw(); stripMid.userData.redraw(); markers.userData.redraw();
  });
  kick();

  // ---------- API ----------
  function setIO(snap = {}) {
    const tags = snap.tags || {};
    for (const l of ioLeds) if (l.tag != null && isOn(tags[l.tag]) !== isOn(state.tags[l.tag])) l.flash = 1;
    state.tags = Object.assign({}, tags);
    const nf = new Set(snap.forced || []);
    const changedF = nf.size !== state.forced.size || [...nf].some((x) => !state.forced.has(x));
    state.forced = nf; state.lastIO = performance.now();
    if (changedF) drawAtlasCPU();
  }
  function drawAtlasCPU() { drawFace(cpu); atlasTex.needsUpdate = true; }
  function setState(s = {}) {
    const prev = `${state.mode}|${state.version}|${state.scanMs}|${state.deploying}`;
    if (s.mode) state.mode = String(s.mode).toUpperCase();
    if (s.version !== undefined) state.version = String(s.version);
    if (s.scanMs !== undefined) state.scanMs = s.scanMs;
    if (s.deploying !== undefined) state.deploying = !!s.deploying;
    if (prev !== `${state.mode}|${state.version}|${state.scanMs}|${state.deploying}`) drawAtlasCPU();
  }
  function pulse(tag) { leds.forEach((l) => { if (l.tag === tag || l.key === tag) l.pulse = 1; }); }
  function focusModule(i) {
    if (typeof i === 'string') i = MODS.findIndex((m) => m.id === i.toUpperCase());
    i = i == null || i < 0 || i >= MODS.length ? -1 : i;
    if (i === focus) return; focus = i; buildStack(i);
    if (o.onFocus) o.onFocus(i, i >= 0 ? MODS[i].id : null);
  }
  function measure(n = 5) {
    const gl = renderer.getContext(); renderer.render(scene, camera); gl.finish();
    const t0 = performance.now(); for (let k = 0; k < n; k++) renderer.render(scene, camera); gl.finish();
    return { msPerRender: +((performance.now() - t0) / n).toFixed(2), drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  }
  function dispose() {
    disposed = true; cancelAnimationFrame(raf); ro.disconnect(); io.disconnect();
    document.removeEventListener('visibilitychange', onVis); window.removeEventListener('keydown', onKey);
    scene.traverse((ob) => { if (ob.isMesh && ob.geometry && !disposables.includes(ob.geometry)) ob.geometry.dispose(); });
    disposables.forEach((d) => d.dispose && d.dispose()); envTex.dispose();
    renderer.dispose(); renderer.forceContextLoss?.();
    renderer.domElement.remove(); ov.remove(); host.classList.remove('pm-host');
  }
  return { setIO, setState, pulse, focusModule, measure, dispose, modules: MODS.map((m) => m.id), get focused() { return focus; } };
}

// ---------- helpers ----------
function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
function matrix(c, x, y, size, seed) {
  const n = 12, cell = size / n; let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  c.fillStyle = 'rgba(220,225,230,.75)';
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const border = i === 0 || j === n - 1 || (i === n - 1 && j % 2 === 0) || (j === 0 && i % 2 === 1);
    if (border || rnd() > 0.52) c.fillRect(x + i * cell, y + j * cell, cell + 0.4, cell + 0.4);
  }
}
function makeNoiseTex() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 256; const c = cv.getContext('2d');
  c.fillStyle = '#ffffff'; c.fillRect(0, 0, 256, 256);
  const img = c.getImageData(0, 0, 256, 256);
  for (let i = 0; i < img.data.length; i += 4) { const v = 236 + Math.random() * 19; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; }
  c.putImageData(img, 0, 0);
  for (let k = 0; k < 90; k++) { c.fillStyle = `rgba(255,255,255,${0.15 + Math.random() * 0.2})`; c.beginPath(); c.arc(Math.random() * 256, Math.random() * 256, 4 + Math.random() * 18, 0, 7); c.fill(); }
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(5, 4); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function makeHaloTex() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64; const c = cv.getContext('2d');
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,.45)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g; c.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(cv);
}
function makeHatchTex() {
  const cv = document.createElement('canvas'); cv.width = 128; cv.height = 58; const c = cv.getContext('2d');
  c.save(); rr(c, 2, 2, 124, 54, 6); c.clip();
  c.strokeStyle = 'rgba(255,90,31,.55)'; c.lineWidth = 5;
  for (let x = -60; x < 190; x += 12) { c.beginPath(); c.moveTo(x, 60); c.lineTo(x + 58, 0); c.stroke(); }
  c.restore(); rr(c, 2, 2, 124, 54, 6); c.strokeStyle = '#FF5A1F'; c.lineWidth = 4; c.stroke();
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}
