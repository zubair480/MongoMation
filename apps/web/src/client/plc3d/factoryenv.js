// factoryenv.js — light-themed factory cell built AROUND the Sorting-by-Height line.
// buildFactoryEnv(scene, opts) -> { group, update(dt, t), dispose() }
// opts: quality ('high'|'low'), reducedMotion (bool), half (fence half-size, default 11.6)
// Static props are merged per material; repeats are InstancedMesh. Nothing here casts shadows;
// only the floor receives them. ~13 draw calls total.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const INK = 0x15171a, YELLOW = 0xf2c230, ORANGE = 0xff5a1f;

export function buildFactoryEnv(scene, opts = {}) {
  const low = opts.quality === 'low';
  const reduced = !!opts.reducedMotion;
  const H = typeof opts.half === 'number' ? opts.half : 11.6; // fence half-size
  const WALL = 34; // hall wall distance

  const group = new THREE.Group(); group.name = 'factory-env';
  const disposables = [];
  const track = o => { disposables.push(o); return o; };

  // ---------- canvas textures ----------
  function canvasTex(w, h, draw, { repeat = true, srgb = true, aniso = 8 } = {}) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = aniso;
    return track(t);
  }
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  // polished concrete, one 6 m slab per tile, saw-cut joint on two edges
  const SLAB = 6;
  const concreteTex = canvasTex(low ? 256 : 512, low ? 256 : 512, (g, w, h) => {
    g.fillStyle = '#eceef0'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 160; i++) { // tileable mottling
      const x = rnd() * w, y = rnd() * h, r = (0.04 + rnd() * 0.18) * w, dark = rnd() < 0.55;
      for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) {
        const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        gr.addColorStop(0, dark ? 'rgba(120,124,130,0.035)' : 'rgba(255,255,255,0.05)');
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr; g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
    const img = g.getImageData(0, 0, w, h), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const n = (rnd() - 0.5) * 7; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    g.putImageData(img, 0, 0);
    const px = Math.max(2, w / 256);
    g.fillStyle = 'rgba(21,23,26,0.22)'; g.fillRect(0, 0, w, px); g.fillRect(0, 0, px, h);
    g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(0, px, w, px * 0.6); g.fillRect(px, 0, px * 0.6, h);
  });
  concreteTex.repeat.set((WALL * 2) / SLAB, (WALL * 2) / SLAB);

  // yellow / ink 45° hatch, one tile = 0.6 m
  const hatchTex = canvasTex(64, 64, (g, w, h) => {
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = ((x + y) % 64) < 30, i = (y * w + x) * 4;
      img.data[i] = k ? 0x15 : 0xf2; img.data[i + 1] = k ? 0x17 : 0xc2; img.data[i + 2] = k ? 0x1a : 0x30; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  });

  // welded wire mesh (100 mm), alpha, mips fade it into a soft yellow veil at distance
  const meshTex = canvasTex(32, 32, (g, w, h) => {
    g.clearRect(0, 0, w, h); g.fillStyle = '#f2c230'; g.fillRect(0, 0, w, 4); g.fillRect(0, 0, 4, h);
  });
  meshTex.repeat.set(19, 17.5); // 100 mm cells on a ~1.9 x 1.75 m panel

  // hall wall: ribbed cladding, window band, dado; one tile = 6 m wide x 12 m tall
  const WALL_H = 12, WALL_TILE = 6;
  const wallTex = canvasTex(256, 512, (g, w, h) => {
    g.fillStyle = '#e6e9ec'; g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 16) { g.fillStyle = 'rgba(21,23,26,0.05)'; g.fillRect(x, 0, 3, h); g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(x + 3, 0, 2, h); }
    const y0 = h * 0.22, y1 = h * 0.42; // window band ~7-9.4 m
    g.fillStyle = '#c9ced4'; g.fillRect(0, y0 - 6, w, y1 - y0 + 12);
    const gr = g.createLinearGradient(0, y0, 0, y1); gr.addColorStop(0, '#fbfcfd'); gr.addColorStop(1, '#eef1f4');
    g.fillStyle = gr; g.fillRect(0, y0, w, y1 - y0);
    g.fillStyle = '#c9ced4'; for (let x = 0; x < w; x += 64) g.fillRect(x, y0, 5, y1 - y0); g.fillRect(0, (y0 + y1) / 2, w, 3);
    g.fillStyle = '#d6dadf'; g.fillRect(0, h * 0.9, w, h * 0.1); // dado
    g.fillStyle = 'rgba(21,23,26,0.12)'; g.fillRect(0, h * 0.9, w, 2);
  });
  wallTex.repeat.set((WALL * 2) / WALL_TILE, 1);

  // ---------- materials ----------
  const mat = {
    floor: new THREE.MeshStandardMaterial({ map: concreteTex, roughness: 0.38, metalness: 0, envMapIntensity: 0.55, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    paint: new THREE.MeshStandardMaterial({ color: YELLOW, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    hatch: new THREE.MeshStandardMaterial({ map: hatchTex, roughness: 0.65, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    yellow: new THREE.MeshStandardMaterial({ color: YELLOW, roughness: 0.5, metalness: 0.1 }),
    mesh: new THREE.MeshStandardMaterial({ map: meshTex, transparent: true, depthWrite: false, side: THREE.DoubleSide, roughness: 0.6 }),
    metal: new THREE.MeshStandardMaterial({ color: 0xc4c9cf, metalness: 0.5, roughness: 0.42 }),
    grey: new THREE.MeshStandardMaterial({ color: 0xdde0e4, roughness: 0.55 }), // RAL 7035-ish
    white: new THREE.MeshStandardMaterial({ color: 0xf7f7f8, roughness: 0.45 }),
    ink: new THREE.MeshStandardMaterial({ color: INK, roughness: 0.6, metalness: 0.15 }),
    wall: new THREE.MeshLambertMaterial({ map: wallTex }),
  };
  Object.values(mat).forEach(track);

  // ---------- merge builder ----------
  const bins = {}; let parent = new THREE.Matrix4();
  const _e = new THREE.Euler(), _q = new THREE.Quaternion();
  const M4 = (x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
    new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)).clone(), new THREE.Vector3(sx, sy, sz));
  function put(key, geo, m = new THREE.Matrix4()) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone(); geo.dispose();
    Object.keys(g.attributes).forEach(a => { if (!['position', 'normal', 'uv'].includes(a)) g.deleteAttribute(a); });
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(parent, m));
    (bins[key] ||= []).push(g);
  }
  const box = (key, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) => put(key, new THREE.BoxGeometry(w, h, d), M4(x, y, z, rx, ry, rz));
  const cyl = (key, rt, rb, h, x, y, z, rx = 0, ry = 0, rz = 0, seg = 16) => put(key, new THREE.CylinderGeometry(rt, rb, h, seg), M4(x, y, z, rx, ry, rz));
  function flat(key, w, d, x, z, y = 0.006, uvScale = 0) { // floor decal
    const g = new THREE.PlaneGeometry(w, d);
    if (uvScale) { const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / uvScale, uv.getY(i) * d / uvScale); }
    put(key, g, M4(x, y, z, -Math.PI / 2));
  }
  function at(x, z, ry, fn, y = 0) { const prev = parent; parent = prev.clone().multiply(M4(x, y, z, 0, ry, 0)); fn(); parent = prev; }

  // instanced collections
  const pallets = [];   // Matrix4
  const cartons = [];   // { m, c }
  const lamps = [];     // { m, mode, period, phase }
  const world = (m) => new THREE.Matrix4().multiplyMatrices(parent, m);
  const lamp = (mode, x, y, z, rx, ry, rz, sx, sy, sz, period = 1, phase = 0) => lamps.push({ m: world(M4(x, y, z, rx, ry, rz, sx, sy, sz)), mode, period, phase });

  // ---------- floor ----------
  const floorGeo = new THREE.PlaneGeometry(WALL * 2, WALL * 2);
  const floor = new THREE.Mesh(floorGeo, mat.floor); track(floorGeo);
  floor.rotation.x = -Math.PI / 2; floor.position.y = 0.003; floor.receiveShadow = true;
  group.add(floor);

  // walkway double lines around the cell (outside the fence) + forklift aisle ring
  const LW = 0.1;
  [12.6, 14.0].forEach(r => {
    flat('paint', r * 2 + LW, LW, 0, -r); flat('paint', r * 2 + LW, LW, 0, r);
    flat('paint', LW, r * 2, -r, 0); flat('paint', LW, r * 2, r, 0);
  });
  for (let i = 0; i < 5; i++) flat('paint', 0.22, 1.3, 4.05 + i * 0.42, 13.3); // zebra at the gate
  // forklift parking bay
  [[8.5, 14.7, 3.2, LW], [8.5, 18.3, 3.2, LW], [6.9, 16.5, LW, 3.6], [10.1, 16.5, LW, 3.6]].forEach(([x, z, w, d]) => flat('paint', w, d, x, z));
  // hatched keep-out zones: cabinet clearance + both discharge ends
  const hatchZone = (x, z, w, d) => {
    flat('hatch', w, d, x, z, 0.006, 0.6);
    flat('paint', w + LW, LW, x, z - d / 2, 0.007); flat('paint', w + LW, LW, x, z + d / 2, 0.007);
    flat('paint', LW, d, x - w / 2, z, 0.007); flat('paint', LW, d, x + w / 2, z, 0.007);
  };
  hatchZone(-5.5, -10.25, 2.2, 1.0);
  hatchZone(0, 9.1, 1.8, 1.1);
  hatchZone(0, -9.1, 1.8, 1.1);

  // ---------- safety fence ----------
  const N = 12, SEG = (H * 2) / N, PANEL_H = 1.75;
  let gateDone = false;
  const sides = [ // [cx, cz, ry, outward z sign for gate]
    { fixed: 'z', v: -H, ry: 0 }, { fixed: 'z', v: H, ry: 0 },
    { fixed: 'x', v: -H, ry: Math.PI / 2 }, { fixed: 'x', v: H, ry: Math.PI / 2 },
  ];
  sides.forEach(side => {
    for (let i = 0; i < N; i++) {
      const s0 = -H + i * SEG, c = s0 + SEG / 2;
      const px = side.fixed === 'z' ? s0 : side.v, pz = side.fixed === 'z' ? side.v : s0;
      box('yellow', 0.06, 2.0, 0.06, px, 1.0, pz); box('ink', 0.16, 0.012, 0.16, px, 0.006, pz);
      const cx = side.fixed === 'z' ? c : side.v, cz = side.fixed === 'z' ? side.v : c;
      const isGate = side.fixed === 'z' && side.v > 0 && !gateDone && c > 4 && c < 6;
      if (isGate) { gateDone = true; gateAt(s0, side.v); continue; }
      at(cx, cz, side.ry, () => fencePanel(SEG));
    }
  });
  // closing corner post
  box('yellow', 0.06, 2.0, 0.06, H, 1.0, H); box('ink', 0.16, 0.012, 0.16, H, 0.006, H);
  function fencePanel(w) {
    put('mesh', new THREE.PlaneGeometry(w - 0.06, PANEL_H), M4(0, 0.15 + PANEL_H / 2, 0));
    box('yellow', w - 0.06, 0.035, 0.035, 0, 1.93, 0); box('yellow', w - 0.06, 0.035, 0.035, 0, 0.14, 0);
  }
  function gateAt(x0, z) { // leaf swung open outward ~70°, interlock on the latch post
    at(x0, z, -1.2, () => { at(SEG / 2, 0, 0, () => { fencePanel(SEG); box('yellow', 0.035, PANEL_H, 0.035, SEG / 2 - 0.05, 1.03, 0); }); });
    box('yellow', 0.09, 0.16, 0.07, x0 + SEG - 0.08, 1.1, z - 0.06);
    box('ink', 0.05, 0.05, 0.02, x0 + SEG - 0.08, 1.14, z - 0.1);
  }

  // ---------- operator desk with HMI monitor ----------
  const screenCanvas = document.createElement('canvas'); screenCanvas.width = 512; screenCanvas.height = 320;
  const screenTex = track(new THREE.CanvasTexture(screenCanvas)); screenTex.colorSpace = THREE.SRGBColorSpace; screenTex.anisotropy = 4;
  function drawScreen(p) {
    const g = screenCanvas.getContext('2d');
    g.fillStyle = '#f4f5f7'; g.fillRect(0, 0, 512, 320);
    g.fillStyle = '#15171a'; g.fillRect(0, 0, 512, 30);
    g.fillStyle = '#ffffff'; g.font = '600 14px ui-monospace, monospace'; g.fillText('SORTING BY HEIGHT', 14, 20);
    g.strokeStyle = '#15171a'; g.lineWidth = 3; g.lineJoin = 'round';
    g.strokeRect(40, 160, 230, 36);        // entry belt
    g.strokeRect(270, 150, 56, 56);        // transfer
    g.strokeRect(278, 46, 40, 104);        // left lane
    g.strokeRect(278, 206, 40, 96);        // right lane
    g.lineWidth = 1.5; g.strokeStyle = '#9aa0a8';
    for (let x = 60; x < 270; x += 20) { g.beginPath(); g.moveTo(x, 162); g.lineTo(x, 194); g.stroke(); }
    g.setLineDash([4, 4]); g.beginPath(); g.moveTo(240, 140); g.lineTo(240, 216); g.stroke(); g.setLineDash([]); // height gate
    g.fillStyle = '#6b7178'; g.font = '500 12px ui-monospace, monospace';
    g.fillText('ENTRY', 44, 214); g.fillText('LEFT', 336, 60); g.fillText('RIGHT', 336, 296); g.fillText('GATE', 222, 134);
    // moving item marker along entry -> transfer -> lane (alternating)
    const k = p % 1, lane = Math.floor(p) % 2 ? -1 : 1;
    let x, y;
    if (k < 0.7) { x = 52 + (298 - 52) * (k / 0.7); y = 178; } else { x = 298; y = 178 + lane * ((k - 0.7) / 0.3) * 110; }
    g.fillStyle = '#ff5a1f'; g.fillRect(x - 7, y - 7, 14, 14);
    screenTex.needsUpdate = true;
  }
  drawScreen(0);
  const screenMat = track(new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false }));

  const DESK = { x: -7.4, z: 9.3 };
  at(DESK.x, DESK.z, 0, () => {
    box('white', 1.6, 0.04, 0.75, 0, 0.92, 0);
    [-0.72, 0.72].forEach(x => { box('ink', 0.06, 0.9, 0.06, x, 0.45, 0); box('ink', 0.06, 0.04, 0.68, x, 0.02, 0); });
    box('ink', 1.4, 0.05, 0.03, 0, 0.82, -0.3); // modesty rail
    // monitor
    box('ink', 0.05, 0.3, 0.05, 0, 1.1, -0.22); box('ink', 0.26, 0.015, 0.18, 0, 0.95, -0.22);
    box('ink', 0.64, 0.42, 0.04, 0, 1.38, -0.2, -0.08);
    box('ink', 0.44, 0.018, 0.15, 0, 0.95, 0.12); box('ink', 0.07, 0.018, 0.1, 0.32, 0.95, 0.14); // keyboard, mouse
    box('white', 0.24, 0.006, 0.32, -0.55, 0.943, 0.05, 0, 0.2);  // paper
    box('ink', 1.2, 0.012, 0.7, 0, 0.006, 0.85);                  // anti-fatigue mat
  });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.58, 0.36), screenMat); track(screen.geometry);
  screen.position.set(DESK.x, 1.38, DESK.z - 0.2 + 0.021); screen.rotation.x = -0.08;
  group.add(screen);

  // ---------- electrical control cabinet ----------
  at(-5.5, -11.05, 0, () => {
    box('ink', 1.6, 0.1, 0.5, 0, 0.05, 0);
    box('grey', 1.6, 1.9, 0.5, 0, 1.05, 0);
    box('grey', 1.66, 0.04, 0.56, 0, 2.02, 0);
    [-0.4, 0.4].forEach(x => {
      box('white', 0.78, 1.82, 0.02, x, 1.05, 0.26);
      box('ink', 0.3, 0.18, 0.01, x, 0.32, 0.275);               // louvre
      box('ink', 0.025, 0.2, 0.03, x > 0 ? x - 0.33 : x + 0.33, 1.1, 0.285); // handle
    });
    box('yellow', 0.16, 0.16, 0.012, 0.4, 1.45, 0.276);            // main isolator plate
    box('ink', 0.03, 0.12, 0.04, 0.4, 1.45, 0.29, 0, 0, 0.6);
    cyl('yellow', 0.09, 0.09, 0.006, 0.4, 1.75, 0.274, Math.PI / 2, 0, 0, 3); // warning sign
    box('ink', 0.18, 0.1, 0.012, -0.4, 1.8, 0.276);                 // nameplate
    // pilot lights (2 rows x 4)
    const modes = [['on'], ['on'], ['blink', 1.0, 0], ['off'], ['blink', 0.45, 0.2], ['off'], ['on'], ['blink', 2.2, 0.5]];
    modes.forEach(([mode, period = 1, phase = 0], i) => {
      const x = -0.64 + (i % 4) * 0.1, y = 1.6 - Math.floor(i / 4) * 0.1;
      cyl('ink', 0.032, 0.032, 0.012, x, y, 0.272, Math.PI / 2);
      lamp(mode, x, y, 0.282, Math.PI / 2, 0, 0, 0.022, 0.012, 0.022, period, phase);
    });
  });

  // ---------- overhead ladder cable tray (along the back fence) + drop to cabinet ----------
  const TZ = -H + 0.4, TY = 3.4, TX0 = -11.2, TX1 = 9;
  [-0.15, 0.15].forEach(dz => box('metal', TX1 - TX0, 0.08, 0.02, (TX0 + TX1) / 2, TY, TZ + dz));
  for (let x = TX0 + 0.15; x < TX1; x += 0.3) box('metal', 0.025, 0.012, 0.3, x, TY - 0.03, TZ);
  box('ink', TX1 - TX0 - 0.2, 0.045, 0.2, (TX0 + TX1) / 2, TY - 0.005, TZ);
  for (let x = TX0 + 0.6; x < TX1; x += 2.2) { cyl('metal', 0.008, 0.008, 2.6, x, TY + 1.3, TZ - 0.17, 0, 0, 0, 6); cyl('metal', 0.008, 0.008, 2.6, x, TY + 1.3, TZ + 0.17, 0, 0, 0, 6); box('metal', 0.04, 0.03, 0.4, x, TY - 0.06, TZ); }
  [-0.15, 0.15].forEach(dx => box('metal', 0.02, TY - 2.04, 0.08, -5.5 + dx, (TY + 2.04) / 2, TZ));
  box('ink', 0.2, TY - 2.04, 0.045, -5.5, (TY + 2.04) / 2, TZ);
  // branch along the left fence toward the operator desk
  const BX = -H + 0.4;
  [-0.12, 0.12].forEach(dx => box('metal', 0.02, 0.07, 20.4, BX + dx, TY, -0.8 + 0.4));
  for (let z = -10.8; z < 10; z += 0.3) box('metal', 0.24, 0.012, 0.025, BX, TY - 0.03, z);
  box('ink', 0.16, 0.04, 20.2, BX, TY - 0.005, -0.4);

  // ---------- high-bay lights (kept off the line's sightlines) ----------
  [[-13, -13], [-1.5, -15], [10, -13], [-15, -1], [-13, 13], [-1.5, 15], [10, 13], [16, 0], [22, -12], [22, 12], [-22, 0]].forEach(([x, z]) => {
    cyl('metal', 0.12, 0.4, 0.32, x, 7.3, z, 0, 0, 0, 24);
    cyl('grey', 0.07, 0.07, 0.12, x, 7.52, z, 0, 0, 0, 12);
    cyl('ink', 0.006, 0.006, 2.4, x, 8.78, z, 0, 0, 0, 4);
    lamps.push({ m: M4(x, 7.13, z, 0, 0, 0, 0.36, 0.02, 0.36), mode: 'white' });
  });

  // ---------- pallet racking (outside fence, +x) ----------
  const RX = 15.1, BAYS = 5, BAY = 2.8, RH = 4.6, LEVELS = [0, 1.55, 3.05];
  const rz0 = -(BAYS * BAY) / 2;
  for (let i = 0; i <= BAYS; i++) {
    const z = rz0 + i * BAY;
    [-0.5, 0.5].forEach(dx => box('metal', 0.08, RH, 0.08, RX + dx, RH / 2, z));
    for (let y = 0.4; y < RH - 0.4; y += 0.9) box('metal', 1.0, 0.025, 0.025, RX, y, z, 0, 0, (Math.floor(y / 0.9) % 2 ? 1 : -1) * 0.7);
    box('yellow', 0.18, 0.4, 0.18, RX - 0.62, 0.2, z); // upright protector
    box('ink', 0.14, 0.01, 0.14, RX + 0.5, 0.005, z);
  }
  for (let b = 0; b < BAYS; b++) {
    const zc = rz0 + b * BAY + BAY / 2;
    LEVELS.forEach((ly, li) => {
      if (ly > 0) [-0.5, 0.5].forEach(dx => box('ink', 0.05, 0.12, BAY - 0.08, RX + dx, ly - 0.06, zc));
      if (ly > 0) for (let k = -1; k <= 1; k += 2) box('metal', 1.0, 0.02, 0.05, RX, ly + 0.01, zc + k * 0.6);
      [-0.65, 0.65].forEach((dz, pi) => {
        if ((b * 7 + li * 3 + pi) % 6 === 5) return; // a few empty slots
        const base = ly + (ly > 0 ? 0.02 : 0);
        pallets.push(M4(RX, base, zc + dz, 0, Math.PI / 2, 0));
        loadPallet(RX, base + 0.144, zc + dz, Math.PI / 2, (b + li + pi) % 4 === 0 ? 'wrap' : 'box', li === 2 ? 2 : 3);
      });
    });
  }
  // end bollards
  [[RX - 0.9, rz0 - 0.5], [RX - 0.9, -rz0 + 0.5]].forEach(([x, z]) => { cyl('yellow', 0.08, 0.08, 1.0, x, 0.5, z, 0, 0, 0, 14); cyl('ink', 0.082, 0.082, 0.08, x, 0.75, z, 0, 0, 0, 14); });

  function loadPallet(x, y, z, ry, kind, layers) {
    const c = Math.cos(ry), s = Math.sin(ry);
    if (kind === 'wrap') { cartons.push({ m: M4(x, y + 0.55, z, 0, ry, 0, 1.18, 1.1, 0.78), c: 0xeef0f2 }); return; }
    const tones = [0xc9a273, 0xbf9868, 0xd2ad80, 0xc49b6c];
    for (let L = 0; L < layers; L++) for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
      const lx = -0.4 + i * 0.4, lz = -0.2 + j * 0.4;
      cartons.push({ m: M4(x + lx * c + lz * s, y + 0.15 + L * 0.31, z - lx * s + lz * c, 0, ry + (rnd() - 0.5) * 0.04, 0, 0.38, 0.3, 0.38), c: tones[Math.floor(rnd() * tones.length)] });
    }
  }

  // ---------- empty pallet stacks + a loaded pallet near the infeed ----------
  [[-9.7, -3.2, 9], [-9.7, -4.6, 6]].forEach(([x, z, n]) => {
    for (let k = 0; k < n; k++) pallets.push(M4(x + (rnd() - 0.5) * 0.04, k * 0.144, z + (rnd() - 0.5) * 0.04, 0, (rnd() - 0.5) * 0.03, 0));
  });
  pallets.push(M4(-9.7, 0, 2.4, 0, 0, 0)); loadPallet(-9.7, 0.144, 2.4, 0, 'box', 2);

  // ---------- forklift (parked, beacon on) ----------
  at(8.5, 16.6, Math.PI / 2, () => {
    box('white', 1.5, 0.55, 1.0, 0.05, 0.55, 0);
    box('ink', 0.45, 0.75, 1.02, -0.78, 0.62, 0);          // counterweight
    box('white', 0.9, 0.12, 0.96, 0.15, 0.88, 0);           // deck
    box('ink', 0.42, 0.1, 0.42, -0.25, 1.0, 0); box('ink', 0.08, 0.45, 0.42, -0.45, 1.25, 0); // seat
    box('ink', 0.05, 0.5, 0.05, 0.3, 1.15, 0, 0, 0, 0.35); cyl('ink', 0.16, 0.16, 0.03, 0.38, 1.4, 0, 0, 0, 0.35, 18);
    [[-0.6, -0.45], [-0.6, 0.45], [0.55, -0.45], [0.55, 0.45]].forEach(([x, z]) => box('ink', 0.05, 1.3, 0.05, x, 1.5, z));
    box('ink', 1.2, 0.04, 0.96, -0.02, 2.16, 0);
    for (let x = -0.45; x <= 0.45; x += 0.15) box('ink', 0.03, 0.05, 0.94, x, 2.14, 0);
    [-0.32, 0.32].forEach(z => box('ink', 0.08, 2.15, 0.1, 0.88, 1.1, z));
    box('ink', 0.08, 0.06, 0.74, 0.88, 2.15, 0); box('ink', 0.08, 0.06, 0.74, 0.88, 1.0, 0);
    box('ink', 0.06, 0.45, 0.9, 0.95, 0.32, 0);
    [-0.26, 0.26].forEach(z => { box('metal', 1.1, 0.04, 0.12, 1.53, 0.04, z); box('metal', 0.04, 0.45, 0.12, 0.99, 0.25, z); });
    [[0.55, 0.27, 0.48, 0.22], [0.55, 0.27, -0.48, 0.22], [-0.62, 0.2, 0.46, 0.18], [-0.62, 0.2, -0.46, 0.18]].forEach(([x, r, z, w]) => {
      cyl('ink', r, r, w, x, r, z, Math.PI / 2, 0, 0, 20); cyl('grey', r * 0.5, r * 0.5, w + 0.01, x, r, z, Math.PI / 2, 0, 0, 12);
    });
    cyl('ink', 0.07, 0.07, 0.04, -0.4, 2.2, 0.3, 0, 0, 0, 12);
    lamp('beacon', -0.4, 2.28, 0.3, 0, 0, 0, 0.06, 0.12, 0.06, 1.1, 0);
  });

  // ---------- floor-standing stack light at the gate ----------
  at(3.2, 10.7, 0, () => {
    cyl('ink', 0.18, 0.2, 0.04, 0, 0.02, 0, 0, 0, 0, 20);
    cyl('metal', 0.022, 0.022, 1.9, 0, 0.99, 0, 0, 0, 0, 10);
    cyl('ink', 0.065, 0.065, 0.05, 0, 1.96, 0, 0, 0, 0, 16);
    lamp('off', 0, 2.05, 0, 0, 0, 0, 0.06, 0.12, 0.06);
    lamp('off', 0, 2.18, 0, 0, 0, 0, 0.06, 0.12, 0.06);
    lamp('pulse', 0, 2.31, 0, 0, 0, 0, 0.06, 0.12, 0.06, 2.4, 0);
    cyl('ink', 0.065, 0.055, 0.04, 0, 2.39, 0, 0, 0, 0, 16);
  });

  // ---------- hall walls + columns (inward-facing only, so they vanish when orbiting outside) ----------
  const wallPlane = (x, z, ry) => {
    const g = new THREE.PlaneGeometry(WALL * 2, WALL_H);
    put('wall', g, M4(x, WALL_H / 2, z, 0, ry, 0));
  };
  wallPlane(0, -WALL, 0); wallPlane(0, WALL, Math.PI); wallPlane(-WALL, 0, Math.PI / 2); wallPlane(WALL, 0, -Math.PI / 2);
  for (let s = -WALL + 4; s <= WALL - 4; s += 12) {
    [[s, -WALL + 0.3], [s, WALL - 0.3], [-WALL + 0.3, s], [WALL - 0.3, s]].forEach(([x, z]) => box('metal', 0.4, WALL_H, 0.4, x, WALL_H / 2, z));
  }
  // crane-rail line along the long walls for depth
  box('metal', WALL * 2, 0.4, 0.3, 0, 9.6, -WALL + 0.6); box('metal', WALL * 2, 0.4, 0.3, 0, 9.6, WALL - 0.6);

  // ---------- assemble merged meshes ----------
  const meshes = [];
  for (const [key, geos] of Object.entries(bins)) {
    const merged = mergeGeometries(geos, false); geos.forEach(g => g.dispose());
    if (!merged) continue;
    track(merged);
    const m = new THREE.Mesh(merged, mat[key]);
    m.name = 'env-' + key; m.castShadow = false; m.receiveShadow = false;
    if (key === 'mesh') m.renderOrder = 2;
    group.add(m); meshes.push(m);
  }

  // pallets (instanced)
  const palletGeo = (() => {
    const gs = [];
    const add = (w, h, d, x, y, z) => { const g = new THREE.BoxGeometry(w, h, d).toNonIndexed(); g.translate(x, y, z); gs.push(g); };
    [-0.35, 0, 0.35].forEach(z => { add(1.2, 0.022, 0.1, 0, 0.011, z); add(1.2, 0.078, 0.1, 0, 0.061, z); });
    for (let i = 0; i < 7; i++) add(0.1, 0.022, 0.8, -0.55 + i * (1.1 / 6), 0.111 + 0.011, 0);
    const g = mergeGeometries(gs, false); gs.forEach(x => x.dispose()); return track(g);
  })();
  const woodMat = track(new THREE.MeshStandardMaterial({ color: 0xd2b98f, roughness: 0.85 }));
  const palletMesh = new THREE.InstancedMesh(palletGeo, woodMat, pallets.length);
  pallets.forEach((m, i) => palletMesh.setMatrixAt(i, m));
  palletMesh.name = 'env-pallets'; group.add(palletMesh);

  // cartons (instanced, per-instance tone)
  const cartonGeo = track(new THREE.BoxGeometry(1, 1, 1));
  const cartonMat = track(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 }));
  const cartonMesh = new THREE.InstancedMesh(cartonGeo, cartonMat, cartons.length);
  const _c = new THREE.Color();
  cartons.forEach((o, i) => { cartonMesh.setMatrixAt(i, o.m); cartonMesh.setColorAt(i, _c.setHex(o.c)); });
  cartonMesh.name = 'env-cartons'; group.add(cartonMesh);

  // lamps (instanced; unit cylinder scaled per instance)
  const lampGeo = track(new THREE.CylinderGeometry(1, 1, 1, 16));
  const lampMat = track(new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
  const lampMesh = new THREE.InstancedMesh(lampGeo, lampMat, lamps.length);
  const C_ON = new THREE.Color(ORANGE), C_OFF = new THREE.Color(0xd5d9de), C_WHITE = new THREE.Color(0xfffdf6), C_DIM = new THREE.Color(0xf3c2ad);
  const lampState = new Array(lamps.length).fill(null);
  function lampColor(l, t) {
    switch (l.mode) {
      case 'on': return C_ON; case 'off': return C_OFF; case 'white': return C_WHITE;
      case 'blink': return reduced || ((t + l.phase) % l.period) < l.period / 2 ? C_ON : C_OFF;
      case 'beacon': return reduced || ((t + l.phase) % l.period) < l.period * 0.35 ? C_ON : C_DIM;
      case 'pulse': return reduced || ((t + l.phase) % l.period) < l.period * 0.75 ? C_ON : C_DIM;
      default: return C_OFF;
    }
  }
  lamps.forEach((l, i) => { lampMesh.setMatrixAt(i, l.m); const c = lampColor(l, 0); lampMesh.setColorAt(i, c); lampState[i] = c; });
  lampMesh.name = 'env-lamps'; group.add(lampMesh);

  [palletMesh, cartonMesh, lampMesh].forEach(m => { m.castShadow = false; m.receiveShadow = false; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; });
  group.traverse(o => { o.updateMatrix(); o.matrixAutoUpdate = false; });
  group.updateMatrixWorld(true);
  scene.add(group);

  // ---------- runtime ----------
  let time = 0, screenAcc = 0;
  function update(dt = 0.016) {
    if (dt > 1) dt /= 1000; // tolerate ms
    time += dt;
    let dirty = false;
    for (let i = 0; i < lamps.length; i++) {
      const c = lampColor(lamps[i], time);
      if (c !== lampState[i]) { lampState[i] = c; lampMesh.setColorAt(i, c); dirty = true; }
    }
    if (dirty) lampMesh.instanceColor.needsUpdate = true;
    if (!reduced) { screenAcc += dt; if (screenAcc > 0.1) { screenAcc = 0; drawScreen(time / 4); } }
  }

  function dispose() {
    scene.remove(group);
    group.traverse(o => { if (o.isInstancedMesh) o.dispose(); });
    disposables.forEach(d => d.dispose && d.dispose());
    disposables.length = 0;
  }

  return { group, update, dispose };
}
