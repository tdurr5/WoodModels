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

const field = async (key,value) => { const input=page.locator(`.dz-part.open .dz-f[data-f=${key}]`); if (['along','up'].includes(key)) await input.selectOption(value); else { await input.fill(String(value)); await input.press('Tab'); } };
const settle=()=>page.waitForTimeout(600);
const point=async (side,x=null)=>page.evaluate(({side,x})=>{
  const {camera,renderer}=window.__viewer, h=window.__viewer.designer().tools.resizeHandles.children.find((m)=>m.userData.axis===0 && m.userData.side===side);
  const p=h.position.clone(); if(x!==null) p.x=x; p.project(camera); const r=renderer.domElement.getBoundingClientRect();
  return [r.left+(p.x+1)*r.width/2,r.top+(1-p.y)*r.height/2];
},{side,x});
async function resizeDrag(side,x,cancel=false) {
  const a=await point(side), b=await point(side,x);
  await page.mouse.move(...a); await page.mouse.down(); await page.mouse.move(...b,{steps:8});
  if(cancel) await page.keyboard.press('Escape'); await page.mouse.up(); await settle();
}
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(()=>document.getElementById('loading').style.display==='none');
  await click('#clLibrary'); await click('#libBlankDesign'); await click('.dz-add');
  await field('name','Rail'); await field('size0',10); await field('size1',2);
  await click('.dz-placement summary'); await field('at1',5);
  await click('[data-action=add]'); await field('name','Post');
  await field('size0',12); await field('size1',3); await field('size2',3);
  await click('.dz-placement summary'); await field('along','y'); await field('up','z');
  await field('at0',6.5); await field('at1',6); await settle();
  const sockets=()=>page.evaluate(()=>window.__viewer.designer().meshes().filter((m)=>m.userData.solid.socketCount>0).length);
  assert.equal(await sockets(),1,'contact automatically cuts a socket');
  await page.locator('.dz-connections .dz-sec summary').click();
  assert.equal(await page.locator('.dz-jtype').count(),1);
  const before=await state();
  await page.locator('.dz-jtype').selectOption('dovetail'); await settle();
  assert.deepEqual((await state()).parts,before.parts,'changing joint does not move the boards');
  assert.ok(await page.evaluate(()=>window.__viewer.designer().meshes()[0].userData.solid.tenons[1].dovetail));
  await click('.dz-inspect'); await settle();
  assert.ok(await page.evaluate(()=>window.__viewer.designer().meshes().some((m)=>m.position.length()>0)));
  assert.deepEqual((await state()).parts,before.parts);
  await page.screenshot({path:path.join(out,'joints-inspection.png')});
  await click('.dz-inspect'); await settle();
  await page.locator('.dz-part-head').first().click(); await click('[data-mode=scale]');
  await click('.dt-settings summary'); await page.locator('.dt-value').fill('8'); await click('.dt-exact button'); await settle();
  assert.equal(await sockets(),0,'shrinking away removes the automatic joint');
  await page.locator('#viewBtns').getByRole('button',{name:'Front',exact:true}).click(); await settle();
  await resizeDrag(1,4.96);
  let rail=(await state()).parts[0];
  assert.ok(Math.abs(rail.size[0]-10)<1e-5,'moving end snaps to receiving board');
  assert.ok(Math.abs(rail.instances[0].at[0]-rail.size[0]/2+5)<1e-5,'opposite face stays fixed');
  assert.equal(await sockets(),1);
  await resizeDrag(-1,-7);
  rail=(await state()).parts[0];
  assert.ok(rail.size[0]>10);
  assert.ok(Math.abs(rail.instances[0].at[0]+rail.size[0]/2-5)<1e-5,'negative-face resize holds positive face');
  const saved=await state(); await page.keyboard.press('f'); await settle(); await resizeDrag(-1,-9,true);
  assert.deepEqual((await state()).parts,saved.parts,'Escape cancels face resize');
  await click('button[data-step=review]'); await click('.dz-save');
  await page.waitForURL(/model=local/); await page.waitForFunction(()=>document.getElementById('loading').style.display==='none');
  assert.equal(await page.locator('#clList > .row').count(),2);
  await click('#clDesign'); assert.deepEqual((await state()).parts,saved.parts);
  assert.deepEqual((await state()).jointChoices,saved.jointChoices);
  assert.equal(await sockets(),1);
  assert.deepEqual(errors,[]);
  console.log('ok automatic sockets, editable dovetail choice, inspection, face resizing from either end, edge snap, cancellation, save/reopen');
} catch(error) { await page.screenshot({path:path.join(out,'joint-failure.png')}); throw error; }
finally { await browser.close(); await new Promise((r)=>server.close(r)); }
