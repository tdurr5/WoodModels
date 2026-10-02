// Work the heirloom tool chest with a real mouse: open the lid by hand,
// slide a tray on its runners, lift the trays out in the order the chest
// allows, then pack it all away again.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { zip } from '../viewer/zip.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viewer = path.join(root, 'viewer');
const out = path.join(root, 'test-output');
fs.mkdirSync(out, { recursive: true });
const mime = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.css': 'text/css', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  const file = path.join(viewer, name === '/' ? 'index.html' : name);
  if (!file.startsWith(viewer + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'text/plain', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const ok = (msg) => console.log(`ok ${msg}`);
const mech = () => page.evaluate(() => window.__viewer.mechanisms().state());
const settled = () => page.waitForFunction(() => !window.__viewer.mechanisms().busy(), null, { timeout: 15000 });
// where a model-space point is on the page
const at = (p) => page.evaluate(([x, y, z]) => {
  const v = window.__viewer, c = v.renderer.domElement.getBoundingClientRect();
  v.camera.updateMatrixWorld();
  const s = new v.THREE.Vector3(x, y, z).project(v.camera);
  return { x: c.left + (s.x + 1) / 2 * c.width, y: c.top + (1 - s.y) / 2 * c.height };
}, p);
const box = (name) => page.evaluate((n) => {
  const v = window.__viewer;
  let m = null;
  v.model.traverse((o) => { if (o.name === n) m = o; });
  const b = new v.THREE.Box3().setFromObject(m, true); // from its vertices, not its drawn (tilted) box
  return { min: b.min.toArray(), max: b.max.toArray() };
}, name);
const row = (id) => `#mechPanel .mp-row[data-id="${id}"]`;

try {
  await page.goto(`${base}?model=models/heirloom-chest/`);
  await page.waitForFunction(() => document.getElementById('loading').style.display === 'none');
  await page.evaluate(() => document.getElementById('introClose')?.click());
  assert.ok(await page.locator('#mechPanel').isVisible());
  assert.equal((await mech()).lid.angle, 0);
  assert.ok((await box('group_1_instance_9_lid_stiles')).max[1] < 13.76, 'the lid starts shut');
  assert.ok(await page.locator(`${row('plane-tray')} .mp-act`).isDisabled());
  assert.match(await page.locator(`${row('plane-tray')} .mp-why`).textContent(), /Chisel tray sits on top/);
  ok('opens with the lid shut and the plane tray held under the chisel tray');

  // hands on (on from the start): a click on the lid opens it, and doesn't select a part
  assert.ok(await page.locator('#mechPanel .mp-hands.on').count(), 'Hands on starts on');
  const lidFront = await at([14.75, 13.6, -0.4]);
  await page.mouse.move(lidFront.x, lidFront.y);
  await page.waitForTimeout(150);
  assert.match(await page.locator('#hoverTip').textContent(), /Lid.*click to open/);
  await page.mouse.click(lidFront.x, lidFront.y);
  await settled();
  assert.equal((await mech()).lid.angle, 95);
  assert.ok((await box('group_1_instance_9_lid_stiles')).min[1] > 25, 'the lid is up');
  assert.equal(await page.evaluate(() => window.__viewer.current), null);
  ok('a click on the lid in Hands on swings it open, without selecting it');

  // drag the chisel tray forward on its runners
  const from = await at([14.75, 13.0, -8]), to = await at([14.75, 13.0, -5.5]);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + (to.x - from.x) * i / 8, from.y + (to.y - from.y) * i / 8);
  await page.mouse.up();
  const slid = (await mech())['chisel-tray'];
  assert.ok(slid.slide > 1.5 && slid.slide <= 3.75, `slid ${slid.slide}`);
  assert.equal(slid.out, 0);
  // dragging it a long way stops at the front wall
  const far = await at([14.75, 13.0, 20]);
  const grab = await at([14.75, 13.0, -8 + slid.slide]);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(grab.x + (far.x - grab.x) * i / 8, grab.y + (far.y - grab.y) * i / 8);
  await page.mouse.up();
  const stop = (await mech())['chisel-tray'].slide;
  assert.ok(Math.abs(stop - 3.74) < 0.01, `stopped at ${stop}`);
  ok(`the chisel tray drags along its runners and stops at the front wall (${stop.toFixed(2)}")`);

  // drag the chisel tray up out of the chest and let go: it's set down on the floor
  const chisel = await at([14.75, 12.9, -8 + stop]);
  await page.mouse.move(chisel.x, chisel.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(chisel.x, chisel.y - 25 * i);
  const lifting = (await mech())['chisel-tray'].out;
  assert.ok(lifting > 0 && lifting < 0.5, `follows the pointer up (${lifting})`);
  await page.mouse.up();
  await settled();
  assert.equal((await mech())['chisel-tray'].out, 1);
  assert.ok((await box('group_3_instance_19_chisel_tray_bottom')).min[1] < 0.01, 'on the floor');
  assert.ok(await page.locator(`${row('plane-tray')} .mp-act`).isEnabled());
  await page.locator(`${row('plane-tray')} .mp-act`).click();
  await settled();
  assert.equal((await mech())['plane-tray'].out, 1);
  ok('the chisel tray drags up out of the chest onto the floor, and then the plane tray can come out');

  // a lid part selected while the lid is open: its dimensions turn with it
  await page.keyboard.press('h');
  await page.evaluate(() => { const v = window.__viewer; v.selectRow(v.rows().find((r) => r.name === 'Lid panel')); });
  const turned = await page.evaluate(() => {
    const v = window.__viewer, m = v.current.meshes[0];
    const sub = v.current.gizmo.children.find((c) => c.isGroup);
    return sub.quaternion.angleTo(m.quaternion) < 1e-6 && m.quaternion.angleTo(new v.THREE.Quaternion()) > 1;
  });
  assert.ok(turned);
  await page.screenshot({ path: path.join(out, 'chest-open.png') });
  ok('a selected lid part is dimensioned where the open lid has it');

  // pack it away: trays in, bottom one first, lid shut
  await page.evaluate(() => window.__viewer.setExplode(0));
  await page.locator('#mechPanel .mp-close-all').click();
  await settled();
  const shut = await mech();
  assert.deepEqual(Object.values(shut).map((s) => s.angle ?? s.out + s.slide), [0, 0, 0, 0, 0, 0]);
  assert.ok((await box('group_1_instance_9_lid_stiles')).max[1] < 13.76);
  ok('Pack it away puts every tray back and shuts the lid');

  // Unpack it all: lid, then every tray out top-first
  await page.locator('#mechPanel .mp-open-all').click();
  await settled();
  const open = await mech();
  assert.ok(['chisel-tray', 'plane-tray', 'saw-till'].every((id) => open[id].out === 1));
  await page.screenshot({ path: path.join(out, 'chest-unpacked.png') });
  ok('Unpack it all opens the lid and lifts every tray out');

  // an upload with no moving parts listed: they're found by name
  const folder = path.join(viewer, 'models', 'heirloom-chest');
  const files = Object.fromEntries(fs.readdirSync(folder).map((f) => [f, new Uint8Array(fs.readFileSync(path.join(folder, f)))]));
  const cfg = JSON.parse(fs.readFileSync(path.join(folder, 'model.json'), 'utf8'));
  delete cfg.mechanisms; delete cfg.edits;
  files['model.json'] = JSON.stringify(cfg);
  // as the browser's own export has it: the photos ride along in the zip, not in scene.mtl
  files['scene.mtl'] = fs.readFileSync(path.join(folder, 'scene.mtl'), 'utf8').replace(/^map_Kd .*$/gm, '');
  await page.goto(base);
  await page.waitForFunction(() => document.getElementById('loading').style.display === 'none');
  await page.locator('#libFile').setInputFiles({ name: 'chest.zip', mimeType: 'application/zip', buffer: Buffer.from(zip(files)) });
  await page.waitForFunction(() => /local/.test(location.search) && document.getElementById('loading').style.display === 'none' && window.__viewer?.mechanisms().has(), null, { timeout: 30000 });
  const found = await page.evaluate(() => window.__viewer.mechanisms().list().map((m) => m.label));
  assert.deepEqual(found, ['Lid', 'Chisel tray', 'Handsaw box', 'Handplane tray']);
  assert.ok(await page.evaluate(() => window.__viewer.mechanisms().handsOn()));
  ok(`an uploaded chest finds its own lid and trays (${found.join(', ')})`);

  // the built-in model has nothing that moves: no panel
  await page.goto(`${base}?model=`);
  await page.waitForFunction(() => document.getElementById('loading').style.display === 'none');
  assert.ok(!(await page.locator('#mechPanel').isVisible()));
  ok('a model with no moving parts shows no panel');

  assert.deepEqual(errors, []);
  ok('no page errors');
} finally {
  await browser.close();
  server.close();
}
