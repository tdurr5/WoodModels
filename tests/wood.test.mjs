// Unit tests for the woodworking design rules: the species and stock data,
// the movement and sag maths, joint proportions, and the review engine that
// puts them together. Run with: node --test tests/
//
// Where a published table exists, the test checks against it rather than
// against whatever the code happens to produce - the point of these modules
// is that the numbers are right.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WOOD, PANELS, panelFor, propsFor, TYPICAL_HARDWOOD } from '../viewer/woodprops.js';
import { emc, mcSwing, movement, slotAllowance, shrinkageCoefficient, DEFAULT_ENV } from '../viewer/movement.js';
import { dimensionalSize, hardwoodStock, HARDWOOD_QUARTERS, NOMINAL_WIDTH, stockFor, boardFeetOf } from '../viewer/stock.js';
import { tenonFor, checkTenon, dadoFor, dowelsFor, recommendJoints, CHISEL_SIZES } from '../viewer/joinery.js';
import { sag, maxSpan, thicknessFor, SAG_LIMITS, LOADS_PSF } from '../viewer/spans.js';
import { pieceTypeFrom, checkHeight } from '../viewer/ergonomics.js';
import { reviewModel } from '../viewer/review.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const close = (a, b, pct = 0.02) => assert.ok(Math.abs(a - b) <= Math.abs(b) * pct, `${a} not within ${pct * 100}% of ${b}`);

// ---------- species and panel data ----------

test('every species has the properties the rules need', () => {
  for (const [key, s] of Object.entries(WOOD)) {
    assert.ok(s.moe > 500000 && s.moe < 2500000, `${key} moe`);
    assert.ok(s.shrinkT > s.shrinkR, `${key}: tangential shrinkage should exceed radial`);
    assert.ok(s.shrinkT < 13 && s.shrinkR > 1, `${key} shrinkage in range`);
    assert.ok(['hardwood', 'softwood'].includes(s.type), `${key} type`);
  }
});

test('Wood Handbook figures are the ones in the table', () => {
  // Sugar maple at 12% MC: E = 1.83 million psi, shrinkage 4.8 / 9.9%.
  near(WOOD.maple.moe, 1830000);
  near(WOOD.maple.shrinkT, 9.9);
  // White oak moves half again as much as walnut across the grain, which is
  // why a walnut top is the easier one to build wide.
  assert.ok(WOOD['white-oak'].shrinkT > WOOD.walnut.shrinkT * 1.3);
});

test('panels are told from species by name', () => {
  assert.equal(panelFor('Birch plywood'), 'plywood');   // a panel, not a birch board
  assert.equal(panelFor('MDF 3/4'), 'mdf');
  assert.equal(panelFor('Melamine white'), 'melamine');
  assert.equal(panelFor('White oak'), null);
  assert.equal(propsFor({ panel: 'mdf' }).moe, PANELS.mdf.moe);
  assert.equal(propsFor({ species: 'cherry' }).name, 'Cherry');
  assert.equal(propsFor({}), null);
  // Panels are cross-banded or random-oriented: no across-grain movement.
  assert.equal(propsFor({ panel: 'plywood' }).moves, false);
});

// ---------- movement ----------

test('equilibrium moisture content follows the sorption curve', () => {
  // Purdue FNR-163: 30% RH gives about 6% MC, 75% RH about 14%.
  close(emc(30), 6, 0.1);
  close(emc(75), 14, 0.1);
  close(emc(40, 72), 7.05, 0.02);   // the worked example in Appendix II
  assert.ok(emc(90) > emc(50) && emc(50) > emc(20));
});

test('a heated room swings about six points of moisture', () => {
  const swing = mcSwing(DEFAULT_ENV);
  assert.ok(swing > 6 && swing < 7, `${swing}`);
  assert.equal(mcSwing({ mcSwing: 8 }), 8);   // the conservative 2% rule
});

test('movement matches the worked example', () => {
  // FNR-163: a 32in sugar maple top over a 6-point moisture change moves
  // 32 x (9.9/100) x 6/30 = 0.63in.
  const m = movement(32, WOOD.maple, { env: { mcSwing: 6 } });
  close(m.total, 0.634, 0.01);
  near(m.each, m.total / 2);
  // Quartersawn moves less, in the ratio of the two coefficients.
  const q = movement(32, WOOD.maple, { env: { mcSwing: 6 }, sawn: 'quartersawn' });
  close(q.total / m.total, WOOD.maple.shrinkR / WOOD.maple.shrinkT, 0.001);
  // The 2% rule: about 2% of the width over a full 8-point swing.
  close(movement(32, WOOD.maple, { env: { mcSwing: 8 } }).percent, 2.6, 0.1);
});

test('panels and unknown materials do not move', () => {
  assert.equal(shrinkageCoefficient(PANELS.mdf), 0);
  assert.equal(movement(24, { ...PANELS.plywood }).total, 0);
  assert.ok(movement(24, TYPICAL_HARDWOOD).total > 0.2);
});

test('slot allowance rounds up to something you would cut', () => {
  const s = slotAllowance(30, WOOD['white-oak']);
  assert.ok(s.each >= s.total / 2);
  near(s.each * 16, Math.round(s.each * 16));   // a sixteenth
  assert.equal(slotAllowance(1, WOOD.pine).each, 1 / 16);   // never less
});

// ---------- stock ----------

test('nominal lumber sizes', () => {
  assert.equal(dimensionalSize(1.5, 3.5), '2×4');
  assert.equal(dimensionalSize(0.75, 5.5), '1×6');
  assert.equal(dimensionalSize(0.75, 7.25), '1×8');   // 8in and up lose 3/4in
  assert.equal(dimensionalSize(3.5, 3.5), '4×4');
  assert.equal(dimensionalSize(0.75, 4), null);       // a milled board, not stock
  assert.equal(dimensionalSize(3.5, 1.5), null);      // thicker than it is wide
  for (const [actual, nominal] of NOMINAL_WIDTH) assert.ok(actual < nominal);
});

test('hardwood thickness comes by the quarter', () => {
  const s = hardwoodStock(1.5);                 // wants 1-5/8 rough, so 8/4
  assert.equal(s.quarter, '8/4');
  near(s.waste, 0.5);
  assert.equal(s.thinner.quarter, '6/4');
  near(s.thinner.maxFinished, 1.375);           // what 6/4 can give you
  assert.equal(hardwoodStock(0.75).quarter, '4/4');
  assert.equal(hardwoodStock(0.75).s2sWorks, true);      // 13/16 covers 3/4
  assert.equal(hardwoodStock(0.875).s2sWorks, false);    // 7/8 does not
  assert.equal(hardwoodStock(40), null);
  for (const q of HARDWOOD_QUARTERS) assert.ok(q.s2s < q.rough);
});

test('board feet and the stock picker', () => {
  near(boardFeetOf(12, 12, 1), 1);
  near(boardFeetOf(96, 6, 2), 8);
  const pine = stockFor(WOOD.pine);
  assert.ok(pine.dimensional.some((s) => s.name === '2×4' && Math.abs(s.thickness - 1.5) < 1e-9));
  assert.equal(stockFor(WOOD.maple).dimensional.length, 0);   // hardwood is random width
  assert.ok(pine.quarters.length && pine.sheets.length && pine.dowels.length);
});

// ---------- joinery ----------

test('tenon proportions are the standard ones', () => {
  // A 3/4in rail into a post with depth to spare: a quarter-inch tenon (a
  // third of the rail, and a chisel size), 1-1/4in long (five times thick).
  const t = tenonFor({ railThickness: 0.75, railWidth: 3, intoThickness: 3.5 });
  near(t.thickness, 0.25);
  near(t.length, 1.25);
  near(t.width, 1.5);              // half the rail width
  assert.equal(t.twin, false);
  assert.equal(t.short, false);
  assert.ok(CHISEL_SIZES.includes(t.thickness));
  // Into a thinner leg the depth wins over the five-times rule, and says so:
  // 2/3 of a 1-1/2in leg is all there is to go into.
  const stub = tenonFor({ railThickness: 0.75, railWidth: 3, intoThickness: 1.5 });
  near(stub.length, 1);
  assert.equal(stub.short, true);
  // A wide rail needs twin tenons rather than one wide one.
  const wide = tenonFor({ railThickness: 0.75, railWidth: 8, intoThickness: 3.5 });
  assert.equal(wide.twin, true);
  assert.equal(wide.count, 2);
  assert.ok(wide.width <= wide.thickness * 6 + 1e-9);
  // A through tenon goes the full depth.
  near(tenonFor({ railThickness: 0.75, railWidth: 3, intoThickness: 1.5, through: true }).length, 1.5);
  // A thin part it goes into limits the tenon, so the walls stay thick.
  const thin = tenonFor({ railThickness: 1.5, railWidth: 3, intoThickness: 0.75 });
  assert.ok((0.75 - thin.thickness) / 2 >= thin.thickness - 1e-9);
});

test('checkTenon finds what is wrong and nothing else', () => {
  const ok = checkTenon({ thickness: 0.25, length: 1.25, width: 1.5, railThickness: 0.75, intoThickness: 1.75 });
  assert.deepEqual(ok, []);
  const ids = (o) => checkTenon(o).map((x) => x.id);
  assert.ok(ids({ thickness: 0.1, length: 1, width: 1, railThickness: 0.75, intoThickness: 1.75 }).includes('tenon-thin'));
  assert.ok(ids({ thickness: 0.5, length: 2.5, width: 1, railThickness: 0.75, intoThickness: 4 }).includes('tenon-fat'));
  assert.ok(ids({ thickness: 0.375, length: 0.75, width: 1, railThickness: 1, intoThickness: 3.5 }).includes('tenon-short'));
  // Not short when the leg is all there is: a tenon taking most of what it
  // can reach is doing its job, and telling someone off for that is noise.
  assert.ok(!ids({ thickness: 0.375, length: 0.75, width: 1, railThickness: 1, intoThickness: 1.75 }).includes('tenon-short'));
  // A round tenon on the end of a leg is sized off the leg, not the 1/3 rule.
  assert.deepEqual(checkTenon({ thickness: 0.9, length: 1.2, width: 0.9, railThickness: 1.5, intoThickness: 1.5, round: true }), []);
  assert.ok(ids({ thickness: 0.25, length: 1.7, width: 1, railThickness: 0.75, intoThickness: 1.75 }).includes('tenon-bottoms'));
  assert.ok(ids({ thickness: 0.25, length: 1.25, width: 3, railThickness: 0.75, intoThickness: 1.75 }).includes('tenon-wide'));
  assert.ok(ids({ thickness: 0.25, length: 1.25, width: 1, railThickness: 0.75, intoThickness: 1.75, fromEnd: 0.5 }).includes('mortise-end'));
  // A through tenon that comes out the far side is the point of it.
  assert.ok(!ids({ thickness: 0.25, length: 1.75, width: 1, railThickness: 0.75, intoThickness: 1.75, through: true }).includes('tenon-bottoms'));
});

test('dados, dowels and joint recommendations', () => {
  near(dadoFor(0.75).depth, 0.25);
  near(dadoFor(0.75).max, 0.375);
  const d = dowelsFor({ thickness: 0.75, width: 3 });
  near(d.diameter, 0.25);
  assert.ok(d.count >= 2);
  assert.ok(d.perSide >= d.diameter * 2.5 - 1e-9);
  // A rail into a leg: mortise and tenon first, with hand tools.
  const rail = recommendJoints('rail-to-leg');
  assert.equal(rail[0].key, 'mortise-tenon');
  assert.ok(rail.slice(0, 2).every((j) => j.canCut), 'the ones it offers first are cuttable');
  // No chisel, but a router: the loose tenon is the one it can cut.
  const router = recommendJoints('rail-to-leg', { tools: ['saw', 'router', 'drill'] });
  assert.ok(router.find((j) => j.key === 'loose-tenon').canCut);
  assert.equal(router.find((j) => j.key === 'mortise-tenon').canCut, false);
  // A shelf bears straight down: a housing, not a tenon.
  assert.equal(recommendJoints('shelf-to-side')[0].key, 'dado');
  // A top onto a frame has one answer, and it is not a strength joint.
  assert.deepEqual(recommendJoints('top-to-frame').map((j) => j.key), ['buttons']);
  assert.deepEqual(recommendJoints('nonsense'), []);
});

// ---------- sag ----------

test('maximum spans match the published shelving tables', () => {
  // Composite Panel Association, "Particleboard & MDF for Shelving", Table 1:
  // M-2 particleboard (MOE 290,100 psi) at 30 lb/ft2, span/240 deflection.
  const m2 = 290100;
  close(maxSpan({ depth: 12, thickness: 0.75, moe: m2, psf: 30 }), 25.0, 0.01);
  close(maxSpan({ depth: 12, thickness: 0.625, moe: m2, psf: 30 }), 20.8, 0.01);
  close(maxSpan({ depth: 12, thickness: 0.5, moe: m2, psf: 30 }), 16.7, 0.01);
  close(maxSpan({ depth: 12, thickness: 0.75, moe: 250200, psf: 30 }), 23.8, 0.01);   // PBU
  close(maxSpan({ depth: 12, thickness: 0.75, moe: m2, psf: 50 }), 21.1, 0.01);
  // Depth cancels out - a deeper shelf carries proportionally more load, which
  // is why the published tables don't list it.
  close(maxSpan({ depth: 24, thickness: 0.75, moe: m2, psf: 30 }), 25.0, 0.01);
});

test('sag: thickness cubed beats everything else', () => {
  const shelf = { span: 36, depth: 10, moe: WOOD['red-oak'].moe, psf: LOADS_PSF.books };
  const thin = sag({ ...shelf, thickness: 0.75 }).inches;
  const thick = sag({ ...shelf, thickness: 1.5 }).inches;
  close(thin / thick, 8, 0.01);                       // twice as thick, an eighth the sag
  const short = sag({ ...shelf, span: 18, thickness: 0.75 }).inches;
  close(thin / short, 16, 0.01);                      // half the span, a sixteenth (L^4 spread)
  // A load in the middle rather than spread out deflects 1.6x as much.
  const total = sag({ ...shelf, thickness: 0.75 }).load;
  const point = sag({ span: 36, depth: 10, thickness: 0.75, moe: shelf.moe, psf: 0, point: total });
  close(point.inches / thin, 1.6, 0.01);
  assert.equal(sag({ span: 0, depth: 10, thickness: 1, moe: 1e6 }), null);
});

test('the thickness a span needs', () => {
  const t = thicknessFor({ span: 36, depth: 10, moe: PANELS.mdf.moe, psf: LOADS_PSF.books });
  // Check it round-trips: at that thickness the sag is right on the limit.
  const s = sag({ span: 36, depth: 10, thickness: t.needed, moe: PANELS.mdf.moe, psf: LOADS_PSF.books });
  close(s.inches, 36 / SAG_LIMITS.loose, 0.001);
  assert.ok(t.buy >= t.needed && t.buy % 0.25 === 0);
});

// ---------- ergonomics ----------

test('piece types and heights', () => {
  assert.equal(pieceTypeFrom('Shaving Horse'), 'shaving horse');
  assert.equal(pieceTypeFrom('Roubo workbench'), 'workbench');
  assert.equal(pieceTypeFrom('Walnut dining table'), 'dining table');
  assert.equal(pieceTypeFrom('Counter stool'), 'counter stool');   // longest name wins
  assert.equal(pieceTypeFrom('Trestle table'), 'dining table');
  assert.equal(pieceTypeFrom('Birdhouse'), null);
  assert.equal(checkHeight('dining table', 29.5).ok, true);
  assert.equal(checkHeight('dining table', 34).ok, false);
  assert.equal(checkHeight('dining chair', 21).ok, false);
  assert.equal(checkHeight('dining chair', 21).what, 'seat height');
  assert.equal(checkHeight('birdhouse', 20), null);
});

// ---------- the review engine ----------

const part = (o) => ({
  count: 1, category: 'Wood', wood: true, sawn: 'unknown',
  touches: [], tenons: [], mortises: [], butts: [], cuts: [], holes: [], ...o,
});
const ALONG = [1, 0, 0], ACROSS = [0, 0, 1];

test('a top screwed across a rail is flagged as cross-grain', () => {
  const top = part({ key: 'top', name: 'Top', dims: [40, 24, 0.875], props: WOOD.maple, grain: ALONG, across: ACROSS, horizontal: true, touches: [{ key: 'rail', name: 'End rail', span: 22 }] });
  const rail = part({ key: 'rail', name: 'End rail', dims: [22, 3, 0.875], props: WOOD.maple, grain: ACROSS, across: ALONG });
  const { findings } = reviewModel({ title: 'Table', parts: [top, rail] });
  const cross = findings.find((f) => f.rule === 'cross-grain');
  assert.ok(cross, 'expected a cross-grain finding');
  assert.equal(cross.severity, 'problem');
  assert.equal(cross.key, 'top');            // reported against the wide part
  assert.deepEqual(cross.parts.sort(), ['rail', 'top']);
  assert.match(cross.fix, /slot|button/i);
  assert.ok(cross.why.length > 40, 'a finding explains itself');
  // It is reported once, not once per direction.
  assert.equal(findings.filter((f) => f.rule === 'cross-grain').length, 1);
  // And the top's own movement is worth knowing either way.
  assert.ok(findings.some((f) => f.rule === 'wide-board' && f.key === 'top'));
});

test('cross-grain is judged on the direction the wood moves, and how far', () => {
  // A narrow frame: grain crosses at every joint, and none of them split.
  const rail = part({ key: 'r', name: 'Rail', dims: [24, 3, 0.75], props: WOOD.maple, grain: ALONG, across: ACROSS, touches: [{ key: 'l', name: 'Leg', span: 3 }] });
  const leg = part({ key: 'l', name: 'Leg', dims: [29, 3, 0.75], props: WOOD.maple, grain: [0, 1, 0], across: ALONG });
  assert.equal(reviewModel({ parts: [rail, leg] }).findings.some((f) => f.rule === 'cross-grain'), false);
  // A wide top with a rail running the same way as its grain: the top's width
  // is still free to move, so there is nothing to say.
  const along = part({ key: 't', name: 'Top', dims: [60, 30, 1], props: WOOD.maple, grain: ALONG, across: ACROSS, touches: [{ key: 'a', name: 'Long apron', span: 26 }] });
  const apron = part({ key: 'a', name: 'Long apron', dims: [50, 4, 1], props: WOOD.maple, grain: ALONG, across: [0, 1, 0] });
  assert.equal(reviewModel({ parts: [along, apron] }).findings.some((f) => f.rule === 'cross-grain'), false);
  // An 8in board held by two legs whose grain runs the way it moves: real but
  // small movement, so it is a thing to get right, not a thing that will fail.
  const bench = part({ key: 'b', name: 'Bench', dims: [46, 8, 1.625], props: WOOD.maple, grain: ALONG, across: ACROSS, touches: [{ key: 'l1', name: 'Front leg', span: 8 }, { key: 'l2', name: 'Rear leg', span: 8 }] });
  const legs = ['l1', 'l2'].map((k, i) => part({ key: k, name: `${i ? 'Rear' : 'Front'} leg`, dims: [20, 2, 2], props: WOOD.maple, grain: ACROSS, across: ALONG }));
  const got = reviewModel({ parts: [bench, ...legs] }).findings.filter((f) => f.rule === 'cross-grain');
  assert.equal(got.length, 1);
  assert.equal(got[0].severity, 'watch');
  assert.match(got[0].text, /Front leg and Rear leg/);
  assert.deepEqual(got[0].parts.sort(), ['b', 'l1', 'l2']);
  // A joint the design says is free to slide has already dealt with it.
  const freed = [{ ...bench, freeOf: ['l1', 'l2'] }, ...legs];
  assert.equal(reviewModel({ parts: freed }).findings.some((f) => f.rule === 'cross-grain'), false);
});

test('parts running the same way, or in plywood, are left alone', () => {
  const a = part({ key: 'a', name: 'Board A', dims: [40, 8, 0.75], props: WOOD.cherry, grain: ALONG, across: ACROSS, touches: [{ key: 'b', name: 'Board B', span: 40 }] });
  const b = part({ key: 'b', name: 'Board B', dims: [40, 8, 0.75], props: WOOD.cherry, grain: [-1, 0, 0], across: ACROSS });
  assert.equal(reviewModel({ parts: [a, b] }).findings.filter((f) => f.rule === 'cross-grain').length, 0);
  const ply = part({ key: 'p', name: 'Panel', dims: [40, 24, 0.75], props: PANELS.plywood, grain: ALONG, across: ACROSS, touches: [{ key: 'r', name: 'Rail', span: 22 }] });
  const rail = part({ key: 'r', name: 'Rail', dims: [22, 3, 0.75], props: PANELS.plywood, grain: ACROSS, across: ALONG });
  const f = reviewModel({ parts: [ply, rail] }).findings;
  assert.equal(f.filter((x) => x.family === 'movement').length, 0);
});

test('a sagging shelf is caught, a stiff one is not', () => {
  const shelf = (props, thickness) => part({ key: 's', name: 'Shelf', dims: [36, 10, thickness], props, horizontal: true, supportSpan: 36 });
  const soft = reviewModel({ parts: [shelf(PANELS.particleboard, 0.75)] }).findings.find((f) => f.rule === 'sag');
  assert.ok(soft, 'particleboard over 36in should sag');
  assert.match(soft.fix, /Shorten the span to 2[0-9]/);
  assert.match(soft.fix, /1"|1-1\/4"/);
  assert.equal(reviewModel({ parts: [shelf(WOOD['red-oak'], 0.75)] }).findings.some((f) => f.rule === 'sag'), false);
  // Upright parts and unsupported ones aren't shelves.
  const upright = { ...shelf(PANELS.particleboard, 0.75), horizontal: false };
  assert.equal(reviewModel({ parts: [upright] }).findings.some((f) => f.rule === 'sag'), false);
});

test('joinery, stock and fastening rules on one part', () => {
  const leg = part({ key: 'leg', name: 'Leg', dims: [29, 3.5, 3.5], props: WOOD.maple, grain: [0, 1, 0] });
  const rail = part({
    key: 'rail', name: 'Rail', dims: [40, 6, 1.5], props: WOOD.maple, grain: ALONG,
    tenons: [{ into: 'Leg', intoKey: 'leg', thickness: 0.5, length: 1, width: 3.5, through: false }],
    cuts: [{ kind: 'dado', depth: 0.875, through: false }],
    holes: [{ diameter: 0.375, fromEnd: 0.5 }],
  });
  const by = (id) => reviewModel({ parts: [leg, rail] }).findings.filter((f) => f.rule === id);
  assert.ok(by('tenon-proportions').length >= 2);                  // short and wide
  assert.ok(by('tenon-proportions').every((f) => f.key === 'rail'));
  assert.equal(by('dado-depth').length, 1);
  assert.match(by('dado-depth')[0].fix, /1\/2"/);                  // a third of 1-1/2
  assert.equal(by('hole-near-end').length, 1);
  assert.equal(by('thickness-waste').length, 1);                   // 1-1/2 wants 8/4
  assert.match(by('thickness-waste')[0].fix, /6\/4/);
  // The same trade on a small part saves a tenth of a board foot: true, but
  // not worth a line of anyone's attention.
  const offcut = part({ key: 'o', name: 'Block', dims: [6, 2, 1.5], props: WOOD.maple, grain: ALONG });
  assert.equal(reviewModel({ parts: [offcut] }).findings.some((f) => f.rule === 'thickness-waste'), false);
});

test('softwood at a stocked size is called out, and heights checked', () => {
  const stud = part({ key: 'p', name: 'Post', dims: [36, 3.5, 1.5], props: WOOD.pine, grain: ALONG });
  const r = reviewModel({ title: 'Dining table', height: 34, parts: [stud] });
  assert.match(r.findings.find((f) => f.rule === 'off-the-rack').text, /2×4/);
  const h = r.findings.find((f) => f.rule === 'height');
  assert.ok(h && h.key === null);
  assert.match(h.text, /29-30in/);
  assert.equal(reviewModel({ title: 'Dining table', height: 29.5, parts: [stud] }).findings.some((f) => f.rule === 'height'), false);
  // A seat is measured at the seat, not over the back of the chair.
  const tall = { title: 'Dining chair', height: 36, seatHeight: 17.5, parts: [stud] };
  assert.equal(reviewModel(tall).findings.some((f) => f.rule === 'height'), false);
  const low = reviewModel({ ...tall, seatHeight: 13 }).findings.find((f) => f.rule === 'height');
  assert.match(low.text, /seat 13" off the ground/);
  // No seat height measured means nothing to say about it.
  assert.equal(reviewModel({ title: 'Dining chair', height: 36, parts: [stud] }).findings.some((f) => f.rule === 'height'), false);
});

test('short grain is flagged', () => {
  const p = part({ key: 'b', name: 'Bracket', dims: [4, 9, 0.75], props: WOOD.oak || WOOD['red-oak'], grain: ALONG });
  assert.ok(reviewModel({ parts: [p] }).findings.some((f) => f.rule === 'short-grain'));
});

test('findings are ordered worst first and counted', () => {
  const top = part({ key: 'top', name: 'Top', dims: [40, 24, 0.875], props: WOOD.maple, grain: ALONG, across: ACROSS, horizontal: true, touches: [{ key: 'rail', name: 'Rail', span: 22 }] });
  const rail = part({ key: 'rail', name: 'Rail', dims: [22, 3, 0.875], props: WOOD.maple, grain: ACROSS, across: ALONG, butts: [{ key: 'top', name: 'Top' }] });
  const r = reviewModel({ parts: [top, rail] });
  assert.equal(r.findings[0].severity, 'problem');
  assert.equal(r.counts.problem, 1);
  assert.ok(r.counts.watch >= 1 && r.counts.note >= 1);
  assert.ok(r.swing > 6 && r.swing < 7);
  // Rules can be run one family at a time, for the panel's filters.
  assert.ok(reviewModel({ parts: [top, rail] }, { only: ['movement'] }).findings.every((f) => f.family === 'movement'));
});

test('a model that knows nothing about itself produces no noise', () => {
  const bare = { key: 'x', name: 'Group 12', dims: [10, 2, 1], wood: false, category: 'Other' };
  const r = reviewModel({ parts: [bare, { key: 'y', name: 'Board', dims: [10, 2, 1], wood: true, category: 'Wood' }] });
  assert.equal(r.counts.problem, 0);
  assert.ok(r.findings.every((f) => f.text && f.why && f.fix));
});

test('metric and decimal units carry through the findings', () => {
  const shelf = part({ key: 's', name: 'Shelf', dims: [36, 10, 0.75], props: PANELS.mdf, horizontal: true, supportSpan: 36 });
  const mm = reviewModel({ parts: [shelf] }, { units: 'mm' }).findings.find((f) => f.rule === 'sag');
  assert.match(mm.text, /mm/);
  const dec = reviewModel({ parts: [shelf] }, { units: 'dec' }).findings.find((f) => f.rule === 'sag');
  assert.match(dec.text, /0\.75"/);
  assert.doesNotMatch(dec.text, /\d-\d+\/\d/);   // no fractions in decimal mode
});

// ---------- the panel's own output ----------

test('the panel and the printed sheet render the findings', async () => {
  const { reviewHtml, reviewPrintHtml } = await import('../viewer/designreview.js');
  const shelf = part({ key: 's', name: 'Shelf <b>', letter: 'A', dims: [36, 10, 0.75], props: PANELS.particleboard, horizontal: true, supportSpan: 36 });
  const wide = part({ key: 'w', name: 'Top', dims: [40, 30, 0.875], props: WOOD['white-oak'], grain: ALONG });
  const result = reviewModel({ parts: [shelf, wide] });
  const html = reviewHtml(result, { open: true });
  assert.match(html, /Design review/);
  assert.match(html, /data-key="s"/);
  assert.doesNotMatch(html, /<b>Shelf/);              // the part name is escaped
  assert.match(html, /Shelf &lt;b&gt;/);
  assert.match(html, /dr-why/);
  assert.match(html, /dr-fix/);
  // Paper gets what to do differently, not the trivia.
  const print = reviewPrintHtml(result);
  assert.match(print, /Design review/);
  assert.match(print, /Will sag/);
  assert.doesNotMatch(print, /Moves with the seasons/);
  assert.equal(reviewPrintHtml({ findings: [] }), '');
  assert.equal(reviewPrintHtml(null), '');
  // Nothing to say is worth saying too.
  assert.match(reviewHtml({ findings: [], counts: {} }), /nothing to flag/);
});
