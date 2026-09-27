// Uploaded models, saved in the browser (IndexedDB) so they're there next
// time. Stores: `meta` (small: name, dates, part count) for listing,
// `files` (the six data files, possibly several MB) loaded only when opened,
// and `config` (model.json - setup and your edits), kept apart so saving an
// edit doesn't rewrite megabytes of geometry. Models saved before `config`
// existed keep their model.json in `files` until it's first changed.
// `photos`: pictures you take of a build step (see addPhoto), for any model.

const DB_NAME = 'woodmodels';
const DB_VERSION = 3;
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
        if (!d.objectStoreNames.contains('config')) d.createObjectStore('config');
        if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos');
      };
      req.onsuccess = () => {
        // another tab upgrading the database: step aside rather than block it
        req.result.onversionchange = () => { req.result.close(); dbPromise = null; };
        resolve(req.result);
      };
      req.onerror = () => reject(req.error || new Error('Browser storage is unavailable (private window?)'));
    });
  }
  return dbPromise;
}

function tx(stores, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let result, failed = null;
    Promise.resolve(fn(...stores.map((s) => t.objectStore(s)))).then((r) => { result = r; }, (e) => {
      failed = e;
      try { t.abort(); } catch { /* already finished */ }
    });
    t.oncomplete = () => (failed ? reject(failed) : resolve(result));
    t.onerror = () => reject(failed || t.error);
    t.onabort = () => reject(failed || t.error || new Error('Storage transaction aborted (disk full?)'));
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
  const size = Object.values(files).reduce((n, s) => n + (typeof s === 'string' ? s.length : Object.values(s || {}).reduce((a, b) => a + (b.length || 0), 0)), 0);
  await tx(['meta', 'files', 'config'], 'readwrite', (meta, fs, c) => {
    meta.put({ id, name, source, parts, size, createdAt: now, updatedAt: now });
    fs.put(files, id);
    if (files['model.json']) c.put(files['model.json'], id);
  });
  return id;
}

export async function listModels() {
  const all = await tx(['meta'], 'readonly', (meta) => req2p(meta.getAll()));
  return (all || []).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getModelFiles(id) {
  const [files, cfg] = await tx(['files', 'config'], 'readonly', (fs, c) => Promise.all([req2p(fs.get(id)), req2p(c.get(id))]));
  if (files && typeof cfg === 'string') files['model.json'] = cfg;
  return files;
}
// just model.json, without reading the (large) geometry
export async function getModelConfig(id) {
  const cfg = await tx(['config'], 'readonly', (c) => req2p(c.get(id)));
  return typeof cfg === 'string' ? cfg : (await getModelFiles(id))?.['model.json'];
}
export const getModelMeta = (id) => tx(['meta'], 'readonly', (meta) => req2p(meta.get(id)));

// replace one data file (e.g. model.json after editing the model's setup)
export async function putModelFile(id, fileName, content, metaPatch = {}) {
  if (fileName === 'model.json') {
    await tx(['meta', 'config'], 'readwrite', async (meta, c) => {
      const m = await req2p(meta.get(id));
      if (!m) throw new Error('Model not found');
      c.put(content, id);
      meta.put({ ...m, ...metaPatch, updatedAt: Date.now() });
    });
    return;
  }
  await tx(['meta', 'files'], 'readwrite', async (meta, fs) => {
    const files = await req2p(fs.get(id));
    const m = await req2p(meta.get(id));
    if (!files || !m) throw new Error('Model not found');
    files[fileName] = content;
    fs.put(files, id);
    meta.put({ ...m, ...metaPatch, updatedAt: Date.now() });
  });
}

// a small picture of the model for the Models list (app.js saveThumbnail);
// doesn't count as a change to the model
export async function setThumbnail(id, thumb) {
  await tx(['meta'], 'readwrite', async (meta) => {
    const m = await req2p(meta.get(id));
    if (m) meta.put({ ...m, thumb, thumbAt: Date.now() });
  });
}

export async function deleteModel(id) {
  await tx(['meta', 'files', 'config', 'photos'], 'readwrite', (meta, fs, c, photos) => {
    meta.delete(id); fs.delete(id); c.delete(id);
    photos.delete(IDBKeyRange.bound(`local-${id}|`, `local-${id}|\uffff`)); // its build log (app.js modelKey)
  });
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

// ---------- build photos ----------
// Keyed "<model>|<step>|<time>", so a step's photos list together in order.
const photoRange = (model, step) => IDBKeyRange.bound(`${model}|${step}|`, `${model}|${step}|\uffff`);
export async function addPhoto(model, step, blob) {
  const key = `${model}|${step}|${Date.now()}`;
  await tx(['photos'], 'readwrite', (p) => { p.put(blob, key); });
  return key;
}
export async function listPhotos(model, step) {
  return tx(['photos'], 'readonly', async (p) => {
    const range = photoRange(model, step);
    const [keys, blobs] = await Promise.all([req2p(p.getAllKeys(range)), req2p(p.getAll(range))]);
    return keys.map((key, i) => ({ key, blob: blobs[i] }));
  });
}
export async function countPhotos(model) {
  return tx(['photos'], 'readonly', (p) => req2p(p.count(IDBKeyRange.bound(`${model}|`, `${model}|\uffff`))));
}
export const deletePhoto = (key) => tx(['photos'], 'readwrite', (p) => { p.delete(key); });
