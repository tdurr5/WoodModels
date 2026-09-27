// Cuts in a part: holes, mortises, notches, dados, grooves and rabbets, read
// from its shape. A grid of rays is cast through the part along each of its
// axes (length, width, thickness); where a ray finds less wood than the
// part's box holds, from a face inward or all the way through, something was
// cut away. Neighbouring rays that agree make up one cut. Plain arrays, no
// three.js; unit-tested.
//
// A: an OBB from geometry.js obbFromDims (axes Length, Width, Thickness).
// tris: the part's triangle vertices [x,y,z, ...], each face once
// (autofix.js singleSidedGeometry).

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ray direction axis -> the two axes of the grid it's cast from
const PLANE = [[1, 2], [0, 2], [0, 1]];
// which of the part's surfaces a cut along that axis goes into
const SURFACE = ['end', 'edge', 'face'];

export function cutFeatures(A, tris, {
  step = 1 / 16, maxCells = 250000, minSize = 1 / 8, minDepth = 1 / 16, ends = [0, 0],
} = {}) {
  const ext = A.half.map((h) => h * 2);
  if (Math.min(...ext) < minSize) return []; // a flat face has no cuts to find
  // every vertex in the part's own frame, 0..ext on each axis
  const n = Math.floor(tris.length / 3);
  const loc = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = [tris[i * 3] - A.center[0], tris[i * 3 + 1] - A.center[1], tris[i * 3 + 2] - A.center[2]];
    for (let k = 0; k < 3; k++) loc[i * 3 + k] = dot(p, A.axes[k]) + A.half[k];
  }
  const found = [];
  for (let d = 0; d < 3; d++) {
    const got = castAlong(d, loc, ext, { step, maxCells, minSize, minDepth });
    if (got === null) return []; // not a closed shape: can't tell wood from air
    found.push(...got);
  }
  // A cut seen from two sides (a notch in an edge is also a step in the
  // face) is listed once: the view that sees through it, else the biggest.
  found.sort((a, b) => (b.through - a.through) || (vol(b.box) - vol(a.box)));
  const kept = [];
  for (const f of found) {
    if (kept.some((k) => overlap(k.box, f.box) > 0.5 * Math.min(vol(k.box), vol(f.box)))) continue;
    // at an end the model draws a tenon: its shoulders aren't cuts to list
    const [l0, l1] = [f.box[0][0], f.box[1][0]];
    if ((ends[0] && l0 < 1 / 32 && l1 <= ends[0] + 1 / 16) || (ends[1] && l1 > ext[0] - 1 / 32 && l0 >= ext[0] - ends[1] - 1 / 16)) continue;
    kept.push(f);
  }
  return kept.map((f) => ({ ...f, center: toWorld(A, mid(f.box)) })).sort((a, b) => a.box[0][0] - b.box[0][0]);
}

const vol = (b) => (b[1][0] - b[0][0]) * (b[1][1] - b[0][1]) * (b[1][2] - b[0][2]);
const mid = (b) => [0, 1, 2].map((k) => (b[0][k] + b[1][k]) / 2);
function overlap(a, b) {
  let v = 1;
  for (let k = 0; k < 3; k++) v *= Math.max(0, Math.min(a[1][k], b[1][k]) - Math.max(a[0][k], b[0][k]));
  return v;
}
function toWorld(A, p) {
  return [0, 1, 2].map((i) => A.center[i] + [0, 1, 2].reduce((s, k) => s + A.axes[k][i] * (p[k] - A.half[k]), 0));
}

// Rays along axis d from a grid over the other two. Returns the cuts they
// show, or null if too many rays cross the surface an odd number of times
// (an open mesh).
function castAlong(d, loc, ext, { step, maxCells, minSize, minDepth }) {
  const [u, v] = PLANE[d];
  const su = ext[u], sv = ext[v], sd = ext[d];
  if (su < minSize || sv < minSize) return [];
  const h = Math.max(step, Math.sqrt((su * sv) / maxCells));
  const nu = Math.max(1, Math.round(su / h)), nv = Math.max(1, Math.round(sv / h));
  const hu = su / nu, hv = sv / nv;
  // off-centre a hair so rays don't run exactly along triangle edges
  const ju = hu * 0.0137, jv = hv * 0.0071;
  const hits = new Array(nu * nv);
  const n = loc.length / 9;
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const au = loc[o + u], av = loc[o + v], ad = loc[o + d];
    const bu = loc[o + 3 + u], bv = loc[o + 3 + v], bd = loc[o + 3 + d];
    const cu = loc[o + 6 + u], cv = loc[o + 6 + v], cd = loc[o + 6 + d];
    const area = (bu - au) * (cv - av) - (bv - av) * (cu - au);
    if (Math.abs(area) < 1e-12) continue; // edge-on to the rays
    const i0 = Math.max(0, Math.ceil((Math.min(au, bu, cu) - ju) / hu - 0.5));
    const i1 = Math.min(nu - 1, Math.floor((Math.max(au, bu, cu) - ju) / hu - 0.5));
    const j0 = Math.max(0, Math.ceil((Math.min(av, bv, cv) - jv) / hv - 0.5));
    const j1 = Math.min(nv - 1, Math.floor((Math.max(av, bv, cv) - jv) / hv - 0.5));
    for (let i = i0; i <= i1; i++) {
      const pu = (i + 0.5) * hu + ju;
      for (let j = j0; j <= j1; j++) {
        const pv = (j + 0.5) * hv + jv;
        const wa = ((bu - pu) * (cv - pv) - (bv - pv) * (cu - pu)) / area;
        const wb = ((cu - pu) * (av - pv) - (cv - pv) * (au - pu)) / area;
        const wc = 1 - wa - wb;
        if (wa < 0 || wb < 0 || wc < 0) continue;
        const c = i * nv + j;
        (hits[c] || (hits[c] = [])).push(wa * ad + wb * bd + wc * cd);
      }
    }
  }
  // per ray: no wood at all (through), or how far in from each face the wood starts
  const cells = nu * nv;
  const thru = new Uint8Array(cells), from0 = new Float64Array(cells), from1 = new Float64Array(cells);
  let odd = 0;
  for (let c = 0; c < cells; c++) {
    const hs = hits[c];
    if (!hs) { thru[c] = 1; continue; }
    hs.sort((a, b) => a - b);
    let m = 0, last = -Infinity;
    for (const x of hs) { if (x - last > 1e-4) m++; last = x; } // a shared edge counts once
    if (m % 2) { odd++; continue; }
    from0[c] = hs[0];
    from1[c] = sd - hs[hs.length - 1];
  }
  if (odd > cells * 0.05) return null;
  const out = [];
  const add = (mask, through, side) => {
    for (const comp of components(mask, nu, nv)) {
      const f = describe(comp, { d, u, v, nu, nv, hu, hv, su, sv, sd, through, side, from0, from1, minSize, minDepth });
      if (f) out.push(f);
    }
  };
  add(thru, true, 0);
  add(from0.map((x, c) => (!thru[c] && x > minDepth ? 1 : 0)), false, 0);
  add(from1.map((x, c) => (!thru[c] && x > minDepth ? 1 : 0)), false, 1);
  return out;
}

// 4-connected groups of set cells: [[cell index...]...]
function components(mask, nu, nv) {
  const seen = new Uint8Array(mask.length);
  const out = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    const comp = [], stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const c = stack.pop();
      comp.push(c);
      const i = Math.floor(c / nv), j = c % nv;
      for (const [a, b] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) {
        if (a < 0 || b < 0 || a >= nu || b >= nv) continue;
        const k = a * nv + b;
        if (mask[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
      }
    }
    out.push(comp);
  }
  return out;
}

// One group of rays -> a cut: its box in the part's frame, what kind it is
// and its size. Shapes that aren't a cut a woodworker makes (a taper, a
// rounded edge, a dowel's curve) are left out: they don't fill their box
// like a rectangle or a round hole, or their depth wanders.
function describe(comp, { d, u, v, nu, nv, hu, hv, su, sv, sd, through, side, from0, from1, minSize, minDepth }) {
  let i0 = Infinity, i1 = -1, j0 = Infinity, j1 = -1;
  for (const c of comp) {
    const i = Math.floor(c / nv), j = c % nv;
    i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j);
  }
  const du = (i1 - i0 + 1) * hu, dv = (j1 - j0 + 1) * hv;
  if (Math.min(du, dv) < minSize) return null;
  const fill = comp.length / ((i1 - i0 + 1) * (j1 - j0 + 1));
  const edges = { u0: i0 === 0, u1: i1 === nu - 1, v0: j0 === 0, v1: j1 === nv - 1 };
  const spansU = edges.u0 && edges.u1, spansV = edges.v0 && edges.v1;
  if (through && (spansU || spansV)) return null; // would cut the part in two: it's the part's outline
  let depth = sd;
  if (!through) {
    const ds = comp.map((c) => (side ? from1[c] : from0[c])).sort((a, b) => a - b);
    depth = ds[Math.floor(ds.length / 2)];
    if (depth < minDepth || depth > sd - minDepth) return null;
    // a flat-bottomed cut: most rays stop at the same depth (a dowel's
    // curve, a chamfer or a roundover doesn't)
    const flat = ds.filter((x) => Math.abs(x - depth) <= Math.max(1 / 32, depth * 0.1)).length;
    if (flat < ds.length * 0.7) return null;
  }
  const inside = !edges.u0 && !edges.u1 && !edges.v0 && !edges.v1;
  const round = inside && Math.abs(du - dv) < Math.max(hu, hv) * 2 + Math.max(du, dv) * 0.1 && fill > 0.65 && fill < 0.88;
  if (!round && fill < 0.8) return null;
  const box = [[0, 0, 0], [0, 0, 0]];
  box[0][u] = i0 * hu; box[1][u] = (i1 + 1) * hu;
  box[0][v] = j0 * hv; box[1][v] = (j1 + 1) * hv;
  box[0][d] = through || !side ? 0 : sd - depth;
  box[1][d] = through || side ? sd : depth;
  let kind;
  if (round) kind = 'hole';
  else if (inside) kind = through ? 'slot' : 'mortise';
  else if (spansU || spansV) {
    // runs from one side of the surface to the other
    const runsAlongLength = spansU ? u === 0 : v === 0;
    const atEdge = spansU ? edges.v0 || edges.v1 : edges.u0 || edges.u1;
    kind = atEdge ? 'rabbet' : runsAlongLength || d === 0 ? 'groove' : 'dado';
  } else {
    // a big bite out of the outline is the part's shape (an L-shaped board)
    kind = through && du * dv > 0.2 * su * sv ? 'cut-away' : 'notch';
  }
  const f = {
    kind, through, surface: SURFACE[d], axis: d, box,
    size: [du, dv], depth, // du along axis u, dv along axis v
    area: comp.length * hu * hv,
  };
  if (round) f.dia = 2 * Math.sqrt(f.area / Math.PI);
  return f;
}
