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
//
// `profile` (flat boards, from flatProfile) swaps the projected silhouette
// for the board's face outline worked out exactly: drawn solid and filled,
// every side's length and every corner's angle marked, and the back face's
// side dashed only where a bevel brings it through somewhere else.
function vectorView(mesh, center, across, up, halfW, halfH, holes = [], units = 'in', profile = null) {
  const M = profile ? profile.margin : MARGIN_IN;
  const wIn = halfW * 2 + M * 2, hIn = halfH * 2 + M * 2;
  const p = new THREE.Vector3();
  const xy = (x, y, z) => {
    p.set(x, y, z).sub(center);
    return [(p.dot(across) + halfW + M).toFixed(4), (halfH - p.dot(up) + M).toFixed(4)];
  };
  const pos = mesh.geometry.attributes.position;
  const fill = [];
  for (let i = 0; !profile && i + 2 < pos.count; i += 3) {
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
  // a profile's outline is drawn from the profile; here only what's inside
  // the board (a bore, a housing) - no edge that touches either face
  const depth = (x, y, z) => q.set(x, y, z).sub(center).dot(toViewer);
  const onFace = (x, y, z) => profile && Math.abs(Math.abs(depth(x, y, z)) - profile.stock / 2) < 0.02;
  for (let i = 0; i + 5 < e.length; i += 6) {
    const at = (t) => [e[i] + (e[i + 3] - e[i]) * t, e[i + 1] + (e[i + 4] - e[i + 1]) * t, e[i + 2] + (e[i + 5] - e[i + 2]) * t];
    if (onFace(e[i], e[i + 1], e[i + 2]) || onFace(e[i + 3], e[i + 4], e[i + 5])) continue;
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
  const cl = `M${(M * 0.4).toFixed(4)},${(halfH + M).toFixed(4)}H${(wIn - M * 0.4).toFixed(4)}`;
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
  const svg = `${profile ? profileSvg(profile, (uv) => [uv[0] + halfW + M, halfH - uv[1] + M], units) : `<path d="${fill.join('')}" fill="#e9e2d6"/>`}
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
  // The note goes under the first page's header when the tiles leave room
  // for it, else on a page of its own in front.
  const lines = note ? note.split('<br>').reduce((n, l) => n + Math.ceil(l.replace(/<[^>]+>/g, '').length / 90), 0) : 0;
  const noteH = note ? 0.25 + 0.18 * lines : 0;
  const noteFirst = note && cells[0].th + noteH <= PAGE.h;
  // as many tiles to a page as fit its height
  const pages = [];
  const GAP = 0.25;
  cells.forEach((c) => {
    const last = pages[pages.length - 1];
    if (last && last.h + GAP + c.th <= PAGE.h - (pages.length === 1 && noteFirst ? noteH : 0)) { last.cells.push(c); last.h += GAP + c.th; } else pages.push({ cells: [c], h: c.th });
  });
  const n = cells.length;
  const notePage = note && !noteFirst ? `
        <div class="tpl-page">
          <div class="tpl-head"><div><b>${escapeHtml(title)}</b> — how to cut it (the full-size template follows)</div><div class="tpl-note">${note}</div></div>
        </div>` : '';
  return notePage + pages.map((pg, i) => `
        <div class="tpl-page">
          <div class="tpl-head">
            <div><b>${escapeHtml(title)}</b> — ${escapeHtml(sub)} · tile${pg.cells.length > 1 ? 's' : ''} <b>${pg.cells.map((c) => c.id).join(', ')}</b> of ${n}${n > 1 ? ` (${ny} row${ny > 1 ? 's' : ''} × ${nx})` : ''}${pg.cells.length > 1 ? ' - cut them apart' : ''}</div>
            <div class="tpl-check">${atScale(SQUARE_SVG, k)}<span class="tpl-checkcol">${atScale(RULER_SVG, k)}<span>${k !== 1 ? `<b>Made ${((k - 1) * 100).toFixed(1)}% bigger for your printer</b> (it printed the 6" ruler short). ` : ''}Print at 100% / "Actual size", not "fit to page". Check with a tape: the square is exactly 1", the ruler exactly 6" - a printer that shrinks the page by 2% is 1/8" short here.${n > 1 ? ' Trim each sheet on its ✂ line, lay that edge on the next sheet\'s dashed line, and check the pink crosses sit exactly on top of each other (hold them up to a light). Then tape.' : ''}</span></span></div>
            ${noteFirst && i === 0 ? `<div class="tpl-note">${note}</div>` : ''}
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
  const u = u0.clone().addScaledVector(face.n, -u0.dot(face.n)).normalize();
  const v = face.n.clone().cross(u);
  if (v.dot(v0) < 0) v.negate();
  // the face you see: the page's across × up (vectorView's viewer side), so
  // "the back face" in the saw steps is the one drawn dashed
  const w = u.clone().cross(v);
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

// --- Flat boards, worked out as a profile ---------------------------------
// A board sawn from flat stock is its face outline pushed through the
// thickness; at most its sides are bevelled. So rather than project the 3D
// model, take each face's outline exactly (the triangles lying in that
// plane, their boundary edges chained into loops, straight runs merged),
// pair every side of the face with the matching side of the back, and the
// distance between the two is the bevel: atan(offset / stock).

const deg = (r) => THREE.MathUtils.radToDeg(r);
const loopArea = (l) => l.reduce((s, a, i) => { const b = l[(i + 1) % l.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0) / 2;
// drop the points a straight side was drawn through (a hole's corners, SketchUp's splits)
function mergeStraight(l) {
  const out = l.slice();
  for (let i = 0; out.length > 3 && i < out.length;) {
    const a = out[(i + out.length - 1) % out.length], b = out[i], c = out[(i + 1) % out.length];
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const turn = ab && bc ? ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) / (ab * bc) : 0;
    const back = ab && bc ? (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) > 0 : true;
    if (ab < 1e-4 || (Math.abs(turn) < 0.003 && back)) out.splice(i, 1); else i++;
  }
  return out;
}

// The outlines of a flat board's two faces, in the face frame (f from
// faceFrame: u along the length, v across, w towards the face you see,
// all from its centre). Loops are counter-clockwise, the outer one first.
export function faceLoops(geometry, f, tol = 0.02) {
  const pos = geometry.attributes.position;
  const p = new THREE.Vector3();
  const pt = (i) => { p.fromBufferAttribute(pos, i).sub(f.center); return [p.dot(f.u), p.dot(f.v), p.dot(f.w)]; };
  const key = (q) => `${q[0].toFixed(3)},${q[1].toFixed(3)}`;
  const loopsAt = (depth) => {
    const seen = new Set(), count = new Map(), at = new Map();
    for (let i = 0; i + 2 < pos.count; i += 3) {
      const t = [pt(i), pt(i + 1), pt(i + 2)];
      if (t.some((q) => Math.abs(q[2] - depth) > tol)) continue;
      const ks = t.map(key);
      const id = [...ks].sort().join('|');
      if (new Set(ks).size < 3 || seen.has(id)) continue; // a sliver, or the back-to-back copy
      seen.add(id);
      t.forEach((q, j) => at.set(ks[j], [q[0], q[1]]));
      for (let j = 0; j < 3; j++) {
        const e = [ks[j], ks[(j + 1) % 3]].sort().join('|');
        count.set(e, (count.get(e) || 0) + 1);
      }
    }
    // an edge only one triangle has is on the outline
    const nb = new Map();
    const link = (a, b) => { if (!nb.has(a)) nb.set(a, []); nb.get(a).push(b); };
    for (const [e, n] of count) if (n === 1) { const [a, b] = e.split('|'); link(a, b); link(b, a); }
    const loops = [], used = new Set();
    for (const start of nb.keys()) {
      if (used.has(start)) continue;
      const loop = [start];
      used.add(start);
      for (let prev = null, cur = start; ;) {
        const next = nb.get(cur).find((k) => k !== prev && !used.has(k));
        if (!next) break;
        loop.push(next); used.add(next); prev = cur; cur = next;
      }
      if (loop.length >= 3) loops.push(mergeStraight(loop.map((k) => at.get(k))));
    }
    return loops.map((l) => (loopArea(l) < 0 ? l.reverse() : l)).sort((a, b) => loopArea(b) - loopArea(a));
  };
  return { near: loopsAt(f.stock / 2), far: loopsAt(-f.stock / 2) };
}

// Every side of the face's outline: its length, which way is out, the
// corner angle at its start, and the bevel - the back face's matching side
// (parallel, nearest) is `off` further out (negative: further in).
export function profileSides(loops, stock) {
  const outer = loops.near[0];
  if (!outer) return [];
  const back = loops.far[0] || [];
  const farSides = back.map((a, i) => [a, back[(i + 1) % back.length]]);
  const sides = outer.map((a, i) => {
    const b = outer[(i + 1) % outer.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const dir = [(b[0] - a[0]) / len, (b[1] - a[1]) / len], out = [dir[1], -dir[0]];
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let best = null;
    for (const [c, e] of farSides) {
      const fl = Math.hypot(e[0] - c[0], e[1] - c[1]);
      if (fl < 1e-6 || Math.abs(dir[0] * (e[1] - c[1]) - dir[1] * (e[0] - c[0])) / fl > 0.03) continue;
      const fm = [(c[0] + e[0]) / 2 - m[0], (c[1] + e[1]) / 2 - m[1]];
      const off = fm[0] * out[0] + fm[1] * out[1];
      // the same side only if it runs alongside this one, no further off than a 50° bevel
      // (a back face shaped differently - a notch on one face only - has sides that match nothing)
      const t0 = (c[0] - a[0]) * dir[0] + (c[1] - a[1]) * dir[1], t1 = (e[0] - a[0]) * dir[0] + (e[1] - a[1]) * dir[1];
      if (Math.min(len, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1)) < Math.min(len, fl) * 0.5) continue;
      if (Math.abs(off) > stock * Math.tan(THREE.MathUtils.degToRad(50))) continue;
      const score = Math.abs(off) + 0.05 * Math.abs(fm[0] * dir[0] + fm[1] * dir[1]);
      if (!best || score < best.score) best = { score, off, back: [c, e] };
    }
    const off = best ? best.off : 0;
    return { a, b, len, dir, out, mid: m, off, back: best && best.back, bevel: deg(Math.atan2(Math.abs(off), stock)) };
  });
  // the inside angle at each side's start, between the side before and this one
  sides.forEach((sd, i) => {
    const pr = sides[(i + sides.length - 1) % sides.length].dir;
    sd.corner = 180 - deg(Math.atan2(pr[0] * sd.dir[1] - pr[1] * sd.dir[0], pr[0] * sd.dir[0] + pr[1] * sd.dir[1]));
  });
  return sides;
}

const BEVEL_MIN = 6; // degrees; under it a side is sawn square (under 3/16" over 1-1/2" stock - a model's lean, not a cut)

// Which end of the length a side is at, for the words: left/right as printed
function sideName(sd, halfL) {
  if (Math.abs(sd.dir[0]) < 0.7 && Math.abs(sd.mid[0]) > halfL * 0.6) return sd.mid[0] < 0 ? 'Left end' : 'Right end';
  return 'Side';
}

// The miter-saw settings for one bevelled side: the blade's tilt, and the
// miter with either neighbouring side against the fence (90° less the
// corner between them).
function sawFor(sides, i) {
  const sd = sides[i], prev = sides[(i + sides.length - 1) % sides.length], next = sides[(i + 1) % sides.length];
  return {
    bevel: sd.bevel,
    fences: [[prev, Math.abs(90 - sd.corner)], [next, Math.abs(90 - next.corner)]].sort((x, y) => y[0].len - x[0].len),
  };
}

// Plain words for the face view's page: what to trace, and how to saw each bevelled side
export function profileSteps(sides, stock, halfL, units = 'in') {
  const r = (x) => Math.round(x);
  const fmt = (x) => formatLength(x, units);
  const steps = sides.map((sd, i) => {
    if (sd.bevel < BEVEL_MIN) return '';
    const saw = sawFor(sides, i);
    const [[f1, m1], [f2, m2]] = saw.fences;
    return `<b>${sideName(sd, halfL)} (the ${fmt(sd.len)} side):</b> blade tilted ${r(sd.bevel)}°, so the cut comes out on the back face ${fmt(Math.abs(sd.off))} further ${sd.off > 0 ? 'out' : 'in'} (the dashed line). `
      + `On a miter saw: bevel ${r(sd.bevel)}°, ${r(m1) ? `miter ${r(m1)}°` : 'no miter (square across)'} with the ${fmt(f1.len)} side on the fence${r(m2) !== r(m1) ? ` (or ${r(m2) ? `${r(m2)}°` : 'square'} with the ${fmt(f2.len)} side)` : ''}.`;
  }).filter(Boolean);
  const lean = Math.max(0, ...sides.filter((sd) => sd.bevel < BEVEL_MIN).map((sd) => sd.bevel));
  const square = lean >= 1 ? ` The other sides are square to the face (the model leans them up to ${r(lean)}°, ${fmt(Math.tan(THREE.MathUtils.degToRad(lean)) * stock)} over the thickness - not worth sawing).` : ' The other sides are square to the face.';
  // nothing to say beyond the header's "trace it" for a board with square sides
  return steps.length ? `Trace the solid outline on the face of the ${fmt(stock)} board, then saw:<br>${steps.join('<br>')}<br>${square.trim()}` : '';
}

// The profile drawn: filled outline, side lengths outside, corner angles inside, bevel exits dashed
function profileSvg(profile, page, units) {
  const { loops, sides } = profile;
  const P = (uv) => page(uv).map((x) => x.toFixed(4)).join(',');
  const ring = (l) => `M${l.map(P).join('L')}Z`;
  const out = [];
  out.push(`<path d="${loops.near.map(ring).join('')}" fill="#e9e2d6" fill-rule="evenodd"/>`);
  out.push(`<path d="${sides.filter((sd) => sd.bevel >= BEVEL_MIN && sd.back).map((sd) => `M${P(sd.back[0])}L${P(sd.back[1])}`).join('')}" fill="none" stroke="#555" stroke-width="0.012" stroke-dasharray="0.08 0.05"/>`);
  out.push(`<path d="${loops.near.map(ring).join('')}" fill="none" stroke="#000" stroke-width="0.014" stroke-linejoin="round"/>`);
  const text = (uv, rot, body, size = 0.14, fill = '#000') => {
    const [x, y] = page(uv);
    return `<text x="${x.toFixed(3)}" y="${y.toFixed(3)}" font-size="${size}" fill="${fill}" text-anchor="middle" dominant-baseline="middle" transform="rotate(${rot.toFixed(1)} ${x.toFixed(3)} ${y.toFixed(3)})">${body}</text>`;
  };
  // side lengths, along each side, just inside it - no paper needed round the part
  for (const sd of sides) {
    if (sd.len < 0.5) continue;
    let rot = deg(Math.atan2(-sd.dir[1], sd.dir[0]));
    if (rot > 90) rot -= 180; else if (rot <= -90) rot += 180;
    const gap = -0.17;
    const bev = sd.bevel >= BEVEL_MIN ? ` · ${Math.round(sd.bevel)}° bevel` : '';
    out.push(text([sd.mid[0] + sd.out[0] * gap, sd.mid[1] + sd.out[1] * gap], rot, `${escapeHtml(formatLength(sd.len, units))}${bev}`));
  }
  // corner angles, with a small arc, inside each corner
  if (sides.length <= 12) {
    sides.forEach((sd, i) => {
      const prev = sides[(i + sides.length - 1) % sides.length];
      // a corner cut into the board (over 180° inside) is marked from outside, where a bevel gauge reads it
      const reflex = sd.corner > 180, shown = reflex ? 360 - sd.corner : sd.corner;
      const v = sd.a, a0 = Math.atan2(sd.dir[1], sd.dir[0]), sweep = THREE.MathUtils.degToRad(reflex ? -shown : shown);
      const r = Math.min(0.3, sd.len / 3, prev.len / 3);
      const arc = Array.from({ length: 9 }, (_, k) => {
        const t = a0 + sweep * k / 8;
        return P([v[0] + Math.cos(t) * r, v[1] + Math.sin(t) * r]);
      });
      out.push(`<path d="M${arc.join('L')}" fill="none" stroke="#c0392b" stroke-width="0.01"/>`);
      const t = a0 + sweep / 2, rl = r + 0.2;
      out.push(text([v[0] + Math.cos(t) * rl, v[1] + Math.sin(t) * rl], 0, `${Math.round(shown)}°`, 0.12, '#c0392b'));
    });
  }
  return out.join('');
}

// Where a bevelled side's cut crosses each edge it meets. Sawing the
// face's shape leaves the edges square to the face, so on an edge the cut
// runs from the corner of the traced outline to where the back face's line
// (the dashed one) crosses that edge, carried straight through. `along` is
// how far along the edge that is - past the corner (towards the waste) when
// positive - and `angle` the slope on the edge off square: atan(along /
// stock). Where the end meets the edge at other than 90° this is steeper
// than the bevel itself (bevel offset / sin of the corner).
export function edgeCuts(sides, i, stock) {
  const sd = sides[i];
  if (!sd.back) return [];
  const prev = sides[(i + sides.length - 1) % sides.length], next = sides[(i + 1) % sides.length];
  const [b0, b1] = sd.back, bd = [b1[0] - b0[0], b1[1] - b0[1]];
  const cross = (x, y) => x[0] * y[1] - x[1] * y[0];
  // from corner c, along the edge (unit d, pointing off the end): where the back line crosses
  const at = (c, d, edge) => {
    const den = cross(d, bd);
    if (Math.abs(den) < 1e-9) return null;
    const along = cross([b0[0] - c[0], b0[1] - c[1]], bd) / den;
    return { edge, along, angle: deg(Math.atan2(Math.abs(along), stock)) };
  };
  return [at(sd.a, prev.dir, prev), at(sd.b, [-next.dir[0], -next.dir[1]], next)].filter(Boolean);
}

// Cut-out strips to trace each bevelled end onto the board's edges: each is
// exactly the stock's thickness wide, so with its top flush with the face
// you traced and its tick on the corner of the outline, its slanted line is
// the saw line on that edge. Full size, with the angle marked to check a
// bevel gauge against.
function endDetails(sides, stock, halfL, name, units, k) {
  const fmt = (x) => escapeHtml(formatLength(x, units));
  const strips = [];
  sides.forEach((sd, i) => {
    if (sd.bevel < BEVEL_MIN) return;
    const end = sideName(sd, halfL);
    for (const c of edgeCuts(sides, i, stock)) {
      // waste to the left of the tick, the part to the right
      const L = 3.6, x0 = 1.5, x1 = x0 - c.along, H = stock;
      const pad = { t: 0.42, b: 0.62, l: 0.1, r: 0.1 };
      const W = L + pad.l + pad.r, Ht = H + pad.t + pad.b;
      const X = (x) => (x + pad.l).toFixed(3), Y = (y) => (y + pad.t).toFixed(3);
      const ang = c.angle.toFixed(1).replace(/\.0$/, '');
      // the angle arc between square (blue) and the cut, at the face corner
      const r = H * 0.8, a1 = Math.atan2(x1 - x0, H);
      const arc = Array.from({ length: 13 }, (_, j) => { const t = a1 * j / 12; return `${X(x0 + Math.sin(t) * r)},${Y(Math.cos(t) * r)}`; });
      // the angle's label beside the wedge, on whichever side the cut leans to
      const lean = x1 < x0 ? -1 : 1, tx = (lean < 0 ? Math.min(x0, x1) : Math.max(x0, x1)) + lean * 0.12, ty = H * 0.62;
      const svg = `<svg width="${W * k}in" height="${Ht * k}in" viewBox="0 0 ${W} ${Ht}">
        <defs><clipPath id="w${strips.length}"><path d="M${X(0)},${Y(0)}H${X(x0)}L${X(x1)},${Y(H)}H${X(0)}Z"/></clipPath></defs>
        <path d="M${X(x0)},${Y(0)}H${X(L)}V${Y(H)}H${X(x1)}Z" fill="#e9e2d6"/>
        <g clip-path="url(#w${strips.length})">${Array.from({ length: 40 }, (_, j) => `<path d="M${X(-H + j * 0.12)},${Y(H)}L${X(j * 0.12)},${Y(0)}" stroke="#bbb" stroke-width="0.008"/>`).join('')}</g>
        <rect x="${X(0)}" y="${Y(0)}" width="${L}" height="${H}" fill="none" stroke="#000" stroke-width="0.01" stroke-dasharray="0.05 0.03"/>
        <path d="M${X(x0)},${Y(0)}V${Y(H)}" stroke="#3366cc" stroke-width="0.01" stroke-dasharray="0.06 0.04"/>
        <path d="M${X(x0)},${Y(0)}L${X(x1)},${Y(H)}" stroke="#000" stroke-width="0.022"/>
        <path d="M${arc.join('L')}" fill="none" stroke="#c0392b" stroke-width="0.012"/>
        <text x="${X(tx)}" y="${Y(ty)}" font-size="0.22" font-weight="bold" fill="#c0392b" stroke="#fff" stroke-width="0.04" paint-order="stroke" text-anchor="${lean < 0 ? 'end' : 'start'}" dominant-baseline="middle">${ang}°</text>
        <path d="M${X(x0)},${Y(-0.2)}V${Y(0.12)}" stroke="#000" stroke-width="0.018"/>
        <text x="${X(x0)}" y="${Y(-0.26)}" font-size="0.12" text-anchor="middle">▼ on the corner of your traced outline</text>
        <text x="${X(L - 0.08)}" y="${Y(0.2)}" font-size="0.11" text-anchor="end">face you traced ↑</text>
        <text x="${X(L - 0.08)}" y="${Y(H / 2)}" font-size="0.16" font-weight="bold" text-anchor="end" dominant-baseline="middle">${escapeHtml(name).toUpperCase()}</text>
        <text x="${X(0.08)}" y="${Y(0.2)}" font-size="0.13" font-weight="bold" fill="#777">WASTE</text>
        <text x="${X(L - 0.08)}" y="${Y(H - 0.1)}" font-size="0.11" text-anchor="end">back face ↓</text>
        <path d="M${X(x0)},${Y(H + 0.14)}H${X(x1)}M${X(x0)},${Y(H + 0.07)}v0.14M${X(x1)},${Y(H + 0.07)}v0.14" stroke="#c0392b" stroke-width="0.01"/>
        <text x="${X((x0 + x1) / 2)}" y="${Y(H + 0.32)}" font-size="0.12" text-anchor="middle" fill="#c0392b">${fmt(Math.abs(c.along))}</text>
        <text x="${X(L)}" y="${Y(H + 0.52)}" font-size="0.11" text-anchor="end">✂ cut out on the dashed box - it's exactly ${fmt(stock)} wide</text>
      </svg>`;
      strips.push({ h: Ht * k + 0.45, html: `<div class="tpl-end"><div><b>${end}</b> (the ${fmt(sd.len)} end) - on the <b>${fmt(c.edge.len)} edge</b>: ${ang}° off square, comes out ${fmt(Math.abs(c.along))} ${c.along > 0 ? 'further out' : 'further in'} on the back</div>${svg}</div>` });
    }
  });
  if (!strips.length) return '';
  // as many strips to a page as fit under the header
  const pages = [];
  for (const st of strips) {
    const last = pages[pages.length - 1];
    if (last && last.h + st.h <= PAGE.h - 0.4) { last.list.push(st.html); last.h += st.h; } else pages.push({ list: [st.html], h: st.h });
  }
  return pages.map((pg) => `<div class="tpl-page">
      <div class="tpl-head"><div><b>${escapeHtml(name)}</b> — end-cut strips, full size. After you've sawn the face shape: cut out each strip on its dashed box, lay it on the edge it names with its top flush with the face you traced and the ▼ tick on the corner of your outline, and trace the black line onto the edge. Saw each end from the line on the face to the lines on both edges. The red angle is the slope on that edge - check it with a bevel gauge.</div></div>
      <div class="tpl-ends">${pg.list.join('')}</div>
    </div>`).join('');
}

// Builds the printable HTML for a part. `dims` is its object_dims.json entry
// ({ center, axes: [{direction, length, role}] }).
// The face view is the shape you trace; the edge view (the part seen from
// its edge, thickness-wide) only matters for cuts in an edge, so it's
// printed only when asked for (withEdge). A flat board is drawn as its
// exact profile instead, and its edge view is the end-cut details.
export function buildTemplate(renderer, mesh, dims, name, units, holes = [], k = 1, withEdge = false) {
  const byRole = Object.fromEntries(dims.axes.map((a) => [a.role, a]));
  const L = byRole.Length, W = byRole.Width, T = byRole.Thickness;
  if (!L || !W || !T) return '';
  let center = new THREE.Vector3(...dims.center);
  let u = new THREE.Vector3(...L.direction).normalize();
  let v = new THREE.Vector3(...W.direction).normalize();
  let w = new THREE.Vector3(...T.direction).normalize();
  let halfL = L.length / 2, halfW = W.length / 2, halfT = T.length / 2;
  // square the view to the board's own face (faceFrame), and take its outline exactly
  const f = faceFrame(mesh.geometry, u, v, w);
  if (f) ({ u, v, w, center, halfL, halfW } = f), halfT = f.stock / 2;
  const loops = f && faceLoops(mesh.geometry, f);
  const sides = loops && loops.near.length && loops.far.length ? profileSides(loops, f.stock) : null;
  // (the frame's extents take in the back face, so a bevel's dashed line is on the paper already)
  const profile = sides && { loops, sides, stock: f.stock, margin: MARGIN_IN };
  // Parts wider than they are long read better stood the other way on paper,
  // but keep length horizontal: it's how you'd lay the template on a board.
  const face = vectorView(mesh, center, u, v, halfL, halfW, holes, units, profile);
  const size = `${formatLength(L.length, units)} × ${formatLength(W.length, units)} × ${formatLength(T.length, units)}`;
  // what the stock really is, when the cut list's box is bigger than the board
  const stock = f && Math.abs(f.stock - T.length) > 1 / 32 ? ` - from ${formatLength(f.stock, units)} thick stock` : '';
  if (profile) {
    return tiles(face, name, `face, full size, ${size}${stock} - trace the solid outline; side lengths and corner angles are marked to check it with a tape and a bevel gauge`, k, profileSteps(profile.sides, f.stock, halfL, units))
      + (withEdge ? endDetails(profile.sides, f.stock, halfL, name, units, k) : '');
  }
  const edge = withEdge && vectorView(mesh, center, u, w, halfL, halfT, holes, units);
  return tiles(face, name, `face view (looking through the thickness), ${size}${stock}`, k)
    + (edge ? tiles(edge, name, `EDGE view - the part seen from its edge (only for cuts in the edge), ${size}${stock}`, k) : '');
}
