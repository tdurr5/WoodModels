// Unit tests for the viewer's pure helper modules. Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toFraction, toMillimeters, formatLength, boardFeet, roughThickness, roughStock,
  displayName, toCSV, escapeHtml,
} from '../viewer/format.js';
import {
  compoundAngle, describeAngle, angleBetween, dihedralFromNormals, slopeAngles, round1,
} from '../viewer/angles.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('toFraction rounds to sixteenths and reduces', () => {
  assert.equal(toFraction(12.4697), '12-1/2"');
  assert.equal(toFraction(5.6683), '5-11/16"');
  assert.equal(toFraction(0.5), '1/2"');
  assert.equal(toFraction(3), '3"');
  assert.equal(toFraction(2.999), '3"'); // rounds up across the whole number
  assert.equal(toFraction(0), '0"');
  assert.equal(toFraction(-1.25), '-1-1/4"');
});

test('toFraction honours the requested precision', () => {
  assert.equal(toFraction(1.03125, 32), '1-1/32"');
  assert.equal(toFraction(1.03125, 16), '1-1/16"'); // 1/32 rounds half-up to 1/16
  assert.equal(toFraction(1.3, 8), '1-1/4"');
});

test('metric and decimal formatting', () => {
  assert.equal(toMillimeters(1), '25.4 mm');
  assert.equal(toMillimeters(10), '254 mm');
  assert.equal(formatLength(1.5, 'dec'), '1.5"');
  assert.equal(formatLength(2, 'dec'), '2"');
  assert.equal(formatLength(1.5, 'mm'), '38.1 mm');
  assert.equal(formatLength(1.5, 'in16'), '1-1/2"');
});

test('board feet', () => {
  assert.equal(boardFeet(12, 12, 1), 1);
  assert.equal(boardFeet(96, 6, 2), 8);
});

test('rough thickness picks the next standard quarter with planing allowance', () => {
  assert.equal(roughThickness(0.75).label, '4/4');
  assert.equal(roughThickness(0.9).label, '5/4'); // 0.9 + 1/8 > 1
  assert.equal(roughThickness(1.625).label, '8/4'); // 1-5/8 finished -> 8/4 (no 7/4 stock)
  assert.equal(roughThickness(1.75).label, '8/4');
  assert.equal(roughThickness(2).label, '10/4');
  assert.equal(roughThickness(4.5), null);
});

test('rough stock adds allowances and prices the rough size', () => {
  const r = roughStock([46.375, 7.875, 1.625]);
  assert.equal(r.length, 47.375);
  assert.equal(r.width, 8.125);
  assert.equal(r.thickness, 2);
  assert.equal(r.thicknessLabel, '8/4');
  near(r.boardFeet, 47.375 * 8.125 * 2 / 144);
  const g = roughStock([10, 5, 5]);
  assert.equal(g.thicknessLabel, 'glue-up');
});

test('displayName cleans SketchUp component names', () => {
  assert.equal(displayName('Seat__2'), 'Seat');
  assert.equal(displayName('Treadle_Jaw_Upper__8'), 'Treadle Jaw Upper');
  assert.equal(displayName('Leg_Rear'), 'Leg Rear');
  assert.equal(displayName('Leg_Rear', { Leg_Rear: 'Rear leg' }), 'Rear leg');
});

test('CSV quoting and HTML escaping', () => {
  assert.equal(toCSV([['a', 'b,c'], ['1-1/2"', null]]), 'a,"b,c"\r\n"1-1/2""",\r\n');
  assert.equal(escapeHtml('<b>"x" & y</b>'), '&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;');
});

test('compoundAngle: square parts return null', () => {
  assert.equal(compoundAngle([1, 0, 0]), null);
  assert.equal(compoundAngle([0, -1, 0]), null);
  assert.equal(compoundAngle([0, 1, 0.001]), null);
});

test('compoundAngle: splayed rear leg (real data from object_dims.json)', () => {
  // Legs_Leg_Rear length axis. The horse's length runs along X, the two rear
  // legs mirror across Z, so this is 12.3 deg rake and 14.1 deg splay.
  const a = compoundAngle([0.2065, 0.948805, 0.239014]);
  assert.equal(a.reference, 'plumb');
  assert.equal(round1(a.total), 18.4);
  const byAxis = Object.fromEntries(a.components.map((c) => [c.axis, c]));
  assert.equal(round1(byAxis.x.deg), 12.3);
  assert.equal(byAxis.x.label, 'front-to-back');
  assert.equal(round1(byAxis.z.deg), 14.1);
  assert.equal(byAxis.z.label, 'side-to-side');
  assert.equal(describeAngle(a), '18.4° off plumb — 12.3° front-to-back, 14.1° side-to-side');
  near(a.sightline, Math.atan2(0.239014, 0.2065) * 180 / Math.PI);
});

test('compoundAngle: direction sign does not matter', () => {
  const a = compoundAngle([0.2, 0.95, 0.24]);
  const b = compoundAngle([-0.2, -0.95, -0.24]);
  near(a.total, b.total);
  a.components.forEach((c, i) => near(c.deg, b.components[i].deg));
});

test('compoundAngle: a part tilted off level is referenced to level, not plumb', () => {
  const t = 16.9 * Math.PI / 180;
  const a = compoundAngle([Math.cos(t), -Math.sin(t), 0]);
  assert.equal(a.reference, 'level');
  assert.equal(a.refAxis, 'x');
  assert.equal(round1(a.total), 16.9);
  assert.deepEqual(a.refVector, [1, 0, 0]);
  const vert = a.components.find((c) => c.axis === 'y');
  assert.equal(round1(Math.abs(vert.deg)), 16.9);
  assert.equal(describeAngle(a), '16.9° off level — 16.9° vertical');
});

test('compoundAngle: custom axis names', () => {
  const a = compoundAngle([0.3, 1, 0], { x: 'rake', y: 'up', z: 'splay' });
  assert.equal(a.components.find((c) => c.axis === 'x').label, 'rake');
});

test('angleBetween / dihedral / slope', () => {
  near(angleBetween([1, 0, 0], [0, 1, 0]), 90);
  near(dihedralFromNormals([1, 0, 0], [0, 1, 0]), 90); // square corner
  near(dihedralFromNormals([0, 1, 0], [0, 1, 0]), 180); // coplanar
  const s45 = Math.SQRT1_2;
  near(dihedralFromNormals([0, 1, 0], [s45, -s45, 0]), 45); // sharp 45 bevel
  const s = slopeAngles([0, 0, 0], [1, 1, 0]);
  near(s.fromLevel, 45);
  near(s.fromPlumb, 45);
  near(slopeAngles([0, 0, 0], [0, 0, 5]).fromLevel, 0);
});

// ---------- nesting ----------
import { packBoards, boardParts, boardYield, piecesByStock } from '../viewer/nesting.js';

function assertValidLayout(result, stock) {
  const kerf = stock.kerf ?? 0.125;
  for (const b of result.boards) {
    const parts = boardParts(b);
    for (const p of parts) {
      assert.ok(p.x >= -1e-9 && p.y >= -1e-9, 'part inside board origin');
      assert.ok(p.x + p.length <= b.length + 1e-9, `part ${p.id} runs off the end of the board`);
      assert.ok(p.y + p.width <= b.width + 1e-9, `part ${p.id} runs off the edge of the board`);
    }
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        const a = parts[i], c = parts[j];
        const apart = a.x + a.length + kerf <= c.x + 1e-9 || c.x + c.length + kerf <= a.x + 1e-9
          || a.y + a.width + kerf <= c.y + 1e-9 || c.y + c.width + kerf <= a.y + 1e-9;
        assert.ok(apart, `parts ${a.id} and ${c.id} overlap (or share a kerf)`);
      }
    }
  }
}

test('packBoards: one part on one board', () => {
  const r = packBoards([{ id: 'a', label: 'A', length: 30, width: 4 }], { length: 96, width: 8 });
  assert.equal(r.boards.length, 1);
  assert.deepEqual(boardParts(r.boards[0]).map((p) => [p.x, p.y]), [[0, 0]]);
});

test('packBoards: short parts share strips and sections before a new board', () => {
  const pieces = Array.from({ length: 6 }, (_, i) => ({ id: `k${i}`, label: 'Key', length: 2.875, width: 1 }));
  const r = packBoards(pieces, { length: 96, width: 8 });
  assert.equal(r.boards.length, 1);
  assert.equal(r.boards[0].sections.length, 1, 'all keys come out of one crosscut section');
  assertValidLayout(r, { kerf: 0.125 });
});

test('packBoards: fills a board before starting another', () => {
  // four 47-3/8 x 8-1/8 wouldn't fit 8" stock; use 45 x 3.5 on 96 x 8 -> 2 per section across, 2 sections
  const pieces = Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, label: 'P', length: 45, width: 3.5 }));
  const r = packBoards(pieces, { length: 96, width: 8, kerf: 0.125 });
  assert.equal(r.boards.length, 1);
  assertValidLayout(r, { kerf: 0.125 });
  const five = packBoards([...pieces, { id: 'p4', label: 'P', length: 45, width: 3.5 }], { length: 96, width: 8 });
  assert.equal(five.boards.length, 2);
});

test('packBoards: oversize parts get their own flagged board', () => {
  const r = packBoards([{ id: 'wide', label: 'W', length: 20, width: 10 }], { length: 96, width: 8 });
  assert.equal(r.boards.length, 1);
  assert.equal(r.boards[0].oversize, true);
  assert.equal(r.boards[0].width, 10);
  const long = packBoards([{ id: 'long', label: 'L', length: 120, width: 3 }], { length: 96, width: 8 });
  assert.equal(long.boards[0].length, 120);
});

test('packBoards: random cut lists never overlap or overhang', () => {
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let trial = 0; trial < 60; trial++) {
    const stock = { length: [72, 96, 120][trial % 3], width: [6, 8, 10][trial % 3], kerf: [0, 0.125, 0.25][trial % 3] };
    const pieces = Array.from({ length: 1 + Math.floor(rand() * 25) }, (_, i) => ({
      id: `t${trial}-${i}`, label: 'x',
      length: 1 + rand() * (stock.length * 1.1), width: 0.5 + rand() * stock.width * 1.1,
    }));
    const r = packBoards(pieces, stock);
    assertValidLayout(r, stock);
    assert.equal(r.boards.reduce((n, b) => n + boardParts(b).length, 0), pieces.length, 'every piece placed exactly once');
  }
});

test('boardYield and piecesByStock', () => {
  const r = packBoards([{ id: 'a', label: 'A', length: 48, width: 8 }], { length: 96, width: 8 });
  near(boardYield(r.boards[0]), 0.5);
  const rows = [
    { key: 'leg', name: 'Leg', count: 2, materialLabel: 'Wood', dims: [20, 3, 1.625] },
    { key: 'peg', name: 'Peg', count: 1, materialLabel: 'Wood', dims: [16, 3, 1] },
    { key: 'rod', name: 'Rod', count: 1, materialLabel: 'Steel', dims: [6, 0.5, 0.5] },
  ];
  const groups = piecesByStock(rows, (r) => (r.materialLabel === 'Wood' ? roughStock(r.dims) : null));
  assert.deepEqual(groups.map((g) => [g.thicknessLabel, g.pieces.length]), [['5/4', 1], ['8/4', 2]]);
  assert.equal(groups[1].pieces[0].length, 21);
});

// ---------- OBB contact tests ----------
import { obbFromDims, obbOverlap, pointInObb, partsTouch, segmentHitsObb } from '../viewer/geometry.js';

const box = (center, half, axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) => ({ center, axes, half });
// the box's 12 surface triangles as a flat vertex array
const trisOf = (b) => {
  const corner = (i) => [0, 1, 2].map((k) => b.center[k]
    + (i & 1 ? 1 : -1) * b.half[0] * b.axes[0][k] + (i & 2 ? 1 : -1) * b.half[1] * b.axes[1][k] + (i & 4 ? 1 : -1) * b.half[2] * b.axes[2][k]);
  const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  return quads.flatMap(([a, b2, c, d]) => [a, b2, c, a, c, d].flatMap(corner));
};

test('obbOverlap: separated, touching and overlapping boxes', () => {
  const a = box([0, 0, 0], [1, 1, 1]);
  assert.equal(obbOverlap(a, box([3, 0, 0], [1, 1, 1])), false);
  assert.equal(obbOverlap(a, box([2, 0, 0], [1, 1, 1])), true); // face contact
  assert.equal(obbOverlap(a, box([2.01, 0, 0], [1, 1, 1])), false);
  assert.equal(obbOverlap(a, box([2.01, 0, 0], [1, 1, 1]), 0.01), true); // within tolerance
  assert.equal(obbOverlap(a, box([0.5, 0.5, 0], [1, 1, 1])), true);
});

test('obbOverlap: rotated box near a corner (only an edge-cross axis separates)', () => {
  const s = Math.SQRT1_2;
  const a = box([0, 0, 0], [1, 1, 1]);
  // 45 deg about Z, placed diagonally just beyond the corner
  const rotated = (c) => box(c, [1, 1, 1], [[s, s, 0], [-s, s, 0], [0, 0, 1]]);
  // B's corner reaches sqrt2 + 1 = 2.414 along the diagonal from A's center;
  // at 1.8 no face axis of A separates them, only B's own (diagonal) axes do
  assert.equal(obbOverlap(a, rotated([1.8, 1.8, 0])), false);
  assert.equal(obbOverlap(a, rotated([1.6, 1.6, 0])), true);
  // edge-edge case: B tilted about X and Z so face axes alone don't separate
  const t = 0.5;
  const c = Math.cos(t), sn = Math.sin(t);
  const tilted = box([2.2, 2.2, 0], [1, 1, 1], [[c, sn, 0], [-sn * c, c * c, sn], [sn * sn, -c * sn, c]]);
  const sat = obbOverlap(a, tilted);
  // brute-force: sample points of B and check if any lie inside A
  let inside = false;
  for (let i = 0; i <= 10 && !inside; i++) for (let j = 0; j <= 10 && !inside; j++) for (let k = 0; k <= 10 && !inside; k++) {
    const u = [i / 5 - 1, j / 5 - 1, k / 5 - 1];
    const p = [0, 1, 2].map((d) => tilted.center[d] + u[0] * tilted.axes[0][d] + u[1] * tilted.axes[1][d] + u[2] * tilted.axes[2][d]);
    if (pointInObb(p, a)) inside = true;
  }
  if (inside) assert.equal(sat, true, 'SAT must not miss a real overlap');
});

test('obbFromDims and partsTouch', () => {
  const d = { center: [0, 0, 0], axes: [
    { direction: [1, 0, 0], length: 10 }, { direction: [0, 1, 0], length: 4 }, { direction: [0, 0, 1], length: 1 }] };
  const A = obbFromDims(d);
  assert.deepEqual(A.half, [5, 2, 0.5]);
  const B = obbFromDims(d, [0, 4, 0]); // edge-glued neighbour
  assert.equal(partsTouch(A, trisOf(A), B, trisOf(B)), true);
  const C = obbFromDims(d, [0, 4.5, 0]); // half an inch gap
  assert.equal(partsTouch(A, trisOf(A), C, trisOf(C)), false);
  // a 1/2" rod through the middle of the board
  const rod = box([0, 0, 0], [0.25, 0.25, 3]);
  assert.equal(partsTouch(A, trisOf(A), rod, trisOf(rod)), true);
  // rod passing near but outside the board
  const miss = box([0, 2.6, 0], [0.25, 0.25, 3]);
  assert.equal(partsTouch(A, trisOf(A), miss, trisOf(miss)), false);
  assert.equal(segmentHitsObb([-10, 0, 0], [10, 0, 0], A), true);
  assert.equal(segmentHitsObb([-10, 3, 0], [10, 3, 0], A), false);
  assert.equal(segmentHitsObb([6, 0, 0], [9, 0, 0], A), false);
  const flat = obbFromDims({ center: [0, 0, 0], axes: [{ direction: [1, 0, 0], length: 2 }, { direction: [0, 1, 0], length: 2 }] });
  assert.equal(flat.axes.length, 3);
  assert.deepEqual(flat.axes[2].map(Math.abs), [0, 0, 1]);
});

import { millingPlan } from '../viewer/format.js';

test('millingPlan groups parts by machine setting, largest first', () => {
  const plan = millingPlan([
    { name: 'Bench', count: 2, dims: [46.344, 7.902, 1.625] },
    { name: 'Leg Rear', count: 2, dims: [20.87, 3.38, 1.64] }, // also shows as 1-5/8": same planer setting
    { name: 'Peg', count: 1, dims: [16.75, 3, 1] },
    { name: 'Beam', count: 2, dims: [29.5, 3, 1.625] },
  ]);
  assert.deepEqual(plan.thickness.map((g) => [g.label, g.pieces]), [['1-5/8"', 6], ['1"', 1]]);
  assert.deepEqual(plan.thickness[0].parts.map((p) => p.name), ['Bench', 'Leg Rear', 'Beam']);
  assert.deepEqual(plan.width.map((g) => g.label), ['7-7/8"', '3-3/8"', '3"']);
  assert.equal(plan.width[2].pieces, 3); // Peg + 2 Beams rip at 3"
  assert.equal(plan.length[0].parts[0].name, 'Bench');
  // 1.645" is 1-5/8" to the nearest 1/16 but 1-21/32" to the nearest 1/32
  const two = [{ name: 'a', count: 1, dims: [1, 1, 1.625] }, { name: 'b', count: 1, dims: [1, 1, 1.645] }];
  assert.equal(millingPlan(two).thickness.length, 1);
  assert.deepEqual(millingPlan(two, (v) => formatLength(v, 'in32')).thickness.map((g) => g.label), ['1-21/32"', '1-5/8"']);
});

// ---------- zip ----------
import { unzip, zip as makeZip, crc32, isZip } from '../viewer/zip.js';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import fsNode from 'node:fs';
import pathNode from 'node:path';

test('unzip reads deflated and stored entries written by Python zipfile (like 3D Warehouse / KMZ)', async () => {
  const dir = fsNode.mkdtempSync(pathNode.join(os.tmpdir(), 'zip-'));
  const file = pathNode.join(dir, 'model.kmz');
  const dae = '<COLLADA>' + 'x'.repeat(5000) + '</COLLADA>';
  execFileSync('python3', ['-c', `
import zipfile
with zipfile.ZipFile(${JSON.stringify(file)}, 'w') as z:
    z.writestr('doc.kml', '<kml/>', compress_type=zipfile.ZIP_STORED)
    z.writestr('models/', '')
    z.writestr('models/untitled.dae', ${JSON.stringify(dae)}, compress_type=zipfile.ZIP_DEFLATED)
    z.writestr('models/untitled/texture.jpg', bytes(range(256)) * 4, compress_type=zipfile.ZIP_DEFLATED)
`]);
  const bytes = new Uint8Array(fsNode.readFileSync(file));
  assert.equal(isZip(bytes), true);
  const files = await unzip(bytes);
  assert.deepEqual([...files.keys()].sort(), ['doc.kml', 'models/untitled.dae', 'models/untitled/texture.jpg']);
  assert.equal(new TextDecoder().decode(files.get('models/untitled.dae')), dae);
  assert.equal(files.get('models/untitled/texture.jpg').length, 1024);
  fsNode.rmSync(dir, { recursive: true, force: true });
});

test('zip writes files that Python and unzip can read back', async () => {
  const z = makeZip({ 'model.json': '{"title":"Bench"}', 'data/scene.obj': 'v 1 2 3\n' });
  const back = await unzip(z);
  assert.equal(new TextDecoder().decode(back.get('model.json')), '{"title":"Bench"}');
  const dir = fsNode.mkdtempSync(pathNode.join(os.tmpdir(), 'zip-'));
  const file = pathNode.join(dir, 'out.zip');
  fsNode.writeFileSync(file, z);
  const listed = execFileSync('python3', ['-c', `import zipfile; z = zipfile.ZipFile(${JSON.stringify(file)}); assert z.testzip() is None; print(','.join(sorted(z.namelist())))`]).toString().trim();
  assert.equal(listed, 'data/scene.obj,model.json');
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926); // standard check value
  fsNode.rmSync(dir, { recursive: true, force: true });
});

test('unzip rejects non-zip data clearly', async () => {
  await assert.rejects(() => unzip(new TextEncoder().encode('<COLLADA/>'.padEnd(100))), /Not a zip file/);
});

// ---------- your edits (rename / delete / set aside) ----------
import { normalizeEdits, rowStatus, withStatus, withName, withGroupName } from '../viewer/edits.js';

test('edits: parts are in the build unless deleted or set aside; loose faces start set aside', () => {
  const e = normalizeEdits(null);
  assert.equal(rowStatus({ key: 'a' }, e), null);
  assert.equal(rowStatus({ key: 'f', flat: true }, e), 'aside');
  const d = withStatus(e, [{ key: 'a' }], 'deleted');
  assert.equal(rowStatus({ key: 'a' }, d), 'deleted');
  assert.deepEqual(e.status, {}, 'edits are immutable');
});

test('edits: putting a part back stores nothing unless it overrides a default', () => {
  let e = withStatus(normalizeEdits(null), [{ key: 'a' }, { key: 'f', flat: true }], 'aside');
  assert.deepEqual(e.status, { a: 'aside' });
  e = withStatus(e, [{ key: 'a' }, { key: 'f', flat: true }], null);
  assert.deepEqual(e.status, { f: 'build' });
  assert.equal(rowStatus({ key: 'f', flat: true }, e), null);
});

test('edits: names are trimmed and cleared by an empty name', () => {
  let e = withName(normalizeEdits(null), 'k', '  Top rail ');
  assert.equal(e.names.k, 'Top rail');
  e = withName(e, 'k', '');
  assert.deepEqual(e.names, {});
  e = withGroupName(e, 'group_7', 'Base');
  assert.deepEqual(e.groups, { group_7: 'Base' });
  assert.deepEqual(normalizeEdits({ names: [], status: 'x' }), { names: {}, groups: {}, status: {}, pieces: {}, joins: [], splits: [], explode: {}, threads: {} }, 'bad data is ignored');
});

// ---------- overlapping copies and single-piece edits ----------
import { findOverlaps } from '../viewer/geometry.js';
import { prepareRows } from '../viewer/cutlist.js';
import { withPieceStatus } from '../viewer/edits.js';

const board = (x, z, len = 68, w = 3.5, t = 1.5) => ({
  center: [x, 10, z],
  axes: [{ direction: [0, 0, 1], length: len }, { direction: [0, 1, 0], length: w }, { direction: [1, 0, 0], length: t }],
});

test('findOverlaps: a copy slid along another board is flagged with the combined length', () => {
  const o = findOverlaps({ a: board(0, 0), b: board(0, 12), side: board(5, 0), dowel: board(0, 3, 3, 0.75, 0.75) });
  assert.equal(o.length, 1);
  assert.deepEqual([o[0].a, o[0].b].sort(), ['a', 'b']);
  near(o[0].overlap, 56);
  near(o[0].span, 80);
});

test('findOverlaps: boards end to end or side by side are not overlaps', () => {
  assert.equal(findOverlaps({ a: board(0, 0), b: board(0, 68) }).length, 0);
  assert.equal(findOverlaps({ a: board(0, 0), b: board(1.5, 0) }).length, 0);
});

test('prepareRows: one deleted piece splits off its own row', () => {
  const raw = [{ label: 'Rail', top_group: 'Base', dims: [68, 3.5, 1.5], count: 3, materials: [], obj_names: ['r1', 'r2', 'r3'], dims_str: '68 x 3-1/2 x 1-1/2' }];
  const rows = prepareRows(raw, { materials: {} }, withPieceStatus(null, ['r2'], 'deleted'));
  const main = rows.find((r) => !r.status), gone = rows.find((r) => r.status === 'deleted');
  assert.equal(main.count, 2);
  assert.deepEqual(main.obj_names, ['r1', 'r3']);
  assert.equal(main.key, 'Rail|68x3.5x1.5');
  assert.equal(gone.count, 1);
  assert.deepEqual(gone.obj_names, ['r2']);
  assert.notEqual(gone.key, main.key);
  assert.equal(gone.letter, '');
});

import { applyJoins } from '../viewer/geometry.js';
import { withJoin, withoutJoins } from '../viewer/edits.js';

test('applyJoins: two overlapping boards become one piece measured end to end', () => {
  const dims = { a: board(0, 0), b: board(0, 12), c: board(5, 0) };
  const raw = [{ label: 'Rail', top_group: 'Base', dims: [68, 3.5, 1.5], count: 3, materials: ['Oak'], obj_names: ['a', 'b', 'c'], dims_str: 'x' }];
  const { rows, dims: out } = applyJoins(raw, withJoin(null, ['a', 'b']).joins, dims, (x) => `${x}"`);
  const single = rows.find((r) => !r.joined), joined = rows.find((r) => r.joined);
  assert.deepEqual(single.obj_names, ['c']);
  assert.equal(single.count, 1);
  assert.deepEqual(joined.dims, [80, 3.5, 1.5]);
  assert.deepEqual(joined.pieces, [['a', 'b']]);
  assert.equal(joined.dims_str, '80" x 3.5" x 1.5"');
  near(out['a+b'].axes[0].length, 80);
  near(out['a+b'].center[2], 6); // midway between -34 and 46
});

test('joins: joining again replaces, splitting removes; stale joins are ignored', () => {
  let e = withJoin(null, ['a', 'b']);
  e = withJoin(e, ['b', 'c']);
  assert.deepEqual(e.joins, [['b', 'c']]);
  assert.deepEqual(withoutJoins(e, ['c']).joins, []);
  const raw = [{ label: 'Rail', dims: [68, 3.5, 1.5], count: 1, obj_names: ['a'] }];
  assert.equal(applyJoins(raw, [['a', 'gone']], { a: board(0, 0) }).rows, raw);
});

import { withAutoFixes, withSplit } from '../viewer/edits.js';

test('automatic fixes apply unless you undid them or changed the same pieces', () => {
  const auto = { joins: [['a', 'b'], ['c', 'd']], dupes: ['x', 'y'] };
  let e = withAutoFixes(null, auto);
  assert.deepEqual(e.joins, [['a', 'b'], ['c', 'd']]);
  assert.equal(e.pieces.x, 'deleted');
  assert.deepEqual([...e.autoJoins].sort(), ['a+b', 'c+d']);
  const mine = withPieceStatus(withSplit(null, [['b', 'a']]), ['x', 'c'], null); // split a+b; keep x; keep c
  e = withAutoFixes(mine, auto);
  assert.deepEqual(e.joins, []);
  assert.equal(e.pieces.x, 'build');
  assert.deepEqual([...e.autoDeleted], ['y']);
});

import { speciesFor } from '../viewer/woodtex.js';

test('wood species are recognised from material names', () => {
  assert.equal(speciesFor('Mélèse_Verticale1'), 'larch');
  assert.equal(speciesFor('Oak_-Red'), 'red-oak');
  assert.equal(speciesFor('Red_Oak'), 'red-oak');
  assert.equal(speciesFor('White Oak'), 'white-oak');
  assert.equal(speciesFor('qcg_7587_zm_mexican_walnut_copy'), 'walnut');
  assert.equal(speciesFor('', 'Wood_Cherry_Original'), 'cherry');
  assert.equal(speciesFor('Wood'), null);
  assert.equal(speciesFor('Pineapple'), null, 'whole words only');
});

import { buildOrder } from '../viewer/build.js';

test('build order: assemblies from the ground up, wood before hardware, big parts first', () => {
  const rows = [
    { key: 'top', top_group: 'Top', category: 'Wood' },
    { key: 'bolt', top_group: 'Base', category: 'Hardware' },
    { key: 'leg', top_group: 'Base', category: 'Wood' },
    { key: 'foot', top_group: 'Base', category: 'Wood' },
    { key: 'stretcher', top_group: 'Base', category: 'Wood' },
  ];
  const boxes = { top: [30, 100], bolt: [5, 1], leg: [0, 50], foot: [0, 80], stretcher: [6, 20] };
  const order = buildOrder(rows, (r) => ({ minY: boxes[r.key][0], volume: boxes[r.key][1] })).map((r) => r.key);
  assert.deepEqual(order, ['foot', 'leg', 'stretcher', 'bolt', 'top']);
});

test('cutting order: wood by species and stock thickness, widest first, then the rest', () => {
  const rows = [
    { key: 'w-thin', category: 'Wood', materialLabel: 'Walnut', dims: [20, 4, 0.75], top_group: 'A' },
    { key: 'o-thick', category: 'Wood', materialLabel: 'Oak', dims: [30, 3, 1.75], top_group: 'A' },
    { key: 'o-thin-wide', category: 'Wood', materialLabel: 'Oak', dims: [30, 6, 0.75], top_group: 'B' },
    { key: 'o-thin', category: 'Wood', materialLabel: 'Oak', dims: [40, 2, 0.75], top_group: 'B' },
    { key: 'bolt', category: 'Hardware', materialLabel: 'Steel', dims: [5, 0.5, 0.5], top_group: 'A' },
  ];
  assert.deepEqual(buildOrder(rows, () => ({ minY: 0, volume: 1 }), 'cutting').map((r) => r.key), ['o-thin-wide', 'o-thin', 'o-thick', 'w-thin', 'bolt']);
});

import { looksLikeSheetGoods } from '../viewer/format.js';
import { sheetLayouts } from '../viewer/cutlist.js';

test('sheet goods are recognised from material or part names', () => {
  assert.ok(looksLikeSheetGoods('Plywood_Birch'));
  assert.ok(looksLikeSheetGoods('__auto_', '', 'Shelf__1_8__Masonite'));
  assert.ok(looksLikeSheetGoods('MDF'));
  assert.ok(looksLikeSheetGoods('Baltic Birch'));
  assert.ok(!looksLikeSheetGoods('Red_Oak', 'Top board'));
  assert.ok(!looksLikeSheetGoods('Supply cabinet'), 'whole words only');
});

test('sheet goods are laid out on 4x8 sheets per material and thickness', () => {
  const rows = prepareRows([
    { label: 'Side', top_group: 'Case', dims: [30, 20, 0.75], count: 2, materials: ['Plywood'], obj_names: [], dims_str: 'x' },
    { label: 'Back', top_group: 'Case', dims: [30, 40, 0.25], count: 1, materials: ['Plywood'], obj_names: [], dims_str: 'x' },
    { label: 'Leg', top_group: 'Base', dims: [30, 2, 2], count: 4, materials: ['Oak'], obj_names: [], dims_str: 'x' },
  ], { materials: { Plywood: { category: 'Wood' }, Oak: { category: 'Wood' } } });
  assert.deepEqual(rows.map((r) => r.category).sort(), ['Sheet goods', 'Sheet goods', 'Wood']);
  const layouts = sheetLayouts(rows, { length: 96, width: 48, kerf: 0.125 });
  assert.deepEqual(layouts.map((g) => [g.material, g.thicknessLabel, g.sheets.length, g.pieces.length]), [['Plywood', '1/4"', 1, 1], ['Plywood', '3/4"', 1, 2]]);
});

import { defaultMaterialLabel } from '../viewer/library.js';

test('uploaded wood materials are named after their species, so texture variants total up', () => {
  const wood = { category: 'Wood' };
  assert.equal(defaultMaterialLabel('Mélèse_Horizontal1_1', wood), 'Larch');
  assert.equal(defaultMaterialLabel('Mélèse_Verticale1', wood), 'Larch');
  assert.equal(defaultMaterialLabel('Oak_-Red', wood), 'Red oak');
  assert.equal(defaultMaterialLabel('Red_Oak', wood), 'Red oak');
  assert.equal(defaultMaterialLabel('qcg_7587_zm_mexican_walnut_copy_2', wood), 'Walnut');
  // not a species we know, or not wood: just tidied
  assert.equal(defaultMaterialLabel('Wood_Board_Dark_1', wood), 'Wood Board Dark');
  assert.equal(defaultMaterialLabel('Walnut_Stain_Handle', { category: 'Hardware' }), 'Walnut Stain Handle');
});

import { endJoints, obbFromDims as obbOf } from '../viewer/geometry.js';

// an axis-aligned box as object_dims + triangle vertices (corners are enough)
function jbox(center, size) {
  const [x, y, z] = center, [sx, sy, sz] = size;
  const order = [0, 1, 2].sort((a, b) => size[b] - size[a]); // length, width, thickness
  const unit = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const dims = { center, axes: order.map((i, k) => ({ direction: unit[i], length: size[i], role: ['Length', 'Width', 'Thickness'][k] })) };
  const tris = [];
  for (const dx of [-1, 1]) for (const dy of [-1, 1]) for (const dz of [-1, 1]) tris.push(x + dx * sx / 2, y + dy * sy / 2, z + dz * sz / 2);
  return { dims, tris };
}
// a rail with narrower tenons on each end: body plus tenon vertices
function tenonedRail(center, bodyLen, tenonLen, size, tenon) {
  const body = jbox(center, [bodyLen, size[0], size[1]]);
  const tris = [...body.tris];
  for (const s of [-1, 1]) {
    const t = jbox([center[0] + s * (bodyLen / 2 + tenonLen / 2), center[1], center[2]], [tenonLen, tenon[0], tenon[1]]);
    tris.push(...t.tris);
  }
  const all = jbox(center, [bodyLen + 2 * tenonLen, size[0], size[1]]);
  return { dims: all.dims, tris };
}

test('a rail drawn with its tenons in the legs: tenon size, depth, shoulder to shoulder', () => {
  // legs 2" square, 30" tall, 20" apart (centres); rail 3" wide, 1" thick, tenons 1-1/4" long, 1/2" x 2"
  const legA = jbox([-10, 0, 0], [2, 2, 30]), legB = jbox([10, 0, 0], [2, 2, 30]);
  const rail = tenonedRail([0, 0, 10], 18, 1.25, [1, 3], [0.5, 2]);
  const others = [{ name: 'A', box: obbOf(legA.dims) }, { name: 'B', box: obbOf(legB.dims) }];
  const j = endJoints(obbOf(rail.dims), rail.tris, others);
  assert.equal(j.length, 2);
  j.forEach((x) => {
    assert.equal(x.kind, 'tenon');
    assert.ok(Math.abs(x.depth - 1.25) < 1e-6, `depth ${x.depth}`);
    assert.deepEqual([x.thick, x.width].map((v) => Math.round(v * 100) / 100).sort(), [0.5, 2]);
    assert.equal(x.through, false);
  });
  assert.deepEqual(j.map((x) => x.name).sort(), ['A', 'B']);
});

test('through tenons, housed ends and butt joints are told apart', () => {
  const leg = jbox([10, 0, 0], [2, 2, 30]);
  const others = [{ name: 'leg', box: obbOf(leg.dims) }];
  // a full-size end passing right through the leg: housed, through
  const through = jbox([0, 0, 5], [22, 1, 3]); // runs x = -11..11, leg x = 9..11
  const t = endJoints(obbOf(through.dims), through.tris, others).find((x) => x.end === 1);
  assert.equal(t.kind, 'housed');
  assert.equal(t.through, true);
  assert.ok(Math.abs(t.depth - 2) < 1e-6);
  // stopping at the leg's face: a butt joint
  const butt = jbox([0, 0, 5], [18, 1, 3]); // x = -9..9
  assert.equal(endJoints(obbOf(butt.dims), butt.tris, others).find((x) => x.end === 1)?.kind, 'butt');
});

test('a through tenon left standing proud of the far face is still found', () => {
  const leg = jbox([10, 0, 0], [2, 2, 30]); // x 9..11
  // rail body to the leg's face (x 9), tenon 1/2" x 2" on to x 11.25: 1/4" proud
  const body = jbox([0, 0, 5], [18, 1, 3]);
  const tenon = jbox([10.125, 0, 5], [2.25, 0.5, 2]);
  const all = jbox([1.125, 0, 5], [20.25, 1, 3]);
  const j = endJoints(obbOf(all.dims), [...body.tris, ...tenon.tris], [{ name: 'leg', box: obbOf(leg.dims) }]).find((x) => x.end === 1);
  assert.equal(j?.kind, 'tenon');
  assert.equal(j.through, true);
  assert.ok(Math.abs(j.depth - 2.25) < 1e-6 && Math.abs(j.proud - 0.25) < 1e-6, `depth ${j.depth}, proud ${j.proud}`);
});

test('a board crossing another or sitting on it is not a tenon', () => {
  // treadle beam over a peg: the beam is wider than the peg it crosses
  const peg = jbox([0, 0, 0], [1, 3, 16]);
  const beam = jbox([14, 0, 0], [30, 3, 1.6]); // end at x = -1, inside the peg's box
  assert.deepEqual(endJoints(obbOf(beam.dims), beam.tris, [{ name: 'peg', box: obbOf(peg.dims) }]).filter((x) => x.kind !== 'butt'), []);
  // a part drawn inside another (a copy): not a joint
  const big = jbox([0, 0, 0], [20, 4, 2]), small = jbox([0, 0, 0], [18, 3, 1]);
  assert.deepEqual(endJoints(obbOf(small.dims), small.tris, [{ name: 'big', box: obbOf(big.dims) }]), []);
});

import { dimensionalSize } from '../viewer/format.js';

test('dimensional lumber is recognised by its actual size', () => {
  assert.equal(dimensionalSize(1.5, 3.5), '2×4');
  assert.equal(dimensionalSize(0.75, 5.5), '1×6');
  assert.equal(dimensionalSize(3.5, 3.5), '4×4');
  assert.equal(dimensionalSize(1.5, 11.25), '2×12');
  assert.equal(dimensionalSize(1.52, 3.49), '2×4'); // modeling slop
  assert.equal(dimensionalSize(1.625, 3.5), null); // 1-5/8": milled hardwood
  assert.equal(dimensionalSize(0.75, 4), null);
});

import { packWithOwned } from '../viewer/nesting.js';

test('boards you own are used first; only the rest is bought', () => {
  const pieces = [
    { id: 'a', length: 30, width: 5 }, { id: 'b', length: 30, width: 5 },
    { id: 'c', length: 60, width: 7 }, { id: 'd', length: 20, width: 3 },
  ];
  const stock = { length: 96, width: 8, kerf: 0.125 };
  // one 5' x 6" board on the rack: takes the two 30" x 5" parts, not the 7" wide one
  const r = packWithOwned(pieces, [{ length: 64, width: 6, label: 'rack' }], stock);
  assert.equal(r.owned.length, 1);
  assert.equal(r.owned[0].owned, true);
  assert.deepEqual(boardParts(r.owned[0]).map((p) => p.id).sort(), ['a', 'b']);
  assert.deepEqual(r.boards.flatMap(boardParts).map((p) => p.id).sort(), ['c', 'd']);
  // enough owned boards: nothing to buy
  const all = packWithOwned(pieces, [{ length: 96, width: 12 }, { length: 96, width: 12 }], stock);
  assert.equal(all.boards.length, 0);
  assert.equal(all.owned.flatMap(boardParts).length, 4);
  // an owned board nothing fits on isn't used
  assert.equal(packWithOwned(pieces, [{ length: 10, width: 2 }], stock).owned.length, 0);
});

import { withAssemblySteps } from '../viewer/build.js';

test('assembly order gets an assemble step after each sub-assembly with several wood parts', () => {
  const row = (key, g, category = 'Wood', count = 1) => ({ key, top_group: g, groupName: g, category, count, dims: [10, 3, 1] });
  const order = [row('a', 'Legs', 'Wood', 4), row('b', 'Legs', 'Hardware', 8), row('c', 'Top'), row('d', 'Base'), row('e', 'Base')];
  const steps = withAssemblySteps(order);
  assert.deepEqual(steps.map((s) => s.key), ['a', 'b', 'assemble:Legs', 'c', 'd', 'e', 'assemble:Base']);
  const legs = steps.find((s) => s.key === 'assemble:Legs');
  assert.equal(legs.assemble, true);
  assert.deepEqual(legs.rows.map((r) => r.key), ['a', 'b']);
});

import { reachableUrl, qrSvg } from '../viewer/share.js';

test('a QR code is offered only for pages a phone can open', () => {
  const at = (href) => { const u = new URL(href); return { protocol: u.protocol, hostname: u.hostname, origin: u.origin, pathname: u.pathname, search: u.search }; };
  assert.equal(reachableUrl(at('https://tdurr5.github.io/WoodModels/?model=models/bench/')), 'https://tdurr5.github.io/WoodModels/?model=models/bench/');
  assert.equal(reachableUrl(at('http://localhost:8743/')), null);
  assert.equal(reachableUrl(at('http://127.0.0.1:8743/')), null);
  assert.equal(reachableUrl(at('file:///home/me/viewer/index.html')), null);
  const svg = qrSvg('https://tdurr5.github.io/WoodModels/');
  assert.match(svg, /^<svg[\s\S]*<path d="M/);
});

import { ownedFor } from '../viewer/inventory.js';

test('My boards: quantity 0 means none left; species and thickness must match', () => {
  const list = [
    { material: 'Walnut', thickness: '8/4', width: 7, length: 72, count: 2 },
    { material: '', thickness: '8/4', width: 5, length: 60 }, // any species, one board (no count)
    { material: 'Walnut', thickness: '8/4', width: 9, length: 96, count: 0 }, // used up
    { material: 'Walnut', thickness: '4/4', width: 9, length: 96, count: 3 },
  ];
  assert.equal(ownedFor(list, 'walnut', '8/4').length, 3);
  assert.equal(ownedFor(list, 'Cherry', '8/4').length, 1);
  assert.equal(ownedFor(list, 'Walnut', '4/4').length, 3);
});

import { glueUpStrips } from '../viewer/nesting.js';

test('a part much wider than your boards is laid out as glue-up strips', () => {
  assert.equal(glueUpStrips(8.125, 8), null); // just over: buy a wider board
  assert.equal(glueUpStrips(9.5, 8), null);
  const g = glueUpStrips(20.25, 8); // a table top on 8" stock
  assert.equal(g.n, 3);
  assert.ok(g.width <= 8 && Math.abs(g.width - (20.25 / 3 + 0.25)) < 1e-9);
  const rows = [{ key: 'top', name: 'Top', letter: 'A', count: 2, materialLabel: 'Oak', dims: [40, 20, 0.75] }];
  const [grp] = piecesByStock(rows, (r) => roughStock(r.dims), { maxWidth: 8 });
  assert.equal(grp.pieces.length, 6); // 3 strips x 2 tops
  assert.match(grp.pieces[0].label, /A Top \(strip 1\/3\)/);
  const packed = packBoards(grp.pieces, { length: 96, width: 8 });
  assert.ok(packed.boards.every((b) => !b.oversize), 'strips fit ordinary boards');
});

import * as THREE3 from 'three';
import { smoothNormals, gridSpacing, materialKind } from '../viewer/look.js';

// a cylinder's side and caps as separate flat triangles, the way OBJLoader
// hands them over (no shared vertices)
function flatCylinder(n = 24, backToBack = false) {
  const pts = [];
  const ring = (k, y) => [Math.cos((2 * Math.PI * k) / n), y, Math.sin((2 * Math.PI * k) / n)];
  for (let k = 0; k < n; k++) {
    const a0 = ring(k, 0), a1 = ring(k + 1, 0), b0 = ring(k, 1), b1 = ring(k + 1, 1);
    pts.push(a0, b0, a1, a1, b0, b1); // side, outward
    pts.push([0, 1, 0], b1, b0); // top cap
  }
  if (backToBack) for (let i = pts.length - 3; i >= 0; i -= 3) pts.push(pts[i], pts[i + 2], pts[i + 1]);
  const g = new THREE3.BufferGeometry();
  g.setAttribute('position', new THREE3.Float32BufferAttribute(pts.flat(), 3));
  return g;
}

test('round parts shade smooth, square edges stay crisp', () => {
  const g = smoothNormals(flatCylinder(24));
  const pos = g.attributes.position, nrm = g.attributes.normal;
  const p = new THREE3.Vector3(), nv = new THREE3.Vector3();
  let sideChecked = 0, capChecked = 0;
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i); nv.fromBufferAttribute(nrm, i);
    const onSide = i % 9 < 6;
    if (onSide) {
      // side corners point straight out from the axis, like a real cylinder
      const radial = new THREE3.Vector3(p.x, 0, p.z).normalize();
      near(nv.dot(radial), 1, 1e-3);
      sideChecked++;
    } else {
      near(nv.y, 1, 1e-6); // the cap stays flat: 90° from the side is a crease
      capChecked++;
    }
  }
  assert.ok(sideChecked > 0 && capChecked > 0);
});

test('smooth shading never mixes the two sides of a back-to-back face', () => {
  const g = smoothNormals(flatCylinder(24, true));
  const nrm = g.attributes.normal;
  // the reversed copies are added last-first: triangle 0's twin is the last
  // one, starting at the same corner
  const front = new THREE3.Vector3().fromBufferAttribute(nrm, 0);
  const back = new THREE3.Vector3().fromBufferAttribute(nrm, nrm.count - 3);
  assert.equal(g.attributes.position.getX(0), g.attributes.position.getX(nrm.count - 3));
  assert.ok(front.dot(back) < -0.99, `front ${front.toArray()} vs back ${back.toArray()}`);
});

test('a box keeps its flat faces', () => {
  const g = new THREE3.BoxGeometry(3, 1, 10).toNonIndexed();
  g.deleteAttribute('normal');
  smoothNormals(g);
  const nrm = g.attributes.normal;
  for (let i = 0; i < nrm.count; i++) {
    const v = new THREE3.Vector3().fromBufferAttribute(nrm, i);
    near(Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)), 1, 1e-6);
  }
});

test('the ground grid is scaled to the model', () => {
  assert.deepEqual(gridSpacing(6), [0.25, 4]); // a keepsake box: quarter inches
  assert.deepEqual(gridSpacing(40), [1, 12]); // a table: inches and feet
  assert.deepEqual(gridSpacing(240), [6, 8]); // a shed: 6" and 4'
  assert.ok(gridSpacing(5000)[0] >= 12);
});

test('non-wood materials are recognised from their names', () => {
  assert.equal(materialKind('Hardware', 'Steel'), 'metal');
  assert.equal(materialKind('Other', 'Brass'), 'brass');
  assert.equal(materialKind('Other', 'Paint_Green'), 'paint');
  assert.equal(materialKind('Other', 'Verre'), 'glass');
  assert.equal(materialKind('Leather', 'Strap'), 'leather');
  assert.equal(materialKind('Hardware', '_____Metal'), 'metal');
  assert.equal(materialKind('Hardware', 'Thing'), 'metal'); // hardware defaults to steel
  assert.equal(materialKind('Other', 'Material12'), 'plain');
  assert.equal(materialKind('Other', 'Doré'), 'brass'); // French gilt
  assert.equal(materialKind('Other', 'Top or bottom'), 'plain'); // "or" is just a word
  assert.equal(materialKind('Other', 'Coral'), 'plain');
});

import { applySetup } from '../viewer/library.js';
import { looksLikeWood } from '../viewer/woodtex.js';

test('a material keeps its own photo when Set up moves it in or out of Wood', () => {
  const cfg = { title: 'T', materials: { Material12: { category: 'Other', color: '#999999', photo: 'p.jpg' }, Oak: { category: 'Wood', color: '#c9975c', texture: { base: '#c9975c', image: 'oak.jpg' } } } };
  const out = applySetup(cfg, { categories: { Material12: 'Wood', Oak: 'Other' } });
  assert.equal(out.materials.Material12.texture.image, 'p.jpg');
  assert.equal(out.materials.Material12.photo, undefined);
  assert.equal(out.materials.Oak.texture, undefined);
  assert.equal(out.materials.Oak.photo, 'oak.jpg');
  const back = applySetup(out, { categories: { Material12: 'Other', Oak: 'Wood' } });
  assert.equal(back.materials.Material12.photo, 'p.jpg');
  assert.equal(back.materials.Oak.texture.image, 'oak.jpg');
});

test('a photo is taken for wood when it is streaky and wood-coloured', () => {
  assert.equal(looksLikeWood(100, 40, '#a0703f'), true); // brown, grain one way
  assert.equal(looksLikeWood(100, 90, '#a0703f'), false); // brown but no grain (leather, cork)
  assert.equal(looksLikeWood(100, 40, '#3050a0'), false); // striped blue fabric
  assert.equal(looksLikeWood(100, 40, '#808080'), false); // brushed steel
  assert.equal(looksLikeWood(40, 100, '#5a3d28'), true); // walnut, grain the other way
});

import { orientFaces, isBackToBack } from '../viewer/look.js';

// signed volume of a closed triangle soup (positive: faces point out)
function volumeOf(g) {
  const p = g.attributes.position, a = new THREE3.Vector3(), b = new THREE3.Vector3(), c = new THREE3.Vector3();
  let v = 0;
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    v += a.dot(b.cross(c)) / 6;
  }
  return v;
}

test('faces drawn inside-out are turned to face out', () => {
  const g = new THREE3.BoxGeometry(2, 3, 4).toNonIndexed();
  g.translate(500, -300, 40); // far from the origin, like many SketchUp models
  const pos = g.attributes.position;
  // flip every third triangle, and the whole thing once more for good measure
  for (let t = 0; t < pos.count / 3; t += 3) {
    for (let c = 0; c < 3; c++) {
      const v = pos.getComponent(t * 3 + 1, c);
      pos.setComponent(t * 3 + 1, c, pos.getComponent(t * 3 + 2, c));
      pos.setComponent(t * 3 + 2, c, v);
    }
  }
  assert.equal(orientFaces(g), true);
  near(volumeOf(g), 24, 1e-3);
  // and every face agrees: turning the whole box inside out gives -24
  const inside = g.clone();
  const ip = inside.attributes.position;
  for (let t = 0; t < ip.count / 3; t++) {
    for (let c = 0; c < 3; c++) {
      const v = ip.getComponent(t * 3 + 1, c);
      ip.setComponent(t * 3 + 1, c, ip.getComponent(t * 3 + 2, c));
      ip.setComponent(t * 3 + 2, c, v);
    }
  }
  near(volumeOf(inside), -24, 1e-3);
  orientFaces(inside);
  near(volumeOf(inside), 24, 1e-3);
});

test("SketchUp's back-to-back faces are left alone", () => {
  const g = flatCylinder(24, true);
  const before = g.attributes.position.array.slice();
  assert.equal(isBackToBack(g), true);
  assert.equal(orientFaces(g), false);
  assert.deepEqual([...g.attributes.position.array], [...before]);
  assert.equal(isBackToBack(flatCylinder(24, false)), false);
});

import { featureEdges } from '../viewer/look.js';

test('outlines: a board has its 12 edges, not the diagonals across its faces', () => {
  const g = new THREE3.BoxGeometry(0.75, 3.5, 30).toNonIndexed();
  assert.equal(featureEdges(g).length / 6, 12);
  // SketchUp's back-to-back copy of every face changes nothing
  const both = new THREE3.BufferGeometry();
  const p = g.attributes.position.array, rev = [];
  for (let i = 0; i < p.length; i += 9) rev.push(p[i], p[i + 1], p[i + 2], p[i + 6], p[i + 7], p[i + 8], p[i + 3], p[i + 4], p[i + 5]);
  both.setAttribute('position', new THREE3.Float32BufferAttribute([...p, ...rev], 3));
  assert.equal(featureEdges(both).length / 6, 12);
});

test("outlines: a dowel shows its end's rim, not the seams between its facets", () => {
  // side + top cap only; the open bottom rim counts as an edge too
  assert.equal(featureEdges(flatCylinder(24)).length / 6, 48);
  assert.equal(featureEdges(flatCylinder(24, true)).length / 6, 48);
});

test('outlines: a carving gets none rather than a scribble of lines', () => {
  const g = new THREE3.SphereGeometry(2, 64, 48);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const s = 1 + 0.08 * Math.sin(p.getX(i) * 9) * Math.cos(p.getY(i) * 7) + 0.05 * Math.sin(p.getZ(i) * 13);
    p.setXYZ(i, p.getX(i) * s, p.getY(i) * s, p.getZ(i) * s);
  }
  assert.equal(featureEdges(g.toNonIndexed()).length, 0);
  // while a board keeps real coordinates for its lines
  const board = featureEdges(new THREE3.BoxGeometry(1, 2, 3).toNonIndexed());
  assert.ok([...board].some((v) => Math.abs(v) === 1.5));
});

import { paletteFromColor, STOCK_TEXTURE } from '../viewer/woodtex.js';

test("wood with the stock palette is drawn in the model's own colour", () => {
  const stock = { ...STOCK_TEXTURE, tile: 5 };
  const dark = paletteFromColor(stock, '#4d3020');
  assert.equal(dark.base, '#4d3020');
  assert.ok(parseInt(dark.ring.slice(1, 3), 16) < 0x4d, 'latewood darker');
  assert.equal(dark.tile, 5);
  // a palette someone set stays; so does one with no colour to go on
  const tuned = { base: '#5b3a24', streak: '#3d2515', ring: '#2c1a0e' };
  assert.equal(paletteFromColor(tuned, '#ffffff'), tuned);
  assert.equal(paletteFromColor(stock, undefined), stock);
  // dozens of browns share a few textures: past the limit, the nearest one issued
  const near = paletteFromColor(stock, '#4e3121', 1);
  assert.equal(near.base, '#4d3020');
});

// A closed prism: cap triangles (2D, [[x,y]x3]...) and the outline's walls,
// extruded from z = 0 to z = h. perm reorders (x,y,z) for other orientations.
function prism(caps, outlines, h, perm = [0, 1, 2]) {
  const out = [];
  const put = (p) => out.push(...perm.map((k) => p[k]));
  caps.forEach(([a, b, c]) => { [a, c, b].forEach(([x, y]) => put([x, y, 0])); [a, b, c].forEach(([x, y]) => put([x, y, h])); });
  outlines.forEach((poly) => poly.forEach((p, i) => {
    const q = poly[(i + 1) % poly.length];
    [[p, 0], [q, 0], [q, h], [p, 0], [q, h], [p, h]].forEach(([[x, y], z]) => put([x, y, z]));
  }));
  return out;
}
const rect = (x0, y0, x1, y1) => [[[x0, y0], [x1, y0], [x1, y1]], [[x0, y0], [x1, y1], [x0, y1]]];
// part frame: Length, Width, Thickness along x, y, z from the origin
const boxOf = (size) => ({ center: size.map((s) => s / 2), axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], half: size.map((s) => s / 2) });

test('cuts: a notch in an edge, through the thickness', async () => {
  const { cutFeatures } = await import('../viewer/features.js');
  // 10 x 3 x 1 board, a 2" wide, 1" deep notch in one edge at 4" from the end
  const caps = [...rect(0, 0, 10, 2), ...rect(0, 2, 4, 3), ...rect(6, 2, 10, 3)];
  const outline = [[0, 0], [10, 0], [10, 3], [6, 3], [6, 2], [4, 2], [4, 3], [0, 3]];
  const cuts = cutFeatures(boxOf([10, 3, 1]), prism(caps, [outline], 1));
  assert.equal(cuts.length, 1);
  assert.equal(cuts[0].kind, 'notch');
  assert.equal(cuts[0].through, true);
  assert.equal(cuts[0].surface, 'face');
  near(cuts[0].box[0][0], 4, 0.07);
  near(cuts[0].size[0], 2, 0.07);
  near(cuts[0].size[1], 1, 0.07);
});

test('cuts: a round hole, and a blind one', async () => {
  const { cutFeatures } = await import('../viewer/features.js');
  // 4 x 4 x 1 block with a 1" hole through the middle
  const n = 32, ring = (r) => Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2 + Math.PI / 4;
    const d = r === 'sq' ? 2 / Math.max(Math.abs(Math.cos(t)), Math.abs(Math.sin(t))) : r;
    return [2 + d * Math.cos(t), 2 + d * Math.sin(t)];
  });
  const inner = ring(0.5), outer = ring('sq');
  const caps = inner.flatMap((p, i) => { const j = (i + 1) % n; return [[p, outer[i], outer[j]], [p, outer[j], inner[j]]]; });
  const block = prism(caps, [outer, [...inner].reverse()], 1);
  let cuts = cutFeatures(boxOf([4, 4, 1]), block);
  assert.equal(cuts.length, 1);
  assert.equal(cuts[0].kind, 'hole');
  assert.equal(cuts[0].through, true);
  near(cuts[0].dia, 1, 0.04);
  // the same hole stopping 1/4" short of the far face: 3/4" deep
  const top = caps.map((t) => t.map(([x, y]) => [x, y, 1]));
  const tri3 = (tris, z, flip) => tris.flatMap(([a, b, c]) => (flip ? [a, c, b] : [a, b, c]).flatMap(([x, y]) => [x, y, z]));
  const walls = (poly, z0, z1) => poly.flatMap((p, i) => {
    const q = poly[(i + 1) % poly.length];
    return [[p, z0], [q, z0], [q, z1], [p, z0], [q, z1], [p, z1]].flatMap(([[x, y], z]) => [x, y, z]);
  });
  const bottom = rect(0, 0, 4, 4), holeFloor = inner.slice(1, -1).map((p, i) => [inner[0], p, inner[i + 2]]);
  const blind = [
    ...top.flatMap((t) => t.flat()), ...tri3(bottom, 0, true), ...tri3(holeFloor, 0.25, false),
    ...walls(outer, 0, 1), ...walls([...inner].reverse(), 0.25, 1),
  ];
  cuts = cutFeatures(boxOf([4, 4, 1]), blind);
  assert.equal(cuts.length, 1);
  assert.equal(cuts[0].kind, 'hole');
  assert.equal(cuts[0].through, false);
  near(cuts[0].depth, 0.75, 0.01);
  near(cuts[0].dia, 1, 0.04);
});

test('cuts: none in a plain board, a dowel, or a tenon the model draws', async () => {
  const { cutFeatures } = await import('../viewer/features.js');
  assert.deepEqual(cutFeatures(boxOf([10, 3, 1]), prism(rect(0, 0, 10, 3), [[[0, 0], [10, 0], [10, 3], [0, 3]]], 1)), []);
  // a 1" dowel 10" long along x: a 24-sided profile in (y, z) extruded along x
  const n = 24, circle = Array.from({ length: n }, (_, i) => [0.5 + 0.5 * Math.cos((i / n) * Math.PI * 2), 0.5 + 0.5 * Math.sin((i / n) * Math.PI * 2)]);
  const fan = circle.slice(1, -1).map((p, i) => [circle[0], p, circle[i + 2]]);
  assert.deepEqual(cutFeatures(boxOf([10, 1, 1]), prism(fan, [circle], 10, [2, 0, 1])), []);
  // a rail with a 1" tenon on one end: its shoulders look like notches...
  const caps = [...rect(0, 0, 10, 3), ...rect(10, 1, 11, 2)];
  const outline = [[0, 0], [10, 0], [10, 1], [11, 1], [11, 2], [10, 2], [10, 3], [0, 3]];
  const rail = prism(caps, [outline], 1);
  assert.equal(cutFeatures(boxOf([11, 3, 1]), rail).length, 2);
  // ...but not once it's known to be a tenon
  assert.deepEqual(cutFeatures(boxOf([11, 3, 1]), rail, { ends: [0, 1] }), []);
});

import { surfaceMaterial } from '../viewer/look.js';

test('the metal decides its colour: brass is yellow, steel grey, whatever the model painted', () => {
  const hue = (m) => m.color.getHSL({}).h, sat = (m) => m.color.getHSL({}).s;
  const brassOnGrey = surfaceMaterial('brass', new THREE3.Color(0.5, 0.5, 0.5));
  assert.ok(sat(brassOnGrey) > 0.3 && hue(brassOnGrey) > 0.08 && hue(brassOnGrey) < 0.17, 'brass stays brass on a grey material');
  const steelOnTan = surfaceMaterial('metal', new THREE3.Color(0.7, 0.55, 0.35)); // the parser's stand-in tan
  assert.ok(sat(steelOnTan) < 0.01, 'steel stays grey on a tan material');
});

import { normalizeEdits as normEdits, withExplodeOffset } from '../viewer/edits.js';

test('pieces moved in the exploded view are kept with the edits', () => {
  let e = withExplodeOffset(normEdits(null), 'Leg_1', [0, 3.14159, -2]);
  assert.deepEqual(e.explode.Leg_1, [0, 3.142, -2]);
  assert.deepEqual(normEdits(JSON.parse(JSON.stringify(e))).explode, { Leg_1: [0, 3.142, -2] }); // survives saving
  e = withExplodeOffset(e, 'Leg_1', null);
  assert.deepEqual(e.explode, {});
  assert.deepEqual(normEdits({ explode: { a: [1, 2], b: 'x', c: [1, NaN, 2] } }).explode, {}); // junk ignored
});

import { findMissingHoles } from '../viewer/holes.js';

test('a bolt through solid wood means the model forgot the hole', () => {
  // a 1-1/2" thick board, a 1/2" bolt straight through it
  const board = { name: 'board', obb: { center: [0, 0, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], half: [10, 2, 0.75] } };
  const bolt = { name: 'bolt', center: [3, 0, 0], axis: [0, 0, 1], length: 4, dia: 0.5 };
  const solidBoard = (P, p) => Math.abs(p[0]) <= 10 && Math.abs(p[1]) <= 2 && Math.abs(p[2]) <= 0.75;
  const [h] = findMissingHoles([bolt], [board], solidBoard);
  assert.equal(h.part, 'board');
  assert.ok(Math.abs(h.depth - 1.5) < 0.1, `through the thickness (${h.depth})`);
  near(h.from[0], 3, 1e-9);
  // drawn with its hole: nothing to add
  const drilled = (P, p) => solidBoard(P, p) && Math.hypot(p[0] - 3, p[1]) > 0.25;
  assert.equal(findMissingHoles([bolt], [board], drilled).length, 0);
  // a bolt that only sits against the board: no hole
  const beside = { ...bolt, center: [3, 0, 2.8] };
  assert.equal(findMissingHoles([beside], [board], solidBoard).length, 0);
});

import { parseMeasured, printCorrection } from '../viewer/template.js';

test('printer correction: what the 6" ruler measured', () => {
  assert.equal(parseMeasured('5 3/4'), 5.75);
  assert.equal(parseMeasured('5-3/4"'), 5.75);
  assert.equal(parseMeasured('5.75'), 5.75);
  assert.equal(parseMeasured('6'), 6);
  assert.equal(parseMeasured('abc'), null);
  near(printCorrection(5.75), 6 / 5.75);
  assert.equal(printCorrection(0), 1); // nothing measured: as is
  assert.equal(printCorrection(12), 1); // not a 6" ruler
});
