import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { formatLength, escapeHtml } from './format.js';
import { compoundAngle, describeAngle, round1, DEFAULT_AXIS_NAMES } from './angles.js';
import { initSettings, settings, updateSettings, onSettingsChange, resetSettings } from './settings.js';
import {
  prepareRows, renderCutList, renderRows, markActive, visibleRows, focusSearch, finishedDims, buildPrintSheet, isRod, userNote,
  millingPlanHTML, setCutListRows, inlineEdit, markActiveGroup,
} from './cutlist.js';
import { normalizeEdits, withStatus, withName, withGroupName, withPieceStatus } from './edits.js';
import { initMeasure } from './measure.js';
import { initDiagramModal, computeLayouts, layoutsHTML } from './diagram.js';
import { buildTemplate } from './template.js';
import { initLibrary } from './library.js';
import { getModelFiles, lastOpened, rememberOpened, putModelFile } from './modelstore.js';
import { obbFromDims, partsTouch, findOverlaps } from './geometry.js';

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
controls.enableZoom = true;  // pinch-to-zoom on touch; the mouse wheel is handled below
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
// Registered in the capture phase so it runs before OrbitControls' own wheel
// listener, which it then stops (pinch zoom still goes through OrbitControls).
const ZOOM_STEP = 0.08;
renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  e.stopImmediatePropagation();
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
}, { passive: false, capture: true });

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
let rows = [];          // parts in the build (what the cut list, totals, diagrams and prints use)
let allPartRows = [];   // plus parts set aside or deleted (edits.js)
let rawRows = [];       // parts_report.json as loaded
let edits = normalizeEdits(null);
let modelKey = 'model'; // per-model storage key
let overlaps = [];      // same-size pieces sharing space (geometry.js findOverlaps)
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
let groupSel = null; // a whole assembly group shown from its cut-list heading
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
// Which model to show:
//   ?model=local:<id>          an uploaded model saved in this browser (library.js)
//   ?model=models/workbench/   another model's data files in a folder next to this page
//   ?model=                    the built-in model (this folder)
//   (no ?model)                whatever was opened last, else the built-in one
const MODEL_REF = (() => {
  const params = new URLSearchParams(location.search);
  if (params.has('model')) return params.get('model') || '';
  const last = lastOpened();
  return last && last.startsWith('local:') ? last : '';
})();
const LOCAL_ID = MODEL_REF.startsWith('local:') ? MODEL_REF.slice(6) : null;
const MODEL_BASE = (() => {
  const m = LOCAL_ID ? '' : MODEL_REF;
  if (!m || !/^[\w\-./]+$/.test(m) || m.includes('..') || m.startsWith('/')) return '';
  return m.endsWith('/') ? m : `${m}/`;
})();

const fetchText = (url) => fetch(url).then((r) => {
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
});

// The six data files as text, from the folder or from browser storage.
async function readModelFiles() {
  if (LOCAL_ID) {
    const files = await getModelFiles(LOCAL_ID).catch(() => null);
    if (!files) {
      rememberOpened('');
      const err = new Error('That uploaded model is no longer in this browser. <a href="?model=">Open the built-in model</a>.');
      err.isHtml = true;
      throw err;
    }
    return files;
  }
  const names = ['model.json', 'materials.json', 'object_dims.json', 'parts_report.json', 'scene.mtl', 'scene.obj'];
  const texts = await Promise.all(names.map((n) => (n === 'model.json' ? fetchText(MODEL_BASE + n).catch(() => '{}') : fetchText(MODEL_BASE + n))));
  return Object.fromEntries(names.map((n, i) => [n, texts[i]]));
}

async function init() {
  $('loading').textContent = 'Loading model…';
  const files = await readModelFiles();
  const cfg = JSON.parse(files['model.json'] || '{}');
  const materialNames = JSON.parse(files['materials.json']);
  config = cfg;
  axisNames = { ...DEFAULT_AXIS_NAMES, ...(cfg.axisNames || {}) };
  objectDims = JSON.parse(files['object_dims.json']);
  document.title = `${cfg.title || 'Model'} — Cut List Viewer`;
  // preferences, ticks and notes are kept per model
  modelKey = LOCAL_ID ? `local-${LOCAL_ID}` : (cfg.title || 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  initSettings(modelKey);
  applyTheme();
  rawRows = JSON.parse(files['parts_report.json']);
  edits = loadEdits(cfg);
  overlaps = findOverlaps(objectDims);
  allPartRows = prepareRows(rawRows, cfg, edits);
  addOverlapNotes(allPartRows);
  rows = allPartRows.filter((r) => !r.status);
  allPartRows.forEach((r) => (r.obj_names || []).forEach((n) => rowByMeshName.set(n, r)));

  renderCutList($('sidebar'), allPartRows, cfg, {
    onSelect: (r) => selectRow(r), onPrint: printSheet, onDiagram: () => diagram.open(),
    onLibrary: () => library.open(), onSetup: LOCAL_ID ? () => library.openSetup(LOCAL_ID) : null,
    onSetStatus: setPartStatus, onRenameGroup: renameGroup, onSelectGroup: selectGroup,
  });
  diagram = initDiagramModal({ rows, onSelectRow: (r) => selectRow(r), finishArea: () => (model ? woodSurfaceArea() : 0) });
  buildViewButtons();

  $('loading').textContent = 'Building 3D model…';
  await new Promise((r) => setTimeout(r, 0));
  const mtl = new MTLLoader().parse(files['scene.mtl'], MODEL_BASE);
  mtl.preload();
  model = new OBJLoader().setMaterials(mtl).parse(files['scene.obj']);
  scene.add(model);
  prepareMeshes(materialNames);
  frameBox(modelBox, config.views?.iso?.dir || [0.7, 0.5, 0.7], false);
  $('loading').style.display = 'none';
  rememberOpened(LOCAL_ID ? `local:${LOCAL_ID}` : MODEL_REF);
  applySettingsToScene();
  selectFromHash();
  if (new URLSearchParams(location.search).has('setup') && LOCAL_ID) {
    history.replaceState(null, '', `${location.pathname}?model=${encodeURIComponent(MODEL_REF)}${location.hash}`); // a reload shouldn't reopen it
    library.openSetup(LOCAL_ID);
  }
  else if (!settings().seenIntro) $('introTip').style.display = 'block';
}

// Model library (uploads). Opening a model reloads the page on it, so every
// model starts from a clean scene.
const library = initLibrary({
  current: LOCAL_ID ? `local:${LOCAL_ID}` : '',
  builtIn: { get title() { return builtInTitle; } },
  onOpen: (ref, { setup = false } = {}) => {
    rememberOpened(ref);
    location.href = `${location.pathname}?model=${encodeURIComponent(ref)}${setup ? '&setup=1' : ''}`;
  },
});
let builtInTitle = 'Built-in model';
fetchText('model.json').then((t) => { builtInTitle = JSON.parse(t).title || builtInTitle; }).catch(() => {});

function dismissIntro() {
  if ($('introTip').style.display === 'none') return;
  $('introTip').style.display = 'none';
  updateSettings({ seenIntro: true });
}
$('introClose').addEventListener('click', dismissIntro);

// ---------- your edits: rename, delete, set aside ----------
// Uploaded models keep them inside their own model.json (so Download carries
// them); built-in and folder models keep them in this browser, apart from
// preferences so "reset preferences" doesn't undo them. A model.json may ship
// edits too (e.g. a downloaded model added to the repo).
const editsStorageKey = () => `woodmodels:${modelKey}:edits`;
function loadEdits(cfg) {
  if (!LOCAL_ID) {
    try {
      const saved = JSON.parse(localStorage.getItem(editsStorageKey()) || 'null');
      if (saved) return normalizeEdits(saved);
    } catch { /* storage unavailable */ }
  }
  return normalizeEdits(cfg.edits);
}
function saveEdits() {
  if (LOCAL_ID) {
    config.edits = edits;
    putModelFile(LOCAL_ID, 'model.json', JSON.stringify(config, null, 2))
      .catch((e) => showToast(`Couldn't save your change: ${e.message || e}`));
  } else {
    try { localStorage.setItem(editsStorageKey(), JSON.stringify(edits)); } catch { /* storage unavailable */ }
  }
}
const editHistory = [];
function commitEdits(next, message) {
  editHistory.push(edits);
  if (editHistory.length > 100) editHistory.shift();
  edits = next;
  saveEdits();
  refreshRows();
  if (message) showToast(message, { undo: true });
}
function undoEdit() {
  const prev = editHistory.pop();
  if (!prev) return false;
  edits = prev;
  saveEdits();
  refreshRows();
  showToast('Undone');
  return true;
}
function setPartStatus(list, status) {
  list = list.filter((r) => r.status !== status);
  if (!list.length) return;
  const what = list.length === 1 ? `"${list[0].name}"` : `${list.length} parts`;
  const msg = status === 'deleted' ? `Deleted ${what}` : status === 'aside' ? `Set aside ${what} - not in the build` : `Put ${what} back in the build`;
  // rows split off from single pieces change those pieces; others the whole part
  let next = withStatus(edits, list.filter((r) => !r.pieceStatus).map((r) => ({ ...r, key: r.baseKey })), status);
  const pieces = list.filter((r) => r.pieceStatus).flatMap((r) => r.obj_names);
  if (pieces.length) next = withPieceStatus(next, pieces, status);
  commitEdits(next, msg);
}
// one piece (mesh) of a part that has several
function setPieceStatus(mesh, status) {
  const row = rowByMeshName.get(mesh.name);
  const msg = `${status === 'deleted' ? 'Deleted' : 'Set aside'} one piece of "${row?.name || 'part'}"`;
  commitEdits(withPieceStatus(edits, [mesh.name], status), msg);
}

// Warn on parts with a same-size piece lying in the same space - a copy left
// on top of another, or two boards slid along each other that look like one
// longer board. Notes go on the rows (sidebar and card).
function addOverlapNotes(all) {
  const rowOf = new Map();
  all.forEach((r) => (r.obj_names || []).forEach((n) => rowOf.set(n, r)));
  const units = settings().units;
  overlaps.forEach((o) => {
    const ra = rowOf.get(o.a), rb = rowOf.get(o.b);
    if (!ra || !rb || ra.status || rb.status) return;
    const text = (other) => `Overlaps ${other === ra && ra === rb ? 'another piece of this part' : `"${other.name}"`} by ${formatLength(o.overlap, units)} - two pieces in the same space (together ${formatLength(o.span, units)} long). Probably a copy left in the model, or meant as one longer piece.`;
    [[ra, rb, o.b], [rb, ra, o.a]].forEach(([r, other, otherMesh]) => {
      const t = text(other);
      if (!r.notes.includes(t)) r.notes.push(t);
      r.warn = true;
      (r.overlapPieces = r.overlapPieces || []).push(otherMesh);
    });
  });
}
function renamePart(row, name) { commitEdits(withName(edits, row.key, name), name ? `Renamed to "${name}"` : 'Name reset'); }
function renameGroup(group, name) { commitEdits(withGroupName(edits, group, name), name ? `Group renamed to "${name}"` : 'Group name reset'); }

// Rebuild the rows after an edit, keeping the 3D scene, camera and selection.
function refreshRows() {
  allPartRows = prepareRows(rawRows, config, edits);
  addOverlapNotes(allPartRows);
  rows = allPartRows.filter((r) => !r.status);
  rowByMeshName.clear();
  allPartRows.forEach((r) => (r.obj_names || []).forEach((n) => rowByMeshName.set(n, r)));
  meshes.forEach((m) => { meshInfo.get(m).row = rowByMeshName.get(m.name); });
  setCutListRows(allPartRows);
  diagram.setRows(rows);
  if (diagram.isOpen()) diagram.render();
  if (tagsOn) setTags(true);
  if (current) {
    const row = allPartRows.find((r) => r.key === current.row.key);
    if (!row || row.status === 'deleted') clearSelection();
    else {
      current.row = row;
      // a piece of it may have been deleted or set aside
      current.meshes = row.obj_names.map((n) => meshByName.get(n)).filter(Boolean);
      if (!current.meshes.includes(current.piece)) current.piece = null;
      buildSelectionOverlays();
      markActive(row, false);
    }
  }
  updateModelBox();
  applyMaterials();
  if (groupSel !== null) {
    if (allPartRows.some((r) => r.top_group === groupSel && r.status !== 'deleted')) {
      markActiveGroup(groupSel);
      renderGroupCard(groupBox(groupSel));
    } else clearSelection();
  }
}

// Parts drawn in 3D: not deleted, and set-aside ones only when shown.
function isShownPart(m) {
  const st = meshInfo.get(m)?.row?.status;
  return st !== 'deleted' && (st !== 'aside' || settings().showAside);
}
function updateModelBox() {
  const b = new THREE.Box3();
  meshes.forEach((m) => { if (isShownPart(m)) b.expandByPoint(m.geometry.boundingBox.min).expandByPoint(m.geometry.boundingBox.max); });
  modelBox = b.isEmpty() ? new THREE.Box3().setFromObject(model) : b;
  modelCenter = modelBox.getCenter(new THREE.Vector3());
  if (explode) setExplodePositions(explode);
}

let toastTimer = null;
function showToast(msg, { undo = false } = {}) {
  const el = $('toast');
  el.innerHTML = `<span>${escapeHtml(msg)}</span>${undo ? '<button class="card-btn" data-act="undo" title="Undo (Ctrl+Z)">Undo</button>' : ''}`;
  el.classList.add('show');
  el.querySelector('[data-act="undo"]')?.addEventListener('click', () => undoEdit());
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), undo ? 6000 : 2500);
}

function prepareMeshes(materialNames) {
  model.traverse((child) => {
    if (!child.isMesh) return;
    // parts with SketchUp's default (no) material are configured as "(none)"
    const mtlName = materialNames[child.material && child.material.name];
    const realName = mtlName === 'default' && config.materials?.['(none)'] ? '(none)' : mtlName;
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
    const hlPiece = hl.clone(); // the one piece clicked of a part with several
    hlPiece.emissive = new THREE.Color(0xffb020);
    if (!hlPiece.map) hlPiece.color = new THREE.Color(0xffc266);
    const row = rowByMeshName.get(child.name);
    meshes.push(child);
    meshByName.set(child.name, child);
    child.geometry.computeBoundingBox();
    meshInfo.set(child, { orig, dim, hl, hlPiece, row, baseCenter: child.geometry.boundingBox.getCenter(new THREE.Vector3()) });
  });
  updateModelBox();

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
  meshInfo.forEach(({ orig, dim, hl, hlPiece }) => out.push(orig, dim, hl, hlPiece));
  return out;
}

function applyMaterials() {
  const s = settings();
  const hidden = new Set(s.hiddenCategories);
  const selected = new Set(current ? current.meshes : []);
  meshes.forEach((m) => {
    const info = meshInfo.get(m);
    const catHidden = info.row && hidden.has(info.row.category);
    const inGroup = !current && groupSel !== null && info.row?.top_group === groupSel;
    const isSel = selected.has(m) || inGroup;
    m.visible = isSel || (isShownPart(m) && !catHidden && !(s.isolate && (current || groupSel !== null) && !isSel));
    m.material = !current && groupSel === null ? info.orig : isSel ? (current?.piece === m && current.meshes.length > 1 ? info.hlPiece : info.hl) : info.dim;
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

const singleSidedCache = new WeakMap();
function singleSidedGeometry(geo) {
  if (singleSidedCache.has(geo)) return singleSidedCache.get(geo);
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
  singleSidedCache.set(geo, out);
  return out;
}

// Total wood surface in square inches (one side of each double-sided face),
// for estimating how much finish to buy.
function woodSurfaceArea() {
  let area = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), tri = new THREE.Triangle();
  meshes.forEach((m) => {
    const row = rowByMeshName.get(m.name);
    if (!row || row.category !== 'Wood' || row.status) return;
    const pos = singleSidedGeometry(m.geometry).attributes.position;
    for (let i = 0; i + 2 < pos.count; i += 3) {
      a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
      area += tri.set(a, b, c).getArea();
    }
  });
  return area;
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
  if ('units' in patch || 'showRough' in patch || 'allowance' in patch || 'cut' in patch || 'hiddenCategories' in patch || 'userNotes' in patch || 'showAside' in patch) renderRows();
  if ('showAside' in patch && model) updateModelBox();
  if ('units' in patch && model && overlaps.length) refreshRows(); // overlap notes are written in the units shown
  // typing a note mustn't rebuild the card it's being typed into
  if (Object.keys(patch).every((k) => k === 'userNotes')) return;
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
  if (!row || !row.clickable || !model || row.status === 'deleted') return;
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
  dismissIntro();
  try { history.replaceState(null, '', `#part=${encodeURIComponent(partRef(row))}`); } catch { /* sandboxed */ }
}

function clearSelection({ keepHash = false } = {}) {
  disposeOverlays();
  current = null;
  groupSel = null;
  markActiveGroup(null);
  dimCard.style.display = 'none';
  markActive(null);
  if (model) applyMaterials();
  measure.onSelectionChange();
  if (!keepHash && location.hash) { try { history.replaceState(null, '', location.pathname + location.search); } catch { /* sandboxed */ } }
}

// Link reference for a part: its source label, plus "@n" when several rows
// share a label (same component name at different sizes).
function partRef(row) {
  const same = rows.filter((r) => r.label === row.label);
  return same.length > 1 ? `${row.label}@${same.indexOf(row) + 1}` : row.label;
}

function selectFromHash() {
  const m = /part=([^&]+)/.exec(location.hash);
  if (!m) return;
  const ref = decodeURIComponent(m[1]);
  const row = rows.find((r) => partRef(r) === ref) || rows.find((r) => r.label === ref.replace(/@\d+$/, ''));
  if (row && row.clickable) selectRow(row);
}
window.addEventListener('hashchange', selectFromHash);

function stepSelection(delta) {
  const list = visibleRows().filter((r) => r.clickable);
  if (!list.length) return;
  const i = current ? list.findIndex((r) => r.key === current.row.key) : -1;
  // nothing selected (or selection filtered out): Down starts at the top, Up at the bottom
  const next = i < 0 ? list[delta > 0 ? 0 : list.length - 1] : list[(i + delta + list.length) % list.length];
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
  // Dimension every piece (the pieces in one row share a size to 1/16", but
  // not always their holes and cuts, and a named part can differ slightly);
  // a measurement that differs from the first piece's is flagged. Show the
  // lean on each, since mirrored pairs lean in opposite directions.
  const first = objectDims[current.meshes[0]?.name];
  // (hardware with a hand-written size is stored as one mesh per facet: not versions)
  const variants = current.row.customDims ? [] : pieceVariants(current.meshes);
  current.meshes.forEach((m, i) => {
    const data = objectDims[m.name];
    if (!data || !data.axes) return;
    const sub = new THREE.Group();
    sub.position.copy(m.position); // exploded-view offset
    if (i < MAX_DIMENSIONED) buildDimensionGizmo(sub, data, labelSpecs, m.position, i ? first : null);
    buildAngleGizmo(sub, data, labelSpecs, m.position);
    // several versions of the part: number each piece by its version
    if (variants.length > 1) {
      const v = variants.findIndex((g) => g.meshes.includes(m));
      labelSpecs.push({ pos: new THREE.Vector3(...data.center).add(m.position), text: `${v + 1}`, color: '#f2f2f2', cls: 'version' });
    }
    gizmo.add(sub);
  });
  current.variants = variants;
  scene.add(gizmo);
  current.gizmo = gizmo;
  current.labels = labelSpecs.map((spec) => {
    const el = document.createElement('div');
    el.className = `axisLabel${spec.differs ? ' differs' : ''}${spec.cls ? ` ${spec.cls}` : ''}`;
    el.textContent = spec.text;
    el.style.background = spec.color;
    if (spec.differs) el.title = 'Different from the first piece';
    if (spec.cls === 'version') el.title = `Version ${spec.text} of this part - see the part card`;
    axisLabelsEl.appendChild(el);
    return { pos: spec.pos, el };
  });
  renderDimCard();
}

const MARGIN = 0.6;   // inches, how far the dimension line stands off the part's face
const TICK_LEN = 0.5; // inches, length of the little perpendicular end-ticks

const MAX_DIMENSIONED = 12; // pieces of one row that get dimension lines

// The selected pieces grouped into versions: same size (in the units shown)
// and the same surface area (holes, slots and notches change it).
function pieceVariants(list) {
  const units = settings().units;
  const size = (m) => (objectDims[m.name]?.axes || []).map((a) => formatLength(a.length, units)).join('|');
  const out = [];
  list.forEach((m) => {
    const info = meshInfo.get(m);
    if (info.area === undefined) info.area = meshArea(m);
    const k = size(m);
    const v = out.find((g) => g.size === k && Math.abs(g.area - info.area) <= Math.max(0.25, g.area * 0.002));
    if (v) v.meshes.push(m); else out.push({ size: k, area: info.area, meshes: [m] });
  });
  return out;
}

function meshArea(m) {
  const pos = singleSidedGeometry(m.geometry).attributes.position;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), tri = new THREE.Triangle();
  let area = 0;
  for (let i = 0; i + 2 < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    area += tri.set(a, b, c).getArea();
  }
  return area;
}

// Card lines for a part whose pieces aren't all the same.
function variantsHtml(variants) {
  if (!variants || variants.length < 2) return '';
  const units = settings().units;
  const dimsOf = (g) => {
    const axes = objectDims[g.meshes[0].name]?.axes || [];
    return axes.length === 3 ? [2, 1, 0].map((i) => formatLength(axes[i].length, units)).join(' × ') : '';
  };
  const base = variants[0];
  const items = variants.map((g, i) => {
    const what = i === 0 ? dimsOf(g) : g.size !== base.size ? dimsOf(g) : 'same size, different holes / cuts';
    return `<li><b>${i + 1}</b> ×${g.meshes.length} · ${escapeHtml(what)}</li>`;
  }).join('');
  const n = variants.reduce((k, g) => k + g.meshes.length, 0);
  return `<div class="card-note warn">⚠ These ${n} pieces aren't all identical - ${variants.length} versions (numbered on the model):<ul class="card-variants">${items}</ul></div>`;
}

// ref: the first piece's dimensions, to flag measurements that differ from it
function buildDimensionGizmo(group, data, labelSpecs, offset, ref = null) {
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
    const text = formatLength(axes[i].length, units);
    const differs = !!ref && ref.axes[i] && formatLength(ref.axes[i].length, units) !== text;
    labelSpecs.push({ pos: lineCenter.clone().add(offset), text, color: AXIS_COLORS[axes[i].role], differs });
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

// Hover explanations for the chairmaking terms on the part card.
const TERMS = {
  resultant: 'The single, true angle the part leans away from plumb, combining both directions of lean. Tilt your drill or bevel by this much.',
  sightline: 'The direction the part leans, seen from above. Draw this line on the seat/bench, sight along it, and tilt toward it by the resultant angle.',
  bevel: 'Set a sliding bevel to this angle against the surface to guide the drill or check the joint.',
  components: 'The same lean split into two views: how far it tips seen from the front (one number) and from the side (the other). Some plans give these (rake and splay) instead of resultant + sightline.',
};
const term = (key, text) => `<span class="term" title="${escapeHtml(TERMS[key])}">${text}</span>`;

function angleHtml(data) {
  if (!data) return '';
  const lines = [];
  const L = data.axes.find((a) => a.role === 'Length');
  const lenAng = L && compoundAngle(L.direction, axisNames);
  if (lenAng) {
    lines.push(`<div class="angle-line">∠ ${term('components', escapeHtml(describeAngle(lenAng)))}</div>`);
    const both = lenAng.components.filter((c) => Math.abs(c.deg) >= 0.05);
    if (lenAng.reference === 'plumb' && both.length === 2) {
      // Chairmaker terms for boring a splayed leg mortise.
      const sl = Math.abs(round1(lenAng.sightline));
      lines.push(`<div class="angle-sub">${term('resultant', 'Resultant')} ${round1(lenAng.total)}° along a ${term('sightline', 'sightline')} ${sl}° off the ${escapeHtml(axisNames.x)} line (plan view). ${term('bevel', 'Bevel gauge')}: ${round1(90 - lenAng.total)}° to the surface.</div>`);
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
    if (!r || r.key === row.key || r.status) return; // not deleted / set-aside parts
    byRow.set(r.key, { row: r, n: (byRow.get(r.key)?.n || 0) + 1 });
  });
  return [...byRow.values()].sort((a, b) => a.row.name.localeCompare(b.row.name));
}

function contactHtml(row) {
  const mesh = current.meshes[0];
  if (!mesh) return '';
  const list = pieceContacts(mesh, row);
  const link = ({ row: r, n }) => `<a href="#part=${encodeURIComponent(partRef(r))}" data-key="${escapeHtml(r.key)}">${escapeHtml(r.name)}</a>${n > 1 ? ` ×${n}` : ''}`;
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

// Collapsed = just the name and size (handy on phones, where the card would
// otherwise cover much of the model). Starts collapsed on narrow screens.
let cardCollapsed = window.matchMedia('(max-width: 800px)').matches;

// Show a whole assembly group (e.g. to find which "Group 12" is the hand plane):
// highlighted and framed, with a card to rename, set aside or delete it.
function selectGroup(group) {
  if (!model) return;
  clearSelection();
  groupSel = group;
  markActiveGroup(group);
  applyMaterials();
  const box = groupBox(group);
  if (!box.isEmpty()) frameBox(box, null);
  renderGroupCard(box);
  dismissIntro();
}
function groupBox(group) {
  const box = new THREE.Box3();
  meshes.forEach((m) => { if (meshInfo.get(m).row?.top_group === group && m.visible) box.expandByObject(m); });
  return box;
}

function renderGroupCard(box) {
  const group = groupSel;
  const inGroup = allPartRows.filter((r) => r.top_group === group);
  const active = inGroup.filter((r) => !r.status);
  const aside = inGroup.filter((r) => r.status === 'aside');
  const name = inGroup[0]?.groupName || String(group);
  const size = box.isEmpty() ? null : box.getSize(new THREE.Vector3());
  const units = settings().units;
  const count = (list) => list.reduce((n, r) => n + r.count, 0);
  dimCard.classList.remove('collapsed');
  dimCard.innerHTML = `
    <button class="card-close" title="Clear (Esc)">×</button>
    <div class="part-name"><span class="pn-text">${escapeHtml(name)}</span><button class="pn-edit" title="Rename this group">✎</button></div>
    <div class="meta">Group · ${count(active)} pieces in the build${aside.length ? ` · ${count(aside)} set aside` : ''}</div>
    ${size ? `<div class="meta">Overall ${escapeHtml(formatLength(size.x, units))} × ${escapeHtml(formatLength(size.y, units))} × ${escapeHtml(formatLength(size.z, units))} (outline box)</div>` : ''}
    <div class="card-actions">
      ${active.length ? '<button class="card-btn" data-act="aside" title="Keep the parts and their sizes, but leave them out of the build (e.g. tools drawn on the bench)">Set aside group</button>' : ''}
      ${aside.length ? '<button class="card-btn" data-act="build" title="Put the set-aside parts back in the build">Put back in build</button>' : ''}
      <button class="card-btn danger" data-act="delete" title="Delete the whole group from this model (Del). You can restore it.">Delete group</button>
    </div>`;
  dimCard.style.display = 'block';
  dimCard.querySelector('.card-close').addEventListener('click', () => clearSelection());
  dimCard.querySelector('.pn-edit').addEventListener('click', () => inlineEdit(dimCard.querySelector('.pn-text'), name, (n) => renameGroup(group, n)));
  const act = (a, fn) => dimCard.querySelector(`[data-act="${a}"]`)?.addEventListener('click', fn);
  act('aside', () => setPartStatus(active, 'aside'));
  act('build', () => setPartStatus(aside, null));
  act('delete', () => setPartStatus(inGroup, 'deleted'));
}

function renameSelected() {
  if (!current) return;
  if (cardCollapsed) { cardCollapsed = false; renderDimCard(); }
  const row = current.row;
  inlineEdit(dimCard.querySelector('.pn-text'), row.name, (name) => renamePart(row, name));
}

function renderDimCard() {
  const row = current.row;
  const data = objectDims[current.meshes[0]?.name];
  const notes = row.notes.map((n) => `<div class="card-note${row.warn ? ' warn' : ''}">${row.warn ? '⚠ ' : ''}${escapeHtml(n)}</div>`).join('');
  dimCard.classList.toggle('collapsed', cardCollapsed);
  dimCard.innerHTML = `
    <button class="card-close" title="Clear selection (Esc)">×</button>
    <button class="card-min" title="Show less / more">${cardCollapsed ? '+' : '–'}</button>
    <div class="part-name">${row.letter ? `<span class="letter">${row.letter}</span>` : ''}<span class="pn-text">${escapeHtml(row.name)}</span><button class="pn-edit" title="Rename this part (F2)">✎</button></div>
    ${row.status === 'aside' ? '<div class="card-aside">Set aside - not in the build (not counted in totals, shopping list or prints)</div>' : ''}
    <div class="dim-big">${escapeHtml(finishedDims(row))}</div>
    <div class="dim-axes">${row.customDims ? '' : 'Thickness × Width × Length'}</div>
    ${angleHtml(data)}
    <div class="meta">qty ${row.count} · ${escapeHtml(row.materialLabel)} · ${escapeHtml(row.groupName)}</div>
    ${variantsHtml(current.variants)}
    ${contactHtml(row)}
    ${notes}
    <details class="card-mynote"${userNote(row) ? ' open' : ''}>
      <summary>${userNote(row) ? 'Your note' : 'Add a note'}</summary>
      <textarea rows="2" placeholder="e.g. use the quartersawn offcut; check grain runout">${escapeHtml(userNote(row))}</textarea>
    </details>
    ${row.overlapPieces?.length && !row.status ? '<div class="card-actions"><button class="card-btn danger" data-act="del-overlap" title="Delete the overlapping copy (you can restore it from Deleted)">Delete the overlapping copy</button></div>' : ''}
    ${current.piece && row.count > 1 && !row.pieceStatus && !row.status ? `<div class="card-piece">The piece you clicked:
      <button class="card-btn" data-act="piece-aside" title="Set aside just this piece">Set aside</button>
      <button class="card-btn danger" data-act="piece-delete" title="Delete just this piece, not all ${row.count}">Delete</button></div>` : ''}
    <div class="card-actions">
      ${data && row.category === 'Wood' && !row.status ? '<button class="card-btn" data-act="template" title="Print this part at full size to trace onto your stock">Print full-size template</button>' : ''}
      ${row.status === 'aside'
    ? '<button class="card-btn" data-act="build" title="Put this part back in the build">Put back in build</button>'
    : `<button class="card-btn" data-act="aside" title="Keep it with its sizes, but leave it out of the build: totals, shopping list, prints (e.g. a tool drawn on the bench)">Set aside${row.count > 1 ? ` all ×${row.count}` : ''}</button>`}
      <button class="card-btn danger" data-act="delete" title="Delete from this model: a mistake or junk in the model (Del). You can restore it.">Delete${row.count > 1 ? ` all ×${row.count}` : ''}</button>
    </div>
  `;
  dimCard.style.display = 'block';
  dimCard.querySelector('.card-close').addEventListener('click', () => clearSelection());
  dimCard.querySelector('.card-min').addEventListener('click', () => { cardCollapsed = !cardCollapsed; renderDimCard(); });
  dimCard.querySelectorAll('.card-rel a').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const r = rows.find((x) => x.key === a.dataset.key);
    if (r) selectRow(r);
  }));
  const noteEl = dimCard.querySelector('.card-mynote textarea');
  noteEl.addEventListener('input', () => {
    const notes = { ...(settings().userNotes || {}) };
    if (noteEl.value.trim()) notes[row.key] = noteEl.value; else delete notes[row.key];
    updateSettings({ userNotes: notes });
  });
  noteEl.addEventListener('keydown', (e) => {
    e.stopPropagation(); // don't trigger shortcuts while typing
    if (e.key === 'Escape') noteEl.blur();
  });
  const tplBtn = dimCard.querySelector('[data-act="template"]');
  if (tplBtn) tplBtn.addEventListener('click', () => printTemplate());
  dimCard.querySelector('.pn-edit').addEventListener('click', () => renameSelected());
  dimCard.querySelector('[data-act="aside"]')?.addEventListener('click', () => setPartStatus([row], 'aside'));
  dimCard.querySelector('[data-act="build"]')?.addEventListener('click', () => setPartStatus([row], null));
  dimCard.querySelector('[data-act="delete"]').addEventListener('click', () => setPartStatus([row], 'deleted'));
  dimCard.querySelector('[data-act="piece-aside"]')?.addEventListener('click', () => setPieceStatus(current.piece, 'aside'));
  dimCard.querySelector('[data-act="piece-delete"]')?.addEventListener('click', () => setPieceStatus(current.piece, 'deleted'));
  dimCard.querySelector('[data-act="del-overlap"]')?.addEventListener('click', () => {
    const m = meshByName.get(row.overlapPieces[0]);
    if (m) setPieceStatus(m, 'deleted');
  });
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
  guidePoints: selectionGuidePoints,
  guideAxes: selectionGuideAxes,
  guideEdges: selectionGuideEdges,
});

// Off-mesh snap targets for measuring: corners and edge midpoints of the
// selected part's outline box (the "invisible corner" where a cut-off or
// shaped end would square up).
function selectionGuidePoints() {
  if (!current) return [];
  const out = [];
  current.meshes.forEach((m) => {
    const cs = selectionBoxCorners(m);
    if (!cs) return;
    cs.forEach((p) => out.push({ p, kind: 'corner' }));
    boxEdges(cs).forEach(([a, b]) => out.push({ p: a.clone().lerp(b, 0.5), kind: 'boxmid' }));
  });
  return out;
}

function selectionBoxCorners(m) {
  const d = objectDims[m.name];
  if (!d) return null;
  const b = obbFromDims(d, m.position.toArray());
  const cs = [];
  for (let i = 0; i < 8; i++) {
    const sgn = [i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1];
    const p = new THREE.Vector3(...b.center);
    for (let k = 0; k < 3; k++) p.addScaledVector(new THREE.Vector3(...b.axes[k]), sgn[k] * b.half[k]);
    cs.push(p);
  }
  return cs;
}

// the 12 edges of a box given its 8 corners (indexed by sign bits)
function boxEdges(cs) {
  const out = [];
  for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) if (!(i & bit)) out.push([cs[i], cs[i | bit]]);
  return out;
}

function selectionGuideEdges() {
  if (!current) return [];
  return current.meshes.flatMap((m) => { const cs = selectionBoxCorners(m); return cs ? boxEdges(cs) : []; });
}

// Axis-lock directions: the selected part's own length/width/thickness, then
// level and plumb (skipped where they coincide with a part axis).
function selectionGuideAxes() {
  const axes = [];
  const d = current && objectDims[current.meshes[0]?.name];
  if (d) d.axes.forEach((a) => axes.push({ dir: new THREE.Vector3(...a.direction).normalize(), name: a.role.toLowerCase(), color: AXIS_COLORS[a.role] || '#ffffff' }));
  [
    { dir: new THREE.Vector3(1, 0, 0), name: `level ${axisNames.x}`, color: '#dddddd' },
    { dir: new THREE.Vector3(0, 1, 0), name: 'plumb', color: '#dddddd' },
    { dir: new THREE.Vector3(0, 0, 1), name: `level ${axisNames.z}`, color: '#dddddd' },
  ].forEach((w) => {
    const same = axes.find((a) => Math.abs(a.dir.dot(w.dir)) > 0.9995);
    if (same) same.name += ` (${w.name})`; else axes.push(w);
  });
  return axes;
}

// Browsers still fire "click" after a drag that starts and ends on the canvas,
// so orbiting/panning would deselect the part (or drop a measure point).
// Ignore clicks where the pointer travelled more than a few pixels.
const DRAG_PX = 5;
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; }, true);
function wasDrag(e) {
  const drag = !!downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > DRAG_PX;
  if (e.type === 'click') downAt = null; // one pointerdown per click
  return drag;
}

renderer.domElement.addEventListener('click', (e) => {
  if (!model || wasDrag(e)) return;
  if (measure.handleClick(e)) return;
  const hit = raycastAt(e.clientX, e.clientY, meshes.filter((m) => m.visible));
  if (!hit) { if (current) clearSelection(); return; }
  const row = rowByMeshName.get(hit.object.name);
  if (row && (!current || row.key !== current.row.key)) selectRow(row, { frame: false });
  // remember which of the part's pieces was clicked (to delete just that one)
  if (current && row && row.key === current.row.key && current.piece !== hit.object) {
    current.piece = hit.object;
    applyMaterials();
    renderDimCard();
  }
});
renderer.domElement.addEventListener('dblclick', (e) => { if (current?.box && !wasDrag(e)) frameBox(current.box, null); });

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
  hoverTip.innerHTML = `<b>${row.letter} · ${escapeHtml(row.name)}</b> <span>${escapeHtml(finishedDims(row))}</span>`;
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
$('resetPrefs').addEventListener('click', () => {
  if (!window.confirm('Reset units, allowances, prices, ticked-off parts and your notes for this model?')) return;
  resetSettings();
  location.reload();
});
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
// With `exploded`, parts are pulled apart and tagged with their cut-list
// letters, like a plan's exploded assembly drawing.
function captureOverview({ exploded = 0 } = {}) {
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
  meshes.forEach((m) => { m.visible = !meshInfo.get(m).row?.status; }); // the build: not deleted / set-aside parts
  setExplodePositions(exploded);
  if (savedWire) allMaterials().forEach((m) => { m.wireframe = false; });
  measure.setVisible(false);
  renderer.localClippingEnabled = false; // ignore any section cut
  const capsOn = section.axis !== 'off';
  if (capsOn) showSectionCaps(false);
  grid.visible = false;
  scene.background = new THREE.Color(0xffffff);
  const box = exploded ? meshes.reduce((b, m) => (m.visible ? b.expandByObject(m) : b), new THREE.Box3()) : modelBox;
  frameBox(box, config.views?.iso?.dir || [0.7, 0.5, 0.7], false);
  let url = null;
  try {
    renderer.render(scene, camera);
    url = cropToContent(renderer.domElement, 24, exploded ? drawCallouts : null);
  } catch { /* tainted canvas etc. */ }
  scene.background = saved.bg;
  grid.visible = true;
  current = saved.current;
  if (current?.gizmo) current.gizmo.visible = saved.gizmoVisible;
  applyMaterials();
  meshes.forEach((m, i) => { m.visible = savedVisible[i]; });
  renderer.localClippingEnabled = true;
  measure.setVisible(true);
  if (capsOn) showSectionCaps(true);
  if (savedWire) setWireframe(true);
  setExplodePositions(savedExplode);
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

// Letter callouts drawn straight onto a captured image (HTML tags aren't part
// of the WebGL canvas): one per part type, like a plan's exploded drawing,
// nudged apart so they don't overlap, with a leader line back to the part.
function drawCallouts(g, w, h) {
  const r = Math.round(w / 110);
  const toPx = (v) => {
    const p = v.clone().project(camera);
    return { x: (p.x * 0.5 + 0.5) * w, y: (0.5 - p.y * 0.5) * h };
  };
  const seen = new Set();
  const marks = [];
  meshes.forEach((m) => {
    const row = rowByMeshName.get(m.name);
    const d = objectDims[m.name];
    if (!row || !d || row.customDims || row.status || seen.has(row.key)) return;
    seen.add(row.key);
    const a = toPx(new THREE.Vector3(...d.center).add(m.position));
    marks.push({ letter: row.letter, ax: a.x, ay: a.y, x: a.x, y: a.y });
  });
  // relax overlapping circles apart
  const minD = r * 2.3;
  for (let it = 0; it < 60; it++) {
    let moved = false;
    for (let i = 0; i < marks.length; i++) {
      for (let j = i + 1; j < marks.length; j++) {
        const A = marks[i], B = marks[j];
        let dx = B.x - A.x, dy = B.y - A.y;
        let dist = Math.hypot(dx, dy);
        if (dist >= minD) continue;
        if (dist < 1e-3) { dx = 1; dy = 0; dist = 1; }
        const push = (minD - dist) / 2;
        A.x -= (dx / dist) * push; A.y -= (dy / dist) * push;
        B.x += (dx / dist) * push; B.y += (dy / dist) * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  g.lineWidth = Math.max(1.5, r / 8);
  g.strokeStyle = '#1b1c1f';
  marks.forEach((mk) => {
    if (Math.hypot(mk.x - mk.ax, mk.y - mk.ay) > r) {
      g.beginPath(); g.moveTo(mk.ax, mk.ay); g.lineTo(mk.x, mk.y); g.stroke();
      g.beginPath(); g.arc(mk.ax, mk.ay, g.lineWidth * 1.4, 0, Math.PI * 2); g.fillStyle = '#1b1c1f'; g.fill();
    }
  });
  g.font = `bold ${Math.round(r * 1.2)}px -apple-system, Segoe UI, Arial, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  marks.forEach((mk) => {
    g.beginPath();
    g.arc(mk.x, mk.y, r, 0, Math.PI * 2);
    g.fillStyle = '#ffffff';
    g.fill();
    g.stroke();
    g.fillStyle = '#1b1c1f';
    g.fillText(mk.letter, mk.x, mk.y + 1);
  });
}

// Copy the just-rendered WebGL canvas and trim the white border around the
// model. Must run in the same task as the render (no preserveDrawingBuffer).
function cropToContent(glCanvas, pad, overlay = null) {
  const w = glCanvas.width, h = glCanvas.height;
  const full = document.createElement('canvas');
  full.width = w; full.height = h;
  const g = full.getContext('2d', { willReadFrequently: true });
  g.drawImage(glCanvas, 0, 0);
  if (overlay) overlay(g, w, h);
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
  const img = model ? [captureOverview(), captureOverview({ exploded: 1 })] : null;
  // print-sized diagrams: 7.5" printable width at 96 css px per inch
  const layouts = computeLayouts(rows);
  const longest = Math.max(...layouts.flatMap((g) => g.boards.map((b) => b.length)), 1);
  const diagrams = layouts.length
    ? `<div class="ps-diagrams"><h2>Shopping list &amp; cutting diagrams</h2>${layoutsHTML(layouts, { pxPerInch: 700 / longest, units: settings().units, colorFor: diagram.colorFor, hardware: rows, finishArea: woodSurfaceArea() })}</div>`
    : '';
  const mill = millingPlanHTML(rows);
  buildPrintSheet($('printSheet'), rows, config, img, drillingHtml() + (mill ? `<h2>Milling plan</h2>${mill}` : '') + diagrams);
});

// ---------- part letter tags in 3D ----------
// One tag per part (not per bolt-head facet), at its oriented-box center;
// positions follow the exploded view every frame.
let tagsOn = false;
let tags = [];
function buildTags() {
  $('partTags').innerHTML = '';
  tags = [];
  meshes.forEach((m) => {
    const row = rowByMeshName.get(m.name);
    const d = objectDims[m.name];
    if (!row || !d || row.customDims || row.status) return;
    const el = document.createElement('div');
    el.className = 'partTag';
    el.textContent = row.letter;
    el.title = row.name;
    $('partTags').appendChild(el);
    tags.push({ mesh: m, center: new THREE.Vector3(...d.center), el });
  });
}
function setTags(on) {
  tagsOn = on;
  if (on && !tags.length) buildTags();
  $('partTags').style.display = on ? 'block' : 'none';
  $('tagsBtn').classList.toggle('on', on);
}
function updateTags() {
  if (!tagsOn) return;
  tags.forEach(({ mesh, center, el }) => {
    if (!mesh.visible) { el.style.display = 'none'; return; }
    const s = project(center.clone().add(mesh.position));
    el.style.display = s.behind ? 'none' : 'block';
    el.style.left = `${s.x}px`;
    el.style.top = `${s.y}px`;
    el.classList.toggle('sel', !!current && current.meshes.includes(mesh));
  });
}
$('tagsBtn').addEventListener('click', () => setTags(!tagsOn));

// ---------- keyboard shortcuts ----------
window.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { if (measure.undo() || undoEdit()) e.preventDefault(); }
    return;
  }
  const viewKeys = Object.keys(config.views || {});
  const k = e.key;
  if (k === 'Escape') {
    if ($('help').style.display === 'flex') toggleHelp(false);
    else if (library.isOpen()) { $('library').style.display = 'none'; $('setup').style.display = 'none'; }
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
  else if (k === 't') setTags(!tagsOn);
  else if (k === 'i') updateSettings({ isolate: !settings().isolate });
  else if (k === 'e') setExplode(explode > 0 ? 0 : 0.6);
  else if (k === 'd') setTool('distance');
  else if (k === 'a') setTool('angle');
  else if (k === 'b') setTool('bevel');
  else if (k === 'Backspace' || k === 'Delete') {
    // removes the last measuring point first; otherwise deletes the selected part
    if (measure.undo()) e.preventDefault();
    else if (current && k === 'Delete') { setPartStatus([current.row], 'deleted'); e.preventDefault(); }
    else if (groupSel !== null && k === 'Delete') { setPartStatus(allPartRows.filter((r) => r.top_group === groupSel), 'deleted'); e.preventDefault(); }
  } else if (k === 'F2' && current) { renameSelected(); e.preventDefault(); }
  else if (k === '/') { focusSearch(); e.preventDefault(); }
  else if (k === '?') toggleHelp();
  else if (k === 'c' && diagram) (diagram.isOpen() ? diagram.close() : diagram.open());
  else if (k === 'm') library.open();
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
  updateTags();
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

// Offline support (see sw.js). Only on http(s); a no-op when opened as a file.
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* e.g. private mode */ });
}

init().catch((err) => {
  const el = $('loading');
  el.classList.add('load-error');
  el.innerHTML = location.protocol === 'file:'
    ? 'This page has to be served over HTTP, not opened as a file.<br>In the <code>viewer</code> folder run <code>python3 -m http.server 8743</code> and open <a href="http://localhost:8743">http://localhost:8743</a>.'
    : err.isHtml ? err.message // our own message, with a link
    : LOCAL_ID ? `Couldn't open this uploaded model: ${escapeHtml(err.message || String(err))}`
    : `Failed to load the model: ${escapeHtml(err.message || String(err))}<br>Is <code>scene.obj</code> next to this page? Regenerate it with <code>parse_dae.py</code>.`;
  console.error(err);
});

// Handle for tests/debugging in the console; not used by the app itself.
window.__viewer = {
  THREE, scene, renderer, controls, measure,
  get camera() { return camera; },
  get model() { return model; },
  get current() { return current; },
  get config() { return config; },
  currentSelectionMeshes: () => (current ? current.meshes : []),
  meshesOf: (name) => meshes.filter((m) => meshInfo.get(m).row?.name === name),
  measureClickCount: () => measure.points.length + measure.measurements.length * 2,
  setExplode, setView, selectRow, rows: () => rows,
  prepareTemplate,
  guidePoints: () => selectionGuidePoints(),
  guideAxes: () => selectionGuideAxes(),
  contactsOf: (name) => [...contactsOf(meshByName.get(name))].map((m) => m.name),
  endTemplate: () => { printingTemplate = false; },
};
