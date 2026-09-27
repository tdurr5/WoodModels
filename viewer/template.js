// Full-size (1:1) printable templates of a part: the part is rendered
// orthographically, looking straight down its thickness (face view) and its
// width (edge view), at a known pixels-per-inch, then tiled across letter
// pages with overlap and alignment marks so the tiles can be taped together
// and traced onto stock.

import * as THREE from 'three';
import { formatLength, escapeHtml } from './format.js';
import { featureEdges } from './look.js';

const MARGIN_IN = 0.3;     // blank border around the part in the render
const PAGE = { w: 7.5, h: 8.6 }; // printable tile area on letter with 0.5" margins, under the header
// a 6" ruler in 1/8"s: a bigger check than the 1" square
const RULER = `<svg class="tpl-ruler" width="6in" height="0.32in" viewBox="0 0 6 0.32">
  <rect x="0" y="0" width="6" height="0.32" fill="none" stroke="#000" stroke-width="0.01"/>
  ${Array.from({ length: 49 }, (_, i) => `<line x1="${i / 8}" x2="${i / 8}" y1="0" y2="${i % 8 === 0 ? 0.22 : i % 4 === 0 ? 0.15 : i % 2 === 0 ? 0.1 : 0.06}" stroke="#000" stroke-width="0.008"/>`).join('')}
  ${[1, 2, 3, 4, 5].map((n) => `<text x="${n}" y="0.3" font-size="0.09" text-anchor="middle">${n}</text>`).join('')}
</svg>`;
const OVERLAP = 0.5;       // inches each tile overlaps its neighbours

// One view of the part as vector lines, in inches: its silhouette (every
// triangle projected, filled) and its outline edges (look.js featureEdges -
// the corners, the cuts, the curve of a shaped edge). `across` is the
// page's horizontal axis, `up` its vertical (unit Vector3s through `center`).
// Vector, not a picture of the model: sharp at any length, so a 46" bench
// prints lines as fine as a 6" block.
function vectorView(mesh, center, across, up, halfW, halfH) {
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
  const svg = `<path d="${fill.join('')}" fill="#e9e2d6"/>
    <path d="${lines.join('')}" fill="none" stroke="#000" stroke-width="0.012" stroke-linecap="round"/>
    <path d="${cl}" stroke="#3366cc" stroke-width="0.01" stroke-dasharray="0.25 0.12"/>`;
  return { svg, wIn, hIn };
}

// Cut a view into letter-size tiles that overlap 1/2" for taping. Short
// tiles (an edge view) share a page, stacked, so a long thin part doesn't
// take a sheet per 7" of strip.
function tiles(img, title, sub) {
  const stepX = PAGE.w - OVERLAP, stepY = PAGE.h - OVERLAP;
  const nx = Math.max(1, Math.ceil((img.wIn - OVERLAP) / stepX));
  const ny = Math.max(1, Math.ceil((img.hIn - OVERLAP) / stepY));
  const cells = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = i * stepX, y = j * stepY;
      const tw = Math.min(PAGE.w, img.wIn - x), th = Math.min(PAGE.h, img.hIn - y);
      const id = `${String.fromCharCode(65 + j)}${i + 1}`;
      const marks = [];
      if (i > 0) marks.push(`<div class="tpl-overlap v" style="left:0;width:${OVERLAP}in"></div>`);
      if (j > 0) marks.push(`<div class="tpl-overlap h" style="top:0;height:${OVERLAP}in"></div>`);
      cells.push({ id, th, html: `
          <div class="tpl-tile" style="width:${tw}in;height:${th}in">
            <svg class="tpl-svg" width="${tw}in" height="${th}in" viewBox="${x} ${y} ${tw} ${th}">${img.svg}</svg>
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
            <div class="tpl-check"><span class="tpl-inch"><i style="left:0.25in"></i><i style="left:0.5in"></i><i style="left:0.75in"></i></span><span class="tpl-checkcol">${RULER}<span>Print at 100% / "Actual size", not "fit to page". Check with a tape: the square is exactly 1", the ruler exactly 6" - a printer that shrinks the page by 2% is 1/8" short here.${n > 1 ? ' Overlap each tile 1/2" so its edge sits on the neighbour\'s dashed line, then tape.' : ''}</span></span></div>
          </div>
          <div class="tpl-cells">${pg.cells.map((c) => c.html).join('')}</div>
        </div>`).join('');
}

// Builds the printable HTML for a part. `dims` is its object_dims.json entry
// ({ center, axes: [{direction, length, role}] }).
export function buildTemplate(renderer, mesh, dims, name, units) {
  const byRole = Object.fromEntries(dims.axes.map((a) => [a.role, a]));
  const L = byRole.Length, W = byRole.Width, T = byRole.Thickness;
  if (!L || !W || !T) return '';
  const center = new THREE.Vector3(...dims.center);
  const u = new THREE.Vector3(...L.direction).normalize();
  const v = new THREE.Vector3(...W.direction).normalize();
  const w = new THREE.Vector3(...T.direction).normalize();
  // Parts wider than they are long read better stood the other way on paper,
  // but keep length horizontal: it's how you'd lay the template on a board.
  const face = vectorView(mesh, center, u, v, L.length / 2, W.length / 2);
  const edge = vectorView(mesh, center, u, w, L.length / 2, T.length / 2);
  const size = `${formatLength(L.length, units)} × ${formatLength(W.length, units)} × ${formatLength(T.length, units)}`;
  return tiles(face, name, `face view (looking through the thickness), ${size}`)
    + tiles(edge, name, `edge view (looking across the width), ${size}`);
}
