import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { chromium, devices } from 'playwright';
const VIEWER = path.resolve('viewer'); const devName = process.argv[2] || 'iPhone 13';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => { const u = decodeURIComponent(new URL(req.url, 'http://x').pathname); const f = path.join(VIEWER, u === '/' ? 'index.html' : u); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' }); fs.createReadStream(f).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ ...devices[devName] });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('pageerror', e.message));
await p.goto(base); await p.waitForFunction(() => document.getElementById('loading').style.display === 'none');
await p.locator('#introClose').tap();
// screen point of a part's center
const pt = (name) => p.evaluate((n) => {
  const { THREE, camera } = window.__viewer; const m = window.__viewer.meshesOf(n)[0];
  const c = new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3()).project(camera);
  const r = document.querySelector('#viewport canvas').getBoundingClientRect();
  return { x: r.left + (c.x * 0.5 + 0.5) * r.width, y: r.top + (0.5 - c.y * 0.5) * r.height };
}, name);
let q = await pt('Bench');
await p.touchscreen.tap(q.x, q.y);
await p.waitForTimeout(400);
console.log('tap Bench ->', await p.locator('#dimCard .pn-text').innerText().catch(() => 'nothing'));
q = await pt('Leg Front');
await p.touchscreen.tap(q.x, q.y);
await p.waitForTimeout(400);
console.log('tap Leg Front ->', await p.locator('#dimCard .pn-text').innerText().catch(() => 'nothing'));
// tap on the selected part again
await p.touchscreen.tap(q.x, q.y);
await p.waitForTimeout(400);
console.log('tap selected again ->', await p.locator('#dimCard .pn-text').innerText().catch(() => 'nothing'), '| card visible', await p.locator('#dimCard').isVisible());
// card expand
await p.locator('#dimCard .card-min').tap();
await p.waitForTimeout(300);
const cb = await p.locator('#dimCard').boundingBox();
console.log('card box', JSON.stringify(cb), 'viewport', JSON.stringify(await p.locator('#viewport').boundingBox()));
await p.screenshot({ path: process.argv[3] });
// double tap on a toolbar button: does page zoom?
const before = await p.evaluate(() => window.visualViewport.scale);
const btn = await p.locator('#resetBtn').boundingBox();
await p.touchscreen.tap(btn.x + 5, btn.y + 5); await p.waitForTimeout(80); await p.touchscreen.tap(btn.x + 5, btn.y + 5);
await p.waitForTimeout(600);
console.log('scale before/after double tap', before, await p.evaluate(() => window.visualViewport.scale));
console.log('css touch-action html:', await p.evaluate(() => getComputedStyle(document.documentElement).touchAction), 'button:', await p.evaluate(() => getComputedStyle(document.querySelector('#resetBtn')).touchAction));
await b.close(); server.close();
