// The model on screen as a SketchUp file (.skp), written in the browser with
// openskp (vendor/openskp/, MIT) - no converter site, nothing uploaded.
// Pure apart from the writer it's handed: parts come in as for export3d.js,
//   { name, group, color: '#rrggbb', positions: Float32Array, frame? }
// (inches, Y up). Each part becomes a SketchUp component on its own axes,
// named as the cut list names it, with one definition shared by parts that are
// the same shape; each assembly is a group; each colour a material.
//
// A part arrives as triangles, which SketchUp would show as triangles. So the
// triangles are welded back into the faces they came from - every run of
// coplanar triangles joined across their shared edges, holes and all - and the
// faces of a round part (a dowel's facets, which meet at a shallow angle) get
// soft, smooth edges, the way SketchUp draws its own circles and arcs. Flat
// faces are written first, so the edges a round part shares with them (a
// dowel's end, a chamfer's shoulder) stay hard - a SketchUp edge takes its
// look from the first face that draws it.

const SOFT = Math.cos(Math.PI / 6);     // facets meeting within 30 deg are one curved surface
const WELD = 1e4;                      // vertices within 1/10000" are the same vertex
const PLANE = 1e-4;                    // inches: coplanar within this

const rgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0xb08a5a;
  return [n >> 16, (n >> 8) & 255, n & 255];
};
// A x = b for a symmetric 3x3 A (Cramer's rule); null if it's singular
function solve3(A, b) {
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  if (Math.abs(D) < 1e-18) return null;
  return [0, 1, 2].map((c) => det(A.map((row, i) => row.map((v, j) => (j === c ? b[i] : v)))) / D);
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// viewer (Y up) -> SketchUp (Z up): (x, y, z) -> (x, -z, y)
const toZUp = (p) => [p[0], -p[2], p[1]];

// a part's triangles in its own frame, and that frame in SketchUp's world
function placed(p) {
  const f = p.frame, s = p.positions;
  const pts = [];
  if (!f) {
    for (let k = 0; k < s.length; k += 3) pts.push([s[k], s[k + 1], s[k + 2]]);
    // the frame is the world's own, turned Z up: geometry stays put
    return { pts, translation: [0, 0, 0], matrix: [1, 0, 0, 0, 0, -1, 0, 1, 0] };
  }
  const [X, Y, Z] = f.axes, o = f.origin;
  for (let k = 0; k < s.length; k += 3) {
    const d = [s[k] - o[0], s[k + 1] - o[1], s[k + 2] - o[2]];
    pts.push([dot(d, X), dot(d, Y), dot(d, Z)]);
  }
  // columns: where the part's own x, y, z axes point in SketchUp's world (row-major)
  const [cx, cy, cz] = [toZUp(X), toZUp(Y), toZUp(Z)];
  return { pts, translation: toZUp(o), matrix: [cx[0], cy[0], cz[0], cx[1], cy[1], cz[1], cx[2], cy[2], cz[2]] };
}

// Triangles -> SketchUp faces: [{ loop, holes, soft }], loops as point lists.
export function facesOf(pts) {
  const key = (p) => `${Math.round(p[0] * WELD)},${Math.round(p[1] * WELD)},${Math.round(p[2] * WELD)}`;
  const index = new Map(), verts = [];
  const vid = (p) => {
    const k = key(p);
    if (!index.has(k)) { index.set(k, verts.length); verts.push(p); }
    return index.get(k);
  };
  const tris = [];
  for (let k = 0; k + 2 < pts.length; k += 3) {
    const t = [vid(pts[k]), vid(pts[k + 1]), vid(pts[k + 2])];
    if (t[0] === t[1] || t[1] === t[2] || t[0] === t[2]) continue;
    const n = cross(sub(verts[t[1]], verts[t[0]]), sub(verts[t[2]], verts[t[0]]));
    const len = Math.hypot(...n);
    if (len < 1e-9) continue;
    const nu = n.map((c) => c / len);
    tris.push({ v: t, n: nu, d: dot(nu, verts[t[0]]), region: -1 });
  }
  // directed edge "a,b" -> triangle; with a consistent winding each edge is shared as a,b and b,a
  const byEdge = new Map();
  tris.forEach((t, i) => { for (let j = 0; j < 3; j++) byEdge.set(`${t.v[j]},${t.v[(j + 1) % 3]}`, i); });

  // grow coplanar regions across shared edges
  const regions = [];
  tris.forEach((t0, i0) => {
    if (t0.region >= 0) return;
    const r = regions.length, members = [i0];
    t0.region = r;
    for (let q = 0; q < members.length; q++) {
      const t = tris[members[q]];
      for (let j = 0; j < 3; j++) {
        const o = byEdge.get(`${t.v[(j + 1) % 3]},${t.v[j]}`);
        if (o === undefined || tris[o].region >= 0) continue;
        const u = tris[o];
        if (dot(u.n, t0.n) > 1 - 1e-7 && Math.abs(u.d - t0.d) < PLANE) { u.region = r; members.push(o); }
      }
    }
    regions.push({ members, n: t0.n, soft: false });
  });

  // a region meeting a neighbour at a shallow angle is a facet of a curved surface
  tris.forEach((t) => {
    for (let j = 0; j < 3; j++) {
      const o = byEdge.get(`${t.v[(j + 1) % 3]},${t.v[j]}`);
      if (o === undefined || tris[o].region === t.region) continue;
      if (dot(tris[o].n, t.n) > SOFT) regions[t.region].soft = true;
    }
  });

  // One position per vertex, on every flat face it belongs to, so each face is
  // flat to the writer's tolerance and neighbours share their corners exactly
  // (the triangles came through float32 and are a few millionths off).
  const planesAt = verts.map(() => []);
  regions.forEach((rg, r) => {
    if (rg.soft) return;
    const t0 = tris[rg.members[0]];
    rg.d = t0.d;
    const vs = new Set();
    rg.members.forEach((i) => tris[i].v.forEach((k) => vs.add(k)));
    vs.forEach((k) => planesAt[k].push(r));
  });
  const snapped = verts.map((p, k) => {
    const ps = planesAt[k].map((r) => regions[r]);
    if (!ps.length) return p;
    // least squares over the planes, held lightly to where the point was
    const A = [[1e-6, 0, 0], [0, 1e-6, 0], [0, 0, 1e-6]], bv = [1e-6 * p[0], 1e-6 * p[1], 1e-6 * p[2]];
    ps.forEach(({ n, d }) => {
      for (let i = 0; i < 3; i++) {
        bv[i] += n[i] * d;
        for (let j = 0; j < 3; j++) A[i][j] += n[i] * n[j];
      }
    });
    return solve3(A, bv) || p;
  });
  const at = (k) => snapped[k];
  const flat = (loops, n) => {
    const all = loops.flat();
    const span = Math.max(1, ...[0, 1, 2].map((i) => Math.max(...all.map((q) => q[i])) - Math.min(...all.map((q) => q[i]))));
    const d = dot(n, all[0]);
    return all.every((q) => Math.abs(dot(n, q) - d) <= span * 5e-7);
  };

  const faces = [];
  const asTriangles = (rg) => rg.members.forEach((i) => faces.push({ loop: tris[i].v.map(at), holes: [], soft: rg.soft }));
  regions.forEach((rg) => {
    // the region's boundary: edges whose twin isn't in the region, chained into loops
    const next = new Map();
    let ok = true;
    rg.members.forEach((i) => {
      const t = tris[i];
      for (let j = 0; j < 3; j++) {
        const a = t.v[j], b = t.v[(j + 1) % 3];
        const o = byEdge.get(`${b},${a}`);
        if (o !== undefined && tris[o].region === t.region) continue;
        if (next.has(a)) ok = false;     // two boundary edges leave one vertex: a pinch
        next.set(a, b);
      }
    });
    const loops = [];
    const seen = new Set();
    for (const start of next.keys()) {
      if (!ok || seen.has(start)) continue;
      const loop = [];
      let v = start;
      while (!seen.has(v)) {
        seen.add(v);
        loop.push(v);
        v = next.get(v);
        if (v === undefined) { ok = false; break; }
      }
      if (v !== start) ok = false;
      if (loop.length >= 3) loops.push(loop);
    }
    // the outer loop is the one enclosing the most area (it runs anticlockwise about the normal, holes clockwise)
    const area = (lp) => {
      const s = [0, 0, 0];
      lp.forEach((v, k) => {
        const c = cross(verts[v], verts[lp[(k + 1) % lp.length]]);
        s[0] += c[0]; s[1] += c[1]; s[2] += c[2];
      });
      return dot(s, rg.n) / 2;
    };
    loops.sort((x, y) => area(y) - area(x));
    const pts3 = loops.map((lp) => lp.map(at));
    if (!ok || !loops.length || !flat(pts3, rg.n)) { asTriangles(rg); return; }   // can't trace it, or it isn't flat enough: keep its triangles
    faces.push({ loop: pts3[0], holes: pts3.slice(1), soft: rg.soft });
  });
  // flat faces first, so the edges they share with curved ones are drawn hard
  return faces.sort((a, b) => a.soft - b.soft);
}

// Write the parts as a .skp: returns its bytes. `create` is openskp's create().
export function toSKP(parts, title, create) {
  const skp = create();
  const materials = new Map();
  parts.forEach((p) => {
    const c = (p.color || '#b08a5a').toLowerCase();
    if (!materials.has(c)) materials.set(c, skp.addMaterial(p.material || `Colour ${materials.size + 1}`, [...rgb(c), 255]));
  });
  // one definition per shape: same name, same triangles in its own frame
  const defs = new Map(), placedParts = [];
  parts.forEach((p) => {
    const pl = placed(p);
    const shape = `${p.name}|${pl.pts.map((q) => q.map((c) => Math.round(c * 1000)).join(',')).join(';')}`;
    if (!defs.has(shape)) {
      const mat = materials.get((p.color || '#b08a5a').toLowerCase());
      const used = [...defs.values()].filter((d) => d.base === p.name).length;
      const def = skp.addComponentDefinition(used ? `${p.name} #${used + 1}` : p.name, (d) => {
        facesOf(pl.pts).forEach((f) => {
          if (f.loop.length < 3) return;
          d.addFace(f.loop, { material: mat, holes: f.holes.length ? f.holes : undefined, softEdges: f.soft, smoothEdges: f.soft });
        });
      });
      defs.set(shape, { def, base: p.name });
    }
    placedParts.push({ p, pl, def: defs.get(shape).def });
  });
  // each assembly a group of its parts' instances
  const groups = new Map();
  placedParts.forEach((x) => {
    const g = x.p.group || title || 'Model';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(x);
  });
  groups.forEach((members, name) => {
    skp.addGroup((grp) => {
      members.forEach(({ p, pl, def }) => grp.addInstance(def, { name: p.name, translation: pl.translation, matrix3x3: pl.matrix }));
    }, { name });
  });
  return skp.toBytes();
}
