// Design review panel: turns what the viewer knows about a model into the
// shape review.js wants, then draws the findings in the sidebar.
//
// Model check (in app.js) asks "is this model drawn properly?". This asks the
// next question: "is the thing it draws built properly?" - wood movement,
// joint proportions, spans, stock sizes, the heights it will be used at.
//
// The measuring is all done from data app.js already has (part sizes, what
// touches what, tenons, cuts, holes), so this costs nothing extra on load,
// and everything it can't work out it simply leaves out: an uploaded
// Warehouse model gets the rules its geometry can answer, and no others.

import { escapeHtml } from './format.js';
import { panelFor, propsFor } from './woodprops.js';
import { reviewModel, SEVERITY } from './review.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// The eight corners of a part's oriented box, in world space.
function corners(d) {
  const out = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const s = [sx, sy, sz];
    out.push(d.center.map((c, k) => c + d.axes.reduce((a, ax, i) => a + ax.direction[k] * ax.length / 2 * s[i], 0)));
  }
  return out;
}

// How far one part reaches across another's width - the distance over which
// it would hold that part's grain if the two were fixed solid. A leg landing
// on a wide seat covers an inch or two; a rail screwed under a top covers its
// whole length, which is the case that splits tops.
function spanAcross(wide, other) {
  const axis = wide.axes[1].direction, base = dot(wide.center, axis);
  let lo = Infinity, hi = -Infinity;
  for (const c of corners(other)) {
    const v = dot(c, axis) - base;
    lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  return Math.min(hi - lo, wide.axes[1].length);
}

// Supports under a horizontal part: where they sit along its length, and the
// biggest unsupported gap between them - the span that decides whether it sags.
function clearSpan(d, supports) {
  if (supports.length < 2) return 0;
  const axis = d.axes[0].direction, base = dot(d.center, axis);
  const at = supports.map((s) => dot(s.center, axis) - base).sort((a, b) => a - b);
  let gap = 0;
  for (let i = 1; i < at.length; i++) gap = Math.max(gap, at[i] - at[i - 1]);
  return gap;
}

const UP = [0, 1, 0];
// What you sit on, for the seat-height check. The seat itself if the model
// names one, else the bench or stool top.
const SEAT_NAME = /\b(seat|saddle)\b/i, SEAT_ALSO = /\b(bench|stool|top)\b/i;

// Build the review model. `ctx` hands over the viewer's own lookups:
// { rows, objectDims, meshByName, rowByMeshName, contactsOf, joineryOf,
//   cutsOf, speciesOf, title, height, isCut }
export function buildReviewModel(ctx) {
  const { rows, objectDims, meshByName, rowByMeshName, isCut } = ctx;
  const usable = rows.filter((r) => isCut(r) && r.clickable && !r.status);
  const dimsOf = (r) => objectDims[r.obj_names?.[0]];
  const parts = usable.map((r) => {
    const mesh = meshByName.get(r.obj_names?.[0]);
    const d = dimsOf(r);
    const panel = panelFor(r.materialLabel, r.material);
    const props = propsFor({ panel, species: panel ? null : ctx.speciesOf(r) });
    const part = {
      key: r.key, name: r.name, letter: r.letter || '', count: r.count, category: r.category,
      wood: isCut(r), dims: r.dims, props, sawn: 'unknown',
      grain: null, horizontal: false, touches: [], tenons: [], butts: [], cuts: [], holes: [],
    };
    if (!d?.axes || d.axes.length !== 3 || r.joined || r.customDims) return part;
    // Grain runs along a board's length - the same assumption the 3D view
    // already draws the wood texture with.
    part.grain = d.axes[0].direction;
    // Lying flat: its faces are up, so it could be a shelf, seat or top.
    part.horizontal = Math.abs(dot(d.axes[2].direction, UP)) > 0.9;

    const contacts = [];
    if (mesh) {
      for (const o of ctx.contactsOf(mesh)) {
        const or = rowByMeshName.get(o.name), od = objectDims[o.name];
        if (!or || or.status || or.key === r.key || !od?.axes) continue;
        contacts.push({ row: or, dims: od });
        part.touches.push({ key: or.key, name: or.name, span: spanAcross(d, od) });
      }
    }
    if (part.horizontal) {
      // Anything whose middle sits below this part is holding it up.
      const below = contacts.filter((c) => dot(c.dims.center, UP) < dot(d.center, UP) - d.axes[2].length / 2);
      part.supportSpan = clearSpan(d, below.map((c) => c.dims));
    }

    const j = ctx.joineryOf(r, mesh);
    if (j) {
      part.tenons = j.cuts.filter((t) => t.kind === 'tenon').map((t) => ({
        into: t.row.name, intoKey: t.row.key, length: t.depth, through: t.through,
        thickness: Math.min(t.width, t.thick), width: Math.max(t.width, t.thick),
      }));
      part.butts = j.butts.map((b) => ({ key: b.key, name: b.name }));
    }
    const len = d.axes[0].length;
    for (const f of ctx.cutsOf(r, mesh)) {
      const depth = f.box[1][f.axis] - f.box[0][f.axis];
      if (f.kind === 'hole' && f.dia) {
        part.holes.push({ diameter: f.dia, fromEnd: Math.max(0, Math.min(f.box[0][0], len - f.box[1][0])) });
      } else {
        part.cuts.push({ kind: f.kind, through: f.through, depth });
      }
    }
    const ys = corners(d).map((c) => c[1]);
    part.top = Math.max(...ys);
    part.bottom = Math.min(...ys);
    return part;
  });
  return { title: ctx.title, height: ctx.height, seatHeight: seatHeight(parts), parts };
}

// How high off the ground the seat sits. Measured from the bottom of the
// whole model, which is the floor it stands on.
function seatHeight(parts) {
  const flat = parts.filter((p) => p.horizontal && p.top != null);
  const seat = flat.find((p) => SEAT_NAME.test(p.name)) || flat.find((p) => SEAT_ALSO.test(p.name));
  if (!seat) return 0;
  const floor = Math.min(...parts.filter((p) => p.bottom != null).map((p) => p.bottom));
  return seat.top - floor;
}

// ---------- the panel ----------

const ICON = { problem: '⚠', watch: '◆', note: 'ℹ' };
const HEADING = { problem: 'will cause trouble', watch: 'worth changing', note: 'worth knowing' };

export function reviewHtml(result, { open = false } = {}) {
  const { findings, counts } = result;
  if (!findings.length) {
    return '<div class="model-check ok">✓ Design review: nothing to flag - no cross-grain traps, no under-sized joints, nothing that will sag.</div>';
  }
  const title = ['problem', 'watch', 'note']
    .filter((s) => counts[s]).map((s) => `${counts[s]} ${HEADING[s]}`).join(' · ');
  const worst = counts.problem ? 'problem' : counts.watch ? 'watch' : 'note';
  const items = findings.map((f) => `<li class="dr-${f.severity}">
    <span class="mc-kind">${ICON[f.severity]} ${escapeHtml(f.title)}</span>
    ${f.key ? `<a href="#" data-key="${escapeHtml(f.key)}">${f.letter ? `${escapeHtml(f.letter)} ` : ''}${escapeHtml(f.name)}</a> ` : ''}${escapeHtml(f.text)}
    <div class="dr-why">${escapeHtml(f.why)}</div>
    <div class="dr-fix"><b>Do this:</b> ${escapeHtml(f.fix)}</div>
  </li>`).join('');
  return `<details class="model-check design-review${worst === 'problem' ? ' warn' : ''}"${open ? ' open' : ''}>
    <summary>${ICON[worst]} Design review: ${escapeHtml(title)}</summary>
    <ul>${items}</ul>
    <div class="dr-foot">Standard practice, not law - break any of it on purpose.</div>
  </details>`;
}

// The same findings for the printed sheet: no links, no toggles, and the
// notes left out - on paper you want what to do differently, not the trivia.
export function reviewPrintHtml(result) {
  const findings = (result?.findings || []).filter((f) => f.severity !== 'note');
  if (!findings.length) return '';
  return `<h2>Design review</h2><ul class="ps-review">${findings.map((f) => `<li>
    <b>${ICON[f.severity]} ${escapeHtml(f.title)}</b>${f.name ? ` — ${escapeHtml(f.letter ? `${f.letter} ${f.name}` : f.name)}` : ''} ${escapeHtml(f.text)}
    <div class="ps-why">${escapeHtml(f.why)}</div>
    <div class="ps-fix">Do this: ${escapeHtml(f.fix)}</div></li>`).join('')}</ul>`;
}

// Renders into `el` and wires the part links. Returns the result, so the
// caller can put the same findings on the printed sheet.
export function renderReview(el, ctx, { units = 'in16', open = false, onPick } = {}) {
  const model = buildReviewModel(ctx);
  const result = reviewModel(model, { units });
  el.innerHTML = reviewHtml(result, { open });
  const details = el.querySelector('details');
  if (details && ctx.onToggle) details.addEventListener('toggle', (e) => ctx.onToggle(e.target.open));
  el.querySelectorAll('a[data-key]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    onPick?.(a.dataset.key);
  }));
  return result;
}

export { SEVERITY };
