// The browser parser (viewer/collada.js) must produce the same data as
// parse_dae.py. Builds fixture COLLADA files with tests/make_fixture.py, runs
// the Python parser on each, runs the JS parser on the same text in headless
// Chromium, and compares every output file (numbers within a small tolerance).
//
//   node tests/parser_parity.mjs

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWER = path.join(ROOT, 'viewer');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-'));

const VARIANTS = {
  inches: {},
  millimetres: { unit_meter: 0.001, scale: 25.4 },
  y_up: { up_axis: 'Y_UP' },
  polygons: { leg_as: 'polygons' },
  translate_rotate: { transforms: 'trs' },
  collada_1_5: { namespace: 'http://www.collada.org/2008/03/COLLADASchema' },
  no_namespace: { namespace: '' },
  sketchup2023: { sketchup2023: 1 },
  scaled_instance: { scaled: 1 },
  painted: { painted: 1 },
  shared_part: { shared: 1 },
};
// Optional: PARITY_SAMPLES=/path/to/folder also compares every .dae in it
// (e.g. real 3D Warehouse / other exporters' files, which aren't in the repo).
const SAMPLES = process.env.PARITY_SAMPLES;

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ok   ${msg}`);
  else { console.log(`  FAIL ${msg}`); failures++; }
}

// deep compare with numeric tolerance; returns the first difference or null
function diff(a, b, tol, where = '') {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= tol ? null : `${where}: ${a} != ${b}`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${where}: length ${a.length} != ${b.length}`;
    for (let i = 0; i < a.length; i++) { const d = diff(a[i], b[i], tol, `${where}[${i}]`); if (d) return d; }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) return `${where}: keys ${ka} != ${kb}`;
    for (const k of ka) { const d = diff(a[k], b[k], tol, `${where}.${k}`); if (d) return d; }
    return null;
  }
  return a === b ? null : `${where}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
}

function objDiff(pyText, jsText) {
  const a = pyText.trim().split('\n'), b = jsText.trim().split('\n');
  if (a.length !== b.length) return `line count ${a.length} != ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    const [ta, ...ra] = a[i].split(' '), [tb, ...rb] = b[i].split(' ');
    if (ta !== tb) return `line ${i + 1}: ${a[i]} != ${b[i]}`;
    if (ta === 'v') { const d = diff(ra.map(Number), rb.map(Number), 2e-5, `line ${i + 1}`); if (d) return d; }
    else if (a[i] !== b[i]) return `line ${i + 1}: ${a[i]} != ${b[i]}`;
  }
  return null;
}

// ---------- Python side ----------
const outputs = {};
for (const [name, kw] of Object.entries(VARIANTS)) {
  const dae = path.join(tmp, `${name}.dae`);
  const args = Object.entries(kw).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
  execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'tests'))}); import make_fixture; open(${JSON.stringify(dae)}, 'w').write(make_fixture.build(${args}))`]);
  const out = path.join(tmp, `${name}-py`);
  execFileSync('python3', [path.join(ROOT, 'parse_dae.py'), dae, '-o', out, '-q']);
  const read = (f) => fs.readFileSync(path.join(out, f), 'utf8');
  outputs[name] = { dae: fs.readFileSync(dae, 'utf8'), py: Object.fromEntries(['scene.obj', 'scene.mtl', 'materials.json', 'object_dims.json', 'parts_report.json', 'model.json'].map((f) => [f, read(f)])) };
}

if (SAMPLES) {
  for (const f of fs.readdirSync(SAMPLES).filter((n) => n.toLowerCase().endsWith('.dae'))) {
    const out = path.join(tmp, `sample-${f}`);
    execFileSync('python3', [path.join(ROOT, 'parse_dae.py'), path.join(SAMPLES, f), '-o', out, '-q']);
    const read = (n) => fs.readFileSync(path.join(out, n), 'utf8');
    outputs[`sample ${f}`] = { dae: fs.readFileSync(path.join(SAMPLES, f), 'utf8'), fileName: f, py: Object.fromEntries(['scene.obj', 'scene.mtl', 'materials.json', 'object_dims.json', 'parts_report.json', 'model.json'].map((n) => [n, read(n)])) };
  }
}

// ---------- JS side (in the browser, where DOMParser lives) ----------
const server = http.createServer((req, res) => {
  const file = path.join(VIEWER, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(VIEWER) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/html' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${base}sw.js`); // any same-origin page works for module imports
try {
  for (const [name, o] of Object.entries(outputs)) {
    console.log(name);
    const js = await page.evaluate(async ({ url, xml, file }) => {
      const m = await import(url);
      return m.parseCollada(xml, { fileName: file }).files;
    }, { url: `${base}collada.js`, xml: o.dae, file: o.fileName || `${name}.dae` });
    const j = (f, src) => JSON.parse(src[f]);
    const d1 = diff(j('parts_report.json', o.py), j('parts_report.json', js), 1e-9, 'parts_report');
    check(!d1, `parts_report.json matches${d1 ? ` (${d1})` : ''}`);
    const d2 = diff(j('object_dims.json', o.py), j('object_dims.json', js), 2e-4, 'object_dims');
    check(!d2, `object_dims.json matches${d2 ? ` (${d2})` : ''}`);
    const d3 = diff(j('materials.json', o.py), j('materials.json', js), 0, 'materials');
    check(!d3, `materials.json matches${d3 ? ` (${d3})` : ''}`);
    const d4 = diff(j('model.json', o.py), j('model.json', js), 0, 'model');
    check(!d4, `model.json (starter config) matches${d4 ? ` (${d4})` : ''}`);
    // map_Kd: the Python writes the texture next to scene.obj and points the
    // OBJ at it; an upload keeps its photos with the model instead (model.json
    // + the library's own store), so only the Python side has those lines.
    const noMaps = (t) => t.split('\n').filter((l) => !l.startsWith('map_Kd ')).join('\n').trim();
    check(noMaps(o.py['scene.mtl']) === noMaps(js['scene.mtl']), 'scene.mtl matches');
    const d5 = objDiff(o.py['scene.obj'], js['scene.obj']);
    check(!d5, `scene.obj matches${d5 ? ` (${d5})` : ''}`);
  }
  // <translate>/<rotate> placement must give the same result as the <matrix> version
  const trsVsMatrix = diff(JSON.parse(outputs.inches.py['object_dims.json']), JSON.parse(outputs.translate_rotate.py['object_dims.json']), 2e-4, 'object_dims');
  check(!trsVsMatrix, `translate/rotate transforms place parts exactly like the equivalent matrix${trsVsMatrix ? ` (${trsVsMatrix})` : ''}`);
  check(outputs.no_namespace.py['parts_report.json'] === outputs.inches.py['parts_report.json'] && outputs.collada_1_5.py['parts_report.json'] === outputs.inches.py['parts_report.json'], 'namespace (1.4, 1.5 or none) does not change the result');

  // unit behaviour the viewer relies on, checked directly
  const units = await page.evaluate(async (url) => {
    const m = await import(url);
    return { a: m.toFrac(0.15625), b: m.toFrac(12.4697), g: m.guessCategory('White_Oak'), cats: ['Mélèse_Verticale1', 'RedOak', 'Chêne clair', 'Steel_Washer', 'Washer', 'First_coat', 'Glass'].map(m.guessCategory) };
  }, `${base}collada.js`);
  check(units.a === '1/8"' && units.b === '12-1/2"' && units.g === 'Wood', `toFrac rounds halves to even like Python (${units.a})`);
  const pyCats = execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(ROOT)}); import parse_dae, json; print(json.dumps([parse_dae.guess_category(n) for n in ['Mélèse_Verticale1', 'RedOak', 'Chêne clair', 'Steel_Washer', 'Washer', 'First_coat', 'Glass']]))`]).toString().trim();
  check(JSON.stringify(units.cats) === JSON.stringify(JSON.parse(pyCats)), `material category guesses match (${units.cats})`);
} finally {
  await browser.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
