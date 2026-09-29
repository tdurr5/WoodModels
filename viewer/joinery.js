// Joint proportions and which joint belongs where.
//
// The one fact the rest of this file follows from: a glue line between two
// long-grain faces is stronger than the wood around it, and a glue line onto
// end grain is worth almost nothing - end grain drinks the glue and has no
// long fibres to hold. So a joint's real job is to turn an end-grain meeting
// into long-grain glue surface plus a mechanical interlock. A mortise and
// tenon isn't tradition; it's the cheapest way to give a rail's end four
// long-grain cheeks inside the leg.
//
// The proportions below are the standard ones, with the reason each exists:
// - Tenon thickness 1/3 of the rail: equal shoulders either side, and mortise
//   walls thick enough not to bulge. (Machine mortisers often go to 1/2;
//   1/3 is the figure that works by hand and by machine.)
// - Tenon length at least 5x its thickness: shorter and the glue area is too
//   small to resist the rail levering out.
// - Tenon width at most 6x its thickness, else twin tenons: a wide tenon
//   shrinks across its width and shears its own glue line.
// - A mortise nearer than about 1in to the end of the mortised piece blows
//   the end out; drop it down and haunch the tenon instead.
// - Dado depth 1/3 of the stock, 1/2 at the very most: deeper and the housed
//   board is doing nothing but weakening the one that houses it.
//
// Sources: Ellis, "Modern Practical Joinery" (tenon width and haunch);
// Popular Woodworking's summary of the tenon rules; standard yard practice
// for dados, dowels and dovetail slopes (1:8 hardwood, 1:6 softwood).

// Mortise widths you can actually cut: chisel, hollow-chisel mortiser and
// straight router bit sizes. A tenon sized off this list needs no fettling.
export const CHISEL_SIZES = [1 / 8, 3 / 16, 1 / 4, 5 / 16, 3 / 8, 1 / 2, 5 / 8, 3 / 4];

export const TENON = {
  thicknessRatio: 1 / 3,
  minLengthRatio: 5,      // length >= 5 x thickness
  maxWidthRatio: 6,       // wider than this, use twin tenons
  blindDepthRatio: 2 / 3, // a stub tenon goes about 2/3 into the mortised part
  endMargin: 1,           // keep a mortise this far from the end of its part
  minShoulder: 1 / 8,     // anything less doesn't hide a gap
};
export const DADO = { depthRatio: 1 / 3, maxDepthRatio: 1 / 2 };
export const DOWEL = { diameterRatio: 1 / 3, maxDiameterRatio: 1 / 2, minLengthRatio: 2.5, minPerJoint: 2 };
export const DOVETAIL = { hardwoodSlope: 8, softwoodSlope: 6 };
// A screw into end grain holds roughly a third of what it holds into face
// grain, and splits the piece if it lands within about 5 diameters of the end.
export const SCREW = { endGrainHolding: 1 / 3, minEndDistanceRatio: 5, minPenetrationRatio: 2 };

const nearest = (list, v) => list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

// The tenon to cut for a rail going into a leg (or any mortised part).
// Sizes are the ones the rules quote back when a model's own tenon differs.
export function tenonFor({ railThickness, railWidth, intoThickness, through = false }) {
  if (!railThickness || !intoThickness) return null;
  const ideal = railThickness * TENON.thicknessRatio;
  let thickness = nearest(CHISEL_SIZES, ideal);
  // Never leave a mortise wall thinner than the tenon itself.
  while (thickness > CHISEL_SIZES[0] && (intoThickness - thickness) / 2 < thickness) {
    thickness = CHISEL_SIZES[CHISEL_SIZES.indexOf(thickness) - 1];
  }
  const length = through ? intoThickness
    : Math.min(thickness * TENON.minLengthRatio, intoThickness * TENON.blindDepthRatio);
  const wantWidth = railWidth ? railWidth / 2 : 0;
  const maxWidth = thickness * TENON.maxWidthRatio;
  const twin = wantWidth > maxWidth;
  return {
    thickness,
    length,
    width: twin ? maxWidth : wantWidth,
    twin,
    count: twin ? 2 : 1,
    shoulder: railWidth ? (railWidth - (twin ? maxWidth * 2 : wantWidth)) / 2 : 0,
    short: length < thickness * TENON.minLengthRatio,
  };
}

// What's wrong with a tenon a model already draws. Returns [] when it's fine.
// Every entry is { id, text, fix } - the rules engine adds the part names.
// `f` formats a length, so the finding reads in whatever units are on screen.
export function checkTenon({ thickness, length, width, railThickness, intoThickness, through, fromEnd }, f = round16) {
  const out = [];
  const ratio = railThickness ? thickness / railThickness : null;
  if (ratio != null && ratio < 0.2) {
    out.push({ id: 'tenon-thin', text: `is ${Math.round(ratio * 100)}% of the rail's thickness`, fix: 'a third is the usual proportion: it doubles the glue area without thinning the mortise walls' });
  } else if (ratio != null && ratio > 0.55) {
    out.push({ id: 'tenon-fat', text: `is ${Math.round(ratio * 100)}% of the rail's thickness`, fix: 'a third to a half is the range; past that the mortise walls are thinner than the tenon and bulge when you clamp' });
  }
  if (length && length < thickness * TENON.minLengthRatio) {
    out.push({ id: 'tenon-short', text: `is ${f(length)} long, under 5 x its ${f(thickness)} thickness`, fix: `make it ${f(thickness * TENON.minLengthRatio)}, or as deep as the part it goes into allows` });
  }
  if (!through && intoThickness && length > intoThickness * 0.85) {
    out.push({ id: 'tenon-bottoms', text: 'reaches almost through the part it goes into', fix: 'stop at two-thirds, or commit to a through tenon and wedge it' });
  }
  if (width && width > thickness * TENON.maxWidthRatio) {
    out.push({ id: 'tenon-wide', text: `is ${f(width)} wide, over 6 x its thickness`, fix: 'split it into twin tenons with a bridge between: the same glue area, without a wide tenon shearing itself as it shrinks' });
  }
  if (fromEnd != null && fromEnd < TENON.endMargin) {
    out.push({ id: 'mortise-end', text: `sits ${f(fromEnd)} from the end of the mortised part`, fix: `keep about ${f(TENON.endMargin)} of solid wood past a mortise, or haunch the tenon - a mortise this close blows the end out` });
  }
  return out;
}

const round16 = (v) => `${Math.round(v * 16) / 16}in`;

// Dado / housing depth for a shelf into a case side.
export function dadoFor(stockThickness) {
  return { depth: stockThickness * DADO.depthRatio, max: stockThickness * DADO.maxDepthRatio };
}

// Dowels for a joint: how big, how long, how many.
export function dowelsFor({ thickness, width }) {
  const size = Math.min(nearest([0.25, 5 / 16, 3 / 8, 0.5], thickness * DOWEL.diameterRatio),
    thickness * DOWEL.maxDiameterRatio);
  const count = Math.max(DOWEL.minPerJoint, Math.floor((width || 0) / (size * 4)) || DOWEL.minPerJoint);
  return { diameter: size, length: size * DOWEL.minLengthRatio * 2, perSide: size * DOWEL.minLengthRatio, count };
}

// ---------- which joint belongs where ----------
// `loads` is what the joint has to survive, which is what actually picks it:
//   racking  - a frame being pushed out of square (table, chair, any 4 rails)
//   shear    - weight bearing straight down on a shelf
//   tension  - being pulled apart (a drawer front, a stretcher under a chair)
//   none     - held by its own weight or captured by other parts
// `needs` is the tooling, so a shop without a router isn't sent to one.
export const JOINTS = {
  'mortise-tenon': { name: 'Mortise and tenon', loads: ['racking', 'shear', 'tension'], needs: ['chisel'], rank: 10, note: 'the default for a rail into a leg' },
  'loose-tenon': { name: 'Loose tenon (Domino / slip tenon)', loads: ['racking', 'shear', 'tension'], needs: ['router'], rank: 9, note: 'same joint, mortises in both parts' },
  'wedged-through-tenon': { name: 'Wedged through tenon', loads: ['racking', 'shear', 'tension'], needs: ['chisel'], rank: 10, note: 'mechanical even if the glue fails' },
  'round-tenon': { name: 'Round (turned) tenon', loads: ['racking', 'shear', 'tension'], needs: ['drill'], rank: 8, note: 'chair legs into a seat; wedge or drawbore it' },
  'half-lap': { name: 'Half lap', loads: ['racking', 'shear'], needs: ['saw'], rank: 7, note: 'long-grain glue both faces, easy to cut' },
  'bridle': { name: 'Bridle joint', loads: ['racking', 'shear'], needs: ['saw'], rank: 7 },
  dado: { name: 'Dado / housing', loads: ['shear'], needs: ['saw'], rank: 8, note: 'the shelf sits in a trench, so the load bears on wood, not glue' },
  'sliding-dovetail': { name: 'Sliding dovetail', loads: ['shear', 'tension'], needs: ['router'], rank: 9 },
  dovetail: { name: 'Dovetail', loads: ['tension', 'racking'], needs: ['saw', 'chisel'], rank: 10, note: 'drawer fronts: it cannot be pulled apart' },
  'box-joint': { name: 'Box joint', loads: ['tension'], needs: ['saw'], rank: 7 },
  rabbet: { name: 'Rabbet', loads: ['shear'], needs: ['saw'], rank: 5, note: 'needs screws, nails or pins to hold it' },
  dowel: { name: 'Dowels', loads: ['racking', 'shear'], needs: ['drill'], rank: 6, note: 'two or more, or the joint hinges on one' },
  biscuit: { name: 'Biscuits', loads: ['none'], needs: ['biscuit'], rank: 3, note: 'alignment, not strength' },
  'pocket-screw': { name: 'Pocket screws', loads: ['shear'], needs: ['pocket-jig'], rank: 4, note: 'quick and strong enough for a shop fixture; it racks over years' },
  'edge-glue': { name: 'Edge glue', loads: ['shear', 'tension'], needs: [], rank: 10, note: 'long grain to long grain needs nothing else' },
  'butt-screw': { name: 'Butt joint and screws', loads: ['none'], needs: ['drill'], rank: 2, note: 'the screws are the joint; the glue onto end grain is not' },
  buttons: { name: 'Buttons or slotted screws', loads: ['none'], needs: ['saw'], rank: 10, note: 'holds a top down while letting it move across the grain' },
};

// Where a connection sits in a piece -> what it has to survive, and the
// joints that suit it, best first. The order is per connection on purpose:
// a mortise and tenon is the stronger joint in the abstract, but for a shelf
// into a case side a dado is the right answer, because the load bears on
// wood instead of on a glue line.
export const CONNECTIONS = {
  'rail-to-leg': { loads: ['racking', 'tension'], label: 'a rail into a leg', prefer: ['mortise-tenon', 'loose-tenon', 'wedged-through-tenon', 'dowel', 'pocket-screw'] },
  'stretcher-to-leg': { loads: ['tension', 'racking'], label: 'a stretcher into a leg', prefer: ['mortise-tenon', 'round-tenon', 'loose-tenon', 'dowel'] },
  'shelf-to-side': { loads: ['shear'], label: 'a shelf into a case side', prefer: ['dado', 'sliding-dovetail', 'rabbet', 'pocket-screw'] },
  'case-corner': { loads: ['tension', 'racking'], label: 'a case corner', prefer: ['dovetail', 'box-joint', 'loose-tenon', 'rabbet'] },
  'drawer-corner': { loads: ['tension'], label: 'a drawer corner', prefer: ['dovetail', 'box-joint', 'rabbet'] },
  'leg-to-slab': { loads: ['racking', 'tension'], label: 'a leg into a slab seat or top', prefer: ['round-tenon', 'wedged-through-tenon', 'mortise-tenon'] },
  'top-to-frame': { loads: ['none'], label: 'a top onto its frame', prefer: ['buttons'] },
  'edge-to-edge': { loads: ['shear', 'tension'], label: 'boards edge to edge into a panel', prefer: ['edge-glue', 'biscuit', 'dowel'] },
};

// Joints that suit a connection, best first: the ones this shop can cut come
// before the ones it can't, so the caller can take the top two and be right.
// `tools` defaults to a hand-tool shop plus a drill: the smallest kit that can
// still cut real joinery.
export function recommendJoints(connection, { tools = ['saw', 'chisel', 'drill'] } = {}) {
  const conn = CONNECTIONS[connection];
  if (!conn) return [];
  const have = new Set(tools);
  return conn.prefer
    .filter((key) => JOINTS[key])
    .map((key) => ({ key, ...JOINTS[key], canCut: JOINTS[key].needs.every((n) => have.has(n)) }))
    .sort((a, b) => b.canCut - a.canCut);   // stable: keeps the preference order within each group
}
