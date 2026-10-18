// A model folder as a SketchUp file, the same way the viewer's .skp button writes it.
//
//   node scripts/to_skp.mjs viewer/models/scroll-saw/ [out.skp]
//
// Reads the folder's scene.obj, parts_report.json, object_dims.json and
// model.json (as parse_dae.py wrote them); writes <title>.skp in the current
// folder unless given a path.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { create } from 'openskp';
import { toSKP } from '../viewer/skp.js';

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };

// each object in scene.obj as a part: its triangles, cut-list name, assembly, wood and own axes
export function partsOf(folder) {
  const read = (f) => readFileSync(join(folder, f), 'utf8');
  const report = JSON.parse(read('parts_report.json'));
  const dims = JSON.parse(read('object_dims.json'));
  const config = JSON.parse(read('model.json'));
  const rowOf = new Map(report.flatMap((r) => r.obj_names.map((n) => [n, r])));
  // as the viewer does: the part's length and width axes, made right-handed
  const frameOf = (n) => {
    const d = dims[n];
    if (d?.axes?.length !== 3) return null;
    const X = unit(d.axes[0].direction), Z = unit(cross(X, unit(d.axes[1].direction)));
    return { origin: d.center, axes: [X, cross(Z, X), Z] };
  };
  const v = [], parts = [];
  let cur = null;
  for (const line of read('scene.obj').split('\n')) {
    if (line.startsWith('v ')) v.push(line.slice(2).trim().split(/\s+/).map(Number));
    else if (line.startsWith('o ')) {
      const n = line.slice(2).trim(), r = rowOf.get(n);
      const mat = config.materials?.[r?.material];
      cur = { name: r?.label || n, group: r?.top_group, material: mat?.label || r?.material, color: mat?.color, frame: frameOf(n), tris: [] };
      parts.push(cur);
    } else if (line.startsWith('f ') && cur) {
      const idx = line.slice(2).trim().split(/\s+/).map((t) => parseInt(t, 10) - 1);
      for (let k = 1; k + 1 < idx.length; k++) cur.tris.push(...v[idx[0]], ...v[idx[k]], ...v[idx[k + 1]]);
    }
  }
  return { title: config.title || 'Model', parts: parts.map(({ tris, ...p }) => ({ ...p, positions: Float32Array.from(tris) })) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [folder, out] = process.argv.slice(2);
  if (!folder) {
    console.error('usage: node scripts/to_skp.mjs <model folder> [out.skp]');
    process.exit(1);
  }
  const { title, parts } = partsOf(folder);
  const path = out || `${title}.skp`;
  writeFileSync(path, toSKP(parts, title, create));
  console.log(`wrote ${path}: ${parts.length} parts`);
}
