import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The foot-powered scroll saw (scripts/scroll_saw/) against its article:
// the sizes Figs. 1-20 give, and the heights Fig. 8 is drawn to.
const folder = new URL('../viewer/models/scroll-saw/', import.meta.url);
const rows = JSON.parse(readFileSync(new URL('parts_report.json', folder)));
const dims = JSON.parse(readFileSync(new URL('object_dims.json', folder)));
const count = (label) => rows.filter((x) => x.label === label).reduce((n, r) => n + r.count, 0);
const row = (label) => {
  const r = rows.find((x) => x.label === label);
  assert.ok(r, `no ${label} in the cut list`);
  return r;
};

// label: [qty, length, width, thickness] in inches (null: not checked)
const PLAN = {
  'Side': [2, 41, 36, 0.75],                   // Fig. 9: two to a 41 x 63-1/2 panel
  'Table': [1, 12, 12, 0.75],                  // 12" x 12" table
  'Tension Housing': [1, 7, 3, 1.5],           // hardwood block 1-1/2 x 3 x 7
  'Tension Shaft': [1, 9.375, 0.5, 0.5],       // 1/2 x 9-3/8
  'Drive Shaft': [1, 6.5, 0.5, 0.5],           // 1/2 x 6-1/2
  'Drive Base': [1, 6.25, 4.5, 0.75],          // 3/4 x 4-1/2 x 6-1/4
  'Drive Pulley 18"': [1, 18, 18, 0.75],       // 3/4 x 18 wood pulley
  'Crank Pulley 4"': [1, 4, 4, null],
  'Slotted Tube': [1, null, 1, 1],             // 1" tube
  'Hold-Down Disk': [1, 1.5, 1.5, null],       // 1-1/2" disk
  'Crossbar': [1, null, 3.5, 1.5],             // 1-1/2 x 3-1/2
  'Seat Member': [1, null, null, null],
  'Rear Leg': [2, null, null, null],
  'Trunnion': [2, null, null, 0.75],
  'Trunnion Guide': [2, 3, null, null],        // 3" segments of the ring
  'Bicycle Pedal': [2, null, null, null],
};

for (const [label, [qty, ...size]] of Object.entries(PLAN)) {
  test(`${label}: ${qty} at the plan's size`, () => {
    assert.equal(count(label), qty);
    const r = row(label);
    size.forEach((want, i) => {
      if (want === null) return;
      assert.ok(Math.abs(r.dims[i] - want) <= 0.02, `${label} ${['length', 'width', 'thickness'][i]} ${r.dims[i]}", plan ${want}"`);
    });
  });
}

test('Fig. 8\'s heights: seat at 29", arm top 17-1/2" above it', () => {
  const seat = dims.Stand_Seat;
  assert.ok(Math.abs(seat.center[1] + 0.375 - 29) < 0.01, `seat top at ${seat.center[1] + 0.375}`);
  const top = Math.max(...Object.entries(dims).filter(([n]) => n.startsWith('Frame_Side')).map(([, d]) => d.center[1] + 18));
  assert.ok(Math.abs(top - 46.5) < 0.01, `arm top at ${top}`);
});

test('the blade runs between the chucks, through the table', () => {
  const blade = dims.Tension_Unit_Scroll_Saw_Blade;
  const table = dims.Table_Table;
  const half = blade.axes.find((a) => Math.abs(a.direction[1]) > 0.99).length / 2;
  assert.ok(blade.center[1] - half < table.center[1] && blade.center[1] + half > table.center[1]);
});

test('92 parts, nothing extra', () => {
  assert.equal(rows.reduce((n, r) => n + r.count, 0), 92);
});
