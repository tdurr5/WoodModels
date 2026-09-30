// Unit tests for the designer's half: the design format, the compiler that
// turns a design into the six data files the viewer reads, the parametric
// archetypes, and the review run straight off a design.
//
// The compiler's contract is the important thing here. If what it writes
// stops matching what collada.js writes, every tool downstream - cut list,
// diagrams, templates, build mode - quietly breaks on designed models only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileDesign, buildSolids, prism, instanceBasis, designBounds, designReviewModel,
  emptyDesign, newPart, validateDesign, DESIGN_VERSION,
} from '../viewer/design.js';
import { ARCHETYPES, archetype, buildArchetype, defaultParams } from '../viewer/archetypes.js';
import { reviewModel } from '../viewer/review.js';
import { WOOD } from '../viewer/woodprops.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const close = (a, b, pct = 0.02) => assert.ok(Math.abs(a - b) <= Math.abs(b) * pct, `${a} not within ${pct * 100}% of ${b}`);

const rail = (over = {}) => ({
  id: 'rail', name: 'Rail', group: 'Frame', material: 'Maple',
  size: [20, 3, 0.75], instances: [{ at: [0, 10, 0], along: 'x', up: 'y' }], ...over,
});
const leg = (over = {}) => ({
  id: 'leg', name: 'Leg', group: 'Frame', material: 'Maple',
  size: [18, 1.75, 1.75], instances: [{ at: [-11, 9, 0], along: 'y', up: 'z' }], ...over,
});
const design = (parts, joints = []) => ({ ...emptyDesign('Test'), parts, joints });

// ---------- placement ----------

test('a placement gives three perpendicular directions', () => {
  const [L, W, T] = instanceBasis({ along: 'x', up: 'y' });
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  near(dot3(L, [1, 0, 0]), 1);
  near(dot3(T, [0, 1, 0]), 1);
  near(dot3(L, W), 0);
  near(dot3(W, T), 0);
  near(Math.hypot(...W), 1);
  // Nonsense (length and thickness the same way) still gives a usable frame.
  const bad = instanceBasis({ along: 'y', up: 'y' });
  near(bad[0][1] * bad[2][1] + bad[0][0] * bad[2][0] + bad[0][2] * bad[2][2], 0);
});

test('tilts lean a part, and two of them make a compound splay', () => {
  const one = instanceBasis({ along: 'y', up: 'z', tilt: { axis: 'z', deg: 10 } });
  close(one[0][1], Math.cos((10 * Math.PI) / 180), 0.001);
  assert.ok(one[0][0] < 0, 'a positive tilt about z leans towards -x');
  const two = instanceBasis({ along: 'y', up: 'z', tilt: [{ axis: 'z', deg: 8 }, { axis: 'x', deg: 8 }] });
  assert.ok(Math.abs(two[0][0]) > 0.1 && Math.abs(two[0][2]) > 0.1, 'leans both ways');
  near(Math.hypot(...two[0]), 1, 1e-9);
});

// ---------- geometry ----------

test('a plain box is a closed mesh of twelve triangles', () => {
  const { positions, faces } = prism([{ length: 4, width: 2, thickness: 1 }]);
  assert.equal(positions.length, 8);
  assert.equal(faces.length, 12);
  // Every edge is shared by exactly two triangles: the solid has no holes.
  const edges = new Map();
  for (const [a, b, c] of faces) {
    for (const [i, j] of [[a, b], [b, c], [c, a]]) {
      const k = [i, j].sort((x, y) => x - y).join('-');
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  assert.ok([...edges.values()].every((n) => n === 2), 'every edge used twice');
});

test('a part with a tenon is one closed solid, stepped at the shoulder', () => {
  const { positions, faces } = prism([
    { length: 10, width: 3, thickness: 0.75 },
    { length: 1.25, width: 1.5, thickness: 0.25 },
  ]);
  assert.equal(positions.length, 16);
  const edges = new Map();
  for (const [a, b, c] of faces) {
    for (const [i, j] of [[a, b], [b, c], [c, a]]) {
      const k = [i, j].sort((x, y) => x - y).join('-');
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  assert.ok([...edges.values()].every((n) => n === 2), 'closed: the shoulder ring fills the step');
  const xs = positions.map((p) => p[0]);
  near(Math.max(...xs) - Math.min(...xs), 11.25);
});

// ---------- the compiler ----------

test('a design compiles to the six files the viewer reads', () => {
  const out = compileDesign(design([rail(), leg()]));
  assert.deepEqual(Object.keys(out.files).sort(), [
    'materials.json', 'model.json', 'object_dims.json', 'parts_report.json', 'scene.mtl', 'scene.obj',
  ]);
  assert.match(out.files['scene.obj'], /^mtllib scene\.mtl/);
  assert.match(out.files['scene.obj'], /\no Frame_Rail\n/);
  assert.match(out.files['scene.obj'], /\nusemtl Maple\n/);
  assert.match(out.files['scene.mtl'], /newmtl Maple\nKd [\d.]+ [\d.]+ [\d.]+/);
  assert.deepEqual(JSON.parse(out.files['materials.json']), { Maple: 'Maple' });
  assert.equal(out.problems.length, 0);
  // Face indices are 1-based and never point past the vertices written.
  const verts = (out.files['scene.obj'].match(/^v /gm) || []).length;
  for (const line of out.files['scene.obj'].split('\n').filter((l) => l.startsWith('f '))) {
    for (const i of line.slice(2).split(' ').map(Number)) assert.ok(i >= 1 && i <= verts, `face index ${i}`);
  }
});

test('parts_report rows look like the parser writes them', () => {
  const rows = JSON.parse(compileDesign(design([rail({ instances: [
    { at: [0, 10, 0], along: 'x', up: 'y' }, { at: [0, 20, 0], along: 'x', up: 'y' },
  ] }), leg()])).files['parts_report.json']);
  const r = rows.find((x) => x.label === 'Rail');
  assert.equal(r.top_group, 'Frame');
  assert.equal(r.count, 2);
  assert.deepEqual(r.obj_names, ['Frame_Rail', 'Frame_Rail_1']);   // named like collada.js
  assert.deepEqual(r.materials, ['Maple']);
  assert.deepEqual(r.dims, [20, 3, 0.75]);                          // biggest first
  assert.equal(r.dims_str, '20" x 3" x 3/4"');
  assert.equal(r.paths.length, 2);
});

test('object_dims carries a real oriented box per piece', () => {
  const dims = JSON.parse(compileDesign(design([rail(), leg()])).files['object_dims.json']);
  const d = dims.Frame_Rail;
  assert.deepEqual(d.center, [0, 10, 0]);
  assert.equal(d.axes.length, 3);
  assert.deepEqual(d.axes.map((a) => a.role), ['Length', 'Width', 'Thickness']);
  assert.deepEqual(d.axes.map((a) => a.length), [20, 3, 0.75]);
  assert.equal(d.axes[0].label, '20"');
  // A tilted part's box tilts with it, and stays a unit frame.
  const tilted = JSON.parse(compileDesign(design([leg({ instances: [{ at: [0, 9, 0], along: 'y', up: 'z', tilt: { axis: 'z', deg: 10 } }] })])).files['object_dims.json']);
  const axes = Object.values(tilted)[0].axes;
  assert.ok(axes[0].direction[0] < 0 && axes[0].direction[1] > 0.9);
  near(Math.hypot(...axes[0].direction), 1, 1e-5);
});

test('a joint grows a tenon: the length includes it, the size you typed is the shoulder', () => {
  const plain = JSON.parse(compileDesign(design([rail(), leg()])).files['parts_report.json']);
  near(plain.find((r) => r.label === 'Rail').dims[0], 20);
  const jointed = compileDesign(design([rail(), leg()], [{ from: 'rail', end: 0, into: 'leg', type: 'mortise-tenon' }]));
  const r = JSON.parse(jointed.files['parts_report.json']).find((x) => x.label === 'Rail');
  // A 3/4in rail into a 1-3/4in leg: a 1/4in tenon, 2/3 of the way in.
  close(r.dims[0], 20 + (1.75 * 2) / 3, 0.001);
  assert.match(r.note, /Mortise and tenon into Leg/);
  // The rail's own box has not moved: the tenon grew out past its end.
  const dims = JSON.parse(jointed.files['object_dims.json']).Frame_Rail;
  close(dims.center[0], -(1.75 * 2) / 3 / 2, 0.001);
  // Both ends tenoned reads as one note, not two.
  const both = compileDesign(design([rail(), leg()], [
    { from: 'rail', end: 0, into: 'leg', type: 'mortise-tenon' },
    { from: 'rail', end: 1, into: 'leg', type: 'mortise-tenon' },
  ]));
  assert.match(JSON.parse(both.files['parts_report.json']).find((x) => x.label === 'Rail').note, /each end$/);
});

test('model.json carries the design, the materials and nothing misleading', () => {
  const d = design([rail(), leg()], [{ from: 'rail', end: 0, into: 'leg', type: 'dado' }]);
  d.title = 'Side table';
  const cfg = JSON.parse(compileDesign(d).files['model.json']);
  assert.equal(cfg.title, 'Side table');
  assert.equal(cfg.materials.Maple.category, 'Wood');
  assert.equal(cfg.materials.Maple.species, 'maple');
  assert.ok(cfg.materials.Maple.texture, 'wood gets a grain to draw');
  assert.deepEqual(cfg.axisNames, { x: 'side-to-side', y: 'vertical', z: 'front-to-back' });
  assert.ok(cfg.views.iso && cfg.views.front && cfg.views.top);
  // model.json notes are the plan author's warnings; a joint is not one.
  assert.deepEqual(cfg.notes, {});
  // The design rides along, so it can be opened and edited again.
  assert.equal(cfg.design.title, 'Side table');
  assert.equal(cfg.design.parts.length, 2);
});

test('a half-finished design still compiles, and says what is wrong', () => {
  const broken = design([
    rail({ size: [20, 0, 0.75] }),
    leg({ id: 'rail', name: 'Clash' }),
    { id: 'nowhere', name: 'Floating', size: [1, 1, 1], instances: [], material: 'Nope' },
  ]);
  const out = compileDesign(broken);
  const texts = out.problems.map((p) => p.text).join(' | ');
  assert.match(texts, /length, width and thickness above zero/);
  assert.match(texts, /shares its id/);
  assert.match(texts, /not placed anywhere/);
  assert.match(texts, /material that isn't in the design/);
  assert.equal(out.stats.parts, 1, 'the parts that are fine are still built');
  assert.equal(validateDesign(design([rail(), leg()])).length, 0);
});

test('bounds, empty designs and new parts', () => {
  const b = designBounds(design([rail(), leg()]));
  assert.deepEqual(b.min, [-11.875, 0, -1.5]);
  assert.equal(designBounds(design([])), null);
  const empty = emptyDesign('Blank');
  assert.equal(empty.version, DESIGN_VERSION);
  assert.equal(empty.parts.length, 0);
  assert.equal(compileDesign(empty).stats.parts, 0);
  // A new part lands clear of what is there, so you can see it arrive.
  const p = newPart(design([rail(), leg()]));
  assert.ok(p.instances[0].at[1] > b.max[1]);
  assert.ok(p.size.every((v) => v > 0));
});

// ---------- archetypes ----------

test('every archetype builds something that stands on the floor', () => {
  for (const a of ARCHETYPES) {
    const d = buildArchetype(a.key);
    assert.equal(validateDesign(d).length, 0, `${a.key} validates`);
    const out = compileDesign(d);
    assert.ok(out.stats.parts >= 2, `${a.key} has parts`);
    assert.ok(out.stats.pieces >= out.stats.parts);
    const b = designBounds(d);
    assert.ok(Math.abs(b.min[1]) < 0.1, `${a.key} sits on y=0, not ${b.min[1]}`);
    assert.ok(b.size.every((v) => v > 1), `${a.key} has size`);
    // Its parameters all reach the design.
    for (const [key, spec] of Object.entries(a.params)) {
      assert.ok(spec.label && spec.max > spec.min, `${a.key}.${key} is a usable control`);
      assert.equal(d.params[key], spec.value);
    }
  }
});

test('the archetypes are already right: nothing to fix out of the box', () => {
  for (const a of ARCHETYPES) {
    const r = reviewModel(designReviewModel(buildArchetype(a.key)));
    assert.equal(r.counts.problem, 0, `${a.key}: ${r.findings.filter((f) => f.severity === 'problem').map((f) => f.text).join(' / ')}`);
    assert.equal(r.counts.watch, 0, `${a.key}: ${r.findings.filter((f) => f.severity === 'watch').map((f) => f.text).join(' / ')}`);
  }
});

test('changing a parameter changes the piece', () => {
  const small = buildArchetype('dining-table', { topLength: 48 });
  const big = buildArchetype('dining-table', { topLength: 84 });
  const len = (d) => d.parts.find((p) => p.id === 'apronLong').size[0];
  close(len(big) - len(small), 36, 0.001);           // the aprons follow the top
  assert.equal(designBounds(big).size[0], 84);
  // Legs stay in from the corner by the overhang you asked for.
  const over = buildArchetype('dining-table', { overhang: 6 });
  const legX = Math.abs(over.parts.find((p) => p.id === 'leg').instances[0].at[0]);
  close(legX, 60 / 2 - 6 - 2.75 / 2, 0.001);
  assert.equal(archetype('nope'), null);
  assert.equal(buildArchetype('nope'), null);
  assert.deepEqual(Object.keys(defaultParams(archetype('stool'))), Object.keys(archetype('stool').params));
});

test('a table\'s two aprons do not fight over the same leg', () => {
  const d = buildArchetype('dining-table');
  const legSize = d.params.legSize;
  for (const j of d.joints.filter((x) => x.tenon)) {
    assert.ok(j.tenon.length < legSize / 2, 'each tenon keeps to its own half of the leg');
  }
  // Push them past half and the review says so.
  const bad = buildArchetype('dining-table');
  bad.joints.filter((j) => j.tenon).forEach((j) => { j.tenon = { ...j.tenon, length: 2 }; });
  const hits = reviewModel(designReviewModel(bad)).findings.filter((f) => f.rule === 'tenon-collision');
  assert.equal(hits.length, 1, 'one finding, not one per leg');
  assert.match(hits[0].fix, /mitre/);
});

test('a bookcase that is too wide is caught before it is cut', () => {
  const fine = reviewModel(designReviewModel(buildArchetype('bookcase', { width: 32 })));
  assert.equal(fine.findings.some((f) => f.rule === 'sag'), false);
  const wide = reviewModel(designReviewModel(buildArchetype('bookcase', { width: 44 })));
  const sag = wide.findings.find((f) => f.rule === 'sag' && f.name === 'Shelf');
  assert.ok(sag, 'a 44in shelf span should be flagged');
  assert.match(sag.text, /still shows|of sag/);
  // Thicker stock fixes it.
  assert.equal(reviewModel(designReviewModel(buildArchetype('bookcase', { width: 44, thickness: 1 })))
    .findings.some((f) => f.rule === 'sag'), false);
});

test('a bench seat is checked against someone sitting on it', () => {
  const springy = buildArchetype('bench', { seatLength: 70, seatThickness: 1 });
  const f = reviewModel(designReviewModel(springy)).findings.find((x) => x.rule === 'sag');
  assert.ok(f, 'a thin 70in bench should be flagged');
  assert.match(f.text, /sitting in the middle/);
  assert.equal(reviewModel(designReviewModel(buildArchetype('bench'))).findings.some((x) => x.rule === 'sag'), false);
});

// ---------- the design as the review sees it ----------

test('the review model knows what the design knows', () => {
  const d = buildArchetype('dining-table');
  const m = designReviewModel(d);
  const top = m.parts.find((p) => p.name === 'Top');
  const apron = m.parts.find((p) => p.name === 'Apron, long');
  const legPart = m.parts.find((p) => p.name === 'Leg');
  assert.equal(top.count, 1);
  assert.equal(legPart.count, 4);
  assert.equal(top.props.name, 'Walnut');
  assert.ok(top.horizontal && !legPart.horizontal);
  assert.ok(top.touches.some((t) => t.name === 'Leg'), 'the top sits on the legs');
  // The design says the top is on buttons, so it is free to move.
  assert.ok(top.freeOf.includes('apronLong'));
  // Tenons and the mortises they make are both known.
  assert.equal(apron.tenons.length, 2);
  assert.equal(apron.tenons[0].into, 'Leg');
  assert.ok(legPart.mortises.length >= 2);
  assert.equal(m.pieceType, 'dining table');
  close(m.height, 29.5, 0.001);
});

test('a stool seat height is measured at the seat', () => {
  const m = designReviewModel(buildArchetype('stool', { seatHeight: 18 }));
  close(m.seatHeight, 18, 0.02);
  assert.ok(m.parts.find((p) => p.name === 'Seat').seat, 'a seat carries a person');
  const low = reviewModel(designReviewModel(buildArchetype('stool', { seatHeight: 12 })));
  assert.ok(low.findings.some((f) => f.rule === 'height'));
});

test('the same design reviews the same whether measured or declared', () => {
  // designReviewModel reads the design; designreview.js measures the built
  // geometry. They are different code paths and must agree on the big things.
  const d = buildArchetype('dining-table', { topWidth: 44 });
  const fromDesign = reviewModel(designReviewModel(d));
  const rows = JSON.parse(compileDesign(d).files['parts_report.json']);
  const top = rows.find((r) => r.label === 'Top');
  assert.deepEqual(top.dims, [60, 44, 1]);
  // The movement note is the one both should reach, off the same species.
  const note = fromDesign.findings.find((f) => f.rule === 'wide-board');
  assert.ok(note && note.text.includes('44"'));
  assert.ok(note.text.includes('walnut'));
});

test('materials that are not wood are treated as panels', () => {
  const d = buildArchetype('bookcase');
  const back = designReviewModel(d).parts.find((p) => p.name === 'Back');
  assert.equal(back.props.moves, false, 'plywood does not move across its width');
  assert.equal(reviewModel(designReviewModel(d)).findings.some((f) => f.key === 'back' && f.family === 'movement'), false);
});

test('buildSolids is what both the preview and the compiler draw', () => {
  const d = buildArchetype('stool');
  const solids = buildSolids(d);
  assert.equal(solids.length, 5);
  assert.ok(solids.every((s) => s.positions.length && s.faces.length && s.name));
  assert.equal(new Set(solids.map((s) => s.name)).size, 5, 'every piece has its own name');
  const legs = solids.filter((s) => s.part.id === 'leg');
  assert.equal(legs.length, 4);
  // The tenon is part of the leg's own solid, not a separate lump.
  assert.ok(legs[0].extents[0] > d.parts.find((p) => p.id === 'leg').size[0]);
});

test('every species the designer offers can be built with', () => {
  for (const key of Object.keys(WOOD)) {
    const d = design([rail()], []);
    d.materials = { Test: { category: 'Wood', species: key, color: '#cccccc' } };
    d.parts[0].material = 'Test';
    const m = designReviewModel(d);
    assert.equal(m.parts[0].props.key, key);
    assert.ok(compileDesign(d).files['scene.obj'].includes('usemtl Test'));
  }
});
