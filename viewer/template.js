// Full-size (1:1) printable templates of a part: the part is rendered
// orthographically, looking straight down its thickness (face view) and its
// width (edge view), at a known pixels-per-inch, then tiled across letter
// pages with overlap and alignment marks so the tiles can be taped together
// and traced onto stock.

import * as THREE from 'three';
import { formatLength, escapeHtml } from './format.js';

const MAX_PX = 4096;       // stay under common WebGL canvas limits
const MAX_PPI = 150;
const MARGIN_IN = 0.3;     // blank border around the part in the render
const PAGE = { w: 7.5, h: 9.2 }; // printable tile area on letter with 0.5" margins + header
const OVERLAP = 0.5;       // inches each tile overlaps its neighbours

// Render one orthographic view. `across` is the image's horizontal axis,
// `up` its vertical axis, `look` the viewing direction (all unit Vector3).
function renderView(renderer, mesh, center, across, up, look, halfW, halfH) {
  const wIn = halfW * 2 + MARGIN_IN * 2, hIn = halfH * 2 + MARGIN_IN * 2;
  const ppi = Math.min(MAX_PPI, MAX_PX / Math.max(wIn, hIn));
  const pxW = Math.round(wIn * ppi), pxH = Math.round(hIn * ppi);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);
  const geo = mesh.geometry; // OBJ geometry is already in world space
  const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: 0xe9e2d6, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  }));
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), new THREE.LineBasicMaterial({ color: 0x000000 }));
  scene.add(fill, edges);

  // center line along the length, handy for laying out
  const cl = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
    center.clone().addScaledVector(across, -halfW - MARGIN_IN * 0.6), center.clone().addScaledVector(across, halfW + MARGIN_IN * 0.6),
  ]), new THREE.LineDashedMaterial({ color: 0x3366cc, dashSize: 0.25, gapSize: 0.12, depthTest: false }));
  cl.computeLineDistances();
  scene.add(cl);

  const cam = new THREE.OrthographicCamera(-wIn / 2, wIn / 2, hIn / 2, -hIn / 2, 0.01, 1000);
  cam.position.copy(center).addScaledVector(look, -200);
  cam.up.copy(up);
  cam.lookAt(center);
  cam.updateProjectionMatrix();

  const prevSize = renderer.getSize(new THREE.Vector2());
  const prevRatio = renderer.getPixelRatio();
  const prevClear = renderer.getClearColor(new THREE.Color());
  renderer.setPixelRatio(1);
  renderer.setSize(pxW, pxH, false);
  renderer.render(scene, cam);
  const url = renderer.domElement.toDataURL('image/png');
  renderer.setPixelRatio(prevRatio);
  renderer.setSize(prevSize.x, prevSize.y, false);
  renderer.setClearColor(prevClear);
  edges.geometry.dispose(); edges.material.dispose(); fill.material.dispose(); cl.geometry.dispose(); cl.material.dispose();
  return { url, wIn, hIn };
}

function tiles(img, title, sub) {
  const stepX = PAGE.w - OVERLAP, stepY = PAGE.h - OVERLAP;
  const nx = Math.max(1, Math.ceil((img.wIn - OVERLAP) / stepX));
  const ny = Math.max(1, Math.ceil((img.hIn - OVERLAP) / stepY));
  const pages = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = i * stepX, y = j * stepY;
      const tw = Math.min(PAGE.w, img.wIn - x), th = Math.min(PAGE.h, img.hIn - y);
      const id = `${String.fromCharCode(65 + j)}${i + 1}`;
      const marks = [];
      if (i > 0) marks.push(`<div class="tpl-overlap v" style="left:0;width:${OVERLAP}in"></div>`);
      if (j > 0) marks.push(`<div class="tpl-overlap h" style="top:0;height:${OVERLAP}in"></div>`);
      pages.push(`
        <div class="tpl-page">
          <div class="tpl-head">
            <div><b>${escapeHtml(title)}</b> — ${escapeHtml(sub)} · tile <b>${id}</b> of ${nx * ny}${nx * ny > 1 ? ` (${ny} row${ny > 1 ? 's' : ''} × ${nx})` : ''}</div>
            <div class="tpl-check"><span class="tpl-inch"><i style="left:0.25in"></i><i style="left:0.5in"></i><i style="left:0.75in"></i></span> Print at 100% / "Actual size". This square must measure exactly 1".${nx * ny > 1 ? ' Overlap each tile 1/2" so its edge sits on the neighbour\'s dashed line, then tape.' : ''}</div>
          </div>
          <div class="tpl-tile" style="width:${tw}in;height:${th}in">
            <img src="${img.url}" style="width:${img.wIn}in;height:${img.hIn}in;left:${-x}in;top:${-y}in" alt="" />
            ${marks.join('')}
            <span class="tpl-id">${id}</span>
          </div>
        </div>`);
    }
  }
  return pages.join('');
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
  const face = renderView(renderer, mesh, center, u, v, w.clone().negate(), L.length / 2, W.length / 2);
  const edge = renderView(renderer, mesh, center, u, w, v, L.length / 2, T.length / 2);
  const size = `${formatLength(L.length, units)} × ${formatLength(W.length, units)} × ${formatLength(T.length, units)}`;
  return tiles(face, name, `face view (looking through the thickness), ${size}`)
    + tiles(edge, name, `edge view (looking across the width), ${size}`);
}
