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
  assert.deepEqual(normalizeEdits({ names: [], status: 'x' }), { names: {}, groups: {}, status: {}, pieces: {}, joins: [] }, 'bad data is ignored');
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
