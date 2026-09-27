// Automatic fixes for rough models. Same-size pieces lying in the same space
// (geometry.js findOverlaps) are looked at closely: sample points in the
// shared stretch and test whether each is inside both meshes. Both, over most
// of it: the pieces really fill the same space - one longer piece modeled as
// two (join them) or a copy left in place (drop it). Each board in only one:
// a lap joint, real joinery - leave it.

import * as THREE from 'three';

// SketchUp exports every face twice (front and back); keep one copy of each
// triangle so ray crossings and surface areas count each face once.
const singleSidedCache = new WeakMap();
export function singleSidedGeometry(geo) {
  if (singleSidedCache.has(geo)) return singleSidedCache.get(geo);
  const src = geo.index ? geo.toNonIndexed() : geo;
  const pos = src.attributes.position.array;
  const seen = new Set();
  const keep = [];
  const k = (i) => `${pos[i].toFixed(4)},${pos[i + 1].toFixed(4)},${pos[i + 2].toFixed(4)}`;
  for (let t = 0; t + 8 < pos.length; t += 9) {
    const key = [k(t), k(t + 3), k(t + 6)].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    for (let j = 0; j < 9; j++) keep.push(pos[t + j]);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(keep, 3));
  singleSidedCache.set(geo, out);
  return out;
}

// Inside a closed mesh: an odd number of surface crossings along every ray.
const insideRay = new THREE.Raycaster();
const solidCache = new WeakMap();
function isInside(mesh, p, dirs) {
  let solid = solidCache.get(mesh);
  if (!solid) {
    solid = new THREE.Mesh(singleSidedGeometry(mesh.geometry), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    solid.updateMatrixWorld();
    solidCache.set(mesh, solid);
  }
  return dirs.every((d) => {
    insideRay.set(p, d);
    let n = 0, last = -1;
    insideRay.intersectObject(solid, false).forEach((h) => { if (h.distance - last > 1e-4) { n++; last = h.distance; } });
    return n % 2 === 1;
  });
}

// 'join' | 'dupe' | 'lap' | 'unsure' for one overlap {a, b, span}
function classifyOverlap(o, dims, meshOf) {
  const A = dims[o.a], B = dims[o.b];
  const ma = meshOf(o.a), mb = meshOf(o.b);
  if (!A || !B || !ma || !mb) return 'unsure';
  const [L, W, T] = A.axes.map((a) => new THREE.Vector3(...a.direction).normalize());
  const [lenA, wA, tA] = A.axes.map((a) => a.length);
  const lenB = B.axes[0].length;
  const cA = new THREE.Vector3(...A.center);
  const t = new THREE.Vector3(...B.center).sub(cA).dot(L);
  const lo = Math.max(-lenA / 2, t - lenB / 2), hi = Math.min(lenA / 2, t + lenB / 2);
  let both = 0, one = 0, total = 0;
  for (let i = 0; i < 5; i++) {
    const s = lo + (hi - lo) * (0.1 + 0.2 * i);
    for (const [fw, ft] of [[0.25, 0.25], [0.25, -0.25], [-0.25, 0.25], [-0.25, -0.25]]) {
      const p = cA.clone().addScaledVector(L, s).addScaledVector(W, fw * wA).addScaledVector(T, ft * tA);
      const ia = isInside(ma, p, [W, T]), ib = isInside(mb, p, [W, T]);
      total++;
      if (ia && ib) both++; else if (ia || ib) one++;
    }
  }
  if (both / total >= 0.75) return o.span <= Math.max(lenA, lenB) + 1 / 16 ? 'dupe' : 'join';
  if (both / total <= 0.1 && one / total >= 0.5) return 'lap';
  return 'unsure';
}

// kinds: "a|b" -> what classifyOverlap made of it; fixes: { joins: chains of
// part names to join, dupes: copies to drop }, applied under your edits.
export function classifyOverlaps(overlaps, dims, meshOf) {
  const kinds = new Map();
  const dupes = new Set();
  const joinPairs = [];
  overlaps.forEach((o) => {
    const kind = classifyOverlap(o, dims, meshOf);
    kinds.set(`${o.a}|${o.b}`, kind);
    if (kind === 'dupe') {
      // drop the shorter one (the one inside the other); the second if equal
      const la = dims[o.a].axes[0].length, lb = dims[o.b].axes[0].length;
      dupes.add(la < lb - 1 / 64 ? o.a : o.b);
    } else if (kind === 'join') joinPairs.push(o);
  });
  // chains of overlapping boards become one piece each
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
  joinPairs.forEach(({ a, b }) => {
    if (dupes.has(a) || dupes.has(b)) return;
    [a, b].forEach((n) => { if (!parent.has(n)) parent.set(n, n); });
    parent.set(find(a), find(b));
  });
  const chains = new Map();
  [...parent.keys()].forEach((n) => { const r = find(n); if (!chains.has(r)) chains.set(r, []); chains.get(r).push(n); });
  return { kinds, fixes: { joins: [...chains.values()].map((names) => names.sort()), dupes: [...dupes] } };
}
