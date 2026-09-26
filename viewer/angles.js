// Compound-angle math for a part's long axis, in the viewer's Y-up world.
// Pure functions (plain [x, y, z] arrays, no three.js) so they're unit-tested
// under Node.
//
// The parser also writes an `angle` block into object_dims.json, but its
// component names are hardcoded (and turn out swapped for the shaving horse,
// whose length runs along world X). Deriving them here from the direction
// vector, with axis names from model.json, keeps the wording right per model.

const DEG = 180 / Math.PI;

export const DEFAULT_AXIS_NAMES = { x: 'front-to-back', y: 'vertical', z: 'side-to-side' };

// Parts within this many degrees of square are reported as square.
export const SQUARE_TOLERANCE_DEG = 0.5;

function norm(v) {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 1e-12 ? [v[0] / n, v[1] / n, v[2] / n] : [1, 0, 0];
}

// Returns null when the direction is essentially square to the world, else:
// {
//   reference: 'plumb' | 'level',
//   refAxis: 'x' | 'y' | 'z',          // nearest world axis
//   refVector: [x, y, z],              // that axis, signed to match `dir`
//   dir: [x, y, z],                    // unit direction, flipped to point along refVector
//   total: deg,                        // angle off the reference axis
//   components: [{ axis, label, deg, planeNormal }],
//   sightline: deg | undefined,        // plumb parts only, see below
// }
//
// For a leaning part (reference = plumb), the two components are the rake
// and splay seen in the two elevation views. `sightline` is the plan-view
// direction of the lean measured from the X axis: together with `total`
// (the "resultant" angle) it's what a chairmaker sets up to bore a splayed
// leg mortise with a bevel gauge and a sightline drawn on the seat.
export function compoundAngle(direction, axisNames = DEFAULT_AXIS_NAMES) {
  let d = norm(direction);
  const abs = d.map(Math.abs);
  const refIdx = abs.indexOf(Math.max(...abs));
  if (d[refIdx] < 0) d = d.map((v) => -v); // point along the reference axis
  const total = Math.acos(Math.min(1, d[refIdx])) * DEG;
  if (total < SQUARE_TOLERANCE_DEG) return null;

  const keys = ['x', 'y', 'z'];
  const refAxis = keys[refIdx];
  const refVector = [0, 0, 0];
  refVector[refIdx] = 1;

  const components = [];
  for (let i = 0; i < 3; i++) {
    if (i === refIdx) continue;
    // Tilt toward axis i, measured in the plane spanned by the reference axis
    // and axis i; that plane's normal is the remaining axis.
    const other = 3 - refIdx - i;
    const planeNormal = [0, 0, 0];
    planeNormal[other] = 1;
    components.push({
      axis: keys[i],
      label: axisNames[keys[i]] || keys[i],
      deg: Math.atan2(d[i], d[refIdx]) * DEG,
      planeNormal,
    });
  }

  const out = {
    reference: refAxis === 'y' ? 'plumb' : 'level',
    refAxis,
    refVector,
    dir: d,
    total,
    components,
  };
  if (refAxis === 'y') out.sightline = Math.atan2(d[2], d[0]) * DEG;
  return out;
}

export function round1(deg) {
  const r = Math.round(deg * 10) / 10;
  return Object.is(r, -0) ? 0 : r;
}

// One-line description for the part card, e.g.
// "18.4° off plumb — 12.3° front-to-back, 14.1° side-to-side".
export function describeAngle(a) {
  const ref = a.reference === 'plumb' ? 'plumb' : 'level';
  const comps = a.components
    .filter((c) => Math.abs(c.deg) >= 0.05)
    .map((c) => `${Math.abs(round1(c.deg))}° ${c.label}`)
    .join(', ');
  return `${round1(a.total)}° off ${ref}${comps ? ' — ' + comps : ''}`;
}

// Angle between two directions in degrees (0..180).
export function angleBetween(a, b) {
  const u = norm(a), v = norm(b);
  const dot = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]));
  return Math.acos(dot) * DEG;
}

// Angle between two faces given their outward normals, as a woodworker reads
// it: 90 for a square corner, 180 for flush/coplanar faces, <90 for an acute
// (sharp) edge, >90 for an obtuse one. The bevel-gauge setting.
export function dihedralFromNormals(n1, n2) {
  return 180 - angleBetween(n1, n2);
}

// Slope of a line from level and from plumb, e.g. for the "angle to world"
// readout on a two-point measurement.
export function slopeAngles(p1, p2) {
  const d = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
  const horiz = Math.hypot(d[0], d[2]);
  const fromLevel = Math.atan2(Math.abs(d[1]), horiz) * DEG;
  return { fromLevel, fromPlumb: 90 - fromLevel };
}
