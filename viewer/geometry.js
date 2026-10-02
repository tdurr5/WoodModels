// Oriented-bounding-box tests used to find which parts touch or pass through
// each other (joints, bolt holes). Plain arrays, no three.js, unit-tested.
//
// An OBB is { center: [x,y,z], axes: [[x,y,z] x3 unit], half: [hx,hy,hz] },
// built from an object_dims.json entry with obbFromDims().

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function obbFromDims(d, offset = [0, 0, 0]) {
  const axes = d.axes.map((a) => a.direction);
  const half = d.axes.map((a) => a.length / 2);
  // Flat/degenerate parts may have fewer than 3 axes; complete the frame.
  while (axes.length < 3) {
    const n = axes.length === 2 ? cross(axes[0], axes[1]) : Math.abs(axes[0][1]) < 0.9 ? cross(axes[0], [0, 1, 0]) : cross(axes[0], [1, 0, 0]);
    const len = Math.hypot(...n) || 1;
    axes.push(n.map((v) => v / len));
    half.push(0);
  }
  return { center: [d.center[0] + offset[0], d.center[1] + offset[1], d.center[2] + offset[2]], axes, half };
}

// Separating-axis test, boxes grown by `tol` on every side.
export function obbOverlap(A, B, tol = 0) {
  const ha = A.half.map((h) => h + tol), hb = B.half.map((h) => h + tol);
  const t = sub(B.center, A.center);
  const test = (L) => {
    const len = Math.hypot(...L);
    if (len < 1e-9) return true; // parallel edges: axis degenerate, skip
    const n = L.map((v) => v / len);
    const ra = ha[0] * Math.abs(dot(A.axes[0], n)) + ha[1] * Math.abs(dot(A.axes[1], n)) + ha[2] * Math.abs(dot(A.axes[2], n));
    const rb = hb[0] * Math.abs(dot(B.axes[0], n)) + hb[1] * Math.abs(dot(B.axes[1], n)) + hb[2] * Math.abs(dot(B.axes[2], n));
    return Math.abs(dot(t, n)) <= ra + rb + 1e-9;
  };
  for (let i = 0; i < 3; i++) if (!test(A.axes[i]) || !test(B.axes[i])) return false;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (!test(cross(A.axes[i], B.axes[j]))) return false;
  return true;
}

export function pointInObb(p, B, tol = 0) {
  const d = sub(p, B.center);
  for (let i = 0; i < 3; i++) if (Math.abs(dot(d, B.axes[i])) > B.half[i] + tol) return false;
  return true;
}

// Does segment p-q pass through (or within `tol` of) box B? Slab test in
// B's local frame.
export function segmentHitsObb(p, q, B, tol = 0) {
  const dp = sub(p, B.center), dq = sub(q, B.center);
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 3; i++) {
    const a = dot(dp, B.axes[i]), b = dot(dq, B.axes[i]);
    const h = B.half[i] + tol, d = b - a;
    if (Math.abs(d) < 1e-12) {
      if (Math.abs(a) > h) return false;
      continue;
    }
    let lo = (-h - a) / d, hi = (h - a) / d;
    if (lo > hi) [lo, hi] = [hi, lo];
    t0 = Math.max(t0, lo); t1 = Math.min(t1, hi);
    if (t0 > t1) return false;
  }
  return true;
}

// Do two parts touch? Their boxes must overlap, and some actual mesh edge of
// one must pass through (or within `tol` of) the other's box. That weeds out
// boxes that only clip each other's empty corners, and still catches a rod
// passing straight through a board (whose vertices are all outside it).
// `trisA`/`trisB` are flat triangle vertex arrays [x,y,z, x,y,z, x,y,z, ...].
export function partsTouch(A, trisA, B, trisB, tol = 0.03) {
  if (!obbOverlap(A, B, tol)) return false;
  const edgesHit = (tris, box) => {
    for (let i = 0; i + 8 < tris.length; i += 9) {
      const v = [[tris[i], tris[i + 1], tris[i + 2]], [tris[i + 3], tris[i + 4], tris[i + 5]], [tris[i + 6], tris[i + 7], tris[i + 8]]];
      if (segmentHitsObb(v[0], v[1], box, tol) || segmentHitsObb(v[1], v[2], box, tol) || segmentHitsObb(v[2], v[0], box, tol)) return true;
    }
    return false;
  };
  return edgesHit(trisA, B) || edgesHit(trisB, A);
}

// Pieces of the same cross-section lying in the same place: a board copied
// and left on top of itself, or slid along (two 68" rails overlapping by 56"
// that look like one 80" rail). Rough models have these; a dowel in a hole or
// a tenon in a mortise has a different cross-section, so it isn't flagged.
// dims: object_dims.json. Returns [{ a, b, overlap, span }] (inches, along
// the pieces' length), each pair once.
export function findOverlaps(dims, { tol = 1 / 16, minOverlap = 1 } = {}) {
  const parts = Object.entries(dims)
    .filter(([, d]) => d.axes && d.axes.length === 3)
    .map(([name, d]) => ({ name, c: d.center, ax: d.axes.map((a) => a.direction), len: d.axes.map((a) => a.length) }));
  // bucket by cross-section so only look-alikes are compared
  const buckets = new Map();
  parts.forEach((p) => {
    const k = `${Math.round(p.len[1] * 16)}|${Math.round(p.len[2] * 16)}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(p);
  });
  const out = [];
  buckets.forEach((list) => {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i], B = list[j];
        if (Math.abs(A.len[1] - B.len[1]) > tol || Math.abs(A.len[2] - B.len[2]) > tol) continue;
        // same orientation: length along length, width along width
        if (Math.abs(dot(A.ax[0], B.ax[0])) < 0.999 || Math.abs(dot(A.ax[1], B.ax[1])) < 0.999) continue;
        const d = sub(B.c, A.c);
        // side by side is fine; they must sit on the same line
        if (Math.abs(dot(d, A.ax[1])) > tol || Math.abs(dot(d, A.ax[2])) > tol) continue;
        const t = dot(d, A.ax[0]);
        const lo = Math.max(-A.len[0] / 2, t - B.len[0] / 2), hi = Math.min(A.len[0] / 2, t + B.len[0] / 2);
        if (hi - lo < minOverlap) continue;
        const span = Math.max(A.len[0] / 2, t + B.len[0] / 2) - Math.min(-A.len[0] / 2, t - B.len[0] / 2);
        out.push({ a: A.name, b: B.name, overlap: hi - lo, span });
      }
    }
  });
  return out;
}

// Boards butted end to end: same cross-section, same way round, on one
// line, the end of one touching the end of the next. Nobody glues end grain
// to end grain without a joint, and a drawn tenon would overlap - so it's
// one longer board the model drew in pieces. Returns lists of mesh names,
// each a chain of pieces that make one board (three in a row is one list).
export function findButts(dims, { tol = 1 / 32 } = {}) {
  const parts = Object.entries(dims)
    .filter(([, d]) => d.axes && d.axes.length === 3)
    .map(([name, d]) => ({ name, c: d.center, ax: d.axes.map((a) => a.direction), len: d.axes.map((a) => a.length) }));
  const buckets = new Map();
  parts.forEach((p) => {
    const k = `${Math.round(p.len[1] * 16)}|${Math.round(p.len[2] * 16)}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(p);
  });
  const parent = new Map(parts.map((p) => [p.name, p.name]));
  const find = (n) => { while (parent.get(n) !== n) n = parent.get(n); return n; };
  buckets.forEach((list) => {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i], B = list[j];
        if (Math.abs(A.len[1] - B.len[1]) > tol || Math.abs(A.len[2] - B.len[2]) > tol) continue;
        if (Math.abs(dot(A.ax[0], B.ax[0])) < 0.999 || Math.abs(dot(A.ax[1], B.ax[1])) < 0.999) continue;
        const d = sub(B.c, A.c);
        if (Math.abs(dot(d, A.ax[1])) > tol || Math.abs(dot(d, A.ax[2])) > tol) continue;
        const gap = Math.abs(dot(d, A.ax[0])) - (A.len[0] + B.len[0]) / 2;
        if (Math.abs(gap) <= tol) parent.set(find(A.name), find(B.name));
      }
    }
  });
  const groups = new Map();
  parts.forEach((p) => {
    const r = find(p.name);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(p.name);
  });
  return [...groups.values()].filter((g) => g.length > 1);
}

// Pieces drawn inside another part that are really part of it: teeth cut
// in a ratchet block, a tongue left on a board, drawn as their own little
// components. Each sits wholly inside the host's box, comes out to one of
// its faces (it's the shape of that face, not something buried in it), and
// is the same stuff. A dowel or peg in a hole is round, a bolt is hardware,
// an inlay is a different wood: those stay their own parts.
// sameStuff(a, b): same material; round(name): a turned part.
// Returns [[host, ...pieces]].
export function findInsets(dims, { sameStuff = () => true, round = () => false, tol = 1 / 32 } = {}) {
  const parts = Object.entries(dims)
    .filter(([, d]) => d.axes && d.axes.length === 3)
    .map(([name, d]) => ({ name, d, box: obbFromDims(d), vol: d.axes.reduce((v, a) => v * a.length, 1) }));
  const hostOf = new Map();
  for (const A of parts) {
    if (round(A.name)) continue;
    const corners = cornersOf(A.box);
    let best = null;
    for (const B of parts) {
      if (B === A || B.vol < A.vol * 4 || !sameStuff(A.name, B.name)) continue;
      if (!corners.every((c) => pointInObb(c, B.box, tol))) continue;
      // out to one of B's faces: some corner on B's surface
      const local = (c) => B.box.axes.map((ax, k) => Math.abs(dot(sub(c, B.box.center), ax)) - B.box.half[k]);
      if (!corners.some((c) => local(c).some((v) => Math.abs(v) <= tol))) continue;
      if (!best || B.vol < best.vol) best = B; // the tightest host
    }
    if (best) hostOf.set(A.name, best.name);
  }
  const groups = new Map();
  hostOf.forEach((host, name) => {
    if (hostOf.has(host)) return; // a piece inside a piece: leave it
    if (!groups.has(host)) groups.set(host, [host]);
    groups.get(host).push(name);
  });
  return [...groups.values()];
}
function cornersOf(B) {
  const out = [];
  for (let i = 0; i < 8; i++) {
    const s = [i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1];
    out.push(B.center.map((c, k) => c + B.axes.reduce((a, ax, j) => a + ax[k] * s[j] * B.half[j], 0)));
  }
  return out;
}

// ---------- joining pieces into one ----------
// Pieces that are really one: a rail modeled as two overlapping or butted
// boards, or pieces you merged yourself (a glued-up slab). list: their
// object_dims entries. as one: the box around them all, square to the first piece -
// boards end to end (a rail modeled as two) come out longer, boards side by
// side (a glued-up slab) wider or thicker. Axes are re-ranked by length.
export function joinDims(list, toLabel = (x) => `${x}`) {
  const A = list[0];
  if (!A?.axes || A.axes.length !== 3) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const d of list) {
    if (!d?.axes || d.axes.length !== 3) return null;
    for (let k = 0; k < 3; k++) {
      const ax = A.axes[k].direction;
      const t = dot(sub(d.center, A.center), ax);
      const r = d.axes.reduce((s, a) => s + Math.abs(dot(a.direction, ax)) * a.length / 2, 0);
      lo[k] = Math.min(lo[k], t - r);
      hi[k] = Math.max(hi[k], t + r);
    }
  }
  const center = A.center.map((c, i) => Math.round((c + A.axes.reduce((s, a, k) => s + a.direction[i] * (lo[k] + hi[k]) / 2, 0)) * 1e4) / 1e4);
  const axes = A.axes.map((a, k) => {
    const length = Math.round((hi[k] - lo[k]) * 1e4) / 1e4;
    return { ...a, length, label: toLabel(length) };
  }).sort((a, b) => b.length - a.length);
  ['Length', 'Width', 'Thickness'].forEach((role, i) => { axes[i] = { ...axes[i], role }; });
  return { center, axes };
}

// Apply edits.joins (lists of mesh names) to parts_report rows and
// object_dims: the joined meshes leave their rows and form a part of their
// own (one piece per join, identical joins sharing a row); each join gets a
// dims entry named "meshA+meshB". Joins that no longer apply are skipped.
export function applyJoins(rawRows, joins, dims, toLabel = (x) => `${x}`) {
  if (!joins || !joins.length) return { rows: rawRows, dims };
  const outDims = { ...dims };
  const rowOf = new Map();
  rawRows.forEach((r) => (r.obj_names || []).forEach((n) => rowOf.set(n, r)));
  const taken = new Set();
  const joined = new Map();
  for (const names of joins) {
    const rows = names.map((n) => rowOf.get(n));
    if (names.length < 2 || names.some((n) => taken.has(n) || !dims[n]) || rows.some((r) => !r || r.count !== r.obj_names.length)) continue;
    const d = joinDims(names.map((n) => dims[n]), toLabel);
    if (!d) continue;
    names.forEach((n) => taken.add(n));
    const key = names.join('+');
    outDims[key] = d;
    const size = d.axes.map((a) => Math.round(a.length * 1000) / 1000).sort((a, b) => b - a);
    const base = rows[0];
    const rk = `${base.label}|${size.join('x')}`;
    if (!joined.has(rk)) {
      joined.set(rk, {
        label: base.label, top_group: base.top_group, dims: size, count: 0, materials: base.materials || [],
        paths: [], obj_names: [], pieces: [], joined: true, auto_name: base.auto_name,
        dims_str: size.map((x) => toLabel(x)).join(' x '),
      });
    }
    const jr = joined.get(rk);
    jr.count += 1;
    jr.obj_names.push(...names);
    jr.pieces.push(names);
  }
  if (!taken.size) return { rows: rawRows, dims };
  const rows = rawRows.map((r) => {
    const keep = (r.obj_names || []).filter((n) => !taken.has(n));
    if (keep.length === (r.obj_names || []).length) return r;
    return keep.length ? { ...r, obj_names: keep, count: keep.length } : null;
  }).filter(Boolean);
  return { rows: [...rows, ...joined.values()], dims: outDims };
}

// ---------- joinery: where a part's end goes into another ----------
// A rail drawn with its tenons pushed into the legs is measured end to end,
// tenons included - right for cutting it, but nothing says so, and the legs
// need mortises. For each end of part A (along its length): the part B that
// end sits inside, how deep it goes in (B's surface to A's end), the size of
// what goes in (A's own vertices past B's surface: narrower than A means a
// shouldered tenon, full size a housed end), and whether it comes out the
// far side (a through tenon). Ends that stop at another part's surface are
// butt joints. A: obbFromDims (axes Length, Width, Thickness); tris: A's
// triangle vertices [x,y,z, ...]; others: [{ name, box }].
//
// What goes in isn't always a tenon, and calling it one gets the advice
// wrong. The shape of the end says which joint it is:
//   'mitre'    the end is cut at 45° (a moulding or frame meeting at a corner)
//   'dovetail' faces near the end slope a few degrees off the length: the
//              flanks of drawn tails or pins (slope: 6 for 1:6)
//   'corner'   full size, into the end of the other part: a box joint, lap
//              or rabbet at a corner, drawn as the boards overlapping
//   'tongue'   full width but thinner: a panel's edge in a groove (rabbeted:
//              flush with one face, as a chest bottom often is)
//   'housed'   full size, into the other part's face: a dado
//   'teeth'    a sawtooth end (45° faces) in the middle of the other part:
//              a ratchet catching its teeth - adjustable, never glued
//   'tenon'    shouldered all round, or on its edges
export function endJoints(A, tris, others, { tol = 1 / 32, minDepth = 1 / 8 } = {}) {
  const [L, W, T] = A.axes;
  const len = A.half[0] * 2;
  const maxProud = Math.min(1, len * 0.1); // a through tenon left long past the far face
  const out = [];
  for (const s of [1, -1]) {
    const end = A.center.map((c, k) => c + s * L[k] * A.half[0]);
    const back = L.map((v) => -s * v); // from the end back into A
    let best = null;
    for (const { name, box } of others) {
      // where the line from A's end back along A is inside B: [t0, t1]
      const span = raySpan(end, back, box);
      if (!span) {
        // stops at B's surface: a butt joint, if A's end face lies against B
        if (!best && pointInObb(end, box, tol)) best = { name, depth: 0, kind: 'butt' };
        continue;
      }
      const [t0, t1] = span;
      // B is further along A, or A only crosses it near its end (a peg through
      // a beam): a through tenon stands proud by a little of what's inside
      if (t0 > maxProud || t0 > (t1 - t0) * 0.25) continue;
      const depth = t1; // A's end to B's near face: all that goes in (and through)
      // mostly inside B isn't a joint (a copy, a part drawn inside another)
      if (depth > len * 0.6) continue;
      if (depth < minDepth) {
        if (!best && depth <= tol * 2) best = { name, depth: 0, kind: 'butt' };
        continue;
      }
      if (best && best.kind !== 'butt' && best.depth >= depth) continue;
      // the size of what goes in: A's vertices between its end and B's near face
      let w0 = Infinity, w1 = -Infinity, u0 = Infinity, u1 = -Infinity;
      for (let i = 0; i + 2 < tris.length; i += 3) {
        const d = [tris[i] - end[0], tris[i + 1] - end[1], tris[i + 2] - end[2]];
        if (dot(d, back) > depth - tol) continue;
        const w = dot(d, W), t = dot(d, T);
        w0 = Math.min(w0, w); w1 = Math.max(w1, w); u0 = Math.min(u0, t); u1 = Math.max(u1, t);
      }
      if (w0 === Infinity) continue;
      const width = w1 - w0, thick = u1 - u0;
      if (width < 1 / 16 || thick < 1 / 16) continue;
      // a tenon or housed end sits within B's outline all round (the mortise
      // or dado has walls); a board crossing B, or sitting on it, sticks out
      const mid = end.map((c, k) => c + back[k] * (t0 + t1) / 2);
      const corner = (w, t) => mid.map((c, k) => c + W[k] * w + T[k] * t);
      if (![[w0, u0], [w0, u1], [w1, u0], [w1, u1]].every(([w, t]) => pointInObb(corner(w, t), box, tol))) continue;
      const fullW = A.half[1] * 2, fullT = A.half[2] * 2;
      const shouldered = width < fullW - 1 / 16 || thick < fullT - 1 / 16;
      // out the far side: A's end stands proud of B, or is flush with its far face
      const through = t0 > tol || !pointInObb(end.map((c, k) => c + back[k] * -tol * 2), box, 0);
      const shape = endShape(tris, end, back, L, depth + tol, W, T);
      // does A, where it goes in, reach the end of B (a corner) or meet its
      // middle? Judged on A's whole section: of a mitre, only a sliver overlaps
      const BL = box.axes[0];
      const reach = Math.abs(dot(sub(mid, box.center), BL)) + (Math.abs(dot(W, BL)) * fullW + Math.abs(dot(T, BL)) * fullT) / 2;
      const atCorner = reach >= box.half[0] - tol * 2;
      let kind;
      // (a mitre closes a corner: 45° faces in the middle of a part are
      // something else - a ratchet's teeth, a bevelled stop)
      if (atCorner && shape.mitre > 0.3 * fullW * fullT) kind = 'mitre';
      else if (shape.mitre > 0.3 * fullW * fullT) kind = 'teeth'; // a ratchet's sawtooth end in another part's teeth
      else if (shape.flank > 0.5 * fullT * depth) kind = 'dovetail';
      else if (!shouldered) kind = atCorner ? 'corner' : 'housed';
      else if (width >= fullW - 1 / 16 && fullW > fullT * 2) kind = 'tongue';
      else kind = 'tenon';
      best = { name, depth, kind, width, thick, through, proud: t0 > tol ? t0 : 0 };
      if (kind === 'dovetail') { best.slope = Math.max(3, Math.round(1 / Math.tan(Math.asin(shape.flankSin)))); best.pins = shape.pins; }
      // a tongue flush with one face is a rabbeted edge
      if (kind === 'tongue') best.rabbeted = (Math.abs(u0 + fullT / 2) < 1 / 32) !== (Math.abs(u1 - fullT / 2) < 1 / 32);
    }
    if (best) out.push({ end: s, ...best });
  }
  return out;
}

// The faces of a part within `zone` of its end, by how they lie against its
// length: cut at 45° (a mitre), or sloped a few degrees off it (the flanks
// of dovetails, 1:5 to 1:10). Square ends and long faces count as neither.
// Areas are as exported (SketchUp's faces come in back-to-back pairs), which
// only matters as a ratio.
function endShape(tris, end, back, L, zone, W, T) {
  let mitre = 0, flank = 0, sinSum = 0, pins = 0;
  for (let i = 0; i + 8 < tris.length; i += 9) {
    const a = [tris[i], tris[i + 1], tris[i + 2]], b = [tris[i + 3], tris[i + 4], tris[i + 5]], c = [tris[i + 6], tris[i + 7], tris[i + 8]];
    const centroid = [0, 1, 2].map((k) => (a[k] + b[k] + c[k]) / 3);
    const along = dot(sub(centroid, end), back);
    if (along < -1e-6 || along > zone) continue;
    const n = cross(sub(b, a), sub(c, a));
    const twice = Math.hypot(n[0], n[1], n[2]);
    if (twice < 1e-9) continue;
    const k = Math.abs(dot(n, L)) / twice;
    if (k > 0.5 && k < 0.87) mitre += twice / 2;
    else if (k > 0.05 && k < 0.35) { flank += twice / 2; sinSum += k * twice / 2; }
    else if (k < 0.05) {
      // a pin's flanks run along the length but slope across the thickness
      const kw = Math.abs(dot(n, W)) / twice, kt = Math.abs(dot(n, T)) / twice;
      const off = Math.min(kw, kt);
      if (off > 0.05 && off < 0.35) { flank += twice / 2; sinSum += off * twice / 2; pins += twice / 2; }
    }
  }
  return { mitre, flank, flankSin: flank ? sinSum / flank : 0, pins: pins > flank / 2 };
}

// The stretch [t0, t1] (t0 >= 0) of the ray p + t*dir that lies inside box
// B, or null if it misses it.
function raySpan(p, dir, B) {
  const d = sub(p, B.center);
  let t0 = 0, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    const a = dot(d, B.axes[i]), v = dot(dir, B.axes[i]);
    if (Math.abs(v) < 1e-9) {
      if (Math.abs(a) > B.half[i] + 1e-9) return null;
      continue;
    }
    let lo = (-B.half[i] - a) / v, hi = (B.half[i] - a) / v;
    if (lo > hi) [lo, hi] = [hi, lo];
    t0 = Math.max(t0, lo); t1 = Math.min(t1, hi);
    if (t1 < t0) return null;
  }
  return t1 > 1e-9 ? [t0, t1] : null;
}
