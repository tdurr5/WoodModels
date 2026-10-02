import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  resolveMechanisms, initialState, hingeTurn, liftHeight, restOffsets, trayOffset, slideLimits,
  liftBlockers, returnBlockers, unmetNeeds, angleAbout, moveBox, detectMechanisms,
} from '../viewer/mechanisms.js';

// The heirloom tool chest: its own moving parts against its own measurements.
const folder = new URL('../viewer/models/heirloom-chest/', import.meta.url);
const config = JSON.parse(readFileSync(new URL('model.json', folder)));
const dims = JSON.parse(readFileSync(new URL('object_dims.json', folder)));
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);

// a part's 8 corners, from its oriented box
function corners(d) {
  const out = [];
  for (let i = 0; i < 8; i++) {
    const p = [...d.center];
    d.axes.forEach((a, k) => { const s = (i >> k) & 1 ? 0.5 : -0.5; for (let j = 0; j < 3; j++) p[j] += s * a.length * a.direction[j]; });
    out.push(p);
  }
  return out;
}
const boxOf = (names) => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  names.flatMap((n) => corners(dims[n])).forEach((p) => p.forEach((v, k) => { min[k] = Math.min(min[k], v); max[k] = Math.max(max[k], v); }));
  return { min, max };
};
// a point turned `deg` about the line through `pivot` along unit `axis` (Rodrigues)
function turn(p, pivot, axis, deg) {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const v = p.map((x, k) => x - pivot[k]);
  const d = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
  const x = [axis[1] * v[2] - axis[2] * v[1], axis[2] * v[0] - axis[0] * v[2], axis[0] * v[1] - axis[1] * v[0]];
  return v.map((vk, k) => vk * c + x[k] * s + axis[k] * d * (1 - c) + pivot[k]);
}

const mechs = resolveMechanisms(config.mechanisms, Object.keys(dims));
const byId = Object.fromEntries(mechs.map((m) => [m.id, m]));
const boxes = Object.fromEntries(mechs.map((m) => [m.id, boxOf(m.parts)]));
const fixed = Object.keys(dims).filter((n) => !mechs.some((m) => m.parts.includes(n)));
const chest = boxOf(fixed);

test('every mechanism finds its parts, and a part belongs to one mechanism', () => {
  assert.deepEqual(mechs.map((m) => m.id), ['lid', 'chisel-tray', 'plane-tray', 'saw-till', 'handle-right', 'handle-left']);
  assert.equal(byId.lid.parts.length, 11); // 9 frame-and-panel parts + one leaf of each hinge
  ['chisel-tray', 'plane-tray', 'saw-till'].forEach((id) => assert.equal(byId[id].parts.length, 5));
  const all = mechs.flatMap((m) => m.parts);
  assert.equal(new Set(all).size, all.length);
  // a prefix match doesn't run into the next group number (group_1_ is not group_11_)
  assert.ok(!byId.lid.parts.some((n) => n.startsWith('group_11_group_12')));
});

test('shut, the lid sits on the chest exactly: frame on the walls, molding on the top molding, flush front and back', () => {
  const lid = byId.lid;
  const frame = lid.parts.filter((n) => /lid_(stiles|rails|panel)/.test(n));
  const molding = lid.parts.filter((n) => /lid_molding/.test(n));
  const shut = (names) => {
    const ps = names.flatMap((n) => corners(dims[n]).map((p) => turn(p, lid.pivot, lid.axis, hingeTurn(lid, n, 0))));
    return { min: [0, 1, 2].map((k) => Math.min(...ps.map((p) => p[k]))), max: [0, 1, 2].map((k) => Math.max(...ps.map((p) => p[k]))) };
  };
  const walls = boxOf(['instance_35_sides', 'instance_36_front_back']);
  const topMolding = boxOf(['group_0_instance_0_top_mold_front_back_1', 'group_0_instance_1_top_mold_front_back']);
  near(shut(frame).min[1], walls.max[1]); // 13": on the walls
  near(shut(molding).min[1], topMolding.max[1]); // 12-7/8": on the top molding
  near(shut(molding).max[2], topMolding.max[2]); // flush with the front
  near(shut(molding).min[2], topMolding.min[2]); // and the back (the hinge knuckles stand proud of it)
  const stiles = shut(frame.filter((n) => /lid_(stiles|rails)/.test(n)));
  near(stiles.max[1] - stiles.min[1], 0.75); // lying level: 3/4" stock, no tilt left
});

test('the lid swings up about its back edge, and the hinge leaf drawn shut turns with it', () => {
  const lid = byId.lid;
  assert.equal(hingeTurn(lid, 'group_1_instance_6_lid_panel', 20.2), 0); // drawn open 20.2°
  assert.equal(hingeTurn(lid, 'group_11_group_13', 0), 0); // the leaf was drawn shut
  const front = corners(dims.group_1_instance_11_lid_molding_stiles_1).map((p) => turn(p, lid.pivot, lid.axis, hingeTurn(lid, 'group_1_instance_11_lid_molding_stiles_1', 95)));
  assert.ok(Math.min(...front.map((p) => p[1])) > 25); // the front edge is up in the air
  assert.ok(Math.max(...front.map((p) => p[2])) < lid.pivot[2]); // leaning back past the hinge
});

test('trays slide only as far as the walls and the other trays let them', () => {
  const st = initialState(mechs);
  const [cLo, cHi] = slideLimits(byId['chisel-tray'], mechs, st, boxes);
  near(cHi, 3.74); // forward to the front wall
  near(cLo, -0.38); // back to the saw till
  const [pLo, pHi] = slideLimits(byId['plane-tray'], mechs, st, boxes);
  near(pHi, 0.085);
  near(pLo, -4.04);
  // with the saw till out, the chisel tray runs to the back wall
  const out = { ...st, 'saw-till': { slide: 0, out: 1 } };
  near(slideLimits(byId['chisel-tray'], mechs, out, boxes)[0], -(boxes['chisel-tray'].min[2] - -15));
  // the saw till hangs on the runners by rabbets in its ends: it slides too,
  // back to the wall and no further forward than the trays in front let it
  const [sLo, sHi] = slideLimits(byId['saw-till'], mechs, st, boxes);
  near(sLo, -0.375); near(sHi, 0.38);
});

test('the plane tray waits for the chisel tray sitting on it, wherever either is slid', () => {
  const st = initialState(mechs);
  assert.deepEqual(liftBlockers(byId['plane-tray'], mechs, st, boxes).map((m) => m.id), ['chisel-tray']);
  assert.deepEqual(liftBlockers(byId['chisel-tray'], mechs, st, boxes), []);
  assert.deepEqual(liftBlockers(byId['saw-till'], mechs, st, boxes), []);
  for (const [c, p] of [[3.74, 0], [0, -4.04], [3.74, -4.04], [-0.38, 0.085]]) {
    const s = { ...st, 'chisel-tray': { slide: c, out: 0 }, 'plane-tray': { slide: p, out: 0 } };
    assert.equal(liftBlockers(byId['plane-tray'], mechs, s, boxes).length, 1, `chisel ${c}, plane ${p}`);
  }
  const chiselOut = { ...st, 'chisel-tray': { slide: 0, out: 1 } };
  assert.deepEqual(liftBlockers(byId['plane-tray'], mechs, chiselOut, boxes), []);
  // with both out, the chisel tray can go back first (nothing in its way)...
  const bothOut = { ...chiselOut, 'plane-tray': { slide: 0, out: 1 } };
  assert.deepEqual(returnBlockers(byId['chisel-tray'], mechs, bothOut, boxes), []);
  // but the plane tray can't go back under the chisel tray once that's back in
  const chiselBack = { ...bothOut, 'chisel-tray': { slide: 0, out: 0 } };
  assert.deepEqual(returnBlockers(byId['plane-tray'], mechs, chiselBack, boxes).map((m) => m.id), ['chisel-tray']);
});

test('lifting a tray out needs the lid open first', () => {
  const st = initialState(mechs);
  assert.deepEqual(unmetNeeds(byId['saw-till'], mechs, st).map(({ mech, angle }) => [mech.id, angle]), [['lid', 95]]);
  assert.deepEqual(unmetNeeds(byId['saw-till'], mechs, { ...st, lid: { angle: 90 } }), []);
});

test('a lifted tray clears the chest, then lands on the floor in front of it without hitting the others', () => {
  const trays = mechs.filter((m) => m.kind === 'tray');
  const rest = restOffsets(trays, boxes, chest, [0, 0, 1]);
  const landed = trays.map((m) => moveBox(boxes[m.id], rest[m.id]));
  landed.forEach((b) => { near(b.min[1], chest.min[1]); assert.ok(b.min[2] >= chest.max[2] + 1.99); });
  for (let i = 1; i < landed.length; i++) assert.ok(landed[i].min[2] >= landed[i - 1].max[2] + 1.99);
  trays.forEach((m) => {
    const lift = liftHeight(boxes[m.id], chest);
    const st = { slide: 0, out: 0 };
    // straight up first: at the top of the lift it's above the chest
    const up = moveBox(boxes[m.id], trayOffset(m, { ...st, out: 0.001 }, rest[m.id], lift));
    near(up.min[0], boxes[m.id].min[0]); near(up.min[2], boxes[m.id].min[2], 0.02);
    const total = lift + Math.hypot(rest[m.id][0], rest[m.id][2]) + Math.abs(rest[m.id][1] - 0) + lift;
    const top = moveBox(boxes[m.id], trayOffset(m, { ...st, out: lift / total }, rest[m.id], lift));
    assert.ok(top.min[1] >= chest.max[1] + 0.99, `${m.id} clears the chest`);
    assert.deepEqual(trayOffset(m, { ...st, out: 1 }, rest[m.id], lift), rest[m.id]);
    assert.deepEqual(trayOffset(m, st, rest[m.id], lift), [0, 0, 0]);
  });
});

test('angleAbout measures a point swung about the hinge line', () => {
  const lid = byId.lid;
  const ref = [5, lid.pivot[1], lid.pivot[2] + 10]; // straight out in front of the hinge
  near(angleAbout(lid, turn(ref, lid.pivot, lid.axis, 30), ref), 30, 1e-6);
  near(angleAbout(lid, turn(ref, lid.pivot, lid.axis, -12), ref), -12, 1e-6);
});

test('mechanisms with no parts in the model, or of an unknown kind, are left out', () => {
  assert.deepEqual(resolveMechanisms([{ id: 'x', kind: 'hinge', parts: ['nothing_*'] }, { id: 'y', kind: 'drawer', parts: ['group_1_*'] }], Object.keys(dims)), []);
  assert.deepEqual(resolveMechanisms(undefined, []), []);
});

// An upload has no "mechanisms" list: they're found from part names and shapes.
const partsOf = (dir) => {
  const d = JSON.parse(readFileSync(new URL('object_dims.json', dir)));
  const rows = JSON.parse(readFileSync(new URL('parts_report.json', dir)));
  return rows.flatMap((r) => r.obj_names.map((name, i) => ({ name, group: r.paths[i].split('/')[0], label: r.label, dims: d[name] })));
};

test('an uploaded chest: the lid and its trays are found, hinged and sliding as the hand-written list has them', () => {
  const found = detectMechanisms(partsOf(folder), { front: [0, 0, 1] });
  assert.deepEqual(found.map((m) => [m.kind, m.label]), [['hinge', 'Lid'], ['tray', 'Chisel tray'], ['tray', 'Handsaw box'], ['tray', 'Handplane tray']]);
  const lid = found[0];
  assert.deepEqual(lid.axis, byId.lid.axis);
  near(lid.pivot[1], byId.lid.pivot[1]); near(lid.pivot[2], byId.lid.pivot[2]);
  near(lid.drawnAt, byId.lid.drawnAt);
  assert.deepEqual([...lid.parts].sort(), byId.lid.parts.filter((n) => n.startsWith('group_1_')).sort());
  const chisel = found.find((m) => m.label === 'Chisel tray');
  assert.deepEqual(chisel.slide, { axis: [0, 0, 1], within: [-15, -1.5] });
  assert.deepEqual(chisel.needs, { lid: 80 });
  // the handles on the outside aren't trays
  assert.ok(!found.some((m) => m.parts.some((n) => /handle/.test(n))));
});

test('a piece with no lid and nothing named like a tray has no moving parts', () => {
  assert.deepEqual(detectMechanisms(partsOf(new URL('../viewer/', import.meta.url)), { front: [1, 0, 0] }), []);
});
