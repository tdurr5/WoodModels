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
// The way out: up out of the chest, over, down to the floor - the legs and
// what share of the whole each is (`out` runs 0 → 1 along them).
export function trayPath(mech, st, rest, lift, up = UP) {
  const s = mech.slide ? scale(mech.slide.axis, st.slide || 0) : [0, 0, 0];
  const p1 = add(s, scale(up, lift));
  const p2 = add(rest, scale(up, dot(p1, up) - dot(rest, up))); // over the rest spot, at carrying height
  const legs = [[s, p1], [p1, p2], [p2, rest]];
  const lens = legs.map(([a, b]) => len(sub(b, a)));
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  return { legs, lens, total, shares: lens.map((l) => l / total) };
}
export function trayOffset(mech, st, rest, lift, up = UP) {
  const t = st.out || 0;
  if (t <= 0) return mech.slide ? scale(mech.slide.axis, st.slide || 0) : [0, 0, 0];
  const { legs, lens, total } = trayPath(mech, st, rest, lift, up);
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

// ---------- finding the moving parts in a model nobody described ----------
// An uploaded model has no "mechanisms" list, so look for them: a lid (parts
// or a group named lid) on hinges along its back edge, and trays - a group
// named tray, till, box, drawer... or one sitting inside the rest of the
// model - that lift out, and slide on runners when they span the inside.
//
// parts: [{ name, group, label, dims }] (dims as in object_dims.json);
// groupName(g) names a group for the panel. Returns mechanisms in the
// model.json format.
const LID = /(^|[^a-z])lids?([^a-z]|$)/i;
const TRAY = /(tray|till|drawer|caddy|insert|tote|organi[sz]er|(^|[^a-z])box([^a-z]|$))/i;
const GENERIC = /^(group|instance|component|mesh|node|object)[\s_#-]*\d*$/i;
// what a tray rides on or rests against, not a tray ("tray runner")
const HOLDS = /(runner|cleat|rail|guide|ledger|support|slide|stop)/i;

function cornersOf(d) {
  const out = [];
  for (let i = 0; i < 8; i++) {
    const p = [...d.center];
    d.axes.forEach((a, k) => { const s = (i >> k) & 1 ? 0.5 : -0.5; for (let j = 0; j < 3; j++) p[j] += s * a.length * a.direction[j]; });
    out.push(p);
  }
  return out;
}
function boxOfPoints(ps) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  ps.forEach((p) => p.forEach((v, k) => { min[k] = Math.min(min[k], v); max[k] = Math.max(max[k], v); }));
  return { min, max };
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// p turned deg about the line through pivot along unit axis (Rodrigues)
function turnPoint(p, pivot, axis, deg) {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const v = sub(p, pivot), d = dot(v, axis), x = cross(axis, v);
  return v.map((vk, k) => vk * c + x[k] * s + axis[k] * d * (1 - c) + pivot[k]);
}
// "handplane_tray_bottom", "handplane_tray_sides" -> "Handplane tray"
function nameFromLabels(labels) {
  const words = labels.map((l) => l.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const common = [];
  for (let i = 0; words.length && i < words[0].length; i++) {
    if (words.every((w) => w[i] === words[0][i])) common.push(words[0][i]); else break;
  }
  const s = common.join(' ');
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

export function detectMechanisms(parts, { front = [0, 0, 1], up = UP, groupName = (g) => g } = {}) {
  const usable = parts.filter((p) => p.dims?.axes?.length === 3);
  if (usable.length < 3) return [];
  const back = scale(front, -1);
  const corners = new Map(usable.map((p) => [p.name, cornersOf(p.dims)]));
  const boxOf = (ps) => boxOfPoints(ps.flatMap((p) => corners.get(p.name)));
  const vol = (p) => p.dims.axes.reduce((v, a) => v * a.length, 1);
  const out = [];

  // the lid: parts named lid (and the rest of their group, if it's mostly lid)
  let lidParts = usable.filter((p) => LID.test(p.label));
  const lidGroups = new Set(lidParts.map((p) => p.group));
  lidGroups.forEach((g) => {
    const inGroup = usable.filter((p) => p.group === g);
    if (inGroup.filter((p) => LID.test(p.label)).length * 2 > inGroup.length) lidParts = [...new Set([...lidParts, ...inGroup])];
  });
  if (lidParts.length && lidParts.length * 2 < usable.length) {
    const lidSet = new Set(lidParts.map((p) => p.name));
    // the lid's face: the thickness of its biggest board
    const big = lidParts.reduce((a, b) => (a.dims.axes[0].length * a.dims.axes[1].length >= b.dims.axes[0].length * b.dims.axes[1].length ? a : b));
    let n = big.dims.axes[2].direction;
    if (dot(n, up) < 0) n = scale(n, -1);
    const tilt = (Math.acos(Math.min(1, dot(n, up))) * 180) / Math.PI;
    // the hinge side: the way the face leans (it tips towards its hinges), else the back
    const lean = sub(n, scale(up, dot(n, up)));
    const h = tilt > 1 && len(lean) > 1e-6 ? norm(lean) : back;
    // the hinge line: along the lid's lowest edge on that side
    const ps = lidParts.flatMap((p) => corners.get(p.name));
    const low = Math.min(...ps.map((p) => dot(p, up)));
    const edge = ps.filter((p) => dot(p, up) < low + 0.05);
    const pivot = edge.reduce((a, b) => (dot(b, h) > dot(a, h) ? b : a));
    let axis = norm(cross(h, up));
    // a positive turn lifts the far edge
    const far = sub(pivot, h);
    if (dot(turnPoint(far, pivot, axis, 10), up) < dot(far, up)) axis = scale(axis, -1);
    axis = axis.map((v) => (Math.abs(v) < 1e-9 ? 0 : v)); // no -0
    const drawnAt = Math.round(tilt * 10) / 10;
    const groups = [...new Set(lidParts.map((p) => p.group))];
    out.push({
      id: 'lid', label: groups.length === 1 && !GENERIC.test(groupName(groups[0])) ? groupName(groups[0]) : 'Lid', kind: 'hinge',
      parts: [...lidSet], pivot: pivot.map((v) => Math.round(v * 1e4) / 1e4), axis, drawnAt,
      range: [0, Math.max(100, Math.ceil(drawnAt))], open: 95, start: 0, detected: true,
    });
  }
  const lid = out[0];
  const moving = new Set(lid ? lid.parts : []);

  // trays: whole groups, named like one or sitting inside the rest
  const groups = new Map();
  usable.forEach((p) => { if (!moving.has(p.name)) { if (!groups.has(p.group)) groups.set(p.group, []); groups.get(p.group).push(p); } });
  const candidates = [];
  groups.forEach((ps, g) => {
    if (ps.length * 2 >= usable.length) return;
    const text = `${groupName(g)} ${ps.map((p) => p.label).join(' ')}`;
    // a tray is a box: several boards, none of them its runners
    if (ps.length < 3 || ps.some((p) => HOLDS.test(p.label))) return;
    candidates.push({ g, ps, named: TRAY.test(text) && !LID.test(groupName(g)), box: boxOf(ps) });
  });
  const restOf = (c) => usable.filter((p) => !moving.has(p.name) && !c.ps.includes(p));
  const hz = [0, 1, 2].filter((k) => Math.abs(up[k]) < 0.5);
  const uk = axisIndex(up);
  const trays = candidates.filter((c) => {
    const others = restOf(c);
    const rest = boxOf(others);
    // not standing on the floor, not above the top
    if (!(c.box.min[uk] > rest.min[uk] + 0.25 && c.box.max[uk] <= rest.max[uk] + 0.25)) return false;
    // walled in: on every side, something at its height beyond it (a handle
    // on the outside of a chest is not in it)
    const walled = hz.every((k) => {
      const k2 = hz.find((j) => j !== k);
      const beside = others.filter((p) => {
        const b = boxOf([p]);
        return Math.min(b.max[uk], c.box.max[uk]) - Math.max(b.min[uk], c.box.min[uk]) > 0.01
          && Math.min(b.max[k2], c.box.max[k2]) - Math.max(b.min[k2], c.box.min[k2]) > 0.01;
      }).map((p) => boxOf([p]));
      return beside.some((b) => b.min[k] >= c.box.max[k] - 0.3) && beside.some((b) => b.max[k] <= c.box.min[k] + 0.3);
    });
    if (!walled) return false;
    if (c.named) return true;
    // unnamed: a group of several boards held inside something with a lid
    // (a named assembly between other parts is just part of the piece)
    return !!lid && GENERIC.test(groupName(c.g));
  });
  const trayNames = new Set(trays.flatMap((c) => c.ps.map((p) => p.name)));
  const fixed = usable.filter((p) => !moving.has(p.name) && !trayNames.has(p.name) && vol(p) > 0.01);
  trays.sort((a, b) => b.box.max[axisIndex(up)] - a.box.max[axisIndex(up)]); // top ones first: nearest when set down
  trays.forEach((c, i) => {
    const m = {
      id: `tray-${i + 1}`, kind: 'tray', parts: c.ps.map((p) => p.name), detected: true,
      label: (!GENERIC.test(groupName(c.g)) && groupName(c.g)) || nameFromLabels(c.ps.map((p) => p.label)) || `Tray ${i + 1}`,
    };
    if (lid) m.needs = { [lid.id]: 80 };
    // runners: it spans the inside one way, so it slides the other way
    // between the walls in front of and behind it
    const [a, b] = hz;
    const span = (k) => c.box.max[k] - c.box.min[k];
    const sk = span(a) < span(b) ? a : b, lk = sk === a ? b : a;
    const sAxis = [0, 0, 0]; sAxis[sk] = Math.sign(front[sk]) || 1;
    const uk = axisIndex(up);
    const overlap = (p, k) => { const bx = boxOf([p]); return Math.min(bx.max[k], c.box.max[k]) - Math.max(bx.min[k], c.box.min[k]) > 0.01; };
    let lo = -Infinity, hi = Infinity;
    fixed.forEach((p) => {
      if (!overlap(p, uk) || !overlap(p, lk) || overlap(p, sk)) return; // not beside it, or a runner it rides in
      const bx = boxOf([p]);
      if (bx.min[sk] >= c.box.max[sk] - 0.01) hi = Math.min(hi, bx.min[sk]);
      else if (bx.max[sk] <= c.box.min[sk] + 0.01) lo = Math.max(lo, bx.max[sk]);
    });
    const interior = (Number.isFinite(lo) && Number.isFinite(hi)) ? hi - lo : 0;
    if (interior > span(sk) + 0.25 && span(lk) > span(sk)) m.slide = { axis: sAxis, within: [lo, hi] };
    out.push(m);
  });
  return out;
}
