// Mesh subtraction for manufactured joints. BSP partitions preserve cut faces,
// including angled mortises; inputs and output use design.js triangle meshes.
const EPS = 1e-6;
const add = (a, b) => a.map((x, i) => x + b[i]);
const sub = (a, b) => a.map((x, i) => x - b[i]);
const mul = (a, s) => a.map((x) => x * s);
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
function plane(vertices) {
  for (let i = 1; i < vertices.length - 1; i++) {
    const n = cross(sub(vertices[i], vertices[0]), sub(vertices[i + 1], vertices[0]));
    const length = Math.hypot(...n);
    if (length > EPS * EPS) { const normal = mul(n, 1 / length); return { normal, w: dot(normal, vertices[0]) }; }
  }
  return null;
}
function polygon(vertices) { const p = plane(vertices); return p ? { vertices, ...p } : null; }
function split(p, face, coplanarFront, coplanarBack, front, back) {
  const distances = face.vertices.map((v) => dot(p.normal, v) - p.w);
  const types = distances.map((d) => d > EPS ? 1 : d < -EPS ? 2 : 0);
  const type = types.reduce((s, t) => s | t, 0);
  if (!type) (dot(p.normal, face.normal) > 0 ? coplanarFront : coplanarBack).push(face);
  else if (type === 1) front.push(face);
  else if (type === 2) back.push(face);
  else {
    const f = [], b = [];
    face.vertices.forEach((v, i) => {
      const j = (i + 1) % face.vertices.length;
      if (types[i] !== 2) f.push(v);
      if (types[i] !== 1) b.push(v);
      if ((types[i] | types[j]) === 3) {
        const t = distances[i] / (distances[i] - distances[j]);
        const point = add(v, mul(sub(face.vertices[j], v), t)); f.push(point); b.push(point);
      }
    });
    const fp = polygon(f), bp = polygon(b); if (fp) front.push(fp); if (bp) back.push(bp);
  }
}
class Partition {
  constructor(faces = []) { this.faces = []; this.build(faces); }
  build(faces) {
    if (!faces.length) return;
    this.plane ||= { normal: faces[0].normal, w: faces[0].w };
    const front = [], back = [];
    faces.forEach((f) => split(this.plane, f, this.faces, this.faces, front, back));
    if (front.length) { this.front ||= new Partition(); this.front.build(front); }
    if (back.length) { this.back ||= new Partition(); this.back.build(back); }
  }
  invert() {
    this.faces = this.faces.map((f) => ({ vertices: [...f.vertices].reverse(), normal: mul(f.normal, -1), w: -f.w }));
    if (this.plane) this.plane = { normal: mul(this.plane.normal, -1), w: -this.plane.w };
    this.front?.invert(); this.back?.invert();
    [this.front, this.back] = [this.back, this.front];
  }
  clip(faces) {
    if (!this.plane) return faces;
    let front = [], back = [];
    faces.forEach((f) => split(this.plane, f, front, back, front, back));
    if (this.front) front = this.front.clip(front);
    back = this.back ? this.back.clip(back) : [];
    return [...front, ...back];
  }
  clipTo(tree) { this.faces = tree.clip(this.faces); this.front?.clipTo(tree); this.back?.clipTo(tree); }
  all() { return [...this.faces, ...(this.front?.all() || []), ...(this.back?.all() || [])]; }
}
export function subtractSolid(stock, cutter) {
  const polys = (mesh) => mesh.faces.map((f) => polygon(f.map((i) => mesh.positions[i]))).filter(Boolean);
  const a = new Partition(polys(stock)), b = new Partition(polys(cutter));
  a.invert(); a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert(); a.build(b.all()); a.invert();
  const positions = [], faces = [], seen = new Map();
  const vertex = (p) => {
    const key = p.map((v) => Math.round(v / EPS)).join(',');
    if (!seen.has(key)) { seen.set(key, positions.length); positions.push(p); }
    return seen.get(key);
  };
  for (const f of a.all()) {
    const ids = f.vertices.map(vertex);
    for (let i = 1; i < ids.length - 1; i++) {
      const triangle = [ids[0], ids[i], ids[i + 1]];
      if (plane(triangle.map((id) => positions[id]))) faces.push(triangle);
    }
  }
  return { positions, faces };
}
// A round tenon stepped out of rectangular stock; the perimeter is sampled
// consistently at each station so the shoulder and cylinder are one shell.
export function roundPrism(segments, center, basis) {
  const positions = [], faces = [], sides = 32, total = segments.reduce((s, v) => s + v.length, 0);
  const world = (l, w, t) => add(center, add(mul(basis[0], l), add(mul(basis[1], w), mul(basis[2], t))));
  const ring = (l, s) => {
    const start = positions.length;
    for (let i = 0; i < sides; i++) {
      const angle = -3 * Math.PI / 4 + i * 2 * Math.PI / sides, x = Math.cos(angle), y = Math.sin(angle);
      const r = s.round ? 1 : 1 / Math.max(Math.abs(x), Math.abs(y));
      positions.push(world(l, x * r * s.width / 2, y * r * s.thickness / 2));
    }
    return start;
  };
  const tri = (a, b, c, reverse = false) => faces.push(reverse ? [a, c, b] : [a, b, c]);
  let offset = -total / 2, previous = null;
  segments.forEach((s, index) => {
    const near = ring(offset, s), far = ring(offset + s.length, s);
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      tri(near+i, near+j, far+j); tri(near+i, far+j, far+i);
      if (previous !== null) { tri(previous+i, previous+j, near+j); tri(previous+i, near+j, near+i); }
    }
    if (!index) { const c = positions.push(world(offset, 0, 0)) - 1; for (let i = 0; i < sides; i++) tri(c, near+(i+1)%sides, near+i); }
    if (index === segments.length - 1) { const c = positions.push(world(offset+s.length, 0, 0)) - 1; for (let i = 0; i < sides; i++) tri(c, far+i, far+(i+1)%sides); }
    previous = far; offset += s.length;
  });
  return { positions, faces: faces.filter((f) => plane(f.map((i) => positions[i]))) };
}

// Split long triangle edges at vertices introduced by neighbouring cuts.
// Besides making a watertight triangle mesh, this prevents false seam lines
// across otherwise flat stock faces in the viewer's edge renderer.
export function conformSolid(mesh) {
  const positions = [...mesh.positions], faces = [];
  for (const face of mesh.faces) {
    const boundary = [];
    for (let i=0;i<3;i++) {
      const a=face[i], b=face[(i+1)%3], p=positions[a], d=sub(positions[b],p), length2=dot(d,d);
      const inside=[]; boundary.push(a);
      if(length2<EPS*EPS) continue;
      const end=positions[b];
      const minX=Math.min(p[0],end[0])-EPS, maxX=Math.max(p[0],end[0])+EPS;
      const minY=Math.min(p[1],end[1])-EPS, maxY=Math.max(p[1],end[1])+EPS;
      const minZ=Math.min(p[2],end[2])-EPS, maxZ=Math.max(p[2],end[2])+EPS;
      for(let id=0;id<mesh.positions.length;id++) {
        if(id===a || id===b) continue;
        const v=mesh.positions[id];
        if(v[0]<minX || v[0]>maxX || v[1]<minY || v[1]>maxY || v[2]<minZ || v[2]>maxZ) continue;
        const qx=v[0]-p[0], qy=v[1]-p[1], qz=v[2]-p[2];
        const t=(qx*d[0]+qy*d[1]+qz*d[2])/length2;
        if(t<=EPS || t>=1-EPS) continue;
        const dx=qx-d[0]*t, dy=qy-d[1]*t, dz=qz-d[2]*t;
        if(dx*dx+dy*dy+dz*dz<EPS*EPS) inside.push([t,id]);
      }
      inside.sort((x,y)=>x[0]-y[0]); boundary.push(...inside.map((v)=>v[1]));
    }
    if(boundary.length===3) faces.push(face);
    else {
      const center=boundary.reduce((p,id)=>add(p,positions[id]),[0,0,0]).map((v)=>v/boundary.length);
      const id=positions.push(center)-1;
      for(let i=0;i<boundary.length;i++) faces.push([id,boundary[i],boundary[(i+1)%boundary.length]]);
    }
  }
  return {positions,faces};
}
