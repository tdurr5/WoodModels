// Starting points: pieces that are already correct, with the numbers that
// make them what they are exposed as parameters.
//
// This is the fastest way to learn the proportions. A blank canvas teaches
// nothing; a table whose apron you can drag from 3in to 8in, watching the
// design review and the board feet change as you do, teaches a lot. Every
// archetype is built to standard practice - standard heights, real joints
// sized from joinery.js, legs inset from the top, shelves in housings - so
// what you start from is a piece that would stand up.
//
// An archetype is { key, name, what, params, build(params) -> design }.
// `params` gives each number a label, a sensible default and a range, so the
// designer can draw the controls without knowing what the piece is.

import { tenonFor, dadoFor } from './joinery.js';
import { instanceBasis } from './design.js';
import { PIECES } from './ergonomics.js';

const num = (label, value, min, max, step = 0.25, note = '') => ({ label, value, min, max, step, note });

const MAPLE = { category: 'Wood', species: 'maple', color: '#e3c99a' };
const WALNUT = { category: 'Wood', species: 'walnut', color: '#6b4b32' };
const PINE = { category: 'Wood', species: 'pine', color: '#e8cb9b' };

// Legs in from the corner, aprons between them, top over the lot: the frame
// under most furniture. Height and stock sizes are what change between a
// dining table, a desk and a workbench.
function tableLike({ name, species, params: p, pieceType }) {
  const { height, topLength, topWidth, topThickness, legSize, apronWidth, apronThickness, overhang } = p;
  const legLength = height - topThickness;
  const legX = topLength / 2 - overhang - legSize / 2;
  const legZ = topWidth / 2 - overhang - legSize / 2;
  const apronY = height - topThickness - apronWidth / 2;
  const material = species.name;
  // Both aprons tenon into the same leg from faces at right angles, so each
  // tenon can only have half the leg. Cut short of half and the ends clear
  // each other; the traditional alternative is to mitre them where they meet.
  const tenon = (railWidth) => {
    const t = tenonFor({ railThickness: apronThickness, railWidth, intoThickness: legSize });
    return { ...t, length: Math.min(t.length, legSize / 2 - 1 / 8) };
  };
  // Shoulder to shoulder: the tenons are added on top of this by the compiler.
  const longClear = 2 * (legX - legSize / 2);
  const shortClear = 2 * (legZ - legSize / 2);
  const design = {
    version: 1,
    title: name,
    subtitle: `${height}in tall, ${topLength} × ${topWidth}`,
    pieceType,
    params: p,
    materials: { [material]: species.material },
    parts: [
      {
        id: 'top', name: 'Top', group: 'Top', material,
        size: [topLength, topWidth, topThickness],
        instances: [{ at: [0, height - topThickness / 2, 0], along: 'x', up: 'y' }],
      },
      {
        id: 'leg', name: 'Leg', group: 'Base', material,
        size: [legLength, legSize, legSize],
        instances: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => ({
          at: [sx * legX, legLength / 2, sz * legZ], along: 'y', up: 'z',
        })),
      },
      {
        id: 'apronLong', name: 'Apron, long', group: 'Base', material,
        size: [longClear, apronWidth, apronThickness],
        instances: [-1, 1].map((sz) => ({ at: [0, apronY, sz * legZ], along: 'x', up: 'z' })),
      },
      {
        id: 'apronShort', name: 'Apron, short', group: 'Base', material,
        size: [shortClear, apronWidth, apronThickness],
        instances: [-1, 1].map((sx) => ({ at: [sx * legX, apronY, 0], along: 'z', up: 'x' })),
      },
    ],
    joints: [
      { from: 'apronLong', end: 0, into: 'leg', type: 'mortise-tenon', tenon: tenon(apronWidth) },
      { from: 'apronLong', end: 1, into: 'leg', type: 'mortise-tenon', tenon: tenon(apronWidth) },
      { from: 'apronShort', end: 0, into: 'leg', type: 'mortise-tenon', tenon: tenon(apronWidth) },
      { from: 'apronShort', end: 1, into: 'leg', type: 'mortise-tenon', tenon: tenon(apronWidth) },
      // The top is solid wood across the aprons' grain: it has to be free to
      // move, so it is never glued down.
      { from: 'top', into: 'apronLong', type: 'buttons', movesFreely: true },
      { from: 'top', into: 'apronShort', type: 'buttons', movesFreely: true },
    ],
  };
  return design;
}

// A slab with legs driven into it at a splay: a staked stool or bench. The
// legs lean out in both directions, which is what stops it tipping and what
// makes it a chairmaker's joint rather than a carpenter's.
function stakedLike({ name, species, params: p, pieceType }) {
  const { seatHeight, seatLength, seatWidth, seatThickness, legDiameter, splay, inset } = p;
  const material = species.name;
  const underSeat = seatHeight - seatThickness;
  const legX = seatLength / 2 - inset;
  const legZ = seatWidth / 2 - inset;
  const rows = Math.max(2, Math.round(p.pairs || 2));
  // A leg leans out in both directions, so it is longer than the seat is
  // high, and the same length for every leg: one setting on the saw. Its foot
  // is sawn off level after assembly, so it is the lowest corner of the leg
  // that lands on the floor, not the middle of its end.
  const [, , upT] = instanceBasisOf({ axis: 'z', deg: splay }, { axis: 'x', deg: splay });
  const dirUp = legDirection([{ axis: 'z', deg: splay }, { axis: 'x', deg: splay }]);
  const drop = (legDiameter / 2) * (Math.abs(upT.W[1]) + Math.abs(upT.T[1]));
  const length = round16((underSeat - drop) / dirUp[1]);
  const instances = [];
  for (let i = 0; i < rows; i++) {
    const x = -legX + (2 * legX * i) / (rows - 1);
    const leanX = Math.sign(round16(x)) * -splay;      // a middle pair stands plumb front to back
    for (const sz of [-1, 1]) {
      const tilt = [{ axis: 'z', deg: leanX }, { axis: 'x', deg: sz * splay }];
      const dir = legDirection(tilt);
      // It meets the seat at (x, underSeat, z) and hangs from there.
      instances.push({
        at: [x - (dir[0] * length) / 2, underSeat - (dir[1] * length) / 2, sz * legZ - (dir[2] * length) / 2],
        along: 'y', up: 'z', tilt,
      });
    }
  }
  return {
    version: 1,
    title: name,
    subtitle: `${seatHeight}in seat, ${seatLength} × ${seatWidth}`,
    pieceType,
    params: p,
    materials: { [material]: species.material },
    parts: [
      {
        id: 'seat', name: 'Seat', group: 'Seat', material,
        size: [seatLength, seatWidth, seatThickness],
        instances: [{ at: [0, seatHeight - seatThickness / 2, 0], along: 'x', up: 'y' }],
      },
      {
        id: 'leg', name: 'Leg', group: 'Legs', material,
        size: [length, legDiameter, legDiameter],
        instances,
      },
    ],
    joints: [
      // Into the seat, not through it: a tapered round tenon, wedged from
      // above if it does go through.
      { from: 'leg', end: 1, into: 'seat', type: 'round-tenon', tenon: { thickness: round16(legDiameter * 0.6), width: round16(legDiameter * 0.6), length: round16(seatThickness * 0.8) } },
    ],
  };
}

const round16 = (v) => Math.round(v * 16) / 16;

// The width and thickness directions of a leg at this lean, for working out
// how far its bottom corner hangs below the middle of its foot.
function instanceBasisOf(...tilt) {
  const b = instanceBasis({ along: 'y', up: 'z', tilt });
  return [b[0], b[1], { W: b[1], T: b[2] }];
}

// The direction a leg points once it is leant over.
function legDirection(tilt) {
  const rad = (d) => (d * Math.PI) / 180;
  let v = [0, 1, 0];
  for (const t of tilt) {
    const a = rad(t.deg || 0);
    const c = Math.cos(a), s = Math.sin(a);
    if (t.axis === 'z') v = [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
    else if (t.axis === 'x') v = [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
  }
  const n = Math.hypot(...v) || 1;
  return v.map((k) => k / n);
}

// Two sides, shelves housed into them. Spans are the thing to watch, which
// is why the review's sag rule earns its keep here.
function caseLike({ name, species, params: p, pieceType }) {
  const { height, width, depth, thickness, shelves, backThickness } = p;
  const material = species.name;
  const dado = dadoFor(thickness).depth;
  const n = Math.max(0, Math.round(shelves));   // 0 is a box with no shelves in it
  const inner = height - 2 * thickness;
  const shelfLength = width - 2 * thickness + 2 * dado;
  const instances = [];
  for (let i = 0; i < n; i++) {
    // Evenly spaced between the fixed top and bottom.
    const y = thickness / 2 + ((inner + thickness) * (i + 1)) / (n + 1);
    instances.push({ at: [0, y, 0], along: 'x', up: 'y' });
  }
  const parts = [
    {
      id: 'side', name: 'Side', group: 'Case', material,
      size: [height, depth, thickness],
      instances: [-1, 1].map((sx) => ({ at: [sx * (width / 2 - thickness / 2), height / 2, 0], along: 'y', up: 'x' })),
    },
    {
      id: 'topBottom', name: 'Top and bottom', group: 'Case', material,
      size: [shelfLength, depth, thickness],
      instances: [thickness / 2, height - thickness / 2].map((y) => ({ at: [0, y, 0], along: 'x', up: 'y' })),
    },
    {
      id: 'shelf', name: 'Shelf', group: 'Case', material,
      size: [shelfLength, depth, thickness],
      instances,
    },
  ];
  if (backThickness > 0) {
    parts.push({
      id: 'back', name: 'Back', group: 'Case', material: 'Plywood',
      size: [height, width, backThickness],
      instances: [{ at: [0, height / 2, -(depth / 2 - backThickness / 2)], along: 'y', up: 'z' }],
    });
  }
  return {
    version: 1,
    title: name,
    subtitle: `${height} × ${width} × ${depth}`,
    pieceType,
    params: p,
    materials: {
      [material]: species.material,
      ...(backThickness > 0 ? { Plywood: { category: 'Sheet goods', color: '#d9c39b' } } : {}),
    },
    parts,
    joints: [
      { from: 'shelf', end: 0, into: 'side', type: 'dado' },
      { from: 'shelf', end: 1, into: 'side', type: 'dado' },
      { from: 'topBottom', end: 0, into: 'side', type: 'dado' },
      { from: 'topBottom', end: 1, into: 'side', type: 'dado' },
    ],
  };
}

const maple = { name: 'Maple', material: MAPLE };
const walnut = { name: 'Walnut', material: WALNUT };
const pine = { name: 'Pine', material: PINE };

export const ARCHETYPES = [
  {
    key: 'dining-table',
    name: 'Dining table',
    what: 'Four legs, four aprons, a solid top on buttons. The frame under most furniture.',
    params: {
      height: num('Height', 29.5, 26, 34, 0.25, `a dining table is ${PIECES['dining table'].height.join('-')}in`),
      topLength: num('Top length', 60, 24, 120, 1),
      topWidth: num('Top width', 34, 18, 48, 1),
      topThickness: num('Top thickness', 1, 0.625, 2, 0.0625),
      legSize: num('Leg', 2.75, 1.25, 4, 0.125, 'square'),
      apronWidth: num('Apron width', 4.5, 2, 8, 0.25, 'deeper resists racking'),
      apronThickness: num('Apron thickness', 0.875, 0.5, 1.5, 0.0625),
      overhang: num('Top overhang', 3, 0, 8, 0.25),
    },
    species: walnut,
    pieceType: 'dining table',
    build: (params) => tableLike({ name: 'Dining table', species: walnut, params, pieceType: 'dining table' }),
  },
  {
    key: 'workbench',
    name: 'Workbench',
    what: 'The same frame in heavy stock, at wrist height.',
    params: {
      height: num('Height', 34, 28, 42, 0.5, `wrist height: ${PIECES.workbench.height.join('-')}in`),
      topLength: num('Top length', 60, 36, 96, 1),
      topWidth: num('Top width', 24, 16, 36, 1),
      topThickness: num('Top thickness', 2.5, 1.5, 4, 0.25),
      legSize: num('Leg', 3.5, 2, 5, 0.25, 'square'),
      apronWidth: num('Apron width', 5.5, 3, 10, 0.25),
      apronThickness: num('Apron thickness', 1.5, 0.75, 2.5, 0.125),
      overhang: num('Top overhang', 2, 0, 8, 0.5),
    },
    species: maple,
    pieceType: 'workbench',
    build: (params) => tableLike({ name: 'Workbench', species: maple, params, pieceType: 'workbench' }),
  },
  {
    key: 'stool',
    name: 'Staked stool',
    what: 'A slab seat with legs driven in at a splay. Four parts, one joint to learn.',
    params: {
      seatHeight: num('Seat height', 18, 12, 32, 0.25, `a stool seat is ${PIECES.stool.seat.join('-')}in`),
      seatLength: num('Seat length', 14, 10, 22, 0.5),
      seatWidth: num('Seat width', 11, 8, 18, 0.5),
      seatThickness: num('Seat thickness', 1.5, 1, 2.5, 0.125),
      legDiameter: num('Leg', 1.5, 1, 2.5, 0.125, 'square or turned round'),
      splay: num('Splay', 8, 0, 20, 1, 'degrees out, both ways: the wider the steadier'),
      inset: num('Inset from the edge', 2, 0.75, 5, 0.25),
    },
    species: maple,
    pieceType: 'stool',
    build: (params) => stakedLike({ name: 'Staked stool', species: maple, params, pieceType: 'stool' }),
  },
  {
    key: 'bench',
    name: 'Staked bench',
    what: 'The stool, stretched, with a third pair of legs under the middle.',
    params: {
      seatHeight: num('Seat height', 18, 12, 24, 0.25),
      seatLength: num('Seat length', 48, 24, 84, 1),
      seatWidth: num('Seat width', 12, 9, 20, 0.5),
      seatThickness: num('Seat thickness', 1.75, 1, 3, 0.125),
      legDiameter: num('Leg', 1.75, 1, 3, 0.125),
      splay: num('Splay', 8, 0, 20, 1, 'degrees out, both ways'),
      inset: num('Inset from the edge', 3, 1, 8, 0.25),
      pairs: num('Pairs of legs', 2, 2, 4, 1),
    },
    species: pine,
    pieceType: 'bench',
    build: (params) => stakedLike({ name: 'Staked bench', species: pine, params, pieceType: 'bench' }),
  },
  {
    key: 'bookcase',
    name: 'Bookcase',
    what: 'Sides, top, bottom and shelves in housings. Watch the shelf span.',
    params: {
      height: num('Height', 48, 24, 84, 1),
      width: num('Width', 32, 18, 48, 1, 'the shelf span: over about 30in a 3/4in shelf sags'),
      depth: num('Depth', 11, 6, 16, 0.5, `${PIECES.bookcase.note}`),
      thickness: num('Stock thickness', 0.75, 0.5, 1.25, 0.0625),
      shelves: num('Shelves between', 3, 1, 8, 1),
      backThickness: num('Plywood back', 0.25, 0, 0.75, 0.0625, '0 for none'),
    },
    species: maple,
    pieceType: 'bookcase',
    build: (params) => caseLike({ name: 'Bookcase', species: maple, params, pieceType: 'bookcase' }),
  },
];

export const archetype = (key) => ARCHETYPES.find((a) => a.key === key) || null;

// Default parameter values as plain numbers, ready to build with.
export const defaultParams = (a) => Object.fromEntries(Object.entries(a.params).map(([k, v]) => [k, v.value]));

// Build an archetype from (possibly partial) parameters.
export function buildArchetype(key, params = {}) {
  const a = archetype(key);
  if (!a) return null;
  return a.build({ ...defaultParams(a), ...params });
}
