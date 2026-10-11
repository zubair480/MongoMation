// factory3d.js — daylit 3D model of the "Sorting by Height (Basic)" line.
// API: createFactory(host, opts) -> { setShot, focusTag, setIO, pulse, setLabels, dispose }
// opts: reducedMotion, offset (0..1 multiplier for the left-UI projection shift, default 1),
//       quality ('high' | 'low' — low caps pixel ratio + shadow map for integrated GPUs), labels ('auto'|'all'|'none')
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const ORANGE = 0xff5a1f;

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

  // height gate frame at x=-4
  const gate = new THREE.Group(); gate.position.set(-4, 0, 0);
  [-1, 1].forEach(s => { const p = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.0, 0.1), M.aluDark); p.position.set(0, 1.0, s * 0.95); gate.add(p); });
  const top = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 2.0), M.aluDark); top.position.set(0, 2.0, 0); gate.add(top);
  shadowAll(gate); scene.add(gate); reveal(gate, 0.75);

  // sensors (positions match index.html sim coordinates)
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  sensor('Low sensor', '%QX12.5', V(-4, 1.12, -0.95), V(0, 0, 1), 1.9);
  sensor('High sensor', '%QX12.6'.replace('12.6', '12.4'), V(-4, 1.62, -0.95), V(0, 0, 1), 1.9);
  sensor('Pallet sensor', '%QX12.6', V(-1.7, 1.12, -0.95), V(0, 0, 1), 1.9);
  sensor('Loaded', '%QX12.7', V(1.25, 1.1, 0), V(-1, 0, 0), 2.4);
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
  const boxMeshes = new Map();
  function boxMesh(tall) {
    const h = tall ? 0.95 : 0.55;
    const g = new THREE.Group();
    const b = new THREE.Mesh(new RoundedBoxGeometry(0.75, h, 0.75, 3, 0.03), tall ? M.cardboardTall : M.cardboard);
    b.position.y = h / 2; g.add(b);
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.77, 0.005, 0.18), M.tape); t.position.y = h + 0.003; g.add(t);
    shadowAll(g); g.userData.h = h; return g;
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
      'Low sensor': near('entry', 'x', -4), 'High sensor': localBoxes.some(b => b.seg === 'entry' && b.tall && Math.abs(b.x + 4) < .35),
      'Pallet sensor': localBoxes.some(b => b.seg === 'entry' && b.x > -1.9), 'Loaded': localBoxes.some(b => b.seg === 'xfer'),
      'At left entry': !near('left', 'z', -2), 'At left exit': !near('left', 'z', -6.5), 'At right entry': !near('right', 'z', 2), 'At right exit': !near('right', 'z', 6.5),
      'Conveyor entry': true, 'Conveyor left': true, 'Conveyor right': true, 'Start light': true, 'Counter': nid - 1 } };
  }

  function applyIO() {
    const t = io.tags || {};
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
    // sensors
    Object.entries(tagObj).forEach(([n, o]) => {
      const v = t[n];
      if (o.kind === 'sensor') {
        const retro = n.startsWith('At ');
        const active = retro ? v === false : !!v; // retro eyes are FALSE when blocked
        o.beam.material.opacity = active ? 0.85 : 0.14;
        o.beam.scale.set(active ? 2.2 : 1, 1, active ? 2.2 : 1);
        o.led.material.emissive.setHex(active ? ORANGE : 0x000000); o.led.material.emissiveIntensity = active ? 2 : 0;
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
  const clock = new THREE.Clock(); let revealT = reduced ? 99 : 0, raf = 0, hidden = false, paused = false;
  if (!reduced) parts.forEach(p => { p.position.y = p.userData.reveal.y - 4; p.visible = false; });
  function frame() {
    if (hidden || paused) { raf = 0; return; } // fully stop the loop while the tab is hidden; restarted by onVis
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, clock.getDelta());
    if (localSim) { stepLocal(dt); applyIO(); } else if (!idleApplied) { idleApplied = true; applyIO(); }
    // reveal
    revealT += dt;
    const gk = Math.min(1, revealT / 1.0); gridMinor.material.opacity = 0.9 * gk; gridMajor.material.opacity = gk;
    gridMinor.scale.setScalar(0.2 + 0.8 * (1 - Math.pow(1 - gk, 3))); gridMajor.scale.copy(gridMinor.scale);
    parts.forEach(p => {
      const R = p.userData.reveal;
      const k = R.t0 == null ? 0 : reduced ? 1 : Math.max(0, Math.min(1, (revealT - R.t0 - (R.t0 === 0 ? R.delay : R.delay * 0.25)) / 0.7));
      p.visible = k > 0; const e = 1 - Math.pow(1 - k, 3);
      p.position.y = R.y - 4 * (1 - e);
      if (p.userData.beam) p.userData.beam.visible = k > 0.95;
    });
    // belts
    belts.forEach(b => { if (b.on) b.tex.offset.y -= dt * 1.5 / 1.2; });
    if (io.tags && io.tags['Load']) xRollers.forEach(r => r.rotation.y += dt * 8);
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
  const onVis = () => { hidden = document.hidden; clock.getDelta(); if (!hidden && !paused && !raf) frame(); };
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
    setIO(snap) { localSim = false; idleApplied = true; io = snap; applyIO(); },
    setLabels(mode) { labelMode = mode; },
    // HMI build: 0..5 parts (process, sensors, actuators, panel, alarms) rise into place as they are bound
    setBuild(n) {
      n = Math.max(0, Math.min(5, n)); if (n === buildLevel) return;
      parts.forEach(p => { const R = p.userData.reveal, on = CATS.indexOf(R.cat) < n; if (on && R.t0 == null) R.t0 = revealT; if (!on) R.t0 = null; });
      buildLevel = n;
    },
    get build() { return buildLevel; },
    setPaused(b) { paused = !!b; clock.getDelta(); if (!paused && !hidden && !raf) frame(); },
    get shot() { return shot; },
    pulse(name) { const o = tagObj[name]; if (o && o.btn) { o.btn.position.z -= 0.04; setTimeout(() => o.btn.position.z += 0.04, 180); } },
    dispose() { cancelAnimationFrame(raf); hidden = true; ro && ro.disconnect(); removeEventListener('resize', onResize); document.removeEventListener('visibilitychange', onVis); renderer.dispose(); host.innerHTML = ''; },
  };
  return api;
}
