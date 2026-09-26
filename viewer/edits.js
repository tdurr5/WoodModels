// Your changes to a model's parts, on top of what the model file says:
//   names   row key -> your name for the part
//   groups  group id -> your name for the group (section heading)
//   status  row key -> 'deleted' (a mistake in the model: hidden everywhere)
//                    | 'aside'  (in the model but not part of the build, e.g.
//                                tools drawn on the bench: kept with its sizes,
//                                left out of totals, shopping list and prints)
//                    | 'build'  (overrides a default, e.g. a flat face)
// Row keys are `${label}|${dims}` like everywhere else. Pure functions; app.js
// stores the result (in the uploaded model itself, or in browser storage).

export function normalizeEdits(e) {
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {});
  return { names: obj(e?.names), groups: obj(e?.groups), status: obj(e?.status) };
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

export const hasEdits = (e) => Object.keys(e.names).length + Object.keys(e.groups).length + Object.keys(e.status).length > 0;
