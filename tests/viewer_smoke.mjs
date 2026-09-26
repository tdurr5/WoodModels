// Headless smoke test for viewer/index.html.
//
// Serves viewer/ from a throwaway local HTTP server, loads it in Chromium, and
// checks the cut list builds, parts can be selected from the sidebar and from
// the 3D view, and nothing logs an error. three.js is normally pulled from
// unpkg via the page's import map; here those requests are answered from the
// local node_modules/three copy so the test runs offline and pinned.
//
//   npm install && npm test
//
// Screenshots land in test-output/ for eyeballing.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWER = path.join(ROOT, 'viewer');
const THREE_DIR = path.join(ROOT, 'node_modules', 'three');
const OUT = path.join(ROOT, 'test-output');
fs.mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.obj': 'text/plain', '.mtl': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg',
};

function serve(dir) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(dir, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ok   ${msg}`);
  else { console.log(`  FAIL ${msg}`); failures++; }
}

const server = await serve(VIEWER);
const base = `http://127.0.0.1:${server.address().port}/`;
const launchOpts = { args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };
if (fs.existsSync('/opt/pw-browsers/chromium')) launchOpts.executablePath = '/opt/pw-browsers/chromium';
const browser = await chromium.launch(launchOpts);
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.route(/^https:\/\/unpkg\.com\/three@[^/]+\/(.*)$/, (route) => {
  const rel = route.request().url().replace(/^https:\/\/unpkg\.com\/three@[^/]+\//, '');
  const file = path.join(THREE_DIR, rel);
  if (!fs.existsSync(file)) return route.fulfill({ status: 404 });
  route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(file) });
});

try {
  console.log('load');
  await page.goto(base);
  await page.waitForFunction(() => document.getElementById('loading').style.display === 'none', null, { timeout: 30000 });
  await page.waitForSelector('#list .row');
  const report = JSON.parse(fs.readFileSync(path.join(VIEWER, 'parts_report.json'), 'utf8'));
  const rowCount = await page.locator('#list .row').count();
  check(rowCount === report.length, `sidebar has one row per cut-list entry (${rowCount}/${report.length})`);
  const disabled = await page.locator('#list .row.disabled').count();
  const expectedDisabled = report.filter((r) => !r.obj_names || !r.obj_names.length).length;
  check(disabled === expectedDisabled, `rows with no 3D geometry are disabled (${disabled}/${expectedDisabled})`);
  await page.screenshot({ path: path.join(OUT, '01-loaded.png') });

  console.log('select from sidebar');
  const bench = page.locator('#list .row', { hasText: 'Bench' }).first();
  await bench.click();
  await page.waitForTimeout(300);
  check(await bench.evaluate((el) => el.classList.contains('active')), 'clicked row is marked active');
  const card = await page.locator('#dimCard').innerText();
  check(card.includes('46-3/8"'), 'dimension card shows the Bench length');
  const axisLabels = await page.locator('#axisLabels .axisLabel').count();
  check(axisLabels >= 3, `dimension gizmo draws L/W/T labels (${axisLabels})`);
  await page.screenshot({ path: path.join(OUT, '02-bench.png') });

  console.log('angled part');
  await page.locator('#list .row', { hasText: 'Leg_Rear' }).first().click();
  await page.waitForTimeout(300);
  const legCard = await page.locator('#dimCard').innerText();
  check(/off plumb/.test(legCard), 'splayed rear leg reports a compound angle');
  await page.screenshot({ path: path.join(OUT, '03-leg-rear.png') });

  console.log('click on model');
  await page.locator('#resetBtn').click();
  await page.waitForTimeout(300);
  check(await page.locator('#list .row.active').count() === 0, 'Show all clears the selection');
  const vp = await page.locator('#viewport canvas').boundingBox();
  const picked = await page.evaluate(({ w, h }) => {
    // Scan a coarse grid of screen points until one lands on the model.
    const canvas = document.querySelector('#viewport canvas');
    const rect = canvas.getBoundingClientRect();
    for (let y = 0.2; y < 0.9; y += 0.05) {
      for (let x = 0.2; x < 0.8; x += 0.05) {
        canvas.dispatchEvent(new MouseEvent('click', { clientX: rect.left + x * w, clientY: rect.top + y * h, bubbles: true }));
        if (document.querySelector('#list .row.active')) return document.querySelector('#list .row.active .name').textContent.trim();
      }
    }
    return null;
  }, { w: vp.width, h: vp.height });
  check(!!picked, `clicking the 3D model selects a part (${picked})`);

  console.log('measure distance');
  await page.locator('#list .row', { hasText: 'Treadle_Foot_Peg' }).first().click();
  await page.waitForTimeout(300);
  await page.locator('#measureDistBtn').click();
  const hitPoints = await page.evaluate(({ w, h }) => {
    const canvas = document.querySelector('#viewport canvas');
    const rect = canvas.getBoundingClientRect();
    let clicks = 0;
    for (let x = 0.3; x < 0.7 && clicks < 2; x += 0.02) {
      const before = document.querySelectorAll('#measureLabels .measureLabel').length;
      const hint = document.getElementById('measureHint').textContent;
      canvas.dispatchEvent(new MouseEvent('click', { clientX: rect.left + x * w, clientY: rect.top + 0.5 * h, bubbles: true }));
      if (document.getElementById('measureHint').textContent !== hint ||
          document.querySelectorAll('#measureLabels .measureLabel').length !== before) clicks++;
    }
    return clicks;
  }, { w: vp.width, h: vp.height });
  const measureLabels = await page.locator('#measureLabels .measureLabel').count();
  check(hitPoints === 2 && measureLabels === 1, `two clicks on the part produce a distance label (${measureLabels})`);
  await page.screenshot({ path: path.join(OUT, '04-measure.png') });
  await page.locator('#clearMeasureBtn').click();
  check(await page.locator('#measureLabels .measureLabel').count() === 0, 'Clear measurements removes labels');
  await page.locator('#measureDistBtn').click();

  console.log('wireframe');
  await page.locator('#wireBtn').click();
  await page.locator('#wireBtn').click();

  check(errors.length === 0, `no page errors${errors.length ? ':\n    ' + errors.join('\n    ') : ''}`);
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
