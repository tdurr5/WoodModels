// Moving parts: a lid on its hinges, handles that swing up, trays that slide
// on their runners and lift out. A model declares them in model.json
// ("mechanisms"); this is the pure maths - where each part is for a given
// state, how far a tray can slide before it hits another, and what has to
// come out first - and app.js / mechpanel.js draw and drive it.
//
// The model stays as drawn: every pose is a transform of the parts from
// where the model drew them, so the cut list, joinery and templates (which
// measure the drawn parts) are unaffected by opening the lid.
//
// A mechanism in model.json:
//   { "id": "lid", "label": "Lid", "kind": "hinge",
//     "parts": ["group_1_*"],              mesh names; a trailing * matches a prefix
//     "pivot": [0, 12.875, -16.5],         a point on the hinge line
//     "axis": [-1, 0, 0],                  hinge line; a positive angle opens (right hand rule)
//     "drawnAt": 20.2,                     the angle the model drew it at (degrees)
//     "partsDrawnAt": { "name": 0 },       parts drawn at another angle (a hinge leaf drawn shut)
//     "range": [0, 100], "open": 95, "start": 0 }
//   { "id": "chisel", "label": "Chisel tray", "kind": "tray",
//     "parts": ["group_3_*"],
//     "slide": { "axis": [0, 0, 1], "within": [-15, -1.5] },   optional: runs on runners, kept between the walls
//     "needs": { "lid": 80 } }                                  lifting out needs the lid open this far
//
// Boxes are axis-aligned { min: [x,y,z], max: [x,y,z] } of a mechanism's
// parts as drawn; a tray only ever translates, so its box moves with it.

const EPS = 0.02; // inches: parts this close are touching, not overlapping

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return scale(a, 1 / l); };
// the box's extent along a unit axis-aligned direction
const along = (box, dir) => {
  const k = axisIndex(dir), s = Math.sign(dir[k]);
  return s > 0 ? [box.min[k], box.max[k]] : [-box.max[k], -box.min[k]];
};
const axisIndex = (dir) => {
  const a = dir.map(Math.abs);
  return a[0] >= a[1] && a[0] >= a[2] ? 0 : a[1] >= a[2] ? 1 : 2;
};
export const moveBox = (box, off) => ({ min: add(box.min, off), max: add(box.max, off) });
export const smoothstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// The mechanisms whose parts are in the model, with the mesh names matched.
export function resolveMechanisms(list, meshNames) {
  if (!Array.isArray(list)) return [];
  const names = [...meshNames];
  const matches = (pat, n) => (pat.endsWith('*') ? n.startsWith(pat.slice(0, -1)) : n === pat);
  const taken = new Set();
  const out = [];
  list.forEach((spec) => {
    if (!spec || !spec.id || (spec.kind !== 'hinge' && spec.kind !== 'tray')) return;
    const parts = names.filter((n) => !taken.has(n) && (spec.parts || []).some((p) => matches(p, n)));
    if (!parts.length) return;
    parts.forEach((n) => taken.add(n)); // a part belongs to one mechanism
    const m = { ...spec, parts, label: spec.label || spec.id };
    if (m.kind === 'hinge') {
      m.axis = norm(spec.axis || [1, 0, 0]);
      m.pivot = spec.pivot || [0, 0, 0];
      m.drawnAt = spec.drawnAt || 0;
      m.range = spec.range || [0, 90];
      m.open = spec.open ?? m.range[1];
      m.start = Math.min(m.range[1], Math.max(m.range[0], spec.start ?? m.range[0]));
    } else if (spec.slide) {
      m.slide = { axis: norm(spec.slide.axis || [0, 0, 1]), within: spec.slide.within || null };
    }
    out.push(m);
  });
  return out;
}

export function initialState(mechs) {
  const st = {};
  mechs.forEach((m) => { st[m.id] = m.kind === 'hinge' ? { angle: m.start } : { slide: 0, out: 0 }; });
  return st;
}

// How far (degrees) a hinged part is turned from where it was drawn.
export function hingeTurn(mech, part, angle) {
  const drawn = mech.partsDrawnAt?.[part] ?? mech.drawnAt;
  return angle - drawn;
}

// Which way is up (opposite gravity) - the model's vertical axis.
export const UP = [0, 1, 0];

// ---------- trays ----------

// How far a tray has to rise to clear the chest: its bottom up past the
// chest's top, plus a little air.
export function liftHeight(trayBox, chestBox, up = UP, clearance = 1) {
  const [lo] = along(trayBox, up), [, top] = along(chestBox, up);
  return Math.max(0, top - lo + clearance);
}

// Where each tray is set down once lifted out: on the floor in front of the
// chest, one behind the other in the order the trays are listed, a couple of
// inches apart. `front` is the direction the chest faces.
export function restOffsets(trays, boxes, chestBox, front, up = UP, gap = 2) {
  const out = {};
  const floor = along(chestBox, up)[0];
  let at = along(chestBox, front)[1] + gap; // the chest's front face, plus a gap
  trays.forEach((m) => {
    const b = boxes[m.id];
    const [near, far] = along(b, front);
    const [bottom] = along(b, up);
    // forward until its back edge is at `at`, down onto the floor
    out[m.id] = add(scale(front, at - near), scale(up, floor - bottom));
    at += far - near + gap;
  });
  return out;
}

// Where a tray's parts are: slid along its runners, then (as `out` goes 0 → 1)
// lifted straight up, carried over and set down at its rest spot.
export function trayOffset(mech, st, rest, lift, up = UP) {
  const s = mech.slide ? scale(mech.slide.axis, st.slide || 0) : [0, 0, 0];
  const t = st.out || 0;
  if (t <= 0) return s;
  const p1 = add(s, scale(up, lift));
  const hi = dot(p1, up);
  const p2 = add(rest, scale(up, hi - dot(rest, up))); // over the rest spot, at carrying height
  const legs = [[s, p1], [p1, p2], [p2, rest]];
  const lens = legs.map(([a, b]) => len(sub(b, a)));
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  let d = t * total;
  for (let i = 0; i < legs.length; i++) {
    if (d <= lens[i] || i === legs.length - 1) {
      const f = lens[i] ? smoothstep(Math.min(1, d / lens[i])) : 1;
      return add(legs[i][0], scale(sub(legs[i][1], legs[i][0]), f));
    }
    d -= lens[i];
  }
  return rest;
}

// A tray's box where it is now (in the chest, slid).
export function trayBoxNow(mech, st, box) {
  return mech.slide ? moveBox(box, scale(mech.slide.axis, st.slide || 0)) : box;
}

// Whether two boxes overlap on every axis except `skip` (by more than EPS).
function overlapsExcept(a, b, skip) {
  for (let k = 0; k < 3; k++) {
    if (k === skip) continue;
    if (Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]) <= EPS) return false;
  }
  return true;
}
const overlaps = (a, b) => overlapsExcept(a, b, -1);

// The trays sitting in the chest (not lifted out, not on their way).
const inChest = (mechs, state) => mechs.filter((m) => m.kind === 'tray' && !(state[m.id]?.out > 0));

// How far along its runners a tray can slide: [lowest, highest] slide value.
// Stopped by the chest's walls (`within`, the inside faces along the slide)
// and by any other tray in the chest at the same height.
export function slideLimits(mech, mechs, state, boxes) {
  if (!mech.slide) return [0, 0];
  const ax = mech.slide.axis, k = axisIndex(ax), sgn = Math.sign(ax[k]);
  const cur = state[mech.id].slide || 0;
  const me = trayBoxNow(mech, state[mech.id], boxes[mech.id]);
  // in slide units: how far forward (+) and back (-) from here
  let fwd = Infinity, back = Infinity;
  const [lo, hi] = along(me, ax);
  if (mech.slide.within) {
    const w = mech.slide.within.map((v) => v * sgn).sort((a, b) => a - b);
    fwd = Math.min(fwd, w[1] - hi);
    back = Math.min(back, lo - w[0]);
  }
  inChest(mechs, state).forEach((o) => {
    if (o === mech) return;
    const ob = trayBoxNow(o, state[o.id], boxes[o.id]);
    if (!overlapsExcept(me, ob, k)) return; // not in its path
    const [olo, ohi] = along(ob, ax);
    if (olo >= hi - EPS) fwd = Math.min(fwd, olo - hi);
    else if (ohi <= lo + EPS) back = Math.min(back, lo - ohi);
  });
  fwd = Math.max(0, fwd); back = Math.max(0, back);
  return [cur - (Number.isFinite(back) ? back : 0), cur + (Number.isFinite(fwd) ? fwd : 0)];
}

// The trays in the chest that sit over this one where it is: it can't be
// lifted out until they're slid clear or lifted out themselves.
export function liftBlockers(mech, mechs, state, boxes, up = UP) {
  const k = axisIndex(up);
  const me = trayBoxNow(mech, state[mech.id], boxes[mech.id]);
  const [, top] = along(me, up);
  return inChest(mechs, state).filter((o) => {
    if (o === mech) return false;
    const ob = trayBoxNow(o, state[o.id], boxes[o.id]);
    return overlapsExcept(me, ob, k) && along(ob, up)[0] >= top - 0.25;
  });
}

// What's in the way of putting a lifted-out tray back where it came from:
// a tray in the chest now sitting over its place, or slid into it.
export function returnBlockers(mech, mechs, state, boxes, up = UP) {
  const k = axisIndex(up);
  const home = trayBoxNow(mech, state[mech.id], boxes[mech.id]);
  const [, top] = along(home, up);
  return inChest(mechs, state).filter((o) => {
    if (o === mech) return false;
    const ob = trayBoxNow(o, state[o.id], boxes[o.id]);
    return overlaps(home, ob) || (overlapsExcept(home, ob, k) && along(ob, up)[0] >= top - 0.25);
  });
}

// What lifting a tray out needs first: hinges (the lid) opened at least so
// far. Returns [{ mech, angle }] for the ones that aren't yet.
export function unmetNeeds(mech, mechs, state) {
  return Object.entries(mech.needs || {}).flatMap(([id, min]) => {
    const h = mechs.find((m) => m.id === id && m.kind === 'hinge');
    return h && state[id].angle < min ? [{ mech: h, angle: Math.max(min, h.open) }] : [];
  });
}

// Lid angle under a pointer: the angle (degrees, in the hinge's own sense)
// of point p about the hinge line, relative to a reference point drawn at
// `refAngle`. Used for dragging a lid open.
export function angleAbout(mech, p, ref) {
  const a = mech.axis;
  const flat = (v) => { const d = sub(v, mech.pivot); return sub(d, scale(a, dot(d, a))); };
  const u = norm(flat(ref)), v = flat(p);
  const w = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]]; // a × u
  return (Math.atan2(dot(v, w), dot(v, u)) * 180) / Math.PI;
}
