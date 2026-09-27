// Headless smoke test for viewer/index.html.
//
// Serves viewer/ from a throwaway local HTTP server, loads it in Chromium, and
// drives every feature, checking results and that nothing logs an error or
// fetches anything from outside the viewer folder (it must work offline).
//
//   npm install && npm test
//
// Screenshots land in test-output/ for eyeballing.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium, devices } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWER = path.join(ROOT, 'viewer');
const OUT = path.join(ROOT, 'test-output');
fs.mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.obj': 'text/plain', '.mtl': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
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

const offsite = [];
page.on('request', (req) => { if (!req.url().startsWith(base) && !req.url().startsWith('data:') && !req.url().startsWith('blob:')) offsite.push(req.url()); });


// part names without the plan letter badge
const nameOnly = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
const activeRowName = () => page.locator('#clList .row.active .name').evaluate(nameOnly);
const cardName = () => page.locator('#dimCard .part-name .pn-text').innerText();

async function selectPart(name) {
  await page.locator('#clList .row', { hasText: name }).first().click();
  await page.waitForTimeout(500);
}

// Runs in the page: where the selected part's middle is on screen.
function partScreenCenter() {
  const { THREE, camera, current } = window.__viewer;
  const c = current.box.getCenter(new THREE.Vector3()).project(camera);
  const r = document.querySelector('#viewport canvas').getBoundingClientRect();
  return { x: r.left + (c.x * 0.5 + 0.5) * r.width, y: r.top + (0.5 - c.y * 0.5) * r.height };
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
  const warns = await page.locator('#clList .note.warn').allInnerTexts();
  check(warns.length === 2 && warns.some((w) => w.includes('Named 8-1/4"')), `rods whose names disagree with their geometry are flagged (${warns.length})`);
  const disabled = await page.locator('#clList .row.disabled').count();
  const expectedDisabled = report.filter((r) => !r.obj_names || !r.obj_names.length).length;
  check(disabled === expectedDisabled, `rows with no 3D geometry are disabled (${disabled}/${expectedDisabled})`);
  check(await page.locator('#introTip').isVisible(), 'first visit shows the welcome tips');
  await page.screenshot({ path: path.join(OUT, '01-loaded.png') });
  await page.locator('#introClose').click();
  check(!(await page.locator('#introTip').isVisible()), 'tips can be dismissed');
  await page.waitForTimeout(1500);
  const frames = await page.evaluate(async () => {
    const info = window.__viewer.renderer.info.render;
    const a = info.frame;
    await new Promise((r) => setTimeout(r, 1000));
    const b = info.frame;
    window.__viewer.controls.rotateLeft?.(0.2);
    window.__viewer.requestRender();
    await new Promise((r) => setTimeout(r, 300));
    return { idle: b - a, after: info.frame - b };
  });
  check(frames.idle === 0 && frames.after > 0, `nothing is redrawn while the model sits still, and it redraws when asked (${frames.idle} idle frames, ${frames.after} after)`);

  console.log('select from sidebar');
  const bench = page.locator('#clList .row', { hasText: 'Bench' }).first();
  await bench.click();
  await page.waitForTimeout(300);
  check(await bench.evaluate((el) => el.classList.contains('active')), 'clicked row is marked active');
  const cardBg = await page.locator('#dimCard').evaluate((el) => getComputedStyle(el).backgroundColor);
  check(!/rgba\(0, 0, 0, 0\)|transparent/.test(cardBg), `part card has an opaque background (${cardBg})`);
  await page.locator('#dimCard .card-min').click();
  check(!(await page.locator('#dimCard .meta').isVisible()) && await page.locator('#dimCard .dim-big').isVisible(), 'part card collapses to name + size');
  await page.locator('#dimCard .card-min').click();
  const card = await page.locator('#dimCard').innerText();
  check(card.includes('46-3/8"'), 'dimension card shows the Bench length');
  const axisLabels = await page.locator('#axisLabels .axisLabel').count();
  check(axisLabels >= 3, `dimension gizmo draws L/W/T labels (${axisLabels})`);
  await page.screenshot({ path: path.join(OUT, '02-bench.png') });

  console.log('angled part');
  await page.locator('#clList .row', { hasText: 'Leg Rear' }).first().click();
  await page.waitForTimeout(300);
  check(!/off plumb/.test(await page.locator('#dimCard').innerText()) && !(await page.locator('#axisLabels .axisLabel').allInnerTexts()).some((t) => t.includes('°')),
    'the part\'s own angles are hidden until asked for (only your measurements show)');
  await page.locator('#dimCard [data-act=angles]').click();
  const legCard = await page.locator('#dimCard').innerText();
  check(/off plumb/.test(legCard) && (await page.locator('#axisLabels .axisLabel').allInnerTexts()).some((t) => t.includes('°')), '"Show angles" shows the splayed rear leg\'s compound angle');
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

  console.log('drag keeps the selection');
  await selectPart('Bench');
  const cam0 = await page.evaluate(() => window.__viewer.camera.position.toArray());
  const vpBox = await page.locator('#viewport canvas').boundingBox();
  // drag from an empty corner of the view across to another empty spot
  await page.mouse.move(vpBox.x + 40, vpBox.y + vpBox.height - 120);
  await page.mouse.down();
  await page.mouse.move(vpBox.x + 200, vpBox.y + vpBox.height - 160, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const cam1 = await page.evaluate(() => window.__viewer.camera.position.toArray());
  check(cam0.some((v, i) => Math.abs(v - cam1[i]) > 0.5), 'dragging orbits the view');
  check((await activeRowName()) === 'Bench', 'dragging the view keeps the part selected');
  await page.mouse.click(vpBox.x + 40, vpBox.y + vpBox.height - 120);
  check(await page.locator('#clList .row.active').count() === 0, 'a plain click on empty space still deselects');

  console.log('angle tool: outline-box corners and axis lock');
  await selectPart('Bench');
  await page.keyboard.press('a');
  const toScreen = (p) => page.evaluate((pt) => {
    const { THREE, camera } = window.__viewer;
    const r = document.querySelector('#viewport canvas').getBoundingClientRect();
    const v = new THREE.Vector3(...pt).project(camera);
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (0.5 - v.y * 0.5) * r.height };
  }, p);
  // an outline-box corner of the first bench half
  const corners = await page.evaluate(() => window.__viewer.guidePoints().filter((g) => g.kind === 'corner').map((g) => g.p.toArray()));
  const cs = await Promise.all(corners.map(toScreen));
  const onScreen = cs.map((c, i) => ({ c, i })).filter(({ c }) => c.x > vpBox.x + 20 && c.x < vpBox.x + vpBox.width - 20 && c.y > vpBox.y + 60 && c.y < vpBox.y + vpBox.height - 60);
  const target = onScreen[0];
  await page.mouse.move(target.c.x + 3, target.c.y + 2);
  await page.waitForTimeout(100);
  check(/Corner of outline box/.test(await page.locator('.snapTag').innerText()), 'hovering near an outline-box corner shows the corner snap');
  await page.mouse.click(target.c.x + 3, target.c.y + 2);
  const firstPt = await page.evaluate(() => window.__viewer.measure.points[0].p.toArray());
  check(firstPt.every((v, k) => Math.abs(v - corners[target.i][k]) < 1e-6), 'clicking snaps exactly onto the invisible box corner');
  // axis lock: aim along the part's length from that corner, a bit off the line
  const len = await page.evaluate(() => window.__viewer.guideAxes()[0].dir.toArray());
  const along = await toScreen(corners[target.i].map((v, k) => v + len[k] * 10));
  const back = await toScreen(corners[target.i].map((v, k) => v - len[k] * 10));
  const aim = (along.x > vpBox.x + 20 && along.x < vpBox.x + vpBox.width - 20) ? along : back;
  await page.mouse.move(aim.x + 4, aim.y + 3);
  await page.waitForTimeout(100);
  const lockTag = await page.locator('.snapTag').innerText();
  check(/On length/.test(lockTag), `moving roughly along the length locks onto that axis (${lockTag})`);
  await page.screenshot({ path: path.join(OUT, '20-angle-axis-lock.png') });
  // where a locked line crosses a real edge of the part: hover near it and click
  const crossings = await page.evaluate(() => window.__viewer.measure.crossings()
    .filter((x) => x.what === 'edge').map((x) => ({ p: x.p.toArray(), axis: x.axis.name })));
  check(crossings.length > 0, `locked lines from the first point cross the part's edges (${crossings.length} crossings)`);
  let crossHit = null;
  for (const x of crossings) {
    const sp = await toScreen(x.p);
    if (sp.x < vpBox.x + 30 || sp.x > vpBox.x + vpBox.width - 30 || sp.y < vpBox.y + 70 || sp.y > vpBox.y + vpBox.height - 70) continue;
    await page.mouse.move(sp.x + 5, sp.y + 4);
    await page.waitForTimeout(60);
    const tag = await page.locator('.snapTag').innerText();
    if (/^Where .* meets an edge/.test(tag)) { crossHit = { x, sp, tag }; break; }
  }
  check(!!crossHit, `hovering near a crossing snaps to it (${crossHit && crossHit.tag})`);
  if (crossHit) {
    await page.screenshot({ path: path.join(OUT, '21-angle-crossing.png') });
    await page.mouse.click(crossHit.sp.x + 5, crossHit.sp.y + 4);
    const second = await page.evaluate(() => window.__viewer.measure.points[1]?.p.toArray());
    check(second && second.every((v, k) => Math.abs(v - crossHit.x.p[k]) < 1e-6), 'clicking lands exactly on the crossing');
  }
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

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
  const lightBg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--card-bg').trim());
  check(/rgba\(255/.test(lightBg), `light theme card background (${lightBg})`);
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

  check(offsite.length === 0, `works offline: no requests outside the viewer folder${offsite.length ? ':\n    ' + offsite.slice(0, 5).join('\n    ') : ''}`);
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
  cfg.notes = { 'Shaft_1_2_-13_8_1_4': 'Author note: use stainless rod' };
  fs.writeFileSync(path.join(sub, 'model.json'), JSON.stringify(cfg));
  // two rows sharing a label at different sizes: move Filler Front's mesh to a second "Bench" row
  const report = JSON.parse(fs.readFileSync(path.join(sub, 'parts_report.json'), 'utf8'));
  const ff = report.find((r) => r.label === 'Filler_Front');
  report.push({ ...ff, label: 'Bench', dims: [7.9, 2.9, 2.01], dims_str: '7-7/8" x 2-7/8" x 2"' });
  report.splice(report.indexOf(ff), 1);
  fs.writeFileSync(path.join(sub, 'parts_report.json'), JSON.stringify(report));
  const b2 = await chromium.launch(launchOpts);
  const p2 = await b2.newPage();
  try {
    await p2.goto(`${base}?model=_test_model`);
    await p2.waitForFunction(() => document.getElementById('loading').style.display === 'none', null, { timeout: 30000 });
    check((await p2.locator('#sidebar h1').innerText()) === 'Test Copy', '?model= loads another model folder');
    const rodNotes = (await p2.locator('#clList .row', { hasText: 'Author note' }).locator('.note').allInnerTexts()).join(' | ');
    check(/Named 8-1\/4"/.test(rodNotes) && /stainless/.test(rodNotes), `a model.json note shows alongside the parser warning (${rodNotes})`);
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

// ---------- uploading models (3D Warehouse Collada zip / KMZ / .dae) ----------
{
  console.log('upload a model');
  const tmp = fs.mkdtempSync(path.join(OUT, 'upload-'));
  const warehouseZip = path.join(tmp, 'Shaker Side Table.zip');
  const kmz = path.join(tmp, 'Step Stool.kmz');
  // what 3D Warehouse's "Collada File" download looks like: a deflated zip with
  // the .dae in a folder next to its textures; KMZ is the same with doc.kml
  execFileSync('python3', ['-c', `
import sys, zipfile
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'tests'))})
import make_fixture
dae = make_fixture.build(sketchup2023=True)
with zipfile.ZipFile(${JSON.stringify(warehouseZip)}, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('model/texture.jpg', b'x' * 10)
    z.writestr('model/Shaker Side Table.dae', dae)
    z.writestr('__MACOSX/model/._Shaker Side Table.dae', b'junk' * 100000)
with zipfile.ZipFile(${JSON.stringify(kmz)}, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('doc.kml', '<kml/>')
    z.writestr('models/untitled.dae', make_fixture.build(unit_meter=0.001, scale=25.4, sketchup2023=True))
`]);
  fs.writeFileSync(path.join(tmp, 'chair.skp'), 'SketchUp binary');
  const b2 = await chromium.launch(launchOpts);
  const ctx = await b2.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const p2 = await ctx.newPage();
  const errs = [];
  p2.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  p2.on('console', (m) => { if (m.type() === 'error' && !/can't be read in a browser/.test(m.text())) errs.push(`console: ${m.text()}`); });
  p2.on('dialog', (d) => d.accept());
  const loaded = () => p2.waitForFunction(() => document.getElementById('loading').style.display === 'none', null, { timeout: 30000 });
  try {
    await p2.goto(base);
    await loaded();
    await p2.locator('#clLibrary').click();
    check(await p2.locator('#library').isVisible(), 'Models button opens the library');
    await p2.waitForSelector('#library .lib-empty');
    check((await p2.locator('#library .lib-item').count()) === 1, 'library starts with just the built-in model');

    await p2.locator('#libFile').setInputFiles(path.join(tmp, 'chair.skp'));
    await p2.waitForFunction(() => document.querySelector('#library .lib-status').classList.contains('error'));
    check(/Collada File/.test(await p2.locator('#library .lib-status').innerText()), '.skp upload explains how to get a Collada file instead');

    await p2.locator('#libFile').setInputFiles(warehouseZip);
    await p2.waitForURL(/\?model=local%3A\w+&setup=1/, { timeout: 30000 });
    await loaded();
    // (it opens once the saved model has been read back, which can lag the page on a slow machine)
    check(await p2.locator('#setup').waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false), 'a new upload opens straight into its setup');
    check(!new URL(p2.url()).searchParams.has('setup'), 'the setup flag leaves the URL (a reload will not reopen it)');
    check((await p2.locator('#setup [name=title]').inputValue()) === 'Shaker Side Table', 'model is named after the uploaded file');
    const mats = await p2.locator('#setup select[data-mat]').evaluateAll((els) => els.map((e) => [e.dataset.mat, e.value]));
    check(mats.some(([m, c]) => m === 'Wood' && c === 'Wood') && !mats.some(([m]) => /edge_color/.test(m)), `materials are listed with a guessed category (${JSON.stringify(mats)})`);
    const rows1 = await p2.locator('#clList .row').count();
    check(rows1 === 5, `uploaded model's cut list is built (${rows1} rows)`);
    const autoNames = await p2.locator('#clList .row .name').evaluateAll((els) => els.map((e) => e.lastChild.textContent.trim()));
    check(['Square stock', 'Dowel'].every((n) => autoNames.includes(n)) && !autoNames.some((n) => /group|geom/i.test(n)), `unnamed parts are named by shape (${autoNames.join(', ')})`);
    check(await p2.locator('#clList > .group-title', { hasText: 'Group 1' }).count() === 1, 'an unnamed group is shown as "Group 1"');
    await p2.screenshot({ path: path.join(OUT, '40-upload-setup.png') });
    await p2.locator('#setup [name=title]').fill('Side Table');
    await p2.locator('#setup [name=front]').selectOption('+Z');
    await Promise.all([p2.waitForEvent('load'), p2.locator('#setup .setup-save').click()]);
    await loaded();
    check((await p2.locator('#sidebar h1').innerText()) === 'Side Table', 'setup saves the new name');
    const front = await p2.evaluate(() => window.__viewer.config.views.front.dir);
    check(JSON.stringify(front) === '[0,0,1]', `setup saves which way is front (${front})`);
    await p2.screenshot({ path: path.join(OUT, '41-uploaded.png') });

    // select a part, tick it, then come back without any ?model=
    await p2.locator('#clList .row', { hasText: 'Board' }).first().click();
    const card = await p2.locator('#dimCard .dim-big').innerText();
    check(/"/.test(card), `uploaded parts can be selected and measured (${card})`);
    await p2.goto(base);
    await loaded();
    check((await p2.locator('#sidebar h1').innerText()) === 'Side Table', 'opening the page again reopens the last uploaded model');

    // KMZ in millimetres lands at the same size
    await p2.locator('#clLibrary').click();
    await p2.locator('#libFile').setInputFiles(kmz);
    await p2.waitForURL(/setup=1/, { timeout: 30000 });
    await loaded();
    await p2.locator('#setup .setup-cancel').click();
    check((await p2.locator('#sidebar h1').innerText()) === 'Step Stool', 'KMZ uploads work and take the file name');
    const dimsA = await p2.locator('#clList .row .dims').allInnerTexts();
    await p2.locator('#clLibrary').click();
    await p2.waitForFunction(() => document.querySelectorAll('#library .lib-item').length === 3).catch(() => {});
    check((await p2.locator('#library .lib-item').count()) === 3, 'library lists built-in + both uploads');
    await p2.locator('#library .lib-item', { hasText: 'Side Table' }).locator('[data-act=open]').click();
    await loaded();
    const dimsB = await p2.locator('#clList .row .dims').allInnerTexts();
    check(dimsA.length > 0 && dimsA.join() === dimsB.join(), `millimetre KMZ measures the same as the inch zip (${dimsA[0]})`);

    // ----- fixing up a model: rename, set aside, delete, groups, undo -----
    const rowNames = () => p2.locator('#clList > .row .name').evaluateAll((els) => els.map((e) => e.lastChild.textContent.trim()));
    const woodPieces = async () => Number((await p2.locator('#clSummary .sum-line b').first().innerText()));
    const piecesBefore = await woodPieces();
    await p2.locator('#clList .row', { hasText: 'Dowel' }).first().click();
    await p2.locator('#dimCard [data-act=aside]').click();
    check(/Set aside "Dowel"/.test(await p2.locator('#toast').innerText()), 'setting a part aside says so, with Undo');
    await p2.locator('#toast [data-act=undo]').click();
    check((await rowNames()).includes('Dowel'), 'the notice\'s Undo button puts it back');
    await p2.locator('#clList .row', { hasText: 'Dowel' }).first().click();
    await p2.locator('#dimCard [data-act=aside]').click();
    check(!(await rowNames()).includes('Dowel') && await p2.locator('.aside-section .row', { hasText: 'Dowel' }).count() === 1, 'a set-aside part moves to "Set aside · not in the build"');
    check(await woodPieces() === piecesBefore - 1, `set-aside parts leave the wood totals (${piecesBefore} -> ${await woodPieces()})`);
    check(await p2.locator('#dimCard .card-aside').isVisible(), 'its card says it is set aside while still selected');
    await p2.keyboard.press('Escape');
    const dowelShown = () => p2.evaluate(() => window.__viewer.rows().length >= 0 && window.__viewer.meshesOf('Dowel').some((m) => m.visible));
    check(!(await dowelShown()), 'set-aside parts are hidden in 3D');
    await p2.locator('.aside-section summary').first().click();
    await p2.locator('.aside-section .show-aside').check();
    check(await dowelShown(), '"Show" draws set-aside parts again');
    await p2.locator('.aside-section .show-aside').uncheck();
    await p2.keyboard.press('Control+z');
    check((await rowNames()).includes('Dowel'), 'Undo puts it back');

    await p2.locator('#clList .row', { hasText: 'Square stock' }).first().click();
    await p2.keyboard.press('Delete');
    check(!(await rowNames()).includes('Square stock') && await p2.locator('.aside-section', { hasText: 'Deleted' }).count() === 1, 'Del deletes the selected part into a "Deleted" list');
    check(!(await p2.locator('#dimCard').isVisible()), 'deleting clears the selection');
    await p2.keyboard.press('Control+z');
    check((await rowNames()).includes('Square stock'), 'Ctrl+Z undoes a delete');
    await p2.keyboard.press('Delete'); // nothing selected: nothing happens
    check((await rowNames()).includes('Square stock'), 'Del with nothing selected does nothing');
    await p2.locator('#clList .row', { hasText: 'Square stock' }).first().click();
    await p2.keyboard.press('Delete');

    await p2.locator('#clList .row', { hasText: 'Board' }).nth(1).click();
    await p2.locator('#dimCard .pn-edit').click();
    await p2.locator('#dimCard .inline-edit').fill('Top rail');
    await p2.keyboard.press('Enter');
    check((await rowNames()).includes('Top rail') && (await p2.locator('#dimCard .part-name').innerText()).includes('Top rail'), 'parts can be renamed from their card');
    await p2.keyboard.press('Escape');
    const g1 = p2.locator('#clList > .group-title', { hasText: 'Group 1' });
    await g1.hover();
    await g1.locator('[data-act=rename]').click();
    await p2.locator('#clList .inline-edit').fill('Stretcher assembly');
    await p2.keyboard.press('Enter');
    check(await p2.locator('#clList > .group-title', { hasText: 'Stretcher assembly' }).count() === 1, 'groups can be renamed');
    await p2.locator('#clList > .group-title .gt-name', { hasText: 'Stretcher assembly' }).click();
    check(/Group · 2 pieces in the build/.test(await p2.locator('#dimCard').innerText()), 'clicking a group heading shows the whole group, with its own card');
    const hl = await p2.evaluate(() => window.__viewer.meshesOf('Top rail').every((m) => m.material.emissiveIntensity > 0));
    check(hl, 'the group is highlighted in 3D');
    await p2.screenshot({ path: path.join(OUT, '42-group.png') });
    await p2.locator('#dimCard [data-act=aside]').click();
    check(!(await rowNames()).includes('Top rail') && !(await rowNames()).includes('Dowel'), '"Set aside group" sets aside all of its parts');
    await p2.locator('#dimCard [data-act=build]').click();
    check((await rowNames()).includes('Top rail'), '...and "Put back in build" returns them');
    await p2.keyboard.press('Escape');

    // edits survive a reload (stored in the uploaded model itself)
    await p2.reload();
    await loaded();
    check((await rowNames()).includes('Top rail') && !(await rowNames()).includes('Square stock')
      && await p2.locator('#clList > .group-title', { hasText: 'Stretcher assembly' }).count() === 1, 'renames and deletes are saved with the model');
    await p2.locator('.aside-section summary', { hasText: 'Deleted' }).click();
    await p2.locator('.aside-section .row', { hasText: 'Square stock' }).locator('[data-act=build]').click();
    check((await rowNames()).includes('Square stock'), 'deleted parts can be restored from the Deleted list');
    await p2.locator('#clList .row', { hasText: 'Square stock' }).first().click();
    await p2.keyboard.press('Delete');
    await p2.screenshot({ path: path.join(OUT, '43-edited.png') });

    // download, delete, re-import the download
    await p2.locator('#clLibrary').click();
    const [dl] = await Promise.all([p2.waitForEvent('download'), p2.locator('#library .lib-item', { hasText: 'Side Table' }).locator('[data-act=export]').click()]);
    const saved = path.join(tmp, dl.suggestedFilename());
    await dl.saveAs(saved);
    check(dl.suggestedFilename() === 'side-table.zip', `Download saves a zip named after the model (${dl.suggestedFilename()})`);
    const listing = execFileSync('python3', ['-c', `import zipfile; print('\\n'.join(zipfile.ZipFile(${JSON.stringify(saved)}).namelist()))`]).toString();
    check(/side-table\/model\.json/.test(listing) && /side-table\/scene\.obj/.test(listing), 'the zip holds the six data files in a folder (drop it next to the viewer and use ?model=)');
    await p2.locator('#library .lib-item', { hasText: 'Side Table' }).locator('[data-act=delete]').click();
    await p2.waitForURL(/\?model=$/);
    await loaded();
    check((await p2.locator('#sidebar h1').innerText()) === 'Shaving Horse', 'deleting the open model goes back to the built-in one');
    await p2.locator('#clLibrary').click();
    await p2.locator('#libFile').setInputFiles(saved);
    await p2.waitForURL(/setup=1/, { timeout: 30000 });
    await loaded();
    await p2.locator('#setup .setup-cancel').click();
    const again = await p2.evaluate(() => window.__viewer.config.views.front.dir);
    check((await p2.locator('#sidebar h1').innerText()) === 'Side Table' && JSON.stringify(again) === '[0,0,1]', 're-importing a downloaded zip keeps its setup');
    check((await rowNames()).includes('Top rail') && !(await rowNames()).includes('Square stock'), '...and your renames and deletions');
    check(errs.length === 0, `no page errors during uploads${errs.length ? ':\n    ' + errs.join('\n    ') : ''}`);
  } finally {
    await b2.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- overlapping pieces: fixed automatically, lap joints left alone ----------
{
  console.log('overlapping pieces');
  const tmp = fs.mkdtempSync(path.join(OUT, 'overlap-'));
  const dae = path.join(tmp, 'Rail Test.dae');
  execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'tests'))}); import make_fixture; open(${JSON.stringify(dae)}, 'w').write(make_fixture.build(overlap=True, lap=True))`]);
  const b2 = await chromium.launch(launchOpts);
  const p2 = await b2.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  p2.on('pageerror', (e) => errs.push(e.message));
  const loaded = () => p2.waitForFunction(() => document.getElementById('loading').style.display === 'none', null, { timeout: 30000 });
  const rowsOf = (label) => p2.locator('#clList > .row', { hasText: label }).evaluateAll((els) => els.map((e) => e.querySelector('.dims').textContent + ' ' + e.querySelector('.qty').textContent));
  const boardRows = () => rowsOf('Board');
  try {
    await p2.goto(base);
    await loaded();
    await p2.locator('#clLibrary').click();
    await p2.locator('#libFile').setInputFiles(dae);
    await p2.waitForURL(/setup=1/, { timeout: 30000 });
    await loaded();
    await p2.locator('#setup .setup-cancel').click();
    check(JSON.stringify(await boardRows()) === JSON.stringify(['1" × 4" × 10" ×1', '1" × 4" × 16" ×1']), `a board modeled as two overlapping boards is joined automatically (${await boardRows()})`);
    check(/Fixed automatically: joined 1 part/.test(await p2.locator('#toast').innerText()), 'a notice says what was fixed automatically');
    const lapRow = await p2.locator('#clList > .row', { hasText: 'Lap rail' }).innerText();
    check(/×2/.test(lapRow) && !/Overlaps/.test(lapRow), `a half-lap joint is real joinery: two boards, no warning (${lapRow.replace(/\n/g, ' ')})`);
    await p2.locator('#clList > .row', { hasText: '16"' }).click();
    check(/Joined automatically/.test(await p2.locator('#dimCard').innerText()), 'the joined part says it was joined automatically');
    check((await p2.locator('#axisLabels .axisLabel').allInnerTexts()).includes('16"'), 'and is dimensioned end to end');
    await p2.locator('#dimCard [data-act=split]').click();
    check(JSON.stringify(await boardRows()) === JSON.stringify(['1" × 4" × 10" ×3']), '"Split apart" undoes an automatic join');
    await p2.reload();
    await loaded();
    check(JSON.stringify(await boardRows()) === JSON.stringify(['1" × 4" × 10" ×3']), 'a split stays split after a reload');
    const row = p2.locator('#clList > .row', { hasText: 'Board' }).first();
    check(/Overlaps another piece of this part by 4" .*together 16" long/.test(await row.innerText()), 'the overlap is still pointed out, with the combined length');
    await row.click();
    await p2.locator('#dimCard [data-act=join-overlap]').click();
    check(JSON.stringify(await boardRows()) === JSON.stringify(['1" × 4" × 10" ×1', '1" × 4" × 16" ×1']), '"Join" joins it again by hand');
    await p2.locator('#clList > .row', { hasText: '16"' }).click();
    await p2.locator('#dimCard [data-act=split]').click();
    await p2.locator('#clList > .row', { hasText: 'Board' }).first().click();
    await p2.locator('#dimCard [data-act=del-overlap]').click();
    check(JSON.stringify(await boardRows()) === JSON.stringify(['1" × 4" × 10" ×2']) && !/Overlaps/.test(await p2.locator('#clList > .row', { hasText: 'Board' }).first().innerText()), '"Delete the overlapping copy" removes one piece and the warning');

    // sheet goods: choose it in Set up
    await p2.locator('#clSetup').click();
    await p2.locator('#setup select[data-mat="Wood"]').selectOption('Sheet goods');
    await Promise.all([p2.waitForEvent('load'), p2.locator('#setup .setup-save').click()]);
    await loaded();
    const sum = await p2.locator('#clSummary').innerText();
    check(/Sheet goods: 1 sheet of 1" Wood \(4' × 8'\)/.test(sum), `a material set to Sheet goods is laid out on sheets (${sum.split('\n').find((l) => /Sheet/.test(l))})`);
    await p2.locator('#clDiagram').click();
    const shopText = await p2.locator('#diagram .cd-shop').innerText();
    const sheetGroups = await p2.locator('#diagram .cd-group h3', { hasText: 'sheet' }).allInnerTexts();
    // one layout per thickness: the 1" boards and the 1-1/2" leg
    check(/Sheet goods to buy/.test(shopText) && sheetGroups.length === 2 && /^1" Wood/.test(sheetGroups[0]), `the cutting diagram shows a sheet layout per thickness (${sheetGroups.join(' / ')})`);
    await p2.locator('#cdSheet').selectOption('60x60');
    check(/5' × 5'/.test(await p2.locator('#diagram .cd-shop').innerText()), 'sheet size can be changed');
    await p2.screenshot({ path: path.join(OUT, '46-sheet-goods.png') });
    check(errs.length === 0, `no page errors (${errs.join('; ')})`);
  } finally {
    await b2.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- edits on the built-in model live in this browser ----------
{
  console.log('edits on a built-in model');
  const b2 = await chromium.launch(launchOpts);
  const p2 = await b2.newPage({ viewport: { width: 1400, height: 900 } });
  p2.on('dialog', (d) => d.accept());
  const loaded = () => p2.waitForFunction(() => document.getElementById('loading').style.display === 'none', null, { timeout: 30000 });
  const names = () => p2.locator('#clList > .row .name').evaluateAll((els) => els.map((e) => e.lastChild.textContent.trim()));
  try {
    await p2.goto(base);
    await loaded();
    await p2.locator('#introClose').click();
    await p2.locator('#clList .row', { hasText: 'Seat Handle' }).first().click();
    await p2.keyboard.press('Delete');
    check(!(await names()).includes('Seat Handle'), 'a built-in model part can be deleted');
    const letters = await p2.locator('#clList > .row .letter').allInnerTexts();
    check(letters.length === 23 && letters[22] === 'W', `part letters close up without gaps (${letters.length}, last ${letters[22]})`);
    await p2.reload();
    await loaded();
    check(!(await names()).includes('Seat Handle'), 'the delete is remembered after a reload');
    await p2.locator('#helpBtn').click();
    await p2.locator('#resetPrefs').click();
    await loaded();
    check(!(await names()).includes('Seat Handle'), '"reset preferences" leaves your model edits alone');
    await p2.locator('.aside-section summary', { hasText: 'Deleted' }).click();
    await p2.locator('.aside-section .row', { hasText: 'Seat Handle' }).locator('[data-act=build]').click();
    check((await names()).includes('Seat Handle') && (await names()).length === 24, 'restoring brings it back');

    // one piece of a part with several
    await p2.locator('#clList .row', { hasText: 'Bench' }).first().click();
    await p2.waitForTimeout(300);
    const benchLabels = await p2.locator('#axisLabels .axisLabel').allTextContents();
    check(benchLabels.filter((t) => t === '46-3/8"').length === 2, `every piece of a part gets its own dimensions (${benchLabels.join(' ')})`);
    const [pt] = await p2.evaluate(visibleFacePoints, 1);
    await p2.mouse.click(pt.x, pt.y);
    await p2.waitForTimeout(300);
    check(await p2.locator('#dimCard .card-piece').isVisible(), 'clicking one piece in 3D offers actions for just that piece');
    await p2.locator('#dimCard [data-act=piece-delete]').click();
    const benchRow = await p2.locator('#clList > .row', { hasText: 'Bench' }).first().innerText();
    check(/×1/.test(benchRow) && await p2.locator('.aside-section .row', { hasText: 'Bench' }).count() === 1, `deleting one piece leaves the rest (${benchRow.replace(/\n/g, ' ')})`);
    check(/qty 1/.test(await p2.locator('#dimCard').innerText()), 'the card updates to the pieces left');
    await p2.keyboard.press('Control+z');
    check(/×2/.test(await p2.locator('#clList > .row', { hasText: 'Bench' }).first().innerText()), 'undo brings the piece back');
  } finally {
    await b2.close();
  }
}

// ---------- build mode ----------
{
  console.log('build mode');
  const b2 = await chromium.launch(launchOpts);
  const p2 = await b2.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  p2.on('pageerror', (e) => errs.push(e.message));
  const loaded = () => p2.waitForFunction(() => document.getElementById('loading').style.display === 'none', null, { timeout: 30000 });
  const stepName = () => p2.locator('#buildPanel .bp-name').evaluate((e) => e.childNodes[1].textContent.trim());
  const stepNo = () => p2.locator('#buildPanel .bp-steps').inputValue();
  try {
    await p2.goto(base);
    await loaded();
    await p2.locator('#introClose').click();
    await p2.locator('#clBuild').click();
    check(await p2.locator('#buildPanel').isVisible() && !(await p2.locator('#dimCard').isVisible()), 'Build opens the step-by-step panel');
    const first = await stepName();
    check(/Leg/.test(first), `assembly order starts from the ground up (${first})`);
    check(/\d/.test(await p2.locator('#buildPanel .bp-size').innerText()) && /rough/.test(await p2.locator('#buildPanel .bp-sub').innerText()), 'a step shows the finished and rough size');
    await p2.locator('#buildPanel .bp-next').click();
    check(await stepNo() === '1', 'Next goes to the next part');
    const ghosts = await p2.evaluate(() => {
      const v = window.__viewer;
      const now = v.currentSelectionMeshes();
      const all = v.rows().flatMap((r) => v.meshesOf(r.name));
      return { hl: now.every((m) => m.material.emissiveIntensity > 0), ghosted: all.some((m) => m.material.transparent && m.visible), solid: all.some((m) => !m.material.transparent && !now.includes(m)) };
    });
    check(ghosts.hl && ghosts.ghosted && ghosts.solid, 'the model assembles as you go: earlier parts solid, this one highlighted, later ones ghosted');
    const name2 = await stepName();
    await p2.locator('#buildPanel .bp-cut input').click(); // (check() would re-tick the next step's box)
    await p2.waitForTimeout(500);
    check(await stepNo() === '2', 'ticking "Cut" moves on to the next part');
    check(await p2.locator('#clList .row', { hasText: name2 }).first().locator('.cut-box').isChecked(), 'and ticks it off in the cut list');
    await p2.keyboard.press('ArrowLeft');
    check(await stepNo() === '1', 'arrow keys step back and forth');
    await p2.locator('#buildPanel .bp-exit').click();
    check(!(await p2.locator('#buildPanel').isVisible()), 'Exit leaves build mode');
    await p2.reload();
    await loaded();
    await p2.locator('#clBuild').click();
    check(await stepNo() === '1', 'build mode picks up where you left off');
    await p2.locator('#buildPanel .bp-order').click();
    check(/Cutting order/.test(await p2.locator('#buildPanel .bp-order').innerText()) && await stepName() === name2, 'cutting order keeps you on the same part');
    const firstCut = await p2.locator('#buildPanel .bp-steps option').first().innerText();
    check(!/Leg Rear/.test(firstCut), `cutting order is different (${firstCut})`);
    await p2.screenshot({ path: path.join(OUT, '45-build-mode.png') });
    // edits while building: the steps follow
    const before = await p2.locator('#buildPanel .bp-steps option').count();
    const gone = await stepName();
    await p2.keyboard.press('Delete');
    await p2.waitForTimeout(300);
    const opts = await p2.locator('#buildPanel .bp-steps option').allInnerTexts();
    check(opts.length === before - 1 && !opts.some((t) => t.includes(gone)) && await stepName() !== gone, `deleting the step's part drops its step and moves on (${await stepName()})`);
    await p2.keyboard.press('Control+z');
    await p2.waitForTimeout(300);
    check(await p2.locator('#buildPanel .bp-steps option').count() === before, 'undo puts the step back');
    await p2.locator('#clDiagram').click();
    await p2.keyboard.press('Escape');
    check(!(await p2.locator('#diagram').isVisible()) && await p2.locator('#buildPanel').isVisible(), 'Esc closes a dialog opened in build mode, not build mode');
    check(errs.length === 0, `no page errors in build mode (${errs.join('; ')})`);
  } finally {
    await b2.close();
  }
}

// ---------- phone (touch) ----------
{
  console.log('phone');
  const b2 = await chromium.launch(launchOpts);
  const ctx = await b2.newContext({ ...devices['iPhone 13'] });
  const p2 = await ctx.newPage();
  const errs = [];
  p2.on('pageerror', (e) => errs.push(e.message));
  try {
    await p2.goto(base);
    await p2.waitForFunction(() => document.getElementById('loading').style.display === 'none', null, { timeout: 30000 });
    await p2.locator('#introClose').tap();
    const tops = await p2.locator('#toolbar button').evaluateAll((els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().top)))]);
    check(tops.length === 1, `the toolbar is one row that scrolls sideways (${tops.length} rows)`);
    const angleX = await p2.locator('#measureAngleBtn').evaluate((e) => e.getBoundingClientRect().right);
    check(angleX < 390, 'the measuring tools are on screen without scrolling');
    check(await p2.evaluate(() => getComputedStyle(document.documentElement).touchAction) === 'manipulation', 'no double-tap zoom on buttons (touch-action: manipulation)');
    await p2.locator('#measureAngleBtn').tap();
    const tb = await p2.locator('#toolbar').boundingBox(), hint = await p2.locator('#measureHint').boundingBox();
    check(hint.y >= tb.y + 34, 'the measuring tip sits below the toolbar, not over its buttons');
    check(/Tap the corner/.test(await p2.locator('#measureHint').innerText()), 'the tip says tap, not click');
    await p2.locator('#measureHint .hint-x').tap();
    check(!(await p2.locator('#measureHint').isVisible()) && await p2.locator('#measureAngleBtn.on').count() === 0, 'the tip\'s × stops measuring (no Esc key on a phone)');
    const q = await p2.evaluate(() => {
      const { THREE, camera } = window.__viewer; const m = window.__viewer.meshesOf('Bench')[0];
      const c = new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3()).project(camera);
      const r = document.querySelector('#viewport canvas').getBoundingClientRect();
      return { x: r.left + (c.x * 0.5 + 0.5) * r.width, y: r.top + (0.5 - c.y * 0.5) * r.height };
    });
    await p2.touchscreen.tap(q.x, q.y);
    await p2.waitForTimeout(300);
    check((await p2.locator('#dimCard .pn-text').innerText().catch(() => '')) === 'Bench', 'tapping a part selects it');
    const stacked = await p2.evaluate(() => {
      const shown = [...document.querySelectorAll('#axisLabels .axisLabel')].filter((e) => e.style.display !== 'none' && e.style.visibility !== 'hidden').map((e) => ({ t: e.textContent, r: e.getBoundingClientRect() }));
      return shown.filter((a, i) => shown.some((b, j) => j > i && a.t === b.t && a.r.left < b.r.right && b.r.left < a.r.right && a.r.top < b.r.bottom && b.r.top < a.r.bottom)).length;
    });
    check(stacked === 0, 'the same measurement on two pieces isn\'t stacked on top of itself');
    check(await p2.locator('.group-title .gt-actions').first().isHidden(), 'group buttons stay out of the way on touch (tap the group name instead)');
    await p2.locator('#clBuild').tap();
    const bp = await p2.locator('#buildPanel').boundingBox();
    check(bp && bp.width > 350 && await p2.locator('#sidebar').isHidden(), 'build mode on a phone: full-width panel, cut list out of the way');
    await p2.waitForTimeout(600);
    const stepAt = await p2.evaluate(partScreenCenter);
    check(stepAt.y < bp.y - 20 && stepAt.y > 60, `the step's part is framed above the panel, not under it (at y=${Math.round(stepAt.y)}, panel at ${Math.round(bp.y)})`);
    await p2.screenshot({ path: path.join(OUT, '51-phone-build.png') });
    await p2.locator('#buildPanel .bp-exit').tap();
    await p2.locator('#helpBtn').tap();
    check(await p2.locator('#help .help-touch').isVisible() && !(await p2.locator('#help .if-mouse-block').isVisible()), 'help shows touch gestures instead of keyboard shortcuts');
    await p2.screenshot({ path: path.join(OUT, '50-phone-help.png') });
    check(errs.length === 0, `no page errors on a phone (${errs.join('; ')})`);
  } finally {
    await b2.close();
  }
}

// ---------- phone held sideways ----------
{
  console.log('phone, landscape');
  const b2 = await chromium.launch(launchOpts);
  const ctx = await b2.newContext({ ...devices['iPhone 13 landscape'] });
  const p2 = await ctx.newPage();
  const errs = [];
  p2.on('pageerror', (e) => errs.push(e.message));
  try {
    await p2.goto(base);
    await p2.waitForFunction(() => document.getElementById('loading').style.display === 'none', null, { timeout: 30000 });
    await p2.locator('#introClose').tap();
    const vp = await p2.locator('#viewport').boundingBox(), sb = await p2.locator('#sidebar').boundingBox();
    check(sb.x >= vp.x + vp.width - 1 && vp.height > 300, `sideways, the model and the cut list sit side by side (model ${Math.round(vp.width)}×${Math.round(vp.height)})`);
    await p2.locator('#clBuild').tap();
    await p2.waitForTimeout(600);
    const bp = await p2.locator('#buildPanel').boundingBox();
    const next = await p2.locator('#buildPanel .bp-next').boundingBox();
    check(bp.x > 300 && next.y + next.height <= bp.y + bp.height, 'build mode sideways: the step down the side, Next on screen');
    const stepAt = await p2.evaluate(partScreenCenter);
    check(stepAt.x < bp.x - 20, `the step's part is framed beside the panel (at x=${Math.round(stepAt.x)}, panel at ${Math.round(bp.x)})`);
    await p2.screenshot({ path: path.join(OUT, '52-phone-landscape-build.png') });
    check(errs.length === 0, `no page errors sideways (${errs.join('; ')})`);
  } finally {
    await b2.close();
  }
}

// ---------- offline after first visit (service worker) ----------
{
  console.log('offline after first visit');
  const b2 = await chromium.launch(launchOpts);
  const ctx = await b2.newContext();
  const p2 = await ctx.newPage();
  try {
    await p2.goto(base);
    await p2.waitForFunction(() => document.getElementById('loading').style.display === 'none', null, { timeout: 30000 });
    await p2.evaluate(() => navigator.serviceWorker.ready);
    await p2.reload(); // first load after the worker takes control fills the cache
    await p2.waitForFunction(() => document.getElementById('loading').style.display === 'none', null, { timeout: 30000 });
    await ctx.setOffline(true);
    await p2.reload();
    await p2.waitForFunction(() => document.getElementById('loading').style.display === 'none', null, { timeout: 30000 });
    check((await p2.locator('#clList .row').count()) === 24, 'reloads and works with no connection after one visit');
  } finally {
    await b2.close();
  }
}

// ---------- failure modes ----------
{
  console.log('load failures explain themselves');
  const b2 = await chromium.launch(launchOpts);
  // no service worker here: it would fetch files itself, bypassing page.route
  const p2 = await b2.newPage({ serviceWorkers: 'block' });
  await p2.route(/\/vendor\/three\//, (route) => route.fulfill({ status: 404 }));
  await p2.clock.install();
  await p2.goto(base);
  await p2.clock.fastForward(13000);
  const msg = await p2.locator('#loading').innerText();
  check(/Couldn't start the 3D viewer/.test(msg), 'missing 3D library shows a helpful message');
  const p3 = await b2.newPage({ serviceWorkers: 'block' });
  await p3.route(/scene\.obj$/, (route) => route.fulfill({ status: 404 }));
  await p3.goto(base);
  await p3.waitForFunction(() => document.getElementById('loading').classList.contains('load-error'), null, { timeout: 30000 });
  check(/Failed to load the model/.test(await p3.locator('#loading').innerText()), 'missing model file shows a helpful message');
  await b2.close();
}
server.close();

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
