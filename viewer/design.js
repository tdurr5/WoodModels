// A design you draw yourself, and the compiler that turns it into the six
// data files the viewer already reads.
//
// The whole point of this file is that it invents no second model. A design
// compiles to exactly what `parse_dae.py` and `collada.js` produce - scene.obj,
// scene.mtl, materials.json, object_dims.json, parts_report.json, model.json -
// so the cut list, rough stock, cutting diagrams, templates, build mode, the
// design review, sharing and printing all work on a designed piece without
// knowing it was designed. The design itself rides along inside model.json,
// so opening the model again lets you keep editing it.
//
// A design:
// {
//   version: 1, title, subtitle,
//   params:    { seatHeight: 18, ... },      // numbers the archetypes drive off
//   materials: { Maple: { category: 'Wood', species: 'maple', color: '#…' } },
//   parts: [{
//     id, name, group,                        // group is the assembly it belongs to
//     material, size: [length, width, thickness],
//     instances: [{ at: [x, y, z], along: 'x', up: 'y', tilt: { axis: 'z', deg: 6 } }],
//                                    // tilt may be a list, for a compound splay
//   }],
//   joints: [{ from: partId, end: 0 | 1, into: partId, type, tenon: { thickness, length, width } }],
// }
//
// Coordinates are inches, Y up, y = 0 at the floor, +z towards the front -
// the same frame the viewer shows an uploaded model in.
//
// `at` is the centre of the part's own box, before any tenons: a tenon grows
// out past the end, so the length in the cut list includes it and the
// shoulder-to-shoulder length is the size you typed. That is the convention
// the rest of the viewer already uses.

import { toFraction } from './format.js';
import { tenonFor } from './joinery.js';
import { WOOD, propsFor } from './woodprops.js';

export const DESIGN_VERSION = 1;

// ---------- small vector helpers ----------
const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => { const n = Math.hypot(...v) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };

// 'x', '-y', or a vector, to a unit vector.
function axisVector(a, fallback = [1, 0, 0]) {
  if (Array.isArray(a)) return norm(a);
  if (typeof a !== 'string') return fallback;
  const neg = a.startsWith('-');
  const v = AXES[a.replace(/^[-+]/, '')];
  return v ? (neg ? scale(v, -1) : v) : fallback;
}

// Rotate v about a unit axis k by `deg` (Rodrigues).
function rotate(v, k, deg) {
  if (!deg) return v;
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
}

// The part's own frame for one placement: length, width, thickness directions.
// `up` is the direction its thickness runs; a tilt leans the whole part.
export function instanceBasis(inst = {}) {
  let L = axisVector(inst.along, [1, 0, 0]);
  let T = axisVector(inst.up, [0, 1, 0]);
  // If they were given parallel, pick any perpendicular rather than collapsing.
  if (Math.abs(dot(L, T)) > 0.999) T = Math.abs(L[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
  let W = norm(cross(T, L));
  T = norm(cross(L, W));
  // One tilt leans a part; two make a chairmaker's compound splay.
  for (const tilt of [].concat(inst.tilt || [])) {
    if (!tilt?.deg) continue;
    const k = axisVector(tilt.axis, [0, 0, 1]);
    L = norm(rotate(L, k, tilt.deg));
    W = norm(rotate(W, k, tilt.deg));
    T = norm(rotate(T, k, tilt.deg));
  }
  return [L, W, T];
}

// ---------- geometry ----------

// A solid of rectangular cross-sections stacked along its length: the part
// itself, plus a tenon on either end where a joint calls for one. Built as one
// closed mesh (side walls, end caps, and a shoulder ring where the section
// steps in) so the viewer's ray tests can tell wood from air the same way they
// do for a real model.
// segments: [{ length, width, thickness }], in order along +L.
export function prism(segments, { center = [0, 0, 0], basis = [AXES.x, AXES.y, AXES.z] } = {}) {
  const [L, W, T] = basis;
  const total = segments.reduce((a, s) => a + s.length, 0);
  const positions = [];
  const faces = [];
  // A ring of 4 corners of a section at distance u along the length.
  const ring = (u, seg) => {
    const start = positions.length;
    const along = scale(L, u - total / 2);
    for (const [sw, st] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      positions.push(add(add(center, along), add(scale(W, (sw * seg.width) / 2), scale(T, (st * seg.thickness) / 2))));
    }
    return start;
  };
  // Two triangles for a quad, wound so its normal points along `outward`.
  const quad = (a, b, c, d, outward) => {
    const p = positions;
    const n = cross(
      [p[b][0] - p[a][0], p[b][1] - p[a][1], p[b][2] - p[a][2]],
      [p[d][0] - p[a][0], p[d][1] - p[a][1], p[d][2] - p[a][2]],
    );
    if (dot(n, outward) >= 0) faces.push([a, b, c], [a, c, d]);
    else faces.push([a, d, c], [a, c, b]);
  };
  let u = 0;
  let prev = null;    // { ring index, segment } at the current plane
  segments.forEach((seg, i) => {
    const back = ring(u, seg);
    const front = ring(u + seg.length, seg);
    // Four side walls.
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      const mid = [0, 1, 2].map((c) => (positions[back + k][c] + positions[back + k2][c]) / 2);
      const out = norm([0, 1, 2].map((c) => mid[c] - (center[c] + L[c] * (u + seg.length / 2 - total / 2))));
      quad(back + k, back + k2, front + k2, front + k, out);
    }
    if (i === 0) quad(back, back + 1, back + 2, back + 3, scale(L, -1));          // the far end cap
    else shoulder(prev, { at: back, seg });                                        // steps in or out
    if (i === segments.length - 1) quad(front, front + 1, front + 2, front + 3, L);
    prev = { at: front, seg };
    u += seg.length;
  });
  // The flat ring left where one section meets a smaller one.
  function shoulder(a, b) {
    const big = a.seg.width * a.seg.thickness >= b.seg.width * b.seg.thickness ? a : b;
    const small = big === a ? b : a;
    const outward = big === a ? L : scale(L, -1);
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      quad(big.at + k, big.at + k2, small.at + k2, small.at + k, outward);
    }
  }
  return { positions, faces };
}

// ---------- compiling ----------

const safe = (s) => String(s || '').replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'part';
const round = (v, n = 4) => Math.round(v * 10 ** n) / 10 ** n;

// The tenons a part grows, by end (0 = the -L end, 1 = the +L end).
function tenonsOf(design, part) {
  const out = {};
  for (const j of design.joints || []) {
    if (j.from !== part.id || !JOINT_MAKES_TENON.has(j.type)) continue;
    const into = (design.parts || []).find((p) => p.id === j.into);
    const t = j.tenon || tenonFor({
      railThickness: part.size[2], railWidth: part.size[1],
      intoThickness: into ? into.size[2] : part.size[2] * 2,
      through: j.type === 'through-tenon',
    });
    if (t) out[j.end ? 1 : 0] = t;
  }
  return out;
}
const JOINT_MAKES_TENON = new Set(['mortise-tenon', 'through-tenon', 'round-tenon']);

// One part instance as segments along its length: [tenon?] part [tenon?].
function segmentsFor(part, tenons) {
  const [len, width, thickness] = part.size;
  const segs = [];
  if (tenons[0]) segs.push({ length: tenons[0].length, width: tenons[0].width, thickness: tenons[0].thickness });
  segs.push({ length: len, width, thickness });
  if (tenons[1]) segs.push({ length: tenons[1].length, width: tenons[1].width, thickness: tenons[1].thickness });
  return segs;
}

// Every solid a design builds: one per placement, with the part it belongs
// to, its mesh and where it ended up. The compiler writes these out as an
// OBJ; the designer draws the same thing as a live preview, so what you see
// while you type is exactly what you get when you save.
export function buildSolids(design) {
  const parts = (design?.parts || []).filter((p) => p?.size?.every((v) => v > 0) && (p.instances || []).length);
  const seen = new Map();
  const out = [];
  for (const part of parts) {
    const tenons = tenonsOf(design, part);
    const segs = segmentsFor(part, tenons);
    const total = segs.reduce((a, s) => a + s.length, 0);
    // Where the part's own box sits inside the whole solid: the tenon on the
    // far end pushes the middle along, so `at` still means the box you typed.
    const shift = ((tenons[1]?.length || 0) - (tenons[0]?.length || 0)) / 2;
    const extents = [total, Math.max(...segs.map((s) => s.width)), Math.max(...segs.map((s) => s.thickness))];
    part.instances.forEach((inst) => {
      const basis = instanceBasis(inst);
      const center = add(inst.at || [0, 0, 0], scale(basis[0], shift));
      const base = safe(`${part.group || ''}_${part.name || part.id}`).slice(0, 55);
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      out.push({
        part, inst, name: n ? `${base}_${n}` : base, basis, center, extents,
        ...prism(segs, { center, basis }),
      });
    });
  }
  return out;
}

// Compile a design into the viewer's six data files.
// Returns { files, stats, problems } - problems are the things that stopped a
// part being built, never an exception: a half-finished design still opens.
export function compileDesign(design) {
  const problems = validateDesign(design);
  const solids = buildSolids(design);
  const obj = ['mtllib scene.mtl\n'];
  const mtl = [];
  const matKeyToName = {};
  const dims = {};
  const byPart = new Map();
  const written = new Set();
  let vertexOffset = 0;
  const f5 = (v) => v.toFixed(5);

  for (const solid of solids) {
    const { part } = solid;
    const matName = part.material || 'Wood';
    const key = safe(matName);
    matKeyToName[key] = matName;
    if (!written.has(key)) {
      written.add(key);
      const c = hexToRgb((design.materials?.[matName] || {}).color || '#d9b26a');
      mtl.push(`newmtl ${key}\nKd ${c.map((v) => v.toFixed(3)).join(' ')}\n\n`);
    }
    obj.push(`o ${solid.name}\n`);
    for (const p of solid.positions) obj.push(`v ${f5(p[0])} ${f5(p[1])} ${f5(p[2])}\n`);
    obj.push(`usemtl ${key}\n`);
    for (const f of solid.faces) obj.push(`f ${vertexOffset + f[0] + 1} ${vertexOffset + f[1] + 1} ${vertexOffset + f[2] + 1}\n`);
    vertexOffset += solid.positions.length;
    dims[solid.name] = objectDims(solid.positions, solid.basis, solid.extents);
    if (!byPart.has(part)) byPart.set(part, []);
    byPart.get(part).push(solid);
  }
  const notes = joinNotes(design);
  const rows = [...byPart].map(([part, list]) => {
    const size = [list[0].extents[0], part.size[1], part.size[2]].map((v) => round(v, 3)).sort((a, b) => b - a);
    return {
      label: part.name || part.id,
      note: notes[part.name || part.id] || undefined,
      top_group: part.group || 'Parts',
      dims: size,
      count: list.length,
      materials: [part.material || 'Wood'],
      material: part.material || 'Wood',
      paths: list.map(() => `${part.group || 'Parts'}/${part.name || part.id}`),
      obj_names: list.map((s) => s.name),
      dims_str: `${toFraction(size[0])} x ${toFraction(size[1])} x ${toFraction(size[2])}`,
    };
  });
  return {
    files: {
      'scene.obj': obj.join(''),
      'scene.mtl': mtl.join(''),
      'materials.json': JSON.stringify(matKeyToName, null, 2),
      'object_dims.json': JSON.stringify(dims, null, 2),
      'parts_report.json': JSON.stringify(rows, null, 2),
      'model.json': JSON.stringify(modelConfig(design), null, 2),
    },
    stats: { parts: rows.length, pieces: solids.length },
    problems,
  };
}

// The oriented box of one built instance, in the shape object_dims.json uses.
function objectDims(positions, basis, extents) {
  // Measured on the part's own axes, not the world's: a tilted part's box is
  // tilted with it, and an orthonormal basis rebuilds the world point exactly.
  const mid = basis.map((ax) => {
    const vals = positions.map((p) => dot(p, ax));
    return (Math.min(...vals) + Math.max(...vals)) / 2;
  });
  const center = basis.reduce((acc, ax, i) => add(acc, scale(ax, mid[i])), [0, 0, 0]);
  const axes = basis.map((direction, i) => ({ direction: direction.map((v) => round(v, 6)), length: round(extents[i], 4) }))
    .filter((a) => a.length > 1e-6)
    .sort((a, b) => b.length - a.length);
  axes.forEach((a, i) => {
    a.role = ['Length', 'Width', 'Thickness'][i] || `axis${i}`;
    a.label = toFraction(a.length);
  });
  return { center: center.map((v) => round(v, 4)), axes };
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return [0.85, 0.7, 0.42];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
}

// model.json for a designed piece, with the design itself carried inside so
// it can be opened and edited again (and survives Download / Share).
export function modelConfig(design) {
  const materials = {};
  for (const [name, m] of Object.entries(design.materials || {})) {
    const entry = { category: m.category || 'Wood', color: m.color || '#d9b26a' };
    if (m.label) entry.label = m.label;
    if (entry.category === 'Wood') {
      entry.texture = { base: '#c9975c', streak: '#a06f3b', ring: '#8a5a2c', tile: 5 };
      entry.species = m.species || 'hardwood';
    }
    materials[name] = entry;
  }
  return {
    title: design.title || 'My design',
    subtitle: design.subtitle || '',
    axisNames: { x: 'side-to-side', y: 'vertical', z: 'front-to-back' },
    views: {
      iso: { label: '3D', dir: [0.7, 0.5, 0.7] },
      front: { label: 'Front', dir: [0, 0, 1] },
      side: { label: 'Side', dir: [-1, 0, 0] },
      top: { label: 'Top', dir: [0, 1, 0.0001] },
    },
    materials,
    categoryOrder: ['Wood', 'Sheet goods', 'Hardware', 'Leather', 'Other'],
    displayNames: {},
    // Joints are a note on the part in parts_report.json; model.json's notes
    // are the plan author's warnings, and a joint isn't one.
    notes: {},
    design,
  };
}

// Joints become a note on the part that carries them, so the cut list, the
// build steps and the printed sheet say how it goes together even where the
// geometry can't show it.
function joinNotes(design) {
  const byPart = new Map();
  const byId = new Map((design.parts || []).map((p) => [p.id, p]));
  for (const j of design.joints || []) {
    const from = byId.get(j.from), into = byId.get(j.into);
    if (!from || !into) continue;
    const key = from.name || from.id;
    const groups = byPart.get(key) || new Map();
    const g = groups.get(j.type) || { targets: new Map() };
    const target = into.name || into.id;
    g.targets.set(target, (g.targets.get(target) || 0) + 1);
    groups.set(j.type, g);
    byPart.set(key, groups);
  }
  const join = (names) => (names.length < 2 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
  const notes = {};
  for (const [key, groups] of byPart) {
    notes[key] = [...groups].map(([type, g]) => {
      const label = JOINT_LABELS[type] || type;
      // The same joint at both ends of a part is one line, not two.
      const ends = [...g.targets.values()].every((n) => n > 1) ? ', each end' : '';
      return `${label} ${JOINED_TO.has(type) ? 'to' : 'into'} ${join([...g.targets.keys()])}${ends}`;
    }).join('; ');
  }
  return notes;
}

// Joints that sit against a part rather than going into it.
const JOINED_TO = new Set(['buttons', 'edge-glue', 'butt-screw', 'pocket-screw', 'half-lap']);
const JOINT_LABELS = {
  'mortise-tenon': 'Mortise and tenon',
  'through-tenon': 'Through tenon, wedged',
  'round-tenon': 'Round tenon',
  dado: 'Dado',
  'half-lap': 'Half lap',
  dowel: 'Dowelled',
  'pocket-screw': 'Pocket screws',
  'butt-screw': 'Butt joint, screwed',
  buttons: 'Buttons (free to move)',
  'edge-glue': 'Edge glued',
};
export { JOINT_LABELS };

// ---------- editing helpers, for the designer UI ----------

export function emptyDesign(title = 'My design') {
  return {
    version: DESIGN_VERSION,
    title,
    subtitle: '',
    params: {},
    materials: { Maple: { category: 'Wood', species: 'maple', color: '#e3c99a' } },
    parts: [],
    joints: [],
  };
}

// A new part, placed clear of everything else so it is visible on arrival.
export function newPart(design, over = {}) {
  let n = (design.parts || []).length + 1;
  while ((design.parts || []).some((p) => p.id === `part${n}`)) n++;
  const box = designBounds(design);
  return {
    id: `part${n}`,
    name: `Part ${n}`,
    group: 'Parts',
    material: Object.keys(design.materials || { Maple: 1 })[0],
    size: [24, 3, 0.75],
    instances: [{ at: [0, (box?.max[1] ?? 0) + 4, 0], along: 'x', up: 'y' }],
    ...over,
  };
}

export function validateDesign(design) {
  const problems = [];
  const ids = new Set();
  for (const p of design?.parts || []) {
    if (!p.id) problems.push({ part: p.name, text: 'has no id' });
    else if (ids.has(p.id)) problems.push({ part: p.name, text: `shares its id (${p.id}) with another part` });
    ids.add(p.id);
    if (!p.size || p.size.length !== 3 || !p.size.every((v) => v > 0)) problems.push({ part: p.name || p.id, text: 'needs a length, width and thickness above zero' });
    if (!(p.instances || []).length) problems.push({ part: p.name || p.id, text: 'is not placed anywhere' });
    if (p.material && design.materials && !design.materials[p.material]) problems.push({ part: p.name || p.id, text: `uses a material that isn't in the design (${p.material})` });
  }
  for (const j of design?.joints || []) {
    if (!ids.has(j.from) || !ids.has(j.into)) problems.push({ part: j.from, text: 'has a joint to a part that is not in the design' });
  }
  return problems;
}

// The whole design's extents, for the ground, the camera and the height check.
export function designBounds(design) {
  const pts = [];
  for (const part of design?.parts || []) {
    if (!part.size?.every((v) => v > 0)) continue;
    for (const inst of part.instances || []) {
      const basis = instanceBasis(inst);
      const at = inst.at || [0, 0, 0];
      for (const s of [-1, 1]) for (const w of [-1, 1]) for (const t of [-1, 1]) {
        pts.push(add(at, add(scale(basis[0], (s * part.size[0]) / 2), add(scale(basis[1], (w * part.size[1]) / 2), scale(basis[2], (t * part.size[2]) / 2)))));
      }
    }
  }
  if (!pts.length) return null;
  const min = [0, 1, 2].map((c) => Math.min(...pts.map((p) => p[c])));
  const max = [0, 1, 2].map((c) => Math.max(...pts.map((p) => p[c])));
  return { min, max, size: [0, 1, 2].map((c) => max[c] - min[c]) };
}

// Species the designer offers, with a readable name: the ones the viewer can
// draw the grain of and the review knows the properties of.
export const SPECIES_CHOICES = Object.entries(WOOD).map(([key, w]) => ({ key, name: w.name, type: w.type }));

// ---------- the design, as the review engine sees it ----------

// review.js works on measured geometry, because that is all an uploaded model
// gives it. A design knows more than that: it knows which parts are joined,
// how, and which joints are meant to slide. This builds the review's model
// straight from the design, so the designer can show findings while you type
// rather than only after you save.
export function designReviewModel(design) {
  const boxes = [];
  const parts = (design?.parts || []).filter((p) => p?.size?.every((v) => v > 0) && (p.instances || []).length);
  const byId = new Map(parts.map((p) => [p.id, p]));
  const tenonsById = new Map(parts.map((p) => [p.id, tenonsOf(design, p)]));
  const free = new Map();
  for (const j of design?.joints || []) {
    if (!j.movesFreely) continue;
    for (const [a, b] of [[j.from, j.into], [j.into, j.from]]) free.set(a, [...(free.get(a) || []), b]);
  }
  for (const part of parts) {
    for (const inst of part.instances) {
      const basis = instanceBasis(inst);
      const center = inst.at || [0, 0, 0];
      const half = part.size.map((v) => v / 2);
      const drop = basis.reduce((a, ax, i) => a + half[i] * Math.abs(ax[1]), 0);
      boxes.push({ part, basis, center, half, bottom: center[1] - drop, top: center[1] + drop });
    }
  }
  const overlap = (a, b, tol) => {
    const t = [0, 1, 2].map((c) => b.center[c] - a.center[c]);
    for (const box of [a, b]) {
      for (let i = 0; i < 3; i++) {
        const L = box.basis[i];
        const reach = a.half.reduce((s, h, k) => s + h * Math.abs(dot(a.basis[k], L)), 0)
          + b.half.reduce((s, h, k) => s + h * Math.abs(dot(b.basis[k], L)), 0);
        if (Math.abs(dot(t, L)) > reach + tol) return false;
      }
    }
    return true;
  };
  // How far one part reaches across another's width, the same measure the
  // cross-grain rule uses on a real model.
  const spanAcross = (wide, other) => {
    const axis = wide.basis[1];
    let lo = Infinity, hi = -Infinity;
    for (const s of [-1, 1]) for (const w of [-1, 1]) for (const t of [-1, 1]) {
      const p = add(other.center, add(scale(other.basis[0], s * other.half[0]),
        add(scale(other.basis[1], w * other.half[1]), scale(other.basis[2], t * other.half[2]))));
      const v = dot(p, axis);
      lo = Math.min(lo, v); hi = Math.max(hi, v);
    }
    return Math.min(hi - lo, wide.half[1] * 2);
  };

  const out = parts.map((part) => {
    const mine = boxes.filter((b) => b.part === part);
    const basis = mine[0].basis;
    const tenons = tenonsById.get(part.id) || {};
    const size = [part.size[0] + (tenons[0]?.length || 0) + (tenons[1]?.length || 0), part.size[1], part.size[2]];
    const material = design.materials?.[part.material] || {};
    const props = propsFor({
      panel: material.category === 'Sheet goods' ? (material.panel || 'plywood') : null,
      species: material.species,
    });
    const touches = [];
    for (const other of boxes) {
      if (other.part === part || touches.some((t) => t.key === other.part.id)) continue;
      if (mine.some((b) => overlap(b, other, 1 / 32))) {
        touches.push({ key: other.part.id, name: other.part.name, span: spanAcross(mine[0], other) });
      }
    }
    // Supports under a part lying flat: the gap between the outermost ones.
    // What holds a flat part up: anything it touches that isn't sitting on
    // top of it. A shelf is held at its ends, a bench from underneath, and
    // the span that matters is the widest gap between two of them.
    let supportSpan = 0;
    const horizontal = Math.abs(dot(basis[2], [0, 1, 0])) > 0.9;
    if (horizontal) {
      const me = mine[0], along = dot(me.center, basis[0]);
      const holding = boxes.filter((b) => {
        if (b.part === part || !touches.some((t) => t.key === b.part.id)) return false;
        const under = b.center[1] < me.center[1];                          // a leg, a cleat
        const atEnd = Math.abs(dot(b.center, basis[0]) - along) >= me.half[0] - me.half[2] - 1 / 32;
        return under || atEnd;                                             // not a back panel behind it
      });
      const at = holding.map((b) => dot(b.center, basis[0])).sort((a, b) => a - b);
      for (let i = 1; i < at.length; i++) supportSpan = Math.max(supportSpan, at[i] - at[i - 1]);
    }
    return {
      key: part.id, name: part.name || part.id, letter: '', count: mine.length,
      category: material.category || 'Wood',
      wood: (material.category || 'Wood') === 'Wood' || material.category === 'Sheet goods',
      dims: [...size].sort((a, b) => b - a),
      props, sawn: part.sawn || 'unknown',
      grain: basis[0], across: basis[1], horizontal, supportSpan,
      seat: horizontal && /\b(seat|bench|stool)\b/i.test(part.name || ''),
      touches,
      tenons: Object.entries(tenons).map(([end, t]) => {
        const j = (design.joints || []).find((x) => x.from === part.id && (x.end ? 1 : 0) === Number(end));
        const into = byId.get(j?.into);
        return {
          into: into?.name || j?.into, intoKey: j?.into,
          thickness: t.thickness, length: t.length, width: t.width,
          through: j?.type === 'through-tenon', round: j?.type === 'round-tenon',
        };
      }),
      mortises: (design.joints || []).filter((j) => j.into === part.id && tenonsById.get(j.from)?.[j.end ? 1 : 0])
        .map((j) => {
          const from = byId.get(j.from);
          return {
            key: j.from, name: from?.name || j.from,
            depth: tenonsById.get(j.from)[j.end ? 1 : 0].length,
            dir: instanceBasis(from?.instances?.[0] || {})[0],
          };
        }),
      butts: (design.joints || []).filter((j) => j.from === part.id && j.type === 'butt-screw')
        .map((j) => ({ key: j.into, name: byId.get(j.into)?.name || j.into })),
      cuts: [], holes: [],
      freeOf: free.get(part.id) || [],
    };
  });
  const bounds = designBounds(design);
  const seat = out.find((p) => p.horizontal && /\b(seat|saddle)\b/i.test(p.name))
    || out.find((p) => p.horizontal && /\b(bench|stool|top)\b/i.test(p.name));
  const seatBox = seat && boxes.find((b) => b.part.id === seat.key);
  return {
    title: design?.title || '',
    pieceType: design?.pieceType || null,
    height: bounds ? bounds.max[1] - Math.min(0, bounds.min[1]) : 0,
    seatHeight: seatBox ? seatBox.center[1] + seatBox.half[2] - (bounds?.min[1] ?? 0) : 0,
    parts: out,
  };
}
