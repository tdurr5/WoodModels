// The model on screen as a 3D file to take into other programs: COLLADA
// (.dae - SketchUp, Blender), binary glTF (.glb), STL and OBJ. (.skp is skp.js.)
// Pure: no three.js, no DOM. Each part comes in as
//   { name, group, color: '#rrggbb', positions: Float32Array, frame? }
// with positions a flat triangle list in the viewer's own space (inches, Y up),
// and frame (optional) the part's own axes - { origin: [x,y,z], axes: [x, y, z
// unit vectors] }, its length, width and thickness directions. COLLADA writes a
// part with a frame in it, placed by a matrix, the way SketchUp components are,
// so what reads it back measures the part along its own grain.
// The files keep one object per part, named as the cut list names it; COLLADA
// and glTF also keep the assembly groups and each part's material colour.

const MM = 25.4;
const M = 0.0254;

const rgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0xb08a5a;
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const ids = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, '_') || 'part';
const fmt = (v) => (Math.round(v * 1e5) / 1e5).toString();

// distinct materials by colour, in order of first use
function palette(parts) {
  const out = new Map();
  parts.forEach((p) => { const c = (p.color || '#b08a5a').toLowerCase(); if (!out.has(c)) out.set(c, `mat${out.size}`); });
  return out;
}

// a part's positions in its own frame, and the matrix placing them (row-major)
function local(p) {
  const f = p.frame;
  if (!f) return { pos: p.positions, matrix: null };
  const [X, Y, Z] = f.axes, o = f.origin, s = p.positions;
  const pos = new Float32Array(s.length);
  for (let k = 0; k < s.length; k += 3) {
    const d0 = s[k] - o[0], d1 = s[k + 1] - o[1], d2 = s[k + 2] - o[2];
    pos[k] = d0 * X[0] + d1 * X[1] + d2 * X[2];
    pos[k + 1] = d0 * Y[0] + d1 * Y[1] + d2 * Y[2];
    pos[k + 2] = d0 * Z[0] + d1 * Z[1] + d2 * Z[2];
  }
  return { pos, matrix: [X[0], Y[0], Z[0], o[0], X[1], Y[1], Z[1], o[1], X[2], Y[2], Z[2], o[2], 0, 0, 0, 1] };
}

// COLLADA 1.4, inches, Y up - what SketchUp and converters to .skp read.
export function toDAE(parts, title = 'Model') {
  const mats = palette(parts);
  const effects = [...mats].map(([c, id]) => `<effect id="${id}-fx"><profile_COMMON><technique sid="c"><lambert><diffuse><color>${rgb(c).map(fmt).join(' ')} 1</color></diffuse></lambert></technique></profile_COMMON></effect>`).join('');
  const materials = [...mats.values()].map((id) => `<material id="${id}" name="${id}"><instance_effect url="#${id}-fx"/></material>`).join('');
  const geoms = [];
  const groups = new Map();
  parts.forEach((p, i) => {
    const n = p.positions.length / 3;
    const g = `g${i}`;
    const { pos, matrix } = local(p);
    geoms.push(`<geometry id="${g}" name="${esc(p.name)}"><mesh><source id="${g}-p"><float_array id="${g}-a" count="${n * 3}">${Array.from(pos, fmt).join(' ')}</float_array>`
      + `<technique_common><accessor source="#${g}-a" count="${n}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>`
      + `<vertices id="${g}-v"><input semantic="POSITION" source="#${g}-p"/></vertices>`
      + `<triangles material="m" count="${n / 3}"><input semantic="VERTEX" source="#${g}-v" offset="0"/><p>${Array.from({ length: n }, (_, k) => k).join(' ')}</p></triangles></mesh></geometry>`);
    const node = `<node id="n${i}" name="${esc(p.name)}">${matrix ? `<matrix>${matrix.map((x) => (Math.round(x * 1e7) / 1e7).toString()).join(' ')}</matrix>` : ''}<instance_geometry url="#${g}"><bind_material><technique_common><instance_material symbol="m" target="#${mats.get((p.color || '#b08a5a').toLowerCase())}"/></technique_common></bind_material></instance_geometry></node>`;
    const key = p.group || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  });
  const scene = [...groups].map(([g, nodes], i) => (g ? `<node id="grp${i}" name="${esc(g)}">${nodes.join('')}</node>` : nodes.join(''))).join('');
  return '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">'
    + '<asset><contributor><authoring_tool>WoodModels cut-list viewer</authoring_tool></contributor><unit name="inch" meter="0.0254"/><up_axis>Y_UP</up_axis></asset>'
    + `<library_effects>${effects}</library_effects><library_materials>${materials}</library_materials>`
    + `<library_geometries>${geoms.join('')}</library_geometries>`
    + `<library_visual_scenes><visual_scene id="scene" name="${esc(title)}">${scene}</visual_scene></library_visual_scenes>`
    + '<scene><instance_visual_scene url="#scene"/></scene></COLLADA>';
}

// Binary glTF 2.0, metres, Y up (glTF's own convention).
export function toGLB(parts, title = 'Model') {
  const mats = palette(parts);
  const chunks = [];
  let offset = 0;
  const accessors = [], bufferViews = [], meshes = [], nodes = [];
  const groupNodes = new Map();
  parts.forEach((p, i) => {
    const pos = Float32Array.from(p.positions, (v) => v * M);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < pos.length; k++) { min[k % 3] = Math.min(min[k % 3], pos[k]); max[k % 3] = Math.max(max[k % 3], pos[k]); }
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: pos.byteLength, target: 34962 });
    accessors.push({ bufferView: i, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max });
    chunks.push(pos);
    offset += pos.byteLength;
    meshes.push({ name: p.name, primitives: [{ attributes: { POSITION: i }, material: [...mats.keys()].indexOf((p.color || '#b08a5a').toLowerCase()) }] });
    nodes.push({ name: p.name, mesh: i });
    const key = p.group || '';
    if (!groupNodes.has(key)) groupNodes.set(key, []);
    groupNodes.get(key).push(i);
  });
  const roots = [];
  groupNodes.forEach((children, g) => {
    if (!g) { roots.push(...children); return; }
    nodes.push({ name: g, children });
    roots.push(nodes.length - 1);
  });
  const json = {
    asset: { version: '2.0', generator: 'WoodModels cut-list viewer' },
    scene: 0, scenes: [{ name: title, nodes: roots }], nodes, meshes, accessors, bufferViews,
    buffers: [{ byteLength: offset }],
    materials: [...mats.keys()].map((c, k) => ({ name: `mat${k}`, pbrMetallicRoughness: { baseColorFactor: [...rgb(c), 1], metallicFactor: 0, roughnessFactor: 0.7 } })),
  };
  const enc = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = Math.ceil(enc.length / 4) * 4;
  const binLen = Math.ceil(offset / 4) * 4;
  const out = new ArrayBuffer(12 + 8 + jsonLen + 8 + binLen);
  const dv = new DataView(out);
  const bytes = new Uint8Array(out);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.byteLength, true);
  dv.setUint32(12, jsonLen, true); dv.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20, 20 + jsonLen); bytes.set(enc, 20);
  const binAt = 20 + jsonLen;
  dv.setUint32(binAt, binLen, true); dv.setUint32(binAt + 4, 0x004e4942, true);
  let at = binAt + 8;
  chunks.forEach((c) => { bytes.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), at); at += c.byteLength; });
  return out;
}

// Binary STL, millimetres, Z up (what 3D printers and CAD expect). One solid:
// STL has no names, groups or colours.
export function toSTL(parts) {
  const tris = parts.reduce((n, p) => n + p.positions.length / 9, 0);
  const out = new ArrayBuffer(84 + 50 * tris);
  const dv = new DataView(out);
  new Uint8Array(out).set(new TextEncoder().encode('WoodModels cut-list viewer, millimetres'.padEnd(80, ' ')).slice(0, 80));
  dv.setUint32(80, tris, true);
  let at = 84;
  const v = new Float32Array(9);
  parts.forEach((p) => {
    const s = p.positions;
    for (let t = 0; t < s.length; t += 9) {
      for (let k = 0; k < 3; k++) {   // (x, y, z) Y-up inches -> (x, -z, y) Z-up mm
        v[k * 3] = s[t + k * 3] * MM; v[k * 3 + 1] = -s[t + k * 3 + 2] * MM; v[k * 3 + 2] = s[t + k * 3 + 1] * MM;
      }
      const ux = v[3] - v[0], uy = v[4] - v[1], uz = v[5] - v[2], wx = v[6] - v[0], wy = v[7] - v[1], wz = v[8] - v[2];
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      [nx, ny, nz, ...v].forEach((f, k) => dv.setFloat32(at + k * 4, f, true));
      at += 50;
    }
  });
  return out;
}

// Wavefront OBJ, millimetres, Y up: one named object per part.
export function toOBJ(parts) {
  const lines = ['# WoodModels cut-list viewer, millimetres'];
  let base = 1;
  const used = new Map();
  parts.forEach((p) => {
    const nm = ids(p.name);
    used.set(nm, (used.get(nm) || 0) + 1);
    lines.push(`o ${nm}${used.get(nm) > 1 ? `_${used.get(nm)}` : ''}`);
    const s = p.positions;
    for (let k = 0; k < s.length; k += 3) lines.push(`v ${fmt(s[k] * MM)} ${fmt(s[k + 1] * MM)} ${fmt(s[k + 2] * MM)}`);
    for (let k = 0; k < s.length / 3; k += 3) lines.push(`f ${base + k} ${base + k + 1} ${base + k + 2}`);
    base += s.length / 3;
  });
  return `${lines.join('\n')}\n`;
}

export const FORMATS = {
  dae: { label: '.dae (SketchUp)', type: 'model/vnd.collada+xml', make: toDAE },
  glb: { label: '.glb', type: 'model/gltf-binary', make: toGLB },
  stl: { label: '.stl', type: 'model/stl', make: toSTL },
  obj: { label: '.obj', type: 'text/plain', make: toOBJ },
};
