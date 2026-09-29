// Physical properties of the species the viewer already recognises, plus the
// panel products, for the design rules in review.js: how much a board moves
// with the seasons, and how stiff it is over a span.
//
// Keyed by the same species keys as woodtex.js (which guesses them from a
// material's name), so a model that already shows the right grain in 3D gets
// the right numbers here for free.
//
// Sources (all public data):
// - shrink{R,T}: total shrinkage green to ovendry, %, USDA Wood Handbook
//   (Ag. Handbook 72 / FPL-GTR-190 Table 4-3). shrinkT is tangential
//   (flatsawn faces), shrinkR radial (quartersawn).
// - moe: modulus of elasticity in static bending at 12% moisture content,
//   lbf/in2, FPL-GTR-190 Table 5-3b. sg: specific gravity at 12%.
// - Panel products: FPL-GTR-282 Table 12-1, except particleboard and MDF,
//   which use the ANSI A208.1/A208.2 grade minimums quoted by the Composite
//   Panel Association's shelving bulletin - lower than typical, which is what
//   you want when deciding whether a shelf will sag.
//
// Each species key here covers a family in woodtex.js (`fir` is fir, spruce
// and hemlock; `pine` is any pine), so the entry names the actual species the
// numbers come from and leans conservative within the family.

export const WOOD = {
  'red-oak': { name: 'Red oak', from: 'northern red oak', type: 'hardwood', sg: 0.63, moe: 1820000, shrinkR: 4.0, shrinkT: 8.6 },
  'white-oak': { name: 'White oak', from: 'white oak', type: 'hardwood', sg: 0.68, moe: 1780000, shrinkR: 5.6, shrinkT: 10.5 },
  walnut: { name: 'Walnut', from: 'black walnut', type: 'hardwood', sg: 0.55, moe: 1680000, shrinkR: 5.5, shrinkT: 7.8 },
  cherry: { name: 'Cherry', from: 'black cherry', type: 'hardwood', sg: 0.50, moe: 1490000, shrinkR: 3.7, shrinkT: 7.1 },
  maple: { name: 'Maple', from: 'sugar maple', type: 'hardwood', sg: 0.63, moe: 1830000, shrinkR: 4.8, shrinkT: 9.9 },
  ash: { name: 'Ash', from: 'white ash', type: 'hardwood', sg: 0.60, moe: 1740000, shrinkR: 4.9, shrinkT: 7.8 },
  hickory: { name: 'Hickory', from: 'shagbark hickory', type: 'hardwood', sg: 0.72, moe: 2160000, shrinkR: 7.0, shrinkT: 10.5 },
  beech: { name: 'Beech', from: 'American beech', type: 'hardwood', sg: 0.64, moe: 1720000, shrinkR: 5.5, shrinkT: 11.9 },
  birch: { name: 'Birch', from: 'yellow birch', type: 'hardwood', sg: 0.62, moe: 2010000, shrinkR: 7.3, shrinkT: 9.5 },
  poplar: { name: 'Poplar', from: 'yellow-poplar', type: 'hardwood', sg: 0.42, moe: 1580000, shrinkR: 4.6, shrinkT: 8.2 },
  mahogany: { name: 'Mahogany', from: 'Honduran mahogany', type: 'hardwood', sg: 0.52, moe: 1460000, shrinkR: 3.6, shrinkT: 5.0 },
  pine: { name: 'Pine', from: 'eastern white pine', type: 'softwood', sg: 0.35, moe: 1240000, shrinkR: 2.1, shrinkT: 6.1 },
  larch: { name: 'Larch', from: 'western larch', type: 'softwood', sg: 0.52, moe: 1870000, shrinkR: 4.5, shrinkT: 9.1 },
  fir: { name: 'Fir / spruce', from: 'coast Douglas-fir', type: 'softwood', sg: 0.48, moe: 1950000, shrinkR: 4.8, shrinkT: 7.6 },
  cedar: { name: 'Cedar', from: 'western redcedar', type: 'softwood', sg: 0.32, moe: 1120000, shrinkR: 2.4, shrinkT: 5.0 },
};

// Panel products. `moves: false` - they're cross-banded or random-oriented, so
// they hold their size across the width; only solid wood needs movement rules.
export const PANELS = {
  plywood: { name: 'Plywood', moe: 1100000, moves: false, note: 'face grain along the span' },
  osb: { name: 'OSB', moe: 750000, moves: false, note: 'strong axis along the span' },
  particleboard: { name: 'Particleboard', moe: 290000, moves: false },
  melamine: { name: 'Melamine', moe: 290000, moves: false, note: 'particleboard core' },
  mdf: { name: 'MDF', moe: 313000, moves: false },
  hardboard: { name: 'Hardboard', moe: 550000, moves: false },
};

const PANEL_WORDS = [
  [/\bmelamine\b/, 'melamine'],
  [/\bmdf\b|medium.?density/, 'mdf'],
  [/\bosb\b|strand.?board/, 'osb'],
  [/particle|chipboard|\bpb\b/, 'particleboard'],
  [/hardboard|masonite|\bhdf\b/, 'hardboard'],
  [/plywood|\bply\b|\bbaltic\b/, 'plywood'],
];

// Which panel product a material name looks like, or null. Checked before the
// species guess, because "birch plywood" is a panel, not a birch board.
export function panelFor(...names) {
  const text = ` ${names.map((n) => String(n || '').toLowerCase()).join(' ')} `;
  for (const [re, key] of PANEL_WORDS) if (re.test(text)) return key;
  return null;
}

// Stiffness and movement for a part, from its panel/species keys.
// Returns { key, name, moe, moves, shrinkR, shrinkT, type } or null when we
// don't know what the wood is (a model that just says "Material12").
export function propsFor({ panel, species } = {}) {
  if (panel && PANELS[panel]) return { key: panel, panel: true, moves: false, ...PANELS[panel] };
  if (species && WOOD[species]) return { key: species, panel: false, moves: true, ...WOOD[species] };
  return null;
}

// A middle-of-the-road hardwood, for rules that need a number when the
// species is unknown: report it as an estimate, never as fact.
export const TYPICAL_HARDWOOD = { name: 'a typical hardwood', moe: 1600000, shrinkR: 4.6, shrinkT: 8.5, moves: true, type: 'hardwood', typical: true };
