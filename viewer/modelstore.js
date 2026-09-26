// Uploaded models, saved in the browser (IndexedDB) so they're there next
// time. Two stores: `meta` (small: name, dates, part count) for listing, and
// `files` (the six data files, possibly several MB) loaded only when opened.

const DB_NAME = 'woodmodels';
const DB_VERSION = 1;
const LAST_KEY = 'woodmodels:lastModel';

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Browser storage is unavailable (private window?)'));
    });
  }
  return dbPromise;
}

function tx(stores, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let result;
    Promise.resolve(fn(...stores.map((s) => t.objectStore(s)))).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage transaction aborted (disk full?)'));
  }));
}
const req2p = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

function newId() {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// files: { 'scene.obj', 'scene.mtl', 'materials.json', 'object_dims.json', 'parts_report.json', 'model.json' }
export async function saveModel({ name, source = '', files, parts = 0 }) {
  const id = newId();
  const now = Date.now();
  const size = Object.values(files).reduce((n, s) => n + s.length, 0);
  await tx(['meta', 'files'], 'readwrite', (meta, fs) => {
    meta.put({ id, name, source, parts, size, createdAt: now, updatedAt: now });
    fs.put(files, id);
  });
  return id;
}

export async function listModels() {
  const all = await tx(['meta'], 'readonly', (meta) => req2p(meta.getAll()));
  return (all || []).sort((a, b) => b.updatedAt - a.updatedAt);
}

export const getModelFiles = (id) => tx(['files'], 'readonly', (fs) => req2p(fs.get(id)));
export const getModelMeta = (id) => tx(['meta'], 'readonly', (meta) => req2p(meta.get(id)));

// replace one data file (e.g. model.json after editing the model's setup)
export async function putModelFile(id, fileName, content, metaPatch = {}) {
  await tx(['meta', 'files'], 'readwrite', async (meta, fs) => {
    const files = await req2p(fs.get(id));
    const m = await req2p(meta.get(id));
    if (!files || !m) throw new Error('Model not found');
    files[fileName] = content;
    fs.put(files, id);
    meta.put({ ...m, ...metaPatch, updatedAt: Date.now() });
  });
}

export async function deleteModel(id) {
  await tx(['meta', 'files'], 'readwrite', (meta, fs) => { meta.delete(id); fs.delete(id); });
  // its preferences, ticks, notes and quick-saved edits (see settings.js, app.js)
  try { ['settings', 'edits'].forEach((k) => localStorage.removeItem(`woodmodels:local-${id}:${k}`)); } catch { /* ignore */ }
  if (lastOpened() === `local:${id}`) rememberOpened('');
}

// which model to open when the page is loaded without ?model=
export function lastOpened() {
  try { return localStorage.getItem(LAST_KEY); } catch { return null; }
}
export function rememberOpened(ref) {
  try { localStorage.setItem(LAST_KEY, ref); } catch { /* ignore */ }
}
