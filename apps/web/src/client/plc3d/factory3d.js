// factory3d.js — daylit 3D model of the "Sorting by Height (Basic)" line.
// API: createFactory(host, opts) -> { setShot, focusTag, setIO, applyPlant, clearPlant, pulse, setPaused, setLabels, dispose }
// setIO(snapshot) without boxes[] runs the HMI digital twin: boxes are reconstructed from the real rig tags.
// opts: reducedMotion, offset (0..1 multiplier for the left-UI projection shift, default 1),
//       quality ('high' | 'low' — low caps pixel ratio + shadow map for integrated GPUs), labels ('auto'|'all'|'none')
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { buildFactoryEnv } from './factoryenv.js';

const ORANGE = 0xff5a1f, FORCED = 0xf2b01e; // FORCED matches the .f3d-label.forced amber-orange

export function createFactory(host, opts = {}) {
  const reduced = !!opts.reducedMotion;
  const low = opts.quality === 'low', offScale = opts.offset ?? 1;
  let labelMode = opts.labels || 'auto';
  const W = () => host.clientWidth || innerWidth, H = () => host.clientHeight || innerHeight;

  // ---------- renderer / scene ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, low ? 1.25 : 2));
  renderer.setSize(W(), H());
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);

  const labels = new CSS2DRenderer();
  labels.setSize(W(), H());
  Object.assign(labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
  host.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  const BG = new THREE.Color(0xf6f7f9);
  scene.background = BG;
  scene.fog = new THREE.Fog(BG, 38, 90);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(32, W() / H(), 0.1, 400);
  camera.position.set(0, 46, 30);

  scene.add(new THREE.HemisphereLight(0xffffff, 0xdfe3e8, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(-14, 26, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(low ? 1024 : 2048, low ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 80 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
  scene.add(sun);

  // ---------- materials ----------
  const M = {
    alu: new THREE.MeshStandardMaterial({ color: 0xdfe3e8, metalness: 0.45, roughness: 0.35 }),
    aluDark: new THREE.MeshStandardMaterial({ color: 0xb4bac2, metalness: 0.4, roughness: 0.45 }),
    roller: new THREE.MeshStandardMaterial({ color: 0xeef0f3, metalness: 0.55, roughness: 0.25 }),
    yellow: new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.55 }),
    ink: new THREE.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.6 }),
    white: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }),
    lens: new THREE.MeshPhysicalMaterial({ color: 0x20242a, roughness: 0.05, metalness: 0.2, clearcoat: 1 }),
    floor: new THREE.MeshStandardMaterial({ color: 0xf4f5f7, roughness: 0.95 }),
    cardboard: new THREE.MeshStandardMaterial({ color: 0xc9a273, roughness: 0.85 }),
    cardboardTall: new THREE.MeshStandardMaterial({ color: 0xb8915f, roughness: 0.85 }),
    tape: new THREE.MeshStandardMaterial({ color: 0xe8d9bf, roughness: 0.6 }),
  };

  // procedural belt texture (rubber with cleats)
  function beltTexture() {
    const c = document.createElement('canvas'); c.width = 64; c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#2a2d31'; g.fillRect(0, 0, 64, 256);
    for (let i = 0; i < 256; i += 16) { g.fillStyle = '#1e2023'; g.fillRect(0, i, 64, 3); }
    for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(255,255,255,${Math.random() * 0.04})`; g.fillRect(Math.random() * 64, Math.random() * 256, 1, 1); }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
  }

  // ---------- floor: drafting-paper grid ----------
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), M.floor);
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const gridMinor = new THREE.GridHelper(80, 160, 0xe3e6ea, 0xe9ecef); gridMinor.position.y = 0.002;
  const gridMajor = new THREE.GridHelper(80, 16, 0xd3d8de, 0xd3d8de); gridMajor.position.y = 0.003;
  [gridMinor, gridMajor].forEach(g => { g.material.transparent = true; g.material.opacity = 0; scene.add(g); });
  // safety floor markings around the cell
  const markMat = new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.7 });
  [[0, -10.6, 22, .12], [0, 10.6, 22, .12], [-11, 0, .12, 21.3], [11, 0, .12, 21.3]].forEach(([x, z, w, d]) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.01, d), markMat); m.position.set(x, 0.005, z); scene.add(m);
  });

  // ---------- builders ----------
  const parts = []; // for reveal animation
  const reveal = (obj, delay, cat = 'process') => { obj.userData.reveal = { delay, y: obj.position.y, cat, t0: 0 }; parts.push(obj); return obj; };
  const CATS = ['process', 'sensors', 'actuators', 'panel', 'alarms']; let buildLevel = 5;
  const shadowAll = o => o.traverse(m => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });

  const belts = [];
  function conveyor({ len, x, z, rotY = 0, width = 1.3 }) {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rotY;
    const H = 0.85;
    // side rails
    [-1, 1].forEach(s => {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.22, 0.08), M.alu);
      rail.position.set(0, H + 0.04, s * (width / 2 + 0.04)); g.add(rail);
      const lip = new THREE.Mesh(new THREE.BoxGeometry(len, 0.04, 0.14), M.aluDark);
      lip.position.set(0, H + 0.16, s * (width / 2 + 0.06)); g.add(lip);
    });
    // belt
    const tex = beltTexture(); tex.repeat.set(1, len / 1.2); tex.rotation = Math.PI / 2; tex.center.set(.5, .5);
    const beltMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75 });
    const belt = new THREE.Mesh(new THREE.BoxGeometry(len, 0.06, width), beltMat);
    belt.position.y = H; g.add(belt); belts.push({ tex, len, on: true, key: null });
    // end drums
    [-1, 1].forEach(s => {
      const d = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, width + 0.02, 20), M.roller);
      d.rotation.x = Math.PI / 2; d.position.set(s * len / 2, H - 0.02, 0); g.add(d);
    });
    // legs + cross braces
    const n = Math.max(2, Math.round(len / 2.2) + 1);
    for (let i = 0; i < n; i++) {
      const lx = -len / 2 + 0.2 + (i * (len - 0.4)) / (n - 1);
      [-1, 1].forEach(s => {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, H, 0.08), M.aluDark);
        leg.position.set(lx, H / 2, s * (width / 2)); g.add(leg);
        const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.04, 12), M.ink);
        foot.position.set(lx, 0.02, s * (width / 2)); g.add(foot);
      });
      const brace = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, width), M.aluDark);
      brace.position.set(lx, 0.25, 0); g.add(brace);
    }
    // cable tray underneath
    const tray = new THREE.Mesh(new THREE.BoxGeometry(len * 0.9, 0.04, 0.25), M.alu);
    tray.position.set(0, 0.5, -width / 2 + 0.2); g.add(tray);
    shadowAll(g); scene.add(g); return { g, belt: belts[belts.length - 1] };
  }

  const tagObj = {};     // tag name -> { pos: Vector3, mesh, beam?, label }
  function makeLabel(name, addr) {
    const el = document.createElement('div');
    el.className = 'f3d-label';
    el.innerHTML = `<span class="n">${name}</span><span class="a">${addr}</span><span class="v">FALSE</span>`;
    const o = new CSS2DObject(el); o.center.set(0, 1.4);
    return o;
  }
  function sensor(name, addr, pos, beamDir, beamLen) {
    const g = new THREE.Group(); g.position.copy(pos);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, pos.y, 10), M.aluDark); post.position.y = -pos.y / 2; g.add(post);
    const body = new THREE.Mesh(new RoundedBoxGeometry(0.22, 0.3, 0.16, 3, 0.03), M.yellow); g.add(body);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.03, 20), M.lens);
    lens.rotation.z = Math.PI / 2; g.add(lens);
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 12), new THREE.MeshStandardMaterial({ color: 0x777777, emissive: 0x000000 }));
    led.position.set(0, 0.17, 0); g.add(led);
    // orient lens along beam dir
    g.lookAt(pos.clone().add(beamDir)); g.rotateY(-Math.PI / 2);
    shadowAll(g); scene.add(g); reveal(g, 0.9 + Math.random() * 0.4, 'sensors');
    const beamMat = new THREE.MeshBasicMaterial({ color: ORANGE, transparent: true, opacity: 0.12, depthWrite: false });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, beamLen, 8), beamMat);
    beam.position.copy(pos).add(beamDir.clone().multiplyScalar(beamLen / 2));
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), beamDir.clone().normalize());
    scene.add(beam);
    const label = makeLabel(name, addr); label.position.set(0, 0.25, 0); g.add(label); label.visible = false;
    tagObj[name] = { pos, group: g, beam, led, label, kind: 'sensor' }; g.userData.beam = beam;
  }

  // ---------- build the line ----------
  const entry = conveyor({ len: 7.8, x: -5.0, z: 0 }); entry.belt.key = 'Conveyor entry';
  const left = conveyor({ len: 6.8, x: 0, z: -4.8, rotY: Math.PI / 2 }); left.belt.key = 'Conveyor left';
  const right = conveyor({ len: 6.8, x: 0, z: 4.8, rotY: -Math.PI / 2 }); right.belt.key = 'Conveyor right';
  [entry, left, right].forEach((c, i) => reveal(c.g, 0.2 + i * 0.15));

  // chain transfer (roller table) at origin
  const xfer = new THREE.Group();
  const xbase = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.7, 2.2), M.alu); xbase.position.y = 0.42; xfer.add(xbase);
  const xRollers = [];
  for (let i = 0; i < 9; i++) {
    const r = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.9, 16), M.roller);
    r.rotation.x = Math.PI / 2; r.position.set(-0.9 + i * 0.225, 0.84, 0); xfer.add(r); xRollers.push(r);
  }
  const chains = [];
  [-0.5, 0.5].forEach(x => { const c = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, 2.0), M.ink); c.position.set(x, 0.8, 0); xfer.add(c); chains.push(c); });
  shadowAll(xfer); scene.add(xfer); reveal(xfer, 0.55);

  // height gate frame: the real sorter measures height at the end-stop (Pallet AND Low), so it sits beside the Pallet sensor.
  // Default x=-1.7; the plant-sim can move it with state.geometry.heightGateX (see setHeightGateX).
  const GATE_X0 = typeof opts.heightGateX === 'number' ? opts.heightGateX : -1.7;
  const gate = new THREE.Group(); gate.position.set(GATE_X0, 0, 0);
  [-1, 1].forEach(s => { const p = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.0, 0.1), M.aluDark); p.position.set(0, 1.0, s * 0.95); gate.add(p); });
  const top = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 2.0), M.aluDark); top.position.set(0, 2.0, 0); gate.add(top);
  shadowAll(gate); scene.add(gate); reveal(gate, 0.75);

  // sensors (positions match index.html sim coordinates)
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  sensor('Low sensor', '%QX12.5', V(GATE_X0, 1.12, -0.95), V(0, 0, 1), 1.9);
  sensor('High sensor', '%QX12.6'.replace('12.6', '12.4'), V(GATE_X0, 1.62, -0.95), V(0, 0, 1), 1.9);
  // Pallet eye on the far rail, just downstream of the gate posts, so the two never overlap
  sensor('Pallet sensor', '%QX12.6', V(GATE_X0 + 0.32, 1.0, 0.95), V(0, 0, -1), 1.9);
  sensor('Loaded', '%QX12.7', V(1.25, 1.1, 0), V(-1, 0, 0), 2.4);
  let gateX = GATE_X0;
  function setHeightGateX(x) { // move the gate frame + Low/High eyes (+ the Pallet eye beside them) along the entry belt
    if (typeof x !== 'number' || !isFinite(x) || Math.abs(x - gateX) < 1e-3) return;
    const dx = x - gateX; gateX = x; gate.position.x += dx;
    ['Low sensor', 'High sensor', 'Pallet sensor'].forEach(n => { const o = tagObj[n]; o.pos.x += dx; o.group.position.x += dx; o.beam.position.x += dx; });
  }
  sensor('At left entry', '%QX13.0', V(-0.95, 1.12, -2), V(1, 0, 0), 1.9);
  sensor('At left exit', '%QX13.1', V(-0.95, 1.12, -6.5), V(1, 0, 0), 1.9);
  sensor('At right entry', '%QX13.2', V(-0.95, 1.12, 2), V(1, 0, 0), 1.9);
  sensor('At right exit', '%QX13.3', V(-0.95, 1.12, 6.5), V(1, 0, 0), 1.9);

  // control panel + stack light
  const panel = new THREE.Group(); panel.position.set(-6.5, 0, 3.2); panel.rotation.y = -0.35;
  const ped = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.1, 0.18), M.aluDark); ped.position.y = 0.55; panel.add(ped);
  const box = new THREE.Mesh(new RoundedBoxGeometry(1.5, 0.95, 0.35, 3, 0.04), M.white); box.position.y = 1.55; box.rotation.x = -0.35; panel.add(box);
  const lampDefs = [['Start light', 0x2fb35a, -0.45], ['Reset light', 0xf2c230, 0], ['Stop light', 0xe0352b, 0.45]];
  const btnDefs = [['Start', 0x2fb35a, -0.45], ['Reset', 0x2f6fe0, 0], ['Stop', 0xe0352b, 0.45]];
  const face = new THREE.Group(); face.position.set(0, 1.55, 0); face.rotation.x = -0.35; panel.add(face);
  lampDefs.forEach(([n, c, x]) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.06, 20), new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0, roughness: 0.3 }));
    m.rotation.x = Math.PI / 2; m.position.set(x, 0.2, 0.19); face.add(m);
    tagObj[n] = { pos: V(-6.5, 1.8, 3.2), group: panel, lamp: m, kind: 'lamp' };
  });
  btnDefs.forEach(([n, c, x]) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.08, 24), new THREE.MeshStandardMaterial({ color: c, roughness: 0.4 }));
    m.rotation.x = Math.PI / 2; m.position.set(x, -0.15, 0.2); face.add(m);
    tagObj[n] = { pos: V(-6.5, 1.5, 3.2), group: panel, btn: m, kind: 'button' };
  });
  const es = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.13, 0.14, 24), new THREE.MeshStandardMaterial({ color: 0xd8261c, roughness: 0.35 }));
  es.position.set(0.95, 1.55, 0.1); es.rotation.z = Math.PI / 2; es.rotation.y = Math.PI / 2; panel.add(es);
  const esRing = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.04, 24), M.yellow);
  esRing.position.set(0.95, 1.55, 0.04); esRing.rotation.x = Math.PI / 2; panel.add(esRing);
  tagObj['Emergency stop'] = { pos: V(-6.0, 1.55, 3.4), group: panel, btn: es, kind: 'button' };
  // counter display
  const cCanvas = document.createElement('canvas'); cCanvas.width = 256; cCanvas.height = 96;
  const cTex = new THREE.CanvasTexture(cCanvas); cTex.colorSpace = THREE.SRGBColorSpace;
  const disp = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.26), new THREE.MeshBasicMaterial({ map: cTex }));
  disp.position.set(0, 0.0, 0.181); face.add(disp);
  tagObj['Counter'] = { pos: V(-6.5, 1.55, 3.2), group: panel, kind: 'counter' };
  function drawCounter(n) {
    const g = cCanvas.getContext('2d'); g.fillStyle = '#101214'; g.fillRect(0, 0, 256, 96);
    g.fillStyle = '#ff5a1f'; g.font = 'bold 64px ui-monospace, monospace'; g.textAlign = 'right'; g.fillText(String(n).padStart(4, '0'), 236, 72); cTex.needsUpdate = true;
  }
  drawCounter(0);
  shadowAll(panel); scene.add(panel); reveal(panel, 1.1, 'panel');

  // stack light near transfer
  const stack = new THREE.Group(); stack.position.set(1.6, 0, -1.6);
  const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.9, 10), M.aluDark); sp.position.y = 0.95; stack.add(sp);
  const stackLamps = [0x2fb35a, 0xf2c230, 0xe0352b].map((c, i) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.2, 20), new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0, transparent: true, opacity: 0.9, roughness: 0.2 }));
    m.position.y = 1.95 + i * 0.21; stack.add(m); return m;
  });
  shadowAll(stack); scene.add(stack); reveal(stack, 1.2, 'alarms');

  // actuator tags anchor positions
  tagObj['Conveyor entry'] = { pos: V(-5, 1, 0), kind: 'belt' };
  tagObj['Conveyor left'] = { pos: V(0, 1, -4.8), kind: 'belt' };
  tagObj['Conveyor right'] = { pos: V(0, 1, 4.8), kind: 'belt' };
  [['Conveyor entry', '%QX0.0', V(-7.4, 1.05, 0.9)], ['Conveyor left', '%QX0.5', V(0.9, 1.05, -7.6)], ['Conveyor right', '%QX0.6', V(0.9, 1.05, 7.6)], ['Counter', '%QW0', V(-6.5, 2.2, 3.2)]].forEach(([n, a, p]) => {
    const l = makeLabel(n, a); l.position.copy(p); l.visible = false; scene.add(l); tagObj[n].label = l;
  });
  ['Load', 'Unload', 'Transf. left', 'Transf. right'].forEach(n => tagObj[n] = { pos: V(0, 1, 0), kind: 'xfer' });
  tagObj['Auto'] = tagObj['Start'];

  // ---------- boxes ----------
  // Shared geometry/materials for every box (max ~20 live): a rounded cardboard body + packing tape over the lid
  // seam that folds down both flaps, plus a small shipping label. Only the body geometry differs between short/tall.
  const BOX_H = { short: 0.55, tall: 0.95 };
  const BG_GEO = {
    short: new RoundedBoxGeometry(0.75, BOX_H.short, 0.75, 3, 0.035),
    tall: new RoundedBoxGeometry(0.75, BOX_H.tall, 0.75, 3, 0.035),
    tapeTop: new THREE.BoxGeometry(0.762, 0.006, 0.17),
    tapeFlap: new THREE.BoxGeometry(0.006, 0.2, 0.17),
    seam: new THREE.BoxGeometry(0.74, 0.004, 0.012),
    label: new THREE.PlaneGeometry(0.22, 0.14),
  };
  M.seam = new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.9 });
  M.label = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.7 });
  const boxMeshes = new Map();
  function boxMesh(tall) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(tall ? BG_GEO.tall : BG_GEO.short, tall ? M.cardboardTall : M.cardboard);
    g.add(body);
    const lid = new THREE.Group(); g.add(lid); // sits on top of the body; follows the animated height
    const tt = new THREE.Mesh(BG_GEO.tapeTop, M.tape); tt.position.y = 0.003; lid.add(tt);
    [-1, 1].forEach(s => { const f = new THREE.Mesh(BG_GEO.tapeFlap, M.tape); f.position.set(s * 0.378, -0.1, 0); lid.add(f); });
    const seam = new THREE.Mesh(BG_GEO.seam, M.seam); seam.position.y = 0.007; lid.add(seam);
    const lbl = new THREE.Mesh(BG_GEO.label, M.label); lbl.position.set(0.12, -0.2, 0.3765); g.userData.lbl = lbl; g.add(lbl);
    g.userData.body = body; g.userData.lid = lid; g.userData.tall = !!tall;
    g.userData.h = tall ? BOX_H.tall : BOX_H.short; g.userData.hv = g.userData.h;
    layoutBox(g); shadowAll(g); return g;
  }
  function layoutBox(g) { // place body/lid/label for the current visual height hv
    const u = g.userData, full = u.tall ? BOX_H.tall : BOX_H.short;
    u.body.scale.y = u.hv / full; u.body.position.y = u.hv / 2; u.lid.position.y = u.hv; u.lbl.position.y = u.hv * 0.55;
  }
  function setBoxTall(g, tall) {
    const u = g.userData; if (u.tall === !!tall) return;
    u.tall = !!tall; u.body.geometry = tall ? BG_GEO.tall : BG_GEO.short; u.body.material = tall ? M.cardboardTall : M.cardboard;
    u.h = tall ? BOX_H.tall : BOX_H.short; layoutBox(g); // hv eases toward h in the frame loop
  }

  // ---------- IO state ----------
  // Idle until real data arrives: no boxes, no tags. setIO() (rig tags) is the only driver unless
  // opts.localSim is explicitly true (standalone demo), which runs a random local box simulation.
  let io = { tags: {}, boxes: [], running: false, fault: false };
  let localSim = opts.localSim === true, simT = 0, nid = 1, idleApplied = false;
  const localBoxes = [];
  function stepLocal(dt) { // used only when index.html isn't feeding setIO (scene-demo)
    simT += dt;
    if (simT > 2.6) { simT = 0; localBoxes.push({ id: nid++, seg: 'entry', x: -8.8, z: 0, tall: Math.random() < .5 }); }
    localBoxes.forEach(b => {
      if (b.seg === 'entry') { b.x += 1.5 * dt; if (b.x >= 0) { b.seg = 'xfer'; b.x = 0; } }
      else if (b.seg === 'xfer') { b.z += (b.tall ? 1 : -1) * 1.5 * dt; if (Math.abs(b.z) > 1.2) b.seg = b.z < 0 ? 'left' : 'right'; }
      else { b.z += (b.seg === 'left' ? -1 : 1) * 1.5 * dt; if (Math.abs(b.z) > 8.2) b.seg = 'gone'; }
    });
    for (let i = localBoxes.length - 1; i >= 0; i--) if (localBoxes[i].seg === 'gone') localBoxes.splice(i, 1);
    const near = (seg, k, v) => localBoxes.some(b => b.seg === seg && Math.abs(b[k] - v) < .35);
    io = { running: true, fault: false, boxes: localBoxes, tags: {
      'Low sensor': near('entry', 'x', gateX), 'High sensor': localBoxes.some(b => b.seg === 'entry' && b.tall && Math.abs(b.x - gateX) < .35),
      'Pallet sensor': localBoxes.some(b => b.seg === 'entry' && b.x > -1.9), 'Loaded': localBoxes.some(b => b.seg === 'xfer'),
      'At left entry': !near('left', 'z', -2), 'At left exit': !near('left', 'z', -6.5), 'At right entry': !near('right', 'z', 2), 'At right exit': !near('right', 'z', 6.5),
      'Conveyor entry': true, 'Conveyor left': true, 'Conveyor right': true, 'Start light': true, 'Counter': nid - 1 } };
  }

  function applyIO() {
    // boxes
    const seen = new Set();
    (io.boxes || []).forEach(b => {
      let m = boxMeshes.get(b.id);
      if (!m) { m = boxMesh(b.tall); m.scale.setScalar(reduced ? 1 : 0.01); scene.add(m); boxMeshes.set(b.id, m); }
      const tx = b.seg === 'left' || b.seg === 'right' ? 0 : b.x;
      m.userData.target = new THREE.Vector3(tx, 0.88, b.z);
      seen.add(b.id);
    });
    for (const [id, m] of boxMeshes) if (!seen.has(id)) { scene.remove(m); boxMeshes.delete(id); }
    applyTags();
  }

  // ---------- digital twin (HMI): boxes inferred from the REAL rig tags fed via setIO(snapshot) ----------
  // The rig only reports tags (no box positions), so boxes are reconstructed from edges in those tags:
  //   spawn   : Counter increased while 'Conveyor entry' runs, or a Low/Pallet sensor rising edge with no box already
  //             heading for the gate
  //   entry   : advance only while 'Conveyor entry' (or 'Load') is TRUE; queue behind the box ahead
  //   height  : a box that is at the gate while 'High sensor' is TRUE (or on its rising edge) becomes tall
  //   transfer: route by the real 'Transf. left' / 'Transf. right' outputs; if neither is seen for a while,
  //             fall back to the height mapping (learned from the outputs when they were seen; default tall→right)
  //   lanes   : advance only while 'Conveyor left' / 'Conveyor right' is TRUE; despawn at the belt end
  // Motion is integrated every frame at the belt speed with each conveyor's state eased (no snapping between
  // snapshots). With no snapshot, an offline rig (snap.online === false / ageMs >= 10 s) or no snapshot for
  // TWIN_STALE_MS, the line idles: belts stop and every box is cleared — nothing is invented.
  const TWIN = { SPEED: 1.5, GAP: 1.0, SPAWN_X: -8.4, XFER_IN: -1.15, LANE_IN: 1.45, LANE_END: 8.0, MAX: 20 };
  const TWIN_STALE_MS = 8000;
  let twinMode = false, twinOnline = false, twinLastAt = 0, twinPrev = null, twinNid = 1;
  const twinBoxes = []; // { id, seg: 'entry'|'xfer'|'left'|'right', x, z, tall, dir, wait, dying, mesh }
  const twinSpd = { entry: 0, left: 0, right: 0, xin: 0 }; // eased 0..1 belt motion factors
  const learned = { tall: 1, short: -1 }; // transfer direction per height (z sign), learned from real outputs
  let highRiseAt = -1e9;
  function twinAdd(tall) {
    if (twinBoxes.length >= TWIN.MAX) return null;
    const tail = twinBoxes.filter(b => b.seg === 'entry').reduce((m, b) => Math.min(m, b.x), Infinity);
    if (tail < TWIN.SPAWN_X + TWIN.GAP) return null; // entry is occupied: the belt can't hold another box yet
    const mesh = boxMesh(tall); mesh.scale.setScalar(reduced ? 1 : 0.01); mesh.position.set(TWIN.SPAWN_X, 0.88, 0); scene.add(mesh);
    const b = { id: twinNid++, seg: 'entry', x: TWIN.SPAWN_X, z: 0, tall: !!tall, dir: 0, wait: 0, dying: 0, mesh };
    twinBoxes.push(b); return b;
  }
  function twinClear() { twinBoxes.forEach(b => scene.remove(b.mesh)); twinBoxes.length = 0; }
  function twinMarkTall(b) { if (b && !b.tall) { b.tall = true; setBoxTall(b.mesh, true); } }
  function twinNearGate(maxD) {
    let best = null, bd = maxD;
    twinBoxes.forEach(b => { if (b.seg === 'entry' && Math.abs(b.x - gateX) < bd) { bd = Math.abs(b.x - gateX); best = b; } });
    return best;
  }
  function twinIngest(snap) { // called once per real snapshot
    const t = snap.tags || {};
    const ageOk = typeof snap.ageMs !== 'number' || snap.ageMs < 10000;
    const online = snap.online !== false && ageOk && Object.keys(t).length > 0;
    twinLastAt = performance.now();
    if (!online) { twinOnline = false; twinPrev = null; twinClear(); return; }
    twinOnline = true;
    const p = twinPrev; twinPrev = { ...t };
    if (!p) return; // first snapshot: establish the baseline, don't invent a backlog of boxes
    let spawned = false;
    const c = t['Counter'], pc = p['Counter'];
    // Counter only spawns while the entry belt really runs: on this rig Counter also ticks with the line stopped,
    // and a stopped belt can't take a new box, so nothing is invented while the line is idle.
    if (typeof c === 'number' && typeof pc === 'number' && c !== pc && !(c === 0 && pc > 0) && (t['Conveyor entry'] || p['Conveyor entry'])) spawned = !!twinAdd(false); // height is measured at the gate, not at spawn
    if (!spawned && ((t['Low sensor'] && !p['Low sensor']) || (t['Pallet sensor'] && !p['Pallet sensor']))) {
      const heading = twinBoxes.some(b => b.seg === 'entry' && b.x < gateX + 0.6);
      if (!heading) twinAdd(false);
    }
    if (t['High sensor'] && !p['High sensor']) { highRiseAt = performance.now(); twinMarkTall(twinNearGate(2.5)); }
    else if (t['High sensor']) twinMarkTall(twinNearGate(0.7));
    // learn the real height→side mapping from the transfer outputs
    const xb = twinBoxes.find(b => b.seg === 'xfer');
    if (xb && (t['Transf. left'] || t['Transf. right'])) learned[xb.tall ? 'tall' : 'short'] = t['Transf. left'] ? -1 : 1;
  }
  let twinClockAt = 0;
  function twinAdvance() { // integrate by wall-clock (fixed 50 ms substeps) so motion speed is right at any frame rate
    const now = performance.now(), el = twinClockAt ? Math.min(2, (now - twinClockAt) / 1000) : 0; twinClockAt = now;
    for (let left = el; left > 1e-4; left -= 0.05) stepTwin(Math.min(0.05, left));
  }
  function stepTwin(dt) {
    const now = performance.now();
    if (twinOnline && now - twinLastAt > TWIN_STALE_MS) { twinOnline = false; twinPrev = null; twinClear(); io = { tags: {}, running: false, fault: false, forced: [] }; applyTags(); }
    const t = twinOnline ? (io.tags || {}) : {};
    const ease = reduced ? 1 : 1 - Math.pow(0.002, dt); // ~0.25 s spin-up / coast-down
    const tgt = { entry: t['Conveyor entry'] ? 1 : 0, left: t['Conveyor left'] ? 1 : 0, right: t['Conveyor right'] ? 1 : 0, xin: t['Conveyor entry'] || t['Load'] ? 1 : 0 };
    for (const k in twinSpd) twinSpd[k] += (tgt[k] - twinSpd[k]) * ease;
    const v = TWIN.SPEED * dt;
    const xferBusy = twinBoxes.some(b => b.seg === 'xfer');
    // entry belt: head first so followers queue behind it
    const entryB = twinBoxes.filter(b => b.seg === 'entry').sort((a, b) => b.x - a.x);
    let ahead = Infinity;
    entryB.forEach((b, i) => {
      let limit = i === 0 ? (xferBusy ? TWIN.XFER_IN : 0) : ahead - TWIN.GAP;
      const spd = b.x > TWIN.XFER_IN ? twinSpd.xin : twinSpd.entry;
      const px = b.x;
      if (b.x < limit) b.x = Math.min(limit, b.x + v * spd);
      if (px < gateX && b.x >= gateX && (t['High sensor'] || now - highRiseAt < 1200)) twinMarkTall(b);
      if (i === 0 && b.x >= 0 && !xferBusy) { b.seg = 'xfer'; b.x = 0; b.wait = 0; b.dir = 0; }
      ahead = b.x;
    });
    // transfer: route by the real outputs, fall back to height after 1.5 s without one
    twinBoxes.filter(b => b.seg === 'xfer').forEach(b => {
      b.wait += dt;
      if (!b.dir) {
        if (t['Transf. left']) b.dir = -1; else if (t['Transf. right']) b.dir = 1;
        else if (b.wait > 1.5) b.dir = learned[b.tall ? 'tall' : 'short'];
      }
      if (!b.dir) return;
      const lane = b.dir < 0 ? 'left' : 'right';
      const laneTail = twinBoxes.filter(o => o.seg === lane).reduce((m, o) => Math.min(m, Math.abs(o.z)), Infinity);
      const drive = (b.dir < 0 ? t['Transf. left'] : t['Transf. right']) || twinSpd[lane] > 0.05 || b.wait > 1.5 ? 1 : 0;
      const limit = Math.min(TWIN.LANE_IN + 0.01, laneTail - TWIN.GAP);
      const az = Math.abs(b.z); if (az < limit) b.z = b.dir * Math.min(limit, az + v * drive);
      if (Math.abs(b.z) >= TWIN.LANE_IN) { b.seg = lane; }
    });
    // output lanes
    ['left', 'right'].forEach(lane => {
      const lb = twinBoxes.filter(b => b.seg === lane).sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
      let ahead2 = Infinity;
      lb.forEach(b => {
        const az = Math.abs(b.z), limit = b.dying ? Infinity : ahead2 - TWIN.GAP;
        const nz = Math.min(limit, az + v * twinSpd[lane]); if (nz > az) b.z = Math.sign(b.z || (lane === 'left' ? -1 : 1)) * nz;
        if (Math.abs(b.z) >= TWIN.LANE_END) b.dying = b.dying || 1e-6;
        ahead2 = b.dying ? Infinity : Math.abs(b.z);
      });
    });
    // render
    for (let i = twinBoxes.length - 1; i >= 0; i--) {
      const b = twinBoxes[i], m = b.mesh, u = m.userData;
      if (b.dying) { b.dying += dt; m.scale.setScalar(Math.max(0.01, 1 - b.dying / 0.35)); if (b.dying > 0.35) { scene.remove(m); twinBoxes.splice(i, 1); continue; } }
      else if (m.scale.x < 1) m.scale.setScalar(Math.min(1, m.scale.x + dt * 4));
      if (Math.abs(u.hv - u.h) > 1e-3) { u.hv += (u.h - u.hv) * (reduced ? 1 : 1 - Math.pow(0.001, dt)); layoutBox(m); }
      const onX = b.seg === 'xfer' || (b.seg === 'entry' && b.x > TWIN.XFER_IN + 0.3);
      m.position.set(b.seg === 'left' || b.seg === 'right' ? 0 : b.x, onX ? 0.9 : 0.88, b.z);
    }
    // transfer rollers / chains follow the real outputs
    const rs = Math.max(t['Load'] ? 1 : 0, twinBoxes.some(b => b.seg === 'entry' && b.x > TWIN.XFER_IN) ? twinSpd.xin : 0);
    if (rs > 0.02) xRollers.forEach(r => r.rotation.y += dt * 8 * rs);
    const cz = t['Transf. left'] ? -1 : t['Transf. right'] ? 1 : 0;
    chains.forEach(ch => { ch.position.y = 0.8 + (cz ? 0.06 : 0); });
  }

  // ---------- external plant state (server-side physics, ws plant-sim) ----------
  // applyPlant(state) is fed ~20 Hz frames from the plant simulator. Boxes are drawn exactly at the server-given
  // positions, interpolated between the two frames bracketing (now - PLANT_DELAY) so motion stays smooth at 60 fps.
  // No local simulation ever runs in this mode.
  const PLANT_DELAY = 110; // ms of render latency; ~2 frames at 20 Hz
  let plantMode = false;
  const plantFrames = []; // { at: performance.now(), boxes: Map(id -> box) }
  let lastTagsKey = '';
  function applyPlantState(state) {
    const now = performance.now();
    const boxes = new Map();
    (state.boxes || []).forEach(b => boxes.set(b.id, b));
    plantFrames.push({ at: now, boxes });
    if (state.geometry && typeof state.geometry.heightGateX === 'number') setHeightGateX(state.geometry.heightGateX);
    while (plantFrames.length > 2 && plantFrames[1].at < now - PLANT_DELAY - 400) plantFrames.shift();
    if (plantFrames.length > 12) plantFrames.shift();
    const t = state.tags || {};
    const estop = t['Emergency stop'] === false; // NC: FALSE = pressed/tripped
    io = { tags: t, boxes: [], running: !!t['Start light'], fault: estop || !!(state.plc && state.plc.connected === false) || !!state.error, forced: [] };
    const key = JSON.stringify(t) + io.running + io.fault;
    if (key !== lastTagsKey) { lastTagsKey = key; applyTags(); }
  }
  function stepPlant() {
    if (!plantFrames.length) return;
    const rt = performance.now() - PLANT_DELAY;
    let a = plantFrames[0], b = plantFrames[plantFrames.length - 1];
    for (let i = plantFrames.length - 1; i > 0; i--) {
      if (plantFrames[i - 1].at <= rt) { a = plantFrames[i - 1]; b = plantFrames[i]; break; }
    }
    if (rt >= b.at) a = b; // past the newest frame: hold the latest positions (no extrapolation)
    const k = a === b ? 1 : Math.max(0, Math.min(1, (rt - a.at) / (b.at - a.at)));
    const seen = new Set();
    for (const [id, nb] of b.boxes) {
      const ob = a.boxes.get(id) || nb;
      let m = boxMeshes.get(id);
      if (!m) { m = boxMesh(!!nb.tall); m.scale.setScalar(reduced ? 1 : 0.01); scene.add(m); boxMeshes.set(id, m); }
      m.userData.target = null; // plant mode positions directly, no easing
      if (m.scale.x < 1) m.scale.setScalar(Math.min(1, m.scale.x + 0.05));
      m.position.set(ob.x + (nb.x - ob.x) * k, 0.88, ob.z + (nb.z - ob.z) * k);
      seen.add(id);
    }
    for (const [id, m] of boxMeshes) if (!seen.has(id)) { scene.remove(m); boxMeshes.delete(id); }
  }

  function applyTags() {
    const t = io.tags || {};
    // sensors
    Object.entries(tagObj).forEach(([n, o]) => {
      const v = t[n];
      if (o.kind === 'sensor') {
        const retro = n.startsWith('At ');
        const active = retro ? v === false : !!v; // retro eyes are FALSE when blocked
        const forced = !!(io.forced && io.forced.includes(n));
        o.beam.material.color.setHex(forced ? FORCED : ORANGE);
        o.beam.material.opacity = active ? 0.85 : forced ? 0.45 : 0.14;
        o.beam.scale.set(active ? 2.2 : forced ? 1.6 : 1, 1, active ? 2.2 : forced ? 1.6 : 1);
        o.led.material.emissive.setHex(forced ? FORCED : active ? ORANGE : 0x000000); o.led.material.emissiveIntensity = forced || active ? 2 : 0;
        const vEl = o.label.element.querySelector('.v'); vEl.textContent = v ? 'TRUE' : 'FALSE'; o.label.element.classList.toggle('on', active);
      } else if (o.label) {
        const vEl = o.label.element.querySelector('.v'); vEl.textContent = typeof v === 'number' ? String(v).padStart(4, '0') : v ? 'TRUE' : 'FALSE';
        o.label.element.classList.toggle('on', typeof v === 'number' ? v > 0 : !!v);
      }
      if (o.label) o.label.element.classList.toggle('forced', !!(io.forced && io.forced.includes(n)));
      if (o.kind === 'lamp') o.lamp.material.emissiveIntensity = v ? 2.2 : 0;
    });
    belts.forEach(b => b.on = b.key ? !!t[b.key] : true);
    stackLamps[0].material.emissiveIntensity = io.running && !io.fault ? 1.8 : 0;
    stackLamps[1].material.emissiveIntensity = t['Reset light'] ? 1.8 : 0;
    stackLamps[2].material.emissiveIntensity = io.fault ? 1.8 : 0;
    if (typeof t['Counter'] === 'number') drawCounter(t['Counter']);
  }

  // ---------- background environment (plc3d/factoryenv.js, agent H2) ----------
  // Built once; survives detach/attach; disposed only in dispose(). Guarded so a failure never breaks the line.
  let envHandle = null;
  try { envHandle = buildFactoryEnv(scene, { quality: low ? 'low' : 'high', reducedMotion: reduced }); } catch (e) { console.warn('[factory3d] buildFactoryEnv failed', e); }

  // ---------- camera shots ----------
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.47; controls.minDistance = 3; controls.maxDistance = 80;
  let userT = 0; controls.addEventListener('start', () => userT = 1e9); controls.addEventListener('end', () => userT = 3);

  const SENSOR_TOUR = ['Low sensor', 'High sensor', 'Pallet sensor', 'Loaded', 'At left entry', 'At right entry', 'At left exit', 'At right exit'];
  let shot = 'overview', shotT = 0, tourI = 0, focus = null; let viewOff = 0.2;
  const camGoal = new THREE.Vector3(), lookGoal = new THREE.Vector3(), look = new THREE.Vector3(0, 0, 0);
  const descendPath = new THREE.CatmullRomCurve3([V(-2, 30, 22), V(-10, 14, 14), V(-13, 5, 7), V(-11, 2.6, 4.2)]);

  function shotGoal(dt) {
    shotT += dt;
    if (focus && tagObj[focus]) {
      const p = tagObj[focus].pos;
      const fd = opts.focusDistance || 1; camGoal.set(p.x + 3.2 * fd, p.y + 1.8 * fd, p.z + 3.6 * fd); lookGoal.copy(p); return;
    }
    if (shot === 'overview') {
      const a = (reduced ? 0.6 : shotT * 0.07) + 0.6, r = 15;
      camGoal.set(Math.cos(a) * r - 1.5, 21, Math.sin(a) * r); lookGoal.set(-1.5, 0, 0);
    } else if (shot === 'descend') {
      const k = Math.min(1, shotT / 3.5); const e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      camGoal.copy(descendPath.getPoint(e)); lookGoal.set(-3, 0.9, 0);
    } else if (shot === 'sensors') {
      if (shotT > 3.6 && !reduced) { shotT = 0; tourI = (tourI + 1) % SENSOR_TOUR.length; }
      const p = tagObj[SENSOR_TOUR[tourI]].pos;
      const side = p.x < -0.5 && Math.abs(p.z) < 1.5 ? V(2.2, 1.9, -4.6) : V(-4.6, 1.9, 2.0);
      camGoal.copy(p).add(side); lookGoal.copy(p);
    } else { // monitor
      camGoal.set(13, 15, 15); lookGoal.set(-1.5, 0, 0);
    }
    if ((shot === 'overview' || shot === 'monitor') && opts.shotScale) { // pull the wide shots closer (bigger stage)
      camGoal.sub(lookGoal).multiplyScalar(opts.shotScale).add(lookGoal);
    }
  }
  function updateLabels() {
    Object.entries(tagObj).forEach(([n, o]) => {
      if (!o.label) return;
      if (o.group && !o.group.visible) { o.label.visible = false; return; }
      o.label.visible = Array.isArray(labelMode) ? (labelMode.includes(n) || focus === n) : labelMode === 'none' ? focus === n : labelMode === 'all' || shot === 'monitor' || focus === n || (shot === 'sensors' && SENSOR_TOUR[tourI] === n);
      o.label.element.classList.toggle('focus', focus === n || (shot === 'sensors' && SENSOR_TOUR[tourI] === n));
    });
  }

  // label de-collision: every 250 ms hide labels whose screen boxes overlap a higher-priority one
  let declT = 0;
  function declutter() {
    const list = [];
    for (const [n, o] of Object.entries(tagObj)) {
      if (!o.label || !o.label.visible) continue;
      const el = o.label.element;
      list.push({ el, pri: (focus === n ? 10 : 0) + (el.classList.contains('focus') ? 5 : 0) + (el.classList.contains('forced') ? 4 : 0) + (el.classList.contains('on') ? 2 : 0) + (o.kind === 'sensor' ? 1 : 0), r: el.getBoundingClientRect() });
    }
    list.sort((a, b) => b.pri - a.pri);
    const kept = [];
    for (const it of list) {
      const r = it.r, hit = kept.some(k => r.left < k.right + 4 && r.right > k.left - 4 && r.top < k.bottom + 2 && r.bottom > k.top - 2);
      it.el.classList.toggle('dc', hit); if (!hit) kept.push(r);
    }
  }

  // ---------- loop ----------
  // reveal:false = machine fully built from the first frame; skipIntro = no reveal AND the camera starts at its shot
  // (no fly-in) — use it when re-creating the view for a page the user already saw.
  const skipIntro = !!opts.skipIntro;
  const noReveal = reduced || opts.reveal === false || skipIntro;
  const clock = new THREE.Clock(); let revealT = noReveal ? 99 : 0, raf = 0, hidden = false, paused = false, detached = false, snapCam = skipIntro;
  if (!noReveal) parts.forEach(p => { p.position.y = p.userData.reveal.y - 4; p.visible = false; });
  function frame() {
    if (hidden || paused || detached) { raf = 0; return; } // fully stop the loop while the tab is hidden; restarted by onVis
    raf = requestAnimationFrame(frame);
    const rawDt = clock.getDelta(), dt = Math.min(0.05, rawDt);
    if (plantMode) stepPlant();
    else if (twinMode) twinAdvance();
    else if (localSim) { stepLocal(dt); applyIO(); } else if (!idleApplied) { idleApplied = true; applyIO(); }
    // reveal
    revealT += Math.min(0.5, rawDt); // wall-clock: the reveal always completes in ~2 s even at a low frame rate
    const gk = Math.min(1, revealT / 1.0); gridMinor.material.opacity = 0.9 * gk; gridMajor.material.opacity = gk;
    gridMinor.scale.setScalar(0.2 + 0.8 * (1 - Math.pow(1 - gk, 3))); gridMajor.scale.copy(gridMinor.scale);
    parts.forEach(p => {
      const R = p.userData.reveal;
      const k = R.t0 == null ? 0 : reduced ? 1 : Math.max(0, Math.min(1, (revealT - R.t0 - (R.t0 === 0 ? R.delay : R.delay * 0.25)) / 0.7));
      p.visible = k > 0; const e = 1 - Math.pow(1 - k, 3);
      p.position.y = R.y - 4 * (1 - e);
      if (p.userData.beam) p.userData.beam.visible = k > 0.95;
    });
    if (envHandle && typeof envHandle.update === 'function') { try { envHandle.update(dt); } catch (e) { envHandle = null; } }
    // belts
    belts.forEach(b => { if (b.on) b.tex.offset.y -= dt * 1.5 / 1.2; });
    if (!twinMode && io.tags && io.tags['Load']) xRollers.forEach(r => r.rotation.y += dt * 8);
    // boxes ease to target
    for (const m of boxMeshes.values()) {
      if (!m.userData.target) continue;
      if (m.position.lengthSq() === 0) m.position.copy(m.userData.target);
      m.position.lerp(m.userData.target, 1 - Math.pow(0.0001, dt));
      if (m.scale.x < 1) m.scale.setScalar(Math.min(1, m.scale.x + dt * 3));
    }
    // camera
    shotGoal(dt); updateLabels();
    // shift the projection so the line sits to the right of the left-side UI panel
    const offGoal = focus ? 0.18 : ({ overview: 0.2, descend: 0.18, sensors: 0, monitor: 0.24 })[shot] ?? 0;
    viewOff += (offGoal - viewOff) * (reduced ? 1 : 1 - Math.pow(0.05, dt));
    camera.setViewOffset(W(), H(), -W() * viewOff * offScale, 0, W(), H());
    if (snapCam) { snapCam = false; camera.position.copy(camGoal); look.copy(lookGoal); viewOff = offGoal; }
    if (userT > 0) { userT -= dt; controls.update(); }
    else {
      const k = 1 - Math.pow(0.02, dt);
      camera.position.lerp(camGoal, reduced ? 1 : k); look.lerp(lookGoal, reduced ? 1 : k);
      camera.lookAt(look); controls.target.copy(look);
    }
    renderer.render(scene, camera); labels.render(scene, camera);
    declT += dt; if (declT > 0.25) { declT = 0; declutter(); }
  }
  frame();

  const onResize = () => { camera.aspect = W() / H(); camera.updateProjectionMatrix(); renderer.setSize(W(), H()); labels.setSize(W(), H()); };
  addEventListener('resize', onResize);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null; ro && ro.observe(host);
  const onVis = () => { hidden = document.hidden; clock.getDelta(); if (!hidden && !paused && !detached && !raf) frame(); };
  // While detached (canvas off-page) keep the twin advancing from setIO at 10 Hz without rendering, so boxes are
  // where the real rig implies when the view is re-attached.
  const bgTimer = setInterval(() => { if (twinMode && (detached || paused || hidden)) twinAdvance(); }, 100);
  document.addEventListener('visibilitychange', onVis);

  // click a sensor in 3D -> tell the page
  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
  renderer.domElement.addEventListener('click', e => {
    const r = renderer.domElement.getBoundingClientRect();
    mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    for (const [n, o] of Object.entries(tagObj)) {
      if (o.kind !== 'sensor') continue;
      if (ray.intersectObject(o.group, true).length) { window.selectIO ? window.selectIO(n) : api.focusTag(n); return; }
    }
  });

  // label styles
  if (!document.getElementById('f3d-style')) {
    const s = document.createElement('style'); s.id = 'f3d-style';
    s.textContent = `.f3d-label{display:flex;gap:10px;align-items:center;padding:6px 10px;background:rgba(255,255,255,.92);border:1px solid #E7E7E9;border-radius:4px;font:500 12px/1 "Geist Mono","IBM Plex Mono",ui-monospace,monospace;color:#0B0B0C;white-space:nowrap;box-shadow:0 4px 16px rgba(11,11,12,.06);transform-origin:left bottom;transition:transform .25s cubic-bezier(.2,.8,.2,1),border-color .2s}
.f3d-label .a{color:#8A8F98}.f3d-label .v{color:#8A8F98;letter-spacing:.04em}.f3d-label.on .v{color:#FF5A1F}
.f3d-label.focus{border-color:#0B0B0C;transform:scale(1.12)}
.f3d-label{transition:transform .25s cubic-bezier(.2,.8,.2,1),border-color .2s,opacity .25s}.f3d-label.dc{opacity:0}
.f3d-label.forced{border-color:#F2B01E;background:#FFF8E6}.f3d-label.forced .v{color:#8A5A00}.f3d-label.forced::after{content:"F";font:600 10px/1 "Geist Mono",monospace;color:#fff;background:#F2B01E;border-radius:2px;padding:2px 4px}
.f3d-label::before{content:"";width:6px;height:6px;border-radius:50%;background:#C9CDD3}.f3d-label.on::before{background:#FF5A1F;box-shadow:0 0 0 4px rgba(255,90,31,.15)}`;
    document.head.appendChild(s);
  }

  const api = {
    setShot(name) { if (name !== shot) { shot = name; shotT = 0; focus = null; } },
    focusTag(name) { focus = tagObj[name] ? name : null; },
    // setIO(snapshot): {tags, forced, running?, fault?, online?, ageMs?}. With an explicit boxes[] array the boxes are drawn
    // as given (legacy); otherwise the digital twin reconstructs boxes from the real tags (see stepTwin).
    setIO(snap) {
      if (!snap) return;
      localSim = false; plantMode = false; plantFrames.length = 0; idleApplied = true;
      if (Array.isArray(snap.boxes)) { if (twinMode) { twinMode = false; twinClear(); } io = snap; applyIO(); return; }
      twinMode = true;
      twinIngest(snap);
      io = twinOnline ? { tags: snap.tags || {}, boxes: [], running: !!snap.running, fault: !!snap.fault, forced: snap.forced || [] } : { tags: {}, boxes: [], running: false, fault: false, forced: [] };
      applyIO();
    },
    get twin() { return { online: twinOnline, spd: { ...twinSpd }, learned: { ...learned }, boxes: twinBoxes.map(b => ({ id: b.id, seg: b.seg, x: +b.x.toFixed(2), z: +b.z.toFixed(2), tall: b.tall, dir: b.dir })), tags: io.tags }; },
    get boxCount() { return twinMode ? twinBoxes.length : boxMeshes.size; },
    // external-state mode: render the server's plant (boxes + tags) exactly; never runs a local sim
    applyPlant(state) { if (!state) return; localSim = false; idleApplied = true; plantMode = true; if (twinMode) { twinMode = false; twinClear(); } applyPlantState(state); },
    // drop all boxes and frames (e.g. on disconnect) while staying in plant mode
    clearPlant() { plantFrames.length = 0; for (const m of boxMeshes.values()) scene.remove(m); boxMeshes.clear(); },
    setLabels(mode) { labelMode = mode; },
    setHeightGateX,
    // HMI build: 0..5 parts (process, sensors, actuators, panel, alarms) rise into place as they are bound
    setBuild(n) {
      n = Math.max(0, Math.min(5, n)); if (n === buildLevel) return;
      parts.forEach(p => { const R = p.userData.reveal, on = CATS.indexOf(R.cat) < n; if (on && R.t0 == null) R.t0 = revealT; if (!on) R.t0 = null; });
      buildLevel = n;
    },
    get build() { return buildLevel; },
    setPaused(b) { paused = !!b; clock.getDelta(); if (!paused && !hidden && !detached && !raf) frame(); },
    // detach(): take the canvas + label layer off the page and stop rendering; ALL state (boxes, twin, camera,
    // environment) is kept and the twin keeps advancing from setIO. attach(newHost): put the same canvas into
    // newHost, resize, and resume with no reveal/camera intro.
    detach() {
      if (detached) return; detached = true; cancelAnimationFrame(raf); raf = 0;
      ro && ro.disconnect();
      renderer.domElement.remove(); labels.domElement.remove();
      if (host && host.__f3d === api) delete host.__f3d;
    },
    attach(newHost) {
      if (!newHost) return;
      if (!detached && newHost === host) return;
      if (!detached) api.detach();
      host = newHost; host.appendChild(renderer.domElement); host.appendChild(labels.domElement); host.__f3d = api;
      ro && ro.observe(host); onResize();
      revealT = 99; parts.forEach(p => { if (p.userData.reveal.t0 == null && CATS.indexOf(p.userData.reveal.cat) < buildLevel) p.userData.reveal.t0 = 0; });
      detached = false; clock.getDelta(); if (!paused && !hidden && !raf) frame();
    },
    get attached() { return !detached; },
    get shot() { return shot; },
    pulse(name) { const o = tagObj[name]; if (o && o.btn) { o.btn.position.z -= 0.04; setTimeout(() => o.btn.position.z += 0.04, 180); } },
    dispose() { clearInterval(bgTimer); try { envHandle && typeof envHandle.dispose === 'function' && envHandle.dispose(); } catch (e) { /* ignore */ } twinClear(); cancelAnimationFrame(raf); hidden = true; ro && ro.disconnect(); detached = true; removeEventListener('resize', onResize); document.removeEventListener('visibilitychange', onVis); renderer.dispose(); renderer.domElement.remove(); labels.domElement.remove(); },
  };
  host.__f3d = api; // debug handle (inspection only)
  return api;
}
