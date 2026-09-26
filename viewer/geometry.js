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
