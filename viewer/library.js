// Model library: upload COLLADA / KMZ / zip files (e.g. 3D Warehouse
// downloads), keep them in the browser, switch between them, set each one
// up (which materials are wood, which way is front), and export them.

import { parseCollada } from './collada.js';
import { unzip, isZip, text as bytesToText, zip } from './zip.js';
import {
  saveModel, listModels, getModelFiles, putModelFile, deleteModel, getModelMeta,
} from './modelstore.js';
import { escapeHtml } from './format.js';

const DATA_FILES = ['scene.obj', 'scene.mtl', 'materials.json', 'object_dims.json', 'parts_report.json', 'model.json'];
export const CATEGORIES = ['Wood', 'Hardware', 'Leather', 'Other'];

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
  if (isZip(bytes)) {
    const entries = await unzip(bytes);
    const names = [...entries.keys()].filter((n) => !n.startsWith('__MACOSX/'));
    const base = (n) => n.split('/').pop();
    // a model exported from this library: use as is
    if (DATA_FILES.every((f) => names.some((n) => base(n) === f))) {
      const files = {};
      DATA_FILES.forEach((f) => { files[f] = bytesToText(entries.get(names.find((n) => base(n) === f))); });
      const cfg = JSON.parse(files['model.json']);
      return { name: cfg.title || file.name, files, parts: JSON.parse(files['parts_report.json']).length };
    }
    const daes = names.filter((n) => n.toLowerCase().endsWith('.dae'));
    if (!daes.length) throw new Error(`No .dae model inside ${file.name}.`);
    daes.sort((a, b) => entries.get(b).length - entries.get(a).length); // the model, not a stray preview
    xml = bytesToText(entries.get(daes[0]));
  } else {
    xml = bytesToText(bytes);
    if (!/<COLLADA[\s>]/.test(xml.slice(0, 4000))) throw new Error(`${file.name} isn't a COLLADA (.dae), KMZ or zip file.`);
  }
  onStatus('Measuring parts…');
  await new Promise((r) => setTimeout(r, 30)); // let the status paint before the heavy parse
  // name the model after the upload (Warehouse zips are named after the model; the .dae inside often isn't)
  const { files, stats } = parseCollada(xml, { fileName: file.name });
  const cfg = JSON.parse(files['model.json']);
  return { name: cfg.title, files, parts: stats.parts };
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
export function applySetup(cfg, { title, subtitle, categories, front }) {
  const out = structuredClone(cfg);
  out.title = title || out.title;
  out.subtitle = subtitle ?? out.subtitle;
  Object.entries(categories || {}).forEach(([name, cat]) => {
    const m = (out.materials[name] = out.materials[name] || (name === '(none)' ? { color: '#c9975c', label: 'No material' } : { color: '#999999' }));
    m.category = cat;
    if (cat === 'Wood' && !m.texture) m.texture = { base: '#c9975c', streak: '#a06f3b', ring: '#8a5a2c', tile: 5 };
    if (cat !== 'Wood') delete m.texture;
  });
  const f = FRONTS[front] || FRONTS['+X'];
  out.axisNames = { x: f.x, y: 'vertical', z: f.z };
  out.views = { ...(out.views || {}), front: { label: 'Front', dir: f.front }, side: { label: 'Side', dir: f.side } };
  return out;
}

// ---------- UI ----------

export function initLibrary({ current, onOpen, builtIn }) {
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
    const row = (ref, name, sub, actions) => `
      <div class="lib-item${ref === current ? ' current' : ''}" data-ref="${escapeHtml(ref)}">
        <div class="lib-name"><b>${escapeHtml(name)}</b>${ref === current ? ' <span class="lib-badge">open</span>' : ''}<div class="muted small">${sub}</div></div>
        <div class="lib-actions">${actions}</div>
      </div>`;
    const btn = (act, label, title) => `<button class="card-btn" data-act="${act}" title="${title}">${label}</button>`;
    listEl.innerHTML = row('', escapeHtml(builtIn.title), 'Built-in model', ref0Actions())
      + (models.length ? models.map((m) => row(`local:${m.id}`, m.name,
        `${m.parts} parts · uploaded ${new Date(m.createdAt).toLocaleDateString()} · ${escapeHtml(m.source || '')}`,
        (`local:${m.id}` === current ? '' : btn('open', 'Open', 'Open this model'))
        + btn('setup', 'Set up', 'Title, which materials are wood, which way is front')
        + btn('export', 'Download', 'Save this model as a zip (to keep, share, or add to the repo)')
        + btn('delete', 'Delete', 'Remove from this browser'))).join('')
        : '<div class="muted small lib-empty">No uploaded models yet.</div>');
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
      const [files, meta] = await Promise.all([getModelFiles(id), getModelMeta(id)]);
      const slug = (meta.name || 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'model';
      const blob = new Blob([zip(Object.fromEntries(DATA_FILES.map((f) => [`${slug}/${f}`, files[f]])))], { type: 'application/zip' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${slug}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } else if (b.dataset.act === 'delete' && id) {
      if (!window.confirm('Delete this model from this browser? (Its notes and ticks go too.)')) return;
      await deleteModel(id);
      if (ref === current) onOpen('');
      else render();
    }
  });

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
    setup.querySelector('.setup-body').innerHTML = `
      <label class="setup-field">Name <input name="title" value="${escapeHtml(cfg.title || '')}" /></label>
      <label class="setup-field">Description <input name="subtitle" value="${escapeHtml(cfg.subtitle || '')}" placeholder="e.g. plan source" /></label>
      <label class="setup-field">Front of the piece faces
        <select name="front">${Object.keys(FRONTS).map((k) => `<option value="${k}"${k === frontOf(cfg) ? ' selected' : ''}>${k} (${k.includes('X') ? 'red' : 'blue'} axis ${k.startsWith('+') ? 'positive' : 'negative'})</option>`).join('')}</select></label>
      <p class="muted small">Tip: use the Front view button afterwards - if you see the back, pick the opposite direction.</p>
      <table class="setup-mats"><thead><tr><th>Material</th><th>Used by</th><th>Counts as</th></tr></thead><tbody>
      ${mats.map((m) => `<tr><td><span class="mat-swatch" style="background:${escapeHtml(cfg.materials[m].color || '#999')}"></span>${escapeHtml(m === '(none)' ? 'No material (unpainted)' : m.replace(/^_+/, ''))}</td>
        <td class="num">${uses[m] || 0} pc</td>
        <td><select data-mat="${escapeHtml(m)}">${CATEGORIES.map((c) => `<option${c === cfg.materials[m].category ? ' selected' : ''}>${c}</option>`).join('')}</select></td></tr>`).join('')}
      </tbody></table>
      <p class="muted small">Only <b>Wood</b> parts go into rough stock, board feet, the cutting diagram and templates. Parts with no material count as Other.</p>`;
    setup.dataset.id = id;
    setup.style.display = 'flex';
  }
  setup.querySelector('.setup-save').addEventListener('click', async () => {
    const id = setup.dataset.id;
    const files = await getModelFiles(id);
    const cfg = JSON.parse(files['model.json']);
    delete (cfg.materials || {}).default;
    const body = setup.querySelector('.setup-body');
    const categories = {};
    body.querySelectorAll('select[data-mat]').forEach((s) => { categories[s.dataset.mat] = s.value; });
    const next = applySetup(cfg, {
      title: body.querySelector('[name=title]').value.trim(),
      subtitle: body.querySelector('[name=subtitle]').value.trim(),
      front: body.querySelector('[name=front]').value,
      categories,
    });
    await putModelFile(id, 'model.json', JSON.stringify(next, null, 2), { name: next.title });
    setup.style.display = 'none';
    onOpen(`local:${id}`, { reload: true });
  });
  setup.querySelector('.setup-cancel').addEventListener('click', () => { setup.style.display = 'none'; });

  return { open, close, openSetup, isOpen: () => modal.style.display === 'flex' || setup.style.display === 'flex', handleFile };
}
