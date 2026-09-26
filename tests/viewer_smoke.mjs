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


// part names without the plan letter badge
const nameOnly = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
const activeRowName = () => page.locator('#clList .row.active .name').evaluate(nameOnly);
const cardName = () => page.locator('#dimCard .part-name').evaluate(nameOnly);

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
  check(await page.locator('#introTip').isVisible(), 'first visit shows the welcome tips');
  await page.screenshot({ path: path.join(OUT, '01-loaded.png') });
  await page.locator('#introClose').click();
  check(!(await page.locator('#introTip').isVisible()), 'tips can be dismissed');

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
        if (document.querySelector('#clList .row.active')) return document.querySelector('#clList .row.active .name').lastChild.textContent.trim();
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

  console.log('zoom');
  const d0 = await page.evaluate(() => window.__viewer.camera.position.distanceTo(window.__viewer.controls.target));
  await page.mouse.move(400, 400);
  await page.mouse.wheel(0, 500); // one big notch
  await page.waitForTimeout(150);
  const d1 = await page.evaluate(() => window.__viewer.camera.position.distanceTo(window.__viewer.controls.target));
  check(Math.abs(d1 / d0 - 1.08) < 0.01, `mouse wheel zooms one fixed 8% step regardless of scroll size (${(d1 / d0).toFixed(3)})`);

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
  const cutAt = await page.evaluate(() => window.__viewer.scene.getObjectByName('Body_Bench').material.clippingPlanes[0]?.constant);
  check(Math.abs(Math.abs(cutAt) - 9.19) < 0.2, `choosing a section axis cuts through the middle straight away (${cutAt?.toFixed(2)})`);
  await page.locator('#sectionRange').fill('0.5');
  await page.waitForTimeout(100);
  const clipped = await page.evaluate(() => window.__viewer.scene.getObjectByName('Body_Bench').material.clippingPlanes.length);
  check(clipped === 1, 'section cut applies a clipping plane');
  const capOn = await page.evaluate(() => window.__viewer.scene.children.some((o) => o.isMesh && o.material.stencilWrite && o.visible));
  check(capOn, 'section cut shows hatched caps on the cut faces');
  await page.screenshot({ path: path.join(OUT, '10-section.png') });
  await page.selectOption('#sectionAxis', 'off');
  await selectPart('Seat Block');
  await page.keyboard.press('i');
  const hiddenOthers = await page.evaluate(() => window.__viewer.scene.getObjectByName('Body_Bench').visible);
  check(hiddenOthers === false, 'Isolate hides the other parts');
  await page.screenshot({ path: path.join(OUT, '11-isolate.png') });
  await page.keyboard.press('i');

  console.log('keyboard navigation + deep link');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowUp');
  const lastClickable = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#clList .row:not(.disabled) .name')];
    return rows[rows.length - 1].lastChild.textContent.trim();
  });
  check((await activeRowName()) === lastClickable, `ArrowUp with nothing selected picks the last part (${lastClickable})`);
  await selectPart('Bench');
  await page.keyboard.press('ArrowDown');
  const afterDown = await activeRowName();
  check(afterDown === 'Filler Front', `ArrowDown moves to the next part (${afterDown})`);
  check(page.url().endsWith('#part=Filler_Front'), `URL hash tracks the selection (${page.url().split('#')[1]})`);

  await page.locator('#clList .row', { hasText: 'Jaw Support' }).first().focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check((await cardName()) === 'Jaw Support', 'a focused cut-list row selects with Enter');

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
  check(csv.split('\r\n')[0].startsWith('Ref,Category,Group,Part,Qty,Thickness,Width,Length'), 'CSV export has a header row');
  check(/,Wood,Legs,Leg Rear,2,/.test(csv) && csv.includes('Wood,Legs,Leg Rear,2,"1-5/8""","3-3/8""","20-7/8"""'), 'CSV export contains the rear legs (inch marks quoted)');
  fs.writeFileSync(path.join(OUT, 'cut-list.csv'), csv);

  await page.locator('#explodeRange').fill('1');
  await page.selectOption('#sectionAxis', 'x');
  // make a measurement on the (exploded) bench first
  await selectPart('Bench');
  await page.keyboard.press('Escape'); // leave the section slider / focus
  await selectPart('Bench');
  await page.locator('#measureDistBtn').click();
  for (const pt of await page.evaluate(visibleFacePoints, 2)) await page.mouse.click(pt.x, pt.y);
  await page.locator('#measureDistBtn').click();
  const nMeasures = await page.evaluate(() => window.__viewer.measure.measurements.length);
  const measureShown = await page.evaluate(() => {
    const { measure } = window.__viewer;
    const seen = [];
    const orig = window.__viewer.renderer.render.bind(window.__viewer.renderer);
    window.__viewer.renderer.render = (sc, cam) => { seen.push(measure.measurements.some((m) => m.group.visible)); orig(sc, cam); };
    window.dispatchEvent(new Event('beforeprint'));
    window.__viewer.renderer.render = orig;
    return seen.slice(0, 2);
  });
  check(nMeasures === 1 && measureShown.length === 2 && measureShown.every((v) => !v), `measurements are hidden in the print pictures (${nMeasures} measurement, visible during captures: ${measureShown})`);
  check(await page.evaluate(() => window.__viewer.measure.measurements.every((m) => m.group.visible)), 'and shown again afterwards');
  await page.locator('#clearMeasureBtn').click();
  const overviewSrc = await page.locator('#printSheet .ps-img').first().getAttribute('src');
  fs.writeFileSync(path.join(OUT, 'print-overview.png'), Buffer.from(overviewSrc.split(',')[1], 'base64'));
  const explodedSrc = await page.locator('#printSheet .ps-img').nth(1).getAttribute('src');
  fs.writeFileSync(path.join(OUT, 'print-exploded.png'), Buffer.from(explodedSrc.split(',')[1], 'base64'));
  check(await page.locator('#printSheet .ps-img').count() === 2, 'print sheet has assembled and exploded pictures');
  check(await page.evaluate(() => window.__viewer.scene.getObjectByName('Legs_Leg_Front').position.length() > 1), 'explode state restored after the print capture');
  await page.selectOption('#sectionAxis', 'off');
  await page.locator('#resetBtn').click();
  const printRows = await page.locator('#printSheet > table tbody tr').count();
  check(await page.locator('#printSheet .ps-diagrams .cd-board').count() >= 5, 'print sheet includes the cutting diagrams');
  const drill = await page.locator('#printSheet h2', { hasText: 'Holes to drill' }).count();
  check(drill === 1, 'print sheet includes a drilling list');
  check(printRows === 24, `print sheet lists every part (${printRows})`);
  await page.emulateMedia({ media: 'print' });
  await page.pdf({ path: path.join(OUT, 'cut-sheet.pdf'), format: 'Letter', margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' } });
  await page.screenshot({ path: path.join(OUT, '15-print.png'), clip: { x: 0, y: 0, width: 1400, height: 900 } });
  await page.emulateMedia({ media: 'screen' });

  console.log('joins and holes');
  await selectPart('Bench');
  const rel = (await page.locator('#dimCard .card-rel').allInnerTexts()).join(' | ');
  check(/Joins:.*Leg Rear/.test(rel) && /4 × ⌀1\/2"/.test(rel), `bench card lists joined parts and its 4 rod holes (${rel})`);
  await page.locator('#dimCard .card-rel a', { hasText: 'Leg Rear' }).click();
  await page.waitForTimeout(200);
  check((await cardName()) === 'Leg Rear', 'clicking a joined part selects it');
  await page.evaluate(() => { const v = window.__viewer; v.selectRow(v.rows().find((r) => r.label === 'Shaft_1_2_-13_6_7_8')); });
  const bore = await page.locator('#dimCard .card-rel').innerText();
  check(/Bore ⌀1\/2".*Bench ×2.*Filler Rear.*Leg Rear ×2/.test(bore), `rod card is a drilling list (${bore})`);

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
  check(/Threaded Rod 1\/2"-13: 4 pieces \(6-7\/8" ×2, 5-1\/16" ×2\), 23-7\/8" total — buy 3'/.test(shop), 'hardware list totals rod by size with a stock length to buy');
  await page.fill('.cd-prices input[data-mat="Wood"]', '8');
  await page.locator('.cd-prices input[data-mat="Wood"]').dispatchEvent('change');
  const priced = await page.locator('#diagram .cd-shop').innerText();
  check(/Lumber estimate: \$\d+\.\d\d/.test(priced), `price per board foot gives a cost estimate (${(priced.match(/Lumber estimate: [^\n]*/) || [''])[0]})`);
  await page.screenshot({ path: path.join(OUT, '16-cutting-diagram.png') });
  const finish = (shop.match(/about ([\d.]+) sq ft/) || [])[1];
  check(finish && +finish > 10 && +finish < 60, `finish estimate is a plausible surface area (${finish} sq ft)`);
  const mill = await page.locator('#diagram .cd-mill').innerText();
  check(/Plane to thickness[\s\S]*1-5\/8"\s*6 pc[\s\S]*Bench ×2, Leg Rear ×2, Treadle Beam ×2/.test(mill), 'milling plan groups parts by planer setting');
  await page.fill('#cdWidth', '12');
  await page.locator('#cdWidth').dispatchEvent('change');
  const boardsWide = await page.locator('#diagram .cd-board').count();
  check(boardsWide <= boards, `wider stock needs no more boards (${boards} -> ${boardsWide})`);
  await page.fill('#cdWidth', '8');
  await page.locator('#cdWidth').dispatchEvent('change');
  await page.locator('#diagram .part').first().click();
  check(!(await page.locator('#diagram').isVisible()) && await page.locator('#clList .row.active').count() === 1, 'clicking a piece in the diagram selects that part');

  console.log('user notes');
  await selectPart('Seat');
  await page.locator('#dimCard .card-mynote summary').click();
  await page.locator('#dimCard .card-mynote textarea').fill('carve from the walnut slab');
  check(await page.locator('#dimCard .card-mynote textarea').evaluate((el) => document.activeElement === el), 'typing a note keeps focus in the note');
  check((await page.locator('#clList .row.active .note.mine').innerText()).includes('walnut slab'), 'note shows in the cut list');
  check(await page.evaluate(() => window.__viewer.current !== null), 'typing a note (with letters like f/i/e) does not trigger shortcuts');
  await page.keyboard.press('Escape');
  const selectedBeforeReload = await activeRowName();

  console.log('cut tracking persists');
  await page.locator('#clList .row', { hasText: 'Leg Rear' }).first().locator('.cut-box').check();
  await page.reload();
  await page.waitForFunction(() => document.getElementById('loading').style.display === 'none', null, { timeout: 30000 });
  check(await page.locator('#clList .row.cut', { hasText: 'Leg Rear' }).count() === 1, 'ticked-off part stays ticked after reload');
  check(/2 of 26 pieces cut/.test(await page.locator('.progress').innerText()), 'progress counts pieces (Leg Rear ×2 = 2 of 26)');
  const selectedAfterReload = await activeRowName().catch(() => '');
  check(selectedAfterReload === selectedBeforeReload, `reload restores the selection from the URL hash (${selectedAfterReload})`);
  check(await page.locator('#clRough').isChecked(), 'settings persist across reload');
  check(await page.locator('#clList .note.mine', { hasText: 'walnut slab' }).count() === 1, 'user notes persist across reload');
  check(!(await page.locator('#introTip').isVisible()), 'dismissed tips stay dismissed');

  console.log('help');
  await page.keyboard.press('?');
  check(await page.locator('#help').isVisible(), '? opens the shortcut sheet');
  await page.screenshot({ path: path.join(OUT, '13-help.png') });
  await page.keyboard.press('Escape');

  console.log('part letters');
  await page.locator('#resetBtn').click();
  await page.locator('#explodeRange').fill('0.8');
  await page.locator('#tagsBtn').click();
  await page.waitForTimeout(200);
  const tagCount = await page.locator('#partTags .partTag').count();
  check(tagCount >= 30, `Labels tag every part in 3D (${tagCount})`);
  await page.screenshot({ path: path.join(OUT, '19-exploded-labels.png') });
  await page.locator('#tagsBtn').click();
  await page.locator('#resetBtn').click();
  check((await page.locator('#clList .row .letter').first().innerText()) === 'A', 'cut-list rows are lettered A, B, C…');

  console.log('light theme');
  await page.keyboard.press('l');
  check(await page.evaluate(() => document.documentElement.dataset.theme) === 'light', 'L switches to the light theme');
  await selectPart('Leg Rear');
  await page.screenshot({ path: path.join(OUT, '18-light-theme.png') });
  await page.keyboard.press('l');
  check(await page.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'and back to dark');

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

// ---------- ?model= loads data from a subfolder ----------
{
  console.log('model folder parameter');
  const sub = path.join(VIEWER, '_test_model');
  fs.mkdirSync(sub, { recursive: true });
  for (const f of ['model.json', 'materials.json', 'object_dims.json', 'parts_report.json', 'scene.obj', 'scene.mtl']) {
    fs.copyFileSync(path.join(VIEWER, f), path.join(sub, f));
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(sub, 'model.json'), 'utf8'));
  cfg.title = 'Test Copy';
  fs.writeFileSync(path.join(sub, 'model.json'), JSON.stringify(cfg));
  // two rows sharing a label at different sizes: move Filler Front's mesh to a second "Bench" row
  const report = JSON.parse(fs.readFileSync(path.join(sub, 'parts_report.json'), 'utf8'));
  const ff = report.find((r) => r.label === 'Filler_Front');
  report.push({ ...ff, label: 'Bench', dims: [7.9, 2.9, 2.01], dims_str: '7-7/8" x 2-7/8" x 2"' });
  report.splice(report.indexOf(ff), 1);
  fs.writeFileSync(path.join(sub, 'parts_report.json'), JSON.stringify(report));
  const b2 = await chromium.launch(launchOpts);
  const p2 = await b2.newPage();
  await p2.route(/^https:\/\/unpkg\.com\/three@[^/]+\/(.*)$/, (route) => {
    const rel = route.request().url().replace(/^https:\/\/unpkg\.com\/three@[^/]+\//, '');
    route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(path.join(THREE_DIR, rel)) });
  });
  try {
    await p2.goto(`${base}?model=_test_model`);
    await p2.waitForFunction(() => document.getElementById('loading').style.display === 'none', null, { timeout: 30000 });
    check((await p2.locator('#sidebar h1').innerText()) === 'Test Copy', '?model= loads another model folder');
    await p2.locator('#clList .row', { hasText: '2" × 2-7/8" × 7-7/8"' }).first().click();
    const ref = decodeURIComponent(new URL(p2.url()).hash);
    check(/^#part=Bench@\d$/.test(ref), `duplicate labels get a distinct link (${ref})`);
    await p2.reload();
    await p2.waitForFunction(() => document.getElementById('loading').style.display === 'none', null, { timeout: 30000 });
    const reopened = await p2.locator('#dimCard .dim-big').innerText();
    check(reopened.startsWith('2" × 2-7/8"'), `that link reopens the right one of the two (${reopened})`);
    await p2.goto(`${base}?model=../../etc`);
    await p2.waitForFunction(() => document.getElementById('loading').style.display === 'none', null, { timeout: 30000 });
    check((await p2.locator('#sidebar h1').innerText()) === 'Shaving Horse', '?model= ignores paths that climb out of the viewer');
  } finally {
    await b2.close();
    fs.rmSync(sub, { recursive: true, force: true });
  }
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
