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

page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const click = (s) => page.locator(s).click();
const state = () => page.evaluate(() => structuredClone(window.__viewer.designer().current()));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => document.getElementById('loading').style.display === 'none');
  await click('#clLibrary'); await click('#libNewDesign'); await click('[data-arch=bookcase]');
  assert.equal(await page.locator('#designer').getAttribute('data-step'), 'size');
  await page.locator('.dz-param[data-key=shelves]').fill('0');
  await page.locator('.dz-param[data-key=shelves]').press('Tab');
  assert.equal((await state()).params.shelves, 0);
  await page.locator('.dz-param[data-key=shelves]').fill('5');
  await page.locator('.dz-param[data-key=shelves]').press('Tab');
  assert.equal((await state()).params.shelves, 5);
  await page.locator('.dz-wood').selectOption('walnut');
  await page.locator('.dz-param[data-key=width]').fill('34');
  await page.locator('.dz-param[data-key=width]').press('Tab');
  assert.equal((await state()).woodSpecies, 'walnut');
  assert.ok((await state()).parts.every((p) => p.material === 'Walnut'));
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(out, 'wood-customize.png') });
  await click('.dz-next');
  await page.locator('.dz-part-head').first().click();
  await page.locator('.dz-f[data-f=grainCut]').selectOption('quarter');
  const grainBefore = await page.evaluate(() => Array.from(window.__viewer.designer().meshes()[0].geometry.attributes.woodPosition.array));
  await click('[data-act=grain]');
  const grainAfter = await page.evaluate(() => Array.from(window.__viewer.designer().meshes()[0].geometry.attributes.woodPosition.array));
  assert.notDeepEqual(grainBefore, grainAfter);
  await page.evaluate(() => {
    const map = window.__viewer.renderer.shadowMap, render = map.render;
    window.shadowRefreshes = 0;
    map.render = function (...args) { if (map.needsUpdate) window.shadowRefreshes++; return render.apply(this, args); };
  });
  const before = await state();
  await click('[data-action=turn-right]'); await page.waitForTimeout(150);
  assert.notDeepEqual((await state()).parts[0].instances[0].along, before.parts[0].instances[0].along);
  assert.ok(await page.evaluate(() => window.shadowRefreshes > 0), 'quarter turn refreshes shadows on next rendered frame');
  await click('[data-action=turn-left]'); await page.waitForTimeout(300);
  const restored = await page.evaluate(() => Array.from(window.__viewer.designer().meshes()[0].geometry.attributes.woodPosition.array));
  restored.forEach((v, i) => assert.ok(Math.abs(v - grainAfter[i]) < 0.001, 'grain stays attached during rotation'));
  await page.screenshot({ path: path.join(out, 'wood-model.png') });
  const design = await state();
  await click('button[data-step=review]'); await click('.dz-save');
  await page.waitForFunction(() => document.getElementById('loading').style.display === 'none' && !document.querySelector('#designer.open'));
  await page.waitForTimeout(600);
  const saved = await page.evaluate(() => window.__viewer.model.children.filter((m) => m.isMesh && m.material.userData.solidWood).map((m) => Array.from(m.geometry.attributes.woodPosition.array)));
  assert.ok(saved.length > 0, 'saved viewer uses volumetric wood too');
  assert.deepEqual(saved[0], restored, 'saved grain is identical to preview');
  await click('#clDesign');
  assert.deepEqual(await state(), design);
  assert.deepEqual(errors, []);
  console.log('ok preset shelf count, project species, grain cuts and variation, quarter turns, immediate shadows, stable grain after save/reopen, no shader errors');
} finally { await browser.close(); await new Promise((r) => server.close(r)); }
