import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { formatLength, escapeHtml } from './format.js';
import { compoundAngle, describeAngle, round1, DEFAULT_AXIS_NAMES } from './angles.js';
import { initSettings, settings, updateSettings, onSettingsChange } from './settings.js';
import {
  prepareRows, renderCutList, renderRows, markActive, visibleRows, focusSearch, finishedDims, buildPrintSheet,
} from './cutlist.js';
import { initMeasure } from './measure.js';

const $ = (id) => document.getElementById(id);
const viewport = $('viewport');

// ---------- renderer, cameras, controls ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b1c1f);

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.localClippingEnabled = true;
viewport.prepend(renderer.domElement); // first, so the HTML overlays paint on top

const perspCamera = new THREE.PerspectiveCamera(45, 1, 0.05, 2000);
const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 4000);
let camera = perspCamera;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.15;
controls.enableZoom = false; // replaced below with a fixed-step handler
controls.minDistance = 1.5;   // inches - stop before clipping into a part
controls.maxDistance = 400;   // inches - stop before flying off into space
controls.panSpeed = 0.9;

// The canvas is absolutely positioned and CSS-sized (style.css), so resizing
// its drawing buffer can't change the viewport's layout and re-trigger the
// observer in a loop.
let lastSize = '';
function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  if (!w || !h || `${w}x${h}` === lastSize) return;
  lastSize = `${w}x${h}`;
  renderer.setSize(w, h, false);
  perspCamera.aspect = w / h;
  perspCamera.updateProjectionMatrix();
  updateOrthoFrustum();
}
new ResizeObserver(resize).observe(viewport);

// Size the ortho frustum so switching projections keeps the same framing.
function updateOrthoFrustum() {
  const dist = orthoCamera.position.distanceTo(controls.target) || 50;
  const halfH = dist * Math.tan(THREE.MathUtils.degToRad(perspCamera.fov / 2));
  const aspect = perspCamera.aspect || 1;
  orthoCamera.left = -halfH * aspect; orthoCamera.right = halfH * aspect;
  orthoCamera.top = halfH; orthoCamera.bottom = -halfH;
  orthoCamera.updateProjectionMatrix();
}

function setOrtho(on) {
  const next = on ? orthoCamera : perspCamera;
  if (next === camera) return;
  next.position.copy(camera.position);
  next.quaternion.copy(camera.quaternion);
  next.up.copy(camera.up);
  if (on) { orthoCamera.zoom = 1; updateOrthoFrustum(); }
  camera = next;
  controls.object = camera;
  controls.update();
  $('orthoBtn').classList.toggle('on', on);
}

// Three's built-in wheel zoom scales the step size by the browser/OS-reported
// scroll delta, which varies wildly across mice/trackpads and makes zoom feel
// random (tiny steps on one device, huge jumps on another). Use a fixed
// percentage step per wheel event instead, so it's always smooth increments.
const ZOOM_STEP = 0.08;
renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  cancelCameraTween();
  const factor = e.deltaY > 0 ? (1 + ZOOM_STEP) : (1 - ZOOM_STEP);
  if (camera.isOrthographicCamera) {
    camera.zoom = THREE.MathUtils.clamp(camera.zoom / factor, 0.05, 80);
    camera.updateProjectionMatrix();
    return;
  }
  const offset = camera.position.clone().sub(controls.target);
  const newDist = THREE.MathUtils.clamp(offset.length() * factor, controls.minDistance, controls.maxDistance);
  offset.setLength(newDist);
  camera.position.copy(controls.target).add(offset);
}, { passive: false });

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const sun1 = new THREE.DirectionalLight(0xffffff, 1.1);
sun1.position.set(1, 2, 1.5);
scene.add(sun1);
const sun2 = new THREE.DirectionalLight(0xffffff, 0.5);
sun2.position.set(-1.2, 1, -1);
scene.add(sun2);

// ground grid (model is exported Y-up, standard three.js convention); 5" squares
const grid = new THREE.GridHelper(120, 24, 0x444444, 0x2a2a2a);
scene.add(grid);

// ---------- state ----------
let config = {};
let axisNames = DEFAULT_AXIS_NAMES;
let objectDims = {};  // safe_name -> { center, axes: [{direction,length,role,label}] }
let rows = [];
let model = null;
const meshes = [];                 // every part mesh
const meshByName = new Map();      // obj name -> mesh
const rowByMeshName = new Map();   // obj name -> cut-list row
const meshInfo = new Map();        // mesh -> { orig, dim, hl, row, baseCenter, groupCenter }
let modelBox = new THREE.Box3();
let modelCenter = new THREE.Vector3();
let wireOn = false;
let explode = 0;
let section = { axis: 'off', t: 1, flip: false };
const clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
let current = null; // { row, meshes, box, gizmo: Group, labels: [{pos, el}] }

const dimCard = $('dimCard');
const axisLabelsEl = $('axisLabels');
const AXIS_COLORS = { Length: '#ff6b4a', Width: '#7ee08a', Thickness: '#6ab7ff' };

// ---------- procedural wood grain (no external texture assets needed) ----------
function generateBoxUV(geometry, tileSize) {
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const pos = geometry.attributes.position;
  const norm = geometry.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = Math.abs(norm.getX(i)), ny = Math.abs(norm.getY(i)), nz = Math.abs(norm.getZ(i));
    let u, v;
    if (nx >= ny && nx >= nz) { u = y; v = z; }
    else if (ny >= nx && ny >= nz) { u = x; v = z; }
    else { u = x; v = y; }
    uv[i * 2] = u / tileSize;
    uv[i * 2 + 1] = v / tileSize;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

// Seeded so the grain looks the same on every load (and in screenshots).
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const woodTextureCache = new Map();
function getWoodTexture(key, { base, streak, ring }) {
  if (woodTextureCache.has(key)) return woodTextureCache.get(key);
  const rand = mulberry32([...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7));
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 90; i++) {
    let x = rand() * size;
    g.strokeStyle = rand() < 0.5 ? streak : ring;
    g.globalAlpha = 0.06 + rand() * 0.16;
    g.lineWidth = 0.5 + rand() * 2.2;
    g.beginPath();
    g.moveTo(x, 0);
    for (let y = 0; y <= size; y += 14) { x += (rand() - 0.5) * 9; g.lineTo(x, y); }
    g.stroke();
  }
  for (let i = 0; i < 2; i++) {
    if (rand() < 0.5) continue;
    const kx = rand() * size, ky = rand() * size, kr = 6 + rand() * 10;
    const grad = g.createRadialGradient(kx, ky, 1, kx, ky, kr);
    grad.addColorStop(0, streak);
    grad.addColorStop(1, base);
    g.globalAlpha = 0.5;
    g.fillStyle = grad;
    g.beginPath(); g.arc(kx, ky, kr, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  woodTextureCache.set(key, tex);
  return tex;
}

// ---------- loading ----------
const fetchJSON = (url, fallback) => fetch(url).then((r) => {
  if (!r.ok) { if (fallback !== undefined) return fallback; throw new Error(`${url}: HTTP ${r.status}`); }
  return r.json();
});
const loadMTL = (url) => new Promise((res, rej) => new MTLLoader().load(url, res, undefined, rej));
const loadOBJ = (url, materials) => new Promise((res, rej) => {
  const loader = new OBJLoader();
  if (materials) loader.setMaterials(materials);
  loader.load(url, res, (e) => {
    if (e.lengthComputable) $('loading').textContent = `Loading model… ${Math.round((e.loaded / e.total) * 100)}%`;
  }, rej);
});

async function init() {
  const [cfg, materialNames, dims, report] = await Promise.all([
    fetchJSON('model.json', {}),
    fetchJSON('materials.json'),
    fetchJSON('object_dims.json'),
    fetchJSON('parts_report.json'),
  ]);
  config = cfg;
  axisNames = { ...DEFAULT_AXIS_NAMES, ...(cfg.axisNames || {}) };
  objectDims = dims;
  document.title = `${cfg.title || 'Model'} — Cut List Viewer`;
  initSettings((cfg.title || 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  rows = prepareRows(report, cfg);
  rows.forEach((r) => (r.obj_names || []).forEach((n) => rowByMeshName.set(n, r)));

  renderCutList($('sidebar'), rows, cfg, { onSelect: (r) => selectRow(r), onPrint: printSheet });
  buildViewButtons();

  const mtl = await loadMTL('scene.mtl');
  mtl.preload();
  model = await loadOBJ('scene.obj', mtl);
  scene.add(model);
  prepareMeshes(materialNames);
  frameBox(modelBox, config.views?.iso?.dir || [0.7, 0.5, 0.7], false);
  $('loading').style.display = 'none';
  applySettingsToScene();
  selectFromHash();
}

function prepareMeshes(materialNames) {
  model.traverse((child) => {
    if (!child.isMesh) return;
    const realName = materialNames[child.material && child.material.name];
    const tex = config.materials?.[realName]?.texture;
    if (tex) {
      generateBoxUV(child.geometry, tex.tile || 5);
      child.material = new THREE.MeshStandardMaterial({ map: getWoodTexture(realName, tex), roughness: 0.85, metalness: 0.0 });
    } else {
      child.material = child.material.clone(); // own copy so clipping/wireframe flags are per mesh
    }
    const orig = child.material;
    const dim = orig.clone();
    dim.transparent = true;
    dim.opacity = 0.18;
    dim.depthWrite = false;
    const hl = orig.clone();
    hl.emissive = new THREE.Color(0xff5b3d);
    hl.emissiveIntensity = 0.55;
    if (!hl.map) hl.color = new THREE.Color(0xff8a66);
    const row = rowByMeshName.get(child.name);
    meshes.push(child);
    meshByName.set(child.name, child);
    child.geometry.computeBoundingBox();
    meshInfo.set(child, { orig, dim, hl, row, baseCenter: child.geometry.boundingBox.getCenter(new THREE.Vector3()) });
  });
  modelBox = new THREE.Box3().setFromObject(model);
  modelCenter = modelBox.getCenter(new THREE.Vector3());

  // Exploded view moves each assembly group away from the model center, and
  // each part a little further away from its group's center, so assemblies
  // stay recognisable while coming apart.
  const groupBoxes = new Map();
  meshes.forEach((m) => {
    const g = meshInfo.get(m).row?.top_group || '?';
    if (!groupBoxes.has(g)) groupBoxes.set(g, new THREE.Box3());
    groupBoxes.get(g).expandByPoint(m.geometry.boundingBox.min).expandByPoint(m.geometry.boundingBox.max);
  });
  meshes.forEach((m) => {
    const info = meshInfo.get(m);
    info.groupCenter = groupBoxes.get(info.row?.top_group || '?').getCenter(new THREE.Vector3());
  });
}

// ---------- materials / visibility ----------
function allMaterials() {
  const out = [];
  meshInfo.forEach(({ orig, dim, hl }) => out.push(orig, dim, hl));
  return out;
}

function applyMaterials() {
  const s = settings();
  const hidden = new Set(s.hiddenCategories);
  const selected = new Set(current ? current.meshes : []);
  meshes.forEach((m) => {
    const info = meshInfo.get(m);
    const catHidden = info.row && hidden.has(info.row.category);
    const isSel = selected.has(m);
    m.visible = isSel || (!catHidden && !(s.isolate && current && !isSel));
    m.material = !current ? info.orig : isSel ? info.hl : info.dim;
  });
}

function applySection() {
  const on = section.axis !== 'off';
  if (on) {
    const i = { x: 0, y: 1, z: 2 }[section.axis];
    const min = modelBox.min.getComponent(i) - 0.01, max = modelBox.max.getComponent(i) + 0.01;
    const v = min + (max - min) * section.t;
    const n = new THREE.Vector3(); n.setComponent(i, section.flip ? 1 : -1);
    clipPlane.normal.copy(n);
    clipPlane.constant = section.flip ? -v : v;
  }
  allMaterials().forEach((mat) => {
    mat.clippingPlanes = on ? [clipPlane] : [];
    mat.side = on ? THREE.DoubleSide : THREE.FrontSide;
    mat.needsUpdate = true;
  });
}

function setWireframe(on) {
  wireOn = on;
  allMaterials().forEach((m) => { m.wireframe = on; });
  $('wireBtn').classList.toggle('on', on);
}

function setExplode(f) {
  explode = f;
  meshes.forEach((m) => {
    const { baseCenter, groupCenter } = meshInfo.get(m);
    m.position.copy(groupCenter).sub(modelCenter).multiplyScalar(f)
      .add(baseCenter.clone().sub(groupCenter).multiplyScalar(f * 0.6));
  });
  $('explodeRange').value = String(f);
  // measurements were taken on the parts' old positions
  if (measure.measurements.length) measure.clear();
  if (current) buildSelectionOverlays();
}

function applySettingsToScene() {
  applyMaterials();
  $('isolateBtn').classList.toggle('on', settings().isolate);
  if (current) buildSelectionOverlays();
  measure.refreshLabels();
}

onSettingsChange((s, patch) => {
  if ('units' in patch || 'showRough' in patch || 'allowance' in patch || 'cut' in patch || 'hiddenCategories' in patch) renderRows();
  if ('hiddenCategories' in patch && current && settings().hiddenCategories.includes(current.row.category)) clearSelection();
  if (model) applySettingsToScene();
});

// ---------- camera framing / view presets ----------
let tween = null;
function cancelCameraTween() { tween = null; }

// Distance at which `box`, seen from direction `dir`, fills the view with a
// small margin: project the box corners onto the view plane and fit whichever
// of width/height is the tighter constraint.
function fitDistance(box, dir) {
  const up = Math.abs(dir.y) > 0.99 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(up, dir).normalize();
  const trueUp = new THREE.Vector3().crossVectors(dir, right).normalize();
  const center = box.getCenter(new THREE.Vector3());
  let halfW = 0.5, halfH = 0.5, depth = 0;
  for (let i = 0; i < 8; i++) {
    const c = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center);
    halfW = Math.max(halfW, Math.abs(c.dot(right)));
    halfH = Math.max(halfH, Math.abs(c.dot(trueUp)));
    depth = Math.max(depth, c.dot(dir));
  }
  const tanV = Math.tan(THREE.MathUtils.degToRad(perspCamera.fov / 2));
  const tanH = tanV * (perspCamera.aspect || 1);
  return Math.max(halfW / tanH, halfH / tanV) * 1.15 + depth;
}

function frameBox(box, dirArr, animate = true) {
  const center = box.getCenter(new THREE.Vector3());
  const dir = dirArr ? new THREE.Vector3(...dirArr).normalize()
    : camera.position.clone().sub(controls.target).normalize();
  const dist = fitDistance(box, dir);
  const toPos = center.clone().addScaledVector(dir, dist);
  if (!animate) {
    camera.position.copy(toPos);
    controls.target.copy(center);
    if (camera.isOrthographicCamera) { camera.zoom = 1; updateOrthoFrustum(); }
    controls.update();
    return;
  }
  tween = {
    t0: performance.now(), dur: 380,
    fromPos: camera.position.clone(), toPos,
    fromTarget: controls.target.clone(), toTarget: center,
    fromZoom: camera.zoom, toZoom: 1,
  };
}

function stepTween(now) {
  if (!tween) return;
  const k = Math.min(1, (now - tween.t0) / tween.dur);
  const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
  // move along a spherical path around the target so views swing, not cut through the model
  const target = tween.fromTarget.clone().lerp(tween.toTarget, e);
  const fromOff = tween.fromPos.clone().sub(tween.fromTarget);
  const toOff = tween.toPos.clone().sub(tween.toTarget);
  const len = THREE.MathUtils.lerp(fromOff.length(), toOff.length(), e);
  const dir = fromOff.normalize().lerp(toOff.normalize(), e);
  if (dir.lengthSq() < 1e-6) dir.copy(toOff);
  camera.position.copy(target).addScaledVector(dir.normalize(), len);
  controls.target.copy(target);
  if (camera.isOrthographicCamera) {
    camera.zoom = THREE.MathUtils.lerp(tween.fromZoom, tween.toZoom, e);
    updateOrthoFrustum();
  }
  if (k >= 1) tween = null;
}

function focusBox() {
  if (current && current.box) return current.box;
  const b = new THREE.Box3();
  meshes.forEach((m) => { if (m.visible) b.expandByObject(m); });
  return b.isEmpty() ? modelBox : b;
}

function setView(key) {
  const v = config.views?.[key];
  if (!v) return;
  frameBox(focusBox(), v.dir);
  // straight-on elevations/plans read best without perspective
  if (key !== 'iso' && !camera.isOrthographicCamera && settingsOrthoAuto) setOrtho(true);
  if (key === 'iso' && camera.isOrthographicCamera && settingsOrthoAuto) setOrtho(false);
}
let settingsOrthoAuto = true; // until the user toggles ortho themselves

function buildViewButtons() {
  const wrap = $('viewBtns');
  wrap.innerHTML = '';
  Object.entries(config.views || { iso: { label: '3D', dir: [0.7, 0.5, 0.7] } }).forEach(([key, v], i) => {
    const b = document.createElement('button');
    b.textContent = v.label || key;
    b.title = `${v.label || key} view (${i + 1})`;
    b.addEventListener('click', () => setView(key));
    wrap.appendChild(b);
  });
}

// ---------- selection ----------
function selectRow(row, { frame = true } = {}) {
  if (!row || !row.clickable || !model) return;
  if (settings().hiddenCategories.includes(row.category)) {
    updateSettings({ hiddenCategories: settings().hiddenCategories.filter((c) => c !== row.category) });
  }
  clearSelection({ keepHash: true });
  current = { row, meshes: row.obj_names.map((n) => meshByName.get(n)).filter(Boolean) };
  applyMaterials();
  buildSelectionOverlays();
  if (frame && current.box) frameBox(current.box, null);
  markActive(row);
  measure.onSelectionChange();
  try { history.replaceState(null, '', `#part=${encodeURIComponent(row.label)}`); } catch { /* sandboxed */ }
}

function clearSelection({ keepHash = false } = {}) {
  disposeOverlays();
  current = null;
  dimCard.style.display = 'none';
  markActive(null);
  if (model) applyMaterials();
  measure.onSelectionChange();
  if (!keepHash && location.hash) { try { history.replaceState(null, '', location.pathname + location.search); } catch { /* sandboxed */ } }
}

function selectFromHash() {
  const m = /part=([^&]+)/.exec(location.hash);
  if (!m) return;
  const label = decodeURIComponent(m[1]);
  const row = rows.find((r) => r.label === label && r.clickable);
  if (row) selectRow(row);
}
window.addEventListener('hashchange', selectFromHash);

function stepSelection(delta) {
  const list = visibleRows().filter((r) => r.clickable);
  if (!list.length) return;
  const i = current ? list.findIndex((r) => r.key === current.row.key) : -1;
  const next = list[(i + delta + list.length) % list.length];
  selectRow(next);
}

function disposeOverlays() {
  if (!current) return;
  if (current.gizmo) {
    scene.remove(current.gizmo);
    current.gizmo.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    current.gizmo = null;
  }
  axisLabelsEl.innerHTML = '';
  current.labels = [];
}

function buildSelectionOverlays() {
  disposeOverlays();
  const box = new THREE.Box3();
  current.meshes.forEach((m) => box.expandByObject(m));
  current.box = box.isEmpty() ? null : box;
  const gizmo = new THREE.Group();
  const labelSpecs = [];
  if (current.box) {
    const helper = new THREE.Box3Helper(current.box, new THREE.Color(0x555555));
    gizmo.add(helper);
  }
  // Identical copies share dimensions, so only dimension the first one; show
  // the lean on each, since mirrored pairs lean in opposite directions.
  current.meshes.forEach((m, i) => {
    const data = objectDims[m.name];
    if (!data || !data.axes) return;
    const sub = new THREE.Group();
    sub.position.copy(m.position); // exploded-view offset
    if (i === 0) buildDimensionGizmo(sub, data, labelSpecs, m.position);
    buildAngleGizmo(sub, data, labelSpecs, m.position);
    gizmo.add(sub);
  });
  scene.add(gizmo);
  current.gizmo = gizmo;
  current.labels = labelSpecs.map((spec) => {
    const el = document.createElement('div');
    el.className = 'axisLabel';
    el.textContent = spec.text;
    el.style.background = spec.color;
    axisLabelsEl.appendChild(el);
    return { pos: spec.pos, el };
  });
  renderDimCard();
}

const MARGIN = 0.6;   // inches, how far the dimension line stands off the part's face
const TICK_LEN = 0.5; // inches, length of the little perpendicular end-ticks

function buildDimensionGizmo(group, data, labelSpecs, offset) {
  if (data.axes.length < 3) return;
  const units = settings().units;
  const center = new THREE.Vector3(...data.center);
  const axes = data.axes.map((a) => ({ dir: new THREE.Vector3(...a.direction), length: a.length, role: a.role }));
  // Each axis's dimension line is offset toward a different corner of the
  // box (rather than all three converging on one corner), so the lines and
  // labels spread out around the part instead of overlapping.
  const CORNER_SIGNS = [[1, 1], [-1, 1], [1, -1]];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3, k = (i + 2) % 3;
    const [sj, sk] = CORNER_SIGNS[i];
    const lineCenter = center.clone()
      .addScaledVector(axes[j].dir, sj * (axes[j].length / 2 + MARGIN))
      .addScaledVector(axes[k].dir, sk * (axes[k].length / 2 + MARGIN));
    const half = axes[i].dir.clone().multiplyScalar(axes[i].length / 2);
    const p1 = lineCenter.clone().sub(half), p2 = lineCenter.clone().add(half);
    const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(AXIS_COLORS[axes[i].role] || '#ffffff') });
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([p1, p2]), mat));
    [p1, p2].forEach((p) => {
      const t = axes[j].dir.clone().multiplyScalar(TICK_LEN / 2);
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([p.clone().sub(t), p.clone().add(t)]), mat));
    });
    labelSpecs.push({ pos: lineCenter.clone().add(offset), text: formatLength(axes[i].length, units), color: AXIS_COLORS[axes[i].role] });
  }
}

// The angle gizmo's centerline/arcs intentionally pass through the solid part
// (e.g. straight through the middle of a leg) to show the true geometric
// pivot, so they'd normally be hidden behind the opaque mesh. Render them
// depth-tested-off so they act like an X-ray overlay, always visible.
function xrayLineMaterial(color) {
  return new THREE.LineBasicMaterial({ color: new THREE.Color(color), depthTest: false, transparent: true });
}

function addArc(group, pivot, v1, v2, radius, color, labelSpecs, labelText, offset) {
  const angle = v1.angleTo(v2);
  if (angle < 0.005) return;
  const axis = new THREE.Vector3().crossVectors(v1, v2).normalize();
  const pts = [];
  for (let s = 0; s <= 24; s++) pts.push(v1.clone().applyAxisAngle(axis, (angle * s) / 24).multiplyScalar(radius).add(pivot));
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), xrayLineMaterial(color));
  line.renderOrder = 999;
  group.add(line);
  // filled wedge (protractor-style), since thin WebGL lines barely show up
  const fan = new THREE.BufferGeometry().setFromPoints([pivot, ...pts]);
  fan.setIndex(pts.slice(0, -1).flatMap((_, i) => [0, i + 1, i + 2]));
  const mesh = new THREE.Mesh(fan, new THREE.MeshBasicMaterial({
    color: new THREE.Color(color), transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthTest: false,
  }));
  mesh.renderOrder = 998;
  group.add(mesh);
  if (labelText) labelSpecs.push({ pos: pts[12].clone().add(offset), text: labelText, color });
}

// Draws the lean as something you can actually SEE: a reference line (plumb,
// or level along the nearest world axis) from the part's end, the part's real
// centerline, and an arc showing how far one swings from the other - plus the
// two component arcs (e.g. rake and splay) that make up that total, each drawn
// in its own elevation plane.
const COMPONENT_COLORS = ['#ff6bd6', '#63d9ff'];
function buildAngleGizmo(group, data, labelSpecs, offset) {
  const lengthAxis = data.axes.find((a) => a.role === 'Length');
  if (!lengthAxis) return;
  const ang = compoundAngle(lengthAxis.direction, axisNames);
  if (!ang) return;
  const center = new THREE.Vector3(...data.center);
  const dir = new THREE.Vector3(...ang.dir);
  const ref = new THREE.Vector3(...ang.refVector);
  const half = lengthAxis.length / 2;
  const pivot = center.clone().addScaledVector(dir, -half); // the end the reference is drawn from
  const otherEnd = center.clone().addScaledVector(dir, half);
  const radius = Math.max(3, Math.min(lengthAxis.length * 0.4, 10));

  const refLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([pivot, pivot.clone().addScaledVector(ref, radius * 1.35)]), xrayLineMaterial(0xcccccc));
  refLine.renderOrder = 999;
  group.add(refLine);
  const cLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([pivot, otherEnd]), xrayLineMaterial(0xffe066));
  cLine.renderOrder = 999;
  group.add(cLine);
  addArc(group, pivot, ref, dir, radius * 1.1, '#ffe066', labelSpecs, `${round1(ang.total)}°`, offset);

  ang.components.forEach((c, i) => {
    if (Math.abs(c.deg) < 0.05 || Math.abs(Math.abs(c.deg) - ang.total) < 0.05) return; // single-plane tilt: total says it all
    const proj = dir.clone();
    proj.setComponent(c.planeNormal.indexOf(1), 0);
    if (proj.lengthSq() < 1e-6) return;
    addArc(group, pivot, ref, proj.normalize(), radius * (0.7 - i * 0.2), COMPONENT_COLORS[i], labelSpecs,
      `${Math.abs(round1(c.deg))}° ${c.label}`, offset);
  });
}

function angleHtml(data) {
  if (!data) return '';
  const lines = [];
  const L = data.axes.find((a) => a.role === 'Length');
  const lenAng = L && compoundAngle(L.direction, axisNames);
  if (lenAng) {
    lines.push(`<div class="angle-line">∠ ${escapeHtml(describeAngle(lenAng))}</div>`);
    const both = lenAng.components.filter((c) => Math.abs(c.deg) >= 0.05);
    if (lenAng.reference === 'plumb' && both.length === 2) {
      // Chairmaker terms for boring a splayed leg mortise.
      const sl = Math.abs(round1(lenAng.sightline));
      lines.push(`<div class="angle-sub">Resultant ${round1(lenAng.total)}° along a sightline ${sl}° off the ${escapeHtml(axisNames.x)} line (plan view). Bevel gauge: ${round1(90 - lenAng.total)}° to the surface.</div>`);
    }
  } else {
    // long axis is square, but the part may be rolled about it (e.g. a canted jaw)
    const other = data.axes.filter((a) => a.role !== 'Length').map((a) => compoundAngle(a.direction, axisNames)).find(Boolean);
    if (other) lines.push(`<div class="angle-line">∠ Rolled ${round1(other.total)}° about its length (faces are off ${other.reference === 'plumb' ? 'plumb' : 'level'})</div>`);
  }
  return lines.join('');
}

function renderDimCard() {
  const row = current.row;
  const data = objectDims[current.meshes[0]?.name];
  const notes = row.notes.map((n) => `<div class="card-note${row.warn ? ' warn' : ''}">${row.warn ? '⚠ ' : ''}${escapeHtml(n)}</div>`).join('');
  dimCard.innerHTML = `
    <button class="card-close" title="Clear selection (Esc)">×</button>
    <div class="part-name">${escapeHtml(row.name)}</div>
    <div class="dim-big">${escapeHtml(finishedDims(row))}</div>
    <div class="dim-axes">${row.customDims ? '' : 'Thickness × Width × Length'}</div>
    ${angleHtml(data)}
    <div class="meta">qty ${row.count} · ${escapeHtml(row.materialLabel)} · ${escapeHtml(row.groupName)}</div>
    ${notes}
  `;
  dimCard.style.display = 'block';
  dimCard.querySelector('.card-close').addEventListener('click', () => clearSelection());
}

// ---------- hover + click picking ----------
const raycaster = new THREE.Raycaster();
const hoverTip = $('hoverTip');
function raycastAt(clientX, clientY, list) {
  const r = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), camera);
  const hits = raycaster.intersectObjects(list, false);
  return hits[0] || null;
}

const measure = initMeasure({
  scene,
  getCamera: () => camera,
  canvas: renderer.domElement,
  pickMeshes: () => (current ? current.meshes : meshes.filter((m) => m.visible)),
  selectionName: () => (current ? current.row.name : null),
  labelsEl: $('measureLabels'),
  hintEl: $('measureHint'),
  units: () => settings().units,
});

// A native "click" event already ignores drags (browsers don't fire it if the
// pointer moved between down/up), so this avoids fighting with OrbitControls'
// own pointerdown/pointerup handling.
renderer.domElement.addEventListener('click', (e) => {
  if (!model) return;
  if (measure.handleClick(e)) return;
  const hit = raycastAt(e.clientX, e.clientY, meshes.filter((m) => m.visible));
  if (!hit) { if (current) clearSelection(); return; }
  const row = rowByMeshName.get(hit.object.name);
  if (row && (!current || row.key !== current.row.key)) selectRow(row, { frame: false });
});
renderer.domElement.addEventListener('dblclick', () => { if (current) frameBox(current.box, null); });

let pendingMove = null;
renderer.domElement.addEventListener('pointermove', (e) => { if (e.buttons === 0) pendingMove = e; });
renderer.domElement.addEventListener('pointerleave', () => { pendingMove = null; hoverTip.style.display = 'none'; });
function processHover() {
  const e = pendingMove;
  pendingMove = null;
  if (!e || !model) return;
  measure.handleMove(e);
  if (measure.mode) { hoverTip.style.display = 'none'; renderer.domElement.style.cursor = 'crosshair'; return; }
  const hit = raycastAt(e.clientX, e.clientY, meshes.filter((m) => m.visible));
  const row = hit && rowByMeshName.get(hit.object.name);
  renderer.domElement.style.cursor = row ? 'pointer' : '';
  if (!row) { hoverTip.style.display = 'none'; return; }
  const r = viewport.getBoundingClientRect();
  hoverTip.innerHTML = `<b>${escapeHtml(row.name)}</b> <span>${escapeHtml(finishedDims(row))}</span>`;
  hoverTip.style.display = 'block';
  hoverTip.style.left = `${e.clientX - r.left + 14}px`;
  hoverTip.style.top = `${e.clientY - r.top + 14}px`;
}

// ---------- toolbar / controls wiring ----------
$('resetBtn').addEventListener('click', () => { clearSelection(); setExplode(0); frameBox(focusBox(), config.views?.iso?.dir); });
$('wireBtn').addEventListener('click', () => setWireframe(!wireOn));
$('isolateBtn').addEventListener('click', () => updateSettings({ isolate: !settings().isolate }));
$('orthoBtn').addEventListener('click', () => { settingsOrthoAuto = false; setOrtho(!camera.isOrthographicCamera); });
const toolButtons = { distance: $('measureDistBtn'), angle: $('measureAngleBtn'), bevel: $('measureBevelBtn') };
function syncToolButtons() {
  Object.entries(toolButtons).forEach(([k, b]) => b.classList.toggle('on', k === measure.mode));
  if (!measure.mode) renderer.domElement.style.cursor = '';
}
function setTool(t) {
  measure.setMode(t);
  syncToolButtons();
}
Object.entries(toolButtons).forEach(([k, b]) => b.addEventListener('click', () => setTool(k)));
$('clearMeasureBtn').addEventListener('click', () => measure.clear());
$('explodeRange').addEventListener('input', (e) => setExplode(parseFloat(e.target.value)));
$('sectionAxis').addEventListener('change', (e) => { section.axis = e.target.value; $('sectionRange').disabled = section.axis === 'off'; $('sectionFlip').disabled = section.axis === 'off'; applySection(); });
$('sectionRange').addEventListener('input', (e) => { section.t = parseFloat(e.target.value); applySection(); });
$('sectionFlip').addEventListener('click', () => { section.flip = !section.flip; applySection(); });
$('shotBtn').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = captureImage();
  a.download = `${(config.title || 'model').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}${current ? '-' + current.row.label.toLowerCase() : ''}.png`;
  a.click();
});
$('helpBtn').addEventListener('click', () => toggleHelp());
$('helpClose').addEventListener('click', () => toggleHelp(false));
$('sidebarToggle').addEventListener('click', () => document.body.classList.toggle('sidebar-collapsed'));

function toggleHelp(force) {
  const el = $('help');
  el.style.display = (force ?? el.style.display !== 'flex') ? 'flex' : 'none';
}

function captureImage() {
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
}

function printSheet() { window.print(); }
window.addEventListener('beforeprint', () => {
  let img = null;
  try { img = model ? captureImage() : null; } catch { /* tainted canvas etc. */ }
  buildPrintSheet($('printSheet'), rows, config, img);
});

// ---------- keyboard shortcuts ----------
window.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { if (measure.undo()) e.preventDefault(); }
    return;
  }
  const viewKeys = Object.keys(config.views || {});
  const k = e.key;
  if (k === 'Escape') {
    if ($('help').style.display === 'flex') toggleHelp(false);
    else if (measure.cancel()) syncToolButtons();
    else clearSelection();
  } else if (k === 'ArrowDown' || k === 'j') { stepSelection(1); e.preventDefault(); }
  else if (k === 'ArrowUp' || k === 'k') { stepSelection(-1); e.preventDefault(); }
  else if (k === 'f') frameBox(focusBox(), null);
  else if (/^[1-9]$/.test(k) && viewKeys[+k - 1]) setView(viewKeys[+k - 1]);
  else if (k === 'o') $('orthoBtn').click();
  else if (k === 'w') setWireframe(!wireOn);
  else if (k === 'i') updateSettings({ isolate: !settings().isolate });
  else if (k === 'e') setExplode(explode > 0 ? 0 : 0.6);
  else if (k === 'd') setTool('distance');
  else if (k === 'a') setTool('angle');
  else if (k === 'b') setTool('bevel');
  else if (k === 'Backspace' || k === 'Delete') { if (measure.undo()) e.preventDefault(); }
  else if (k === '/') { focusSearch(); e.preventDefault(); }
  else if (k === '?') toggleHelp();
});

// ---------- per-frame ----------
function project(worldPos) {
  const p = worldPos.clone().project(camera);
  return { x: (p.x * 0.5 + 0.5) * viewport.clientWidth, y: (0.5 - p.y * 0.5) * viewport.clientHeight, behind: p.z > 1 };
}

function updateOverlays() {
  if (current) {
    (current.labels || []).forEach(({ pos, el }) => {
      const s = project(pos);
      el.style.display = s.behind ? 'none' : 'block';
      el.style.left = `${s.x}px`;
      el.style.top = `${s.y}px`;
    });
  }
  measure.update(project);
}

function animate(now) {
  requestAnimationFrame(animate);
  stepTween(now);
  controls.update();
  if (camera.isOrthographicCamera) updateOrthoFrustumIfNeeded();
  processHover();
  updateOverlays();
  renderer.render(scene, camera);
}
let lastOrthoDist = 0;
function updateOrthoFrustumIfNeeded() {
  const d = camera.position.distanceTo(controls.target);
  if (Math.abs(d - lastOrthoDist) > 1e-3) { lastOrthoDist = d; updateOrthoFrustum(); }
}
resize();
requestAnimationFrame(animate);

init().catch((err) => {
  $('loading').textContent = `Failed to load model: ${err.message || err}`;
  console.error(err);
});

// Handle for tests/debugging in the console; not used by the app itself.
window.__viewer = {
  THREE, scene, renderer, controls, measure,
  get camera() { return camera; },
  get model() { return model; },
  get current() { return current; },
  currentSelectionMeshes: () => (current ? current.meshes : []),
  measureClickCount: () => measure.points.length + measure.measurements.length * 2,
  setExplode, setView, selectRow, rows: () => rows,
};
