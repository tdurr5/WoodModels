// Model library: upload COLLADA / KMZ / zip files (e.g. 3D Warehouse
// downloads), keep them in the browser, switch between them, set each one
// up (which materials are wood, which way is front), and export them.

import { parseCollada } from './collada.js';
import { unzip, isZip, text as bytesToText, zip } from './zip.js';
import {
  saveModel, listModels, getModelFiles, getModelConfig, putModelFile, deleteModel, getModelMeta,
} from './modelstore.js';
import { escapeHtml, looksLikeSheetGoods, SHEET } from './format.js';
import { SPECIES, GRAINS, speciesFor, photoWood } from './woodtex.js';
import { materialKind } from './look.js';

const DATA_FILES = ['scene.obj', 'scene.mtl', 'materials.json', 'object_dims.json', 'parts_report.json', 'model.json'];
export const CATEGORIES = ['Wood', 'Sheet goods', 'Hardware', 'Leather', 'Other'];

// ---------- import ----------

// File -> { name, files, parts }. Accepts .dae, .zip / .kmz containing a .dae,
// or a zip previously exported from this library.
export async function importFile(file, onStatus = () => {}) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.skp')) {
    throw new Error('SketchUp .skp files can\'t be read in a browser. On 3D Warehouse, use Download → "Collada File" (or KMZ) and upload that instead.');
  }
  onStatus(`Reading ${file.name}…`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let xml = null;
  let zipEntries = null;
  if (isZip(bytes)) {
    const entries = await unzip(bytes);
    const names = [...entries.keys()].filter((n) => !n.startsWith('__MACOSX/'));
    const base = (n) => n.split('/').pop();
    // a model exported from this library: use as is
    if (DATA_FILES.every((f) => names.some((n) => base(n) === f))) {
      const files = {};
      DATA_FILES.forEach((f) => { files[f] = bytesToText(entries.get(names.find((n) => base(n) === f))); });
      const cfg = JSON.parse(files['model.json']);
      const images = woodImages(cfg, entries, names);
      if (images) files.images = images;
      return { name: cfg.title || file.name, files, parts: JSON.parse(files['parts_report.json']).length };
    }
    const daes = names.filter((n) => n.toLowerCase().endsWith('.dae'));
    if (!daes.length) throw new Error(`No .dae model inside ${file.name}.`);
    daes.sort((a, b) => entries.get(b).length - entries.get(a).length); // the model, not a stray preview
    xml = bytesToText(entries.get(daes[0]));
    zipEntries = { entries, names };
  } else {
    xml = bytesToText(bytes);
    if (!/<COLLADA[\s>]/.test(xml.slice(0, 4000))) throw new Error(`${file.name} isn't a COLLADA (.dae), KMZ or zip file.`);
  }
  onStatus('Measuring parts…');
  await new Promise((r) => setTimeout(r, 30)); // let the status paint before the heavy parse
  // name the model after the upload (Warehouse zips are named after the model; the .dae inside often isn't)
  const { files, stats } = parseCollada(xml, { fileName: file.name });
  const cfg = JSON.parse(files['model.json']);
  // readable species names up front, so texture variants of one wood total up as one
  Object.entries(cfg.materials || {}).forEach(([name, m]) => {
    const label = defaultMaterialLabel(name, m);
    if (!m.label && label !== name) m.label = label;
  });
  // the model's own photos of its woods (3D Warehouse zips carry them), shown on the parts
  const images = zipEntries && woodImages(cfg, zipEntries.entries, zipEntries.names);
  if (images) {
    files.images = images;
    await woodFromPhotos(cfg, images);
  }
  files['model.json'] = JSON.stringify(cfg, null, 2);
  return { name: cfg.title, files, parts: stats.parts };
}

// Warehouse models often paint wood with a photo under a name that says
// nothing ("Material12", "Texture_3"). A material like that whose photo is
// streaky and wood-coloured is wood: it counts in the cut list and is shown
// with its photo. Set up can always say otherwise. And a photo material with
// no colour of its own (the parser's stand-in tan) takes its photo's colour,
// for the cut list's colour dots.
const STAND_IN = '#b28c59'; // collada.js: a material with a texture and no colour
async function woodFromPhotos(cfg, images) {
  await Promise.all(Object.entries(cfg.materials || {}).map(async ([name, m]) => {
    const img = m.photo || m.texture?.image;
    if (!img || !images[img]) return;
    try {
      const photo = photoWood(await createImageBitmap(new Blob([images[img]])), img);
      if (m.color === STAND_IN) m.color = photo.mean;
      if (!m.photo || m.category !== 'Other' || materialKind('Other', name, m.label) !== 'plain' || !photo.woody) return;
      m.category = 'Wood';
      m.texture = { base: '#c9975c', streak: '#a06f3b', ring: '#8a5a2c', tile: 5, image: m.photo };
      delete m.photo;
    } catch { /* not an image the browser can read */ }
  }));
}

// { file name: bytes } of the photos model.json refers to (wood, and other
// textured materials), found in the zip
function woodImages(cfg, entries, names) {
  const wanted = new Set(Object.values(cfg.materials || {}).flatMap((m) => [m.texture?.image, m.photo]).filter(Boolean));
  const images = {};
  const base = (n) => n.split('/').pop();
  const decode = (n) => { try { return decodeURIComponent(n); } catch { return n; } };
  wanted.forEach((img) => {
    const hit = names.find((n) => base(n) === img || decode(base(n)) === decode(img));
    const bytes = hit && entries.get(hit);
    if (bytes && bytes.length < 12e6) images[img] = bytes;
  });
  return Object.keys(images).length ? images : null;
}

// An uploaded model as a zip of its data files in a folder named after it
// (Download, and Share on a phone); uploading it again restores it.
export async function modelZip(id) {
  const [files, meta] = await Promise.all([getModelFiles(id), getModelMeta(id)]);
  const slug = (meta?.name || 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'model';
  const bytes = zip({
    ...Object.fromEntries(DATA_FILES.map((f) => [`${slug}/${f}`, files[f]])),
    ...Object.fromEntries(Object.entries(files.images || {}).map(([name, b]) => [`${slug}/${name}`, b])),
  });
  return new File([bytes], `${slug}.zip`, { type: 'application/zip' });
}

// ---------- model setup (config editing) ----------

// Directions for "front": the world axis the model's length/front points along.
const FRONTS = {
  '+X': { x: 'front-to-back', z: 'side-to-side', front: [1, 0, 0], side: [0, 0, 1] },
  '-X': { x: 'front-to-back', z: 'side-to-side', front: [-1, 0, 0], side: [0, 0, -1] },
  '+Z': { x: 'side-to-side', z: 'front-to-back', front: [0, 0, 1], side: [-1, 0, 0] },
  '-Z': { x: 'side-to-side', z: 'front-to-back', front: [0, 0, -1], side: [1, 0, 0] },
};
export function frontOf(cfg) {
  const f = cfg.views?.front?.dir || [1, 0, 0];
  const k = Math.abs(f[0]) >= Math.abs(f[2]) ? (f[0] >= 0 ? '+X' : '-X') : (f[2] >= 0 ? '+Z' : '-Z');
  return k;
}
// A readable species/material name from a SketchUp material name, so the
// variants a model uses for grain direction or texture copies ("Mélèse_Verticale1_0",
// "Mélèse_Horizontal1_1") read - and total up - as one: "Mélèse".
export function cleanMaterialName(name) {
  const out = String(name || '')
    .replace(/_+/g, ' ')
    .replace(/\b(?:copy|finished|horizontal|vertical|verticale|horizontale|grain|end|side|top|rough|texture|color|colour|material)\d*\b/gi, ' ')
    .replace(/\s\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return out || String(name || '').replace(/^_+/, '');
}

// What a material is called before you name it: the species for a wood we
// recognise ("Mélèse_Horizontal1" and "Mélèse_Verticale1" are both Larch, so
// they total up as one), otherwise its texture name without the clutter.
export function defaultMaterialLabel(name, m = {}) {
  const sp = m.category === 'Wood' ? speciesFor(name) : null;
  return sp ? SPECIES[sp].name : cleanMaterialName(name);
}

// the category a material is treated as (cutlist.js prepareRows does the same)
const effectiveCategory = (name, m) => ((m.category === 'Wood' || m.category === 'Other') && !m.userCategory && looksLikeSheetGoods(name, m.label) ? SHEET : m.category);

// changed: materials whose category you picked yourself (kept as chosen)
export function applySetup(cfg, { title, subtitle, categories, front, labels = {}, species = {}, changed = [] }) {
  const out = structuredClone(cfg);
  out.title = title || out.title;
  out.subtitle = subtitle ?? out.subtitle;
  Object.entries(categories || {}).forEach(([name, cat]) => {
    const m = (out.materials[name] = out.materials[name] || (name === '(none)' ? { color: '#c9975c', label: 'No material' } : { color: '#999999' }));
    m.category = cat;
    if (changed.includes(name)) m.userCategory = true; // don't second-guess a choice (e.g. plywood as Wood)
    // the model's own photo goes with the material either way
    if ((cat === 'Wood' || cat === 'Sheet goods') && !m.texture) {
      m.texture = { base: '#c9975c', streak: '#a06f3b', ring: '#8a5a2c', tile: 5, ...(m.photo ? { image: m.photo } : {}) };
      delete m.photo;
    }
    if (cat !== 'Wood' && cat !== 'Sheet goods') {
      if (m.texture?.image) m.photo = m.texture.image;
      delete m.texture;
    }
  });
  // how the wood looks ('' = guess from its names)
  Object.entries(species).forEach(([name, sp]) => {
    const m = out.materials[name];
    if (!m) return;
    if (sp && (SPECIES[sp] || GRAINS[sp])) m.species = sp; else delete m.species;
  });
  // materials given the same name are one species: totals and shopping list combine them
  Object.entries(labels).forEach(([name, label]) => {
    const m = out.materials[name];
    if (!m) return;
    if (label && label.trim()) m.label = label.trim(); else delete m.label;
  });
  const f = FRONTS[front] || FRONTS['+X'];
  out.axisNames = { x: f.x, y: 'vertical', z: f.z };
  out.views = { ...(out.views || {}), front: { label: 'Front', dir: f.front }, side: { label: 'Side', dir: f.side } };
  return out;
}

// ---------- UI ----------

export function initLibrary({ current, onOpen, builtIn, onNewDesign }) {
  // current: 'local:<id>' | '' (built-in); onOpen(ref) navigates to a model
  const modal = document.getElementById('library');
  const listEl = modal.querySelector('.lib-list');
  const statusEl = modal.querySelector('.lib-status');
  const input = modal.querySelector('#libFile');
  const setup = document.getElementById('setup');

  const status = (msg, kind = '') => { statusEl.textContent = msg; statusEl.className = `lib-status ${kind}`; };

  async function render() {
    let models = [];
    try { models = await listModels(); } catch (e) { status(e.message, 'error'); }
    const thumb = (src) => (src && /^data:image\/jpeg;base64,[\w+/=]+$/.test(src) ? `<img class="lib-thumb" src="${src}" alt="">` : '<span class="lib-thumb"></span>');
    const row = (ref, name, sub, actions, pic) => `
      <div class="lib-item${ref === current ? ' current' : ''}" data-ref="${escapeHtml(ref)}">
        ${thumb(pic)}
        <div class="lib-name"><b>${escapeHtml(name)}</b>${ref === current ? ' <span class="lib-badge">open</span>' : ''}<div class="muted small">${sub}</div></div>
        <div class="lib-actions">${actions}</div>
      </div>`;
    const btn = (act, label, title) => `<button class="card-btn" data-act="${act}" title="${title}">${label}</button>`;
    listEl.innerHTML = row('', escapeHtml(builtIn.title), 'Built-in model', ref0Actions(), builtIn.thumb)
      + (models.length ? models.map((m) => row(`local:${m.id}`, m.name,
        `${m.parts} parts · ${m.source === 'design' ? 'designed' : 'imported'} ${new Date(m.createdAt).toLocaleDateString()} · ${escapeHtml(m.source || '')}`,
        (`local:${m.id}` === current ? '' : btn('open', 'Open', 'Open this model'))
        + btn('setup', 'Set up', 'Title, which materials are wood, which way is front')
        + btn('export', 'Download', 'Save this model as a zip (to keep, share, or add to the repo)')
        + btn('delete', 'Delete', 'Remove from this browser'), m.thumb)).join('')
        : '<div class="muted small lib-empty">Your saved projects will appear here.</div>');
    function ref0Actions() { return current === '' ? '' : btn('open', 'Open', 'Open this model'); }
  }

  async function handleFile(file) {
    open();
    try {
      const { name, files, parts } = await importFile(file, (m) => status(m));
      status('Saving…');
      const id = await saveModel({ name, source: file.name, files, parts });
      status(`Added "${name}" (${parts} parts). Opening…`, 'ok');
      onOpen(`local:${id}`, { setup: true });
    } catch (e) {
      console.error(e);
      status(e.message || String(e), 'error');
    }
  }

  listEl.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const ref = b.closest('.lib-item').dataset.ref;
    const id = ref.startsWith('local:') ? ref.slice(6) : null;
    if (b.dataset.act === 'open') onOpen(ref);
    else if (b.dataset.act === 'setup' && id) { close(); openSetup(id); }
    else if (b.dataset.act === 'export' && id) {
      const file = await modelZip(id);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } else if (b.dataset.act === 'delete' && id) {
      if (!window.confirm('Delete this model from this browser? (Its notes and ticks go too.)')) return;
      await deleteModel(id);
      if (ref === current) onOpen('');
      else render();
    }
  });

  modal.querySelector('#libNewDesign').addEventListener('click', () => { close(); onNewDesign?.(false); });
  modal.querySelector('#libBlankDesign').addEventListener('click', () => { close(); onNewDesign?.(true); });
  modal.querySelector('.lib-drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });

  input.addEventListener('change', () => { if (input.files[0]) handleFile(input.files[0]); input.value = ''; });
  modal.querySelector('.lib-drop').addEventListener('click', () => input.click());

  // drag a file anywhere onto the page
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
  window.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    handleFile(f);
  });

  function open() { modal.style.display = 'flex'; render(); }
  function close() { modal.style.display = 'none'; status(''); }
  modal.querySelector('.lib-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  // ----- setup dialog -----
  let photoUrls = [];
  async function openSetup(id) {
    const files = await getModelFiles(id);
    if (!files) return;
    const cfg = JSON.parse(files['model.json']);
    const rows = JSON.parse(files['parts_report.json']);
    // how many parts use each material, to help decide which are wood
    const uses = {};
    rows.forEach((r) => {
      const ms = r.materials && r.materials.length ? r.materials : ['(none)'];
      ms.forEach((m) => { uses[m] = (uses[m] || 0) + r.count; });
    });
    cfg.materials = cfg.materials || {};
    delete cfg.materials.default; // SketchUp's default material = "(none)" here
    if (uses['(none)'] && !cfg.materials['(none)']) {
      // unpainted parts: most likely the wood itself, unless something else already is
      const anyWood = Object.values(cfg.materials).some((m) => m.category === 'Wood');
      cfg.materials['(none)'] = { category: anyWood ? 'Other' : 'Wood', color: '#c9975c', label: 'No material' };
    }
    const mats = Object.keys(cfg.materials).sort((a, b) => (uses[b] || 0) - (uses[a] || 0));
    // a material painted with a photo shows that photo: "Material12" and
    // "Material13" are easier told apart by their wood (or fabric) than their names
    photoUrls.forEach((u) => URL.revokeObjectURL(u));
    photoUrls = [];
    const swatch = (m) => {
      const img = cfg.materials[m].texture?.image || cfg.materials[m].photo;
      const bytes = img && files.images?.[img];
      if (!bytes) return `<span class="mat-swatch" style="background:${escapeHtml(cfg.materials[m].color || '#999')}"></span>`;
      const url = URL.createObjectURL(new Blob([bytes]));
      photoUrls.push(url);
      return `<span class="mat-swatch photo" style="background-image:url('${url}')" title="${escapeHtml(img)}"></span>`;
    };
    setup.querySelector('.setup-body').innerHTML = `
      <label class="setup-field">Name <input name="title" value="${escapeHtml(cfg.title || '')}" /></label>
      <label class="setup-field">Description <input name="subtitle" value="${escapeHtml(cfg.subtitle || '')}" placeholder="e.g. plan source" /></label>
      <label class="setup-field">Front of the piece faces
        <select name="front">${Object.keys(FRONTS).map((k) => `<option value="${k}"${k === frontOf(cfg) ? ' selected' : ''}>${k} (${k.includes('X') ? 'red' : 'blue'} axis ${k.startsWith('+') ? 'positive' : 'negative'})</option>`).join('')}</select></label>
      <p class="muted small">Tip: use the Front view button afterwards - if you see the back, pick the opposite direction.</p>
      <table class="setup-mats"><thead><tr><th>Material</th><th>Used by</th><th>Counts as</th><th title="Species or material name. Materials with the same name are added up together.">Called</th><th title="How the wood looks in 3D">Looks like</th></tr></thead><tbody>
      ${mats.map((m) => `<tr><td>${swatch(m)}${escapeHtml(m === '(none)' ? 'No material (unpainted)' : m.replace(/^_+/, ''))}</td>
        <td class="num">${uses[m] || 0} pc</td>
        <td><select data-mat="${escapeHtml(m)}" data-initial="${escapeHtml(effectiveCategory(m, cfg.materials[m]))}">${CATEGORIES.map((c) => `<option${c === effectiveCategory(m, cfg.materials[m]) ? ' selected' : ''}>${c}</option>`).join('')}</select></td>
        <td><input data-label="${escapeHtml(m)}" value="${escapeHtml(cfg.materials[m].label || (m === '(none)' ? 'No material' : defaultMaterialLabel(m, cfg.materials[m])))}" /></td>
        <td><select data-species="${escapeHtml(m)}"><option value="">${escapeHtml(cfg.materials[m].texture?.image ? 'The model\'s own photo' : SPECIES[speciesFor(cfg.materials[m].label, m)]?.name ? `Auto (${SPECIES[speciesFor(cfg.materials[m].label, m)].name})` : 'Auto (wide grain)')}</option><optgroup label="In the model's colour">${Object.entries(GRAINS).map(([k, g]) => `<option value="${k}"${cfg.materials[m].species === k ? ' selected' : ''}>${escapeHtml(g.name)}</option>`).join('')}</optgroup><optgroup label="Species">${Object.entries(SPECIES).map(([k, sp]) => `<option value="${k}"${cfg.materials[m].species === k ? ' selected' : ''}>${escapeHtml(sp.name)}</option>`).join('')}</optgroup></select></td></tr>`).join('')}
      </tbody></table>
      <p class="muted small">Only <b>Wood</b> parts go into rough stock, board feet, the cutting diagram and templates. Give materials the same name (e.g. all the oak textures "Red oak") to total them as one species.</p>`;
    // "Looks like" is how wood looks: only wood (and sheet goods) have a choice
    const syncLooks = (sel) => {
      const look = setup.querySelector(`select[data-species="${CSS.escape(sel.dataset.mat)}"]`);
      if (look) look.disabled = sel.value !== 'Wood' && sel.value !== SHEET;
    };
    setup.querySelectorAll('select[data-mat]').forEach((sel) => {
      syncLooks(sel);
      sel.addEventListener('change', () => syncLooks(sel));
    });
    setup.dataset.id = id;
    setup.style.display = 'flex';
  }
  const saveBtn = setup.querySelector('.setup-save');
  saveBtn.addEventListener('click', async () => {
    if (saveBtn.disabled) return;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      await saveSetup();
      saveBtn.textContent = 'Save';
    } catch (e) {
      saveBtn.textContent = 'Couldn\'t save - try again';
      saveBtn.title = e.message || String(e);
    }
    saveBtn.disabled = false;
  });
  async function saveSetup() {
    const id = setup.dataset.id;
    const cfg = JSON.parse(await getModelConfig(id));
    delete (cfg.materials || {}).default;
    const body = setup.querySelector('.setup-body');
    const categories = {};
    const changed = [];
    body.querySelectorAll('select[data-mat]').forEach((s) => {
      categories[s.dataset.mat] = s.value;
      if (s.value !== s.dataset.initial) changed.push(s.dataset.mat);
    });
    const labels = {};
    body.querySelectorAll('input[data-label]').forEach((i) => { labels[i.dataset.label] = i.value; });
    const species = {};
    body.querySelectorAll('select[data-species]').forEach((sel) => { species[sel.dataset.species] = sel.value; });
    const next = applySetup(cfg, {
      title: body.querySelector('[name=title]').value.trim(),
      subtitle: body.querySelector('[name=subtitle]').value.trim(),
      front: body.querySelector('[name=front]').value,
      categories,
      labels,
      species,
      changed,
    });
    await putModelFile(id, 'model.json', JSON.stringify(next, null, 2), { name: next.title });
    setup.style.display = 'none';
    onOpen(`local:${id}`);
  }
  setup.querySelector('.setup-cancel').addEventListener('click', () => { setup.style.display = 'none'; });

  return { open, close, openSetup, isOpen: () => modal.style.display === 'flex' || setup.style.display === 'flex', handleFile };
}
