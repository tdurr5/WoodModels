// Full-size (1:1) printable templates of a part: the part is rendered
// orthographically, looking straight down its thickness (face view) and its
// width (edge view), at a known pixels-per-inch, then tiled across letter
// pages with overlap and alignment marks so the tiles can be taped together
// and traced onto stock.

import * as THREE from 'three';
import { formatLength, escapeHtml } from './format.js';
import { featureEdges } from './look.js';

const MARGIN_IN = 0.15;    // blank border around the part (small: an 8" board fits one row even when enlarged for a printer)
const PAGE = { w: 7.5, h: 8.65 }; // printable tile area on letter with 0.5" margins, under the header
// Printer correction: some printers shrink every page a few percent (fit to
// the printable area) and won't be told otherwise. Measure the 6" ruler on
// a printout, and everything after is drawn that much bigger to make up
// for it: k = 6 / what you measured. "5 3/4", "5-3/4", "5.75" all work.
export function parseMeasured(text) {
  const m = String(text || '').trim().replace(/["”in]+$/i, '').match(/^(\d+(?:\.\d+)?)?(?:[\s-]*(\d+)\s*\/\s*(\d+))?$/);
  if (!m || (!m[1] && !m[2])) return null;
  const v = (m[1] ? +m[1] : 0) + (m[2] ? +m[2] / +m[3] : 0);
  return v > 0 ? v : null;
}
export const printCorrection = (measured) => (measured > 5 && measured < 7 ? 6 / measured : 1);

// a 6" ruler in 1/8"s: a bigger check than the 1" square. The square too,
// drawn exact (its outline's outer edge is 1").
const RULER_SVG = `<svg class="tpl-ruler" width="6in" height="0.32in" viewBox="0 0 6 0.32">
  <rect x="0" y="0" width="6" height="0.32" fill="none" stroke="#000" stroke-width="0.01"/>
  ${Array.from({ length: 49 }, (_, i) => `<line x1="${i / 8}" x2="${i / 8}" y1="0" y2="${i % 8 === 0 ? 0.22 : i % 4 === 0 ? 0.15 : i % 2 === 0 ? 0.1 : 0.06}" stroke="#000" stroke-width="0.008"/>`).join('')}
  ${[1, 2, 3, 4, 5].map((n) => `<text x="${n}" y="0.3" font-size="0.09" text-anchor="middle">${n}</text>`).join('')}
</svg>`;
const SQUARE_SVG = `<svg class="tpl-square" width="1in" height="1in" viewBox="0 0 1 1">
  <rect x="0.005" y="0.005" width="0.99" height="0.99" fill="none" stroke="#000" stroke-width="0.01"/>
  ${[0.25, 0.5, 0.75].map((x) => `<line x1="${x}" x2="${x}" y1="1" y2="0.88" stroke="#000" stroke-width="0.008"/>`).join('')}
</svg>`;
// the same, k times bigger on paper
const atScale = (svg, k) => svg.replace(/width="([\d.]+)in" height="([\d.]+)in"/, (_, w, h) => `width="${+w * k}in" height="${+h * k}in"`);
const OVERLAP = 0.5;       // inches each tile overlaps its neighbours
const NOTE_H = 0.6;        // room for the how-to-cut note under a template's header

// One view of the part as vector lines, in inches: its silhouette (every
// triangle projected, filled) and its outline edges (look.js featureEdges -
// the corners, the cuts, the curve of a shaped edge). `across` is the
// page's horizontal axis, `up` its vertical (unit Vector3s through `center`).
// Vector, not a picture of the model: sharp at any length, so a 46" bench
// prints lines as fine as a 6" block.
function vectorView(mesh, center, across, up, halfW, halfH, holes = [], units = 'in', flat = '') {
  const wIn = halfW * 2 + MARGIN_IN * 2, hIn = halfH * 2 + MARGIN_IN * 2;
  const p = new THREE.Vector3();
  const xy = (x, y, z) => {
    p.set(x, y, z).sub(center);
    return [(p.dot(across) + halfW + MARGIN_IN).toFixed(4), (halfH - p.dot(up) + MARGIN_IN).toFixed(4)];
  };
  const pos = mesh.geometry.attributes.position;
  const fill = [];
  for (let i = 0; i + 2 < pos.count; i += 3) {
    const a = xy(pos.getX(i), pos.getY(i), pos.getZ(i)), b = xy(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1)), c = xy(pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2));
    fill.push(`M${a}L${b}L${c}Z`);
  }
  // Only the edges you'd see from this side are drawn as lines to cut to;
  // ones behind the part (the far face's notches, a housing on the other
  // side) are faint dashes. Each edge is tested at a few points along it:
  // does a ray from there towards the viewer pass through the part?
  const e = featureEdges(mesh.geometry);
  const solid = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  solid.updateMatrixWorld();
  const toViewer = across.clone().cross(up).normalize();
  const ray = new THREE.Raycaster();
  const q = new THREE.Vector3();
  const hidden = (x, y, z) => {
    ray.set(q.set(x, y, z).addScaledVector(toViewer, 0.01), toViewer);
    return ray.intersectObject(solid, false).length > 0;
  };
  const lines = [], back = [];
  const N = 8;
  // A flat board is traced from the face you lay it on: its outline is the
  // line to cut to. The back face's outline is only where a bevelled end or
  // a leaning edge comes out (dashed), however much of it peeks past the
  // front, and the short corners joining the two aren't drawn at all.
  // Seen from its edge, the bevel at each end is a slanted line on each
  // edge: the edge facing you is solid, the far one (deeper than the middle
  // of the board) dashed, so the two don't read as two cuts.
  let near = -Infinity, far = Infinity;
  if (flat) {
    for (let i = 0; i < pos.count; i++) {
      const d = q.set(pos.getX(i), pos.getY(i), pos.getZ(i)).dot(toViewer);
      near = Math.max(near, d); far = Math.min(far, d);
    }
  }
  const TOL = 0.02;
  const plane = (x, y, z) => {
    const d = q.set(x, y, z).dot(toViewer);
    return Math.abs(d - near) < TOL ? 'near' : Math.abs(d - far) < TOL ? 'far' : '';
  };
  for (let i = 0; i + 5 < e.length; i += 6) {
    const at = (t) => [e[i] + (e[i + 3] - e[i]) * t, e[i + 1] + (e[i + 4] - e[i + 1]) * t, e[i + 2] + (e[i + 5] - e[i + 2]) * t];
    if (flat === 'edge') {
      const m = at(0.5);
      if (q.set(...m).dot(toViewer) < (near + far) / 2 - TOL) { back.push(`M${xy(...at(0))}L${xy(...at(1))}`); continue; }
    }
    if (flat === 'face') {
      const a = plane(e[i], e[i + 1], e[i + 2]), b = plane(e[i + 3], e[i + 4], e[i + 5]);
      if (a === 'far' && b === 'far') { back.push(`M${xy(...at(0))}L${xy(...at(1))}`); continue; }
      if (a && b && a !== b) continue;
      if (a === 'near' && b === 'near') { lines.push(`M${xy(...at(0))}L${xy(...at(1))}`); continue; }
    }
    // split the edge where it goes behind the part: test the middle of each
    // slice, join neighbouring slices that agree
    const h = Array.from({ length: N }, (_, k) => hidden(...at((k + 0.5) / N)));
    for (let k = 0, start = 0; k < N; k++) {
      if (k === N - 1 || h[k + 1] !== h[k]) {
        (h[k] ? back : lines).push(`M${xy(...at(start / N))}L${xy(...at((k + 1) / N))}`);
        start = k + 1;
      }
    }
  }
  solid.material.dispose();
  // centre line along the length, handy for laying out
  const cl = `M${(MARGIN_IN * 0.4).toFixed(4)},${(halfH + MARGIN_IN).toFixed(4)}H${(wIn - MARGIN_IN * 0.4).toFixed(4)}`;
  // holes the model didn't draw (holes.js): a circle and crosshair where the
  // bolt goes in when you look along it, else the bore as dashed lines
  const look = across.clone().cross(up);
  const marks = holes.map((h) => {
    const a = new THREE.Vector3(...h.axis), r = h.dia / 2;
    const [cx, cy] = xy(...h.from).map(Number);
    const label = `<text x="${(cx + r + 0.08).toFixed(3)}" y="${(cy - r - 0.04).toFixed(3)}" font-size="0.14" fill="#c0392b">⌀${escapeHtml(formatLength(h.dia, units))} (not in the model)</text>`;
    if (Math.abs(a.dot(look)) > 0.8) {
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#c0392b" stroke-width="0.015"/>
        <path d="M${cx - r * 1.6},${cy}H${cx + r * 1.6}M${cx},${cy - r * 1.6}V${cy + r * 1.6}" stroke="#c0392b" stroke-width="0.01"/>${label}`;
    }
    const [tx, ty] = xy(...h.to).map(Number);
    const n = [-(ty - cy), tx - cx], l = Math.hypot(...n) || 1;
    const o = [n[0] / l * r, n[1] / l * r];
    return `<path d="M${cx + o[0]},${cy + o[1]}L${tx + o[0]},${ty + o[1]}M${cx - o[0]},${cy - o[1]}L${tx - o[0]},${ty - o[1]}" stroke="#c0392b" stroke-width="0.012" stroke-dasharray="0.08 0.05"/>${label}`;
  }).join('');
  const svg = `<path d="${fill.join('')}" fill="#e9e2d6"/>
    <path d="${back.join('')}" fill="none" stroke="#999" stroke-width="0.008" stroke-dasharray="0.06 0.05"/>
    <path d="${lines.join('')}" fill="none" stroke="#000" stroke-width="0.012" stroke-linecap="round"/>
    <path d="${cl}" stroke="#3366cc" stroke-width="0.01" stroke-dasharray="0.25 0.12"/>${marks}`;
  return { svg, wIn, hIn };
}

// Cut a view into letter-size tiles that overlap 1/2" for taping. Short
// tiles (an edge view) share a page, stacked, so a long thin part doesn't
// take a sheet per 7" of strip.
function tiles(img, title, sub, k = 1, note = '') {
  // drawing inches (the part's) vs paper inches: one drawing inch is k on paper.
  // A note under the header takes its room from the tiles.
  const roomH = PAGE.h - (note ? NOTE_H : 0);
  const pageW = PAGE.w / k, pageH = roomH / k, ov = OVERLAP / k;
  const stepX = pageW - ov, stepY = pageH - ov;
  const nx = Math.max(1, Math.ceil((img.wIn - ov) / stepX));
  const ny = Math.max(1, Math.ceil((img.hIn - ov) / stepY));
  // Alignment crosses in the middle of every overlap strip, in the part's
  // own coordinates: they print on both sheets of a joint, so when the
  // sheets are overlapped right the crosses sit exactly on top of each other
  // (check against a window or a light). A sloped or curved line then meets
  // itself too - a straight one lines up however far you slide it.
  const c = 0.15 / k, cross = (x, y) => `M${x - c},${y}H${x + c}M${x},${y - c}V${y + c}`;
  const reg = [];
  for (let i = 1; i < nx; i++) {
    const x = i * stepX + ov / 2;
    for (let y = 0.5 / k; y < img.hIn; y += 2 / k) reg.push(cross(x, y));
  }
  for (let j = 1; j < ny; j++) {
    const y = j * stepY + ov / 2;
    for (let x = 0.5 / k; x < img.wIn; x += 2 / k) reg.push(cross(x, y));
  }
  const regSvg = reg.length ? `<path d="${reg.join('')}" stroke="#e0218a" stroke-width="${0.012 / k}"/>` : '';
  const cells = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = i * stepX, y = j * stepY;
      const tw = Math.min(pageW, img.wIn - x), th = Math.min(pageH, img.hIn - y);
      const id = `${String.fromCharCode(65 + j)}${i + 1}`;
      const marks = [];
      if (i > 0) marks.push(`<div class="tpl-overlap v" style="left:0;width:${OVERLAP}in"></div>`);
      if (j > 0) marks.push(`<div class="tpl-overlap h" style="top:0;height:${OVERLAP}in"></div>`);
      // where the paper's edge lands depends on the printer, so trim this
      // sheet on the tile's own edge: that edge goes on the next one's dashed line
      if (i < nx - 1) marks.push('<div class="tpl-trim v"><span>✂ trim</span></div>');
      if (j < ny - 1) marks.push('<div class="tpl-trim h"><span>✂ trim</span></div>');
      cells.push({ id, th: th * k, html: `
          <div class="tpl-tile" style="width:${tw * k}in;height:${th * k}in">
            <svg class="tpl-svg" width="${tw * k}in" height="${th * k}in" viewBox="${x} ${y} ${tw} ${th}">${img.svg}${regSvg}</svg>
            ${marks.join('')}
            <span class="tpl-id">${id}</span>
          </div>` });
    }
  }
  // as many tiles to a page as fit its height
  const pages = [];
  const GAP = 0.25;
  cells.forEach((c) => {
    const last = pages[pages.length - 1];
    if (last && last.h + GAP + c.th <= roomH) { last.cells.push(c); last.h += GAP + c.th; } else pages.push({ cells: [c], h: c.th });
  });
  const n = cells.length;
  return pages.map((pg, i) => `
        <div class="tpl-page">
          <div class="tpl-head">
            <div><b>${escapeHtml(title)}</b> — ${escapeHtml(sub)} · tile${pg.cells.length > 1 ? 's' : ''} <b>${pg.cells.map((c) => c.id).join(', ')}</b> of ${n}${n > 1 ? ` (${ny} row${ny > 1 ? 's' : ''} × ${nx})` : ''}${pg.cells.length > 1 ? ' - cut them apart' : ''}</div>
            <div class="tpl-check">${atScale(SQUARE_SVG, k)}<span class="tpl-checkcol">${atScale(RULER_SVG, k)}<span>${k !== 1 ? `<b>Made ${((k - 1) * 100).toFixed(1)}% bigger for your printer</b> (it printed the 6" ruler short). ` : ''}Print at 100% / "Actual size", not "fit to page". Check with a tape: the square is exactly 1", the ruler exactly 6" - a printer that shrinks the page by 2% is 1/8" short here.${n > 1 ? ' Trim each sheet on its ✂ line, lay that edge on the next sheet\'s dashed line, and check the pink crosses sit exactly on top of each other (hold them up to a light). Then tape.' : ''}</span></span></div>
            ${note && i === 0 ? `<div class="tpl-note">${note}</div>` : ''}
          </div>
          <div class="tpl-cells">${pg.cells.map((c) => c.html).join('')}</div>
        </div>`).join('');
}

// The flat face to look through. The cut list's box is fitted around the
// whole part, so on a board with bevelled ends (a splayed leg sawn from a
// 2x4) it leans a few degrees off the board's faces - and a view along it
// shows the front and back outlines side by side, a 3D drawing instead of
// a shape to trace. This finds the largest flat face near the box's
// thickness axis and turns the view square to it: length stays along the
// board, extents and centre are re-measured in that frame, and `stock` is
// the true face-to-face thickness. Each end's saw settings come with it:
// `miter` is the end line's angle off square across the face, `bevel` the
// blade's tilt off 90° through the thickness. Without such a face (a
// turned or carved part) the box's own axes are kept.
export function faceFrame(geometry, u0, v0, w0) {
  const pos = geometry.attributes.position;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  const tris = [];
  for (let i = 0; i + 2 < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    n.subVectors(b, a).cross(c.clone().sub(a));
    const area = n.length() / 2;
    if (area < 1e-8) continue;
    tris.push({ n: n.clone().normalize(), area, mid: a.clone().add(b).add(c).divideScalar(3) });
  }
  // gather triangles into flat faces by normal (either side: SketchUp draws back-to-back copies)
  const groups = (list) => {
    const out = [];
    for (const t of list) {
      const g = out.find((o) => Math.abs(o.n.dot(t.n)) > 0.9998);
      if (g) g.area += t.area; else out.push({ n: t.n.clone(), area: t.area, tris: [] });
      (g || out[out.length - 1]).tris.push(t);
    }
    return out.sort((x, y) => y.area - x.area);
  };
  const face = groups(tris.filter((t) => Math.abs(t.n.dot(w0)) > Math.cos(THREE.MathUtils.degToRad(20))))[0];
  if (!face) return null;
  const w = face.n.clone();
  if (w.dot(w0) < 0) w.negate();
  const u = u0.clone().addScaledVector(w, -u0.dot(w)).normalize();
  const v = w.clone().cross(u);
  if (v.dot(v0) < 0) v.negate();
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.count; i++) {
    a.fromBufferAttribute(pos, i);
    [u, v, w].forEach((ax, k) => { const d = a.dot(ax); lo[k] = Math.min(lo[k], d); hi[k] = Math.max(hi[k], d); });
  }
  const center = new THREE.Vector3()
    .addScaledVector(u, (lo[0] + hi[0]) / 2).addScaledVector(v, (lo[1] + hi[1]) / 2).addScaledVector(w, (lo[2] + hi[2]) / 2);
  // the end cuts: the biggest flat face at each end of the length
  const deg = (r) => THREE.MathUtils.radToDeg(r);
  const ends = {};
  for (const side of [-1, 1]) {
    const end = groups(tris.filter((t) => Math.abs(t.n.dot(u)) > 0.5 && Math.sign(t.mid.clone().sub(center).dot(u)) === side))[0];
    if (!end) continue;
    const line = w.clone().cross(end.n); // where the end meets the face
    const out = end.n.clone().multiplyScalar(Math.sign(end.n.dot(u)) * side); // pointing off the end
    ends[side < 0 ? 'left' : 'right'] = {
      // how much further out the cut comes through on the back face (negative: further in)
      back: (hi[2] - lo[2]) * out.dot(w) / Math.abs(out.dot(u)),
      miter: deg(Math.atan2(Math.abs(line.dot(u)), Math.abs(line.dot(v)))),
      bevel: deg(Math.asin(Math.min(1, Math.abs(end.n.dot(w))))),
    };
  }
  return { u, v, w, center, halfL: (hi[0] - lo[0]) / 2, halfW: (hi[1] - lo[1]) / 2, stock: hi[2] - lo[2], ends };
}

// "45° miter, 12° bevel" - what to set the saw to for one end
export function endCutText({ miter, bevel }) {
  const m = Math.round(miter), b = Math.round(bevel);
  if (!m && !b) return 'square';
  return [m ? `${m}° miter` : '', b ? `${b}° bevel` : ''].filter(Boolean).join(', ');
}

// How to saw each end of a flat board, in words, for the face view's page:
// which saw settings, and where the cut comes out on the back.
export function endCutSteps(ends, units = 'in') {
  const out = [];
  for (const side of ['left', 'right']) {
    const e = ends[side];
    if (!e || endCutText(e) === 'square') continue;
    const m = Math.round(e.miter), b = Math.round(e.bevel);
    const kind = m && b ? `compound cut - ${m}° miter, ${b}° bevel` : m ? `${m}° miter, blade square` : `${b}° bevel, square across`;
    const exit = b && Math.abs(e.back) >= 1 / 32
      ? ` Tilt the blade so the cut comes out on the back face ${formatLength(Math.abs(e.back), units)} ${e.back > 0 ? 'further out' : 'further in'} than the solid line (the dashed line on the back).`
      : '';
    out.push(`<b>${side === 'left' ? 'Left' : 'Right'} end:</b> ${kind}.${exit}`);
  }
  return out.length ? `Trace the solid outline on the face of the board. ${out.join(' ')} The miter is measured off square to the blue centre line.` : '';
}

// Builds the printable HTML for a part. `dims` is its object_dims.json entry
// ({ center, axes: [{direction, length, role}] }).
// The face view is the shape you trace; the edge view (the part seen from
// its edge, thickness-wide) only matters for cuts in an edge, so it's
// printed only when asked for (withEdge).
export function buildTemplate(renderer, mesh, dims, name, units, holes = [], k = 1, withEdge = false) {
  const byRole = Object.fromEntries(dims.axes.map((a) => [a.role, a]));
  const L = byRole.Length, W = byRole.Width, T = byRole.Thickness;
  if (!L || !W || !T) return '';
  let center = new THREE.Vector3(...dims.center);
  let u = new THREE.Vector3(...L.direction).normalize();
  let v = new THREE.Vector3(...W.direction).normalize();
  let w = new THREE.Vector3(...T.direction).normalize();
  let halfL = L.length / 2, halfW = W.length / 2, halfT = T.length / 2;
  // square the view to the board's own face (faceFrame)
  const f = faceFrame(mesh.geometry, u, v, w);
  if (f) ({ u, v, w, center, halfL, halfW } = f), halfT = f.stock / 2;
  // Parts wider than they are long read better stood the other way on paper,
  // but keep length horizontal: it's how you'd lay the template on a board.
  const face = vectorView(mesh, center, u, v, halfL, halfW, holes, units, f ? 'face' : '');
  const edge = withEdge && vectorView(mesh, center, u, w, halfL, halfT, holes, units, f ? 'edge' : '');
  const size = `${formatLength(L.length, units)} × ${formatLength(W.length, units)} × ${formatLength(T.length, units)}`;
  // what the stock really is, when the cut list's box is bigger than the board
  const stock = f && Math.abs(f.stock - T.length) > 1 / 32 ? ` - from ${formatLength(f.stock, units)} thick stock` : '';
  // the saw settings for each end, when either isn't square
  const ends = f && Object.values(f.ends).some((e) => endCutText(e) !== 'square')
    ? ` · ends: left ${f.ends.left ? endCutText(f.ends.left) : '-'}, right ${f.ends.right ? endCutText(f.ends.right) : '-'}` : '';
  const bevels = f && Object.values(f.ends).some((e) => Math.round(e.bevel));
  return tiles(face, name, `face view (looking through the thickness), ${size}${stock}${ends}`, k, f ? endCutSteps(f.ends, units) : '')
    + (edge ? tiles(edge, name, `EDGE view - the part seen from its edge (only for cuts in the edge), ${size}${stock}`, k,
      bevels ? 'Top and bottom lines are the two faces of the board. The slanted line at each end is the end\'s bevel through the thickness - <b>solid on the edge facing you</b>, dashed on the far edge (the miter moves it along).' : '') : '');
}
