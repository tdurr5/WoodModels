import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { toDAE, toGLB, toSTL, toOBJ } from '../viewer/export3d.js';

// Export the spinning wheel the way the viewer does (each part's triangles,
// named and grouped as the cut list has them), and read it back.
const folder = new URL('../viewer/models/spinning-wheel/', import.meta.url);
const report = JSON.parse(readFileSync(new URL('parts_report.json', folder)));
const dims = JSON.parse(readFileSync(new URL('object_dims.json', folder)));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
// as the viewer does: the part's own axes from object_dims.json, made right-handed
function frameOf(name) {
  const d = dims[name];
  const X = unit(d.axes[0].direction), Z = unit(cross(X, unit(d.axes[1].direction)));
  return { origin: d.center, axes: [X, cross(Z, X), Z] };
}
const rowOf = new Map(report.flatMap((r) => r.obj_names.map((n) => [n, r])));
const colors = { Walnut: '#6b472b', Cherry: '#9e422b', Steel: '#9ea3ab', Leather: '#8c6138', Cord: '#d9ccad' };

function partsFromObj(text) {
  const v = [];
  const parts = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('v ')) v.push(line.slice(2).trim().split(/\s+/).map(Number));
    else if (line.startsWith('o ')) {
      const n = line.slice(2).trim(), r = rowOf.get(n);
      cur = { name: r.label, group: r.top_group, color: colors[r.material], frame: frameOf(n), tris: [] };
      parts.push(cur);
    } else if (line.startsWith('f ') && cur) {
      const idx = line.slice(2).trim().split(/\s+/).map((t) => parseInt(t, 10) - 1);
      for (let k = 1; k + 1 < idx.length; k++) cur.tris.push(...v[idx[0]], ...v[idx[k]], ...v[idx[k + 1]]);
    }
  }
  return parts.map(({ tris, ...p }) => ({ ...p, positions: Float32Array.from(tris) }));
}

const parts = partsFromObj(readFileSync(new URL('scene.obj', folder), 'utf8'));
const triangles = parts.reduce((n, p) => n + p.positions.length / 9, 0);

test('the .dae reads back as the same cut list: every part, its size, its group', () => {
  const dir = mkdtempSync(join(tmpdir(), 'export3d-'));
  try {
    writeFileSync(join(dir, 'wheel.dae'), toDAE(parts, 'Castle Spinning Wheel'));
    execFileSync('python3', [new URL('../parse_dae.py', import.meta.url).pathname, join(dir, 'wheel.dae'), '-o', join(dir, 'out'), '-q']);
    const back = JSON.parse(readFileSync(join(dir, 'out', 'parts_report.json')));
    assert.equal(back.reduce((n, r) => n + r.count, 0), 80);
    for (const r of report) {
      const b = back.find((x) => x.label === r.label && x.top_group === r.top_group);
      assert.ok(b, `${r.label} missing from the export`);
      assert.equal(b.count, r.count, `${r.label} count`);
      r.dims.forEach((d, i) => assert.ok(Math.abs(d - b.dims[i]) < 0.005, `${r.label} ${d} != ${b.dims[i]}`));
    }
    const mats = JSON.parse(readFileSync(join(dir, 'out', 'materials.json')));
    assert.ok(Object.keys(mats).length >= 5, 'one material per colour');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the .glb is valid glTF 2.0 with a named node per part, in metres', () => {
  const buf = toGLB(parts, 'Castle Spinning Wheel');
  const dv = new DataView(buf);
  assert.equal(dv.getUint32(0, true), 0x46546c67);   // 'glTF'
  assert.equal(dv.getUint32(8, true), buf.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
  assert.equal(json.meshes.length, 80);
  assert.deepEqual(json.scenes[0].nodes.map((i) => json.nodes[i].name).sort(), ['Flyer Assembly', 'Frame Assembly', 'Wheel Assembly']);
  const top = Math.max(...json.accessors.map((a) => a.max[1]));
  assert.ok(Math.abs(top - 1.1646) < 0.002, `top at ${top} m`);   // the wool bar's top
  assert.equal(dv.getUint32(20 + jsonLen + 4, true), 0x004e4942);  // 'BIN'
});

test('the .stl has every triangle, in millimetres, Z up', () => {
  const buf = toSTL(parts);
  const dv = new DataView(buf);
  assert.equal(dv.getUint32(80, true), triangles);
  assert.equal(buf.byteLength, 84 + 50 * triangles);
  let top = -Infinity;
  for (let t = 0; t < triangles; t++) for (let k = 0; k < 3; k++) top = Math.max(top, dv.getFloat32(84 + t * 50 + 12 + k * 12 + 8, true));
  assert.ok(Math.abs(top - 1164.6) < 1, `top at ${top} mm`);
});

test('the .obj has one named object per part', () => {
  const obj = toOBJ(parts);
  assert.equal((obj.match(/^o /gm) || []).length, 80);
  assert.equal((obj.match(/^f /gm) || []).length, triangles);
  assert.match(obj, /^o Main_Pillar$/m);
});
