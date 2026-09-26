// In-browser port of parse_dae.py: turns a COLLADA (.dae) file - e.g. a 3D
// Warehouse "Collada" or KMZ download - into the viewer's data files, so new
// models can be uploaded without Python. Kept function-for-function with the
// Python so the two can be checked against each other (tests/parser_parity.mjs);
// change both together.
//
//   const out = parseCollada(xmlText, { fileName: 'workbench.dae' });
//   out.files -> { 'scene.obj', 'scene.mtl', 'materials.json', 'object_dims.json',
//                  'parts_report.json', 'model.json' }   (strings)

const PLAN_SHEET_PREFIX = 'Plan_Lie_Nielson_Boggs';
const INCH_IN_METERS = 0.0254;
const IDENTITY4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// ---------- XML helpers (namespace-agnostic) ----------
const kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el, name) => kids(el, name)[0] || null;
const desc = (el, name) => (el ? [...el.getElementsByTagNameNS('*', name)] : []);
const numbers = (text) => (text || '').trim().split(/\s+/).filter(Boolean).map(Number);

// Python's round() rounds halves to even; match it so sizes agree exactly.
function roundHalfEven(x) {
  const f = Math.floor(x), d = x - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}
const roundTo = (x, n) => { const r = Number(x.toFixed(n)); return Object.is(r, -0) ? 0 : r; };

// ---------- formatting ----------
function gcd(a, b) { return b ? gcd(b, a % b) : a; }
export function toFrac(x) {
  const sixteenths = roundHalfEven(x * 16);
  const whole = Math.floor(sixteenths / 16), rem = sixteenths - whole * 16;
  if (rem === 0) return `${whole}"`;
  const g = gcd(rem, 16);
  return whole ? `${whole}-${rem / g}/${16 / g}"` : `${rem / g}/${16 / g}"`;
}

// ---------- vector / matrix helpers ----------
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function vnorm(a) {
  const n = Math.sqrt(vdot(a, a));
  return n > 1e-12 ? [a[0] / n, a[1] / n, a[2] / n] : [1, 0, 0];
}
function normalize(v) {
  const n = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
  return n > 1e-9 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 0, 0];
}
const matVec3 = (m, v) => [0, 1, 2].map((i) => 0 + m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]);
function matMul(a, b) {
  const r = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j];
      r[i * 4 + j] = s;
    }
  }
  return r;
}
const applyMatrix = (m, p) => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];
const applyRotation = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[4] * v[0] + m[5] * v[1] + m[6] * v[2],
  m[8] * v[0] + m[9] * v[1] + m[10] * v[2],
];
// SketchUp (and most COLLADA) is Z-up; three.js is Y-up. Y-up files pass through.
const toYup = (p, up) => (up === 'Y_UP' ? [p[0], p[1], p[2]] : [p[0], p[2], -p[1]]);

// ---------- oriented bounding boxes ----------
function powerIteration(m, seed, iterations = 60) {
  let v = seed;
  for (let i = 0; i < iterations; i++) v = vnorm(matVec3(m, v));
  return [v, vdot(v, matVec3(m, v))];
}

// Oriented-bounding-box axes via PCA (see parse_dae.py principal_axes).
function principalAxes(points) {
  const n = points.length;
  const centroid = [0, 1, 2].map((k) => points.reduce((s, p) => s + p[k], 0) / n);
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of points) {
    const d = vsub(p, centroid);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += d[i] * d[j] / n;
  }
  const [v1, e1] = powerIteration(cov, [1.0, 0.6, 0.2]);
  const cov2 = [0, 1, 2].map((i) => [0, 1, 2].map((j) => cov[i][j] - e1 * v1[i] * v1[j]));
  let [v2] = powerIteration(cov2, [0.2, 1.0, 0.6]);
  const d12 = vdot(v1, v2);
  v2 = vnorm(vsub(v2, v1.map((x) => d12 * x)));
  return [centroid, [v1, v2, vcross(v1, v2)]];
}

// min/max without spreading (Math.min(...big) overflows the stack on large meshes)
function range(values) {
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return [lo, hi];
}

function fitBox(positions) {
  if (!positions.length) return [[0, 0, 0], [0, 0, 0], [[1, 0, 0], [0, 1, 0], [0, 0, 1]]];
  const r = [0, 1, 2].map((k) => range(positions.map((p) => p[k])));
  const aabbExt = r.map(([lo, hi]) => hi - lo);
  const aabbCenter = r.map(([lo, hi]) => (hi + lo) / 2);
  const aabbVol = aabbExt[0] * aabbExt[1] * aabbExt[2];
  const [centroid, axes] = principalAxes(positions);
  const pr = axes.map((ax) => range(positions.map((p) => vdot(vsub(p, centroid), ax))));
  const pcaExt = pr.map(([lo, hi]) => hi - lo);
  const pcaVol = pcaExt[0] * pcaExt[1] * pcaExt[2];
  // only trust PCA when it's a meaningfully tighter fit (part pre-rotated in its own mesh)
  if (pcaVol < aabbVol * 0.92) {
    const mids = pr.map(([lo, hi]) => (hi + lo) / 2);
    const center = [0, 1, 2].map((k) => centroid[k] + mids[0] * axes[0][k] + mids[1] * axes[1][k] + mids[2] * axes[2][k]);
    return [pcaExt, center, axes];
  }
  return [aabbExt, aabbCenter, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]];
}

// ---------- compound angles ----------
const CARDINALS = [
  ['+Y (vertical)', [0, 1, 0]], ['-Y (vertical)', [0, -1, 0]],
  ['+X', [1, 0, 0]], ['-X', [-1, 0, 0]], ['+Z', [0, 0, 1]], ['-Z', [0, 0, -1]],
];
const DEG = 180 / Math.PI;
function computeAxisAngle(d) {
  let bestName = null, bestDot = -2;
  for (const [name, axis] of CARDINALS) {
    const dot = vdot(d, axis);
    if (dot > bestDot) { bestDot = dot; bestName = name; }
  }
  bestDot = Math.max(-1, Math.min(1, bestDot));
  const total = Math.acos(bestDot) * DEG;
  if (total < 0.5) return null;
  let comp;
  if (bestName.includes('Y')) comp = [['x', Math.atan2(d[0], Math.abs(d[1])) * DEG], ['z', Math.atan2(d[2], Math.abs(d[1])) * DEG]];
  else if (bestName.includes('X')) comp = [['vertical', Math.atan2(d[1], Math.abs(d[0])) * DEG], ['z', Math.atan2(d[2], Math.abs(d[0])) * DEG]];
  else comp = [['x', Math.atan2(d[0], Math.abs(d[2])) * DEG], ['vertical', Math.atan2(d[1], Math.abs(d[2])) * DEG]];
  return {
    reference: bestName,
    total_deg: roundTo(total, 1),
    components: comp.map(([label, deg]) => ({ label, deg: roundTo(deg, 1) })),
  };
}

// ---------- COLLADA reading ----------
function loadGeometries(root, scale) {
  const geoms = new Map();
  for (const lib of kids(root, 'library_geometries')) {
    for (const g of kids(lib, 'geometry')) {
      const gid = g.getAttribute('id');
      const mesh = kid(g, 'mesh');
      if (!mesh) continue;
      const sources = new Map();
      for (const src of kids(mesh, 'source')) {
        const farr = kid(src, 'float_array');
        if (!farr || !farr.textContent.trim()) continue;
        const vals = numbers(farr.textContent);
        const acc = kid(kid(src, 'technique_common'), 'accessor');
        const stride = acc && acc.getAttribute('stride') ? parseInt(acc.getAttribute('stride'), 10) : 3;
        const tuples = [];
        for (let i = 0; i < vals.length; i += stride) tuples.push(vals.slice(i, i + stride));
        sources.set(src.getAttribute('id'), tuples);
      }
      let posSrc = null;
      const vtx = kid(mesh, 'vertices');
      for (const inp of kids(vtx, 'input')) if (inp.getAttribute('semantic') === 'POSITION') posSrc = inp.getAttribute('source').replace(/^#/, '');
      const positions = (sources.get(posSrc) || []).map((p) => [p[0] * scale, p[1] * scale, p[2] * scale]);

      const faces = [];
      const materialsUsed = new Set();
      const layout = (prim) => {
        const inputs = kids(prim, 'input');
        const stride = new Set(inputs.map((i) => i.getAttribute('offset'))).size || 1;
        const v = inputs.find((i) => i.getAttribute('semantic') === 'VERTEX');
        return { stride, vo: v ? parseInt(v.getAttribute('offset'), 10) : 0 };
      };
      for (const prim of [...kids(mesh, 'triangles'), ...kids(mesh, 'polylist')]) {
        if (prim.getAttribute('material')) materialsUsed.add(prim.getAttribute('material'));
        const { stride, vo } = layout(prim);
        const p = kid(prim, 'p');
        if (!p || !p.textContent.trim()) continue;
        const idx = numbers(p.textContent);
        const vcountEl = kid(prim, 'vcount');
        if (vcountEl && vcountEl.textContent.trim()) {
          let pos = 0;
          for (const vc of numbers(vcountEl.textContent)) {
            const verts = [];
            for (let k = 0; k < vc; k++) verts.push(idx[(pos + k) * stride + vo]);
            pos += vc;
            for (let k = 1; k < vc - 1; k++) faces.push([verts[0], verts[k], verts[k + 1]]);
          }
        } else {
          const n = Math.floor(idx.length / stride);
          for (let t = 0; t < n - (n % 3); t += 3) faces.push([0, 1, 2].map((k) => idx[(t + k) * stride + vo]));
        }
      }
      for (const prim of kids(mesh, 'polygons')) {
        if (prim.getAttribute('material')) materialsUsed.add(prim.getAttribute('material'));
        const { stride, vo } = layout(prim);
        for (const p of kids(prim, 'p')) {
          const idx = numbers(p.textContent);
          const verts = [];
          for (let k = 0; k < Math.floor(idx.length / stride); k++) verts.push(idx[k * stride + vo]);
          for (let k = 1; k < verts.length - 1; k++) faces.push([verts[0], verts[k], verts[k + 1]]);
        }
      }
      const [bbox, localCenter, localAxes] = fitBox(positions);
      geoms.set(gid, { positions, faces, bbox, localCenter, localAxes, materials: materialsUsed });
    }
  }
  return geoms;
}

function loadMaterials(root) {
  const imageById = new Map();
  desc(root, 'library_images').forEach((lib) => kids(lib, 'image').forEach((im) => {
    const init = kid(im, 'init_from');
    imageById.set(im.getAttribute('id'), init ? init.textContent : null);
  }));
  const effectDiffuse = new Map();
  desc(root, 'library_effects').forEach((lib) => kids(lib, 'effect').forEach((eff) => {
    let color = null, image = null;
    const diffuse = desc(eff, 'diffuse')[0];
    if (diffuse) {
      const c = kid(diffuse, 'color'), t = kid(diffuse, 'texture');
      if (c) color = numbers(c.textContent);
      if (t) {
        const params = new Map(desc(eff, 'newparam').map((np) => [np.getAttribute('sid'), np]));
        const samp = params.get(t.getAttribute('texture'));
        const src = samp ? kid(kid(samp, 'sampler2D'), 'source') : null;
        const surf = src ? params.get(src.textContent) : null;
        const init = surf ? kid(kid(surf, 'surface'), 'init_from') : null;
        if (init) image = imageById.get(init.textContent) || null;
      }
    }
    effectDiffuse.set(eff.getAttribute('id'), { color, image });
  }));
  const info = new Map();
  desc(root, 'library_materials').forEach((lib) => kids(lib, 'material').forEach((m) => {
    const ie = kid(m, 'instance_effect');
    const eff = effectDiffuse.get(ie ? ie.getAttribute('url').replace(/^#/, '') : null) || {};
    info.set(m.getAttribute('id'), { name: m.getAttribute('name'), color: eff.color || null, image: eff.image || null });
  }));
  return info;
}

// file unit -> inches; no unit given means metres (COLLADA spec)
function readUnitScale(root) {
  const unit = kid(kid(root, 'asset'), 'unit');
  let meter = unit && unit.getAttribute('meter') ? parseFloat(unit.getAttribute('meter')) : 1;
  if (!Number.isFinite(meter)) meter = 1;
  return meter > 0 ? meter / INCH_IN_METERS : 1;
}

function readUpAxis(root) {
  const el = kid(kid(root, 'asset'), 'up_axis');
  return el && el.textContent.trim().toUpperCase() === 'Y_UP' ? 'Y_UP' : 'Z_UP';
}

function rotation4(axis, deg) {
  const [x, y, z] = axis.some((v) => v) ? normalize(axis) : [1, 0, 0];
  const a = deg * Math.PI / 180;
  const c = Math.cos(a), s = Math.sin(a), t = 1 - Math.cos(a);
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0,
    0, 0, 0, 1];
}

// The node's local transform: <matrix>, <translate>, <rotate>, <scale>
// composed in document order; translations converted to inches.
function parseMatrix(node, scale) {
  let m = IDENTITY4;
  for (const el of node.children) {
    const tag = el.localName;
    if (!['matrix', 'translate', 'rotate', 'scale'].includes(tag)) continue;
    const v = numbers(el.textContent);
    if (tag === 'matrix' && v.length === 16) {
      v[3] *= scale; v[7] *= scale; v[11] *= scale;
      m = matMul(m, v);
    } else if (tag === 'translate' && v.length === 3) {
      m = matMul(m, [1, 0, 0, v[0] * scale, 0, 1, 0, v[1] * scale, 0, 0, 1, v[2] * scale, 0, 0, 0, 1]);
    } else if (tag === 'rotate' && v.length === 4) {
      m = matMul(m, rotation4(v.slice(0, 3), v[3]));
    } else if (tag === 'scale' && v.length === 3) {
      m = matMul(m, [v[0], 0, 0, 0, 0, v[1], 0, 0, 0, 0, v[2], 0, 0, 0, 0, 1]);
    }
  }
  return m;
}

function materialBindings(ig) {
  const out = new Map();
  const bm = kid(ig, 'bind_material');
  if (bm) desc(bm, 'instance_material').forEach((im) => out.set(im.getAttribute('symbol'), im.getAttribute('target').replace(/^#/, '')));
  return out;
}

function resolveInstances(root, scale) {
  const libNodes = new Map();
  desc(root, 'library_nodes').forEach((lib) => desc(lib, 'node').forEach((n) => { if (n.getAttribute('id')) libNodes.set(n.getAttribute('id'), n); }));
  // skinned meshes: <instance_controller> -> controller/skin -> source geometry, in bind pose
  const controllers = new Map();
  desc(root, 'library_controllers').forEach((lib) => kids(lib, 'controller').forEach((c) => {
    const skin = kid(c, 'skin');
    if (!skin || !skin.getAttribute('source')) return;
    const bsm = kid(skin, 'bind_shape_matrix');
    const v = bsm ? numbers(bsm.textContent) : [];
    if (v.length === 16) { v[3] *= scale; v[7] *= scale; v[11] *= scale; }
    controllers.set(c.getAttribute('id'), [skin.getAttribute('source').replace(/^#/, ''), v.length === 16 ? v : IDENTITY4]);
  }));

  const instances = [];
  const depthGuard = new Set();

  function addInstance(el, gid, world, namePath, topGroup) {
    let label = namePath.length ? namePath[namePath.length - 1] : gid;
    if (label === 'Head__2__6' && namePath.length >= 2 && namePath[namePath.length - 2] === 'Nut_3_4') label = 'Nut_3_4';
    instances.push({
      label,
      path: namePath.length ? namePath.join('/') : gid,
      top_group: topGroup || (namePath.length ? namePath[0] : gid),
      geom_id: gid,
      world_matrix: world,
      material_bindings: materialBindings(el),
    });
  }

  function visit(node, parentMatrix, namePath, topGroup) {
    const world = matMul(parentMatrix, parseMatrix(node, scale));
    const name = node.getAttribute('name') || node.getAttribute('id');
    // skip SketchUp's anonymous component wrappers so parts keep their real names
    if (!/^SketchUp_Instance_\d+$/.test(name || '')) {
      namePath = [...namePath, name];
      if (topGroup === null) topGroup = name;
    }
    for (const ig of kids(node, 'instance_geometry')) addInstance(ig, ig.getAttribute('url').replace(/^#/, ''), world, namePath, topGroup);
    for (const ic of kids(node, 'instance_controller')) {
      const ctrl = controllers.get(ic.getAttribute('url').replace(/^#/, ''));
      if (ctrl) addInstance(ic, ctrl[0], matMul(world, ctrl[1]), namePath, topGroup);
    }
    for (const inode of kids(node, 'instance_node')) {
      const target = libNodes.get(inode.getAttribute('url').replace(/^#/, ''));
      if (target && !depthGuard.has(target)) {
        depthGuard.add(target); // guard against cyclic references in malformed files
        visit(target, world, namePath, topGroup);
        depthGuard.delete(target);
      }
    }
    for (const child of kids(node, 'node')) visit(child, world, namePath, topGroup);
  }

  const vs = desc(kid(root, 'library_visual_scenes'), 'visual_scene')[0];
  const roots = kids(vs, 'node');
  if (roots.length === 1 && !kid(roots[0], 'instance_geometry') && !kid(roots[0], 'instance_controller')) {
    for (const child of kids(roots[0], 'node')) visit(child, parseMatrix(roots[0], scale), [], null);
  } else {
    for (const node of roots) visit(node, IDENTITY4, [], null);
  }
  return instances;
}

// ---------- outputs ----------
const isPlanSheet = (inst) => inst.path.startsWith(PLAN_SHEET_PREFIX);
const isExcludedFrom3d = (inst) => isPlanSheet(inst) || inst.path.split('/').includes('Nut_3_4');

function pickMaterial(bindings, info) {
  for (const target of bindings.values()) {
    if (!((info.get(target) || {}).name || '').startsWith('edge_color')) return target;
  }
  const first = bindings.values().next();
  return first.done ? null : first.value;
}

function writeObj(instances, geoms, info, up) {
  const matKeyToName = {};
  const seen = new Map();
  const written = new Set();
  const obj = ['mtllib scene.mtl\n'];
  const mtl = [];
  let vertexOffset = 0;
  const f5 = (v) => v.toFixed(5);
  for (const inst of instances) {
    if (isExcludedFrom3d(inst)) continue;
    const geo = geoms.get(inst.geom_id);
    if (!geo || !geo.positions.length || !geo.faces.length) continue;
    const base = inst.path.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 55) || inst.geom_id;
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    inst.safe_name = n ? `${base}_${n}` : base;
    inst.in_obj = true;
    obj.push(`o ${inst.safe_name}\n`);
    for (const p of geo.positions) {
      const w = toYup(applyMatrix(inst.world_matrix, p), up);
      obj.push(`v ${f5(w[0])} ${f5(w[1])} ${f5(w[2])}\n`);
    }
    const target = pickMaterial(inst.material_bindings, info);
    const key = target || 'default';
    const mi = info.get(target) || {};
    matKeyToName[key] = mi.name || 'default';
    if (!written.has(key)) {
      written.add(key);
      const c = mi.color || [0.7, 0.55, 0.35, 1.0];
      // textures aren't carried over (the OBJ has no UVs); the viewer shades by colour
      mtl.push(`newmtl ${key}\nKd ${c[0].toFixed(3)} ${c[1].toFixed(3)} ${c[2].toFixed(3)}\n\n`);
    }
    obj.push(`usemtl ${key}\n`);
    for (const face of geo.faces) obj.push(`f ${vertexOffset + face[0] + 1} ${vertexOffset + face[1] + 1} ${vertexOffset + face[2] + 1}\n`);
    vertexOffset += geo.positions.length;
  }
  return { obj: obj.join(''), mtl: mtl.join(''), matKeyToName };
}

function computeObjectDims(instances, geoms, up) {
  const out = {};
  for (const inst of instances) {
    if (!inst.in_obj) continue;
    const geo = geoms.get(inst.geom_id);
    if (!geo) continue;
    const wm = inst.world_matrix;
    const center = toYup(applyMatrix(wm, geo.localCenter), up);
    const axes = [];
    for (let i = 0; i < 3; i++) {
      const length = geo.bbox[i];
      if (length < 1e-6) continue;
      const dir = toYup(normalize(applyRotation(wm, geo.localAxes[i])), up);
      axes.push({ direction: dir.map((v) => roundTo(v, 6)), length: roundTo(length, 4) });
    }
    axes.sort((a, b) => b.length - a.length);
    axes.forEach((a, i) => {
      a.role = ['Length', 'Width', 'Thickness'][i] || `axis${i}`;
      a.label = toFrac(a.length);
      const angle = computeAxisAngle(a.direction);
      if (angle) a.angle = angle;
    });
    out[inst.safe_name] = { center: center.map((v) => roundTo(v, 4)), axes };
  }
  return out;
}

// whole_numerator_denominator lengths in part names, e.g. Shaft_1_2_-13_8_1_4
const NAMED_LENGTH = /(?<![0-9])(?=(\d+)_(\d+)_(\d+)(?![0-9]))/g;
export function namedLengthWarning(label, dims) {
  const named = [];
  for (const m of label.matchAll(NAMED_LENGTH)) {
    const whole = +m[1], num = +m[2], den = +m[3];
    if (num > 0 && num < den && [2, 4, 8, 16, 32, 64].includes(den)) named.push(whole + num / den);
  }
  if (!named.length) return null;
  if (named.some((n) => dims.some((d) => Math.abs(n - d) <= 1 / 16))) return null;
  return `Named ${toFrac(range(named)[1])} in the source model but modeled ${toFrac(range(dims)[1])} long - check the plan.`;
}

function applyManualCorrections(rows) {
  for (const r of rows) {
    if (r.label === 'Bolt_Head__6') {
      r.count = 4;
      r.dims_str = '3/4" hex head (fits 1/2"-13 rod)';
      r.note = 'source file models each head as 6 face facets; qty corrected to real fastener count';
    } else if (r.label === 'Nut_3_4') {
      r.count = 4;
      r.dims_str = '3/4" hex nut (fits 1/2"-13 rod)';
      r.obj_names = [];
      r.note = 'source geometry for this part is corrupted (huge bogus bbox); not shown in 3D view, qty inferred from matching rod count';
    }
  }
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // codepoint order, like Python

function buildReport(instances, geoms, info) {
  const report = new Map();
  for (const inst of instances) {
    if (isPlanSheet(inst)) continue;
    const geo = geoms.get(inst.geom_id);
    if (!geo || !geo.faces.length) continue;
    const dims = [...geo.bbox].sort((a, b) => b - a).map((d) => roundTo(d, 3));
    const key = `${inst.label}\u0000${dims.join(',')}`;
    if (!report.has(key)) {
      report.set(key, { label: inst.label, top_group: inst.top_group, dims, count: 0, materials: new Set(), paths: [], obj_names: [] });
    }
    const rep = report.get(key);
    rep.count += 1;
    for (const t of inst.material_bindings.values()) {
      const nm = (info.get(t) || {}).name;
      if (nm && !nm.startsWith('edge_color')) rep.materials.add(nm);
    }
    rep.paths.push(inst.path);
    if (inst.in_obj) rep.obj_names.push(inst.safe_name);
  }
  const rows = [...report.values()].sort((a, b) => cmp(a.top_group || '', b.top_group || '') || cmp(a.label, b.label));
  const out = rows.map((r) => ({
    ...r,
    materials: [...r.materials].sort(cmp),
    dims_str: `${toFrac(r.dims[0])} x ${toFrac(r.dims[1])} x ${toFrac(r.dims[2])}`,
  }));
  out.forEach((r) => { const w = namedLengthWarning(r.label, r.dims); if (w) r.warning = w; });
  applyManualCorrections(out);
  return out;
}

const CATEGORY_WORDS = [
  ['Wood', ['wood', 'oak', 'maple', 'walnut', 'cherry', 'ash', 'pine', 'birch', 'poplar', 'plywood', 'mahogany', 'beech', 'cedar', 'fir']],
  ['Hardware', ['metal', 'steel', 'iron', 'brass', 'bronze', 'alumin', 'chrome', 'zinc', 'bolt', 'screw']],
  ['Leather', ['leather']],
];
export function guessCategory(name) {
  const n = (name || '').toLowerCase();
  for (const [cat, words] of CATEGORY_WORDS) if (words.some((w) => n.includes(w))) return cat;
  return 'Other';
}

function titleCase(s) {
  return s.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (m, p, c) => p + c.toUpperCase());
}

export function starterConfig(fileName, matKeyToName, info) {
  const base = (fileName || 'model').replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
  const title = titleCase(base.replace(/[_-]+/g, ' ').trim()) || 'Model';
  const byName = new Map([...info.values()].map((i) => [i.name, i]));
  const materials = {};
  for (const name of [...new Set(Object.values(matKeyToName))].sort(cmp)) {
    const c = ((byName.get(name) || {}).color) || [0.7, 0.55, 0.35, 1];
    const hex = '#' + c.slice(0, 3).map((v) => Math.max(0, Math.min(255, roundHalfEven(v * 255))).toString(16).padStart(2, '0')).join('');
    const entry = { category: guessCategory(name), color: hex };
    if (entry.category === 'Wood') entry.texture = { base: '#c9975c', streak: '#a06f3b', ring: '#8a5a2c', tile: 5 };
    materials[name] = entry;
  }
  return {
    title,
    subtitle: '',
    axisNames: { x: 'front-to-back', y: 'vertical', z: 'side-to-side' },
    views: {
      iso: { label: '3D', dir: [0.7, 0.5, 0.7] },
      front: { label: 'Front', dir: [1, 0, 0] },
      side: { label: 'Side', dir: [0, 0, 1] },
      top: { label: 'Top', dir: [0, 1, 0.0001] },
    },
    materials,
    categoryOrder: ['Wood', 'Hardware', 'Leather', 'Other'],
    displayNames: {},
    notes: {},
  };
}

// ---------- entry point ----------
export function parseCollada(xmlText, { fileName = 'model.dae', parser = null } = {}) {
  const doc = (parser || new DOMParser()).parseFromString(xmlText, 'application/xml');
  const root = doc.documentElement;
  if (!root || root.localName !== 'COLLADA' || doc.getElementsByTagName('parsererror').length) {
    throw new Error('This is not a COLLADA (.dae) file.');
  }
  const scale = readUnitScale(root);
  const up = readUpAxis(root);
  const geoms = loadGeometries(root, scale);
  const info = loadMaterials(root);
  const instances = resolveInstances(root, scale);
  const { obj, mtl, matKeyToName } = writeObj(instances, geoms, info, up);
  const dims = computeObjectDims(instances, geoms, up);
  const rows = buildReport(instances, geoms, info);
  if (!rows.length) throw new Error('No solid parts found in this model.');
  return {
    files: {
      'scene.obj': obj,
      'scene.mtl': mtl,
      'materials.json': JSON.stringify(matKeyToName, null, 2),
      'object_dims.json': JSON.stringify(dims, null, 2),
      'parts_report.json': JSON.stringify(rows, null, 2),
      'model.json': JSON.stringify(starterConfig(fileName, matKeyToName, info), null, 2),
    },
    stats: { instances: instances.length, parts: rows.length, meshes: Object.keys(dims).length, scaleToInches: scale, upAxis: up },
  };
}
