// Manual measuring tools: distance (2 points), angle (3 points) and bevel
// (angle between two faces). Clicks snap SketchUp-style to the nearest
// endpoint, edge midpoint or point on a real edge, else the clicked surface,
// and a preview marker shows what the next click will snap to.

import * as THREE from 'three';
import { formatLength } from './format.js';
import { dihedralFromNormals, slopeAngles } from './angles.js';

const SNAP_PX = { endpoint: 14, midpoint: 11, edge: 8 };
const SNAP_COLORS = { endpoint: 0x7ee08a, midpoint: 0x6ab7ff, edge: 0xff6bd6, face: 0xffb454 };
const SNAP_NAMES = { endpoint: 'Endpoint', midpoint: 'Midpoint', edge: 'On edge', face: 'On face' };
const ACCENT = '#ffb454';

export function initMeasure(ctx) {
  // ctx: { scene, getCamera, canvas, pickMeshes, selectionName, labelsEl, hintEl, units }
  let mode = null; // null | 'distance' | 'angle' | 'bevel'
  let points = []; // { p: Vector3, normal?: Vector3 }
  let markers = [];
  const measurements = []; // { group, labels: [{ pos, el, text: () => string }], kind }
  const raycaster = new THREE.Raycaster();
  const featureEdgeCache = new WeakMap();

  const preview = new THREE.Mesh(
    new THREE.SphereGeometry(1, 14, 14),
    new THREE.MeshBasicMaterial({ color: SNAP_COLORS.face, depthTest: false, transparent: true, opacity: 0.9 }),
  );
  preview.renderOrder = 1001;
  preview.visible = false;
  ctx.scene.add(preview);
  const previewTag = document.createElement('div');
  previewTag.className = 'snapTag';
  ctx.labelsEl.appendChild(previewTag);
  let previewSnap = null;

  const needed = () => ({ distance: 2, angle: 3, bevel: 2 }[mode]);

  function toScreen(v) {
    const p = v.clone().project(ctx.getCamera());
    const r = ctx.canvas.getBoundingClientRect();
    return new THREE.Vector2((p.x * 0.5 + 0.5) * r.width, (0.5 - p.y * 0.5) * r.height);
  }

  // World-space size of `px` screen pixels at `pos`, for constant-size markers.
  function pxToWorld(pos, px) {
    const cam = ctx.getCamera();
    const h = ctx.canvas.clientHeight || 1;
    if (cam.isOrthographicCamera) return ((cam.top - cam.bottom) / cam.zoom / h) * px;
    const dist = cam.position.distanceTo(pos);
    return (2 * dist * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) / h) * px;
  }

  // Edges of the triangulated mesh that are real model edges (a crease between
  // faces, or a boundary) rather than diagonals splitting a flat face.
  function featureEdges(mesh) {
    if (featureEdgeCache.has(mesh)) return featureEdgeCache.get(mesh);
    const pos = mesh.geometry.attributes.position;
    const index = mesh.geometry.index;
    const key = (i) => {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      return `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
    };
    const edges = new Map(); // "ka|kb" -> [normals]
    const triCount = index ? index.count / 3 : pos.count / 3;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const tri = new THREE.Triangle();
    for (let t = 0; t < triCount; t++) {
      const ids = [0, 1, 2].map((k) => (index ? index.getX(t * 3 + k) : t * 3 + k));
      a.fromBufferAttribute(pos, ids[0]); b.fromBufferAttribute(pos, ids[1]); c.fromBufferAttribute(pos, ids[2]);
      tri.set(a, b, c);
      if (tri.getArea() < 1e-10) continue;
      const n = tri.getNormal(new THREE.Vector3());
      const keys = ids.map(key);
      for (let e = 0; e < 3; e++) {
        const k1 = keys[e], k2 = keys[(e + 1) % 3];
        const ek = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
        if (!edges.has(ek)) edges.set(ek, []);
        edges.get(ek).push(n);
      }
    }
    const feature = new Set();
    edges.forEach((normals, ek) => {
      if (normals.length !== 2 || normals[0].dot(normals[1]) < 0.9998) feature.add(ek);
    });
    featureEdgeCache.set(mesh, { feature, key });
    return featureEdgeCache.get(mesh);
  }

  function snap(hit) {
    const mesh = hit.object;
    const face = hit.face;
    const worldNormal = face ? face.normal.clone().transformDirection(mesh.matrixWorld).normalize() : null;
    if (!face) return { p: hit.point.clone(), type: 'face', normal: worldNormal };
    const pos = mesh.geometry.attributes.position;
    const ids = [face.a, face.b, face.c];
    const local = ids.map((i) => new THREE.Vector3().fromBufferAttribute(pos, i));
    const world = local.map((v) => mesh.localToWorld(v.clone()));
    const click = toScreen(hit.point);
    const { feature, key } = featureEdges(mesh);
    const keys = ids.map(key);

    let best = null;
    const consider = (p, type, limit) => {
      const d = toScreen(p).distanceTo(click);
      if (d <= limit && (!best || d < best.d)) best = { p, type, d };
    };
    world.forEach((v) => consider(v, 'endpoint', SNAP_PX.endpoint));
    if (best) return { p: best.p, type: best.type, normal: worldNormal };
    for (let e = 0; e < 3; e++) {
      const k1 = keys[e], k2 = keys[(e + 1) % 3];
      if (!feature.has(k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`)) continue;
      const v1 = world[e], v2 = world[(e + 1) % 3];
      consider(v1.clone().add(v2).multiplyScalar(0.5), 'midpoint', SNAP_PX.midpoint);
    }
    if (best) return { p: best.p, type: best.type, normal: worldNormal };
    for (let e = 0; e < 3; e++) {
      const k1 = keys[e], k2 = keys[(e + 1) % 3];
      if (!feature.has(k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`)) continue;
      const line = new THREE.Line3(world[e], world[(e + 1) % 3]);
      consider(line.closestPointToPoint(hit.point, true, new THREE.Vector3()), 'edge', SNAP_PX.edge);
    }
    if (best) return { p: best.p, type: best.type, normal: worldNormal };
    return { p: hit.point.clone(), type: 'face', normal: worldNormal };
  }

  function pick(clientX, clientY) {
    const r = ctx.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, ctx.getCamera());
    const hits = raycaster.intersectObjects(ctx.pickMeshes(), false);
    return hits.length ? hits[0] : null;
  }

  function hint() {
    if (!mode) { ctx.hintEl.style.display = 'none'; return; }
    ctx.hintEl.style.display = 'block';
    const on = ctx.selectionName() ? ` on ${ctx.selectionName()}` : '';
    const scope = ctx.selectionName() ? '' : ' (tip: select a part first to measure only that part)';
    let text;
    if (mode === 'distance') {
      text = points.length === 0 ? `Click the first point${on}${scope}.` : 'Click the second point.';
    } else if (mode === 'angle') {
      text = [`Click the corner the angle pivots around${on}${scope}.`,
        'Click a point along one side of the angle.',
        'Click a point along the other side.'][points.length];
    } else {
      if (points.length === 0) text = `Click the first face${on}${scope}.`;
      else {
        const s = slopeOfFace(points[0].normal);
        text = `First face is ${s}. Click the second face.`;
      }
    }
    ctx.hintEl.innerHTML = `<b>${{ distance: 'Distance', angle: 'Angle', bevel: 'Bevel' }[mode]}:</b> ${text} <span class="muted">Esc to cancel.</span>`;
  }

  function slopeOfFace(n) {
    // angle of the face itself from level: 0 = flat (normal straight up/down)
    const tilt = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(n.y))));
    if (tilt < 0.05) return 'level';
    if (Math.abs(90 - tilt) < 0.05) return 'plumb';
    return `${tilt.toFixed(1)}° from level`;
  }

  function addMarker(p, color) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 12),
      new THREE.MeshBasicMaterial({ color, depthTest: false }),
    );
    m.position.copy(p);
    m.renderOrder = 1000;
    ctx.scene.add(m);
    markers.push(m);
  }
  function clearMarkers() {
    markers.forEach((m) => { ctx.scene.remove(m); m.geometry.dispose(); m.material.dispose(); });
    markers = [];
  }

  function xrayLine(pts, color = ACCENT) {
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: new THREE.Color(color), depthTest: false, transparent: true }));
    line.renderOrder = 999;
    return line;
  }

  function makeLabel(pos, text) {
    const el = document.createElement('div');
    el.className = 'measureLabel';
    ctx.labelsEl.appendChild(el);
    const label = { pos, el, text };
    el.textContent = text();
    return label;
  }

  function finishDistance() {
    const [a, b] = points.map((x) => x.p);
    const group = new THREE.Group();
    group.add(xrayLine([a, b]));
    const dist = a.distanceTo(b);
    const slope = slopeAngles(a.toArray(), b.toArray());
    const d = b.clone().sub(a);
    const text = () => {
      let t = formatLength(dist, ctx.units());
      if (slope.fromLevel > 0.05 && slope.fromPlumb > 0.05) t += ` · ${slope.fromLevel.toFixed(1)}° from level`;
      const parts = [['X', d.x], ['Y', d.y], ['Z', d.z]].filter(([, v]) => Math.abs(v) > 1e-3);
      if (parts.length > 1) t += `  (${parts.map(([n, v]) => `${n} ${formatLength(Math.abs(v), ctx.units())}`).join(', ')})`;
      return t;
    };
    measurements.push({ group, kind: 'distance', value: dist, labels: [makeLabel(a.clone().lerp(b, 0.5), text)] });
    ctx.scene.add(group);
  }

  function arcGroup(pivot, v1, v2, radius, color) {
    const g = new THREE.Group();
    const angle = v1.angleTo(v2);
    if (angle < 0.01) return { g, mid: pivot.clone() };
    const axis = new THREE.Vector3().crossVectors(v1, v2).normalize();
    const pts = [];
    for (let s = 0; s <= 24; s++) pts.push(v1.clone().applyAxisAngle(axis, (angle * s) / 24).multiplyScalar(radius).add(pivot));
    g.add(xrayLine(pts, color));
    const fan = new THREE.BufferGeometry().setFromPoints([pivot, ...pts]);
    fan.setIndex(pts.slice(0, -1).flatMap((_, i) => [0, i + 1, i + 2]));
    const mesh = new THREE.Mesh(fan, new THREE.MeshBasicMaterial({
      color: new THREE.Color(color), transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthTest: false,
    }));
    mesh.renderOrder = 998;
    g.add(mesh);
    return { g, mid: pts[12] };
  }

  function finishAngle() {
    const [v, a, b] = points.map((x) => x.p);
    const d1 = a.clone().sub(v).normalize(), d2 = b.clone().sub(v).normalize();
    const deg = THREE.MathUtils.radToDeg(d1.angleTo(d2));
    const group = new THREE.Group();
    group.add(xrayLine([v, a])); group.add(xrayLine([v, b]));
    const { g, mid } = arcGroup(v, d1, d2, Math.min(v.distanceTo(a), v.distanceTo(b)) * 0.5, ACCENT);
    group.add(g);
    ctx.scene.add(group);
    measurements.push({ group, kind: 'angle', value: deg, labels: [makeLabel(mid, () => `${deg.toFixed(1)}° (other side ${(180 - deg).toFixed(1)}°)`)] });
  }

  function finishBevel() {
    const [f1, f2] = points;
    const deg = dihedralFromNormals(f1.normal.toArray(), f2.normal.toArray());
    const group = new THREE.Group();
    const len = pxToWorld(f1.p, 40);
    [f1, f2].forEach((f) => group.add(xrayLine([f.p, f.p.clone().addScaledVector(f.normal, len)], '#63d9ff')));
    group.add(xrayLine([f1.p, f2.p], '#63d9ff'));
    ctx.scene.add(group);
    const text = () => {
      if (deg > 179.95) return 'Faces are parallel (flush / coplanar)';
      if (deg < 0.05) return 'Faces are parallel (facing each other)';
      return `${deg.toFixed(1)}° between faces · bevel gauge ${deg.toFixed(1)}° / ${(180 - deg).toFixed(1)}°`;
    };
    measurements.push({ group, kind: 'bevel', value: deg, labels: [makeLabel(f1.p.clone().lerp(f2.p, 0.5), text)] });
  }

  function reset() { points = []; clearMarkers(); }

  const api = {
    get mode() { return mode; },
    get measurements() { return measurements; },
    get points() { return points; },
    setMode(m) {
      mode = mode === m ? null : m;
      reset();
      preview.visible = false;
      previewTag.style.display = 'none';
      hint();
      return mode;
    },
    cancel() {
      if (points.length) { reset(); hint(); return true; }
      if (mode) { api.setMode(mode); return true; }
      return false;
    },
    onSelectionChange() { reset(); hint(); },
    clear() {
      measurements.forEach((m) => {
        ctx.scene.remove(m.group);
        m.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
        m.labels.forEach((l) => l.el.remove());
      });
      measurements.length = 0;
      reset();
      hint();
    },
    undo() {
      if (points.length) { points.pop(); const m = markers.pop(); if (m) ctx.scene.remove(m); hint(); return true; }
      const m = measurements.pop();
      if (!m) return false;
      ctx.scene.remove(m.group);
      m.labels.forEach((l) => l.el.remove());
      return true;
    },
    // hide/show everything this tool draws in 3D (for clean captures)
    setVisible(on) {
      measurements.forEach((m) => { m.group.visible = on; });
      markers.forEach((m) => { m.visible = on; });
      if (!on) preview.visible = false;
    },
    refreshLabels() { measurements.forEach((m) => m.labels.forEach((l) => { l.el.textContent = l.text(); })); },
    // returns true if the click was consumed by a measuring tool
    handleClick(e) {
      if (!mode) return false;
      const hit = pick(e.clientX, e.clientY);
      if (!hit) return true;
      const s = snap(hit);
      if (mode === 'bevel') s.p = hit.point.clone(); // faces: exact click point, not a snapped corner
      points.push(s);
      addMarker(s.p, SNAP_COLORS[mode === 'bevel' ? 'face' : s.type]);
      if (points.length >= needed()) {
        if (mode === 'distance') finishDistance();
        else if (mode === 'angle') finishAngle();
        else finishBevel();
        reset();
      }
      hint();
      return true;
    },
    handleMove(e) {
      if (!mode) { previewSnap = null; return; }
      const hit = pick(e.clientX, e.clientY);
      if (!hit) { previewSnap = null; preview.visible = false; previewTag.style.display = 'none'; return; }
      previewSnap = snap(hit);
      if (mode === 'bevel') { previewSnap.type = 'face'; previewSnap.p = hit.point.clone(); }
      preview.position.copy(previewSnap.p);
      preview.material.color.setHex(SNAP_COLORS[previewSnap.type]);
      preview.visible = true;
      previewTag.textContent = mode === 'bevel' ? slopeOfFace(previewSnap.normal) : SNAP_NAMES[previewSnap.type];
      previewTag.style.display = 'block';
      if (points.length && mode !== 'bevel') {
        const d = points[points.length - 1].p.distanceTo(previewSnap.p);
        if (mode === 'distance') previewTag.textContent += ` · ${formatLength(d, ctx.units())}`;
      }
    },
    // per-frame: keep markers a constant screen size and labels glued to 3D points
    update(project) {
      const scaleFor = (m, px) => m.scale.setScalar(pxToWorld(m.position, px));
      markers.forEach((m) => scaleFor(m, 5));
      if (preview.visible) {
        scaleFor(preview, 6);
        const s = project(preview.position);
        previewTag.style.left = `${s.x + 12}px`;
        previewTag.style.top = `${s.y - 12}px`;
      }
      measurements.forEach((m) => m.labels.forEach(({ pos, el }) => {
        const s = project(pos);
        el.style.display = s.behind ? 'none' : 'block';
        el.style.left = `${s.x}px`;
        el.style.top = `${s.y}px`;
      }));
    },
  };
  return api;
}
