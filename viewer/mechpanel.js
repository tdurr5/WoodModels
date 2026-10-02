// Working the model's moving parts (mechanisms.js has the maths): the
// "Open it up" panel - a button and slider per lid, tray and handle - and
// Hands on (H), where you work them in 3D: click the lid to open or shut
// it, drag it to swing it, drag a tray along its runners, click a tray to
// lift it out of the chest (and click it on the floor to put it back).
//
// It goes the way the real thing does: the lid opens before anything comes
// out, a tray under another one waits until that one is out of the way,
// and trays slide only as far as the chest's walls and the other trays let
// them.

import * as THREE from 'three';
import { escapeHtml, formatLength } from './format.js';
import {
  resolveMechanisms, initialState, hingeTurn, liftHeight, restOffsets, trayOffset, slideLimits,
  liftBlockers, returnBlockers, unmetNeeds, angleAbout, smoothstep, UP,
} from './mechanisms.js';

const DRAG_PX = 5;
const LID_MS_PER_DEG = 9; // a 95° swing in about 0.85 s
const TRAY_MS_PER_IN = 38;

export function initMechanisms(ctx) {
  const { panel, canvas } = ctx;
  let mechs = [], state = {}, boxes = {}, rest = {}, lift = {};
  let mechOf = new Map(); // mesh -> mechanism
  let queue = []; // tweens: { id, key, to, ms, ease, start, from }
  let hands = false, grab = null, hoverMech = null;
  // folded away to start on a phone, where it would cover half the model
  let collapsed = !!window.matchMedia?.('(max-width: 800px)').matches;

  // ---------- setup ----------
  function setup(config, meshes) {
    mechs = resolveMechanisms(config.mechanisms, meshes.map((m) => m.name));
    state = initialState(mechs);
    queue = [];
    mechOf = new Map();
    const byName = new Map(meshes.map((m) => [m.name, m]));
    boxes = {};
    mechs.forEach((mech) => {
      const b = new THREE.Box3();
      mech.parts.forEach((n) => { const m = byName.get(n); if (m) { mechOf.set(m, mech); b.union(m.geometry.boundingBox); } });
      boxes[mech.id] = { min: b.min.toArray(), max: b.max.toArray() };
    });
    // the chest itself: everything that doesn't move
    const chest = new THREE.Box3();
    meshes.forEach((m) => { if (!mechOf.has(m)) chest.union(m.geometry.boundingBox); });
    const chestBox = { min: chest.min.toArray(), max: chest.max.toArray() };
    const trays = mechs.filter((m) => m.kind === 'tray');
    rest = chest.isEmpty() ? {} : restOffsets(trays, boxes, chestBox, frontOf(config));
    lift = {};
    trays.forEach((m) => { lift[m.id] = chest.isEmpty() ? 0 : liftHeight(boxes[m.id], chestBox); });
    if (!mechs.length) setHands(false);
    buildPanel();
  }
  // the way the model faces: its Front view looks at it from there
  function frontOf(config) {
    const d = config.views?.front?.dir || [0, 0, 1];
    const k = [0, 1, 2].reduce((a, b) => (Math.abs(d[b]) > Math.abs(d[a]) ? b : a), 0);
    const out = [0, 0, 0];
    out[k] = Math.sign(d[k]) || 1;
    return out;
  }

  // ---------- poses ----------
  const q = new THREE.Quaternion(), axis = new THREE.Vector3(), piv = new THREE.Vector3();
  // Turn/move a part from where it was drawn. The mesh's position already
  // holds its exploded-view offset; geometry is in model space, so a turn
  // about the hinge line is a rotation plus the shift that keeps the line put.
  function applyPose(m) {
    const mech = mechOf.get(m);
    if (!mech) { m.quaternion.identity(); return; }
    if (mech.kind === 'hinge') {
      const deg = hingeTurn(mech, m.name, state[mech.id].angle);
      q.setFromAxisAngle(axis.fromArray(mech.axis), THREE.MathUtils.degToRad(deg));
      m.quaternion.copy(q);
      piv.fromArray(mech.pivot);
      m.position.add(piv).sub(piv.clone().applyQuaternion(q));
    } else {
      m.quaternion.identity();
      m.position.add(new THREE.Vector3(...trayOffset(mech, state[mech.id], rest[mech.id] || [0, 0, 0], lift[mech.id] || 0)));
    }
  }

  // ---------- animation ----------
  const busy = () => queue.length > 0;
  function enqueue(id, key, to, ms, ease = true) { queue.push({ id, key, to, ms: Math.max(120, ms), ease }); }
  // Advance whatever is moving; true while something moved this frame.
  function step(now) {
    if (!queue.length) return false;
    const tw = queue[0];
    if (tw.start === undefined) { tw.start = now; tw.from = state[tw.id][tw.key]; }
    const t = Math.min(1, (now - tw.start) / tw.ms);
    state[tw.id][tw.key] = tw.from + (tw.to - tw.from) * (tw.ease ? smoothstep(t) : t);
    if (t >= 1) {
      queue.shift();
      if (!queue.length) { syncPanel(); ctx.settled(); }
    }
    ctx.moved();
    return true;
  }
  function changed() { syncPanel(); ctx.moved(); ctx.settled(); }

  // ---------- actions ----------
  const byId = (id) => mechs.find((m) => m.id === id);
  const names = (list) => list.map((m) => m.label).join(' and ');
  // where a part will be once what's queued has run
  function pending(id, key) {
    const last = queue.filter((tw) => tw.id === id && tw.key === key).pop();
    return last ? last.to : state[id][key];
  }
  function swing(id, angle) {
    const mech = byId(id);
    const to = Math.min(mech.range[1], Math.max(mech.range[0], angle));
    const from = pending(id, 'angle');
    if (Math.abs(to - from) < 0.01) return;
    enqueue(id, 'angle', to, Math.abs(to - from) * LID_MS_PER_DEG);
  }
  // Why a tray can't be lifted out (or put back) right now, or ''.
  function trayBlock(mech) {
    const st = state[mech.id];
    if (st.out >= 1) {
      const b = returnBlockers(mech, mechs, state, boxes, UP);
      return b.length ? `${names(b)} ${b.length > 1 ? 'are' : 'is'} in its place - move ${b.length > 1 ? 'them' : 'it'} first` : '';
    }
    const b = liftBlockers(mech, mechs, state, boxes, UP);
    return b.length ? `${names(b)} ${b.length > 1 ? 'sit' : 'sits'} on top of it - lift ${b.length > 1 ? 'them' : 'it'} out first` : '';
  }
  function liftOut(mech) {
    const why = trayBlock(mech);
    if (why) { ctx.toast(`${mech.label}: ${why}.`); return false; }
    unmetNeeds(mech, mechs, state).forEach(({ mech: h, angle }) => swing(h.id, angle)); // open the lid first
    const path = (lift[mech.id] || 0) * 2 + Math.hypot(...(rest[mech.id] || [0, 0, 0]));
    enqueue(mech.id, 'out', 1, path * TRAY_MS_PER_IN, false);
    return true;
  }
  function putBack(mech) {
    const why = trayBlock(mech);
    if (why) { ctx.toast(`${mech.label}: ${why}.`); return false; }
    unmetNeeds(mech, mechs, state).forEach(({ mech: h, angle }) => swing(h.id, angle));
    const path = (lift[mech.id] || 0) * 2 + Math.hypot(...(rest[mech.id] || [0, 0, 0]));
    enqueue(mech.id, 'out', 0, path * TRAY_MS_PER_IN, false);
    return true;
  }
  function toggle(mech) {
    if (busy()) return;
    if (mech.kind === 'hinge') {
      const open = state[mech.id].angle > (mech.range[0] + mech.open) / 2;
      swing(mech.id, open ? mech.range[0] : mech.open);
    } else if (state[mech.id].out >= 1) putBack(mech);
    else liftOut(mech);
    syncPanel();
  }
  // Open everything up: the lid, then every tray out, top ones first.
  function openAll() {
    if (busy()) return;
    const sim = JSON.parse(JSON.stringify(state));
    const lid = byId(lidId());
    if (lid) { swing(lid.id, lid.open); sim[lid.id].angle = Math.max(sim[lid.id].angle, lid.open); }
    let left = mechs.filter((m) => m.kind === 'tray' && sim[m.id].out < 1);
    while (left.length) {
      const next = left.find((m) => !liftBlockers(m, mechs, sim, boxes, UP).length);
      if (!next) break;
      unmetNeeds(next, mechs, sim).forEach(({ mech: h, angle }) => { swing(h.id, angle); sim[h.id].angle = angle; });
      const path = (lift[next.id] || 0) * 2 + Math.hypot(...(rest[next.id] || [0, 0, 0]));
      enqueue(next.id, 'out', 1, path * TRAY_MS_PER_IN, false);
      sim[next.id].out = 1;
      left = left.filter((m) => m !== next);
    }
    syncPanel();
  }
  // Put it all back the way it came: trays in (bottom ones first, slid back
  // to where they were drawn), handles down, lid shut.
  function closeAll() {
    if (busy()) return;
    const sim = JSON.parse(JSON.stringify(state));
    mechs.filter((m) => m.kind === 'tray' && sim[m.id].slide).forEach((m) => {
      if (sim[m.id].out > 0) { sim[m.id].slide = 0; state[m.id].slide = 0; return; } // out of the chest: it goes back square
      enqueue(m.id, 'slide', 0, Math.abs(sim[m.id].slide) * 60);
      sim[m.id].slide = 0;
    });
    // m would sit on o once both are in: o goes in first
    const sitsOn = (m, o) => {
      const both = { ...sim, [m.id]: { ...sim[m.id], out: 0 }, [o.id]: { ...sim[o.id], out: 0 } };
      return liftBlockers(o, mechs, both, boxes, UP).includes(m);
    };
    let left = mechs.filter((m) => m.kind === 'tray' && sim[m.id].out > 0);
    while (left.length) {
      const next = left.find((m) => !returnBlockers(m, mechs, sim, boxes, UP).length && !left.some((o) => o !== m && sitsOn(m, o)));
      if (!next) break;
      const path = (lift[next.id] || 0) * 2 + Math.hypot(...(rest[next.id] || [0, 0, 0]));
      enqueue(next.id, 'out', 0, path * TRAY_MS_PER_IN, false);
      sim[next.id].out = 0;
      left = left.filter((m) => m !== next);
    }
    mechs.filter((m) => m.kind === 'hinge' && m.id !== lidId()).forEach((m) => swing(m.id, m.range[0]));
    const lid = byId(lidId());
    if (lid) swing(lid.id, lid.range[0]);
    syncPanel();
  }
  // the hinge the trays need open (the lid), else the first hinge
  function lidId() {
    const needed = mechs.flatMap((m) => Object.keys(m.needs || {}));
    return needed[0] || mechs.find((m) => m.kind === 'hinge')?.id;
  }

  // ---------- panel ----------
  const fmt = (v) => formatLength(Math.abs(v), ctx.units());
  function buildPanel() {
    panel.style.display = mechs.length ? '' : 'none';
    if (!mechs.length) { panel.innerHTML = ''; return; }
    panel.innerHTML = `
      <div class="mp-head">
        <b>Open it up</b>
        <button class="mp-hands" title="Work the lid and trays with the mouse: click to open or lift out, drag to swing or slide (H)">✋ Hands on</button>
        <button class="mp-min" title="Fold away">–</button>
      </div>
      <div class="mp-body">
        ${mechs.map((m) => `
          <div class="mp-row" data-id="${escapeHtml(m.id)}">
            <div class="mp-line">
              <span class="mp-name">${escapeHtml(m.label)}</span>
              <span class="mp-val"></span>
              <button class="mp-act"></button>
            </div>
            ${m.kind === 'hinge' ? `<input class="mp-range" type="range" min="${m.range[0]}" max="${m.range[1]}" step="0.5" aria-label="${escapeHtml(m.label)} angle" />` : ''}
            ${m.kind === 'tray' && m.slide ? `<input class="mp-range" type="range" step="0.0625" aria-label="Slide ${escapeHtml(m.label)}" />` : ''}
            <div class="mp-why"></div>
          </div>`).join('')}
        <div class="mp-all">
          <button class="mp-open-all" title="Open the lid and lift every tray out, top one first">Unpack it all</button>
          <button class="mp-close-all" title="Put every tray back and shut the lid">Pack it away</button>
        </div>
      </div>`;
    panel.querySelector('.mp-hands').addEventListener('click', () => setHands(!hands));
    panel.querySelector('.mp-min').addEventListener('click', () => { collapsed = !collapsed; syncPanel(); });
    panel.querySelector('.mp-open-all').addEventListener('click', openAll);
    panel.querySelector('.mp-close-all').addEventListener('click', closeAll);
    panel.querySelectorAll('.mp-row').forEach((row) => {
      const mech = byId(row.dataset.id);
      row.querySelector('.mp-act').addEventListener('click', () => toggle(mech));
      const range = row.querySelector('.mp-range');
      range?.addEventListener('input', () => {
        if (busy()) { syncPanel(); return; }
        const v = parseFloat(range.value);
        if (mech.kind === 'hinge') state[mech.id].angle = v;
        else {
          const [lo, hi] = slideLimits(mech, mechs, state, boxes);
          state[mech.id].slide = Math.min(hi, Math.max(lo, v));
        }
        changed();
      });
    });
    syncPanel();
  }
  function syncPanel() {
    if (!mechs.length) return;
    panel.classList.toggle('collapsed', collapsed);
    panel.querySelector('.mp-min').textContent = collapsed ? '+' : '–';
    panel.querySelector('.mp-hands').classList.toggle('on', hands);
    const moving = busy();
    panel.querySelectorAll('.mp-row').forEach((row) => {
      const mech = byId(row.dataset.id), st = state[mech.id];
      const act = row.querySelector('.mp-act'), val = row.querySelector('.mp-val'), why = row.querySelector('.mp-why');
      const range = row.querySelector('.mp-range');
      let reason = '';
      if (mech.kind === 'hinge') {
        const open = st.angle > (mech.range[0] + mech.open) / 2;
        act.textContent = open ? (mech.closeLabel || 'Close') : (mech.openLabel || 'Open');
        val.textContent = st.angle <= mech.range[0] + 0.25 ? (mech.closedText || 'shut') : `${Math.round(st.angle)}°`;
        if (document.activeElement !== range) range.value = String(st.angle);
      } else {
        const out = st.out >= 1, inside = st.out <= 0;
        act.textContent = out ? 'Put back' : 'Lift out';
        reason = moving ? '' : trayBlock(mech);
        val.textContent = out ? 'out' : !inside ? '…' : st.slide && Math.abs(st.slide) > 1 / 64 ? `slid ${fmt(st.slide)} ${st.slide > 0 ? (mech.slideNames?.[1] || 'forward') : (mech.slideNames?.[0] || 'back')}` : 'in place';
        if (range) {
          const [lo, hi] = inside ? slideLimits(mech, mechs, state, boxes) : [st.slide, st.slide];
          range.min = String(lo); range.max = String(hi);
          range.disabled = !inside || moving || hi - lo < 1 / 64;
          if (document.activeElement !== range) range.value = String(st.slide || 0);
          range.title = hi - lo < 1 / 64 ? 'No room to slide it' : `Slides ${fmt(hi - lo)} on its runners`;
        }
      }
      act.disabled = moving || !!reason;
      act.title = reason ? `${mech.label}: ${reason}` : '';
      why.textContent = reason;
      if (range && mech.kind === 'hinge') range.disabled = moving;
    });
    panel.querySelectorAll('.mp-all button').forEach((b) => { b.disabled = moving; });
  }

  // ---------- hands on: working it in 3D ----------
  function setHands(on) {
    hands = !!on && mechs.length > 0;
    if (!hands) { grab = null; setHover(null); ctx.controls.enabled = true; }
    if (mechs.length) syncPanel();
    canvas.classList.toggle('hands-on', hands);
    ctx.handsChanged?.(hands);
  }
  function setHover(mech) {
    if (mech === hoverMech) return;
    hoverMech = mech;
    ctx.setHoverMeshes(mech ? [...mechOf.keys()].filter((m) => mechOf.get(m) === mech) : []);
  }
  function hitAt(e) {
    const hit = ctx.raycast(e.clientX, e.clientY);
    return hit && mechOf.has(hit.object) ? { hit, mech: mechOf.get(hit.object) } : null;
  }
  // hover in hands-on mode: what the pointer is over and what a click does
  function hover(e) {
    if (!hands) return false;
    if (grab) return true;
    const h = hitAt(e);
    setHover(h?.mech || null);
    if (!h) { canvas.style.cursor = ''; ctx.tip(null); return true; }
    const { mech } = h, st = state[mech.id];
    canvas.style.cursor = busy() ? 'progress' : 'grab';
    let what;
    if (mech.kind === 'hinge') what = st.angle > (mech.range[0] + mech.open) / 2 ? 'click to close · drag to swing' : 'click to open · drag to swing';
    else if (st.out >= 1) what = 'click to put it back in the chest';
    else what = `click to lift it out${mech.slide ? ' · drag to slide it' : ''}`;
    const why = mech.kind === 'tray' ? trayBlock(mech) : '';
    ctx.tip(e, `<b>${escapeHtml(mech.label)}</b> <span>${escapeHtml(why || what)}</span>`);
    return true;
  }
  // screen pixels per inch along a direction from a point, for dragging
  function screenAlong(p, dir) {
    const cam = ctx.camera(), r = canvas.getBoundingClientRect();
    const toPx = (v) => { const s = v.clone().project(cam); return new THREE.Vector2((s.x + 1) / 2 * r.width, (1 - s.y) / 2 * r.height); };
    return toPx(p.clone().add(dir)).sub(toPx(p));
  }
  function onDown(e) {
    if (!hands || grab || e.button !== 0 || !ctx.enabled()) return; // (a second finger mid-drag: not a new grab)
    const h = hitAt(e);
    if (!h) return; // empty space: orbit as usual
    e.stopImmediatePropagation();
    ctx.controls.enabled = false;
    const st = state[h.mech.id];
    grab = { mech: h.mech, x: e.clientX, y: e.clientY, dragged: false, point: h.hit.point.clone(), angle: st.angle, slide: st.slide, pointerId: e.pointerId };
    canvas.style.cursor = 'grabbing';
    try { canvas.setPointerCapture(e.pointerId); } catch { /* the pointer's already gone */ }
  }
  function onMove(e) {
    if (!grab || e.pointerId !== grab.pointerId) return;
    e.stopImmediatePropagation();
    const { mech } = grab, st = state[mech.id];
    if (!grab.dragged && Math.hypot(e.clientX - grab.x, e.clientY - grab.y) <= DRAG_PX) return;
    grab.dragged = true;
    if (busy()) return;
    if (mech.kind === 'hinge') {
      // where the pointer meets the plane the part swings in
      const a = new THREE.Vector3(...mech.axis);
      const ray = ctx.rayAt(e.clientX, e.clientY);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(a, grab.point);
      const p = Math.abs(ray.direction.dot(a)) > 0.2 ? ray.intersectPlane(plane, new THREE.Vector3()) : null;
      let angle;
      if (p) angle = grab.angle + angleAbout(mech, p.toArray(), grab.point.toArray());
      else angle = grab.angle + (grab.y - e.clientY) * 0.4; // looking along the hinge: drag up to open
      state[mech.id].angle = Math.min(mech.range[1], Math.max(mech.range[0], angle));
      changed();
    } else if (mech.slide && st.out <= 0) {
      const dir = new THREE.Vector3(...mech.slide.axis);
      const s = screenAlong(grab.point, dir);
      if (s.lengthSq() < 4) return; // looking straight along the runners
      const d = new THREE.Vector2(e.clientX - grab.x, e.clientY - grab.y).dot(s) / s.lengthSq();
      const [lo, hi] = slideLimits(mech, mechs, { ...state, [mech.id]: { ...st, slide: grab.slide } }, boxes);
      state[mech.id].slide = Math.min(hi, Math.max(lo, grab.slide + d));
      changed();
    }
  }
  function onUp(e) {
    if (!grab || e.pointerId !== grab.pointerId) return;
    e.stopImmediatePropagation();
    const g = grab;
    grab = null;
    ctx.controls.enabled = true;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (!g.dragged) toggle(g.mech);
    canvas.style.cursor = 'grab';
  }
  // a click on a moving part in hands-on mode isn't a selection
  function onClick(e) {
    if (hands && ctx.enabled() && hitAt(e)) e.stopImmediatePropagation();
  }
  canvas.addEventListener('pointerdown', onDown, true);
  canvas.addEventListener('pointermove', onMove, true);
  canvas.addEventListener('pointerup', onUp, true);
  canvas.addEventListener('pointercancel', onUp, true);
  canvas.addEventListener('click', onClick, true);

  return {
    setup, applyPose, step, hover, setHands, toggle, openAll, closeAll,
    has: () => mechs.length > 0,
    handsOn: () => hands,
    busy,
    moves: (m) => mechOf.has(m),
    syncPanel,
    // for tests: the state of every mechanism, and setting one directly
    state: () => JSON.parse(JSON.stringify(state)),
    set: (id, key, v) => { if (state[id]) { state[id][key] = v; changed(); } },
    list: () => mechs.map((m) => ({ id: m.id, kind: m.kind, label: m.label, parts: m.parts.length })),
  };
}
