// The designer: direct 3D manipulation with an exact part inspector.
// Transform handles and point snapping edit the same design that the
// parameter controls, joinery editor and woodworking review use.
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
import { DesignHistory, pieceKey } from './modeling.js';
import { SPECIES } from './woodtex.js';
import { solidWoodMaterial, grainCoordinates, grainSeed, GRAIN_CUTS } from './solidwood.js';
import { smoothNormals } from './look.js';
import { resolvedJoints, jointKey } from './autojoints.js';
import { initDesignControls } from './designcontrols.js';

const AXIS_NAMES = { x: 'side to side', y: 'up', z: 'front to back' };
const AXIS_OPTIONS = ['x', 'y', 'z', '-x', '-y', '-z'];
const JOINT_CHOICES = ['mortise-tenon', 'dovetail', 'none', 'through-tenon', 'round-tenon', 'dado', 'half-lap', 'dowel', 'pocket-screw', 'butt-screw', 'buttons', 'edge-glue'];

// ---------- the panel ----------

export function initDesigner({ THREE, TransformControls, canvas, orbit, getCamera, scene, frame, frameSelection = frame, redrawScene, invalidateShadows, onSave, getUnits = () => 'in16', onOpenChange }) {
  const el = document.createElement('div');
  el.id = 'designer';
  document.getElementById('app').appendChild(el);

  const group = new THREE.Group();
  group.name = 'designPreview';
  group.visible = false;
  scene.add(group);

  const previewMaterials = new Map();
  let design = null;
  let source = null;        // the archetype it came from, if any
  let openPart = null;      // the part whose editor is unfolded
  let dirty = false;
  let redrawTimer = null;
  let step = 'size';
  let draftKey = '';
  let draft = null;
  let draftStatus = '';
  let inspectJoints = false;
  const history = new DesignHistory();
  const tools = initDesignControls({
    THREE, TransformControls, scene, canvas, orbit, getCamera, history,
    getDesign: () => design, getMeshes: () => group.children.filter((child) => child.isMesh),
    redraw: redrawScene, onFrame: frameSelection,
    onSelect: (keys) => {
      const first = (design?.parts || []).find((part) => part.instances.some((_, i) => keys.has(pieceKey(part.id, i))));
      openPart = first?.id || null; step = 'parts'; render(); redraw();
    },
    onEdit: (live) => {
      clearTimeout(redrawTimer);
      if (!live) { dirty = true; rememberDraft(); render(); }
      redraw();
    },
    onUndo: () => restore(history.undo()), onRedo: () => restore(history.redo()),
  });

  function restore(value) {
    if (value === undefined || value === null) return;
    design = value; source = archetype(design.from);
    dirty = true; rememberDraft(); render(); redraw();
  }


  function rememberDraft() {
    if (!design || !dirty) return;
    if (history.past.at(-1) === 'null') history.reset(design); else history.record(design);
    try {
      localStorage.setItem(draftKey, JSON.stringify(design));
      draftStatus = 'Draft saved in this browser';
    } catch { draftStatus = 'Draft could not be saved — keep this page open'; }
    const status = el.querySelector('.dz-draft-status');
    if (status) status.textContent = draftStatus;
  }
  function requestClose() {
    rememberDraft();
    if (dirty && draftStatus.startsWith('Draft could not') && !window.confirm('Browser storage is unavailable. Close and lose these unsaved changes?')) return;
    close();
  }

  const f = (v) => formatLength(v, getUnits());
  const isOpen = () => el.classList.contains('open');

  function open(existing = null, options = {}) {
    clearTimeout(redrawTimer);
    inspectJoints = false;
    draftKey = options.draftKey || 'woodmodels:design-draft:new';
    draft = null;
    draftStatus = '';
    try { draft = JSON.parse(localStorage.getItem(draftKey)); } catch { /* unavailable */ }
    design = existing ? structuredClone(existing) : options.blank && !draft ? emptyDesign() : null;
    step = design ? 'parts' : 'size';
    source = design?.from ? archetype(design.from) : null;
    openPart = null;
    dirty = false;
    history.reset(design);
    tools.setOpen(true);
    el.classList.add('open');
    group.visible = true;
    onOpenChange?.(true);
    render();
    redraw({ fit: true });
  }

  function close() {
    clearTimeout(redrawTimer);
    tools.setOpen(false);
    el.classList.remove('open');
    group.visible = false;
    clearPreview();
    onOpenChange?.(false);
    redrawScene?.();
  }

  // ---------- preview ----------

  function clearPreview() {
    for (const child of [...group.children]) {
      child.geometry?.dispose();
      if (!child.isMesh) child.material?.dispose?.();
      group.remove(child);
    }
  }

  function redraw({ fit = false } = {}) {
    clearPreview();
    if (!design) return;
    const designBox = designBounds(design);
    const solids = buildSolids(design);
    for (const solid of solids) {
      const g = new THREE.BufferGeometry();
      const verts = new Float32Array(solid.faces.length * 9);
      solid.faces.forEach((face, i) => face.forEach((idx, k) => {
        verts.set(solid.positions[idx], i * 9 + k * 3);
      }));
      g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
      if (Object.values(solid.tenons).some((t) => t.round)) smoothNormals(g); else g.computeVertexNormals();
      g.computeBoundingBox();
      const species = design.materials?.[solid.part.material]?.species || 'maple';
      const instanceIndex = solid.part.instances.indexOf(solid.inst);
      const on = tools.selection().has(pieceKey(solid.part.id, instanceIndex));
      grainCoordinates(g, solid.basis, solid.inst.at || [0, 0, 0], grainSeed(`${solid.part.id}:${instanceIndex}:${solid.inst.grainVariant || 0}`), solid.part.grainCut);
      const materialKey = `${species}:${on}`;
      if (!previewMaterials.has(materialKey)) {
        const material = solidWoodMaterial(species);
        if (on) { material.emissive.set('#bd752a'); material.emissiveIntensity = 0.12; }
        previewMaterials.set(materialKey, material);
      }
      const material = previewMaterials.get(materialKey);
      const mesh = new THREE.Mesh(g, material);
      mesh.userData = { partId: solid.part.id, instanceIndex, solid };
      mesh.castShadow = mesh.receiveShadow = true;
      group.add(mesh);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(g, 25),
        new THREE.LineBasicMaterial({ color: on ? 0xffffff : 0x000000, transparent: true, opacity: on ? 0.75 : 0.12 }),
      );
      group.add(edges);
      if (inspectJoints && designBox) {
        const center = designBox.min.map((v, i) => (v + designBox.max[i]) / 2);
        const offset = solid.center.map((v, i) => (v - center[i]) * 0.32);
        if (Math.hypot(...offset) < 0.1) offset[1] = Math.max(...designBox.size) * 0.15;
        mesh.position.fromArray(offset); edges.position.copy(mesh.position);
      }
    }
    const box = designBounds(design);
    if (fit && box && frame) {
      frame(new THREE.Box3(new THREE.Vector3(...box.min), new THREE.Vector3(...box.max)));
    }
    if (inspectJoints && fit) {
      const joint=resolvedJoints(design).find((j)=>j.type!=='none');
      const from=solids.find((s)=>s.part.id===joint?.from), into=solids.find((s)=>s.part.id===joint?.into);
      const dir=from && into ? new THREE.Vector3(...from.center).sub(new THREE.Vector3(...into.center)).normalize().multiplyScalar(1.1).add(new THREE.Vector3(0.35,0.45,0.7)).toArray() : undefined;
      frameSelection?.(new THREE.Box3().setFromObject(group), dir);
    }
    tools.sync();
    invalidateShadows?.();
    // The viewer only draws when something changes, and this is something.
    redrawScene?.();
  }

  // Redrawing on every keystroke of a number field is wasteful; a short wait
  // keeps typing smooth and still feels immediate.
  function changed({ fit = false, rerender = true } = {}) {
    dirty = true;
    rememberDraft();
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(() => { redraw({ fit }); const node = el.querySelector('.dz-connections'); if (node) { node.innerHTML = jointsHtml(); bindJoints(); } }, 60);
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
    el.dataset.step = step;
    bind();
    tools.mount(el.querySelector('.dz-tools-mount'));
    const body = el.querySelector('.dz-body');
    if (body) body.scrollTop = scroll;
    if (focus) el.querySelector(`.dz-param[data-key="${focus}"]`)?.focus();
  }

  function startHtml() {
    return `<div class="dz-head"><h2>New project</h2><button class="dz-close" title="Close (Esc)">×</button></div>
      <div class="dz-body">
        <p class="muted small">Choose a starting point. Size it for your space and the wood you have, then open its cut list and build plan. All dimension fields use inches.</p>
        ${draftHtml()}
        ${ARCHETYPES.map((a) => `<button class="dz-arch" data-arch="${a.key}">
          <b>${escapeHtml(a.name)}</b><span>${escapeHtml(a.what)}</span></button>`).join('')}
        <button class="dz-arch" data-arch=""><b>Blank project</b><span>Start with nothing and add parts one at a time.</span></button>
      </div>`;
  }

  function draftHtml() {
    return draft ? `<div class="dz-draft"><b>Unfinished: ${escapeHtml(draft.title || 'Untitled project')}</b><div><button class="dz-resume dz-small">Resume draft</button> <button class="dz-discard dz-small">Discard draft</button></div></div>` : '';
  }

  function designHtml() {
    return `<div class="dz-head">
        <input class="dz-title" value="${escapeHtml(design.title || '')}" aria-label="Design name" />
        <button class="dz-close" title="Close (Esc)">×</button>
      </div>
      <nav class="dz-steps" aria-label="Design steps">
        ${[['size', 'Customize'], ['parts', 'Model'], ['review', 'Review']].map(([key, label]) => `<button data-step="${key}" aria-current="${step === key ? 'step' : 'false'}">${label}</button>`).join('')}
      </nav>
      <div class="dz-tools-mount"></div>
      <div class="dz-body">
        ${draftHtml()}
        <section class="dz-stage dz-stage-size">
          <h3 class="dz-section-title">${source ? escapeHtml(source.name) : 'Custom project'}</h3><p class="muted small">Set your starting proportions. Dimensions are in inches.</p>
          ${source ? paramsHtml() + woodChoiceHtml() : '<p>Build your project one part at a time in <b>Model</b>.</p>'}
          <button class="dz-small dz-restart">Change starting point</button>
        </section>
        <section class="dz-stage dz-stage-parts">
          ${partsStageHtml()}
        </section>
        <section class="dz-stage dz-stage-review">
          <h3>Ready for the shop?</h3>
          <p class="muted small">Check the findings below, then open your project for its cut list, full-size templates and build steps. You can come back to Design to make changes.</p>
          <div class="dz-review"></div>
        </section>
      </div>
      <div class="dz-foot">
        <div><span class="dz-count muted small"></span><div class="dz-draft-status muted small" role="status">${escapeHtml(draftStatus)}</div></div>
        <button class="dz-next dz-small">${step === 'size' ? 'Start modeling →' : 'Review & build →'}</button>
        <button class="dz-save primary">Open build plan</button>
      </div>`;
  }

  function paramsHtml() {
    const p = design.params || {};
    return `<details class="dz-sec" open><summary>Overall dimensions &amp; stock sizes</summary>
      <div class="dz-grid">${Object.entries(source.params).map(([key, spec]) => `
        <label title="${escapeHtml(spec.note || '')}">${escapeHtml(spec.label)}
          <input type="number" class="dz-param" data-key="${key}" value="${p[key] ?? spec.value}"
            min="${spec.min}" max="${spec.max}" step="${key === 'shelves' ? 1 : 'any'}" />
        </label>`).join('')}
      </div>
      ${Object.values(source.params).some((s) => s.note) ? `<ul class="dz-notes">${Object.values(source.params).filter((s) => s.note).map((s) => `<li><b>${escapeHtml(s.label)}:</b> ${escapeHtml(s.note)}</li>`).join('')}</ul>` : ''}
    </details>`;
  }

  function woodChoiceHtml() {
    return `<label class="dz-project-wood">Project wood<select class="dz-wood">${Object.entries(SPECIES).map(([key, spec]) => `<option value="${key}"${(design.woodSpecies || Object.values(design.materials)[0]?.species) === key ? ' selected' : ''}>${spec.name}</option>`).join('')}</select></label>`;
  }
  function applyProjectWood(key) {
    if (!SPECIES[key]) return;
    const spec = SPECIES[key]; design.woodSpecies = key;
    design.materials[spec.name] = { category: 'Wood', species: key, color: spec.early };
    design.parts.forEach((p) => { p.material = spec.name; });
  }

  function partsStageHtml() {
    return `<p class="muted small dz-hint">Select a board to edit. Shift-click adds to the selection.</p><div class="dz-connections">${jointsHtml()}</div>${partsHtml()}`;
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
    const materials = [...new Set([...Object.keys(design.materials || {}), ...Object.values(SPECIES).map((s) => s.name)])];
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
      <div class="dz-grid"><label>Grain cut<select class="dz-f" data-f="grainCut">${Object.entries(GRAIN_CUTS).map(([key, name]) => `<option value="${key}"${(part.grainCut || 'plain') === key ? ' selected' : ''}>${name}</option>`).join('')}</select></label><button class="dz-small dz-grain-new" data-act="grain">New grain pattern</button></div>
      <details class="dz-placement"><summary>Position & orientation</summary><div class="dz-places">
        ${part.instances.map((inst, i) => `
          <div class="dz-place" data-i="${i}">
            <span class="dz-place-n">${i + 1}</span>
            ${['x', 'y', 'z'].map((ax, k) => `<label>${ax}<input type="number" step="0.25" class="dz-f" data-f="at${k}" value="${round(inst.at?.[k] ?? 0)}" /></label>`).join('')}
            <label title="Which way its length runs - and its grain with it">length runs
              <select class="dz-f" data-f="along">${Array.isArray(inst.along) ? '<option value="custom" selected>Custom rotation</option>' : ''}${AXIS_OPTIONS.map((a) => `<option value="${a}"${a === (inst.along || 'x') ? ' selected' : ''}>${a}${AXIS_NAMES[a.replace('-', '')] ? ` (${AXIS_NAMES[a.replace('-', '')]})` : ''}</option>`).join('')}</select>
            </label>
            <label title="Which way its thickness runs">thickness
              <select class="dz-f" data-f="up">${Array.isArray(inst.up) ? '<option value="custom" selected>Custom rotation</option>' : ''}${AXIS_OPTIONS.map((a) => `<option value="${a}"${a === (inst.up || 'y') ? ' selected' : ''}>${a}</option>`).join('')}</select>
            </label>
            <button class="dz-x" data-act="unplace" title="Remove this one">×</button>
          </div>`).join('')}
        <button class="dz-small" data-act="place">+ Another one</button>
      </div>
      </details><div class="dz-part-acts">
        <button class="dz-small" data-act="dup">Duplicate part</button>
        <button class="dz-small danger" data-act="del">Delete part</button>
      </div>
    </div>`;
  }

  function jointsHtml() {
    const joints = resolvedJoints(design);
    const parts = design.parts || [];
    const name = (id) => escapeHtml(parts.find((p) => p.id === id)?.name || id);
    return `<div class="dz-joinery-controls"><label><input type="checkbox" class="dz-auto-joints"${design.autoJoinery ? ' checked' : ''}> Automatic joinery</label><button class="dz-inspect" aria-pressed="${inspectJoints}">${inspectJoints ? 'Back to assembly' : 'Inspect joints'}</button></div>
      <p class="muted small">${inspectJoints ? 'Pieces spread apart for inspection. Your actual placements are unchanged.' : 'Connections follow board contact. Choose a joint below to override the suggestion.'}</p>
      <details class="dz-sec"><summary>Connections (${joints.length})</summary>
      ${joints.map((j, i) => `<div class="dz-joint" data-j="${i}">
        <span>${name(j.from)}${j.fromInstance != null ? ` #${j.fromInstance + 1}` : ''}${j.automatic ? (design.jointChoices?.[jointKey(j)] ? ' · chosen' : ' · auto') : ''}${j.end != null ? ` <span class="muted">(${j.end ? 'far' : 'near'} end)</span>` : ''} → ${name(j.into)}</span>
        <select class="dz-jtype"><option value="auto"${!design.jointChoices?.[jointKey(j)] ? ' selected' : ''}>${j.automatic ? 'Automatic' : 'Preset'}: ${escapeHtml(JOINT_LABELS[resolvedJoints({ ...design, jointChoices: {} }).find((q) => jointKey(q) === jointKey(j))?.type] || j.type)}</option>${JOINT_CHOICES.map((t) => `<option value="${t}"${t === design.jointChoices?.[jointKey(j)] ? ' selected' : ''}>${escapeHtml(JOINT_LABELS[t] || t)}</option>`).join('')}</select>
        <button class="dz-x" data-act="unjoin" title="Remove">×</button>
      </div>`).join('')}
      ${parts.length > 1 ? `<div class="dz-joint dz-newjoint">
        <select class="dz-jfrom">${parts.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.id)}</option>`).join('')}</select>
        <select class="dz-jend"><option value="0">near end</option><option value="1">far end</option></select>
        <select class="dz-jinto">${parts.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.id)}</option>`).join('')}</select>
        <select class="dz-jtypenew">${JOINT_CHOICES.map((t) => `<option value="${t}">${escapeHtml(JOINT_LABELS[t] || t)}</option>`).join('')}</select>
        <button class="dz-small" data-act="join">Add</button>
      </div>` : ''}
      <p class="muted small">Mortises, tenons, dados, sliding dovetails and half-laps cut real geometry. Screws, buttons, glue and dowels remain construction notes.</p>
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
    el.querySelector('.dz-close')?.addEventListener('click', requestClose);
    el.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => { step = b.dataset.step; render(); }));
    el.querySelector('.dz-next')?.addEventListener('click', () => { step = step === 'size' ? 'parts' : 'review'; render(); });
    el.querySelector('.dz-resume')?.addEventListener('click', () => {
      design = structuredClone(draft); draft = null; source = archetype(design.from);
      history.reset(design); dirty = true; rememberDraft(); step = 'parts'; render(); redraw({ fit: true });
    });
    el.querySelector('.dz-discard')?.addEventListener('click', () => {
      try { localStorage.removeItem(draftKey); } catch { /* unavailable */ }
      draft = null; render();
    });
    el.querySelector('.dz-restart')?.addEventListener('click', () => {
      rememberDraft(); draft = structuredClone(design); design = null; source = null; render(); clearPreview(); redrawScene?.();
    });
    el.querySelectorAll('[data-arch]').forEach((b) => b.addEventListener('click', () => {
      if (draft && !window.confirm('Replace the unfinished draft with this starting point?')) return;
      const key = b.dataset.arch;
      design = key ? { ...buildArchetype(key), from: key } : emptyDesign();
      source = key ? archetype(key) : null;
      dirty = true; draft = null; step = key ? 'size' : 'parts';
      rememberDraft();
      render();
      redraw({ fit: true });
    }));
    el.querySelector('.dz-title')?.addEventListener('input', (e) => { design.title = e.target.value; dirty = true; rememberDraft(); });
    el.querySelector('.dz-save')?.addEventListener('click', save);
    // Changing an archetype's number rebuilds the piece from it, keeping the
    // name you gave it.
    el.querySelectorAll('.dz-param').forEach((input) => input.addEventListener('change', () => {
      if (!input.value || !input.checkValidity()) {
        window.alert(`Enter ${input.min} to ${input.max}${input.dataset.key === 'shelves' ? ' whole shelves' : ' inches'}. The previous value has been kept.`);
        input.value = design.params[input.dataset.key];
        return;
      }
      if (design.customized && !window.confirm('Changing overall dimensions rebuilds the starting design and replaces your custom parts and joints. Continue?')) { render(); return; }
      const params = { ...defaultParams(source), ...design.params };
      params[input.dataset.key] = Number(input.value);
      const title = design.title, woodSpecies = design.woodSpecies;
      design = { ...buildArchetype(source.key, params), from: source.key, title };
      applyProjectWood(woodSpecies);
      dirty = true; rememberDraft();
      clearTimeout(redrawTimer);
      redrawTimer = setTimeout(() => redraw(), 60);
      // Keep the active size field and navigation buttons in place. Replacing
      // them on blur would swallow the click that committed this value.
      el.querySelector('.dz-stage-parts').innerHTML = partsStageHtml();
      bindParts();
      renderSummary();
    }));
    el.querySelector('.dz-wood')?.addEventListener('change', (e) => { applyProjectWood(e.target.value); dirty = true; rememberDraft(); render(); redraw(); });
    bindParts();
  }

  function bindParts() {
    el.querySelector('.dz-add')?.addEventListener('click', () => {
      const part = newPart(design);
      design.parts.push(part);
      openPart = part.id;
      tools.select([pieceKey(part.id, 0)], false);
      design.customized = true; dirty = true; rememberDraft();
      render();
      redraw({ fit: true });
    });
    el.querySelectorAll('.dz-part').forEach(bindPart);
    bindJoints();
  }

  function bindPart(node) {
    const part = design.parts.find((p) => p.id === node.dataset.part);
    if (!part) return;
    node.querySelector('[data-act=grain]')?.addEventListener('click', () => {
      const selected = tools.selection();
      part.instances.forEach((inst, i) => { if (!selected.size || selected.has(pieceKey(part.id, i))) inst.grainVariant = (inst.grainVariant || 0) + 1; });
      dirty = true; rememberDraft(); redraw();
    });
    node.querySelector('[data-act="toggle"]').addEventListener('click', () => {
      openPart = openPart === part.id ? null : part.id;
      tools.select(openPart ? [pieceKey(part.id, 0)] : [], false);
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
        } else if (inst && input.value !== 'custom') { inst[key] = input.value; if (key === 'along' || key === 'up') delete inst.tilt; }
        else if (key === 'name' || key === 'group' || key === 'material' || key === 'grainCut') {
          part[key] = input.value;
          if (key === 'material' && !design.materials[input.value]) {
            const [species, spec] = Object.entries(SPECIES).find(([, s]) => s.name === input.value);
            design.materials[input.value] = { category: 'Wood', species, color: spec.early };
          }
        }
        design.customized = true;
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
      design.customized = true; dirty = true; rememberDraft();
      render();
      redraw();
    });
    node.querySelectorAll('[data-act="unplace"]').forEach((b) => b.addEventListener('click', () => {
      if (part.instances.length < 2) return;
      part.instances.splice(Number(b.closest('.dz-place').dataset.i), 1);
      design.customized = true; dirty = true; rememberDraft();
      render();
      redraw();
    }));
    node.querySelector('[data-act="dup"]')?.addEventListener('click', () => {
      const copy = structuredClone(part);
      copy.id = newPart(design).id;
      copy.name = `${part.name} copy`;
      design.parts.push(copy);
      openPart = copy.id;
      tools.select([pieceKey(copy.id, 0)], false);
      design.customized = true; dirty = true; rememberDraft();
      render();
      redraw();
    });
    node.querySelector('[data-act="del"]')?.addEventListener('click', () => {
      design.parts = design.parts.filter((p) => p !== part);
      design.joints = (design.joints || []).filter((j) => j.from !== part.id && j.into !== part.id);
      openPart = null;
      design.customized = true; dirty = true; rememberDraft();
      render();
      redraw();
    });
  }

  function bindJoints() {
    el.querySelector('.dz-auto-joints')?.addEventListener('change', (e) => {
      design.autoJoinery = e.target.checked; design.customized = true; dirty = true; rememberDraft(); render(); redraw();
    });
    el.querySelector('.dz-inspect')?.addEventListener('click', () => {
      inspectJoints = !inspectJoints; tools.setOpen(!inspectJoints); render(); redraw({ fit: true });
    });
    el.querySelectorAll('.dz-joint[data-j]').forEach((node) => {
      const j = resolvedJoints(design)[Number(node.dataset.j)];
      node.querySelector('.dz-jtype')?.addEventListener('change', (e) => {
        design.jointChoices ||= {};
        if (e.target.value === 'auto') delete design.jointChoices[jointKey(j)]; else design.jointChoices[jointKey(j)] = e.target.value;
        design.customized = true; dirty = true; rememberDraft(); render(); redraw();
      });
      node.querySelector('[data-act="unjoin"]')?.addEventListener('click', () => {
        design.jointChoices ||= {}; design.jointChoices[jointKey(j)] = 'none';
        design.customized = true; dirty = true; rememberDraft();
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
      design.customized = true; dirty = true; rememberDraft();
      render();
      redraw();
    });
  }

  async function save() {
    const button = el.querySelector('.dz-save');
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      if (!design.title?.trim()) throw new Error('Give your project a name first.');
      const out = compileDesign(design);
      if (!out.stats.parts) throw new Error('Nothing to save yet - add a part first.');
      await onSave(out, design);
      try { localStorage.removeItem(draftKey); } catch { /* unavailable */ }
      dirty = false;
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Open build plan';
      window.alert(err.message || String(err));
    }
  }

  // Esc closes; typing never reaches the viewer's one-key shortcuts.
  el.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (tools.keydown(e)) return;
    if (e.key === 'Escape' && !/^(INPUT|SELECT)$/.test(e.target.tagName)) requestClose();
  });

  return { open, close, requestClose, isOpen, meshes: () => group.children.filter((m) => m.isMesh), tools, keydown: tools.keydown, syncCamera: tools.sync, current: () => design };
}

const round = (v) => Math.round(v * 1000) / 1000;
