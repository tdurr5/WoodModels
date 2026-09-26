import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { formatLength, escapeHtml } from './format.js';
import { compoundAngle, describeAngle, round1, DEFAULT_AXIS_NAMES } from './angles.js';
import { initSettings, settings, updateSettings, onSettingsChange } from './settings.js';
import {
  prepareRows, renderCutList, renderRows, markActive, visibleRows, focusSearch, finishedDims, buildPrintSheet, isRod,
} from './cutlist.js';
import { initMeasure } from './measure.js';
import { initDiagramModal, computeLayouts, layoutsHTML } from './diagram.js';
import { buildTemplate } from './template.js';
import { obbFromDims, partsTouch } from './geometry.js';

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
let section = { axis: 'off', t: 0.5, flip: false }; // t matches the slider's initial value
const clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
let current = null; // { row, meshes, box, gizmo: Group, labels: [{pos, el}] }
let diagram = null; // cutting-diagram modal

const dimCard = $('dimCard');
const axisLabelsEl = $('axisLabels');
const AXIS_COLORS = { Length: '#ff6b4a', Width: '#7ee08a', Thickness: '#6ab7ff' };

// ---------- procedural wood grain (no external texture assets needed) ----------
// Texture streaks run along the texture's V axis, so map V to the part's own
// length axis: grain then runs along every board the way it's cut, whatever
// its orientation in the model. U is whichever cross axis lies in the face.
// Parts without dimension data fall back to world-axis box mapping.
function generateGrainUV(geometry, tileSize, dims) {
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const pos = geometry.attributes.position;
  const norm = geometry.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  const byRole = dims ? Object.fromEntries(dims.axes.map((a) => [a.role, new THREE.Vector3(...a.direction)])) : {};
  const L = byRole.Length, W = byRole.Width, T = byRole.Thickness;
  const c = dims ? new THREE.Vector3(...dims.center) : new THREE.Vector3();
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(norm, i);
    let u, v;
    if (L && W && T) {
      p.sub(c);
      const nl = Math.abs(n.dot(L)), nw = Math.abs(n.dot(W)), nt = Math.abs(n.dot(T));
      if (nl > nw && nl > nt) { u = p.dot(W); v = p.dot(T); } // end grain
      else { u = nw > nt ? p.dot(T) : p.dot(W); v = p.dot(L); }
    } else {
      const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
      if (ax >= ay && ax >= az) { u = p.y; v = p.z; }
      else if (ay >= ax && ay >= az) { u = p.x; v = p.z; }
      else { u = p.x; v = p.y; }
    }
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
  applyTheme();
  rows = prepareRows(report, cfg);
  rows.forEach((r) => (r.obj_names || []).forEach((n) => rowByMeshName.set(n, r)));

  renderCutList($('sidebar'), rows, cfg, { onSelect: (r) => selectRow(r), onPrint: printSheet, onDiagram: () => diagram.open() });
  diagram = initDiagramModal({ rows, onSelectRow: (r) => selectRow(r) });
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
      generateGrainUV(child.geometry, tex.tile || 5, objectDims[child.name]);
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

// Section caps: solid cut faces instead of hollow shells. Each part gets an
// invisible, clipped copy that flips the stencil bit on every surface a pixel's
// ray crosses (parity), leaving it set exactly where the cut plane is inside a
// solid; one plane on the cut then draws only there and clears the stencil.
// SketchUp exports every face as a back-to-back pair of triangles, which would
// cancel out, so the copy keeps one triangle of each pair. The copies are
// children of their part so they follow the exploded view and visibility.
let capMesh = null;
const stencilHelpers = [];

function singleSidedGeometry(geo) {
  const src = geo.index ? geo.toNonIndexed() : geo;
  const pos = src.attributes.position.array;
  const seen = new Set();
  const keep = [];
  const k = (i) => `${pos[i].toFixed(4)},${pos[i + 1].toFixed(4)},${pos[i + 2].toFixed(4)}`;
  for (let t = 0; t + 8 < pos.length; t += 9) {
    const key = [k(t), k(t + 3), k(t + 6)].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    for (let j = 0; j < 9; j++) keep.push(pos[t + j]);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(keep, 3));
  return out;
}

function ensureSectionCaps() {
  if (capMesh) return;
  const flip = new THREE.MeshBasicMaterial({
    side: THREE.DoubleSide, colorWrite: false, depthWrite: false, depthTest: false,
    stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, stencilWriteMask: 1,
    stencilFail: THREE.InvertStencilOp, stencilZFail: THREE.InvertStencilOp, stencilZPass: THREE.InvertStencilOp,
    clippingPlanes: [clipPlane],
  });
  meshes.forEach((m) => {
    const h = new THREE.Mesh(singleSidedGeometry(m.geometry), flip);
    h.renderOrder = 1;
    h.raycast = () => {}; // never pickable
    m.add(h);
    stencilHelpers.push(h);
  });
  const size = modelBox.getSize(new THREE.Vector3()).length() * 4;
  // drafting-style diagonal hatch, one line every 3/8"
  const hc = document.createElement('canvas');
  hc.width = hc.height = 32;
  const hg = hc.getContext('2d');
  hg.fillStyle = '#f1dfbd';
  hg.fillRect(0, 0, 32, 32);
  hg.strokeStyle = '#a0763f';
  hg.lineWidth = 3;
  hg.beginPath();
  hg.moveTo(-8, 40); hg.lineTo(40, -8);
  hg.moveTo(-8, 8); hg.lineTo(8, -8);
  hg.moveTo(24, 40); hg.lineTo(40, 24);
  hg.stroke();
  const hatch = new THREE.CanvasTexture(hc);
  hatch.wrapS = hatch.wrapT = THREE.RepeatWrapping;
  hatch.repeat.set(size / 0.375, size / 0.375);
  hatch.colorSpace = THREE.SRGBColorSpace;
  capMesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({
    map: hatch, side: THREE.DoubleSide,
    stencilWrite: true, stencilRef: 0, stencilFuncMask: 1, stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.ZeroStencilOp, stencilZFail: THREE.ZeroStencilOp, stencilZPass: THREE.ZeroStencilOp,
  }));
  capMesh.renderOrder = 2;
  capMesh.raycast = () => {};
  scene.add(capMesh);
}

function showSectionCaps(on) {
  if (on) ensureSectionCaps();
  stencilHelpers.forEach((h) => { h.visible = on; });
  if (capMesh) capMesh.visible = on;
}

function placeCap() {
  if (!capMesh) return;
  // plane: normal·p + constant = 0 -> the point on it nearest the model center
  const p = clipPlane.projectPoint(modelCenter, new THREE.Vector3());
  capMesh.position.copy(p);
  capMesh.lookAt(p.clone().add(clipPlane.normal));
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
    mat.needsUpdate = true;
  });
  showSectionCaps(on);
  if (on) placeCap();
}

function setWireframe(on) {
  wireOn = on;
  allMaterials().forEach((m) => { m.wireframe = on; });
  $('wireBtn').classList.toggle('on', on);
}

function setExplodePositions(f) {
  meshes.forEach((m) => {
    const { baseCenter, groupCenter } = meshInfo.get(m);
    m.position.copy(groupCenter).sub(modelCenter).multiplyScalar(f)
      .add(baseCenter.clone().sub(groupCenter).multiplyScalar(f * 0.6));
  });
}

function setExplode(f) {
  explode = f;
  setExplodePositions(f);
  $('explodeRange').value = String(f);
  // measurements were taken on the parts' old positions
  if (measure.measurements.length) measure.clear();
  if (current) buildSelectionOverlays();
}

const THEMES = {
  dark: { bg: 0x1b1c1f, grid: [0x444444, 0x2a2a2a] },
  light: { bg: 0xf4f1ec, grid: [0xb5ada0, 0xddd6cb] },
};
function applyTheme() {
  const name = settings().theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = name;
  const t = THEMES[name];
  scene.background = new THREE.Color(t.bg);
  const [c1, c2] = t.grid;
  const colors = grid.geometry.attributes.color;
  // GridHelper bakes its two colours into vertex colours: centre lines first
  const center = new THREE.Color(c1), other = new THREE.Color(c2);
  const n = colors.count, divisions = 24, perLine = 4;
  for (let i = 0; i < n; i++) {
    const line = Math.floor(i / perLine);
    const c = line === divisions / 2 ? center : other;
    colors.setXYZ(i, c.r, c.g, c.b);
  }
  colors.needsUpdate = true;
  $('themeBtn').textContent = name === 'light' ? 'Dark' : 'Light';
}

function applySettingsToScene() {
  applyTheme();
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

// How far back to put the camera so `box`, seen from direction `dir`, fills
// the view with a small margin. Each corner must fit inside the frustum at its
// own depth, so check them individually. `lateral` is the same fit ignoring
// depth - what an orthographic camera needs.
const FIT_MARGIN = 1.2;
function fitDistance(box, dir) {
  const up = Math.abs(dir.y) > 0.99 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(up, dir).normalize();
  const trueUp = new THREE.Vector3().crossVectors(dir, right).normalize();
  const center = box.getCenter(new THREE.Vector3());
  const tanV = Math.tan(THREE.MathUtils.degToRad(perspCamera.fov / 2));
  const tanH = tanV * (perspCamera.aspect || 1);
  let persp = 1, lateral = 1;
  for (let i = 0; i < 8; i++) {
    const c = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center);
    const need = Math.max(Math.abs(c.dot(right)) / tanH, Math.abs(c.dot(trueUp)) / tanV) * FIT_MARGIN;
    lateral = Math.max(lateral, need);
    persp = Math.max(persp, need + c.dot(dir));
  }
  return { persp, lateral };
}

function frameBox(box, dirArr, animate = true) {
  const center = box.getCenter(new THREE.Vector3());
  const dir = dirArr ? new THREE.Vector3(...dirArr).normalize()
    : camera.position.clone().sub(controls.target).normalize();
  const { persp: dist, lateral } = fitDistance(box, dir);
  const toPos = center.clone().addScaledVector(dir, dist);
  // ortho frustum height is derived from the camera distance; zoom corrects
  // it to the depth-independent fit
  const toZoom = dist / lateral;
  if (!animate) {
    camera.position.copy(toPos);
    controls.target.copy(center);
    if (camera.isOrthographicCamera) { camera.zoom = toZoom; updateOrthoFrustum(); }
    controls.update();
    return;
  }
  tween = {
    t0: performance.now(), dur: 380,
    fromPos: camera.position.clone(), toPos,
    fromTarget: controls.target.clone(), toTarget: center,
    fromZoom: camera.zoom, toZoom,
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

// ---------- what touches what (joints, bolt holes) ----------
const contactCache = new Map();
function meshTris(m) {
  const g = m.geometry;
  return g.index ? g.toNonIndexed().attributes.position.array : g.attributes.position.array;
}
function contactsOf(mesh) {
  if (contactCache.has(mesh)) return contactCache.get(mesh);
  const out = new Set();
  const dA = objectDims[mesh.name];
  if (dA) {
    const A = obbFromDims(dA), trisA = meshTris(mesh);
    meshes.forEach((o) => {
      const dB = o !== mesh && objectDims[o.name];
      if (dB && partsTouch(A, trisA, obbFromDims(dB), meshTris(o))) out.add(o);
    });
  }
  contactCache.set(mesh, out);
  return out;
}

// Contacts of one piece of the selected row, grouped by the row they belong to.
function pieceContacts(mesh, row) {
  const byRow = new Map();
  contactsOf(mesh).forEach((o) => {
    const r = rowByMeshName.get(o.name);
    if (!r || r.key === row.key) return;
    byRow.set(r.key, { row: r, n: (byRow.get(r.key)?.n || 0) + 1 });
  });
  return [...byRow.values()].sort((a, b) => a.row.name.localeCompare(b.row.name));
}

function contactHtml(row) {
  const mesh = current.meshes[0];
  if (!mesh) return '';
  const list = pieceContacts(mesh, row);
  const link = ({ row: r, n }) => `<a href="#part=${encodeURIComponent(r.label)}" data-key="${escapeHtml(r.key)}">${escapeHtml(r.name)}</a>${n > 1 ? ` ×${n}` : ''}`;
  const units = settings().units;
  if (isRod(row)) {
    const wood = list.filter((c) => c.row.category === 'Wood');
    return wood.length ? `<div class="card-rel"><b>Bore ⌀${escapeHtml(formatLength(row.dims[1], units))}</b> (plus clearance) through: ${wood.map(link).join(', ')}</div>` : '';
  }
  // Hardware facets (bolt heads, nuts) are one mesh per face; they're listed
  // under the rod they belong to instead.
  const joins = list.filter((c) => c.row.category !== 'Hardware');
  const rods = list.filter((c) => isRod(c.row));
  const parts = [];
  if (joins.length) parts.push(`<div class="card-rel"><b>Joins:</b> ${joins.map(link).join(', ')}</div>`);
  if (rods.length) {
    // one entry per hole size + hardware name, e.g. "4 × ⌀1/2" Threaded Rod 1/2"-13"
    const holes = new Map();
    rods.forEach((c) => {
      const k = `${formatLength(c.row.dims[1], units)}|${c.row.name}`;
      const h = holes.get(k) || { dia: formatLength(c.row.dims[1], units), row: c.row, n: 0 };
      h.n += c.n;
      holes.set(k, h);
    });
    parts.push(`<div class="card-rel"><b>Holes:</b> ${[...holes.values()].map((h) => `${h.n} × ⌀${escapeHtml(h.dia)} for ${link({ row: h.row, n: 1 })}`).join(', ')}</div>`);
  }
  return parts.join('');
}

// Printed drilling list: every rod and the wood parts it passes through.
function drillingHtml() {
  const units = settings().units;
  const items = rows.filter((r) => isRod(r) && r.clickable).map((r) => {
    const mesh = meshByName.get(r.obj_names[0]);
    const wood = mesh ? pieceContacts(mesh, r).filter((c) => c.row.category === 'Wood') : [];
    if (!wood.length) return '';
    const through = wood.map((c) => `${escapeHtml(c.row.name)}${c.n > 1 ? ` ×${c.n}` : ''}`).join(', ');
    return `<tr><td class="ps-chk"><span class="box"></span></td><td><b>${escapeHtml(r.name)}</b> <span class="ps-grp">${escapeHtml(formatLength(r.dims[0], units))} long</span></td>
      <td class="num">${r.count}</td><td>⌀${escapeHtml(formatLength(r.dims[1], units))} + clearance</td><td>${through}</td></tr>`;
  }).join('');
  return items ? `<h2>Holes to drill</h2><table><thead><tr><th class="ps-chk">✓</th><th>For</th><th>Qty</th><th>Hole</th><th>Through (per rod)</th></tr></thead><tbody>${items}</tbody></table>` : '';
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
    ${contactHtml(row)}
    ${notes}
    ${data && row.category === 'Wood' ? '<div class="card-actions"><button class="card-btn" data-act="template" title="Print this part at full size to trace onto your stock">Print full-size template</button></div>' : ''}
  `;
  dimCard.style.display = 'block';
  dimCard.querySelector('.card-close').addEventListener('click', () => clearSelection());
  dimCard.querySelectorAll('.card-rel a').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const r = rows.find((x) => x.key === a.dataset.key);
    if (r) selectRow(r);
  }));
  const tplBtn = dimCard.querySelector('[data-act="template"]');
  if (tplBtn) tplBtn.addEventListener('click', () => printTemplate());
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
renderer.domElement.addEventListener('dblclick', () => { if (current?.box) frameBox(current.box, null); });

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
$('themeBtn').addEventListener('click', () => updateSettings({ theme: settings().theme === 'light' ? 'dark' : 'light' }));
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

// Full-size template of the selected part. Takes over #printSheet for one
// print; the next print goes back to the cut sheet.
let printingTemplate = false;
function prepareTemplate() {
  if (!current) return false;
  const mesh = current.meshes[0];
  const data = mesh && objectDims[mesh.name];
  if (!data) return false;
  $('printSheet').innerHTML = buildTemplate(renderer, mesh, data, current.row.name, settings().units);
  printingTemplate = true;
  return true;
}
function printTemplate() { if (prepareTemplate()) window.print(); }
window.addEventListener('afterprint', () => { printingTemplate = false; });
// A clean overview for the printed sheet: whole model from the 3D preset,
// no highlight/ghosting/labels, on white - independent of the current view.
function captureOverview() {
  const saved = {
    camera, pos: camera.position.clone(), target: controls.target.clone(), zoom: camera.zoom,
    bg: scene.background, current, gizmoVisible: current?.gizmo?.visible,
    size: renderer.getSize(new THREE.Vector2()), aspect: perspCamera.aspect,
  };
  const W = 1800, H = 1200;
  camera = perspCamera;
  controls.object = camera;
  renderer.setSize(W, H, false);
  perspCamera.aspect = W / H;
  perspCamera.updateProjectionMatrix();
  const savedVisible = meshes.map((m) => m.visible);
  const savedExplode = explode, savedWire = wireOn;
  if (current?.gizmo) current.gizmo.visible = false;
  current = null;
  applyMaterials();
  meshes.forEach((m) => { m.visible = true; m.position.set(0, 0, 0); });
  if (savedWire) allMaterials().forEach((m) => { m.wireframe = false; });
  renderer.localClippingEnabled = false; // ignore any section cut
  const capsOn = section.axis !== 'off';
  if (capsOn) showSectionCaps(false);
  grid.visible = false;
  scene.background = new THREE.Color(0xffffff);
  frameBox(modelBox, config.views?.iso?.dir || [0.7, 0.5, 0.7], false);
  let url = null;
  try {
    renderer.render(scene, camera);
    url = cropToContent(renderer.domElement, 24);
  } catch { /* tainted canvas etc. */ }
  scene.background = saved.bg;
  grid.visible = true;
  current = saved.current;
  if (current?.gizmo) current.gizmo.visible = saved.gizmoVisible;
  applyMaterials();
  meshes.forEach((m, i) => { m.visible = savedVisible[i]; });
  renderer.localClippingEnabled = true;
  if (capsOn) showSectionCaps(true);
  if (savedWire) setWireframe(true);
  if (savedExplode) setExplodePositions(savedExplode);
  renderer.setSize(saved.size.x, saved.size.y, false);
  perspCamera.aspect = saved.aspect;
  perspCamera.updateProjectionMatrix();
  camera = saved.camera;
  controls.object = camera;
  camera.position.copy(saved.pos);
  controls.target.copy(saved.target);
  camera.zoom = saved.zoom;
  camera.updateProjectionMatrix();
  controls.update();
  return url;
}

// Copy the just-rendered WebGL canvas and trim the white border around the
// model. Must run in the same task as the render (no preserveDrawingBuffer).
function cropToContent(glCanvas, pad) {
  const w = glCanvas.width, h = glCanvas.height;
  const full = document.createElement('canvas');
  full.width = w; full.height = h;
  const g = full.getContext('2d', { willReadFrequently: true });
  g.drawImage(glCanvas, 0, 0);
  const px = g.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      if (px[i] < 245 || px[i + 1] < 245 || px[i + 2] < 245) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return full.toDataURL('image/png');
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w, x1 + pad); y1 = Math.min(h, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0; out.height = y1 - y0;
  out.getContext('2d').drawImage(full, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

window.addEventListener('beforeprint', () => {
  if (printingTemplate) return;
  const img = model ? captureOverview() : null;
  // print-sized diagrams: 7.5" printable width at 96 css px per inch
  const layouts = computeLayouts(rows);
  const longest = Math.max(...layouts.flatMap((g) => g.boards.map((b) => b.length)), 1);
  const diagrams = layouts.length
    ? `<div class="ps-diagrams"><h2>Shopping list &amp; cutting diagrams</h2>${layoutsHTML(layouts, { pxPerInch: 700 / longest, units: settings().units, colorFor: diagram.colorFor, hardware: rows })}</div>`
    : '';
  buildPrintSheet($('printSheet'), rows, config, img, drillingHtml() + diagrams);
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
    else if (diagram && diagram.isOpen()) diagram.close();
    else if (measure.cancel()) syncToolButtons();
    else clearSelection();
  } else if (k === 'ArrowDown' || k === 'j') { stepSelection(1); e.preventDefault(); }
  else if (k === 'ArrowUp' || k === 'k') { stepSelection(-1); e.preventDefault(); }
  else if (k === 'f') frameBox(focusBox(), null);
  else if (/^[1-9]$/.test(k) && viewKeys[+k - 1]) setView(viewKeys[+k - 1]);
  else if (k === 'o') $('orthoBtn').click();
  else if (k === 'w') setWireframe(!wireOn);
  else if (k === 'l') $('themeBtn').click();
  else if (k === 'i') updateSettings({ isolate: !settings().isolate });
  else if (k === 'e') setExplode(explode > 0 ? 0 : 0.6);
  else if (k === 'd') setTool('distance');
  else if (k === 'a') setTool('angle');
  else if (k === 'b') setTool('bevel');
  else if (k === 'Backspace' || k === 'Delete') { if (measure.undo()) e.preventDefault(); }
  else if (k === '/') { focusSearch(); e.preventDefault(); }
  else if (k === '?') toggleHelp();
  else if (k === 'c' && diagram) (diagram.isOpen() ? diagram.close() : diagram.open());
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
  const el = $('loading');
  el.classList.add('load-error');
  el.innerHTML = location.protocol === 'file:'
    ? 'This page has to be served over HTTP, not opened as a file.<br>In the <code>viewer</code> folder run <code>python3 -m http.server 8743</code> and open <a href="http://localhost:8743">http://localhost:8743</a>.'
    : `Failed to load the model: ${escapeHtml(err.message || String(err))}<br>Is <code>scene.obj</code> next to this page? Regenerate it with <code>parse_dae.py</code>.`;
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
  prepareTemplate,
  contactsOf: (name) => [...contactsOf(meshByName.get(name))].map((m) => m.name),
  endTemplate: () => { printingTemplate = false; },
};
