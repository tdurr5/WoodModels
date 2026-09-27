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

// ---------- joining overlapping pieces into one ----------
// A rail modeled as two overlapping boards is one longer piece: its size
// runs from the first board's end to the last one's. list: object_dims
// entries lying on one line (as findOverlaps reports them).
export function joinDims(list, toLabel = (x) => `${x}`) {
  const A = list[0];
  if (!A?.axes || A.axes.length !== 3) return null;
  const ax = A.axes[0].direction;
  let lo = Infinity, hi = -Infinity;
  for (const d of list) {
    if (!d?.axes || Math.abs(dot(d.axes[0].direction, ax)) < 0.999) return null;
    const t = dot(sub(d.center, A.center), ax);
    lo = Math.min(lo, t - d.axes[0].length / 2);
    hi = Math.max(hi, t + d.axes[0].length / 2);
  }
  const mid = (lo + hi) / 2;
  const length = Math.round((hi - lo) * 1e4) / 1e4;
  return {
    center: A.center.map((c, k) => Math.round((c + ax[k] * mid) * 1e4) / 1e4),
    axes: [{ ...A.axes[0], length, label: toLabel(length) }, ...A.axes.slice(1)],
  };
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
export function endJoints(A, tris, others, { tol = 1 / 32, minDepth = 1 / 8 } = {}) {
  const [L, W, T] = A.axes;
  const len = A.half[0] * 2;
  const out = [];
  for (const s of [1, -1]) {
    const end = A.center.map((c, k) => c + s * L[k] * A.half[0]);
    const back = L.map((v) => -s * v); // from the end back into A
    let best = null;
    for (const { name, box } of others) {
      if (!pointInObb(end, box, tol)) continue;
      // back along A from its end to where it leaves B: B's surface
      const exitT = rayExit(end, back, box);
      if (exitT === null) continue;
      const depth = exitT;
      // mostly inside B isn't a joint (a copy, a part drawn inside another)
      if (depth > len * 0.6) continue;
      if (depth < minDepth) {
        // stops at B's surface: a butt joint, if A's end face lies against B
        if (!best && Math.abs(depth) <= tol * 2) best = { name, depth: 0, kind: 'butt' };
        continue;
      }
      if (best && best.kind !== 'butt' && best.depth >= depth) continue;
      // the size of what goes in: A's vertices between its end and B's surface
      let w0 = Infinity, w1 = -Infinity, t0 = Infinity, t1 = -Infinity;
      for (let i = 0; i + 2 < tris.length; i += 3) {
        const d = [tris[i] - end[0], tris[i + 1] - end[1], tris[i + 2] - end[2]];
        if (dot(d, back) > depth - tol) continue;
        const w = dot(d, W), t = dot(d, T);
        w0 = Math.min(w0, w); w1 = Math.max(w1, w); t0 = Math.min(t0, t); t1 = Math.max(t1, t);
      }
      if (w0 === Infinity) continue;
      const width = w1 - w0, thick = t1 - t0;
      if (width < 1 / 16 || thick < 1 / 16) continue;
      // a tenon or housed end sits within B's outline all round (the mortise
      // or dado has walls); a board crossing B, or sitting on it, sticks out
      const mid = end.map((c, k) => c + back[k] * depth / 2);
      const corner = (w, t) => mid.map((c, k) => c + W[k] * w + T[k] * t);
      if (![[w0, t0], [w0, t1], [w1, t0], [w1, t1]].every(([w, t]) => pointInObb(corner(w, t), box, tol))) continue;
      const fullW = A.half[1] * 2, fullT = A.half[2] * 2;
      const shouldered = width < fullW - 1 / 16 || thick < fullT - 1 / 16;
      // out the far side: A's end is at B's surface on the other side too
      const through = !pointInObb(end.map((c, k) => c + back[k] * -tol * 2), box, 0);
      best = { name, depth, kind: shouldered ? 'tenon' : 'housed', width, thick, through };
    }
    if (best) out.push({ end: s, ...best });
  }
  return out;
}

// Distance along the ray from p (inside box B) to where it leaves B.
function rayExit(p, dir, B) {
  const d = sub(p, B.center);
  let tExit = Infinity;
  for (let i = 0; i < 3; i++) {
    const a = dot(d, B.axes[i]), v = dot(dir, B.axes[i]);
    if (Math.abs(v) < 1e-9) continue;
    const t = ((v > 0 ? B.half[i] : -B.half[i]) - a) / v;
    tExit = Math.min(tExit, t);
  }
  return tExit === Infinity ? null : Math.max(0, tExit);
}
