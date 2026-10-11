// plcprops.js — set dressing for the PLC control room (what a real automation/electrical room has).
// Back wall: engineering workstation with SCADA screens, network rack, UPS, whiteboard, clock, posters, LOTO, extinguisher.
// Left wall: door + EXIT sign, fire alarm pull, thermostat, mini-split AC, spare-parts shelving, eyewash.
// Floor: rubber safety mats, tool cart, cable reel, step ladder, cone, drops from the cable ladder, hanging LED lights, dust.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Collapse every static mesh under `root` into one mesh per material (huge draw-call saving on integrated GPUs).
// Meshes flagged userData.dynamic (or under a flagged parent) are left alone.
export function mergeStatic(root) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const buckets = new Map(), victims = [];
  root.traverse(o => {
    if (!o.isMesh) return;
    for (let p = o; p && p !== root.parent; p = p.parent) if (p.userData.dynamic) return;
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) return;
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    const key = o.material.uuid; if (!buckets.has(key)) buckets.set(key, { m: o.material, gs: [], cast: false });
    const b = buckets.get(key); b.gs.push(g); b.cast ||= o.castShadow; victims.push(o);
  });
  victims.forEach(o => o.parent.remove(o));
  for (const { m, gs, cast } of buckets.values()) { const merged = new THREE.Mesh(mergeGeometries(gs), m); merged.castShadow = cast; merged.receiveShadow = true; root.add(merged); }
  return victims.length;
}

const std = (c, r = .6, m = 0, x = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m, ...x });
function tex(w, h, draw) { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; }

export function buildProps(scene, { backZ = -3.525, leftX = -5.225 } = {}) {
  const G = new THREE.Group(); scene.add(G);
  const anim = [];
  const box = (w, h, d, m, x, y, z, parent = G, ry = 0) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); o.rotation.y = ry; parent.add(o); return o; };
  const rbox = (w, h, d, r, m, x, y, z, parent = G) => { const o = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, r), m); o.position.set(x, y, z); parent.add(o); return o; };
  const cyl = (rt, rb, h, m, x, y, z, parent = G, seg = 20) => { const o = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m); o.position.set(x, y, z); parent.add(o); return o; };
  const M = {
    steel: std(0xb7bdc4, .35, .8), dark: std(0x26292e, .55, .2), black: std(0x121315, .5, .1), white: std(0xf7f7f5, .6),
    wood: std(0xc9a77c, .7), red: std(0xd0281f, .45, .1), yellow: std(0xf2c230, .55), green: std(0x1f8a4c, .5),
    rubber: std(0x2f3236, .95), conduit: std(0xcfd3d8, .35, .7), blue: std(0x2b5fc2, .5), orange: std(0xff5a1f, .5),
    cable: std(0x1a1b1d, .7), glass: new THREE.MeshPhysicalMaterial({ color: 0xdfe8ee, roughness: .05, transmission: .6, transparent: true, opacity: .5 }),
    cardboard: std(0xc29a6b, .85), chair: std(0x2d3035, .7), screenOff: std(0x0d0f12, .2, .3),
  };
  const glow = (c, i = 1.6) => std(c, .4, 0, { emissive: c, emissiveIntensity: i });
  // wall-face helpers
  const BZ = backZ, LX = leftX;
  const onBack = (w, h, m, x, y, d = .01) => box(w, h, d, m, x, y, BZ + d / 2);
  const onLeft = (w, h, m, z, y, d = .01) => box(d, h, w, m, LX + d / 2, y, z);

  // ---------- left wall + baseboards ----------
  const wallM = std(0xffffff, .95, 0, { emissive: 0xffffff, emissiveIntensity: .3 });
  { const lw = new THREE.Mesh(new THREE.PlaneGeometry(8.4, 3.2), wallM); lw.rotation.y = Math.PI / 2; lw.position.set(LX, 1.6, .6); G.add(lw); }
  box(10.4, .1, .02, M.dark, 0, .05, BZ + .01); box(.02, .1, 8.4, M.dark, LX + .01, .05, .6);
  // painted lower band (common in plant rooms)
  onBack(10.4, .9, std(0xe9ecef, .9), 0, .55, .004); onLeft(8.4, .9, std(0xe9ecef, .9), .6, .55, .004);

  // ---------- engineering workstation (back wall, left) ----------
  const desk = new THREE.Group(); desk.position.set(-3.6, 0, BZ + .45); G.add(desk);
  box(1.9, .04, .8, M.white, 0, .74, 0, desk); [-.9, .9].forEach(x => box(.04, .72, .74, M.steel, x, .37, 0, desk));
  box(1.8, .3, .02, M.steel, 0, .55, -.38, desk);
  const scadaTex = tex(512, 300, (g, w, h) => { g.fillStyle = '#f4f6f8'; g.fillRect(0, 0, w, h); g.fillStyle = '#0b0b0c'; g.font = '600 18px ui-monospace,monospace'; g.fillText('SORTING STATION · OVERVIEW', 16, 28);
    g.strokeStyle = '#3a3f46'; g.lineWidth = 10; g.beginPath(); g.moveTo(40, 160); g.lineTo(250, 160); g.moveTo(260, 60); g.lineTo(260, 260); g.stroke();
    g.fillStyle = '#ff5a1f'; [[120, 150], [200, 150], [260, 110]].forEach(([x, y]) => g.fillRect(x, y, 16, 16)); g.fillStyle = '#1f8a4c'; g.beginPath(); g.arc(440, 60, 12, 0, 7); g.fill();
    g.fillStyle = '#6b7079'; g.font = '14px ui-monospace,monospace'; ['Conveyor entry  RUN', 'Boxes sorted  0142', 'Jam timer  0.0 s'].forEach((s, i) => g.fillText(s, 320, 120 + i * 26)); });
  const trendTex = tex(512, 300, (g, w, h) => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); g.strokeStyle = '#e7e7e9'; for (let i = 0; i < 8; i++) { g.beginPath(); g.moveTo(0, 40 + i * 32); g.lineTo(w, 40 + i * 32); g.stroke(); }
    g.fillStyle = '#0b0b0c'; g.font = '600 18px ui-monospace,monospace'; g.fillText('HARNESS SCORE · v0 → v4', 16, 28);
    g.strokeStyle = '#ff5a1f'; g.lineWidth = 3; g.beginPath(); [60, 75, 72, 110, 150, 170, 210, 236].forEach((v, i) => g.lineTo(30 + i * 64, 280 - v)); g.stroke(); });
  const alarmTex = tex(512, 300, (g, w, h) => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); g.fillStyle = '#0b0b0c'; g.font = '600 18px ui-monospace,monospace'; g.fillText('ALARMS · EVENTS', 16, 28); g.font = '14px ui-monospace,monospace';
    [['11:09:12', 'CAB-01 verification running', '#ff5a1f'], ['11:07:42', 'v3 repair compiled OK', '#0b0b0c'], ['11:02:10', 'CAB-02 jam latched', '#d0281f'], ['10:58:31', 'Rig FIO reachable', '#0b0b0c'], ['10:48:02', 'v1 tests 6/8 passed', '#6b7079']]
      .forEach(([t, s, c], i) => { g.fillStyle = c; g.fillRect(16, 52 + i * 44, 6, 26); g.fillStyle = '#6b7079'; g.fillText(t, 32, 70 + i * 44); g.fillStyle = '#0b0b0c'; g.fillText(s, 120, 70 + i * 44); }); });
  [[-.62, trendTex, .25], [0, scadaTex, 0], [.62, alarmTex, -.25]].forEach(([x, t, ry]) => {
    const mon = new THREE.Group(); mon.position.set(x, 1.05, -.18); mon.rotation.y = ry; desk.add(mon);
    rbox(.58, .35, .03, .008, M.black, 0, 0, 0, mon);
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(.55, .32), new THREE.MeshStandardMaterial({ map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: .55, roughness: .3 })); scr.position.z = .016; mon.add(scr);
    box(.04, .26, .04, M.dark, 0, -.26, -.03, mon); box(.2, .015, .14, M.dark, 0, -.38, 0, mon);
  });
  box(.45, .02, .15, M.dark, 0, .765, .15, desk); box(.07, .025, .1, M.dark, .32, .765, .15, desk); // keyboard + mouse
  rbox(.08, .1, .08, .01, M.white, -.75, .8, .2, desk); // mug
  const binder = (x, c) => box(.05, .3, .24, std(c, .7), x, .9, -.28, desk);
  // laptop (programming the PLC)
  const lap = new THREE.Group(); lap.position.set(.6, .76, .18); lap.rotation.y = -.3; desk.add(lap);
  box(.34, .015, .24, M.steel, 0, 0, 0, lap); const lid = box(.34, .23, .01, M.steel, 0, .115, -.12, lap); lid.rotation.x = -.25;
  // chair
  const chair = new THREE.Group(); chair.position.set(-3.5, 0, BZ + 1.25); chair.rotation.y = .35; G.add(chair);
  cyl(.03, .03, .4, M.steel, 0, .25, 0, chair); rbox(.48, .08, .46, .03, M.chair, 0, .48, 0, chair); rbox(.46, .55, .06, .03, M.chair, 0, .82, .22, chair);
  for (let i = 0; i < 5; i++) { const a = i / 5 * Math.PI * 2; const leg = box(.3, .03, .04, M.dark, Math.cos(a) * .15, .06, Math.sin(a) * .15, chair); leg.rotation.y = -a; cyl(.025, .025, .03, M.black, Math.cos(a) * .3, .025, Math.sin(a) * .3, chair); }

  // ---------- 42U network / SCADA server rack ----------
  const rack = new THREE.Group(); rack.position.set(-1.6, 0, BZ + .4); G.add(rack);
  box(.6, 2.0, .7, M.dark, 0, 1.0, 0, rack); const rd = box(.56, 1.9, .01, M.glass, 0, 1.0, .355, rack);
  const leds = [];
  [[.25, 'srv'], [.45, 'srv'], [.65, 'srv'], [1.25, 'sw'], [1.35, 'sw'], [1.5, 'patch'], [1.62, 'fw']].forEach(([y, k]) => {
    box(.5, k === 'srv' ? .17 : .08, .6, k === 'patch' ? M.black : std(0x3a3e45, .4, .3), 0, y, 0, rack);
    const n = k === 'sw' || k === 'patch' ? 16 : 3;
    for (let i = 0; i < n; i++) { const l = box(.012, .006, .004, glow(k === 'fw' ? 0xff5a1f : 0x2fb35a, 0), -.22 + i * (.44 / n), y + .02, .305, rack); l.userData.dynamic = true; leds.push(l); }
  });
  for (let i = 0; i < 10; i++) { const c = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(-.2 + i * .04, 1.5, .31), new THREE.Vector3(-.2 + i * .045, 1.42, .34), new THREE.Vector3(-.22 + i * .05, 1.35, .31)]), 8, .004, 5), i % 3 ? M.blue : std(0xf2c230, .5)); rack.add(c); }
  anim.push(t => leds.forEach((l, i) => l.material.emissiveIntensity = Math.sin(t * (4 + i % 7) + i * 1.7) > .3 ? 2.2 : .2));

  // ---------- UPS + battery cabinet ----------
  rbox(.45, 1.1, .7, .02, std(0x2b2e33, .5, .2), -.95, .55, BZ + .4);
  const upsScreen = box(.16, .08, .01, glow(0x2fb35a, 1.2), -.95, .9, BZ + .755);
  box(.45, .08, .02, M.white, -.95, 1.02, BZ + .755);

  // ---------- whiteboard with ladder logic sketch ----------
  const wbTex = tex(1024, 512, (g, w, h) => { g.fillStyle = '#fbfbfa'; g.fillRect(0, 0, w, h); g.strokeStyle = '#2b5fc2'; g.lineWidth = 4; g.font = '28px "Segoe Print", "Comic Sans MS", cursive'; g.fillStyle = '#2b5fc2';
    g.fillText('CAB-01 seal-in', 40, 52); g.beginPath(); g.moveTo(40, 80); g.lineTo(40, 460); g.moveTo(980, 80); g.lineTo(980, 460); g.stroke();
    [[130, 'Start', 'Stop', 'Run'], [250, 'Run', 'E-stop', ''], [370, 'Pallet', 'TON 5s', 'Jam']].forEach(([y, a, b, c]) => { g.beginPath(); g.moveTo(40, y); g.lineTo(980, y); g.stroke();
      g.clearRect(180, y - 22, 40, 44); g.strokeRect(180, y - 22, 14, 44); g.strokeRect(206, y - 22, 14, 44); g.fillText(a, 160, y - 30);
      g.clearRect(420, y - 22, 40, 44); g.strokeRect(420, y - 22, 14, 44); g.strokeRect(446, y - 22, 14, 44); g.fillText(b, 400, y - 30);
      if (c) { g.clearRect(860, y - 24, 50, 48); g.beginPath(); g.arc(885, y, 22, 0, 7); g.stroke(); g.fillText(c, 860, y - 32); } });
    g.strokeStyle = '#d0281f'; g.fillStyle = '#d0281f'; g.fillText('TODO: no auto-restart after reset!', 520, 470); });
  const wb = new THREE.Mesh(new THREE.PlaneGeometry(1.6, .8), new THREE.MeshStandardMaterial({ map: wbTex, roughness: .35 })); wb.position.set(.6, 1.65, BZ + .02); G.add(wb);
  box(1.66, .86, .015, M.steel, .6, 1.65, BZ + .008); box(1.5, .03, .06, M.steel, .6, 1.2, BZ + .04);
  [0xd0281f, 0x2b5fc2, 0x0b0b0c].forEach((c, i) => { const mk = cyl(.008, .008, .1, std(c, .5), .3 + i * .05, 1.23, BZ + .05); mk.rotation.z = Math.PI / 2; });

  // ---------- wall clock ----------
  const clock = new THREE.Group(); clock.position.set(2.1, 2.3, BZ + .03); G.add(clock);
  const face = new THREE.Mesh(new THREE.CircleGeometry(.18, 48), new THREE.MeshStandardMaterial({ map: tex(256, 256, (g) => { g.fillStyle = '#fff'; g.beginPath(); g.arc(128, 128, 128, 0, 7); g.fill(); g.fillStyle = '#111';
    for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; g.fillRect(126 + Math.sin(a) * 104, 124 - Math.cos(a) * 104, 5, 10); } }) })); clock.add(face);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(.185, .015, 10, 48), M.black); clock.add(rim);
  const hand = (len, w, m) => { const p = new THREE.Group(); p.userData.dynamic = true; const b = box(w, len, .004, m, 0, len / 2, .01, p); clock.add(p); return p; };
  const hH = hand(.09, .012, M.black), hM = hand(.14, .008, M.black), hS = hand(.15, .003, M.red);
  anim.push(() => { const d = new Date(), s = d.getSeconds(), m = d.getMinutes() + s / 60, h = d.getHours() % 12 + m / 60; hS.rotation.z = -s / 60 * Math.PI * 2; hM.rotation.z = -m / 60 * Math.PI * 2; hH.rotation.z = -h / 12 * Math.PI * 2; });

  // ---------- safety signage ----------
  const sign = (w, h, draw, x, y, z, left = false) => { const t = tex(512, Math.round(512 * h / w), draw); const s = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: t, roughness: .5 }));
    if (left) { s.rotation.y = Math.PI / 2; s.position.set(LX + .012, y, z); } else s.position.set(x, y, BZ + .012); G.add(s); return s; };
  sign(.5, .35, (g, w, h) => { g.fillStyle = '#ff7a00'; g.fillRect(0, 0, w, 90); g.fillStyle = '#000'; g.font = 'bold 64px Arial'; g.fillText('⚠ WARNING', 40, 70); g.fillStyle = '#fff'; g.fillRect(0, 90, w, h);
    g.fillStyle = '#000'; g.font = 'bold 40px Arial'; g.fillText('ARC FLASH AND SHOCK', 30, 160); g.font = '30px Arial'; g.fillText('HAZARD · PPE REQUIRED', 30, 210); g.fillText('480 VAC · 8 cal/cm²', 30, 255); g.fillText('Boundary 1.2 m', 30, 300); }, 2.95, 1.55, 0);
  sign(.45, .3, (g, w, h) => { g.fillStyle = '#c8102e'; g.fillRect(0, 0, w, 100); g.fillStyle = '#fff'; g.font = 'bold 68px Arial'; g.fillText('DANGER', 110, 78); g.fillStyle = '#fff'; g.fillRect(0, 100, w, h); g.fillStyle = '#000'; g.font = 'bold 44px Arial'; g.fillText('AUTHORIZED', 110, 190); g.fillText('PERSONNEL ONLY', 60, 250); }, -2.6, 1.7, 0);
  sign(.6, .42, (g, w, h) => { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.fillStyle = '#1f8a4c'; g.fillRect(0, 0, w, 70); g.fillStyle = '#fff'; g.font = 'bold 44px Arial'; g.fillText('PLC ROOM · AREA 3', 24, 52); g.fillStyle = '#000'; g.font = '30px Arial';
    ['CAB-01..08  Line PLCs', 'MCC-A/B  Motor control', 'Rack R1  SCADA / network', 'Emergency: ext. 4444'].forEach((s, i) => g.fillText(s, 24, 120 + i * 44)); }, 4.1, 1.6, 0);

  // ---------- LOTO station ----------
  const loto = new THREE.Group(); loto.position.set(3.4, 1.35, BZ + .03); G.add(loto);
  box(.6, .5, .02, std(0xd0281f, .5), 0, 0, 0, loto); box(.56, .08, .01, M.white, 0, .2, .015, loto);
  for (let i = 0; i < 6; i++) { const lk = rbox(.05, .06, .025, .006, std([0xd0281f, 0xf2c230, 0x2b5fc2][i % 3], .4), -.22 + i * .088, .02, .03, loto); const sh = new THREE.Mesh(new THREE.TorusGeometry(.017, .004, 6, 12, Math.PI), M.steel); sh.position.set(-.22 + i * .088, .055, .03); loto.add(sh); }
  for (let i = 0; i < 5; i++) box(.06, .1, .004, std(0xd0281f, .6), -.2 + i * .1, -.15, .02, loto);

  // ---------- fire extinguisher + eyewash ----------
  const ext = new THREE.Group(); ext.position.set(4.6, 0, BZ + .15); G.add(ext);
  cyl(.075, .075, .5, M.red, 0, .65, 0, ext); cyl(.04, .05, .06, M.black, 0, .93, 0, ext); box(.12, .02, .03, M.black, .04, .97, 0, ext);
  const hose = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(.03, .93, .04), new THREE.Vector3(.12, .8, .07), new THREE.Vector3(.09, .5, .08)]), 10, .01, 6), M.black); ext.add(hose);
  box(.2, .03, .2, M.steel, 0, .4, -.02, ext);
  sign(.18, .25, (g, w, h) => { g.fillStyle = '#c8102e'; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.font = 'bold 60px Arial'; g.fillText('FIRE', 150, 260); g.fillText('EXTINGUISHER', 20, 360); }, 4.6, 1.25, 0);

  // ---------- conduit runs on back wall into the cable ladder ----------
  for (let i = 0; i < 6; i++) { const x = -2.4 + i * .9; cyl(.02, .02, 1.5, M.conduit, x, 2.35, BZ + .06);
    for (let k = 0; k < 4; k++) box(.06, .02, .03, M.steel, x, 1.7 + k * .4, BZ + .03); }
  box(10, .02, .03, M.conduit, 0, 3.08, BZ + .06);

  // ---------- left wall: door, EXIT, fire alarm, thermostat, mini-split, shelving, eyewash ----------
  const door = new THREE.Group(); door.position.set(LX + .02, 0, 3.1); G.add(door);
  box(.05, 2.15, 1.0, std(0x8c939b, .4, .5), 0, 1.075, 0, door); box(.06, 2.1, .94, std(0xd9dde2, .4, .3), .01, 1.05, 0, door);
  box(.07, .5, .3, M.glass, .02, 1.5, -.15, door); box(.09, .04, .14, M.steel, .05, 1.0, .35, door); box(.04, .06, .9, M.steel, .04, .9, 0, door);
  const exitTex = tex(256, 96, g => { g.fillStyle = '#fff'; g.fillRect(0, 0, 256, 96); g.fillStyle = '#c8102e'; g.font = 'bold 70px Arial'; g.fillText('EXIT', 50, 74); });
  const exit = new THREE.Mesh(new THREE.BoxGeometry(.06, .16, .38), [M.white, M.white, M.white, M.white, M.white, M.white]);
  exit.position.set(LX + .04, 2.35, 3.1); G.add(exit);
  const exitFace = new THREE.Mesh(new THREE.PlaneGeometry(.36, .14), new THREE.MeshStandardMaterial({ map: exitTex, emissive: 0xffffff, emissiveMap: exitTex, emissiveIntensity: .9 })); exitFace.rotation.y = Math.PI / 2; exitFace.position.set(LX + .075, 2.35, 3.1); G.add(exitFace);
  const pull = rbox(.03, .14, .1, .01, M.red, LX + .02, 1.25, 2.35); const strobe = rbox(.04, .1, .12, .01, std(0xd0281f, .4, 0, { emissive: 0xffffff, emissiveIntensity: 0 }), LX + .025, 2.3, 2.35);
  strobe.userData.dynamic = true; anim.push(t => strobe.material.emissiveIntensity = (t % 6) < .06 ? 3 : 0);
  rbox(.02, .12, .09, .01, M.white, LX + .02, 1.45, 1.6); box(.004, .04, .06, glow(0x6fb8ff, .8), LX + .035, 1.47, 1.6);
  // mini-split AC head with fluttering louver
  const ac = new THREE.Group(); ac.position.set(LX + .14, 2.55, 0); G.add(ac);
  rbox(.25, .3, 1.0, .05, M.white, 0, 0, 0, ac); const louver = box(.02, .04, .9, std(0xe3e6ea, .5), .13, -.13, 0, ac); louver.userData.dynamic = true;
  box(.004, .015, .03, glow(0x2fb35a, 1.2), .126, .08, .4, ac);
  anim.push(t => louver.rotation.z = .35 + Math.sin(t * .8) * .25);
  const line = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(LX + .04, 2.45, .5), new THREE.Vector3(LX + .04, 2.8, .7), new THREE.Vector3(LX + .04, 3.1, .7)]), 10, .025, 6), M.white); G.add(line);
  // spare parts shelving (boxes of IO modules, contactors, cable)
  const shelf = new THREE.Group(); shelf.position.set(LX + .35, 0, -1.6); G.add(shelf);
  [-.75, .75].forEach(z => [-.25, .25].forEach(x => box(.03, 2.0, .03, M.steel, x, 1.0, z, shelf)));
  [.15, .6, 1.05, 1.5, 1.95].forEach(y => box(.55, .02, 1.55, M.steel, 0, y, 0, shelf));
  const rnd = (a, b) => a + Math.random() * (b - a);
  [.16, .61, 1.06, 1.51].forEach(y => { let z = -.7; while (z < .65) { const d = rnd(.18, .34), h = rnd(.12, .32), c = Math.random() < .7 ? M.cardboard : std([0x2b5fc2, 0xf2c230, 0x3d4e60, 0xffffff][Math.floor(Math.random() * 4)], .6);
    box(rnd(.3, .45), h, d - .02, c, rnd(-.04, .04), y + h / 2 + .01, z + d / 2, shelf); z += d; } });
  for (let i = 0; i < 2; i++) { const reel = new THREE.Mesh(new THREE.TorusGeometry(.12, .05, 10, 24), std(i ? 0x2b5fc2 : 0x121315, .6)); reel.rotation.y = Math.PI / 2; reel.position.set(.05, 2.1, -.4 + i * .5); shelf.add(reel); }
  // eyewash
  const eye = new THREE.Group(); eye.position.set(LX + .12, 0, -3.0); G.add(eye);
  cyl(.02, .02, 1.0, std(0x1f8a4c, .5), 0, .9, 0, eye); cyl(.12, .08, .06, std(0x1f8a4c, .5), .1, 1.05, 0, eye); box(.01, .2, .2, std(0x1f8a4c, .5), -.1, 1.7, 0, eye);
  sign(.22, .3, (g, w, h) => { g.fillStyle = '#1f8a4c'; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.font = 'bold 56px Arial'; g.fillText('EMERGENCY', 60, 260); g.fillText('EYEWASH', 100, 340); }, 0, 1.75, -3.0, true);

  // ---------- floor: rubber insulating mats in front of each cabinet row ----------
  const matTex = tex(256, 256, g => { g.fillStyle = '#2f3236'; g.fillRect(0, 0, 256, 256); g.strokeStyle = '#3a3e43'; g.lineWidth = 3; for (let i = 0; i < 256; i += 10) { g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); } });
  matTex.wrapS = matTex.wrapT = THREE.RepeatWrapping; matTex.repeat.set(6, 1);
  const matM = new THREE.MeshStandardMaterial({ map: matTex, roughness: .95 });
  [[-1.6, 1.0], [.85, 1.0]].forEach(([z]) => { const m = new THREE.Mesh(new THREE.BoxGeometry(4.6, .012, .9), matM); m.position.set(0, .006, z); m.receiveShadow = true; G.add(m); });
  // floor hazard tape around rack
  [[-1.6, .006, BZ + .95, 1.0, .05], [-2.08, .006, BZ + .55, .05, .8], [-1.12, .006, BZ + .55, .05, .8]].forEach(([x, y, z, w, d]) => box(w, .004, d, std(0xf2c230, .7), x, .003, z));

  // tool cart
  const cart = new THREE.Group(); cart.position.set(3.3, 0, 2.6); cart.rotation.y = -.5; G.add(cart);
  [.25, .55, .85].forEach(y => box(.7, .03, .42, M.red, 0, y, 0, cart)); [-.33, .33].forEach(x => [-.19, .19].forEach(z => { box(.025, .85, .025, M.steel, x, .47, z, cart); cyl(.04, .04, .03, M.black, x, .04, z, cart).rotation.z = Math.PI / 2; }));
  box(.1, .3, .1, std(0xf2c230, .5), -.2, 1.0, 0, cart); box(.26, .06, .14, M.dark, .12, .9, 0, cart); box(.2, .04, .1, std(0x2b5fc2, .5), .15, .6, .05, cart);
  const meter = rbox(.09, .17, .05, .01, std(0xf2c230, .5), -.1, .9, .1, cart); meter.rotation.x = -1.2;
  // cable drum
  const drum = new THREE.Group(); drum.position.set(4.3, .32, 1.2); drum.rotation.y = .4; G.add(drum);
  [-.16, .16].forEach(z => { const f = cyl(.32, .32, .03, M.wood, 0, 0, z, drum, 28); f.rotation.x = Math.PI / 2; });
  const core = cyl(.2, .2, .3, std(0x121315, .7), 0, 0, 0, drum, 28); core.rotation.x = Math.PI / 2;
  // step ladder
  const lad = new THREE.Group(); lad.position.set(-4.6, 0, 1.4); lad.rotation.y = .7; G.add(lad);
  [-1, 1].forEach(s => { [-.2, .2].forEach(x => { const r = box(.04, 1.6, .03, std(0xf2c230, .6), x, .78, s * .22, lad); r.rotation.x = s * .17; }); });
  for (let i = 0; i < 4; i++) box(.44, .025, .1, M.steel, 0, .35 + i * .35, .2 - i * .05, lad);
  // traffic cone near the aisle end
  const cone = new THREE.Group(); cone.position.set(3.9, 0, -.4); G.add(cone);
  box(.3, .03, .3, M.orange, 0, .015, 0, cone); cyl(.02, .12, .45, M.orange, 0, .25, 0, cone); cyl(.07, .09, .07, M.white, 0, .25, 0, cone);
  // cable drops: bundles fall straight from the tray into each cabinet roof gland
  [[-2.2, 1], [1.4, -1]].forEach(([z, dir]) => { for (let i = 0; i < 5; i++) { const x = (-1.9 + i * .84 + (i > 3 ? .45 : 0)) * (dir > 0 ? 1 : -1) + (dir > 0 ? 0 : .5);
    for (let k = 0; k < 3; k++) { const c = cyl(.012, .012, .62, k === 1 ? M.blue : M.cable, x - .05 + k * .05, 2.43, z); }
    box(.2, .03, .1, M.steel, x, 2.13, z); } });
  // ---------- hanging linear LED fixtures ----------
  [-2.2, 0, 2.2].forEach(x => { const f = box(1.2, .05, .16, M.white, x, 3.0, -.4); const diff = box(1.16, .01, .12, glow(0xffffff, 1.4), x, 2.97, -.4);
    [-.5, .5].forEach(dx => box(.004, .3, .004, M.steel, x + dx, 3.18, -.4)); });

  // ---------- dust motes in the light ----------
  const N = 260, pos = new Float32Array(N * 3); for (let i = 0; i < N; i++) { pos[i * 3] = rnd(-4.5, 4.5); pos[i * 3 + 1] = rnd(.2, 2.9); pos[i * 3 + 2] = rnd(-3.2, 3.5); }
  const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const motes = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0xffffff, size: .018, transparent: true, opacity: .55, depthWrite: false })); G.add(motes);
  anim.push((t, dt) => { const a = pg.attributes.position.array; for (let i = 0; i < N; i++) { a[i * 3 + 1] += Math.sin(t * .3 + i) * .0006; a[i * 3] += Math.cos(t * .2 + i * .7) * .0005; } pg.attributes.position.needsUpdate = true; });

  G.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  motes.castShadow = false;
  console.info('[props] merged', mergeStatic(G), 'static meshes');
  return { group: G, update: (dt, t) => anim.forEach(f => f(t, dt)) };
}

// =====================================================================================================
// buildHall: the daylit factory hall around the cutaway control room + the live production line the
// PLCs drive: infeed case erector -> belt conveyor -> sort-by-height pusher + chute -> 90° turn ->
// robot cell -> palletizer. Building shell is merged per material (no shadows); repeated items are
// InstancedMesh; only belts, cartons, pusher, robot, palletizer head, forklift and lamps animate.
// Room footprint (open on +x and +z): x -5.225..5.4, z -3.525..4.8.
// =====================================================================================================
export function buildHall(scene) {
  const X0 = -16, X1 = 26, Z0 = -14, Z1 = 26, HH = 11;
  const B = new THREE.Group(), L = new THREE.Group(), D = new THREE.Group(); // building (no shadow) / line (shadow) / dynamic
  scene.add(B, L, D);
  const anim = [];
  const box = (w, h, d, m, x, y, z, p = B, ry = 0) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); o.rotation.y = ry; p.add(o); return o; };
  const cyl = (rt, rb, h, m, x, y, z, p = B, seg = 16) => { const o = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m); o.position.set(x, y, z); p.add(o); return o; };
  const geo = parts => mergeGeometries(parts.map(([g, x, y, z, rx = 0, ry = 0, rz = 0]) => { g = g.index ? g.toNonIndexed() : g;
    return g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1))); }));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const sm = u => u * u * (3 - 2 * u);
  const paint = (c, o = {}) => std(c, .55, 0, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, ...o });
  const M = {
    steel: std(0x8f9ba8, .45, .6), steelLt: std(0xc3c9cf, .4, .7), white: std(0xf1f2f3, .7), dark: std(0x2b2e33, .6, .2),
    yellow: std(0xf2c230, .5), black: std(0x16171a, .6), orange: std(0xff5a1f, .42, .15), blueRack: std(0x2b5fc2, .45, .3),
    beam: std(0xff7a1a, .45, .2), wood: std(0xc9a77c, .8), card: std(0xc9a06e, .85), rubber: std(0x1d1f22, .9),
    rail: std(0xb9c0c7, .28, .9), cable: std(0x3a3d42, .7), glass: std(0xdfe8ee, .1, .2, { transparent: true, opacity: .35 }),
  };
  const glow = (c, i) => std(c, .4, 0, { emissive: c, emissiveIntensity: i });
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3();

  // ---------- polished concrete floor with saw-cut joints ----------
  const fTex = tex(1024, 1024, (g, w, h) => {
    g.fillStyle = '#d9dbdc'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 70; i++) { const x = Math.random() * w, y = Math.random() * h, r = 60 + Math.random() * 220, gr = g.createRadialGradient(x, y, 0, x, y, r);
      const l = Math.random() < .5 ? '255,255,255' : '150,152,155'; gr.addColorStop(0, `rgba(${l},.07)`); gr.addColorStop(1, `rgba(${l},0)`); g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r); }
    for (let i = 0; i < 9000; i++) { g.fillStyle = `rgba(${Math.random() < .5 ? '90,92,95' : '255,255,255'},${Math.random() * .12})`; g.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
    g.strokeStyle = 'rgba(120,122,126,.55)'; g.lineWidth = 3; g.strokeRect(0, 0, w, h);
  });
  fTex.wrapS = fTex.wrapT = THREE.RepeatWrapping; fTex.repeat.set((X1 - X0) / 6, (Z1 - Z0) / 6);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(X1 - X0, Z1 - Z0), new THREE.MeshStandardMaterial({ map: fTex, roughness: .32, metalness: 0 }));
  floor.rotation.x = -Math.PI / 2; floor.position.set((X0 + X1) / 2, 0, (Z0 + Z1) / 2); floor.receiveShadow = true; scene.add(floor);

  // ---------- painted markings ----------
  const P = { yellow: paint(0xf2c230), white: paint(0xf7f7f5), green: paint(0x8fc4a2, { roughness: .6 }) };
  const hatchTex = tex(256, 64, (g, w, h) => { g.fillStyle = '#f2c230'; g.fillRect(0, 0, w, h); g.fillStyle = '#16171a'; for (let x = -64; x < w + 64; x += 48) { g.beginPath(); g.moveTo(x, h); g.lineTo(x + 24, h); g.lineTo(x + 24 + h, 0); g.lineTo(x + h, 0); g.fill(); } });
  hatchTex.wrapS = hatchTex.wrapT = THREE.RepeatWrapping;
  const strip = (x0, z0, x1, z1, m) => { const o = new THREE.Mesh(new THREE.PlaneGeometry(Math.abs(x1 - x0), Math.abs(z1 - z0)), m); o.rotation.x = -Math.PI / 2; o.position.set((x0 + x1) / 2, .002, (z0 + z1) / 2); B.add(o); return o; };
  const hatch = (x0, z0, x1, z1) => { const t = hatchTex.clone(); t.needsUpdate = true; const len = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0)); t.repeat.set(len / 1.2, 1);
    const o = strip(x0, z0, x1, z1, paint(0xffffff, { map: t })); if (Math.abs(z1 - z0) > Math.abs(x1 - x0)) { o.geometry = new THREE.PlaneGeometry(Math.abs(z1 - z0), Math.abs(x1 - x0)); o.rotation.z = Math.PI / 2; } return o; };
  const lineRect = (x0, z0, x1, z1, w = .1, m = P.yellow) => { strip(x0, z0, x1, z0 + w, m); strip(x0, z1 - w, x1, z1, m); strip(x0, z0, x0 + w, z1, m); strip(x1 - w, z0, x1, z1, m); };
  hatch(5.42, -3.525, 5.72, 4.8); hatch(-5.225, 4.82, 5.72, 5.12); // room curb on the two open sides
  strip(5.9, -12.5, 7.2, 5.3, P.green); strip(-14.5, 5.3, 7.2, 6.6, P.green); // green walkways hugging the room
  strip(5.8, -12.5, 5.9, 5.3, P.yellow); strip(7.2, -12.5, 7.3, 6.7, P.yellow); strip(-14.5, 5.2, 5.9, 5.3, P.yellow); strip(-14.5, 6.6, 7.3, 6.7, P.yellow);
  for (let i = 0; i < 6; i++) strip(5.98 + i * .2, 5.45, 6.08 + i * .2, 6.45, P.white);
  strip(-15, 13.1, 25, 13.22, P.yellow); strip(-15, 16.6, 25, 16.72, P.yellow); // forklift aisle
  for (let x = -14; x < 24; x += 2.4) strip(x, 14.86, x + 1.2, 14.96, P.white);
  const arrowTex = tex(128, 128, g => { g.fillStyle = '#f7f7f5'; g.beginPath(); g.moveTo(10, 50); g.lineTo(80, 50); g.lineTo(80, 20); g.lineTo(122, 64); g.lineTo(80, 108); g.lineTo(80, 78); g.lineTo(10, 78); g.fill(); });
  const arrowM = paint(0xffffff, { map: arrowTex, alphaTest: .5 });
  [[-6, 14.1, 0], [8, 14.1, 0], [-2, 15.7, Math.PI], [14, 15.7, Math.PI]].forEach(([x, z, r]) => { const o = strip(x - .7, z - .5, x + .7, z + .5, arrowM); o.rotation.z = r; });
  lineRect(7.5, -13.5, 11.9, 6.8); lineRect(-10.2, 6.9, 9.6, 12.4); hatch(-9.4, 11.7, -5.8, 12.2);

  // ---------- steel columns (instanced I-beams) on a grid, yellow/black base guards ----------
  const xs = [-14, -6, 2, 10, 18], zs = [-12, -4.4, 3.6, 12.2, 20.8], cols = [];
  xs.forEach(x => zs.forEach(z => { if (!(x > -5.3 && x < 5.5 && z > -3.6 && z < 4.9)) cols.push([x, z]); }));
  const ibeam = geo([[new THREE.BoxGeometry(.36, HH, .03), 0, HH / 2, -.17], [new THREE.BoxGeometry(.36, HH, .03), 0, HH / 2, .17], [new THREE.BoxGeometry(.025, HH, .32), 0, HH / 2, 0]]);
  const colIM = new THREE.InstancedMesh(ibeam, std(0x9aa7b4, .45, .55), cols.length);
  const guardIM = new THREE.InstancedMesh(geo([[new THREE.BoxGeometry(.55, 1.1, .55), 0, .55, 0]]), M.yellow, cols.length);
  const stripeIM = new THREE.InstancedMesh(geo([[new THREE.BoxGeometry(.56, .1, .56), 0, .35, 0], [new THREE.BoxGeometry(.56, .1, .56), 0, .75, 0]]), M.black, cols.length);
  cols.forEach(([x, z], i) => { m4.makeTranslation(x, 0, z); colIM.setMatrixAt(i, m4); guardIM.setMatrixAt(i, m4); stripeIM.setMatrixAt(i, m4); });
  [colIM, guardIM, stripeIM].forEach(o => { o.computeBoundingSphere(); D.add(o); });

  // ---------- roof trusses, purlins, roof deck with skylight strips (one-sided: cutaway from above) ----------
  const tl = X1 - X0, tparts = [[new THREE.BoxGeometry(tl, .14, .2), 0, 10.6, 0], [new THREE.BoxGeometry(tl, .12, .16), 0, 9.3, 0]];
  for (let i = 0, x = -tl / 2; x <= tl / 2 + .01; x += 1.75, i++) { tparts.push([new THREE.BoxGeometry(.06, 1.3, .06), x, 9.95, 0]);
    if (x < tl / 2 - .1) tparts.push([new THREE.BoxGeometry(.05, 2.2, .05), x + .875, 9.95, 0, 0, 0, Math.atan2(1.75, 1.3) * (i % 2 ? 1 : -1)]); }
  const trussIM = new THREE.InstancedMesh(geo(tparts), M.white, zs.length);
  zs.forEach((z, i) => trussIM.setMatrixAt(i, m4.makeTranslation((X0 + X1) / 2, 0, z))); trussIM.computeBoundingSphere(); D.add(trussIM);
  for (let x = X0 + 2; x < X1; x += 3.5) box(.1, .16, Z1 - Z0, M.steelLt, x, 10.75, (Z0 + Z1) / 2);
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(X1 - X0, Z1 - Z0), std(0xe9ebee, .9)); roof.rotation.x = Math.PI / 2; roof.position.set((X0 + X1) / 2, HH, (Z0 + Z1) / 2); B.add(roof);
  [-10, -2, 6, 14, 22].forEach(x => { const s = new THREE.Mesh(new THREE.PlaneGeometry(1.8, Z1 - Z0 - 4), std(0xffffff, .5, 0, { emissive: 0xf4f8ff, emissiveIntensity: 1.1 })); s.rotation.x = Math.PI / 2; s.position.set(x, HH - .03, (Z0 + Z1) / 2); B.add(s); });
  const hb = []; for (let x = -12; x <= 24; x += 6) for (let i = 0; i < zs.length - 1; i++) hb.push([x, (zs[i] + zs[i + 1]) / 2]);
  const bellIM = new THREE.InstancedMesh(geo([[new THREE.CylinderGeometry(.16, .42, .32, 20, 1, true), 0, 8.6, 0], [new THREE.CylinderGeometry(.012, .012, 1.9, 4), 0, 9.7, 0]]), std(0xdfe2e6, .35, .6, { side: THREE.DoubleSide }), hb.length);
  const lensIM = new THREE.InstancedMesh(geo([[new THREE.CircleGeometry(.4, 20), 0, 8.45, 0, Math.PI / 2]]), glow(0xffffff, 2.2), hb.length);
  hb.forEach(([x, z], i) => { m4.makeTranslation(x, 0, z); bellIM.setMatrixAt(i, m4); lensIM.setMatrixAt(i, m4); }); [bellIM, lensIM].forEach(o => { o.computeBoundingSphere(); D.add(o); });

  // ---------- hall walls: ribbed cladding, ribbon windows + clerestory, roller doors ----------
  const wT = tex(1024, 1408, (g, w, h) => { // 8 m wide x 11 m tall module
    const px = h / 11; g.fillStyle = '#e4e7ea'; g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 32) { g.fillStyle = 'rgba(255,255,255,.55)'; g.fillRect(x, 0, 6, h); g.fillStyle = 'rgba(120,128,136,.18)'; g.fillRect(x + 6, 0, 3, h); }
    g.fillStyle = '#c9ced4'; g.fillRect(0, h - 1.0 * px, w, 1.0 * px);
    const win = (y0, y1) => { g.fillStyle = '#8a95a1'; g.fillRect(0, h - y1 * px - 8, w, (y1 - y0) * px + 16);
      const gr = g.createLinearGradient(0, h - y1 * px, 0, h - y0 * px); gr.addColorStop(0, '#fbfdff'); gr.addColorStop(1, '#dfe9f1'); g.fillStyle = gr; g.fillRect(0, h - y1 * px, w, (y1 - y0) * px);
      g.fillStyle = '#8a95a1'; for (let x = 0; x <= w; x += w / 6) g.fillRect(x - 4, h - y1 * px, 8, (y1 - y0) * px); g.fillRect(0, h - (y0 + y1) / 2 * px - 3, w, 6); };
    win(2.0, 3.6); win(7.2, 9.6);
  });
  wT.wrapS = THREE.RepeatWrapping;
  const wallMat = len => { const t = wT.clone(); t.needsUpdate = true; t.repeat.set(len / 8, 1); return new THREE.MeshStandardMaterial({ map: t, roughness: .8, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: .28 }); };
  const wall = (len, x, z, ry) => { const o = new THREE.Mesh(new THREE.PlaneGeometry(len, HH), wallMat(len)); o.position.set(x, HH / 2, z); o.rotation.y = ry; B.add(o); };
  wall(X1 - X0, (X0 + X1) / 2, Z0, 0); wall(X1 - X0, (X0 + X1) / 2, Z1, Math.PI); wall(Z1 - Z0, X0, (Z0 + Z1) / 2, Math.PI / 2); wall(Z1 - Z0, X1, (Z0 + Z1) / 2, -Math.PI / 2);
  const doorTex = tex(256, 256, g => { g.fillStyle = '#d3d8dd'; g.fillRect(0, 0, 256, 256); for (let y = 0; y < 256; y += 16) { g.fillStyle = 'rgba(255,255,255,.7)'; g.fillRect(0, y, 256, 3); g.fillStyle = 'rgba(90,98,108,.35)'; g.fillRect(0, y + 13, 256, 2); }
    g.fillStyle = '#9fb3c4'; for (let x = 20; x < 240; x += 56) g.fillRect(x, 120, 40, 12); });
  const doorM = new THREE.MeshStandardMaterial({ map: doorTex, roughness: .5, metalness: .3 });
  const doorHatch = paint(0xffffff, { map: hatchTex });
  const rollDoor = (x, z, ry) => { const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = ry; B.add(g);
    box(4.6, 4.8, .06, doorM, 0, 2.4, .03, g); box(5.2, .6, .5, M.steelLt, 0, 5.1, .25, g); [-2.45, 2.45].forEach(dx => { box(.2, 4.8, .14, M.yellow, dx, 2.4, .07, g); cyl(.1, .1, 1.1, M.yellow, dx * 1.1, .55, 1.0, g); });
    box(4.6, .004, 1.2, doorHatch, 0, .003, .9, g); };
  rollDoor(X1, -2, -Math.PI / 2); rollDoor(X1, 8, -Math.PI / 2); rollDoor(14, Z0, 0); rollDoor(-4, Z1, Math.PI);

  // ---------- pallet racking (instanced) along the back and left of the hall ----------
  const BW = 2.8, rk = [];
  for (let i = 0; i < 7; i++) rk.push([-12.6 + i * BW, -9.6, 0]);
  for (let i = 0; i < 6; i++) rk.push([-11.2, -5.4 + i * BW, Math.PI / 2]);
  const upr = [], bms = [], levels = [1.55, 3.1, 4.65];
  [-BW / 2 + .05, BW / 2 - .05].forEach(x => { [-.5, .5].forEach(z => upr.push([new THREE.BoxGeometry(.08, 6.2, .07), x, 3.1, z]));
    for (let y = .4; y < 6; y += 1.2) { upr.push([new THREE.BoxGeometry(.03, .03, 1.0), x, y, 0]); upr.push([new THREE.BoxGeometry(.03, 1.5, .03), x, y + .6, 0, Math.atan2(1, 1.2), 0, 0]); } });
  levels.forEach(y => [-.53, .53].forEach(z => bms.push([new THREE.BoxGeometry(BW - .1, .12, .05), 0, y, z])));
  const uprIM = new THREE.InstancedMesh(geo(upr), M.blueRack, rk.length), bmIM = new THREE.InstancedMesh(geo(bms), M.beam, rk.length);
  const slots = []; rk.forEach(([x, z, r], i) => { m4.makeRotationY(r).setPosition(x, 0, z); uprIM.setMatrixAt(i, m4); bmIM.setMatrixAt(i, m4);
    [0.06, ...levels.map(y => y + .07)].forEach(y => [-.68, .68].forEach(dx => { if (Math.random() < .86) slots.push([x + Math.cos(r) * dx, y, z - Math.sin(r) * dx, r]); })); });
  const palIM = new THREE.InstancedMesh(geo([[new THREE.BoxGeometry(1.2, .14, 1.0), 0, .07, 0]]), M.wood, slots.length);
  const loadIM = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), std(0xffffff, .75), slots.length);
  const loadCols = [0xc9a06e, 0xc9a06e, 0xd8b384, 0xeef1f3, 0xe3e7ea, 0x9fb7d6].map(c => new THREE.Color(c));
  slots.forEach(([x, y, z, r], i) => { m4.makeRotationY(r).setPosition(x, y, z); palIM.setMatrixAt(i, m4); const h = rnd(.6, 1.15);
    q.setFromAxisAngle(v.set(0, 1, 0), r); m4.compose(v.set(x, y + .14 + h / 2, z), q, sc.set(rnd(1.0, 1.15), h, rnd(.85, .98))); loadIM.setMatrixAt(i, m4); loadIM.setColorAt(i, loadCols[Math.floor(Math.random() * loadCols.length)]); });
  [uprIM, bmIM, palIM, loadIM].forEach(o => { o.computeBoundingSphere(); D.add(o); });

  // ---------- production line: conveyors ----------
  const BELT_Y = .82, beltTex = tex(64, 64, g => { g.fillStyle = '#2a2d31'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#3a3e43'; g.fillRect(0, 0, 10, 64); });
  beltTex.wrapS = beltTex.wrapT = THREE.RepeatWrapping; const belts = [];
  function conveyor(ax, az, bx, bz, p = L) {
    const len = Math.hypot(bx - ax, bz - az), ry = Math.atan2(-(bz - az), bx - ax), g = new THREE.Group(); g.position.set((ax + bx) / 2, 0, (az + bz) / 2); g.rotation.y = ry; p.add(g);
    [-.36, .36].forEach(z => { box(len, .14, .05, M.steelLt, 0, BELT_Y - .04, z, g); box(len, .03, .03, M.yellow, 0, BELT_Y + .05, z, g); });
    for (let x = -len / 2 + .3; x <= len / 2 - .2; x += 1.6) { [-.33, .33].forEach(z => box(.06, BELT_Y - .1, .06, M.steel, x, (BELT_Y - .1) / 2, z, g)); box(.06, .05, .7, M.steel, x, .25, 0, g); box(.2, .03, .7, M.rubber, x, .015, 0, g); }
    [-len / 2, len / 2].forEach(x => { const r = cyl(.07, .07, .7, M.steelLt, x, BELT_Y - .06, 0, g); r.rotation.x = Math.PI / 2; });
    const t = beltTex.clone(); t.needsUpdate = true; t.repeat.set(len / .25, 1); belts.push(t);
    const belt = new THREE.Mesh(new THREE.PlaneGeometry(len, .66), new THREE.MeshStandardMaterial({ map: t, roughness: .7 })); belt.rotation.x = -Math.PI / 2; belt.position.y = BELT_Y; g.add(belt);
    box(.26, .22, .22, std(0x2b5fc2, .5, .2), len / 2 - .2, BELT_Y - .2, .5, g); cyl(.09, .09, .3, std(0x2b5fc2, .5, .2), len / 2 - .2, BELT_Y - .2, .75, g).rotation.x = Math.PI / 2;
    return g;
  }
  const PA = [8.2, -12.2], PB = [8.2, 7.5], PC = [-6.6, 7.5];
  conveyor(PA[0], PA[1], PB[0], PB[1] + .35); conveyor(PB[0] + .35, PB[1], PC[0], PC[1]);
  anim.push((t, dt) => belts.forEach(b => b.offset.x -= dt * .6 / .25));
  // infeed: case erector the cartons come out of
  const ce = new THREE.Group(); ce.position.set(8.2, 0, -12.9); L.add(ce);
  box(1.6, 1.9, 1.5, M.white, 0, .95, 0, ce); box(1.62, .1, 1.52, M.orange, 0, 1.85, 0, ce); box(.8, .45, .02, M.dark, 0, 1.3, .76, ce);
  box(.55, .5, .02, M.black, 0, BELT_Y + .2, .76, ce); box(.3, .2, .02, glow(0x9ad1ff, .8), -.55, 1.55, .77, ce);
  // sorting station (sort by height): portal with light curtain, pusher, gravity chute, tote
  const SZ = -2;
  const pt = new THREE.Group(); pt.position.set(8.2, 0, SZ); L.add(pt);
  [-.5, .5].forEach(x => box(.08, 1.9, .08, M.steelLt, x, .95, -.3, pt)); box(1.08, .1, .1, M.steelLt, 0, 1.9, -.3, pt);
  box(.1, .1, .08, M.dark, -.42, 1.25, -.3, pt); box(.1, .1, .08, M.dark, .42, 1.25, -.3, pt); box(.84, .006, .006, glow(0xff3020, 1.6), 0, 1.25, -.3, pt);
  box(.4, .35, .16, M.white, -.75, 1.4, -.3, pt);
  box(.5, .16, .16, M.steelLt, 7.3, BELT_Y + .18, SZ, L);
  const plate = box(.06, .26, .46, M.orange, 7.75, BELT_Y + .15, SZ, D); plate.castShadow = true;
  const rod = cyl(.02, .02, 1, M.steelLt, 0, 0, 0, D); rod.rotation.z = Math.PI / 2;
  const chute = new THREE.Group(); chute.position.set(9.9, 0, SZ); L.add(chute);
  const slope = Math.atan2(BELT_Y - .62, 1.8);
  for (let i = 0; i < 9; i++) { const r = cyl(.03, .03, .5, M.steelLt, -.8 + i * .2, BELT_Y - .04 - (i * .2) * Math.tan(slope), 0, chute); r.rotation.x = Math.PI / 2; }
  [-.27, .27].forEach(z => { const s = box(1.9, .1, .03, M.steelLt, 0, (BELT_Y + .62) / 2 - .02, z, chute); s.rotation.z = -slope; [-.8, .8].forEach(x => box(.05, .7, .05, M.steel, x, .35, z, chute)); });
  const tote = new THREE.Group(); tote.position.set(11.25, 0, SZ); L.add(tote);
  box(.9, .1, .8, M.dark, 0, .12, 0, tote); [[0, .45, -.39, .9, .7, .03], [0, .45, .39, .9, .7, .03], [-.44, .45, 0, .03, .7, .8], [.44, .45, 0, .03, .7, .8]].forEach(([x, y, z, w, h, d]) => box(w, h, d, std(0x2b5fc2, .55), x, y, z, tote));
  for (let i = 0; i < 4; i++) box(.4, .55, .35, M.card, -.2 + (i % 2) * .4, .45, -.18 + (i >> 1) * .36, tote);

  // ---------- robot cell: 6-axis arm in brand orange, yellow mesh fencing, controller ----------
  const RB = new THREE.Vector3(2.2, 0, 9.3);
  const robot = new THREE.Group(); robot.position.copy(RB); D.add(robot);
  cyl(.42, .46, .12, M.dark, 0, .06, 0, robot); cyl(.3, .34, .22, M.orange, 0, .23, 0, robot);
  const turret = new THREE.Group(); turret.position.y = .34; robot.add(turret);
  cyl(.28, .3, .3, M.orange, 0, .15, 0, turret); const sh = new THREE.Group(); sh.position.y = .5; turret.add(sh);
  cyl(.17, .17, .42, M.dark, 0, 0, 0, sh).rotation.x = Math.PI / 2;
  box(.22, 1.1, .26, M.orange, 0, .55, 0, sh); const el = new THREE.Group(); el.position.y = 1.1; sh.add(el);
  cyl(.13, .13, .34, M.dark, 0, 0, 0, el).rotation.x = Math.PI / 2;
  box(.95, .17, .19, M.orange, .47, 0, 0, el); const wr = new THREE.Group(); wr.position.x = .95; el.add(wr);
  cyl(.08, .08, .22, M.dark, 0, 0, 0, wr).rotation.x = Math.PI / 2;
  box(.1, .2, .1, M.steelLt, 0, -.12, 0, wr); box(.26, .03, .2, M.dark, 0, -.23, 0, wr);
  const held = box(.4, .3, .35, M.card, 0, -.4, 0, wr);
  robot.traverse(o => { if (o.isMesh) o.castShadow = true; });
  const PICK = [Math.PI / 2, -.9, .76, .14], LIFT1 = [Math.PI / 2, -.5, .95, -.45], LIFT2 = [-.7, -.5, .95, -.45], PLACE = [-.7, -.92, .8, .12];
  const KF = [[0, ...PICK, 0], [.5, ...PICK, 1], [1.3, ...LIFT1, 1], [2.9, ...LIFT2, 1], [3.6, ...PLACE, 1], [4.1, ...PLACE, 0], [4.8, ...LIFT2, 0], [6.4, ...LIFT1, 0], [7.2, ...PICK, 0]];
  anim.push(t => { const c = t % 7.2; let k = 0; while (k < KF.length - 2 && KF[k + 1][0] < c) k++; const A = KF[k], Bk = KF[k + 1], u = sm(Math.min(1, (c - A[0]) / (Bk[0] - A[0]))); const f = j => A[j] + (Bk[j] - A[j]) * u;
    turret.rotation.y = f(1); sh.rotation.z = f(2); el.rotation.z = f(3); wr.rotation.z = f(4); held.visible = A[5] > .5; });
  const op = new THREE.Group(); op.position.set(RB.x + 1.35, 0, RB.z + 1.1); L.add(op); box(1.2, .14, 1.0, M.wood, 0, .07, 0, op);
  for (let i = 0; i < 6; i++) box(.4, .3, .35, M.card, -.4 + (i % 3) * .41, .3, -.19 + (i > 2 ? .38 : 0), op);
  const ctrl = new THREE.Group(); ctrl.position.set(4.6, 0, 10.6); L.add(ctrl); box(.6, 1.2, .5, std(0xe3e6ea, .45, .2), 0, .6, 0, ctrl); box(.2, .1, .01, glow(0x2fb35a, 1.2), 0, 1.0, -.26, ctrl); box(.5, .4, .02, M.dark, 0, .6, -.26, ctrl);
  const meshTex = tex(128, 128, g => { g.clearRect(0, 0, 128, 128); g.strokeStyle = '#e8b81f'; g.lineWidth = 6; for (let i = 0; i <= 128; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 128); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(128, i); g.stroke(); } });
  meshTex.wrapS = meshTex.wrapT = THREE.RepeatWrapping; meshTex.repeat.set(5, 7);
  const meshM = new THREE.MeshStandardMaterial({ map: meshTex, alphaTest: .4, side: THREE.DoubleSide, roughness: .6 });
  function fence(ax, az, bx, bz) { const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(len / 1.4)), dx = (bx - ax) / n, dz = (bz - az) / n, ry = Math.atan2(-(bz - az), bx - ax);
    for (let i = 0; i <= n; i++) box(.06, 2.0, .06, M.yellow, ax + dx * i, 1.0, az + dz * i, L);
    for (let i = 0; i < n; i++) { const cx = ax + dx * (i + .5), cz = az + dz * (i + .5), pl = Math.hypot(dx, dz) - .08;
      const o = new THREE.Mesh(new THREE.PlaneGeometry(pl, 1.75), meshM); o.position.set(cx, 1.05, cz); o.rotation.y = ry; L.add(o);
      box(pl, .04, .04, M.yellow, cx, 1.95, cz, L, ry); box(pl, .04, .04, M.yellow, cx, .15, cz, L, ry); } }
  fence(.4, 8.1, .4, 11.6); fence(.4, 11.6, 4.1, 11.6); fence(4.1, 11.6, 4.1, 9.2);
  fence(-9.8, 8.0, -9.8, 11.2); fence(-9.8, 11.2, -5.6, 11.2);

  // ---------- palletizer gantry at the end of the line ----------
  const PZ = new THREE.Vector3(-7.7, 0, 8.8), PICKP = [PC[0] - .25, PC[1]], DROPP = [-7.8, 9.35];
  const pg = new THREE.Group(); pg.position.copy(PZ); L.add(pg);
  [[-1.2, -1.3], [1.2, -1.3], [-1.2, 1.3], [1.2, 1.3]].forEach(([x, z]) => box(.14, 3.0, .14, M.steelLt, x, 1.5, z, pg));
  [-1.3, 1.3].forEach(z => box(2.54, .18, .14, M.orange, 0, 3.0, z, pg)); [-1.2, 1.2].forEach(x => box(.14, .18, 2.74, M.steelLt, x, 3.0, 0, pg));
  box(1.2, .14, 1.0, M.wood, DROPP[0] - PZ.x, .07, DROPP[1] - PZ.z, pg);
  for (let l = 0; l < 3; l++) for (let i = 0; i < 6; i++) if (l < 2 || i < 4) box(.4, .3, .35, M.card, DROPP[0] - PZ.x - .41 + (i % 3) * .41, .3 + l * .31, DROPP[1] - PZ.z - .19 + (i > 2 ? .38 : 0), pg);
  box(.9, .55, .9, M.white, PICKP[0], BELT_Y + .3, PICKP[1], L); box(.92, .06, .92, M.orange, PICKP[0], BELT_Y + .6, PICKP[1], L);
  const bridge = box(2.4, .2, .25, M.dark, PZ.x, 2.95, PZ.z, D), zAx = box(.12, 1.6, .12, M.steelLt, 0, 0, 0, D), head = box(.5, .12, .45, M.orange, 0, 0, 0, D), pBox = box(.4, .3, .35, M.card, 0, 0, 0, D);
  [bridge, zAx, head, pBox].forEach(o => o.castShadow = true);
  anim.push(t => { const c = (t % 6) / 6, u = c < .5 ? sm(c * 2) : sm(2 - c * 2), lift = Math.sin(Math.PI * (c < .5 ? c * 2 : (c - .5) * 2));
    const x = PICKP[0] + (DROPP[0] - PICKP[0]) * u, z = PICKP[1] + (DROPP[1] - PICKP[1]) * u, y = 1.75 + lift * .7;
    bridge.position.z = z; zAx.position.set(x, y + .85, z); head.position.set(x, y, z); pBox.position.set(x, y - .21, z); pBox.visible = c < .5; });

  // ---------- floor-standing stack lights ----------
  const sl = { g: glow(0x2fb35a, 2.2), a: glow(0xf2c230, 0), r: glow(0xe0352b, 0), aSort: glow(0xf2c230, 0) };
  const stackLight = (x, z, amber = sl.a) => { cyl(.025, .025, 1.9, M.steelLt, x, .95, z, L); cyl(.12, .12, .03, M.dark, x, .015, z, L);
    [[sl.g, 0], [amber, 1], [sl.r, 2]].forEach(([m, i]) => cyl(.05, .05, .09, m, x, 1.95 + i * .095, z, L)); cyl(.05, .05, .03, M.dark, x, 2.24, z, L); };
  stackLight(9.3, -11.7); stackLight(7.4, SZ - .7, sl.aSort); stackLight(4.4, 8.4); stackLight(-5.9, 10.6);

  // ---------- cable trays: out of the room's ladders, along the line, down to each machine ----------
  function tray(ax, az, bx, bz, y = 2.75) { const len = Math.hypot(bx - ax, bz - az), ry = Math.atan2(-(bz - az), bx - ax), g = new THREE.Group(); g.position.set((ax + bx) / 2, y, (az + bz) / 2); g.rotation.y = ry; B.add(g);
    [-.2, .2].forEach(z => box(len, .06, .03, M.rail, 0, 0, z, g)); for (let x = -len / 2; x < len / 2; x += .4) box(.03, .02, .4, M.rail, x, -.02, 0, g);
    for (let i = 0; i < 5; i++) { const c = cyl(.017, .017, len, i % 3 ? M.cable : std(0x2b5fc2, .55), 0, .04, -.12 + i * .06, g, 6); c.rotation.z = Math.PI / 2; }
    for (let x = -len / 2 + .3; x < len / 2; x += 3) box(.015, 9.3 - y, .015, M.steelLt, x, (9.3 - y) / 2, 0, g); }
  tray(5.2, -2.2, 7.0, -2.2); tray(5.2, 1.4, 7.0, 1.4); tray(7.0, -12.4, 7.0, 6.0); tray(7.0, 6.0, -7.7, 6.0); tray(4.6, 6.0, 4.6, 10.6);
  [[7.0, SZ, 1.6], [7.0, -12.2, 1.9], [4.6, 10.6, 1.2], [-7.7, 6.0, 3.1]].forEach(([x, z, top]) => box(.12, 2.75 - top, .05, M.cable, x, (2.75 + top) / 2, z, B));

  // ---------- forklift shuttling along the aisle with a load ----------
  const fk = new THREE.Group(); D.add(fk);
  box(1.8, .5, 1.05, M.yellow, 0, .5, 0, fk); box(.5, .75, 1.05, M.dark, -.85, .7, 0, fk); box(.5, .12, .5, M.black, -.15, .82, 0, fk); box(.12, .5, .5, M.black, -.38, 1.05, 0, fk);
  [[-.5, -.45], [-.5, .45], [.45, -.45], [.45, .45]].forEach(([x, z]) => box(.05, 1.35, .05, M.dark, x, 1.4, z, fk)); box(1.05, .05, 1.0, M.dark, 0, 2.07, 0, fk);
  [[.6, .5], [-.6, .5], [.6, -.5], [-.6, -.5]].forEach(([x, z]) => { const w = cyl(.26, .26, .2, M.rubber, x, .26, z, fk, 18); w.rotation.x = Math.PI / 2; });
  [-.32, .32].forEach(z => box(.08, 2.3, .08, M.steel, .98, 1.15, z, fk)); box(.06, .5, .8, M.dark, 1.05, .45, 0, fk);
  [-.25, .25].forEach(z => box(1.1, .05, .12, M.steel, 1.6, .2, z, fk));
  box(1.2, .14, 1.0, M.wood, 1.65, .3, 0, fk); box(1.1, .8, .95, std(0xeef1f3, .6), 1.65, .78, 0, fk); box(.06, .12, .2, M.orange, -.3, 2.13, 0, fk);
  fk.traverse(o => { if (o.isMesh) o.castShadow = true; }); mergeStatic(fk);
  anim.push(t => { const c = (t % 40) / 40, u = c < .45 ? sm(c / .45) : c < .5 ? 1 : c < .95 ? 1 - sm((c - .5) / .45) : 0; fk.position.set(-12 + u * 30, 0, 14.9); });

  // staged pallets beside the line
  [[-3, 11.9], [-1.6, 11.9], [12.8, 4.6], [12.8, 6]].forEach(([x, z]) => { box(1.2, .14, 1.0, M.wood, x, .07, z, L); const h = rnd(.5, 1.1); box(1.1, h, .95, Math.random() < .5 ? M.card : std(0xeef1f3, .6), x, .14 + h / 2, z, L); });

  // ---------- finish: shadows only from line equipment, merge statics ----------
  B.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; } });
  L.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  D.traverse(o => { if (o.isMesh) o.receiveShadow = true; });
  const nb = mergeStatic(B), nl = mergeStatic(L);
  B.traverse(o => { if (o.isMesh) o.castShadow = false; });

  // ---------- moving cartons (instanced) with sort-by-height diversion ----------
  const cardTex = tex(128, 128, g => { g.fillStyle = '#c99f6c'; g.fillRect(0, 0, 128, 128); g.fillStyle = '#dcbd8f'; g.fillRect(54, 0, 20, 128); g.fillStyle = 'rgba(80,50,20,.25)'; g.fillRect(0, 0, 128, 3); g.fillRect(0, 125, 128, 3); });
  const NB = 22, LA = PB[1] - PA[1], LB = PB[0] - PC[0], LT = LA + LB, SP = SZ - PA[1];
  const cartons = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ map: cardTex, roughness: .85 }), NB);
  cartons.castShadow = true; cartons.receiveShadow = true; cartons.frustumCulled = false; D.add(cartons);
  const hash = n => { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); };
  let pushState = 0;
  anim.push(t => {
    let push = 0;
    for (let i = 0; i < NB; i++) {
      const raw = t * .6 + i * LT / NB, s = raw % LT, cyc = Math.floor(raw / LT), tall = hash(i * 13 + cyc) < .3, h = tall ? .55 : .3;
      let x, y = BELT_Y + h / 2, z, show = s > .5;
      if (tall && s > SP) { const d = s - SP; z = PA[1] + SP;
        if (d < .55) { x = PA[0] + d * 1.5; push = Math.max(push, d / .55); }
        else { const u = (d - .55) * 1.2; x = PA[0] + .82 + u; y -= u * Math.tan(slope); if (x > 10.95) show = false; } }
      else if (s < LA) { x = PA[0]; z = PA[1] + s; }
      else { x = PB[0] - (s - LA); z = PB[1]; if (x < PC[0] + .05) show = false; }
      m4.compose(v.set(x, y, z), q.identity(), show ? sc.set(.4, h, .35) : sc.set(0, 0, 0)); cartons.setMatrixAt(i, m4);
    }
    cartons.instanceMatrix.needsUpdate = true;
    pushState = push > 0 ? push : pushState * .85;
    plate.position.x = 7.75 + pushState * .8; rod.scale.y = .3 + pushState * .8; rod.position.set(7.4 + pushState * .4, BELT_Y + .18, SZ);
    sl.aSort.emissiveIntensity = pushState > .05 ? 2.4 : 0;
  });

  console.info('[hall] merged', nb + nl, 'static meshes;', cols.length, 'columns;', slots.length, 'rack loads');
  return { update: (dt, t) => anim.forEach(f => f(t, dt)) };
}
