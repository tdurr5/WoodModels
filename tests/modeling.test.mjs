import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDesign, newPart, buildSolids, instanceBasis, compileDesign } from '../viewer/design.js';
import { DesignHistory, pieceKey, selectedPieces, translatePieces, rotatePieces, duplicatePieces, deletePieces, makeUnique, solidAnchors, snapTranslation } from '../viewer/modeling.js';
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
function fixture() {
  const design = emptyDesign();
  design.parts.push(newPart(design, { size: [10, 4, 2], instances: [{ at: [0, 1, 0], along: 'x', up: 'y' }, { at: [0, 1, 8], along: 'x', up: 'y' }] }));
  return design;
}
test('moving one linked piece leaves the other fixed and compiles the moved geometry', () => {
  const d = fixture(), key = pieceKey(d.parts[0].id, 1);
  translatePieces(d, new Set([key]), [3, 0, -2]);
  assert.deepEqual(d.parts[0].instances.map((i) => i.at), [[0, 1, 0], [3, 1, 6]]);
  assert.equal(compileDesign(d).problems.length, 0);
  assert.deepEqual(buildSolids(d)[1].center, [3, 1, 6]);
});
test('rotating a selection preserves spacing, dimensions and orthogonal grain axes', () => {
  const d = fixture(), keys = new Set(d.parts[0].instances.map((_, i) => pieceKey(d.parts[0].id, i)));
  rotatePieces(d, keys, [0, 1, 0], 90, [0, 1, 4]);
  const [a, b] = d.parts[0].instances;
  near(a.at[0], -4); near(b.at[0], 4); near(a.at[2], 4); near(b.at[2], 4);
  assert.deepEqual(d.parts[0].size, [10, 4, 2]);
  for (const inst of [a, b]) {
    const basis = instanceBasis(inst);
    near(basis[0][2], -1); near(basis[2][1], 1);
    basis.forEach((v) => near(Math.hypot(...v), 1));
  }
});
test('duplicate, detach and delete preserve unaffected linked pieces', () => {
  const d = fixture(), keys = new Set([pieceKey(d.parts[0].id, 0)]);
  const copies = duplicatePieces(d, keys, [20, 0, 0]);
  assert.equal(d.parts[0].instances.length, 3);
  assert.deepEqual(selectedPieces(d, copies)[0].inst.at, [20, 1, 0]);
  const unique = makeUnique(d, [...copies][0]);
  const part = selectedPieces(d, new Set([unique]))[0].part;
  part.size[0] = 15;
  assert.equal(d.parts[0].size[0], 10);
  assert.equal(d.parts[0].instances.length, 2);
  deletePieces(d, new Set([unique]));
  assert.equal(d.parts.length, 1);
  assert.equal(compileDesign(d).problems.length, 0);
});
test('a box offers its eight corners, twelve edge midpoints and six face centres', () => {
  const anchors = solidAnchors(buildSolids(fixture())[0]);
  assert.equal(anchors.filter((a) => a.kind === 'corner').length, 8);
  assert.equal(anchors.filter((a) => a.kind === 'edge midpoint').length, 12);
  assert.equal(anchors.filter((a) => a.kind === 'face centre').length, 6);
});
test('magnetic snapping is exact and never violates an axis lock', () => {
  const source = [{ point: [1, 2, 3], kind: 'corner' }], target = [{ point: [6, 2, 3], kind: 'corner' }];
  assert.deepEqual(snapTranslation(source, target, [4.8, 0, 0], [0], 0.3).delta, [5, 0, 0]);
  assert.deepEqual(snapTranslation(source, [{ point: [6, 2.1, 3] }], [4.8, 0, 0], [0], 0.3).delta, [4.8, 0, 0]);
  assert.deepEqual(snapTranslation(source, target, [3, 0, 0], [0], 0.3).delta, [3, 0, 0]);
});
test('history restores geometry, supports redo, and drops redo after a new edit', () => {
  const d = fixture(), h = new DesignHistory(); h.reset(d);
  d.parts[0].size[0] = 20; h.record(d);
  assert.equal(h.undo().parts[0].size[0], 10);
  assert.equal(h.redo().parts[0].size[0], 20);
  const restored = h.undo(); restored.parts[0].size[0] = 30; h.record(restored);
  assert.equal(h.canRedo, false);
  assert.equal(h.undo().parts[0].size[0], 10);
});

test('volumetric grain is continuous across faces and stays fixed when a board rotates or moves', async () => {
  const THREE = await import('three');
  const { grainCoordinates, grainSeed } = await import('../viewer/solidwood.js');
  const box = new THREE.BoxGeometry(20, 5, 1).toNonIndexed();
  const seed = grainSeed('board:0');
  grainCoordinates(box, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0], seed);
  const expected = [...box.attributes.woodPosition.array];
  const seen = new Map();
  for (let i = 0; i < box.attributes.position.count; i++) {
    const position = [...box.attributes.position.array.slice(i * 3, i * 3 + 3)].join(',');
    const grain = expected.slice(i * 3, i * 3 + 3);
    if (seen.has(position)) assert.deepEqual(grain, seen.get(position));
    seen.set(position, grain);
  }
  box.rotateZ(Math.PI / 2).translate(12, 3, -5);
  grainCoordinates(box, [[0, 1, 0], [-1, 0, 0], [0, 0, 1]], [12, 3, -5], seed);
  [...box.attributes.woodPosition.array].forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-5));
  grainCoordinates(box, [[0, 1, 0], [-1, 0, 0], [0, 0, 1]], [12, 3, -5], grainSeed('board:1'));
  assert.notDeepEqual([...box.attributes.woodPosition.array], expected, 'copies get distinct sections of wood');
});
