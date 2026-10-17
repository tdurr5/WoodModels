import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The Castle spinning wheel (scripts/spinning_wheel/) against its plan: every
// part's size and count from the plan's own drawings and parts lists.
const folder = new URL('../viewer/models/spinning-wheel/', import.meta.url);
const rows = JSON.parse(readFileSync(new URL('parts_report.json', folder)));
const dims = JSON.parse(readFileSync(new URL('object_dims.json', folder)));
const MM = 25.4;
const row = (label) => {
  const r = rows.find((x) => x.label === label);
  assert.ok(r, `no ${label} in the cut list`);
  return r;
};

// label: [qty, length, width, thickness] in mm, as the plan gives them (null: not checked)
const PLAN = {
  'Hub': [1, 100, 77, 77],
  'Toggle': [6, 160, 24, 24],
  'Wheel Plank': [6, null, null, 35],
  'Pin D6 x 35mm': [6, 35, 6, 6],
  'Wheel Axle': [1, 215, 6, 6],
  'Rotation Pin': [1, 22, 10, 10],
  'Flyer': [1, 142, 138, null],
  'Flyer Axle': [1, 194, 6, 6],
  'Bobbin': [1, 129, 90, 90],
  'Flyer Whorl': [1, 80, 80, 32],
  'Rectangle Nut': [1, 12, 12, 10],
  'Hook 1': [12, null, null, null],
  'Hook 2': [8, null, null, null],
  'Base Plank 1': [1, 430, 52, 30],
  'Base Plank 2': [1, 290, 52, 30],
  'Leg': [3, 193, 27, 27],               // 154 from the shoulder on the foot's long side, + 39 tenon
  'Main Pillar': [1, 643, 54, 54],
  'Movable Bearing': [1, 45, 34, 20],
  'Tension Knob': [1, 165, 58, 58],
  'Secondary Pillar': [1, 493, null, null],
  'Main Holder': [1, 340, 45, 45],
  'Disc': [2, 60, 60, 20],
  'Maidens': [1, 235, null, null],
  'Pin D8 x 44mm': [1, 44, 8, 8],
  'Wool Carrier': [1, 250, 40, 40],
  'Axle Pin': [2, 80, 9, 9],
  'Treadle Axle': [1, 283, null, null],
  'Treadle Pedal': [1, 245, 56, 10],
  'Treadle Bar': [2, 90, 6, 6],
  'Footman': [1, 350, 26, 10],
  'Thin Wedge': [3, 35, 17, 3],
  'Wool Bar': [1, 1194, 42, 42],
};

for (const [label, [qty, ...size]] of Object.entries(PLAN)) {
  test(`${label}: ${qty} at the plan's size`, () => {
    const r = row(label);
    assert.equal(r.count, qty);
    size.forEach((want, i) => {
      if (want === null) return;
      const got = r.dims[i] * MM;
      assert.ok(Math.abs(got - want) <= 0.6, `${label} ${['length', 'width', 'thickness'][i]} ${got.toFixed(2)} mm, plan ${want}`);
    });
  });
}

test('it stands 843 tall, the plan\'s overall height', () => {
  const knob = Object.entries(dims).find(([name]) => /Tension_Knob/.test(name))[1];
  const up = knob.axes.find((a) => Math.abs(a.direction[1]) > 0.99);
  const top = (knob.center[1] + up.length / 2) * MM;
  assert.ok(Math.abs(top - 843) <= 1, `top of the tension knob at ${top.toFixed(1)} mm`);
});

test('the plan\'s 80 parts, nothing extra', () => {
  assert.equal(rows.reduce((n, r) => n + r.count, 0), 80);
});
