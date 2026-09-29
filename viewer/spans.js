// Will it sag? Beam deflection for shelves, seats and any board carrying a
// load between two supports.
//
// Two things make this worth calculating rather than guessing:
// - thickness is cubed, so 1in stock is 2.4x as stiff as 3/4in, and
// - span is cubed the other way, so moving the supports 6in closer does more
//   than changing the material.
//
// delta = 5 w L^4 / (384 E I) for an evenly spread load on a shelf supported
// at both ends, where w is the load per inch of span, L the span, E the
// modulus of elasticity (woodprops.js) and I = depth x thickness^3 / 12.
// A load in the middle instead of spread out deflects 1.6x as much:
// delta = P L^3 / (48 E I).
//
// The limit is span/240, the shelving industry's figure (Composite Panel
// Association, "Particleboard & MDF for Shelving") - about 1/8in over 30in.
// span/360 is the cabinetmaker's stricter one. Either way the eye picks up
// about 1/32in per foot of span, so a long shelf can pass the ratio and still
// look bowed.

export const SAG_LIMITS = { loose: 240, tight: 360 };
// Books packed on a shelf come to about 30 lb per square foot; a shelf of
// records or tools closer to 50. Both are within the range the span tables use.
export const LOADS_PSF = { light: 15, books: 30, heavy: 50 };

const momentOfInertia = (depth, thickness) => (depth * thickness ** 3) / 12;

// Deflection in inches at the middle of the span.
// span, depth, thickness in inches; moe in lbf/in2; load in lb/ft2 spread
// evenly, or { point: lb } for a single load in the middle.
export function sag({ span, depth, thickness, moe, psf = LOADS_PSF.books, point = 0 }) {
  if (!(span > 0) || !(depth > 0) || !(thickness > 0) || !(moe > 0)) return null;
  const I = momentOfInertia(depth, thickness);
  const w = (psf / 144) * depth;               // lb per inch of span
  const spread = (5 * w * span ** 4) / (384 * moe * I);
  const middle = point ? (point * span ** 3) / (48 * moe * I) : 0;
  const total = spread + middle;
  return {
    inches: total,
    ratio: total > 0 ? span / total : Infinity,   // span/N, bigger is stiffer
    perFoot: total / (span / 12),
    load: w * span + point,
  };
}

// The longest span that still meets a deflection limit, in inches.
export function maxSpan({ depth, thickness, moe, psf = LOADS_PSF.books, limit = SAG_LIMITS.loose }) {
  if (!(depth > 0) || !(thickness > 0) || !(moe > 0)) return null;
  const I = momentOfInertia(depth, thickness);
  const w = (psf / 144) * depth;
  if (!(w > 0)) return null;
  return Math.cbrt((384 * moe * I) / (5 * w * limit));
}

// The thickness needed to carry a span, rounded up to something you can buy
// (a quarter of an inch at a time).
export function thicknessFor({ span, depth, moe, psf = LOADS_PSF.books, limit = SAG_LIMITS.loose }) {
  if (!(span > 0) || !(depth > 0) || !(moe > 0)) return null;
  const w = (psf / 144) * depth;
  // Invert delta = span/limit for thickness: t^3 = 5 w L^4 limit x 12 / (384 E depth L)
  const t3 = (5 * w * span ** 3 * limit * 12) / (384 * moe * depth);
  const needed = Math.cbrt(t3);
  return { needed, buy: Math.ceil(needed * 4) / 4 };
}

// A verdict plus the cheapest ways out of a sag, in the order worth trying:
// shorten the span (cubed), thicken the board (cubed), or stiffen the edge.
export function verdict(result, span, limit = SAG_LIMITS.loose) {
  if (!result) return null;
  const allowed = span / limit;
  return {
    ...result,
    allowed,
    ok: result.inches <= allowed,
    visible: result.perFoot > 1 / 32,   // what the eye catches
  };
}

// A lip glued along the front edge, or a back rail, turns a plank into a
// shallow beam. Worth naming as a fix, though the real number depends on how
// deep the lip is: a 1-1/2in lip on a 3/4in shelf roughly triples stiffness.
export const EDGE_LIP_NOTE = 'a 1-1/2in lip glued under the front edge stiffens a 3/4in shelf about threefold - cheaper than thicker stock';
