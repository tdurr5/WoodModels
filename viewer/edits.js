// Your changes to a model's parts, on top of what the model file says:
//   names   row key -> your name for the part
//   groups  group id -> your name for the group (section heading)
//   status  row key -> 'deleted' (a mistake in the model: hidden everywhere)
//                    | 'aside'  (in the model but not part of the build, e.g.
//                                tools drawn on the bench: kept with its sizes,
//                                left out of totals, shopping list and prints)
//                    | 'build'  (overrides a default, e.g. a flat face)
//   pieces  mesh name -> 'deleted' | 'aside' for one piece of a part with
//           several (e.g. one of two copies of a board left on top of each other),
//           or 'build' to keep a piece an automatic fix would remove
//   joins   [[mesh names]...]: overlapping pieces that are really one longer
//           piece (a rail modeled as two boards slid along each other)
//   splits  [join keys]: automatic joins you split apart again
// Automatic fixes (see withAutoFixes) are defaults under all of these.
// Row keys are `${label}|${dims}` like everywhere else. Pure functions; app.js
// stores the result (in the uploaded model itself, or in browser storage).

export function normalizeEdits(e) {
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {});
  const joins = Array.isArray(e?.joins) ? e.joins.filter((j) => Array.isArray(j) && j.length > 1 && j.every((n) => typeof n === 'string')).map((j) => [...j]) : [];
  const splits = Array.isArray(e?.splits) ? e.splits.filter((k) => typeof k === 'string') : [];
  return { names: obj(e?.names), groups: obj(e?.groups), status: obj(e?.status), pieces: obj(e?.pieces), joins, splits };
}

// A loose face with no thickness isn't a piece of wood: set aside by default.
const defaultStatus = (row) => (row.flat ? 'aside' : null);

export function rowStatus(row, edits) {
  const s = edits.status[row.key];
  if (s === 'deleted' || s === 'aside') return s;
  if (s === 'build') return null;
  return defaultStatus(row);
}

// status: 'deleted' | 'aside' | null (back in the build)
export function withStatus(edits, rows, status) {
  const next = normalizeEdits(edits);
  rows.forEach((r) => {
    if (status === defaultStatus(r)) delete next.status[r.key];
    else next.status[r.key] = status || 'build';
  });
  return next;
}

// single pieces (mesh names); status 'deleted' | 'aside' | null (keep it in
// the build - stored, so an automatic fix doesn't remove it again)
export function withPieceStatus(edits, names, status) {
  const next = normalizeEdits(edits);
  names.forEach((n) => { next.pieces[n] = status || 'build'; });
  return next;
}

export const joinKey = (names) => [...names].sort().join('+');

// join pieces into one (names: mesh names), or split every join touching them
export function withJoin(edits, names) {
  const next = normalizeEdits(edits);
  next.joins = next.joins.filter((j) => !j.some((n) => names.includes(n)));
  next.joins.push([...names]);
  next.splits = next.splits.filter((k) => k !== joinKey(names));
  return next;
}
// pieceLists: the joins to undo (as shown); remembered so automatic joins stay split
export function withSplit(edits, pieceLists) {
  const next = normalizeEdits(edits);
  const names = pieceLists.flat();
  next.joins = next.joins.filter((j) => !j.some((n) => names.includes(n)));
  pieceLists.forEach((p) => { if (!next.splits.includes(joinKey(p))) next.splits.push(joinKey(p)); });
  return next;
}
export const withoutJoins = (edits, names) => withSplit(edits, [names]);

// Your edits plus the automatic fixes found for the model (auto: { joins:
// [[names]], dupes: [names] }): a fix applies unless you've undone it or
// changed the same pieces yourself. Returns the edits to use, with
// autoJoins (join keys) and autoDeleted (mesh names) telling which are automatic.
export function withAutoFixes(edits, auto = {}) {
  const e = normalizeEdits(edits);
  const autoJoins = new Set(), autoDeleted = new Set();
  const used = new Set(e.joins.flat());
  (auto.dupes || []).forEach((n) => {
    if (e.pieces[n] || used.has(n)) return;
    e.pieces[n] = 'deleted';
    autoDeleted.add(n);
  });
  (auto.joins || []).forEach((names) => {
    const k = joinKey(names);
    if (e.splits.includes(k) || names.some((n) => used.has(n) || e.pieces[n])) return;
    e.joins.push([...names]);
    names.forEach((n) => used.add(n));
    autoJoins.add(k);
  });
  return { ...e, autoJoins, autoDeleted };
}

export function withName(edits, key, name) {
  const next = normalizeEdits(edits);
  if (name && name.trim()) next.names[key] = name.trim(); else delete next.names[key];
  return next;
}

export function withGroupName(edits, group, name) {
  const next = normalizeEdits(edits);
  if (name && name.trim()) next.groups[group] = name.trim(); else delete next.groups[group];
  return next;
}
