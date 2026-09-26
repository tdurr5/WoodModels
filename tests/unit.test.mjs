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
