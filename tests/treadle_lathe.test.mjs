import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The treadle lathe (scripts/treadle_lathe/) against its book: every part's
// size and count from the materials list (nominal lumber at its actual size),
// and the heights its text and measured drawing give.
const folder = new URL('../viewer/models/treadle-lathe/', import.meta.url);
const rows = JSON.parse(readFileSync(new URL('parts_report.json', folder)));
const dims = JSON.parse(readFileSync(new URL('object_dims.json', folder)));
const model = JSON.parse(readFileSync(new URL('model.json', folder)));
const row = (label) => {
  const r = rows.find((x) => x.label === label);
  assert.ok(r, `no ${label} in the cut list`);
  return r;
};
const centreHeight = (name) => dims[name].center[1];

// label: [qty, length, width, thickness] in inches (null: not checked)
const PLAN = {
  'Headstock Upright': [2, 38.5, 2.75, 2.75],      // 3x3 x 38-1/2
  'Tail Upright': [1, 27.5, 2.75, 2.75],           // 3x3 x 27-1/2
  'Way': [2, 42, 3.5, 1.5],                        // 2x4 x 42
  'Base': [1, 40.5, 3.5, 1.5],                     // 2x4 x 40-1/2
  'Stabilizer': [1, 24, 3.5, 1.5],                 // 2x4 x 24
  'Headstock End Brace': [1, 12, 9.25, 0.75],      // 1x10 x 12
  'Tailstock': [1, 18, 3.5, 1.5],                  // 2x4 x 18
  'Tailstock Brace': [2, 6, 2.5, 0.75],            // 1x3 x 6
  'Tailstock Block': [1, 6, 2.75, 2.75],           // 6" of 3x3
  'Tailstock Wedge': [1, 7, 2.25, 0.5],
  'Wheel Board, Long': [2, 24, 7.25, 0.75],        // the 26" 1x8s, cut to the 24" circle
  'Wheel Board, Short': [2, null, 4.75, 0.75],     // the 22" 1x8s: 12" radius less one board's width
  'Rim Section': [8, null, null, 0.75],            // cherry 1x6, four to a face
  'Treadle': [1, 28, 1.5, 0.75],                   // 1x2 x 28
  'Tool Rest Post': [1, 5, 2.75, 2.75],            // 3x3 x 5
  'Tool Rest Top': [1, 8, 3.5, 1.5],               // 2x4 x 8
  'Tool Rest Base': [1, 12, 3.5, 0.75],            // 1x4 x 12
  'Tool Rest Spacer': [1, 3, 2.75, 2.75],          // 3x3 x 3
  'Clamp Piece': [1, 6, 3.5, 0.75],                // 1x4 x 6
  'Wing Nut': [1, 4, 1, 1],
  'Spindle Shaft': [1, 8, 0.5, 0.5],               // 8 x 1/2 rod
  'Spindle Pulley': [1, 3, 3, null],               // 3" pulley
  'Treadle Connector': [1, 11, 0.25, 0.25],        // 11 x 1/4 rod
  'Ball Bearing': [4, 1.125, 1.125, 0.3125],       // 1/2" ID: two for the spindle, two for the flywheel
  'Floor Flange': [2, null, null, null],
  'Lag Screw 5/16 x 3"': [1, null, null, null],
  'Carriage Bolt 3/8 x 6"': [1, null, null, null],
  'Leather Belt': [1, null, null, 0.25],
};

for (const [label, [qty, ...size]] of Object.entries(PLAN)) {
  test(`${label}: ${qty} at the plan's size`, () => {
    const r = row(label);
    assert.equal(r.count, qty);
    size.forEach((want, i) => {
      if (want === null) return;
      assert.ok(Math.abs(r.dims[i] - want) <= 0.02, `${label} ${['length', 'width', 'thickness'][i]} ${r.dims[i]}", plan ${want}"`);
    });
  });
}

test('the heights the book gives: ways 30", spindle 8" above them, flywheel 12-1/2" above the base, 40" overall', () => {
  const wayTop = centreHeight('Frame_Way') + 1.75;
  assert.ok(Math.abs(wayTop - 30) < 0.01, `ways' top at ${wayTop}`);
  assert.ok(Math.abs(centreHeight('Headstock_Spindle_Shaft') - (wayTop + 8)) < 0.01);
  const baseTop = centreHeight('Frame_Base') + 0.75;
  assert.ok(Math.abs(centreHeight('Flywheel___Treadle_Floor_Flange') - (baseTop + 12.5)) < 0.01);
  const uprightTop = centreHeight('Frame_Headstock_Upright') + 38.5 / 2;
  assert.ok(Math.abs(uprightTop - 40) < 0.01, `headstock uprights' top at ${uprightTop}`);
});

test('the centers meet the spindle\'s axis', () => {
  const axis = dims.Headstock_Spindle_Shaft.center;
  for (const name of ['Headstock_Drive_Center', 'Tailstock_Cup_Center']) {
    const c = dims[name].center;
    assert.ok(Math.abs(c[1] - axis[1]) < 0.01 && Math.abs(c[2] - axis[2]) < 0.01, `${name} off the axis: ${c}`);
  }
});

test('the tool rest swivels on its lag screw', () => {
  const [rest] = model.mechanisms;
  rest.parts.forEach((p) => assert.ok(dims[p], `no ${p} in the model`));
  const lag = dims['Tool_Rest_Lag_Screw_5_16_x_3_'].center;
  assert.ok(Math.abs(rest.pivot[0] - lag[0]) < 0.01 && Math.abs(rest.pivot[2] - lag[2]) < 0.01, 'pivot on the lag screw\'s axis');
});

test('71 parts, nothing extra', () => {
  assert.equal(rows.reduce((n, r) => n + r.count, 0), 71);
});
