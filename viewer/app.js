import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { woodMaterial, addEndGrain, endMapOf, speciesFor, generateGrainUV, photoWood, SPECIES } from './woodtex.js';
import { classifyOverlaps as classifyOverlapsIn, singleSidedGeometry } from './autofix.js';
import { formatLength, escapeHtml, toFraction, isCut, dimensionalSize } from './format.js';
import { compoundAngle, describeAngle, round1, DEFAULT_AXIS_NAMES } from './angles.js';
import { initSettings, settings, updateSettings, onSettingsChange, resetSettings } from './settings.js';
import {
  prepareRows, renderCutList, renderRows, markActive, visibleRows, focusSearch, finishedDims, buildPrintSheet, isRod, userNote,
  millingPlanHTML, setCutListRows, inlineEdit, markActiveGroup, roughDims, roughFor, sheetLayouts,
} from './cutlist.js';
import { buildOrder, withAssemblySteps } from './build.js';
import {
  normalizeEdits, withStatus, withName, withGroupName, withPieceStatus, withJoin, withSplit, withAutoFixes, joinKey,
} from './edits.js';
import { initMeasure } from './measure.js';
import { initDiagramModal, computeLayouts, layoutsHTML, STOCK_DEFAULTS, shoppingText, setSpeciesLookup } from './diagram.js';
import { initShare } from './share.js';
import { buildTemplate } from './template.js';
import { initLibrary, modelZip } from './library.js';
import { getModelFiles, lastOpened, rememberOpened, putModelFile, addPhoto, listPhotos, deletePhoto } from './modelstore.js';
import { obbFromDims, partsTouch, findOverlaps, applyJoins, endJoints } from './geometry.js';
import { glueUpStrips } from './nesting.js';
import { createStage, smoothNormals, orientFaces, materialKind, surfaceMaterial, featureEdges, edgeMaterial } from './look.js';

const $ = (id) => document.getElementById(id);
const viewport = $('viewport');

// ---------- renderer, cameras, controls ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b1c1f);

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // 3x phones: no visible gain for 2.25x the pixels
renderer.localClippingEnabled = true;
viewport.prepend(renderer.domElement); // first, so the HTML overlays paint on top

// Draw only when something may have changed - input, the camera moving, an
// edit - and for a moment after. An idle phone on the bench shouldn't spend
// its battery redrawing the same picture 60 times a second.
let renderUntil = 0;
function requestRender(ms = 500) { renderUntil = Math.max(renderUntil, performance.now() + ms); }
['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'input', 'change', 'click'].forEach((t) => window.addEventListener(t, () => requestRender(), { capture: true, passive: true }));

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
  requestRender();
  renderer.setSize(w, h, false);
  perspCamera.aspect = w / h;
  perspCamera.updateProjectionMatrix();
  updateOrthoFrustum();
  updateFreeArea();
}

// The part of the view the build panel leaves free, where framing centers
// the model - on a phone the panel covers the bottom (or, sideways, the
// right) of the screen. Null: the whole view.
let freeArea = null;
function updateFreeArea() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  const panel = $('buildPanel');
  let f = null;
  if (build && w && h && panel.style.display !== 'none') {
    const v = viewport.getBoundingClientRect(), p = panel.getBoundingClientRect();
    const top = 48; // under the toolbar
    if (p.width > w * 0.6 && p.top - v.top > h * 0.3) f = { x: 0, y: top, w, h: p.top - v.top - top };
    else if (p.height > h * 0.6 && p.left - v.left > w * 0.35) f = { x: 0, y: top, w: p.left - v.left, h: h - top };
  }
  freeArea = f;
  // shift the picture so the view's center sits in the middle of the free part
  [perspCamera, orthoCamera].forEach((c) => {
    if (f) c.setViewOffset(w, h, w / 2 - (f.x + f.w / 2), h / 2 - (f.y + f.h / 2), w, h);
    else if (c.view?.enabled) c.clearViewOffset();
  });
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

// soft studio light for reflections, so finished wood has some life to it
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture;
// lights, ground grid and soft shadows, laid out around whatever model is
// loaded (look.js; the model is exported Y-up, standard three.js convention)
const stage = createStage(scene, renderer);
// every part's outline, SketchUp-style (look.js featureEdges); one material
// for plain parts and one for the highlighted part, recoloured with the theme
const edgeMats = { plain: edgeMaterial(0x000000, 0.4), hl: edgeMaterial(0x5a1a00, 0.55) };

// ---------- state ----------
let config = {};
let axisNames = DEFAULT_AXIS_NAMES;
let objectDims = {};  // safe_name -> { center, axes: [{direction,length,role,label}] }, plus "a+b" for joined pieces
let baseObjectDims = {}; // object_dims.json as loaded
let rows = [];          // parts in the build (what the cut list, totals, diagrams and prints use)
let allPartRows = [];   // plus parts set aside or deleted (edits.js)
let rawRows = [];       // parts_report.json as loaded
let edits = normalizeEdits(null);
let modelKey = 'model'; // per-model storage key
let overlaps = [];      // same-size pieces sharing space (geometry.js findOverlaps)
let overlapKind = new Map(); // "a|b" -> 'join' | 'dupe' | 'lap' | 'unsure' (classifyOverlaps)
let autoFixes = { joins: [], dupes: [] }; // applied as defaults under your edits
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

// ---------- loading ----------
// The wood photos a model comes with (3D Warehouse textures): kept with an
// upload (files.images), or next to scene.obj for a model folder. A photo
// that can't be read just leaves the generated grain.
let woodPhotos = new Map();
async function loadWoodPhotos(cfg, files) {
  const out = new Map();
  const wanted = [...new Set(Object.values(cfg.materials || {}).flatMap((m) => [m.texture?.image, m.photo]).filter(Boolean))];
  await Promise.all(wanted.map(async (name) => {
    try {
      let blob = files.images?.[name] ? new Blob([files.images[name]]) : null;
      if (!blob && !LOCAL_ID) {
        const r = await fetch(MODEL_BASE + name.split('/').map(encodeURIComponent).join('/'));
        if (r.ok) blob = await r.blob();
      }
      if (blob) out.set(name, photoWood(await createImageBitmap(blob), name));
    } catch { /* not an image the browser can read */ }
  }));
  return out;
}
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
  baseObjectDims = objectDims = JSON.parse(files['object_dims.json']);
  document.title = `${cfg.title || 'Model'} — Cut List Viewer`;
  // preferences, ticks and notes are kept per model
  modelKey = LOCAL_ID ? `local-${LOCAL_ID}` : (cfg.title || 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  initSettings(modelKey);
  applyTheme();
  rawRows = JSON.parse(files['parts_report.json']);
  edits = loadEdits(cfg);
  overlaps = findOverlaps(baseObjectDims);
  computeRows();
  rows = allPartRows.filter((r) => !r.status);
  allPartRows.forEach((r) => (r.obj_names || []).forEach((n) => rowByMeshName.set(n, r)));

  renderCutList($('sidebar'), allPartRows, cfg, {
    onSelect: (r) => pickRow(r), onPrint: printSheet, onDiagram: () => diagram.open(),
    onLibrary: () => library.open(), onSetup: LOCAL_ID ? () => library.openSetup(LOCAL_ID) : null,
    onSetStatus: setPartStatus, onRenameGroup: renameGroup, onSelectGroup: selectGroup, onBuild: () => startBuild(),
    onShare: () => share.open(),
  });
  diagram = initDiagramModal({ rows, onSelectRow: (r) => selectRow(r), finishArea: () => (model ? woodSurfaceArea() : 0) });
  // typical prices follow the species picked in Set up (materials are grouped by their label)
  setSpeciesLookup((label) => {
    const hit = Object.entries(cfg.materials || {}).find(([name, m]) => (m.label || name.replace(/^_+/, '')) === label && m.species);
    return hit ? hit[1].species : null;
  });
  buildViewButtons();

  $('loading').textContent = 'Building 3D model…';
  await new Promise((r) => setTimeout(r, 0));
  const mtl = new MTLLoader().parse(files['scene.mtl'], MODEL_BASE);
  mtl.preload();
  model = new OBJLoader().setMaterials(mtl).parse(files['scene.obj']);
  scene.add(model);
  woodPhotos = await loadWoodPhotos(cfg, files);
  prepareMeshes(materialNames);
  if (classifyOverlaps()) refreshRows();
  frameBox(modelBox, config.views?.iso?.dir || [0.7, 0.5, 0.7], false);
  $('loading').style.display = 'none';
  rememberOpened(LOCAL_ID ? `local:${LOCAL_ID}` : MODEL_REF);
  applySettingsToScene();
  announceAutoFixes();
  scheduleModelCheck();
  selectFromHash();
  if (new URLSearchParams(location.search).has('setup') && LOCAL_ID) {
    history.replaceState(null, '', `${location.pathname}?model=${encodeURIComponent(MODEL_REF)}${location.hash}`); // a reload shouldn't reopen it
    library.openSetup(LOCAL_ID);
  }
  else if (!settings().seenIntro && !seenIntroAnywhere()) $('introTip').style.display = 'block';
}

// Share: this model on your phone, the shopping list as text (share.js)
const share = initShare({
  getTitle: () => config.title || 'Project',
  localId: LOCAL_ID,
  shoppingText: () => shoppingText(rows, config.title || 'Project'),
  modelFile: () => modelZip(LOCAL_ID),
  notify: (msg) => showToast(msg),
});

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

// the welcome tips once per browser, not again for every model you upload
const INTRO_KEY = 'woodmodels:seenIntro';
function seenIntroAnywhere() { try { return !!localStorage.getItem(INTRO_KEY); } catch { return false; } }
function dismissIntro() {
  if ($('introTip').style.display === 'none') return;
  $('introTip').style.display = 'none';
  updateSettings({ seenIntro: true });
  try { localStorage.setItem(INTRO_KEY, '1'); } catch { /* storage unavailable */ }
}
$('introClose').addEventListener('click', dismissIntro);

// ---------- your edits: rename, delete, set aside ----------
// Uploaded models keep them inside their own model.json (so Download carries
// them); built-in and folder models keep them in this browser, apart from
// preferences so "reset preferences" doesn't undo them. A model.json may ship
// edits too (e.g. a downloaded model added to the repo).
const editsStorageKey = () => `woodmodels:${modelKey}:edits`;
function loadEdits(cfg) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(editsStorageKey()) || 'null'); } catch { /* storage unavailable */ }
  if (!LOCAL_ID) return normalizeEdits(saved || cfg.edits);
  // uploaded model: its model.json, unless the quick copy below is newer (a
  // reload right after an edit can beat the model's asynchronous save)
  if (saved?.t && saved.t > (cfg.editsSavedAt || 0)) return normalizeEdits(saved.edits);
  return normalizeEdits(cfg.edits);
}
function saveEdits() {
  if (LOCAL_ID) {
    const t = Date.now();
    try { localStorage.setItem(editsStorageKey(), JSON.stringify({ t, edits })); } catch { /* storage unavailable */ }
    config.edits = edits;
    config.editsSavedAt = t;
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
    if (ra.joined && ra.pieces.some((p) => p.includes(o.a) && p.includes(o.b))) return; // already joined
    if (overlapKind.get(`${o.a}|${o.b}`) === 'lap') return; // a lap joint: real joinery
    const text = (other) => `Overlaps ${other === ra && ra === rb ? 'another piece of this part' : `"${other.name}"`} by ${formatLength(o.overlap, units)} - two pieces in the same space (together ${formatLength(o.span, units)} long). Either a copy left in the model, or one ${formatLength(o.span, units)} piece modeled as two.`;
    [[ra, rb, o.b], [rb, ra, o.a]].forEach(([r, other]) => {
      const t = text(other);
      if (!r.notes.includes(t)) r.notes.push(t);
      r.warn = true;
      (r.overlapPairs = r.overlapPairs || []).push(o);
    });
  });
}
function renamePart(row, name) { commitEdits(withName(edits, row.key, name), name ? `Renamed to "${name}"` : 'Name reset'); }
function renameGroup(group, name) { commitEdits(withGroupName(edits, group, name), name ? `Group renamed to "${name}"` : 'Group name reset'); }

// Rebuild the rows after an edit, keeping the 3D scene, camera and selection.
// rows (and joined pieces' dimensions) from the model data, the automatic
// fixes and your edits
function computeRows() {
  const eff = withAutoFixes(edits, autoFixes);
  const j = applyJoins(rawRows, eff.joins, baseObjectDims, toFraction);
  objectDims = j.dims;
  allPartRows = prepareRows(j.rows, config, eff);
  allPartRows.forEach((r) => {
    if (r.joined) r.autoJoined = r.pieces.every((p) => eff.autoJoins.has(joinKey(p)));
    if (r.pieceStatus === 'deleted' && r.obj_names.every((n) => eff.autoDeleted.has(n))) {
      r.autoDeleted = true;
      r.notes.push('An exact copy of another piece, in the same place - removed automatically. Restore it if it is really there twice.');
    }
  });
  addOverlapNotes(allPartRows);
}

// ---------- automatic fixes for rough models (autofix.js) ----------
// Fills overlapKind and autoFixes; true if there's anything to fix.
function classifyOverlaps() {
  ({ kinds: overlapKind, fixes: autoFixes } = classifyOverlapsIn(overlaps, baseObjectDims, (n) => meshByName.get(n)));
  return autoFixes.joins.length + autoFixes.dupes.length > 0;
}

// Say what was fixed automatically, once per model (and after it changes).
function announceAutoFixes() {
  const eff = withAutoFixes(edits, autoFixes);
  const joined = eff.autoJoins.size, dropped = eff.autoDeleted.size;
  if (!joined && !dropped) return;
  const sig = `${joined}|${dropped}|${[...eff.autoJoins].join(',')}`;
  if (settings().autoFixSeen === sig) return;
  updateSettings({ autoFixSeen: sig });
  const parts = [];
  if (joined) parts.push(`joined ${joined} part${joined > 1 ? 's' : ''} the model drew as overlapping boards`);
  if (dropped) parts.push(`removed ${dropped} exact cop${dropped > 1 ? 'ies' : 'y'}`);
  showToast(`Fixed automatically: ${parts.join(', ')}. See the part's card to undo.`, { ms: 9000 });
}

function refreshRows() {
  jointCache.clear(); // parts deleted or set aside no longer take a tenon
  computeRows();
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
  if (build) refreshBuild();
  scheduleModelCheck();
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
  fitStage();
  if (explode) setExplodePositions(explode);
}
// The ground, lights and camera limits follow the model's size: a 6" box
// and a 20' shed both get a grid to scale and room to orbit.
function fitStage() {
  stage.fit(modelBox, config.views?.iso?.dir);
  const R = stage.size;
  controls.maxDistance = Math.max(400, R * 12);
  perspCamera.far = Math.max(2000, R * 40);
  perspCamera.updateProjectionMatrix();
  orthoCamera.near = -Math.max(2000, R * 20);
  orthoCamera.far = Math.max(4000, R * 40);
  orthoCamera.updateProjectionMatrix();
}

let toastTimer = null;
function showToast(msg, { undo = false, ms = 0 } = {}) {
  const el = $('toast');
  el.innerHTML = `<span>${escapeHtml(msg)}</span>${undo ? '<button class="card-btn" data-act="undo" title="Undo (Ctrl+Z)">Undo</button>' : ''}`;
  el.classList.add('show');
  el.querySelector('[data-act="undo"]')?.addEventListener('click', () => undoEdit());
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms || (undo ? 9000 : 3000));
}

function prepareMeshes(materialNames) {
  model.traverse((child) => {
    if (!child.isMesh) return;
    // parts with SketchUp's default (no) material are configured as "(none)"
    const mtlName = materialNames[child.material && child.material.name];
    const realName = mtlName === 'default' && config.materials?.['(none)'] ? '(none)' : mtlName;
    const mc = config.materials?.[realName];
    // not SketchUp's back-to-back faces: turn any face drawn inside-out
    const singleSided = orientFaces(child.geometry);
    if (mc?.texture || mc?.species) {
      // wood: the species set in Set up, else guessed from the material's names
      const seed = [...child.name].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 17);
      generateGrainUV(child.geometry, 6, objectDims[child.name], seed); // on the flat normals: one grain direction per face
      // the model's own photo of the wood, unless you picked how it looks in Set up
      const photo = !mc.species && woodPhotos.get(mc.texture?.image);
      child.material = woodMaterial(mc.species || speciesFor(mc.label, realName), mc.texture, photo || null);
      child.material.color.multiplyScalar(0.9 + 0.14 * (((seed >>> 0) % 97) / 97)); // no two boards quite the same shade
    } else {
      // steel, brass, paint, leather... lit the same way as the wood (look.js)
      const kind = materialKind(mc?.category, mc?.label, realName, rowByMeshName.get(child.name)?.name);
      const name = child.material.name;
      const photo = woodPhotos.get(mc?.photo);
      child.material = surfaceMaterial(kind, photo ? 0xffffff : child.material.color);
      child.material.name = name;
      if (photo) {
        // its own photo (fabric, stone, a textured finish), laid on like the wood's
        generateGrainUV(child.geometry, 6, objectDims[child.name]);
        child.material.map = photo.map;
      }
    }
    smoothNormals(child.geometry); // round parts shade round, square edges stay crisp
    if (singleSided) child.material.side = THREE.DoubleSide; // an open surface still shows from behind
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.BufferAttribute(featureEdges(child.geometry), 3));
    const edges = new THREE.LineSegments(edgeGeo, edgeMats.plain);
    edges.raycast = () => {}; // never picked or measured
    child.add(edges); // follows the part: exploded, hidden, set aside
    child.castShadow = child.receiveShadow = true;
    const orig = child.material;
    const endMap = endMapOf(orig);
    const dim = addEndGrain(orig.clone(), endMap);
    dim.transparent = true;
    dim.opacity = 0.18;
    dim.depthWrite = false;
    const hl = addEndGrain(orig.clone(), endMap);
    hl.emissive = new THREE.Color(0xff5b3d);
    hl.emissiveIntensity = 0.55;
    if (!hl.map) hl.color = new THREE.Color(0xff8a66);
    const hlPiece = addEndGrain(hl.clone(), endMap); // the one piece clicked of a part with several
    hlPiece.emissive = new THREE.Color(0xffb020);
    if (!hlPiece.map) hlPiece.color = new THREE.Color(0xffc266);
    if (orig.metalness) hl.metalness = hlPiece.metalness = 0.2; // a highlighted bolt reads orange, not dark bronze
    const row = rowByMeshName.get(child.name);
    meshes.push(child);
    meshByName.set(child.name, child);
    child.geometry.computeBoundingBox();
    meshInfo.set(child, { orig, dim, hl, hlPiece, row, edges, baseCenter: child.geometry.boundingBox.getCenter(new THREE.Vector3()) });
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
  requestRender();
  const s = settings();
  const hidden = new Set(s.hiddenCategories);
  const selected = new Set(current ? current.meshes : []);
  meshes.forEach((m) => {
    const info = meshInfo.get(m);
    const catHidden = info.row && hidden.has(info.row.category);
    if (build) {
      // build mode: parts from earlier steps solid, this step highlighted, the rest ghosted
      const step = build.stepOf.get(info.row?.key);
      const done = step !== undefined && step < build.i;
      const now = selected.has(m) || (!current && groupSel !== null && info.row?.top_group === groupSel);
      m.visible = now || (isShownPart(m) && !catHidden);
      m.material = now ? info.hl : done ? info.orig : info.dim;
      m.castShadow = !m.material.transparent; // ghosts and glass throw no shadow
      showEdges(m, info);
      return;
    }
    const inGroup = !current && groupSel !== null && info.row?.top_group === groupSel;
    const isSel = selected.has(m) || inGroup;
    m.visible = isSel || (isShownPart(m) && !catHidden && !(s.isolate && (current || groupSel !== null) && !isSel));
    m.material = !current && groupSel === null ? info.orig : isSel ? (current?.piece === m && current.meshes.length > 1 ? info.hlPiece : info.hl) : info.dim;
    m.castShadow = !m.material.transparent;
    showEdges(m, info);
  });
}
// Outlines on solid parts only: a ghosted part is just a hint, and wireframe draws its own
function showEdges(m, info) {
  info.edges.visible = !wireOn && m.material !== info.dim;
  info.edges.material = m.material === info.hl || m.material === info.hlPiece ? edgeMats.hl : edgeMats.plain;
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

// Total wood surface in square inches (one side of each double-sided face),
// for estimating how much finish to buy.
function woodSurfaceArea() {
  let area = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), tri = new THREE.Triangle();
  meshes.forEach((m) => {
    const row = rowByMeshName.get(m.name);
    if (!row || !isCut(row) || row.status) return;
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
  requestRender();
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
    mat.clipShadows = on; // the part cut away throws no shadow either
    mat.needsUpdate = true;
  });
  Object.values(edgeMats).forEach((mat) => { mat.clippingPlanes = on ? [clipPlane] : []; mat.needsUpdate = true; });
  showSectionCaps(on);
  if (on) placeCap();
}

function setWireframe(on) {
  wireOn = on;
  allMaterials().forEach((m) => { m.wireframe = on; });
  $('wireBtn').classList.toggle('on', on);
  if (model) applyMaterials();
}

function setExplodePositions(f) {
  requestRender();
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
  dark: { bg: 0x1b1c1f },
  light: { bg: 0xf4f1ec },
};
function applyTheme() {
  const name = settings().theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = name;
  const t = THEMES[name];
  scene.background = new THREE.Color(t.bg);
  stage.setTheme(name);
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
  requestRender();
  if ('units' in patch || 'showRough' in patch || 'allowance' in patch || 'cut' in patch || 'hiddenCategories' in patch || 'userNotes' in patch || 'showAside' in patch) renderRows();
  if ('showAside' in patch && model) updateModelBox();
  if ('units' in patch && model && overlaps.length) refreshRows(); // overlap notes are written in the units shown
  else if (('units' in patch || 'stock' in patch) && model) scheduleModelCheck();
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
  const full = Math.tan(THREE.MathUtils.degToRad(perspCamera.fov / 2));
  const tanV = full * (freeArea ? freeArea.h / viewport.clientHeight : 1);
  const tanH = full * (perspCamera.aspect || 1) * (freeArea ? freeArea.w / viewport.clientWidth : 1);
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
    current.gizmo.traverse((o) => {
      if (o.userData.shared) return; // an x-ray ghost: the part's own geometry, a shared material
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    current.gizmo = null;
  }
  axisLabelsEl.innerHTML = '';
  current.labels = [];
}

const xrayMaterial = new THREE.MeshBasicMaterial({ color: 0xff7a45, transparent: true, opacity: 0.28, depthTest: false, depthWrite: false });
function buildSelectionOverlays() {
  requestRender();
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
  // x-ray: the part shows faintly through whatever is in front of it (a block
  // set into a top, a tenon inside a leg), following it as it moves (explode)
  current.meshes.forEach((m) => {
    const ghost = new THREE.Mesh(m.geometry, xrayMaterial);
    ghost.matrixAutoUpdate = false;
    ghost.renderOrder = 10;
    ghost.userData.shared = true;
    ghost.onBeforeRender = () => { ghost.matrix.copy(m.matrixWorld); ghost.matrixWorld.copy(m.matrixWorld); };
    gizmo.add(ghost);
  });
  const pieces = rowPieces(current.row);
  const first = objectDims[pieces[0]?.key];
  // (hardware with a hand-written size is stored as one mesh per facet: not versions)
  const variants = current.row.customDims || current.row.joined ? [] : pieceVariants(current.meshes);
  pieces.forEach(({ key, meshes: pm }, i) => {
    const m = pm[0];
    if (!m) return;
    const data = objectDims[key];
    if (!data || !data.axes) return;
    const sub = new THREE.Group();
    sub.position.copy(m.position); // exploded-view offset
    if (i < (current.row.customDims ? 1 : MAX_DIMENSIONED)) buildDimensionGizmo(sub, data, labelSpecs, m.position, i ? first : null);
    if (settings().showPartAngles) buildAngleGizmo(sub, data, labelSpecs, m.position);
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
    return { pos: spec.pos, el, text: spec.text };
  });
  renderDimCard();
}

const MARGIN = 0.6;   // inches, how far the dimension line stands off the part's face
const TICK_LEN = 0.5; // inches, length of the little perpendicular end-ticks

const MAX_DIMENSIONED = 12; // pieces of one row that get dimension lines

// A row's pieces: one mesh each, or several meshes joined into one piece.
function rowPieces(row) {
  if (row.pieces) return row.pieces.map((names) => ({ key: names.join('+'), meshes: names.map((n) => meshByName.get(n)).filter(Boolean) }));
  return (row.obj_names || []).map((n) => ({ key: n, meshes: [meshByName.get(n)].filter(Boolean) }));
}

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

// ---------- joinery: tenons, housed ends, mortises (geometry.js endJoints) ----------
const jointCache = new Map();
function jointsOf(mesh) {
  if (jointCache.has(mesh)) return jointCache.get(mesh);
  let out = [];
  const d = objectDims[mesh.name];
  if (d?.axes?.length === 3) {
    const others = [];
    meshes.forEach((o) => {
      const r = rowByMeshName.get(o.name), dB = objectDims[o.name];
      if (o !== mesh && r && isCut(r) && !r.status && dB) others.push({ name: o.name, box: obbFromDims(dB) });
    });
    out = endJoints(obbFromDims(d), meshTris(mesh), others);
  }
  jointCache.set(mesh, out);
  return out;
}

// What this part's ends go into (and the shoulder-to-shoulder length that
// leaves), the mortises other parts need cut in it, and ends that only meet
// another part (no tenon drawn - add one's length if you'll use it).
function joineryOf(row, mesh) {
  if (!mesh || !isCut(row) || row.joined || row.customDims) return null;
  const rowOf = (name) => rowByMeshName.get(name);
  const js = jointsOf(mesh).filter((j) => rowOf(j.name));
  const cuts = js.filter((j) => j.kind !== 'butt').map((j) => ({ ...j, row: rowOf(j.name) }));
  const length = objectDims[mesh.name].axes[0].length;
  const shoulders = length - cuts.reduce((a, j) => a + j.depth, 0);
  // (almost) all of it inside the parts it joins: a loose tenon, spline or dowel
  const loose = cuts.length === 2 && shoulders < Math.max(1 / 4, length * 0.15);
  const holes = new Map();
  meshes.forEach((o) => {
    const r = rowOf(o.name);
    if (o === mesh || !r || !isCut(r) || r.status || r.joined) return;
    jointsOf(o).forEach((j) => {
      if (j.name !== mesh.name || j.kind === 'butt') return;
      const k = `${Math.round(Math.min(j.width, j.thick) * 64)}|${Math.round(Math.max(j.width, j.thick) * 64)}|${j.through ? 'through' : Math.round(j.depth * 64)}|${r.key}`;
      const h = holes.get(k) || { j, row: r, n: 0 };
      h.n++;
      holes.set(k, h);
    });
  });
  const butts = cuts.length ? [] : [...new Map(js.filter((j) => j.kind === 'butt').map((j) => [rowOf(j.name).key, rowOf(j.name)])).values()];
  const buttEnds = js.filter((j) => j.kind === 'butt').length;
  if (!cuts.length && !holes.size && !butts.length) return null;
  return { cuts, shoulders, loose, holes: [...holes.values()], butts, buttEnds };
}

function joineryText(jy, link, units) {
  const f = (x) => formatLength(x, units);
  const size = (j) => `${f(Math.min(j.width, j.thick))} × ${f(Math.max(j.width, j.thick))}`;
  const out = {};
  if (jy.cuts.length) {
    const texts = jy.cuts.map((j) => `${j.kind === 'tenon' ? `tenon ${size(j)}, ${f(j.depth)} long` : `goes ${f(j.depth)} in`}${j.through ? ` (through${j.proud ? `, ${f(j.proud)} proud` : ''})` : ''} into ${link(j.row)}`);
    const both = texts.length === 2 && texts[0] === texts[1];
    out.ends = `${both ? `${texts[0]}, each end` : texts.join('; ')}. ${jy.loose
      ? 'It sits almost wholly inside the parts it joins, like a loose tenon or dowel.'
      : `The length includes ${jy.cuts.length > 1 ? 'both' : 'it'}: <b>${f(jy.shoulders)}</b> ${jy.cuts.length > 1 ? 'shoulder to shoulder' : 'from the shoulder to the other end'}.`}`;
  }
  if (jy.holes.length) {
    out.holesLabel = jy.holes.some((h) => h.j.kind === 'tenon') ? 'Mortises' : 'Housings';
    out.holes = jy.holes.map(({ j, row: r, n }) => `${size(j)}, ${j.through ? 'through' : `${f(j.depth)} deep`}, for ${link(r)}${n > 1 ? ` (${n})` : ''}`).join('; ');
  }
  if (jy.butts.length) {
    const many = jy.buttEnds > 1;
    out.butt = `${many ? 'Its ends meet' : 'One end meets'} ${jy.butts.map((r) => link(r)).join(', ')} with no tenon drawn. If you'll join ${many ? 'them' : 'it'} with a mortise and tenon, add the tenon's length${many ? ' at each end' : ''} to the cut length.`;
  }
  return out;
}

function joineryHtml(row, mesh) {
  const jy = joineryOf(row, mesh);
  if (!jy) return '';
  const link = (r) => `<a href="#part=${encodeURIComponent(partRef(r))}" data-key="${escapeHtml(r.key)}">${escapeHtml(r.name)}</a>`;
  const t = joineryText(jy, link, settings().units);
  return [
    t.ends && `<div class="card-rel card-joinery"><b>Joinery:</b> ${t.ends}</div>`,
    t.holes && `<div class="card-rel card-joinery"><b>${t.holesLabel}:</b> ${t.holes}</div>`,
    t.butt && `<div class="card-note">${t.butt}</div>`,
  ].filter(Boolean).join('');
}

// For the printed sheet: every part with joinery drawn in the model.
function joineryPrintHtml() {
  const units = settings().units;
  const name = (r) => `${r.letter ? `${r.letter} ` : ''}${escapeHtml(r.name)}`;
  const lines = rows.filter((r) => isCut(r) && r.clickable).map((r) => {
    const mesh = meshByName.get(r.obj_names[0]);
    const jy = mesh && joineryOf(r, mesh);
    if (!jy || (!jy.cuts.length && !jy.holes.length)) return '';
    const t = joineryText(jy, name, units);
    return `<tr><td><b>${name(r)}</b></td><td>${[t.ends, t.holes && `${t.holesLabel}: ${t.holes}`].filter(Boolean).join('<br>')}</td></tr>`;
  }).filter(Boolean);
  return lines.length ? `<h2>Joinery</h2><table class="ps-table ps-joinery"><tbody>${lines.join('')}</tbody></table>` : '';
}

// "2×4" when a wood part is a dimensional-lumber size (buy it, no milling) -
// construction lumber is softwood: a 3/4" x 3-1/2" walnut rail isn't a 1x4
const SOFTWOODS = new Set(['pine', 'larch', 'fir', 'cedar']);
function stdSize(row) {
  if (row.category !== 'Wood' || row.customDims || row.dims?.length !== 3) return null;
  const mc = config.materials?.[row.material] || {};
  if (mc.species === 'hardwood') return null;
  const sp = SPECIES[mc.species] ? mc.species : speciesFor(row.materialLabel, row.material);
  if (sp && !SOFTWOODS.has(sp)) return null;
  return dimensionalSize(row.dims[2], row.dims[1]);
}

// ---------- model check: things in a downloaded model worth a look ----------
// Wood that touches nothing (a leftover, or drawn in the wrong place), parts
// drawn as a flat face (no thickness to cut), pieces still overlapping, and
// parts wider than your boards (glue-ups), each with a link to the part.
let checkOpen = false;
function modelCheckItems() {
  const units = settings().units, f = (x) => formatLength(x, units);
  const stockW = { ...STOCK_DEFAULTS, ...(settings().stock || {}) }.width;
  const items = [];
  rows.filter((r) => isCut(r) && r.clickable).forEach((r) => {
    const pieces = r.obj_names.map((n) => meshByName.get(n)).filter(Boolean);
    if (r.dims[2] < 1 / 32) items.push({ kind: 'Flat', row: r, text: 'is drawn as a flat face with no thickness: nothing to cut. Delete it, or set it aside if it\'s a guide.' });
    else if (pieces.length && pieces.every((m) => ![...contactsOf(m)].some((o) => { const or = rowByMeshName.get(o.name); return or && !or.status; }))) {
      items.push({ kind: 'Floating', row: r, text: `touches no other part${r.count > 1 ? ' (none of its pieces)' : ''}: a leftover, or drawn in the wrong place?` });
    }
    if (r.overlapPairs?.length) items.push({ kind: 'Overlap', row: r, text: 'has a piece overlapping another: a copy, or one piece drawn as two (see its card).' });
    const roughW = r.category === 'Wood' ? (roughFor(r)?.width || r.dims[1]) : 0;
    if (roughW && r.dims[1] > stockW + 1 / 32) {
      const glue = glueUpStrips(roughW, stockW);
      items.push({ kind: 'Glue-up', row: r, info: true, text: glue
        ? `is ${f(r.dims[1])} wide: glue it up from ${glue.n} strips of your ${f(stockW)} boards${r.count > 1 ? `, for each of ${r.count}` : ''} (laid out that way in the cutting diagram).`
        : `is ${f(r.dims[1])} wide, just over your ${f(stockW)} boards: buy a wider board, or glue it up from 2.` });
    }
  });
  return items;
}
// It measures what touches what, all parts against all: once the model is on
// screen, not before (a big model on a phone). The results are cached, so
// after an edit it's quick.
let checkPending = false;
function scheduleModelCheck() {
  if (checkPending || !$('clCheck')) return;
  checkPending = true;
  if (!$('clCheck').textContent) $('clCheck').innerHTML = '<div class="model-check ok">Model check: checking…</div>';
  const later = window.requestIdleCallback ? (f) => window.requestIdleCallback(f, { timeout: 1500 }) : (f) => setTimeout(f, 200);
  later(() => { checkPending = false; renderModelCheck(); });
}
function renderModelCheck() {
  const el = $('clCheck');
  if (!el || !model) return;
  const items = modelCheckItems();
  const problems = items.filter((i) => !i.info).length, info = items.length - problems;
  if (!items.length) { el.innerHTML = '<div class="model-check ok">✓ Model check: every part touches another, nothing overlaps, no paper-thin parts.</div>'; return; }
  const title = [problems && `${problems} thing${problems > 1 ? 's' : ''} to look at`, info && `${info} glue-up${info > 1 ? 's' : ''}`].filter(Boolean).join(' · ');
  el.innerHTML = `<details class="model-check${problems ? ' warn' : ''}"${checkOpen ? ' open' : ''}><summary>${problems ? '⚠' : 'ℹ'} Model check: ${title}</summary><ul>${items.map((i) => `<li><span class="mc-kind">${i.kind}</span> <a href="#" data-key="${escapeHtml(i.row.key)}">${i.row.letter ? `${i.row.letter} ` : ''}${escapeHtml(i.row.name)}</a> ${escapeHtml(i.text)}</li>`).join('')}</ul></details>`;
  el.querySelector('details').addEventListener('toggle', (e) => { checkOpen = e.target.open; });
  el.querySelectorAll('a[data-key]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const r = rows.find((x) => x.key === a.dataset.key);
    if (r) pickRow(r);
  }));
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
    const wood = list.filter((c) => isCut(c.row));
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
    const wood = mesh ? pieceContacts(mesh, r).filter((c) => isCut(c.row)) : [];
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
function selectGroup(group, { frame = true } = {}) {
  if (!model) return;
  clearSelection();
  groupSel = group;
  markActiveGroup(group);
  applyMaterials();
  const box = groupBox(group);
  if (frame && !box.isEmpty()) frameBox(box, null);
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

// one geometry holding several (non-indexed OBJ) geometries' triangles
function mergePositions(geos) {
  const arrays = geos.map((g) => g.attributes.position.array);
  const out = new Float32Array(arrays.reduce((n, a) => n + a.length, 0));
  let o = 0;
  arrays.forEach((a) => { out.set(a, o); o += a.length; });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  return g;
}

// ---------- build mode ----------
// A step-by-step guide for the shop (build.js orders the parts): one part per
// step, big, with its size, rough stock, joins and notes and a "cut" tick; the
// model assembles as you go.
let build = null; // { order: rows, stepOf: key -> index, i }

function buildSteps() {
  const boxOf = (r) => {
    const box = new THREE.Box3();
    (r.obj_names || []).forEach((n) => { const m = meshByName.get(n); if (m) box.expandByObject(m); });
    if (box.isEmpty()) return null;
    const sz = box.getSize(new THREE.Vector3());
    return { minY: box.min.y, volume: sz.x * sz.y * sz.z };
  };
  const order = buildOrder(rows.filter((r) => r.clickable), boxOf, settings().buildOrder, (r) => roughFor(r)?.thickness || r.dims[2]);
  return settings().buildOrder === 'cutting' ? order : withAssemblySteps(order);
}
const buildState = (order, i) => ({ order, stepOf: new Map(order.map((r, k) => [r.key, k])), i });

// Keep the screen on while building: a phone propped up on the bench
// shouldn't go dark between cuts. (The lock drops when the tab is hidden.)
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) await wakeLock.release();
  } catch { /* not allowed (e.g. battery saver): the screen sleeps as usual */ }
}
document.addEventListener('visibilitychange', () => { if (build) keepAwake(true); });

function startBuild() {
  if (!model) return;
  const order = buildSteps();
  if (!order.length) return;
  build = buildState(order, Math.max(0, order.findIndex((r) => r.key === settings().buildStep)));
  keepAwake(true);
  document.body.classList.add('build-mode');
  measure.cancel();
  syncToolButtons();
  dismissIntro();
  showStep(true);
}

// after an edit (renamed, deleted, set aside): fresh steps, same part if it's still there
function refreshBuild() {
  const order = buildSteps();
  if (!order.length) { exitBuild(); return; }
  const k = order.findIndex((r) => r.key === build.order[build.i].key);
  build = buildState(order, k >= 0 ? k : Math.min(build.i, order.length - 1));
  if (k >= 0 && current) renderBuildPanel(); else showStep(true);
}

// a part picked in the list: in build mode, go to its step
function pickRow(r) {
  const k = build ? build.order.findIndex((x) => x.key === r.key) : -1;
  if (k >= 0) { build.i = k; showStep(true); } else selectRow(r);
}

function exitBuild() {
  build = null;
  keepAwake(false);
  toggleVoice(false);
  document.body.classList.remove('build-mode');
  $('buildPanel').style.display = 'none';
  updateFreeArea();
  clearSelection();
  frameBox(focusBox(), null);
}

// A small part (a key, a dog block) framed on its own fills the screen with
// no sign of where it goes: frame at least a foot around it.
const CONTEXT_SIZE = 12;
function withContext(box) {
  const size = box.getSize(new THREE.Vector3());
  const grow = new THREE.Vector3(...[size.x, size.y, size.z].map((d) => Math.max(0, CONTEXT_SIZE - d) / 2));
  return box.clone().expandByVector(grow);
}

function stepBuild(delta) {
  if (!build) return;
  build.i = Math.min(build.order.length - 1, Math.max(0, build.i + delta));
  showStep(true);
}

function showStep(frame) {
  const step = build.order[build.i];
  if (step.assemble) selectGroup(step.group, { frame: false }); else selectRow(step, { frame: false });
  updateSettings({ buildStep: step.key });
  renderBuildPanel();
  // frame once the panel is up: its height changes with the step
  updateFreeArea();
  const box = step.assemble ? groupBox(step.group) : current?.box;
  if (frame && box && !box.isEmpty()) frameBox(withContext(box), null);
}

function partStepHtml(row, units) {
  const rough = row.category === 'Wood' ? roughDims(row, units) : '';
  const mine = userNote(row);
  return `
    <div class="bp-name"><span class="letter">${row.letter}</span>${escapeHtml(row.name)} <span class="bp-qty">×${row.count}</span></div>
    <div class="bp-size">${escapeHtml(finishedDims(row, units))}</div>
    <div class="bp-sub">${row.customDims ? '' : 'Thickness × Width × Length'}${stdSize(row) ? ` · a standard <b>${stdSize(row)}</b>` : rough ? ` · rough <b>${escapeHtml(rough)}</b>` : ''} · ${escapeHtml(row.materialLabel)}</div>
    ${contactHtml(row)}
    ${joineryHtml(row, current?.meshes[0])}
    ${row.notes.map((t) => `<div class="card-note${row.warn ? ' warn' : ''}">${escapeHtml(t)}</div>`).join('')}
    ${mine ? `<div class="card-note mine">✎ ${escapeHtml(mine)}</div>` : ''}`;
}

// A sub-assembly's parts are all cut: put it together.
function assembleStepHtml(step) {
  const link = (r) => `<a href="#part=${encodeURIComponent(partRef(r))}" data-key="${escapeHtml(r.key)}">${r.letter ? `${r.letter} ` : ''}${escapeHtml(r.name)}</a>${r.count > 1 ? ` ×${r.count}` : ''}`;
  const wood = step.rows.filter(isCut), hardware = step.rows.filter((r) => !isCut(r));
  return `
    <div class="bp-name">Assemble ${escapeHtml(step.groupName)}</div>
    <div class="card-rel"><b>Parts:</b> ${wood.map(link).join(', ')}</div>
    ${hardware.length ? `<div class="card-rel"><b>Hardware:</b> ${hardware.map(link).join(', ')}</div>` : ''}
    <ol class="bp-assemble">
      <li><b>Dry-fit</b> it all first: every joint closes, nothing binds.</li>
      <li>Check it's <b>square</b>: the diagonals measure the same.</li>
      <li>Mark the parts so they go back the same way, take it apart, then <b>glue and clamp</b>${hardware.length ? ' and fit the hardware' : ''}. Check square again before the glue sets.</li>
    </ol>`;
}

// Tick the step off (a part cut, an assembly done) and move on to the next.
function setStepDone(on) {
  const key = build.order[build.i].key;
  const next = new Set(settings().cut);
  if (on) next.add(key); else next.delete(key);
  updateSettings({ cut: [...next] });
  if (on && build.i < build.order.length - 1) setTimeout(() => stepBuild(1), 250);
  else renderBuildPanel();
}

// ---- hands-free: say "next", "back" or "done" (where the browser can listen) ----
const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
let voice = null;
function toggleVoice(on = !voice) {
  if (!on) {
    const rec = voice;
    voice = null;
    rec?.stop();
    if (build) renderBuildPanel();
    return;
  }
  if (!Speech || voice) return;
  const rec = new Speech();
  rec.continuous = true;
  rec.interimResults = false;
  rec.lang = navigator.language || 'en-US';
  rec.onresult = (e) => {
    const said = e.results[e.results.length - 1][0].transcript.toLowerCase();
    if (!build) return;
    if (/\b(next|forward|go on)\b/.test(said)) stepBuild(1);
    else if (/\b(back|previous|go back)\b/.test(said)) stepBuild(-1);
    else if (/\b(done|finished|cut|check)\b/.test(said)) setStepDone(true);
  };
  // browsers stop listening after a while: keep going until it's turned off
  rec.onend = () => { if (voice === rec) { try { rec.start(); } catch { /* already started */ } } };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      showToast('The microphone is blocked for this page - allow it in the browser\'s site settings to use voice.');
      toggleVoice(false);
    }
  };
  voice = rec;
  try { rec.start(); } catch { voice = null; }
  renderBuildPanel();
}

// ---- build log: photos per step (IndexedDB, modelstore.js) ----
async function shrinkPhoto(file) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob((b) => r(b || file), 'image/jpeg', 0.82));
  } catch { return file; } // e.g. a format the browser can't decode: keep it as is
}
let photoUrls = [];
async function showStepPhotos(stepKey) {
  let photos = [];
  try { photos = await listPhotos(modelKey, stepKey); } catch { /* storage unavailable */ }
  const box = $('buildPanel').querySelector('.bp-photos');
  if (!build || build.order[build.i]?.key !== stepKey || !box) return; // moved on meanwhile
  photoUrls.forEach((u) => URL.revokeObjectURL(u));
  photoUrls = photos.map((p) => URL.createObjectURL(p.blob));
  box.querySelectorAll('.bp-thumb').forEach((t) => t.remove());
  photos.forEach((p, i) => {
    const img = document.createElement('img');
    img.className = 'bp-thumb';
    img.src = photoUrls[i];
    img.alt = 'Build photo';
    img.addEventListener('click', () => showPhoto(photoUrls[i], p.key, stepKey));
    box.insertBefore(img, box.querySelector('.bp-photo-add'));
  });
}
function showPhoto(url, key, stepKey) {
  const view = $('photoView');
  view.querySelector('img').src = url;
  view.style.display = 'flex';
  view.querySelector('.pv-delete').onclick = async (e) => {
    e.stopPropagation();
    await deletePhoto(key).catch(() => {});
    view.style.display = 'none';
    showStepPhotos(stepKey);
  };
}
$('photoView').addEventListener('click', () => { $('photoView').style.display = 'none'; });

// swipe the step panel sideways to step through (phones)
let swipe = null;
$('buildPanel').addEventListener('pointerdown', (e) => { swipe = e.pointerType === 'touch' ? { x: e.clientX, y: e.clientY } : null; });
$('buildPanel').addEventListener('pointerup', (e) => {
  if (!swipe || !build) return;
  const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
  swipe = null;
  if (Math.abs(dx) > 70 && Math.abs(dy) < 45) stepBuild(dx < 0 ? 1 : -1);
});

function renderBuildPanel() {
  const el = $('buildPanel');
  const row = build.order[build.i];
  const units = settings().units;
  const cutSet = new Set(settings().cut);
  const n = build.order.length;
  el.innerHTML = `
    <div class="bp-top">
      <select class="bp-steps" title="Jump to a step">${build.order.map((r, k) => `<option value="${k}"${k === build.i ? ' selected' : ''}>${k + 1}. ${escapeHtml(r.letter)} ${escapeHtml(r.name)}${cutSet.has(r.key) ? ' ✓' : ''}</option>`).join('')}</select>
      <span class="bp-of">of ${n} · ${escapeHtml(row.groupName)}</span>
      <button class="bp-order card-btn" title="Step through the parts in assembly order (ground up) or cutting order (by species and stock thickness)">${settings().buildOrder === 'cutting' ? 'Cutting order' : 'Assembly order'}</button>
      ${Speech ? `<button class="bp-voice card-btn${voice ? ' on' : ''}" title="Hands-free: say &quot;next&quot;, &quot;back&quot; or &quot;done&quot;">${voice ? '🎤 Listening' : '🎤'}</button>` : ''}
      <button class="bp-exit card-btn" title="Leave build mode (Esc)">Exit</button>
    </div>
    <div class="bp-progress"><div style="width:${Math.round(((build.i + 1) / n) * 100)}%"></div></div>
    ${row.assemble ? assembleStepHtml(row) : partStepHtml(row, units)}
    <div class="bp-photos"><label class="card-btn bp-photo-add" title="Take a picture of this step for your build log">📷 Photo<input type="file" accept="image/*" capture="environment" hidden /></label></div>
    <div class="bp-nav">
      <button class="bp-prev" ${build.i === 0 ? 'disabled' : ''}>◀ Back</button>
      <label class="bp-cut"><input type="checkbox" ${cutSet.has(row.key) ? 'checked' : ''} /> ${!row.assemble && isCut(row) ? 'Cut' : 'Done'}</label>
      <button class="bp-next" ${build.i === n - 1 ? 'disabled' : ''}>Next ▶</button>
    </div>`;
  el.style.display = 'block';
  el.querySelector('.bp-exit').addEventListener('click', () => exitBuild());
  el.querySelector('.bp-order').addEventListener('click', () => {
    updateSettings({ buildOrder: settings().buildOrder === 'cutting' ? 'assembly' : 'cutting' });
    startBuild(); // same part, new order
  });
  el.querySelector('.bp-prev').addEventListener('click', () => stepBuild(-1));
  el.querySelector('.bp-next').addEventListener('click', () => stepBuild(1));
  el.querySelector('.bp-steps').addEventListener('change', (e) => { build.i = +e.target.value; showStep(true); });
  el.querySelector('.bp-cut input').addEventListener('change', (e) => setStepDone(e.target.checked));
  el.querySelector('.bp-voice')?.addEventListener('click', () => toggleVoice());
  el.querySelector('.bp-photo-add input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await addPhoto(modelKey, row.key, await shrinkPhoto(file));
    } catch (err) { showToast(`Couldn't save the photo: ${err.message || err}`); }
    showStepPhotos(row.key);
  });
  showStepPhotos(row.key);
  el.querySelectorAll('.card-rel a, .card-note a').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const k = build.order.findIndex((r) => r.key === a.dataset.key);
    if (k >= 0) { build.i = k; showStep(true); }
  }));
}

function renameSelected() {
  if (!current) return;
  if (cardCollapsed) { cardCollapsed = false; renderDimCard(); }
  const row = current.row;
  inlineEdit(dimCard.querySelector('.pn-text'), row.name, (name) => renamePart(row, name));
}

function renderDimCard() {
  const row = current.row;
  const data = objectDims[rowPieces(current.row)[0]?.key];
  const notes = row.notes.map((n) => `<div class="card-note${row.warn ? ' warn' : ''}">${row.warn ? '⚠ ' : ''}${escapeHtml(n)}</div>`).join('');
  dimCard.classList.toggle('collapsed', cardCollapsed);
  dimCard.innerHTML = `
    <button class="card-close" title="Clear selection (Esc)">×</button>
    <button class="card-min" title="Show less / more">${cardCollapsed ? '+' : '–'}</button>
    <div class="part-name">${row.letter ? `<span class="letter">${row.letter}</span>` : ''}<span class="pn-text">${escapeHtml(row.name)}</span><button class="pn-edit" title="Rename this part (F2)">✎</button></div>
    ${row.status === 'aside' ? '<div class="card-aside">Set aside - not in the build (not counted in totals, shopping list or prints)</div>' : ''}
    <div class="dim-big">${escapeHtml(finishedDims(row))}</div>
    <div class="dim-axes">${row.customDims ? '' : 'Thickness × Width × Length'}${stdSize(row) ? ` · <span class="card-std" title="Dimensional lumber: buy it surfaced to this size, no milling">a standard ${stdSize(row)}</span>` : ''}</div>
    ${settings().showPartAngles ? angleHtml(data) : ''}
    ${angleHtml(data) ? `<button class="card-btn angle-toggle" data-act="angles" title="The part's lean / splay angles, worked out from the model">${settings().showPartAngles ? 'Hide angles' : '∠ Show angles'}</button>` : ''}
    <div class="meta">qty ${row.count} · ${escapeHtml(row.materialLabel)} · ${escapeHtml(row.groupName)}</div>
    ${variantsHtml(current.variants)}
    ${contactHtml(row)}
    ${joineryHtml(row, current.piece || current.meshes[0])}
    ${notes}
    <details class="card-mynote"${userNote(row) ? ' open' : ''}>
      <summary>${userNote(row) ? 'Your note' : 'Add a note'}</summary>
      <textarea rows="2" placeholder="e.g. use the quartersawn offcut; check grain runout">${escapeHtml(userNote(row))}</textarea>
    </details>
    ${row.overlapPairs?.length && !row.status ? `<div class="card-actions">
      <button class="card-btn" data-act="join-overlap" title="They're one longer piece: measure them end to end as one part">Join into one ${escapeHtml(formatLength(row.overlapPairs[0].span, settings().units))} piece</button>
      <button class="card-btn danger" data-act="del-overlap" title="It's a copy left in the model: delete it (you can restore it from Deleted)">Delete the overlapping copy</button></div>` : ''}
    ${row.joined ? `<div class="card-note">${row.autoJoined ? 'Joined automatically: the model draws this' : 'Joined from'} as ${row.pieces[0].length} overlapping boards; measured end to end as one piece. <button class="card-btn" data-act="split" title="Undo the join">Split ${row.count > 1 ? `all ×${row.count} ` : ''}apart</button></div>` : ''}
    ${current.piece && row.count > 1 && !row.pieceStatus && !row.status && !row.joined ? `<div class="card-piece">The piece you clicked:
      <button class="card-btn" data-act="piece-aside" title="Set aside just this piece">Set aside</button>
      <button class="card-btn danger" data-act="piece-delete" title="Delete just this piece, not all ${row.count}">Delete</button></div>` : ''}
    <div class="card-actions">
      ${data && isCut(row) && !row.status ? '<button class="card-btn" data-act="template" title="Print this part at full size to trace onto your stock">Print full-size template</button>' : ''}
      ${row.status === 'aside'
    ? '<button class="card-btn" data-act="build" title="Put this part back in the build">Put back in build</button>'
    : `<button class="card-btn" data-act="aside" title="Keep it with its sizes, but leave it out of the build: totals, shopping list, prints (e.g. a tool drawn on the bench)">Set aside${row.count > 1 ? ` all ×${row.count}` : ''}</button>`}
      <button class="card-btn danger" data-act="delete" title="Delete from this model: a mistake or junk in the model (Del). You can restore it.">Delete${row.count > 1 ? ` all ×${row.count}` : ''}</button>
    </div>
  `;
  dimCard.style.display = 'block';
  dimCard.querySelector('.card-close').addEventListener('click', () => clearSelection());
  dimCard.querySelector('.card-min').addEventListener('click', () => { cardCollapsed = !cardCollapsed; renderDimCard(); });
  dimCard.querySelectorAll('.card-rel a, .card-note a').forEach((a) => a.addEventListener('click', (e) => {
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
  dimCard.querySelector('[data-act="angles"]')?.addEventListener('click', () => updateSettings({ showPartAngles: !settings().showPartAngles }));
  dimCard.querySelector('[data-act="aside"]')?.addEventListener('click', () => setPartStatus([row], 'aside'));
  dimCard.querySelector('[data-act="build"]')?.addEventListener('click', () => setPartStatus([row], null));
  dimCard.querySelector('[data-act="delete"]').addEventListener('click', () => setPartStatus([row], 'deleted'));
  dimCard.querySelector('[data-act="piece-aside"]')?.addEventListener('click', () => setPieceStatus(current.piece, 'aside'));
  dimCard.querySelector('[data-act="piece-delete"]')?.addEventListener('click', () => setPieceStatus(current.piece, 'deleted'));
  dimCard.querySelector('[data-act="del-overlap"]')?.addEventListener('click', () => {
    const o = row.overlapPairs[0];
    // delete the copy that isn't the piece you clicked, if you clicked one
    const m = meshByName.get(current.piece?.name === o.b ? o.a : o.b);
    if (m) setPieceStatus(m, 'deleted');
  });
  dimCard.querySelector('[data-act="join-overlap"]')?.addEventListener('click', () => {
    const o = row.overlapPairs[0];
    commitEdits(withJoin(edits, [o.a, o.b]), `Joined into one ${formatLength(o.span, settings().units)} piece`);
    selectRow(allPartRows.find((r) => r.obj_names.includes(o.a)), { frame: false });
  });
  dimCard.querySelector('[data-act="split"]')?.addEventListener('click', () => {
    commitEdits(withSplit(edits, row.pieces), 'Split back into the pieces in the model');
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
// like wasDrag, without consuming the press (pointerup comes before click)
const wasDragAt = (e) => !!downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > DRAG_PX;
function wasDrag(e) {
  const drag = !!downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > DRAG_PX;
  if (e.type === 'click') downAt = null; // one pointerdown per click
  return drag;
}

renderer.domElement.addEventListener('click', (e) => {
  if (!model || wasDrag(e)) return;
  if (measure.handleClick(e)) return;
  const hit = raycastAt(e.clientX, e.clientY, meshes.filter((m) => m.visible));
  if (!hit) { if (current && !build) clearSelection(); return; }
  const row = rowByMeshName.get(hit.object.name);
  if (build && row) { const k = build.order.findIndex((r) => r.key === row.key); if (k >= 0 && k !== build.i) { build.i = k; showStep(false); return; } }
  if (row && (!current || row.key !== current.row.key)) selectRow(row, { frame: false });
  // remember which of the part's pieces was clicked (to delete just that one)
  if (current && row && row.key === current.row.key && current.piece !== hit.object) {
    current.piece = hit.object;
    applyMaterials();
    renderDimCard();
  }
});
renderer.domElement.addEventListener('dblclick', (e) => { if (current?.box && !wasDrag(e)) frameBox(current.box, null); });
// double-tap: not every mobile browser sends dblclick for a canvas
let lastTap = null;
renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.pointerType !== 'touch' || wasDragAt(e)) return;
  const now = e.timeStamp;
  if (lastTap && now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30 && current?.box) {
    frameBox(current.box, null);
    lastTap = null;
  } else lastTap = { t: now, x: e.clientX, y: e.clientY };
});

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
// the hint's × stops measuring (phones have no Esc key)
$('measureHint').addEventListener('click', (e) => {
  if (!e.target.closest('.hint-x')) return;
  measure.cancel();
  syncToolButtons();
});
// iOS Safari: a pinch outside the 3D view would zoom the whole page
document.addEventListener('gesturestart', (e) => e.preventDefault());

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
  const piece = rowPieces(current.row)[0];
  const data = piece && objectDims[piece.key];
  if (!data) return false;
  // a joined piece is drawn from all of its meshes
  const mesh = piece.meshes.length === 1 ? piece.meshes[0] : new THREE.Mesh(mergePositions(piece.meshes.map((m) => m.geometry)));
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
  stage.ground.visible = false;
  scene.background = new THREE.Color(0xffffff);
  const box = exploded ? meshes.reduce((b, m) => (m.visible ? b.expandByObject(m) : b), new THREE.Box3()) : modelBox;
  frameBox(box, config.views?.iso?.dir || [0.7, 0.5, 0.7], false);
  let url = null;
  try {
    renderer.render(scene, camera);
    url = cropToContent(renderer.domElement, 24, exploded ? drawCallouts : null);
  } catch { /* tainted canvas etc. */ }
  scene.background = saved.bg;
  stage.ground.visible = true;
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
  const sheets = sheetLayouts(rows);
  const longest = Math.max(...layouts.flatMap((g) => [...g.owned, ...g.boards].map((b) => b.length)), ...sheets.flatMap((g) => g.sheets.map((b) => b.length)), 1);
  const diagrams = layouts.length || sheets.length
    ? `<div class="ps-diagrams"><h2>Shopping list &amp; cutting diagrams</h2>${layoutsHTML(layouts, { pxPerInch: 700 / longest, units: settings().units, colorFor: diagram.colorFor, hardware: rows, finishArea: woodSurfaceArea(), sheets })}</div>`
    : '';
  const mill = millingPlanHTML(rows);
  buildPrintSheet($('printSheet'), rows, config, img, drillingHtml() + joineryPrintHtml() + (mill ? `<h2>Milling plan</h2>${mill}` : '') + diagrams);
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
  if (build && ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', ' '].includes(k)) { stepBuild(k === 'ArrowLeft' || k === 'ArrowUp' ? -1 : 1); e.preventDefault(); return; }
  if (k === 'Escape') {
    // the thing on top first: a dialog, then measuring, then build mode
    if ($('help').style.display === 'flex') toggleHelp(false);
    else if (library.isOpen()) { $('library').style.display = 'none'; $('setup').style.display = 'none'; }
    else if (share.isOpen()) share.close();
    else if (diagram && diagram.isOpen()) diagram.close();
    else if (measure.cancel()) syncToolButtons();
    else if (build) exitBuild();
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
    // (not in build mode, where an Assemble step shows a whole sub-assembly)
    else if (groupSel !== null && k === 'Delete' && !build) { setPartStatus(allPartRows.filter((r) => r.top_group === groupSel), 'deleted'); e.preventDefault(); }
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
    // The same measurement on several pieces (a pair of legs side by side)
    // often lands on top of itself: show it once there. A measurement that
    // differs, or anything else, always shows.
    const shown = [];
    (current.labels || []).forEach((l) => {
      const s = project(l.pos);
      l.el.style.display = s.behind ? 'none' : 'block';
      l.el.style.left = `${s.x}px`;
      l.el.style.top = `${s.y}px`;
      if (s.behind) return;
      if (!l.w) { l.w = l.el.offsetWidth; l.h = l.el.offsetHeight; }
      const dupe = shown.some((o) => o.text === l.text && Math.abs(o.x - s.x) < (o.w + l.w) / 2 && Math.abs(o.y - s.y) < (o.h + l.h) / 2);
      l.el.style.visibility = dupe ? 'hidden' : '';
      if (!dupe) shown.push({ text: l.text, x: s.x, y: s.y, w: l.w, h: l.h });
    });
  }
  measure.update(project);
  updateTags();
}

function animate(now) {
  requestAnimationFrame(animate);
  stepTween(now);
  if (controls.update() || tween) requestRender(); // moving (incl. the orbit's glide to a stop)
  if (now > renderUntil) return; // nothing has changed: don't redraw the same picture
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
  setExplode, setView, selectRow, rows: () => rows, requestRender, objectDims: () => objectDims,
  prepareTemplate,
  guidePoints: () => selectionGuidePoints(),
  guideAxes: () => selectionGuideAxes(),
  contactsOf: (name) => [...contactsOf(meshByName.get(name))].map((m) => m.name),
  endTemplate: () => { printingTemplate = false; },
};
