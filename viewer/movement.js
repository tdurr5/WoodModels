// How much a board changes size with the seasons - the number behind most of
// the "this will split" rules in review.js.
//
// Wood is stable along the grain (0.1-0.2% green to ovendry, ignored here) and
// moves across it. So a part's length never really changes; its width and
// thickness do, and anything that holds a wide board's width fixed - a rail
// screwed across its grain, a panel glued into a frame - eventually loses to
// it. The job of these functions is to put inches on that.
//
// Sources:
// - Equilibrium moisture content from relative humidity and temperature:
//   Eckelman, "The Shrinking and Swelling of Wood and Its Effect on
//   Furniture" (Purdue FNR-163), Appendix II.
// - Movement from a moisture content change: same paper,
//   dW = W x (SC / 100) x (dmc / 30), where SC is the species' total
//   green-to-ovendry shrinkage (see woodprops.js) and 30 is the fiber
//   saturation point, the moisture content below which wood starts moving.
// - The fallback "2 percent rule": allow 2% of movement across the grain,
//   about an 8-point moisture swing (4% to 12%), enough for almost anywhere
//   in the US. Same paper.

// Moisture content wood settles at, in percent, after long enough at this
// relative humidity (0-100) and temperature (F).
export function emc(rh, tempF = 70) {
  const phi = Math.min(0.995, Math.max(0.005, rh / 100));
  return Math.pow(-Math.log(1 - phi) / (4.5e-5 * (tempF + 460)), 0.638);
}

// A heated, lived-in room: dry in winter, humid in summer. About a 6.5-point
// moisture swing, close to the conservative 2% rule.
export const DEFAULT_ENV = { rhLow: 30, rhHigh: 70, tempF: 70 };

// The moisture swing a piece will see, in percentage points.
// Either from a humidity range, or given directly as `mcSwing`.
export function mcSwing(env = DEFAULT_ENV) {
  if (env?.mcSwing != null) return env.mcSwing;
  const e = { ...DEFAULT_ENV, ...(env || {}) };
  return Math.abs(emc(e.rhHigh, e.tempF) - emc(e.rhLow, e.tempF));
}

export const FIBER_SATURATION = 30;

// The shrinkage coefficient to use for a face, in percent.
// Flatsawn boards move tangentially (the most); quartersawn radially (about
// half as much). Plain boards off the rack are a mix, so `sawn: 'unknown'`
// takes the tangential figure - the one that won't surprise you.
export function shrinkageCoefficient(props, sawn = 'unknown') {
  if (!props || props.moves === false) return 0;
  if (sawn === 'quartersawn' || sawn === 'rift') return props.shrinkR;
  return props.shrinkT;
}

// Across-grain movement of a dimension, in the same units in.
// { total } is the full seasonal range, { each } the swing either side of the
// size you built it at.
export function movement(width, props, { env = DEFAULT_ENV, sawn = 'unknown' } = {}) {
  const sc = shrinkageCoefficient(props, sawn);
  if (!width || !sc) return { total: 0, each: 0, percent: 0, swing: mcSwing(env) };
  const swing = mcSwing(env);
  const total = width * (sc / 100) * (swing / FIBER_SATURATION);
  return { total, each: total / 2, percent: (total / width) * 100, swing };
}

// Panels glued up from narrow strips move exactly as much as one wide board:
// the movement is the sum of the strips, which is the panel's width. Worth
// stating, because "I glued it up so it won't move" is a common belief.
export const gluedPanelMovement = movement;

// Fraction of a wide part's width that is safe to hold rigidly across the
// grain. Under about 3 inches, movement is small enough that glue and the
// wood's own give absorb it; past that it has to be free to slide.
export const RIGID_CROSS_GRAIN_LIMIT = 3;

// A fastened joint that crosses the grain: what it has to allow for.
// `span` is the distance between the outermost fixings across the grain.
export function slotAllowance(span, props, opts) {
  const m = movement(span, props, opts);
  // Round up to the next 1/16in, and never suggest less than 1/16in: a slot
  // you can't see the point of doesn't get cut.
  const each = Math.max(1 / 16, Math.ceil(m.each * 16) / 16);
  return { ...m, each, slot: each * 2 };
}
