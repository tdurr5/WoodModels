// What a lumber yard actually sells: the sizes you can buy, not the sizes you
// can imagine. A design drawn in round numbers ("2 inches thick") quietly
// commits you to milling a thicker board down and paying for the shavings, so
// the rules in review.js check every wood part against this catalogue, and the
// designer picks parts from it.
//
// Softwood (the 1x/2x rack): sold by a nominal size that is bigger than what
// you get. A 2x4 is 1-1/2 x 3-1/2 because the nominal size is the green,
// rough-sawn size before drying and planing. Widths lose 1/2in up to 6in
// nominal and 3/4in from 8in up.
//
// Hardwood: sold rough by the quarter-inch of thickness (4/4, 5/4, 8/4...) in
// random widths, so only thickness is standard. `s2s` is what you get if the
// yard surfaces both faces for you; `rough` is what you start with if you
// thickness it yourself.
//
// Sheet goods: nominal 3/4in plywood has been 23/32in for decades (metric
// tooling), which matters the moment you cut a dado to fit it.
//
// Sources: US softwood dimensions per PS 20 / the standard yard chart,
// hardwood thicknesses per NHLA surfaced-two-sides practice.

// [actual, nominal] pairs, thinnest first.
export const NOMINAL_THICKNESS = [[0.75, 1], [1.5, 2], [2.5, 3], [3.5, 4], [5.5, 6], [7.25, 8]];
export const NOMINAL_WIDTH = [[1.5, 2], [2.5, 3], [3.5, 4], [5.5, 6], [7.25, 8], [9.25, 10], [11.25, 12]];

// Softwood is stocked in even lengths; a board may run up to 3in long.
export const SOFTWOOD_LENGTHS = [6, 8, 10, 12, 14, 16, 18, 20, 22, 24].map((ft) => ft * 12);

// Hardwood thickness by the quarter. `rough` is the nominal quarter size,
// `s2s` the thickness after the yard planes both faces.
export const HARDWOOD_QUARTERS = [
  { quarter: '4/4', rough: 1, s2s: 13 / 16 },
  { quarter: '5/4', rough: 1.25, s2s: 1 + 1 / 16 },
  { quarter: '6/4', rough: 1.5, s2s: 1 + 5 / 16 },
  { quarter: '8/4', rough: 2, s2s: 1.75 },
  { quarter: '10/4', rough: 2.5, s2s: 2 + 3 / 16 },
  { quarter: '12/4', rough: 3, s2s: 2.75 },
  { quarter: '16/4', rough: 4, s2s: 3.75 },
];

// Sheet sizes, in inches. 5x5 is Baltic birch; 2x4 and 4x4 are the handy
// panels sold for people without a truck.
export const SHEET_SIZES = [
  { name: '4×8', w: 48, l: 96 },
  { name: '5×5', w: 60, l: 60 },
  { name: '4×4', w: 48, l: 48 },
  { name: '2×4', w: 24, l: 48 },
  { name: '5×10', w: 60, l: 120 },
];

// [nominal, actual] panel thicknesses. MDF and particleboard come in the
// nominal size; plywood is undersized.
export const PLYWOOD_THICKNESS = [[0.25, 7 / 32], [3 / 8, 11 / 32], [0.5, 15 / 32], [5 / 8, 19 / 32], [0.75, 23 / 32]];
export const PANEL_THICKNESS = [0.25, 3 / 8, 0.5, 5 / 8, 0.75, 1];

// Dowel and round stock diameters you can buy without turning them.
export const DOWEL_DIAMETERS = [0.25, 5 / 16, 3 / 8, 0.5, 5 / 8, 0.75, 1, 1.25, 1.5];

const near = (list, v, tol) => list.find(([actual]) => Math.abs(actual - v) <= tol);

// The dimensional-lumber name for a thickness x width, e.g. 1-1/2in x 3-1/2in
// is a 2x4 - stock you can buy surfaced, no milling. Null if it isn't one.
export function dimensionalSize(thickness, width, tol = 1 / 32) {
  const t = near(NOMINAL_THICKNESS, thickness, tol)?.[1];
  const w = near(NOMINAL_WIDTH, width, tol)?.[1];
  return t && w && t <= w ? `${t}×${w}` : null;
}

// The hardwood thickness to buy for a finished thickness, and what it wastes.
// `allowance` is what you plane off getting a rough board flat and true
// (1/8in is the usual figure for a board you have to joint and thickness).
// Returns the quarter, plus the next thinner one and what you'd have to give
// up to use it - the trade the design review offers you.
export function hardwoodStock(finished, allowance = 0.125) {
  const needed = finished + allowance;
  const i = HARDWOOD_QUARTERS.findIndex((q) => q.rough >= needed - 1e-9);
  if (i < 0) return null;
  const pick = HARDWOOD_QUARTERS[i], thinner = HARDWOOD_QUARTERS[i - 1] || null;
  return {
    ...pick,
    waste: pick.rough - finished,
    // How thick the part could be if it came out of the next quarter down.
    thinner: thinner ? { ...thinner, maxFinished: thinner.rough - allowance } : null,
    // Buying it surfaced only works if S2S is still thick enough.
    s2sWorks: pick.s2s >= finished - 1e-9,
  };
}

// Board feet of a rough board: the unit hardwood is priced in.
export const boardFeetOf = (l, w, t) => (l * w * Math.max(1, t)) / 144;

// Everything buyable for a species, for the designer's stock picker: the
// softwood rack if it's a softwood, hardwood quarters either way (most yards
// will sell you 4/4 pine too), and the sheet products.
export function stockFor(props) {
  const softwood = props?.type === 'softwood';
  return {
    dimensional: softwood ? NOMINAL_THICKNESS.flatMap(([t, tn]) => NOMINAL_WIDTH
      .filter(([, wn]) => wn >= tn).map(([w, wn]) => ({ name: `${tn}×${wn}`, thickness: t, width: w, lengths: SOFTWOOD_LENGTHS }))) : [],
    quarters: HARDWOOD_QUARTERS,
    sheets: SHEET_SIZES,
    dowels: DOWEL_DIAMETERS,
  };
}
