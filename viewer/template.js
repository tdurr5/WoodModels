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

// One view of the part as vector lines, in inches: its silhouette (every
// triangle projected, filled) and its outline edges (look.js featureEdges -
// the corners, the cuts, the curve of a shaped edge). `across` is the
// page's horizontal axis, `up` its vertical (unit Vector3s through `center`).
// Vector, not a picture of the model: sharp at any length, so a 46" bench
// prints lines as fine as a 6" block.
function vectorView(mesh, center, across, up, halfW, halfH, holes = [], units = 'in') {
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
  const e = featureEdges(mesh.geometry);
  const lines = [];
  for (let i = 0; i + 5 < e.length; i += 6) lines.push(`M${xy(e[i], e[i + 1], e[i + 2])}L${xy(e[i + 3], e[i + 4], e[i + 5])}`);
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
    <path d="${lines.join('')}" fill="none" stroke="#000" stroke-width="0.012" stroke-linecap="round"/>
    <path d="${cl}" stroke="#3366cc" stroke-width="0.01" stroke-dasharray="0.25 0.12"/>${marks}`;
  return { svg, wIn, hIn };
}

// Cut a view into letter-size tiles that overlap 1/2" for taping. Short
// tiles (an edge view) share a page, stacked, so a long thin part doesn't
// take a sheet per 7" of strip.
function tiles(img, title, sub, k = 1) {
  // drawing inches (the part's) vs paper inches: one drawing inch is k on paper
  const pageW = PAGE.w / k, pageH = PAGE.h / k, ov = OVERLAP / k;
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
    if (last && last.h + GAP + c.th <= PAGE.h) { last.cells.push(c); last.h += GAP + c.th; } else pages.push({ cells: [c], h: c.th });
  });
  const n = cells.length;
  return pages.map((pg) => `
        <div class="tpl-page">
          <div class="tpl-head">
            <div><b>${escapeHtml(title)}</b> — ${escapeHtml(sub)} · tile${pg.cells.length > 1 ? 's' : ''} <b>${pg.cells.map((c) => c.id).join(', ')}</b> of ${n}${n > 1 ? ` (${ny} row${ny > 1 ? 's' : ''} × ${nx})` : ''}${pg.cells.length > 1 ? ' - cut them apart' : ''}</div>
            <div class="tpl-check">${atScale(SQUARE_SVG, k)}<span class="tpl-checkcol">${atScale(RULER_SVG, k)}<span>${k !== 1 ? `<b>Made ${((k - 1) * 100).toFixed(1)}% bigger for your printer</b> (it printed the 6" ruler short). ` : ''}Print at 100% / "Actual size", not "fit to page". Check with a tape: the square is exactly 1", the ruler exactly 6" - a printer that shrinks the page by 2% is 1/8" short here.${n > 1 ? ' Trim each sheet on its ✂ line, lay that edge on the next sheet\'s dashed line, and check the pink crosses sit exactly on top of each other (hold them up to a light). Then tape.' : ''}</span></span></div>
          </div>
          <div class="tpl-cells">${pg.cells.map((c) => c.html).join('')}</div>
        </div>`).join('');
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
  const center = new THREE.Vector3(...dims.center);
  const u = new THREE.Vector3(...L.direction).normalize();
  const v = new THREE.Vector3(...W.direction).normalize();
  const w = new THREE.Vector3(...T.direction).normalize();
  // Parts wider than they are long read better stood the other way on paper,
  // but keep length horizontal: it's how you'd lay the template on a board.
  const face = vectorView(mesh, center, u, v, L.length / 2, W.length / 2, holes, units);
  const edge = withEdge && vectorView(mesh, center, u, w, L.length / 2, T.length / 2, holes, units);
  const size = `${formatLength(L.length, units)} × ${formatLength(W.length, units)} × ${formatLength(T.length, units)}`;
  return tiles(face, name, `face view (looking through the thickness), ${size}`, k)
    + (edge ? tiles(edge, name, `EDGE view - the part seen from its edge (only for cuts in the edge), ${size}`, k) : '');
}
