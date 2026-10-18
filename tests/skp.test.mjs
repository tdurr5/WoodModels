import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, parseSkp } from 'openskp';
import { facesOf, toSKP } from '../viewer/skp.js';
import { partsOf } from '../scripts/to_skp.mjs';

// The .skp writer: triangles joined back into faces, and a whole model written
// and read back (with openskp's own reader) with every part where it was.

const quad = (a, b, c, d) => [a, b, c, a, c, d];
function cube(s = 1) {
  const p = (x, y, z) => [x * s, y * s, z * s];
  return [
    ...quad(p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)), ...quad(p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)),
    ...quad(p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)), ...quad(p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)),
    ...quad(p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)), ...quad(p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)),
  ];
}
function cylinder(r, h, n) {
  const at = (k, z) => [r * Math.cos((2 * Math.PI * k) / n), r * Math.sin((2 * Math.PI * k) / n), z];
  const t = [];
  for (let k = 0; k < n; k++) {
    t.push(...quad(at(k, 0), at(k + 1, 0), at(k + 1, h), at(k, h)));
    t.push([0, 0, 0], at(k + 1, 0), at(k, 0), [0, 0, h], at(k, h), at(k + 1, h));
  }
  return t;
}

test('a cube\'s 12 triangles come back as its 6 square faces, hard-edged', () => {
  const faces = facesOf(cube(2));
  assert.equal(faces.length, 6);
  faces.forEach((f) => { assert.equal(f.loop.length, 4); assert.equal(f.soft, false); });
});

test('a dowel: two round ends with hard rims, a soft, smooth side', () => {
  const faces = facesOf(cylinder(0.5, 3, 24));
  const ends = faces.filter((f) => !f.soft);
  assert.equal(ends.length, 2);
  ends.forEach((f) => assert.equal(f.loop.length, 24));
  assert.ok(faces.filter((f) => f.soft).length >= 24);
  assert.ok(faces.indexOf(ends[1]) < faces.findIndex((f) => f.soft), 'flat faces are written before the soft ones');
});

test('a board with a hole through it: each face keeps its hole', () => {
  // a 4x4 plate, 1 thick, with a 2x2 square hole: the top and bottom are one face each, with a hole
  const P = (x, y, z) => [x, y, z];
  const ring = (z, up) => {
    const o = [P(0, 0, z), P(4, 0, z), P(4, 4, z), P(0, 4, z)], i = [P(1, 1, z), P(3, 1, z), P(3, 3, z), P(1, 3, z)];
    const t = [];
    for (let k = 0; k < 4; k++) {
      const q = [o[k], o[(k + 1) % 4], i[(k + 1) % 4], i[k]];
      t.push(...(up ? quad(...q) : quad(...q.reverse())));
    }
    return t;
  };
  const wall = (a, b) => quad(a, b, [b[0], b[1], 1], [a[0], a[1], 1]);
  const o = [P(0, 0, 0), P(4, 0, 0), P(4, 4, 0), P(0, 4, 0)], i = [P(1, 1, 0), P(1, 3, 0), P(3, 3, 0), P(3, 1, 0)];
  const tris = [...ring(1, true), ...ring(0, false)];
  for (let k = 0; k < 4; k++) tris.push(...wall(o[k], o[(k + 1) % 4]), ...wall(i[k], i[(k + 1) % 4]));
  const faces = facesOf(tris);
  const withHoles = faces.filter((f) => f.holes.length === 1);
  assert.equal(withHoles.length, 2);
  withHoles.forEach((f) => { assert.equal(f.loop.length, 4); assert.equal(f.holes[0].length, 4); });
  assert.equal(faces.length, 10);
});

// every part's box in the file, in SketchUp's axes (Z up)
function partBoxes(model) {
  const apply = (M, p) => [0, 1, 2].map((r) => (M[3 * r] * p[0] + M[3 * r + 1] * p[1] + M[3 * r + 2] * p[2]) * (M[12] || 1) + M[9 + r]);
  const mul = (A, B) => [...[0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => A[3 * r] * B[c] + A[3 * r + 1] * B[3 + c] + A[3 * r + 2] * B[6 + c])), ...apply(A, B.slice(9, 12)), 1];
  const out = [];
  const walk = (def, M, group) => def.instances.forEach((ins) => {
    const child = model.definitions.get(ins.refIdx);
    const W = mul(M, ins.matrix);
    if (child.faces.length) out.push({ name: ins.name, group, box: box(child.vertices.map((q) => apply(W, [q.x, q.y, q.z]))) });
    walk(child, W, group || ins.name);
  });
  walk(model.root, [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], null);
  return out;
}
const box = (pts) => [0, 1, 2].map((i) => [Math.min(...pts.map((p) => p[i])), Math.max(...pts.map((p) => p[i]))]);

for (const name of ['treadle-lathe', 'scroll-saw']) {
  test(`${name}: written, read back, every part in place`, () => {
    const { title, parts } = partsOf(new URL(`../viewer/models/${name}/`, import.meta.url).pathname);
    const model = parseSkp(toSKP(parts, title, create));
    const got = partBoxes(model);
    assert.equal(got.length, parts.length);
    const groups = new Set(parts.map((p) => p.group));
    assert.deepEqual(new Set(model.root.instances.map((i) => i.name)), groups, 'one group per assembly');
    const pool = [...got];
    parts.forEach((p) => {
      const s = p.positions;
      const want = box(Array.from({ length: s.length / 3 }, (_, k) => [s[3 * k], -s[3 * k + 2], s[3 * k + 1]]));
      const dist = (g) => Math.max(...[0, 1, 2].flatMap((a) => [Math.abs(g.box[a][0] - want[a][0]), Math.abs(g.box[a][1] - want[a][1])]));
      const i = pool.reduce((b, g, k) => (g.name === p.name && g.group === p.group && (b < 0 || dist(g) < dist(pool[b])) ? k : b), -1);
      assert.ok(i >= 0, `no ${p.name} in the file`);
      assert.ok(dist(pool[i]) < 0.001, `${p.name} ${dist(pool[i]).toFixed(4)}" from where it belongs`);
      pool.splice(i, 1);
    });
    assert.ok(model.definitions.size < parts.length, 'parts of the same shape share a definition');
  });
}
