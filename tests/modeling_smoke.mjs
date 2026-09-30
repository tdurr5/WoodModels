// Exercise the direct editor with real pointer and keyboard input, then save
// through the normal model pipeline and verify its measured cut list.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viewer = path.join(root, 'viewer');
const out = path.join(root, 'test-output');
fs.mkdirSync(out, { recursive: true });
const mime = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  const file = path.join(viewer, name === '/' ? 'index.html' : name);
  if (!file.startsWith(viewer + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'text/plain', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
const state = () => page.evaluate(() => structuredClone(window.__viewer.designer().current()));
const click = (selector) => page.locator(selector).click();
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-4, `${a} != ${b}`);
const loaded = () => page.waitForFunction(() => document.getElementById('loading').style.display === 'none');
const settle = () => page.waitForTimeout(550);
async function exact(axis, value) {
  await page.locator('.dt-axis').selectOption({ index: axis });
  await page.locator('.dt-value').fill(String(value));
  await click('.dt-exact button');
  await settle();
}
async function dragHandle(axis, pixels = 50, cancel = false) {
  await settle();
  const points = await page.evaluate((axis) => {
    const { THREE, camera, renderer } = window.__viewer;
    const { gizmo, target } = window.__viewer.designer().tools;
    const r = renderer.domElement.getBoundingClientRect();
    const project = (v) => { v.project(camera); return [(v.x + 1) * r.width / 2 + r.left, (1 - v.y) * r.height / 2 + r.top]; };
    if (gizmo.mode === 'scale') {
      const h = window.__viewer.designer().tools.resizeHandles.children.find((m) => m.userData.axis === 'XYZ'.indexOf(axis) && m.userData.side === 1);
      const d = window.__viewer.designer().current().parts[0].instances[0].at;
      return { start: project(h.position.clone()), origin: project(new THREE.Vector3(...d)) };
    }
    const meshes = gizmo._gizmo.gizmo[gizmo.mode].children.filter((m) => m.name === axis && m.isMesh && m.visible);
    const handle = meshes.find((m) => {
      m.geometry.computeBoundingBox();
      return m.geometry.boundingBox.getCenter(new THREE.Vector3()).length() > 0.4;
    });
    if (!handle) throw new Error(`No visible ${axis} handle`);
    const center = handle.geometry.boundingBox.getCenter(new THREE.Vector3());
    return { start: project(handle.localToWorld(center)), origin: project(target.position.clone()) };
  }, axis);
  const [x, y] = points.start, dx = x - points.origin[0], dy = y - points.origin[1], length = Math.hypot(dx, dy);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / length * pixels, y + dy / length * pixels, { steps: 12 });
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
  await settle();
}
async function dragRotation() {
  await settle();
  const points = await page.evaluate(() => {
    const { THREE, camera, renderer } = window.__viewer;
    const { gizmo, target } = window.__viewer.designer().tools;
    const r = renderer.domElement.getBoundingClientRect();
    const line = gizmo._gizmo.gizmo.rotate.children.find((m) => m.name === 'Y' && m.visible);
    const attr = line.geometry.attributes.position;
    const caster = new THREE.Raycaster();
    const project = (v) => [(v.x + 1) * r.width / 2 + r.left, (1 - v.y) * r.height / 2 + r.top];
    for (let i = 0; i < attr.count; i++) {
      const point = line.localToWorld(new THREE.Vector3().fromBufferAttribute(attr, i)).project(camera);
      caster.setFromCamera(new THREE.Vector2(point.x, point.y), camera);
      const hit = caster.intersectObjects(gizmo._gizmo.picker.rotate.children.filter((m) => m.visible), false)[0];
      if (hit?.object.name === 'Y') {
        const origin = project(target.position.clone().project(camera));
        const tangent = new THREE.Vector3(0, 1, 0).cross(camera.position.clone().sub(target.position).normalize());
        const tip = project(target.position.clone().add(tangent).project(camera));
        return { start: project(point), direction: tip.map((v, j) => v - origin[j]) };
      }
    }
    throw new Error('No unobstructed Y rotation handle');
  });
  const [x, y] = points.start, [dx, dy] = points.direction, length = Math.hypot(dx, dy);
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + dx / length * 60, y + dy / length * 60, { steps: 12 });
  await page.mouse.up(); await settle();
}
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await loaded();
  await click('#clLibrary'); await click('#libBlankDesign'); await click('.dz-add');
  await page.locator('.dz-title').fill('Direct modeling test');
  const original = await state();
  await dragHandle('X');
  const moved = await state();
  assert.notEqual(moved.parts[0].instances[0].at[0], original.parts[0].instances[0].at[0]);
  near(moved.parts[0].instances[0].at[1], original.parts[0].instances[0].at[1]);
  near(moved.parts[0].instances[0].at[2], original.parts[0].instances[0].at[2]);
  near(moved.parts[0].instances[0].at[0] / 0.125, Math.round(moved.parts[0].instances[0].at[0] / 0.125));
  await click('[data-action=undo]');
  assert.deepEqual((await state()).parts[0].instances, original.parts[0].instances);
  await click('[data-action=redo]');
  assert.deepEqual((await state()).parts[0].instances, moved.parts[0].instances);
  await click('[data-action=undo]');
  await dragHandle('X', 40, true);
  assert.deepEqual((await state()).parts[0].instances, original.parts[0].instances);
  console.log('ok pointer movement, grid, axis constraint, undo, redo and Escape cancellation');

  await click('[data-mode=scale]');
  await dragHandle('X');
  assert.notEqual((await state()).parts[0].size[0], original.parts[0].size[0]);
  near((await state()).parts[0].size[1], original.parts[0].size[1]);
  await click('[data-action=undo]');
  await click('.dt-settings summary');
  await exact(0, 30);
  assert.equal((await state()).parts[0].size[0], 30);
  await click('[data-action=undo]');
  await click('[data-mode=rotate]');
  await dragRotation();
  const spin = (await state()).parts[0].instances[0].along;
  assert.ok(Array.isArray(spin));
  const degrees = Math.atan2(-spin[2], spin[0]) * 180 / Math.PI;
  assert.ok(Math.abs(degrees) > 1);
  near(degrees / 15, Math.round(degrees / 15));
  await click('[data-action=undo]');
  await exact(1, 90);
  const rotated = await state();
  near(rotated.parts[0].instances[0].along[2], -1);
  assert.deepEqual(rotated.parts[0].size, original.parts[0].size);
  await click('[data-action=undo]');
  console.log('ok resize handle, exact dimensions and exact rotation preserve board measurements');

  await click('[data-mode=translate]');
  await click('[data-action=duplicate]');
  assert.equal((await state()).parts[0].instances.length, 2);
  await exact(2, 8);
  const beforeSnap = await state();
  await page.locator('#viewBtns').getByRole('button', { name: 'Top', exact: true }).click();
  await settle();
  const centres = await page.evaluate(() => {
    const { THREE, scene, camera, renderer } = window.__viewer;
    const r = renderer.domElement.getBoundingClientRect();
    return scene.getObjectByName('designPreview').children.filter((m) => m.isMesh).map((m) => {
      const p = new THREE.Vector3(...m.userData.solid.center).project(camera);
      return [(p.x + 1) * r.width / 2 + r.left, (1 - p.y) * r.height / 2 + r.top];
    });
  });
  await page.mouse.click(...centres[0]);
  await page.keyboard.down('Shift'); await page.mouse.click(...centres[1]); await page.keyboard.up('Shift');
  assert.equal(await page.evaluate(() => window.__viewer.designer().tools.selection().size), 2);
  await exact(0, 2);
  (await state()).parts[0].instances.forEach((inst, i) => near(inst.at[0], beforeSnap.parts[0].instances[i].at[0] + 2));
  await click('[data-action=undo]');
  await page.mouse.click(...centres[1]);
  console.log('ok Shift-click multi-selection and moving a selection together');
  await click('[data-mode=snap]');
  const snap = await page.evaluate(() => {
    const { THREE, renderer, camera, scene } = window.__viewer;
    const meshes = scene.getObjectByName('designPreview').children.filter((m) => m.isMesh);
    const rect = renderer.domElement.getBoundingClientRect();
    const project = (v) => { v.project(camera); return [(v.x + 1) * rect.width / 2 + rect.left, (1 - v.y) * rect.height / 2 + rect.top]; };
    const pick = (mesh, left) => {
      const points = mesh.userData.solid.positions;
      const x = (left ? Math.min : Math.max)(...points.map((p) => p[0]));
      const y = Math.max(...points.map((p) => p[1]));
      const z = Math.min(...points.map((p) => p[2]));
      const point = points.find((p) => Math.abs(p[0] - x) < 1e-5 && Math.abs(p[1] - y) < 1e-5 && Math.abs(p[2] - z) < 1e-5);
      const screen = project(new THREE.Vector3(...point));
      const centre = project(new THREE.Vector3(...mesh.userData.solid.center));
      return { point, screen: screen.map((v, i) => v + Math.sign(centre[i] - v) * 3) };
    };
    return { source: pick(meshes.find((m) => m.userData.instanceIndex === 1), true), target: pick(meshes.find((m) => m.userData.instanceIndex === 0), false) };
  });
  await page.screenshot({ path: path.join(out, 'snap-before.png') });
  await page.mouse.click(...snap.source.screen); await settle();
  assert.match(await page.locator('.dt-status').innerText(), /picked/);
  await page.mouse.click(...snap.target.screen); await settle();
  assert.match(await page.locator('.dt-status').innerText(), /Placed exactly/);
  const afterSnap = await state();
  afterSnap.parts[0].instances[1].at.forEach((v, i) => near(v, beforeSnap.parts[0].instances[1].at[i] + snap.target.point[i] - snap.source.point[i]));
  assert.deepEqual(afterSnap.parts[0].instances[0], beforeSnap.parts[0].instances[0]);
  console.log('ok actual two-click corner placement, original piece untouched');

  await click('[data-mode=translate]');
  await click('[data-action=unique]');
  assert.equal((await state()).parts.length, 2);
  await click('[data-mode=scale]'); await exact(0, 12);
  const independent = await state();
  assert.equal(independent.parts[0].size[0], 24);
  assert.equal(independent.parts[1].size[0], 12);
  await click('[data-action=delete]');
  assert.equal((await state()).parts.length, 1);
  await click('[data-action=undo]');
  assert.equal((await state()).parts.length, 2);
  await page.screenshot({ path: path.join(out, 'direct-modeling.png') });
  console.log('ok independent copies, deletion and undo');

  await click('[data-step=review]');
  await click('.dz-save');
  await page.waitForURL(/model=local/); await loaded();
  const rows = await page.locator('#clList > .row').allInnerTexts();
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => r.includes('24"')));
  assert.ok(rows.some((r) => r.includes('12"')));
  await click('#clDesign');
  assert.deepEqual((await state()).parts, independent.parts);
  assert.deepEqual(errors, []);
  console.log('ok saved geometry reopens with matching 24-inch and 12-inch cut-list parts; no browser errors');
} catch (err) {
  await page.screenshot({ path: path.join(out, 'modeling-failure.png') });
  throw err;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
