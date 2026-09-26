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
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
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


async function selectPart(name) {
  await page.locator('#clList .row', { hasText: name }).first().click();
  await page.waitForTimeout(500);
}

// Runs in the page: screen points on `n` visible faces of the selected part
// that have clearly different normals.
function visibleFacePoints(n) {
  const { THREE, camera, currentSelectionMeshes } = window.__viewer;
  const canvas = document.querySelector('#viewport canvas');
  const rect = canvas.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  const meshes = currentSelectionMeshes();
  const found = [];
  for (const m of meshes) {
    const pos = m.geometry.attributes.position;
    const tris = [];
    for (let t = 0; t < pos.count / 3; t++) {
      const a = m.localToWorld(new THREE.Vector3().fromBufferAttribute(pos, t * 3));
      const b = m.localToWorld(new THREE.Vector3().fromBufferAttribute(pos, t * 3 + 1));
      const c = m.localToWorld(new THREE.Vector3().fromBufferAttribute(pos, t * 3 + 2));
      const tri = new THREE.Triangle(a, b, c);
      tris.push({ tri, area: tri.getArea() });
    }
    tris.sort((x, y) => y.area - x.area);
    for (const { tri } of tris) {
      const normal = tri.getNormal(new THREE.Vector3());
      const centroid = tri.getMidpoint(new THREE.Vector3());
      // SketchUp exports double-sided faces as back-to-back triangle pairs;
      // only consider the side facing the camera.
      if (normal.dot(camera.position.clone().sub(centroid)) <= 0) continue;
      if (found.some((f) => f.normal.dot(normal) > 0.9)) continue;
      const ndc = centroid.clone().project(camera);
      if (Math.abs(ndc.x) > 0.95 || Math.abs(ndc.y) > 0.95) continue;
      ray.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
      const hit = ray.intersectObjects(meshes, false)[0];
      if (!hit || hit.point.distanceTo(centroid) > 0.05) continue;
      found.push({ normal, x: rect.left + (ndc.x * 0.5 + 0.5) * rect.width, y: rect.top + (0.5 - ndc.y * 0.5) * rect.height });
      if (found.length === n) return found.map(({ x, y }) => ({ x, y }));
    }
  }
  return found.map(({ x, y }) => ({ x, y }));
}

try {
  console.log('load');
  await page.goto(base);
  await page.waitForFunction(() => document.getElementById('loading').style.display === 'none', null, { timeout: 30000 });
  await page.waitForSelector('#clList .row');
  const report = JSON.parse(fs.readFileSync(path.join(VIEWER, 'parts_report.json'), 'utf8'));
  const rowCount = await page.locator('#clList .row').count();
  check(rowCount === report.length, `sidebar has one row per cut-list entry (${rowCount}/${report.length})`);
  const disabled = await page.locator('#clList .row.disabled').count();
  const expectedDisabled = report.filter((r) => !r.obj_names || !r.obj_names.length).length;
  check(disabled === expectedDisabled, `rows with no 3D geometry are disabled (${disabled}/${expectedDisabled})`);
  await page.screenshot({ path: path.join(OUT, '01-loaded.png') });

  console.log('select from sidebar');
  const bench = page.locator('#clList .row', { hasText: 'Bench' }).first();
  await bench.click();
  await page.waitForTimeout(300);
  check(await bench.evaluate((el) => el.classList.contains('active')), 'clicked row is marked active');
  const card = await page.locator('#dimCard').innerText();
  check(card.includes('46-3/8"'), 'dimension card shows the Bench length');
  const axisLabels = await page.locator('#axisLabels .axisLabel').count();
  check(axisLabels >= 3, `dimension gizmo draws L/W/T labels (${axisLabels})`);
  await page.screenshot({ path: path.join(OUT, '02-bench.png') });

  console.log('angled part');
  await page.locator('#clList .row', { hasText: 'Leg Rear' }).first().click();
  await page.waitForTimeout(300);
  const legCard = await page.locator('#dimCard').innerText();
  check(/off plumb/.test(legCard), 'splayed rear leg reports a compound angle');
  await page.screenshot({ path: path.join(OUT, '03-leg-rear.png') });

  console.log('click on model');
  await page.locator('#resetBtn').click();
  await page.waitForTimeout(300);
  check(await page.locator('#clList .row.active').count() === 0, 'Show all clears the selection');
  const vp = await page.locator('#viewport canvas').boundingBox();
  const picked = await page.evaluate(({ w, h }) => {
    // Scan a coarse grid of screen points until one lands on the model.
    const canvas = document.querySelector('#viewport canvas');
    const rect = canvas.getBoundingClientRect();
    for (let y = 0.2; y < 0.9; y += 0.05) {
      for (let x = 0.2; x < 0.8; x += 0.05) {
        canvas.dispatchEvent(new MouseEvent('click', { clientX: rect.left + x * w, clientY: rect.top + y * h, bubbles: true }));
        if (document.querySelector('#clList .row.active')) return document.querySelector('#clList .row.active .name').textContent.trim();
      }
    }
    return null;
  }, { w: vp.width, h: vp.height });
  check(!!picked, `clicking the 3D model selects a part (${picked})`);

  console.log('measure distance');
  await page.locator('#clList .row', { hasText: 'Treadle Foot Peg' }).first().click();
  await page.waitForTimeout(300);
  await page.locator('#measureDistBtn').click();
  // Click two different vertices of the selected part: project its mesh
  // vertices to screen space and click the pair farthest apart on screen.
  await page.waitForTimeout(600);
  const hitPoints = await page.evaluate(() => {
    const { THREE, camera, currentSelectionMeshes } = window.__viewer;
    const canvas = document.querySelector('#viewport canvas');
    const rect = canvas.getBoundingClientRect();
    const pts = [];
    currentSelectionMeshes().forEach((m) => {
      const pos = m.geometry.attributes.position;
      for (let i = 0; i < pos.count; i += 7) {
        const v = new THREE.Vector3().fromBufferAttribute(pos, i);
        m.localToWorld(v).project(camera);
        pts.push({ x: rect.left + (v.x * 0.5 + 0.5) * rect.width, y: rect.top + (0.5 - v.y * 0.5) * rect.height });
      }
    });
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length, cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    // aim 60% of the way from the centroid toward the two screen-extreme points
    pts.sort((a, b) => a.x - b.x);
    const targets = [pts[0], pts[pts.length - 1]].map((p) => ({ x: cx + (p.x - cx) * 0.6, y: cy + (p.y - cy) * 0.6 }));
    let clicks = 0;
    targets.forEach((t) => {
      const before = window.__viewer.measureClickCount();
      canvas.dispatchEvent(new MouseEvent('click', { clientX: t.x, clientY: t.y, bubbles: true }));
      if (window.__viewer.measureClickCount() !== before) clicks++;
    });
    return clicks;
  });
  const measureLabels = await page.locator('#measureLabels .measureLabel').count();
  check(hitPoints === 2 && measureLabels === 1, `two clicks on the part produce a distance label (${measureLabels})`);
  await page.screenshot({ path: path.join(OUT, '04-measure.png') });
  await page.locator('#clearMeasureBtn').click();
  check(await page.locator('#measureLabels .measureLabel').count() === 0, 'Clear measurements removes labels');
  await page.locator('#measureDistBtn').click();

  console.log('wireframe');
  await page.locator('#wireBtn').click();
  check(await page.locator('#wireBtn.on').count() === 1, 'wireframe toggles on');
  await page.locator('#wireBtn').click();

  console.log('bevel (face angle) tool');
  await selectPart('Bench');
  await page.keyboard.press('b');
  const facePts = await page.evaluate(visibleFacePoints, 2);
  check(facePts.length === 2, `found two visible faces with different normals on the Bench (${facePts.length})`);
  for (const pt of facePts) await page.mouse.click(pt.x, pt.y);
  const bevelText = await page.locator('#measureLabels .measureLabel').last().innerText().catch(() => '');
  check(/90\.0° between faces/.test(bevelText), `bevel between two faces of a square board reads 90.0° (${bevelText})`);
  await page.screenshot({ path: path.join(OUT, '05-bevel.png') });
  await page.keyboard.press('Control+z');
  check(await page.locator('#measureLabels .measureLabel').count() === 0, 'Ctrl+Z undoes the last measurement');
  await page.keyboard.press('Escape');
  check(await page.locator('#measureBevelBtn.on').count() === 0, 'Esc leaves the measuring tool');

  console.log('angle referenced to level');
  await selectPart('Jaw Lower');
  const jawCard = await page.locator('#dimCard').innerText();
  check(/16\.9° off level/.test(jawCard), `a part tilted off level is described against level (${jawCard.split('\n').find((l) => l.includes('°'))})`);
  await page.screenshot({ path: path.join(OUT, '06-jaw-lower.png') });

  console.log('views, ortho, explode, section, isolate');
  await page.keyboard.press('Escape');
  await page.keyboard.press('2');
  await page.waitForTimeout(600);
  check(await page.evaluate(() => window.__viewer.camera.isOrthographicCamera), 'Front view switches to orthographic');
  await page.screenshot({ path: path.join(OUT, '07-front-ortho.png') });
  await page.keyboard.press('1');
  await page.waitForTimeout(600);
  check(await page.evaluate(() => !window.__viewer.camera.isOrthographicCamera), '3D view switches back to perspective');
  await page.locator('#explodeRange').fill('1');
  await page.waitForTimeout(100);
  const moved = await page.evaluate(() => window.__viewer.scene.getObjectByName('Legs_Leg_Front').position.length());
  check(moved > 1, `explode moves parts apart (${moved.toFixed(1)}")`);
  await page.screenshot({ path: path.join(OUT, '08-exploded.png') });
  await selectPart('Leg Front');
  const labelsExploded = await page.locator('#axisLabels .axisLabel').count();
  check(labelsExploded >= 3, 'dimension callouts still drawn on an exploded part');
  await page.screenshot({ path: path.join(OUT, '09-exploded-selected.png') });
  await page.locator('#resetBtn').click();
  check(await page.evaluate(() => window.__viewer.scene.getObjectByName('Legs_Leg_Front').position.length()) < 1e-6, 'Show all resets the explode');
  await page.selectOption('#sectionAxis', 'z');
  await page.locator('#sectionRange').fill('0.5');
  await page.waitForTimeout(100);
  const clipped = await page.evaluate(() => window.__viewer.scene.getObjectByName('Body_Bench').material.clippingPlanes.length);
  check(clipped === 1, 'section cut applies a clipping plane');
  await page.screenshot({ path: path.join(OUT, '10-section.png') });
  await page.selectOption('#sectionAxis', 'off');
  await selectPart('Seat Block');
  await page.keyboard.press('i');
  const hiddenOthers = await page.evaluate(() => window.__viewer.scene.getObjectByName('Body_Bench').visible);
  check(hiddenOthers === false, 'Isolate hides the other parts');
  await page.screenshot({ path: path.join(OUT, '11-isolate.png') });
  await page.keyboard.press('i');

  console.log('keyboard navigation + deep link');
  await selectPart('Bench');
  await page.keyboard.press('ArrowDown');
  const afterDown = await page.locator('#clList .row.active .name').innerText();
  check(afterDown.trim() === 'Filler Front', `ArrowDown moves to the next part (${afterDown.trim()})`);
  check(page.url().endsWith('#part=Filler_Front'), `URL hash tracks the selection (${page.url().split('#')[1]})`);

  console.log('cut list controls');
  await page.fill('#clSearch', 'leg');
  const filtered = await page.locator('#clList .row').count();
  check(filtered === 2, `filter narrows the list (${filtered} rows for "leg")`);
  await page.fill('#clSearch', '');
  await page.selectOption('#clUnits', 'mm');
  const mmDims = await page.locator('#clList .row', { hasText: 'Bench' }).first().locator('.dims').innerText();
  check(/41\.3 mm × 201 mm × 1177 mm/.test(mmDims), `metric units (${mmDims})`);
  await page.selectOption('#clUnits', 'in16');
  await page.check('#clRough');
  const rough = await page.locator('#clList .row', { hasText: 'Bench' }).first().locator('.rough').innerText();
  check(/8\/4 × 8-1\/8" × 47-3\/8"/.test(rough), `rough stock for the Bench (${rough})`);
  await page.screenshot({ path: path.join(OUT, '12-rough.png') });
  await page.locator('.cat-title', { hasText: 'Hardware' }).locator('.eye').click();
  const rodVisible = await page.evaluate(() => window.__viewer.scene.getObjectByName('Hardware_Hardware_6_7_8_Shaft_1_2__13_6_7_8')?.visible);
  check(rodVisible === false, 'hiding a category hides its parts in 3D');
  await page.locator('.cat-title', { hasText: 'Hardware' }).locator('.eye').click();

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#clCsv')]);
  const csv = fs.readFileSync(await download.path(), 'utf8');
  check(csv.split('\r\n')[0].startsWith('Category,Group,Part,Qty,Thickness,Width,Length'), 'CSV export has a header row');
  check(csv.includes('Wood,Legs,Leg Rear,2,"1-5/8""","3-3/8""","20-7/8"""'), 'CSV export contains the rear legs (inch marks quoted)');
  fs.writeFileSync(path.join(OUT, 'cut-list.csv'), csv);

  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  const printRows = await page.locator('#printSheet tbody tr').count();
  check(await page.locator('#printSheet .ps-diagrams .cd-board').count() >= 5, 'print sheet includes the cutting diagrams');
  check(printRows === 24, `print sheet lists every part (${printRows})`);
  await page.emulateMedia({ media: 'print' });
  await page.pdf({ path: path.join(OUT, 'cut-sheet.pdf'), format: 'Letter', margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' } });
  await page.screenshot({ path: path.join(OUT, '15-print.png'), clip: { x: 0, y: 0, width: 1400, height: 900 } });
  await page.emulateMedia({ media: 'screen' });

  console.log('full-size template');
  await selectPart('Leg Front');
  check(await page.locator('#dimCard [data-act="template"]').count() === 1, 'wood part card offers a full-size template');
  const tpl = await page.evaluate(() => {
    window.__viewer.prepareTemplate();
    const img = document.querySelector('#printSheet .tpl-tile img');
    return { pages: document.querySelectorAll('#printSheet .tpl-page').length, w: img.style.width, h: img.style.height };
  });
  // Leg Front is 27-1/8" x 3-13/16" (+0.3" border each side): face view needs 4 letter tiles across
  check(tpl.pages >= 5 && /^27\.7\d*in$/.test(tpl.w), `template is tiled at true size (${tpl.pages} pages, face ${tpl.w} × ${tpl.h})`);
  await page.emulateMedia({ media: 'print' });
  await page.pdf({ path: path.join(OUT, 'template-leg-front.pdf'), format: 'Letter' });
  check(await page.locator('#printSheet .tpl-page').count() === tpl.pages, 'printing keeps the template (not the cut sheet)');
  await page.screenshot({ path: path.join(OUT, '17-template-print.png') });
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => { window.__viewer.endTemplate(); document.getElementById('printSheet').innerHTML = ''; });

  console.log('cutting diagram');
  await page.keyboard.press('c');
  check(await page.locator('#diagram').isVisible(), 'C opens the cutting diagram');
  const boards = await page.locator('#diagram .cd-board').count();
  const shop = await page.locator('#diagram .cd-shop').innerText();
  check(boards >= 5 && /8\/4 Wood/.test(shop), `diagram lays parts out on boards (${boards} boards)`);
  const partsInDiagram = await page.locator('#diagram .part').count();
  check(partsInDiagram === 26, `every wood piece appears once in the diagram (${partsInDiagram}/26)`);
  await page.screenshot({ path: path.join(OUT, '16-cutting-diagram.png') });
  await page.fill('#cdWidth', '12');
  await page.locator('#cdWidth').dispatchEvent('change');
  const boardsWide = await page.locator('#diagram .cd-board').count();
  check(boardsWide <= boards, `wider stock needs no more boards (${boards} -> ${boardsWide})`);
  await page.fill('#cdWidth', '8');
  await page.locator('#cdWidth').dispatchEvent('change');
  await page.locator('#diagram .part').first().click();
  check(!(await page.locator('#diagram').isVisible()) && await page.locator('#clList .row.active').count() === 1, 'clicking a piece in the diagram selects that part');

  const selectedBeforeReload = (await page.locator('#clList .row.active .name').innerText()).trim();

  console.log('cut tracking persists');
  await page.locator('#clList .row', { hasText: 'Leg Rear' }).first().locator('.cut-box').check();
  await page.reload();
  await page.waitForFunction(() => document.getElementById('loading').style.display === 'none', null, { timeout: 30000 });
  check(await page.locator('#clList .row.cut', { hasText: 'Leg Rear' }).count() === 1, 'ticked-off part stays ticked after reload');
  const selectedAfterReload = (await page.locator('#clList .row.active .name').innerText().catch(() => '')).trim();
  check(selectedAfterReload === selectedBeforeReload, `reload restores the selection from the URL hash (${selectedAfterReload})`);
  check(await page.locator('#clRough').isChecked(), 'settings persist across reload');

  console.log('help');
  await page.keyboard.press('?');
  check(await page.locator('#help').isVisible(), '? opens the shortcut sheet');
  await page.screenshot({ path: path.join(OUT, '13-help.png') });
  await page.keyboard.press('Escape');

  console.log('mobile layout');
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '14-mobile.png') });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(!overflow, 'no horizontal overflow at phone width');

  check(errors.length === 0, `no page errors${errors.length ? ':\n    ' + errors.join('\n    ') : ''}`);
} finally {
  await browser.close();
}

// ---------- failure modes ----------
{
  console.log('load failures explain themselves');
  const b2 = await chromium.launch(launchOpts);
  const p2 = await b2.newPage();
  await p2.route(/unpkg\.com/, (route) => route.abort());
  await p2.clock.install();
  await p2.goto(base);
  await p2.clock.fastForward(13000);
  const msg = await p2.locator('#loading').innerText();
  check(/Couldn't load the 3D library/.test(msg), 'blocked CDN shows a helpful message');
  const p3 = await b2.newPage();
  await p3.route(/^https:\/\/unpkg\.com\/three@[^/]+\/(.*)$/, (route) => {
    const rel = route.request().url().replace(/^https:\/\/unpkg\.com\/three@[^/]+\//, '');
    route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(path.join(THREE_DIR, rel)) });
  });
  await p3.route(/scene\.obj$/, (route) => route.fulfill({ status: 404 }));
  await p3.goto(base);
  await p3.waitForFunction(() => document.getElementById('loading').classList.contains('load-error'), null, { timeout: 30000 });
  check(/Failed to load the model/.test(await p3.locator('#loading').innerText()), 'missing model file shows a helpful message');
  await b2.close();
}
server.close();

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
