// The designer: build your own piece, in numbers rather than by dragging.
//
// Dragging in 3D is how you end up with a 46-3/8in part. Everything here is
// typed or picked: a size, a position, which way the grain runs, what it
// joins. The preview redraws as you type and the design review runs on every
// change, so the woodworking rules arrive while you can still act on them.
//
// Saving compiles the design (design.js) into the same six data files an
// uploaded model has, so the piece you drew gets the cut list, the cutting
// diagrams, the templates, build mode and the printed sheet for free.

import { escapeHtml, formatLength } from './format.js';
import {
  compileDesign, buildSolids, designBounds, designReviewModel, emptyDesign, newPart, JOINT_LABELS,
} from './design.js';
import { ARCHETYPES, buildArchetype, archetype, defaultParams } from './archetypes.js';
import { reviewModel } from './review.js';
import { reviewHtml } from './designreview.js';

const AXIS_NAMES = { x: 'side to side', y: 'up', z: 'front to back' };
const AXIS_OPTIONS = ['x', 'y', 'z', '-x', '-y', '-z'];
const JOINT_CHOICES = ['mortise-tenon', 'through-tenon', 'round-tenon', 'dado', 'half-lap', 'dowel', 'pocket-screw', 'butt-screw', 'buttons', 'edge-glue'];

// ---------- the panel ----------

export function initDesigner({ THREE, scene, frame, onSave, getUnits = () => 'in16', onOpenChange }) {
  const el = document.createElement('div');
  el.id = 'designer';
  document.getElementById('app').appendChild(el);

  const group = new THREE.Group();
  group.name = 'designPreview';
  group.visible = false;
  scene.add(group);

  let design = null;
  let source = null;        // the archetype it came from, if any
  let openPart = null;      // the part whose editor is unfolded
  let selected = null;      // highlighted in the preview
  let dirty = false;
  let redrawTimer = null;

  const f = (v) => formatLength(v, getUnits());
  const isOpen = () => el.classList.contains('open');

  function open(existing = null) {
    design = existing ? structuredClone(existing) : null;
    source = design?.from ? archetype(design.from) : null;
    openPart = null;
    selected = null;
    dirty = false;
    el.classList.add('open');
    group.visible = true;
    render();
    redraw({ fit: true });
    onOpenChange?.(true);
  }

  function close() {
    el.classList.remove('open');
    group.visible = false;
    clearPreview();
    onOpenChange?.(false);
  }

  // ---------- preview ----------

  function clearPreview() {
    for (const child of [...group.children]) {
      child.geometry?.dispose();
      child.material?.dispose?.();
      group.remove(child);
    }
  }

  function redraw({ fit = false } = {}) {
    clearPreview();
    if (!design) return;
    for (const solid of buildSolids(design)) {
      const g = new THREE.BufferGeometry();
      const verts = new Float32Array(solid.faces.length * 9);
      solid.faces.forEach((face, i) => face.forEach((idx, k) => {
        verts.set(solid.positions[idx], i * 9 + k * 3);
      }));
      g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
      g.computeVertexNormals();
      g.computeBoundingBox();
      const colour = design.materials?.[solid.part.material]?.color || '#d9b26a';
      const on = selected === solid.part.id;
      const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
        color: new THREE.Color(on ? '#ffb454' : colour), roughness: 0.75, metalness: 0,
      }));
      mesh.castShadow = mesh.receiveShadow = true;
      group.add(mesh);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(g, 25),
        new THREE.LineBasicMaterial({ color: on ? 0xffffff : 0x000000, transparent: true, opacity: on ? 0.9 : 0.45 }),
      );
      group.add(edges);
    }
    const box = designBounds(design);
    if (fit && box && frame) {
      frame(new THREE.Box3(new THREE.Vector3(...box.min), new THREE.Vector3(...box.max)));
    }
  }

  // Redrawing on every keystroke of a number field is wasteful; a short wait
  // keeps typing smooth and still feels immediate.
  function changed({ fit = false, rerender = true } = {}) {
    dirty = true;
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(() => redraw({ fit }), 60);
    if (rerender) renderSummary();
  }

  // ---------- rendering ----------

  // Rebuilds the panel. A parameter change rewrites every part, so the whole
  // panel has to follow - but not at the cost of throwing you out of the box
  // you are typing in, so the focused field is put back afterwards.
  function render({ keepFocus = false } = {}) {
    const focus = keepFocus && document.activeElement?.dataset?.key;
    const scroll = el.querySelector('.dz-body')?.scrollTop || 0;
    el.innerHTML = design ? designHtml() : startHtml();
    bind();
    const body = el.querySelector('.dz-body');
    if (body) body.scrollTop = scroll;
    if (focus) el.querySelector(`.dz-param[data-key="${focus}"]`)?.focus();
  }

  function startHtml() {
    return `<div class="dz-head"><h2>Design something</h2><button class="dz-close" title="Close (Esc)">×</button></div>
      <div class="dz-body">
        <p class="muted small">Start from a piece that is already right, then change its numbers. Everything you change is checked as you go, and what you save gets a cut list, a cutting diagram and full-size templates like any other model.</p>
        ${ARCHETYPES.map((a) => `<button class="dz-arch" data-arch="${a.key}">
          <b>${escapeHtml(a.name)}</b><span>${escapeHtml(a.what)}</span></button>`).join('')}
        <button class="dz-arch" data-arch=""><b>Empty</b><span>Start with nothing and add parts one at a time.</span></button>
      </div>`;
  }

  function designHtml() {
    return `<div class="dz-head">
        <input class="dz-title" value="${escapeHtml(design.title || '')}" aria-label="Design name" />
        <button class="dz-close" title="Close (Esc)">×</button>
      </div>
      <div class="dz-body">
        ${source ? paramsHtml() : ''}
        ${partsHtml()}
        ${jointsHtml()}
        <div class="dz-review"></div>
      </div>
      <div class="dz-foot">
        <span class="dz-count muted small"></span>
        <button class="dz-save primary">Save &amp; open</button>
      </div>`;
  }

  function paramsHtml() {
    const p = design.params || {};
    return `<details class="dz-sec" open><summary>Size</summary>
      <div class="dz-grid">${Object.entries(source.params).map(([key, spec]) => `
        <label title="${escapeHtml(spec.note || '')}">${escapeHtml(spec.label)}
          <input type="number" class="dz-param" data-key="${key}" value="${p[key] ?? spec.value}"
            min="${spec.min}" max="${spec.max}" step="${spec.step}" />
        </label>`).join('')}
      </div>
      ${Object.values(source.params).some((s) => s.note) ? `<ul class="dz-notes">${Object.values(source.params).filter((s) => s.note).map((s) => `<li><b>${escapeHtml(s.label)}:</b> ${escapeHtml(s.note)}</li>`).join('')}</ul>` : ''}
    </details>`;
  }

  function partsHtml() {
    const parts = design.parts || [];
    return `<details class="dz-sec" open><summary>Parts (${parts.length})</summary>
      ${parts.map((part) => partRow(part)).join('') || '<p class="muted small">No parts yet.</p>'}
      <button class="dz-add">+ Add a part</button>
    </details>`;
  }

  const summaryOf = (part) => `${[2, 1, 0].map((i) => f(part.size[i])).join(' × ')}${part.instances.length > 1 ? ` · ×${part.instances.length}` : ''}`;

  function partRow(part) {
    const open = openPart === part.id;
    return `<div class="dz-part${open ? ' open' : ''}" data-part="${escapeHtml(part.id)}">
      <button class="dz-part-head" data-act="toggle">
        <b>${escapeHtml(part.name || part.id)}</b>
        <span class="muted">${escapeHtml(summaryOf(part))}</span>
      </button>
      ${open ? partEditor(part) : ''}
    </div>`;
  }

  function partEditor(part) {
    const materials = Object.keys(design.materials || {});
    return `<div class="dz-edit">
      <div class="dz-grid">
        <label>Name<input class="dz-f" data-f="name" value="${escapeHtml(part.name || '')}" /></label>
        <label>Assembly<input class="dz-f" data-f="group" value="${escapeHtml(part.group || '')}" /></label>
        <label>Material<select class="dz-f" data-f="material">
          ${materials.map((m) => `<option${m === part.material ? ' selected' : ''}>${escapeHtml(m)}</option>`).join('')}
        </select></label>
      </div>
      <div class="dz-grid dz-size">
        <label title="Along the grain">Length<input type="number" step="0.0625" min="0.0625" class="dz-f" data-f="size0" value="${part.size[0]}" /></label>
        <label>Width<input type="number" step="0.0625" min="0.0625" class="dz-f" data-f="size1" value="${part.size[1]}" /></label>
        <label>Thickness<input type="number" step="0.0625" min="0.0625" class="dz-f" data-f="size2" value="${part.size[2]}" /></label>
      </div>
      <div class="dz-places">
        ${part.instances.map((inst, i) => `
          <div class="dz-place" data-i="${i}">
            <span class="dz-place-n">${i + 1}</span>
            ${['x', 'y', 'z'].map((ax, k) => `<label>${ax}<input type="number" step="0.25" class="dz-f" data-f="at${k}" value="${round(inst.at?.[k] ?? 0)}" /></label>`).join('')}
            <label title="Which way its length runs - and its grain with it">length runs
              <select class="dz-f" data-f="along">${AXIS_OPTIONS.map((a) => `<option value="${a}"${a === (inst.along || 'x') ? ' selected' : ''}>${a}${AXIS_NAMES[a.replace('-', '')] ? ` (${AXIS_NAMES[a.replace('-', '')]})` : ''}</option>`).join('')}</select>
            </label>
            <label title="Which way its thickness runs">thickness
              <select class="dz-f" data-f="up">${AXIS_OPTIONS.map((a) => `<option value="${a}"${a === (inst.up || 'y') ? ' selected' : ''}>${a}</option>`).join('')}</select>
            </label>
            <button class="dz-x" data-act="unplace" title="Remove this one">×</button>
          </div>`).join('')}
        <button class="dz-small" data-act="place">+ Another one</button>
      </div>
      <div class="dz-part-acts">
        <button class="dz-small" data-act="dup">Duplicate part</button>
        <button class="dz-small danger" data-act="del">Delete part</button>
      </div>
    </div>`;
  }

  function jointsHtml() {
    const joints = design.joints || [];
    const parts = design.parts || [];
    const name = (id) => escapeHtml(parts.find((p) => p.id === id)?.name || id);
    return `<details class="dz-sec"><summary>Joints (${joints.length})</summary>
      ${joints.map((j, i) => `<div class="dz-joint" data-j="${i}">
        <span>${name(j.from)}${j.end != null ? ` <span class="muted">(${j.end ? 'far' : 'near'} end)</span>` : ''} → ${name(j.into)}</span>
        <select class="dz-jtype">${JOINT_CHOICES.map((t) => `<option value="${t}"${t === j.type ? ' selected' : ''}>${escapeHtml(JOINT_LABELS[t] || t)}</option>`).join('')}</select>
        <button class="dz-x" data-act="unjoin" title="Remove">×</button>
      </div>`).join('')}
      ${parts.length > 1 ? `<div class="dz-joint dz-newjoint">
        <select class="dz-jfrom">${parts.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.id)}</option>`).join('')}</select>
        <select class="dz-jend"><option value="0">near end</option><option value="1">far end</option></select>
        <select class="dz-jinto">${parts.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.id)}</option>`).join('')}</select>
        <select class="dz-jtypenew">${JOINT_CHOICES.map((t) => `<option value="${t}">${escapeHtml(JOINT_LABELS[t] || t)}</option>`).join('')}</select>
        <button class="dz-small" data-act="join">Add</button>
      </div>` : ''}
      <p class="muted small">A mortise and tenon, a round tenon or a through tenon is drawn on the part: its length grows by the tenon, and the part it goes into gets the mortise. The rest are noted on the cut sheet.</p>
    </details>`;
  }

  // The review, and the running totals, without rebuilding the whole panel.
  function renderSummary() {
    const box = el.querySelector('.dz-review');
    if (!box || !design) return;
    const result = reviewModel(designReviewModel(design), { units: getUnits() });
    box.innerHTML = reviewHtml(result, { open: box.querySelector('details')?.open ?? false });
    const count = el.querySelector('.dz-count');
    if (count) {
      const pieces = (design.parts || []).reduce((a, p) => a + (p.instances?.length || 0), 0);
      const bounds = designBounds(design);
      count.textContent = bounds
        ? `${design.parts.length} parts, ${pieces} pieces · ${f(bounds.size[0])} × ${f(bounds.size[2])} × ${f(bounds.size[1])} high`
        : `${design.parts.length} parts`;
    }
  }

  // ---------- events ----------

  function bind() {
    renderSummary();
    el.querySelector('.dz-close')?.addEventListener('click', () => {
      if (!dirty || window.confirm('Close the designer? Anything not saved is lost.')) close();
    });
    el.querySelectorAll('[data-arch]').forEach((b) => b.addEventListener('click', () => {
      const key = b.dataset.arch;
      design = key ? { ...buildArchetype(key), from: key } : emptyDesign();
      source = key ? archetype(key) : null;
      dirty = true;
      render();
      redraw({ fit: true });
    }));
    el.querySelector('.dz-title')?.addEventListener('input', (e) => { design.title = e.target.value; dirty = true; });
    el.querySelector('.dz-save')?.addEventListener('click', save);
    el.querySelector('.dz-add')?.addEventListener('click', () => {
      const part = newPart(design);
      design.parts.push(part);
      openPart = part.id;
      render();
      redraw();
    });
    // Changing an archetype's number rebuilds the piece from it, keeping the
    // name you gave it.
    el.querySelectorAll('.dz-param').forEach((input) => input.addEventListener('input', () => {
      const params = { ...defaultParams(source), ...design.params };
      params[input.dataset.key] = Number(input.value);
      const title = design.title;
      design = { ...buildArchetype(source.key, params), from: source.key, title };
      dirty = true;
      clearTimeout(redrawTimer);
      redrawTimer = setTimeout(() => redraw(), 60);
      render({ keepFocus: true });          // every part's size just changed
    }));
    el.querySelectorAll('.dz-part').forEach(bindPart);
    bindJoints();
  }

  function bindPart(node) {
    const part = design.parts.find((p) => p.id === node.dataset.part);
    if (!part) return;
    node.querySelector('[data-act="toggle"]').addEventListener('click', () => {
      openPart = openPart === part.id ? null : part.id;
      selected = openPart;
      render();
      redraw();
    });
    node.querySelectorAll('.dz-f').forEach((input) => {
      input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', () => {
        const key = input.dataset.f;
        const place = input.closest('.dz-place');
        const inst = place ? part.instances[Number(place.dataset.i)] : null;
        if (key.startsWith('size')) part.size[Number(key.slice(4))] = Math.max(0.0625, Number(input.value) || 0);
        else if (key.startsWith('at') && inst) {
          inst.at = [...(inst.at || [0, 0, 0])];
          inst.at[Number(key.slice(2))] = Number(input.value) || 0;
        } else if (inst) inst[key] = input.value;
        else if (key === 'name' || key === 'group' || key === 'material') part[key] = input.value;
        changed();
        // Keep the row's own summary honest without rebuilding the editor
        // under the cursor.
        node.querySelector('.dz-part-head b').textContent = part.name || part.id;
        node.querySelector('.dz-part-head .muted').textContent = summaryOf(part);
      });
    });
    node.querySelector('[data-act="place"]')?.addEventListener('click', () => {
      const last = part.instances[part.instances.length - 1] || { at: [0, 0, 0], along: 'x', up: 'y' };
      part.instances.push({ ...last, at: [(last.at?.[0] || 0) + part.size[0] + 2, last.at?.[1] || 0, last.at?.[2] || 0] });
      render();
      redraw();
    });
    node.querySelectorAll('[data-act="unplace"]').forEach((b) => b.addEventListener('click', () => {
      if (part.instances.length < 2) return;
      part.instances.splice(Number(b.closest('.dz-place').dataset.i), 1);
      render();
      redraw();
    }));
    node.querySelector('[data-act="dup"]')?.addEventListener('click', () => {
      const copy = structuredClone(part);
      copy.id = `${part.id}-${design.parts.length + 1}`;
      copy.name = `${part.name} copy`;
      design.parts.push(copy);
      openPart = copy.id;
      render();
      redraw();
    });
    node.querySelector('[data-act="del"]')?.addEventListener('click', () => {
      design.parts = design.parts.filter((p) => p !== part);
      design.joints = (design.joints || []).filter((j) => j.from !== part.id && j.into !== part.id);
      openPart = null;
      render();
      redraw();
    });
  }

  function bindJoints() {
    el.querySelectorAll('.dz-joint[data-j]').forEach((node) => {
      const j = design.joints[Number(node.dataset.j)];
      node.querySelector('.dz-jtype')?.addEventListener('change', (e) => { j.type = e.target.value; changed(); });
      node.querySelector('[data-act="unjoin"]')?.addEventListener('click', () => {
        design.joints.splice(Number(node.dataset.j), 1);
        render();
        redraw();
      });
    });
    el.querySelector('[data-act="join"]')?.addEventListener('click', () => {
      const get = (c) => el.querySelector(c)?.value;
      const from = get('.dz-jfrom'), into = get('.dz-jinto');
      if (!from || !into || from === into) return;
      design.joints = design.joints || [];
      design.joints.push({ from, into, end: Number(get('.dz-jend')), type: get('.dz-jtypenew') });
      render();
      redraw();
    });
  }

  async function save() {
    const button = el.querySelector('.dz-save');
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      const out = compileDesign(design);
      if (!out.stats.parts) throw new Error('Nothing to save yet - add a part first.');
      await onSave(out, design);
      dirty = false;
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Save & open';
      window.alert(err.message || String(err));
    }
  }

  // Esc closes; typing never reaches the viewer's one-key shortcuts.
  el.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' && !/^(INPUT|SELECT)$/.test(e.target.tagName)) close();
  });

  return { open, close, isOpen, current: () => design };
}

const round = (v) => Math.round(v * 1000) / 1000;
