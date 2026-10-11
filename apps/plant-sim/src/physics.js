// Plant physics for "Sorting by Height (Basic)", in the coordinates factory3d.js uses.
// Entry belt along +x from -8.8 to -1.2 at z=0; chain transfer at the origin; left lane toward z=-8.2,
// right lane toward z=+8.2. Boxes are 0.75 m cubes (tall ones are taller, same footprint).
// The physics only reads PLC outputs and produces sensor values; it never decides anything itself.

const HALF = 0.375; // half box footprint
const GAP = 0.06; // min clearance between boxes on a belt
const PITCH = 2 * HALF + GAP;

export const GEOMETRY = {
  entryStartX: -8.8,
  entryEndX: -1.2, // belt end / end-stop face
  xferHalf: 1.1, // chain transfer table half-size
  laneEnd: 8.2,
  heightGateX: Number(process.env.HEIGHT_GATE_X ?? -1.7), // see README: the real program measures at the end-stop
  palletX: -1.7,
  leftEntryZ: -2, leftExitZ: -6.5, rightEntryZ: 2, rightExitZ: 6.5,
  speed: Number(process.env.BELT_SPEED ?? 1.5),
  emitEveryS: Number(process.env.EMIT_EVERY_S ?? 3),
};

export class Plant {
  constructor(g = GEOMETRY, rng = Math.random) {
    this.g = g;
    this.rng = rng;
    this.boxes = []; // { id, x, z, tall, seg: 'entry'|'xfer'|'left'|'right' }
    this.nextId = 1;
    this.emitT = g.emitEveryS - 0.5; // first box shortly after the belt starts
    this.sorted = { left: 0, right: 0 };
    this.time = 0;
  }

  entryFree() {
    return !this.boxes.some((b) => b.seg === 'entry' && b.x < this.g.entryStartX + PITCH);
  }

  spawn(tall = null) {
    if (!this.entryFree()) return null;
    const b = { id: this.nextId++, x: this.g.entryStartX, z: 0, tall: tall ?? this.rng() < 0.5, seg: 'entry' };
    this.boxes.push(b);
    return b;
  }

  /** Advance dt seconds under the PLC outputs `out` (by tag name). */
  step(dt, out) {
    const g = this.g, v = g.speed * dt;
    this.time += dt;
    const on = (n) => !!out[n];

    // emission while the entry conveyor runs
    if (on('Conveyor entry')) {
      this.emitT += dt;
      if (this.emitT >= g.emitEveryS && this.spawn()) this.emitT = 0;
    }

    const xferBox = this.boxes.find((b) => b.seg === 'xfer');
    const stopX = g.entryEndX - HALF; // box resting against the end-stop

    // --- entry belt: front to back so queued boxes stack behind each other
    const entry = this.boxes.filter((b) => b.seg === 'entry').sort((a, b) => b.x - a.x);
    let limit = Infinity;
    for (const b of entry) {
      let nx = b.x;
      const onBeltEnd = b.x >= stopX - 0.02; // at the end-stop, the transfer rollers can pull it in
      if (on('Conveyor entry')) nx += v;
      if (onBeltEnd && on('Load') && !xferBox) nx = Math.max(nx, b.x + v); // rollers drag it onto the transfer
      // end-stop unless the transfer is loading and empty
      const canPass = on('Load') && !xferBox;
      if (!canPass) nx = Math.min(nx, stopX);
      nx = Math.min(nx, limit);
      b.x = nx;
      limit = b.x - PITCH;
      if (b.x > g.entryEndX - HALF + 0.3) { b.seg = 'xfer'; } // past the belt end: now on the transfer
    }

    // --- chain transfer
    for (const b of this.boxes.filter((b) => b.seg === 'xfer')) {
      const lateral = on('Transf. left') ? -1 : on('Transf. right') ? 1 : 0;
      if (lateral === 0) {
        if (on('Load')) b.x = Math.min(0, b.x + v);
        else if (on('Unload')) b.x = Math.max(-0.6, b.x - v);
      } else {
        b.x += Math.sign(-b.x) * Math.min(Math.abs(b.x), v); // chains centre the box while moving it sideways
        b.z += lateral * v;
      }
      if (Math.abs(b.z) > g.xferHalf - 0.1) {
        // clear of the table: hand over to the lane, but only if the lane entry is free
        const lane = b.z < 0 ? 'left' : 'right';
        const blocked = this.boxes.some((o) => o.seg === lane && Math.abs(o.z) < Math.abs(b.z) + PITCH);
        if (blocked) b.z = Math.sign(b.z) * (g.xferHalf - 0.1);
        else { b.seg = lane; b.x = 0; }
      }
    }

    // --- side lanes (also pushed by the transfer chains for the first ~half metre)
    for (const lane of ['left', 'right']) {
      const s = lane === 'left' ? -1 : 1;
      const onLane = this.boxes.filter((b) => b.seg === lane).sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
      let lim = Infinity;
      const pushing = on(lane === 'left' ? 'Transf. left' : 'Transf. right');
      for (const b of onLane) {
        let d = Math.abs(b.z);
        if (on(lane === 'left' ? 'Conveyor left' : 'Conveyor right') || (pushing && d < g.xferHalf + HALF + 0.1)) d += v;
        d = Math.min(d, lim);
        b.z = s * d;
        lim = d - PITCH;
      }
    }

    // --- removal at the lane ends
    this.boxes = this.boxes.filter((b) => {
      if ((b.seg === 'left' || b.seg === 'right') && Math.abs(b.z) > g.laneEnd) { this.sorted[b.seg]++; return false; }
      return true;
    });
  }

  /** Sensor values (TRUE/FALSE as the PLC sees them, i.e. retro eyes are TRUE when clear). */
  sensors() {
    const g = this.g;
    const covers = (b, axis, at) => Math.abs(b[axis] - at) < HALF;
    const any = (f) => this.boxes.some(f);
    const atGate = (b) => (b.seg === 'entry' || b.seg === 'xfer') && Math.abs(b.z) < HALF && covers(b, 'x', g.heightGateX);
    return {
      'High sensor': any((b) => atGate(b) && b.tall),
      'Low sensor': any(atGate),
      'Pallet sensor': any((b) => (b.seg === 'entry' || b.seg === 'xfer') && Math.abs(b.z) < HALF && covers(b, 'x', g.palletX)),
      Loaded: any((b) => b.seg === 'xfer' && b.x > -0.5),
      'At left entry': !any((b) => b.seg === 'left' && covers(b, 'z', g.leftEntryZ)),
      'At left exit': !any((b) => b.seg === 'left' && covers(b, 'z', g.leftExitZ)),
      'At right entry': !any((b) => b.seg === 'right' && covers(b, 'z', g.rightEntryZ)),
      'At right exit': !any((b) => b.seg === 'right' && covers(b, 'z', g.rightExitZ)),
    };
  }

  snapshot() {
    return this.boxes.map((b) => ({ id: b.id, x: +b.x.toFixed(3), z: +b.z.toFixed(3), tall: b.tall, seg: b.seg }));
  }
}
