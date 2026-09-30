// Geometry operations shared by the direct editor and its tests. Coordinates
// remain inches; these edit the design that the normal compiler consumes.
import { instanceBasis, newPart } from './design.js';

export const pieceKey = (partId, index) => `${partId}:${index}`;
export function selectedPieces(design, keys) {
  const out = [];
  for (const part of design?.parts || []) part.instances.forEach((inst, index) => {
    if (keys.has(pieceKey(part.id, index))) out.push({ part, inst, index });
  });
  return out;
}
const add = (a, b) => a.map((n, i) => n + b[i]);
const sub = (a, b) => a.map((n, i) => n - b[i]);
const mul = (a, n) => a.map((v) => v * n);
export function rotateVector(v, axis, radians) {
  const c = Math.cos(radians), s = Math.sin(radians);
  const dot = v.reduce((n, x, i) => n + x * axis[i], 0);
  const cross = [axis[1] * v[2] - axis[2] * v[1], axis[2] * v[0] - axis[0] * v[2], axis[0] * v[1] - axis[1] * v[0]];
  return v.map((x, i) => x * c + cross[i] * s + axis[i] * dot * (1 - c));
}
export function translatePieces(design, keys, delta) {
  selectedPieces(design, keys).forEach(({ inst }) => { inst.at = add(inst.at || [0, 0, 0], delta); });
}
export function rotatePieces(design, keys, axis, degrees, pivot) {
  selectedPieces(design, keys).forEach(({ inst }) => {
    const basis = instanceBasis(inst);
    inst.at = add(pivot, rotateVector(sub(inst.at || [0, 0, 0], pivot), axis, degrees * Math.PI / 180));
    inst.along = rotateVector(basis[0], axis, degrees * Math.PI / 180);
    inst.up = rotateVector(basis[2], axis, degrees * Math.PI / 180);
    delete inst.tilt;
  });
}
export function duplicatePieces(design, keys, delta = [2, 0, 2]) {
  const next = new Set();
  // Copies remain instances of their original part, like linked components.
  for (const { part, inst } of selectedPieces(design, keys)) {
    const copy = structuredClone(inst);
    copy.at = add(copy.at || [0, 0, 0], delta);
    part.instances.push(copy);
    next.add(pieceKey(part.id, part.instances.length - 1));
  }
  return next;
}
export function deletePieces(design, keys) {
  for (const part of design.parts) part.instances = part.instances.filter((_, i) => !keys.has(pieceKey(part.id, i)));
  design.parts = design.parts.filter((p) => p.instances.length);
  const ids = new Set(design.parts.map((p) => p.id));
  design.joints = (design.joints || []).filter((j) => ids.has(j.from) && ids.has(j.into));
}
// Make a single linked copy independently editable, retaining its joint specs.
export function makeUnique(design, key) {
  const piece = selectedPieces(design, new Set([key]))[0];
  if (!piece || piece.part.instances.length === 1) return key;
  const { part, inst, index } = piece;
  const copy = { ...structuredClone(part), id: newPart(design).id, name: `${part.name} unique`, instances: [structuredClone(inst)] };
  part.instances.splice(index, 1);
  design.parts.push(copy);
  const joints = (design.joints || []).filter((j) => j.from === part.id || j.into === part.id).map((j) => ({
    ...structuredClone(j), from: j.from === part.id ? copy.id : j.from, into: j.into === part.id ? copy.id : j.into,
  }));
  design.joints = [...(design.joints || []), ...joints];
  return pieceKey(copy.id, 0);
}

// Use real solid vertices and quad boundaries, including tenon shoulders.
// The compiler emits consecutive pairs of triangles for every quad.
export function solidAnchors(solid) {
  const points = new Map();
  const put = (point, kind) => {
    const key = point.map((v) => Math.round(v * 1e6)).join(',');
    if (!points.has(key)) points.set(key, { point: [...point], kind });
  };
  solid.positions.forEach((p) => put(p, 'corner'));
  for (let i = 0; i < solid.faces.length; i += 2) {
    const faces = solid.faces.slice(i, i + 2);
    const ids = [...new Set(faces.flat())];
    if (ids.length !== 4) continue;
    const normals = faces.map((f) => {
      const [a,b,c] = f.map((id) => solid.positions[id]), u=sub(b,a), v=sub(c,a);
      const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
      return mul(n,1/(Math.hypot(...n)||1));
    });
    if (normals[0].reduce((s,v,i)=>s+v*normals[1][i],0)<0.999) continue;
    put(mul(ids.reduce((p, id) => add(p, solid.positions[id]), [0, 0, 0]), 0.25), 'face centre');
    const edges = new Map();
    for (const face of faces) for (let j = 0; j < 3; j++) {
      const a = face[j], b = face[(j + 1) % 3], key = [a, b].sort((x, y) => x - y).join(',');
      edges.set(key, { a, b, count: (edges.get(key)?.count || 0) + 1 });
    }
    for (const { a, b, count } of edges.values()) if (count === 1) put(mul(add(solid.positions[a], solid.positions[b]), 0.5), 'edge midpoint');
  }
  solidEdges(solid).forEach(({ a, b }) => put(mul(add(a, b), 0.5), 'edge midpoint'));
  return [...points.values()];
}

// Magnetic placement respects the active gizmo axes. Never nudge a locked
// coordinate to make a tempting nearby snap appear to fit.
export function snapTranslation(moving, targets, delta, axes, tolerance) {
  let best = null, distance = tolerance;
  for (const a of moving) for (const b of targets) {
    const correction = sub(b.point, add(a.point, delta));
    if (correction.some((v, i) => !axes.includes(i) && Math.abs(v) > 1e-5)) continue;
    const d = Math.hypot(...correction);
    if (d < distance) {
      distance = d;
      best = { delta: add(delta, correction), source: a, target: b };
    }
  }
  return best || { delta };
}

export class DesignHistory {
  constructor(limit = 100) { this.limit = limit; this.reset(null); }
  reset(design) { this.past = [JSON.stringify(design)]; this.future = []; }
  record(design) {
    const value = JSON.stringify(design);
    if (value === this.past.at(-1)) return;
    this.past.push(value); this.future = [];
    if (this.past.length > this.limit) this.past.shift();
  }
  get canUndo() { return this.past.length > 1; }
  get canRedo() { return this.future.length > 0; }
  undo() { if (!this.canUndo) return undefined; this.future.push(this.past.pop()); return JSON.parse(this.past.at(-1)); }
  redo() { if (!this.canRedo) return undefined; const value = this.future.pop(); this.past.push(value); return JSON.parse(value); }
}

// side=+1 grows the positive face and holds the negative face still; -1 is
// the reverse. Centre mode is explicit (0), never an accidental second move.
export function resizePiece(part, instanceIndex, axis, size, side = 1) {
  const old = part.size[axis], inst = part.instances[instanceIndex];
  part.size[axis] = Math.max(1 / 64, size);
  if (side && inst) inst.at = add(inst.at || [0, 0, 0], mul(instanceBasis(inst)[axis], side * (part.size[axis] - old) / 2));
}

export function solidEdges(solid) {
  const edges = new Map();
  const key = (p) => p.map((v) => Math.round(v * 1e5)).join(',');
  for (const face of solid.faces) {
    const [a,b,c] = face.map((i) => solid.positions[i]);
    const ab = sub(b,a), ac = sub(c,a);
    const n = [ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]];
    const length = Math.hypot(...n); if (length < 1e-10) continue;
    for (let j=0;j<3;j++) {
      const p=solid.positions[face[j]], q=solid.positions[face[(j+1)%3]], id=[key(p),key(q)].sort().join('|');
      if (!edges.has(id)) edges.set(id,{a:p,b:q,normals:[]});
      edges.get(id).normals.push(mul(n,1/length));
    }
  }
  return [...edges.values()].filter(({normals}) => normals.length===1 || normals.some((n)=>Math.abs(n.reduce((s,v,i)=>s+v*normals[0][i],0))<0.999));
}
