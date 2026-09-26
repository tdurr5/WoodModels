// Manual measuring tools: distance (2 points), angle (3 points) and bevel
// (angle between two faces). Clicks snap SketchUp-style to the nearest
// endpoint, edge midpoint or point on a real edge, else the clicked surface,
// and a preview marker shows what the next click will snap to.

import * as THREE from 'three';
import { formatLength } from './format.js';
import { dihedralFromNormals, slopeAngles } from './angles.js';

const SNAP_PX = { endpoint: 14, corner: 14, boxmid: 11, cross: 16, axis: 10, midpoint: 11, edge: 8 };
const SNAP_COLORS = { endpoint: 0x7ee08a, corner: 0xffe066, boxmid: 0xffe066, cross: 0x7ee08a, midpoint: 0x6ab7ff, edge: 0xff6bd6, face: 0xffb454, axis: 0xffffff };
const SNAP_NAMES = {
  endpoint: 'Endpoint', corner: 'Corner of outline box', boxmid: 'Midpoint of outline box edge',
  midpoint: 'Midpoint', edge: 'On edge', face: 'On face',
};
// Axis lock: a point this close to parallel with an axis (from the tool's
// start point) is pulled onto it, SketchUp-style.
const AXIS_LOCK_DEG = 2.5;
const ACCENT = '#ffb454';

// phones and tablets: tap, not click, and no Esc key
const TOUCH = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

export function initMeasure(ctx) {
  // ctx: { scene, getCamera, canvas, pickMeshes, selectionName, labelsEl, hintEl, units,
  //        guidePoints: () => [{ p, kind: 'corner'|'boxmid' }]  (off-mesh snap targets),
  //        guideAxes: () => [{ dir, name, color }],             (axis-lock directions)
  //        guideEdges: () => [[a, b]] }                         (outline-box edges)
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
  const guideLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.4, gapSize: 0.25, depthTest: false, transparent: true }));
  guideLine.renderOrder = 1001;
  guideLine.visible = false;
  ctx.scene.add(guideLine);

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
    // A crease has two face normals that aren't parallel; a boundary edge has
    // one face. Normals are compared up to sign because SketchUp exports every
    // face twice, back to back - so a diagonal splitting a flat face (n, n, -n,
    // -n) is not an edge, while a real corner (n1, n2, -n1, -n2) is.
    const feature = new Set();
    const segments = []; // world-space endpoints of the feature edges, for intersections
    edges.forEach((normals, ek) => {
      const crease = normals.some((n1, i) => normals.some((n2, j) => j > i && Math.abs(n1.dot(n2)) < 0.9998));
      if (normals.length === 1 || crease) {
        feature.add(ek);
        const [k1, k2] = ek.split('|');
        segments.push([new THREE.Vector3(...k1.split(',').map(Number)), new THREE.Vector3(...k2.split(',').map(Number))]);
      }
    });
    featureEdgeCache.set(mesh, { feature, key, segments });
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

  function cursorRay(clientX, clientY) {
    const r = ctx.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, ctx.getCamera());
    return { ray: raycaster.ray.clone(), px: new THREE.Vector2(clientX - r.left, clientY - r.top) };
  }

  // Where the next click lands, or null. In priority order: a real corner or
  // a corner of the part's outline box (whichever is nearer on screen), then an
  // axis lock from the start point (works in empty space too), then the mesh
  // snaps (midpoint, edge, face). Bevel measures faces, so it only uses the face.
  function resolve(clientX, clientY) {
    const hit = pick(clientX, clientY);
    if (mode === 'bevel') return hit ? { p: hit.point.clone(), type: 'face', normal: snap(hit).normal } : null;
    const { ray, px } = cursorRay(clientX, clientY);
    const meshSnap = hit ? snap(hit) : null;
    const screenDist = (p) => toScreen(p).distanceTo(px);

    let best = null;
    const consider = (cand, limit) => {
      const d = screenDist(cand.p);
      if (d <= limit && (!best || d < best.d)) best = { ...cand, d };
    };
    if (meshSnap && meshSnap.type === 'endpoint') consider(meshSnap, SNAP_PX.endpoint);
    (ctx.guidePoints ? ctx.guidePoints() : []).forEach((g) => consider({ p: g.p.clone(), type: g.kind }, SNAP_PX[g.kind]));
    if (best) return withAxisNote(best);

    // axis lock from the start point: first where a locked line crosses the
    // part (edge / outline box / surface), then anywhere along the line
    const origin = points.length ? points[0].p : null;
    if (origin && ctx.guideAxes) {
      axisCrossings(origin, ctx.guideAxes()).forEach((x) => consider({ p: x.p.clone(), type: 'cross', axis: x.axis, what: x.what }, SNAP_PX.cross));
      if (best) return best;
    }
    if (origin) {
      (ctx.guideAxes ? ctx.guideAxes() : []).forEach((ax) => {
        const onLine = new THREE.Vector3();
        ray.distanceSqToSegment(origin.clone().addScaledVector(ax.dir, -1e4), origin.clone().addScaledVector(ax.dir, 1e4), undefined, onLine);
        if (onLine.distanceTo(origin) < 1e-6) return;
        consider({ p: onLine, type: 'axis', axis: ax }, SNAP_PX.axis);
      });
      if (best) return best;
    }
    return meshSnap ? withAxisNote(meshSnap) : null;
  }

  // Where each axis-lock line from the start point meets the part: crossings
  // with its real edges, the outline box's edges, and its surface. Lets the
  // second/third click land exactly where a locked line hits e.g. an angled
  // cut, instead of wherever the cursor happens to be along the line.
  let crossCache = { key: null, list: [] };
  function axisCrossings(origin, axes) {
    const key = `${origin.toArray().map((v) => v.toFixed(5)).join(',')}|${axes.map((a) => a.name).join(',')}`;
    if (crossCache.key === key) return crossCache.list;
    const list = [];
    const TOL = 0.02; // inches between lines to call it an intersection
    const segLine = new THREE.Vector3(), segPt = new THREE.Vector3();
    const meshes = ctx.pickMeshes();
    const segments = [];
    meshes.forEach((m) => featureEdges(m).segments.forEach(([a, b]) => segments.push([a.clone().add(m.position), b.clone().add(m.position), 'edge'])));
    (ctx.guideEdges ? ctx.guideEdges() : []).forEach(([a, b]) => segments.push([a, b, 'box edge']));
    const rc = new THREE.Raycaster();
    axes.forEach((ax) => {
      const far = 1e4;
      const l0 = origin.clone().addScaledVector(ax.dir, -far), l1 = origin.clone().addScaledVector(ax.dir, far);
      segments.forEach(([a, b, what]) => {
        // closest points between the axis line and the segment
        const d = closestBetweenSegments(l0, l1, a, b, segLine, segPt);
        if (d > TOL || segLine.distanceTo(origin) < 1e-3) return;
        list.push({ p: segPt.clone(), axis: ax, what });
      });
      // entering/leaving the surface, both directions along the axis
      [1, -1].forEach((sgn) => {
        rc.set(origin.clone().addScaledVector(ax.dir, sgn * 1e-3), ax.dir.clone().multiplyScalar(sgn));
        rc.intersectObjects(meshes, false).forEach((h) => {
          if (h.point.distanceTo(origin) > 1e-3) list.push({ p: h.point.clone(), axis: ax, what: 'surface' });
        });
      });
    });
    crossCache = { key, list };
    return list;
  }

  // Shortest distance between segments p1-q1 and p2-q2; writes the closest
  // points into c1/c2. (Real-Time Collision Detection, 5.1.9)
  function closestBetweenSegments(p1, q1, p2, q2, c1, c2) {
    const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2);
    const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
    let s = 0, t = 0;
    if (a <= 1e-12 && e <= 1e-12) { s = t = 0; }
    else if (a <= 1e-12) { s = 0; t = THREE.MathUtils.clamp(f / e, 0, 1); }
    else {
      const c = d1.dot(r);
      if (e <= 1e-12) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
      else {
        const b = d1.dot(d2), denom = a * e - b * b;
        s = denom > 1e-12 ? THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1) : 0;
        t = (b * s + f) / e;
        if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
        else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - c) / a, 0, 1); }
      }
    }
    c1.copy(p1).addScaledVector(d1, s);
    c2.copy(p2).addScaledVector(d2, t);
    return c1.distanceTo(c2);
  }

  // Tag a snapped point that also happens to line up with an axis from the start.
  function withAxisNote(s) {
    const origin = points.length ? points[0].p : null;
    if (!origin || !ctx.guideAxes) return s;
    const v = s.p.clone().sub(origin);
    if (v.lengthSq() < 1e-8) return s;
    v.normalize();
    const ax = ctx.guideAxes().find((a) => THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(v.dot(a.dir))))) < AXIS_LOCK_DEG / 2);
    return ax ? { ...s, alignedAxis: ax } : s;
  }

  function snapLabel(sn) {
    if (sn.type === 'axis') return `On ${sn.axis.name} axis`;
    if (sn.type === 'cross') return `Where ${sn.axis.name} meets ${sn.what === 'surface' ? 'the surface' : sn.what === 'box edge' ? 'the outline box' : 'an edge'}`;
    return SNAP_NAMES[sn.type] + (sn.alignedAxis ? ` · on ${sn.alignedAxis.name} axis` : '');
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
        'Click a point along the other side. Corners of the grey outline box snap too, and lines along the part lock on.'][points.length];
    } else {
      if (points.length === 0) text = `Click the first face${on}${scope}.`;
      else {
        const s = slopeOfFace(points[0].normal);
        text = `First face is ${s}. Click the second face.`;
      }
    }
    if (TOUCH) text = text.replace(/\bClick/g, 'Tap');
    ctx.hintEl.innerHTML = `<button class="hint-x" title="Stop measuring (Esc)" aria-label="Stop measuring">×</button><b>${{ distance: 'Distance', angle: 'Angle', bevel: 'Bevel' }[mode]}:</b> ${text}${TOUCH ? '' : ' <span class="muted">Esc to cancel.</span>'}`;
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

  function reset() { points = []; clearMarkers(); guideLine.visible = false; crossCache = { key: null, list: [] }; }

  const api = {
    get mode() { return mode; },
    get measurements() { return measurements; },
    get points() { return points; },
    // where the axis-lock lines from the first point cross the part (tests/debugging)
    crossings: () => (points.length && ctx.guideAxes ? axisCrossings(points[0].p, ctx.guideAxes()) : []),
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
      if (!on) { preview.visible = false; guideLine.visible = false; }
    },
    refreshLabels() { measurements.forEach((m) => m.labels.forEach((l) => { l.el.textContent = l.text(); })); },
    // returns true if the click was consumed by a measuring tool
    handleClick(e) {
      if (!mode) return false;
      const sn = resolve(e.clientX, e.clientY);
      if (!sn) return true;
      points.push(sn);
      addMarker(sn.p, sn.type === 'axis' ? new THREE.Color(sn.axis.color).getHex() : SNAP_COLORS[sn.type]);
      guideLine.visible = false;
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
      if (!mode) { previewSnap = null; guideLine.visible = false; return; }
      previewSnap = resolve(e.clientX, e.clientY);
      if (!previewSnap) { preview.visible = false; guideLine.visible = false; previewTag.style.display = 'none'; return; }
      preview.position.copy(previewSnap.p);
      const lockAxis = (previewSnap.type === 'axis' || previewSnap.type === 'cross') ? previewSnap.axis : previewSnap.alignedAxis;
      preview.material.color.set(previewSnap.type === 'cross' ? SNAP_COLORS.cross : lockAxis ? lockAxis.color : SNAP_COLORS[previewSnap.type]);
      preview.visible = true;
      // dashed guide from the start point along the locked axis
      if (lockAxis && points.length) {
        // run the guide a bit past the cursor so the lock is easy to see
        const end = previewSnap.p.clone().lerp(points[0].p, -0.35);
        guideLine.geometry.setFromPoints([points[0].p, end]);
        guideLine.computeLineDistances();
        guideLine.material.color.set(lockAxis.color);
        guideLine.visible = true;
      } else guideLine.visible = false;
      previewTag.textContent = mode === 'bevel' ? slopeOfFace(previewSnap.normal) : snapLabel(previewSnap);
      previewTag.style.display = 'block';
      if (points.length && mode !== 'bevel') {
        const from = points[points.length - 1].p;
        if (mode === 'distance') previewTag.textContent += ` · ${formatLength(from.distanceTo(previewSnap.p), ctx.units())}`;
        if (mode === 'angle' && points.length === 2) {
          const v = points[0].p;
          const deg = THREE.MathUtils.radToDeg(points[1].p.clone().sub(v).angleTo(previewSnap.p.clone().sub(v)));
          previewTag.textContent += ` · ${deg.toFixed(1)}°`;
        }
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
