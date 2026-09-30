// Direct manipulation of the designer's real solids. The preview meshes are
// disposable; selection and edits always refer back to design part instances.
import { buildSolids, instanceBasis, newPart } from './design.js';
import { pieceKey, selectedPieces, duplicatePieces, deletePieces, makeUnique, solidAnchors, snapTranslation, translatePieces, rotatePieces } from './modeling.js';

export function initDesignControls({ THREE, TransformControls, scene, canvas, orbit, getCamera, getDesign, getMeshes, onSelect, onFrame, onEdit, onUndo, onRedo, history, redraw }) {
  let active = false, keys = new Set(), mode = 'translate', grid = 0.125, angle = 15, magnet = true;
  let space = 'world', dragBase = null, startPosition = null, startQuaternion = null;
  let movingAnchors = [], targetAnchors = [], down = null, didTransform = false, anchor = null;
  const target = new THREE.Object3D();
  scene.add(target);
  const gizmo = new TransformControls(getCamera(), canvas);
  gizmo.setSize(0.85);
  scene.add(gizmo);
  const marker = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: '#5ef0c1', depthTest: false }));
  marker.renderOrder = 1000;
  marker.visible = false;
  scene.add(marker);
  const raycaster = new THREE.Raycaster();
  const el = document.createElement('div');
  el.id = 'designTools';
  el.innerHTML = `<div class="dt-modes" role="group" aria-label="Modeling tools">
    <button data-mode="translate" title="Move (G)">Move</button><button data-mode="rotate" title="Rotate (R)">Rotate</button>
    <button data-mode="scale" title="Resize along a part's own axes (S)">Resize</button><button data-mode="snap" title="Pick a source point, then a destination point (P)">Snap place</button>
    </div><div class="dt-actions">
    <button data-action="add" title="Add a board to the design">+ Board</button><button data-action="undo" title="Undo (Ctrl+Z)">Undo</button><button data-action="redo" title="Redo (Ctrl+Shift+Z)">Redo</button>
    <button data-action="duplicate" title="Duplicate selected pieces (Ctrl+D)">Duplicate</button><button data-action="delete" title="Delete selected pieces">Delete</button>
    </div><div class="dt-quarter" aria-label="Quarter turns"><span>Turn</span><select class="dt-turn-axis" aria-label="Quarter turn axis"><option>X</option><option selected>Y</option><option>Z</option></select><button data-action="turn-left" title="Rotate minus 90 degrees">↶ −90°</button><button data-action="turn-right" title="Rotate plus 90 degrees">↷ +90°</button></div><div class="dt-selection" aria-live="polite"></div>
    <details class="dt-settings"><summary>Snapping &amp; exact transforms</summary>
      <div class="dt-grid">
        <label>Grid (in)<select class="dt-grid-step"><option value="0">Free</option><option value="0.0625">1/16</option><option value="0.125" selected>1/8</option><option value="0.25">1/4</option><option value="0.5">1/2</option><option value="1">1</option></select></label>
        <label>Angle<select class="dt-angle"><option value="0">Free</option><option value="5">5°</option><option value="15" selected>15°</option><option value="45">45°</option><option value="90">90°</option></select></label>
        <label>Move axes<select class="dt-space"><option value="world">World</option><option value="local">Part</option></select></label>
        <label class="dt-check"><input type="checkbox" class="dt-magnet" checked>Snap to pieces</label>
      </div>
      <form class="dt-exact"><label>Axis<select class="dt-axis"><option>X</option><option>Y</option><option>Z</option></select></label><label class="dt-value-label">Distance (in)<input class="dt-value" type="number" step="any" value="1" required></label><button type="submit">Apply</button></form>
      <div class="dt-actions"><button data-action="unique">Make independent</button><button data-action="assembly">Select assembly</button><button data-action="group">Group parts</button></div>
      <p class="muted small">G move · R rotate · S resize · P snap place · Shift-click selects more. X/Y/Z lock an axis. Esc cancels a drag or snap. Sizes apply to linked copies; Make independent separates one.</p>
    </details><div class="dt-status muted small" role="status">Click a piece in the model.</div>`;
  const status = (text) => { el.querySelector('.dt-status').textContent = text; };
  const pieces = () => selectedPieces(getDesign(), keys);
  const meshKey = (mesh) => pieceKey(mesh.userData.partId, mesh.userData.instanceIndex);
  const basisQuaternion = (inst) => {
    const b = instanceBasis(inst).map((v) => new THREE.Vector3(...v));
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(...b));
  };
  function tolerance(point) {
    const camera = getCamera(), height = canvas.getBoundingClientRect().height || 1;
    return camera.isOrthographicCamera ? (camera.top - camera.bottom) / camera.zoom / height * 14
      : camera.position.distanceTo(new THREE.Vector3(...point)) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 28 / height;
  }
  function showMarker(point) {
    marker.position.fromArray(point);
    marker.scale.setScalar(Math.max(0.03, tolerance(point) / 4));
    marker.visible = true;
    redraw?.();
  }
  function updateUi() {
    const selected = pieces();
    el.querySelectorAll('[data-mode]').forEach((b) => { b.setAttribute('aria-pressed', String(mode === b.dataset.mode)); });
    el.querySelector('[data-action=undo]').disabled = !history.canUndo;
    el.querySelector('[data-action=redo]').disabled = !history.canRedo;
    el.querySelectorAll('[data-action=duplicate],[data-action=delete],[data-action=assembly],[data-action=group],[data-action=turn-left],[data-action=turn-right]').forEach((b) => { b.disabled = !selected.length; });
    el.querySelector('[data-action=unique]').disabled = selected.length !== 1 || selected[0].part.instances.length < 2;
    el.querySelector('[data-mode=scale]').disabled = selected.length !== 1;
    el.querySelector('.dt-selection').textContent = selected.length === 1
      ? `${selected[0].part.name} · piece ${selected[0].index + 1} of ${selected[0].part.instances.length}${selected[0].part.instances.length > 1 ? ' · linked sizes' : ''}`
      : selected.length ? `${selected.length} pieces selected` : 'Select a piece · Shift-click to select more';
    const label = el.querySelector('.dt-value-label');
    label.firstChild.textContent = mode === 'rotate' ? 'Angle (degrees)' : mode === 'scale' ? 'Finished size (in)' : 'Distance (in)';
    const axis = el.querySelector('.dt-axis');
    const previous = axis.selectedIndex;
    axis.innerHTML = (mode === 'scale' ? ['Length', 'Width', 'Thickness'] : ['X', 'Y', 'Z']).map((name, i) => `<option value="${i}"${i === previous ? ' selected' : ''}>${name}</option>`).join('');
  }
  function sync() {
    gizmo.camera = getCamera();
    const selected = pieces();
    keys = new Set(selected.map(({ part, index }) => pieceKey(part.id, index)));
    el.hidden = !active || !getDesign();
    if (gizmo.dragging) return;
    if (!active || !selected.length || mode === 'snap' || (mode === 'scale' && selected.length !== 1)) gizmo.detach();
    else {
      target.position.set(0, 0, 0);
      selected.forEach(({ inst }) => target.position.add(new THREE.Vector3(...(inst.at || [0, 0, 0]))));
      target.position.divideScalar(selected.length);
      target.quaternion.copy(selected.length === 1 ? basisQuaternion(selected[0].inst) : new THREE.Quaternion());
      target.scale.set(1, 1, 1);
      target.updateMatrixWorld();
      gizmo.setMode(mode);
      gizmo.setSpace(mode === 'scale' ? 'local' : space);
      gizmo.setTranslationSnap(grid || null);
      gizmo.setRotationSnap(angle ? THREE.MathUtils.degToRad(angle) : null);
      gizmo.attach(target);
    }
    updateUi();
    redraw?.();
  }
  function select(next, reveal = true) {
    keys = new Set(next); anchor = null; marker.visible = false;
    status(keys.size ? '' : 'Click a piece in the model.');
    if (reveal) onSelect?.(keys);
    sync();
  }
  function setMode(next) {
    if (gizmo.dragging) return;
    mode = next; anchor = null; marker.visible = false;
    gizmo.showX = gizmo.showY = gizmo.showZ = true;
    status(mode === 'snap' ? 'Click a corner, edge midpoint or face centre on the piece to move.' : 'Drag a handle. Shift-click pieces for a multiple selection.');
    sync();
  }
  function commit() { getDesign().customized = true; onEdit?.(false); sync(); }
  function action(name) {
    if (gizmo.dragging) return;
    const design = getDesign();
    if (name === 'undo') { onUndo(); sync(); return; }
    if (name === 'redo') { onRedo(); sync(); return; }
    if (!design) return;
    if (name === 'add') {
      const part = newPart(design); design.parts.push(part);
      keys = new Set([pieceKey(part.id, 0)]);
      onSelect?.(keys); commit();
      const mesh = getMeshes().find((m) => keys.has(meshKey(m)));
      if (mesh) onFrame?.(new THREE.Box3().setFromObject(mesh));
      return;
    }
    if (!pieces().length) return;
    if (name === 'turn-left' || name === 'turn-right') {
      const axis = [0, 0, 0]; axis[el.querySelector('.dt-turn-axis').selectedIndex] = 1;
      const pivot = pieces().reduce((p, { inst }) => p.add(new THREE.Vector3(...(inst.at || [0, 0, 0]))), new THREE.Vector3()).divideScalar(pieces().length);
      rotatePieces(design, keys, axis, name === 'turn-left' ? -90 : 90, pivot.toArray());
    } else if (name === 'duplicate') keys = duplicatePieces(design, keys, [grid || 1, 0, grid || 1]);
    else if (name === 'delete') { deletePieces(design, keys); keys.clear(); }
    else if (name === 'unique' && pieces().length === 1) keys = new Set([makeUnique(design, [...keys][0])]);
    else if (name === 'assembly') {
      const groups = new Set(pieces().map(({ part }) => part.group));
      keys = new Set(design.parts.flatMap((part) => groups.has(part.group) ? part.instances.map((_, i) => pieceKey(part.id, i)) : []));
      select(keys); return;
    } else if (name === 'group') {
      const name = window.prompt('Assembly name (groups whole parts, including their linked copies):', 'New assembly');
      if (!name?.trim()) return;
      pieces().forEach(({ part }) => { part.group = name.trim(); });
    } else return;
    onSelect?.(keys); commit();
  }
  el.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  el.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => action(b.dataset.action)));
  el.querySelector('.dt-grid-step').addEventListener('change', (e) => { grid = Number(e.target.value); sync(); });
  el.querySelector('.dt-angle').addEventListener('change', (e) => { angle = Number(e.target.value); sync(); });
  el.querySelector('.dt-space').addEventListener('change', (e) => { space = e.target.value; sync(); });
  el.querySelector('.dt-magnet').addEventListener('change', (e) => { magnet = e.target.checked; });
  el.querySelector('.dt-exact').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = Number(el.querySelector('.dt-value').value), index = el.querySelector('.dt-axis').selectedIndex;
    if (!Number.isFinite(value) || !pieces().length) return;
    const vector = [0, 0, 0]; vector[index] = 1;
    if (mode === 'rotate') rotatePieces(getDesign(), keys, new THREE.Vector3(...vector).applyQuaternion(space === 'local' ? target.quaternion : new THREE.Quaternion()).toArray(), value, target.position.toArray());
    else if (mode === 'scale') {
      if (value <= 0 || pieces().length !== 1) { status('Choose one piece and a size above zero.'); return; }
      pieces()[0].part.size[index] = value;
    } else {
      const delta = new THREE.Vector3(...vector).multiplyScalar(value);
      if (space === 'local') delta.applyQuaternion(target.quaternion);
      translatePieces(getDesign(), keys, delta.toArray());
    }
    status('Exact transform applied.'); commit();
  });

  gizmo.addEventListener('change', () => redraw?.());
  gizmo.addEventListener('mouseDown', () => {
    dragBase = structuredClone(getDesign());
    startPosition = target.position.clone(); startQuaternion = target.quaternion.clone();
    didTransform = true;
    const solids = buildSolids(dragBase);
    const keyOf = (solid) => pieceKey(solid.part.id, solid.part.instances.indexOf(solid.inst));
    movingAnchors = solids.filter((s) => keys.has(keyOf(s))).flatMap(solidAnchors);
    targetAnchors = solids.filter((s) => !keys.has(keyOf(s))).flatMap(solidAnchors);
  });
  gizmo.addEventListener('dragging-changed', (e) => {
    orbit.enabled = !e.value;
    if (!e.value && dragBase) { dragBase = null; marker.visible = false; commit(); }
  });
  gizmo.addEventListener('objectChange', () => {
    if (!dragBase) return;
    const design = getDesign();
    Object.assign(design, structuredClone(dragBase));
    if (mode === 'translate') {
      let delta = target.position.clone().sub(startPosition).toArray();
      if (magnet && space === 'world') {
        const axes = [0, 1, 2].filter((i) => (gizmo.axis || 'XYZ').includes('XYZ'[i]));
        const snapped = snapTranslation(movingAnchors, targetAnchors, delta, axes, tolerance(target.position.toArray()));
        delta = snapped.delta;
        if (snapped.target) { showMarker(snapped.target.point); status(`Snapped ${snapped.source.kind} to ${snapped.target.kind}`); }
        else { marker.visible = false; status(grid ? `Grid: ${grid} in` : 'Free move'); }
      }
      translatePieces(design, keys, delta);
    } else if (mode === 'rotate') {
      const delta = target.quaternion.clone().multiply(startQuaternion.clone().invert());
      for (const { inst } of pieces()) {
        const basis = instanceBasis(inst);
        inst.at = new THREE.Vector3(...(inst.at || [0, 0, 0])).sub(startPosition).applyQuaternion(delta).add(startPosition).toArray();
        inst.along = new THREE.Vector3(...basis[0]).applyQuaternion(delta).toArray();
        inst.up = new THREE.Vector3(...basis[2]).applyQuaternion(delta).toArray();
        delete inst.tilt;
      }
      status(`Rotation: ${Math.round(THREE.MathUtils.radToDeg(gizmo.rotationAngle) * 100) / 100}°`);
    } else if (mode === 'scale' && pieces().length === 1) {
      const { part } = pieces()[0];
      part.size = part.size.map((v, i) => {
        const value = Math.max(1 / 64, v * Math.abs(target.scale.getComponent(i)));
        return grid ? Math.max(grid, Math.round(value / grid) * grid) : value;
      });
      status(`Size: ${part.size.map((n) => Math.round(n * 1000) / 1000).join(' × ')} in (L × W × T)`);
    }
    onEdit?.(true);
  });

  function hitAt(e) {
    const r = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), getCamera());
    return raycaster.intersectObjects(getMeshes(), false)[0];
  }
  function anchorAt(e) {
    const r = canvas.getBoundingClientRect(), camera = getCamera(), meshes = getMeshes();
    const visibility = new THREE.Raycaster();
    let best = null, distance = 18;
    // Search in screen space, including just outside a silhouette. Requiring
    // a surface hit makes corners unnecessarily difficult to pick.
    for (const mesh of meshes) {
      if (anchor && keys.has(meshKey(mesh))) continue;
      for (const a of solidAnchors(mesh.userData.solid)) {
        const world = new THREE.Vector3(...a.point), screen = world.clone().project(camera);
        if (screen.z < -1 || screen.z > 1) continue;
        const d = Math.hypot((screen.x + 1) * r.width / 2 + r.left - e.clientX, (1 - screen.y) * r.height / 2 + r.top - e.clientY);
        if (d >= distance) continue;
        visibility.setFromCamera(new THREE.Vector2(screen.x, screen.y), camera);
        const obstruction = visibility.intersectObjects(meshes, false)[0];
        if (obstruction && obstruction.distance < visibility.ray.origin.distanceTo(world) - 1e-4) continue;
        distance = d; best = { ...a, key: meshKey(mesh) };
      }
    }
    return best;
  }
  canvas.addEventListener('pointerdown', (e) => { if (active) { down = [e.clientX, e.clientY]; didTransform = false; gizmo.camera = getCamera(); } }, { capture: true });
  canvas.addEventListener('click', (e) => {
    if (!active || !getDesign() || didTransform || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
    const hit = hitAt(e);
    if (mode === 'snap') {
      let point = anchorAt(e);
      if (!hit && anchor) {
        const ground = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
        if (ground) point = { point: [grid ? Math.round(ground.x / grid) * grid : ground.x, 0, grid ? Math.round(ground.z / grid) * grid : ground.z], kind: 'ground grid', key: 'ground' };
      }
      if (!point) { status('Point at a visible corner, edge midpoint or face centre.'); return; }
      if (!anchor) {
        if (!keys.has(point.key)) keys = new Set([point.key]);
        anchor = point; onSelect?.(keys); sync(); showMarker(point.point);
        status(`${point.kind} picked. Click a point on another piece to place it here.`);
      } else {
        if (keys.has(point.key)) { status('Choose a destination on a different piece.'); return; }
        translatePieces(getDesign(), keys, point.point.map((n, i) => n - anchor.point[i]));
        anchor = null; marker.visible = false; commit();
        status(`Placed exactly on ${point.kind}. Pick another source point, or switch to Move.`);
      }
    } else if (hit) {
      const key = meshKey(hit.object), next = e.shiftKey ? new Set(keys) : new Set();
      if (e.shiftKey && next.has(key)) next.delete(key); else next.add(key);
      select(next);
    } else if (!e.shiftKey) select([]);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!active || mode !== 'snap' || e.buttons) return;
    const point = anchorAt(e);
    if (point) { showMarker(point.point); status(`${anchor ? 'Destination' : 'Source'}: ${point.kind}`); }
    else { marker.visible = false; redraw?.(); }
  });
  function cancel() {
    if (dragBase) {
      const original = dragBase; dragBase = null;
      Object.assign(getDesign(), original);
      gizmo.reset(); gizmo.dragging = false; orbit.enabled = true;
      onEdit?.(true); sync();
      status('Transform cancelled.');
      return true;
    }
    if (mode === 'snap') { anchor = null; marker.visible = false; setMode('translate'); return true; }
    return false;
  }
  function keydown(e) {
    if (!active || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return false;
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === 'z') action(e.shiftKey ? 'redo' : 'undo');
    else if ((e.ctrlKey || e.metaKey) && key === 'y') action('redo');
    else if ((e.ctrlKey || e.metaKey) && key === 'd') action('duplicate');
    else if (e.ctrlKey || e.metaKey || e.altKey) return false;
    else if (key === 'g') setMode('translate');
    else if (key === 'r') setMode('rotate');
    else if (key === 's') setMode('scale');
    else if (key === 'p') setMode('snap');
    else if (key === 'delete' || key === 'backspace') action('delete');
    else if (key === 'escape') { if (!cancel()) return false; }
    else if ('xyz'.includes(key) && key.length === 1) {
      const already = gizmo[`show${key.toUpperCase()}`] && ['X', 'Y', 'Z'].filter((a) => gizmo[`show${a}`]).length === 1;
      for (const a of ['X', 'Y', 'Z']) gizmo[`show${a}`] = already || a === key.toUpperCase();
      status(already ? 'All axes available.' : `${key.toUpperCase()} axis only.`); redraw?.();
    } else return false;
    e.preventDefault(); return true;
  }
  return {
    mount(node) { node?.appendChild(el); sync(); },
    setOpen(value) { active = value; if (!value) { cancel(); keys.clear(); marker.visible = false; gizmo.detach(); orbit.enabled = true; } sync(); },
    select, sync, keydown,
    selection: () => new Set(keys),
    bounds: () => {
      const box = new THREE.Box3();
      getMeshes().filter((mesh) => !keys.size || keys.has(meshKey(mesh))).forEach((mesh) => box.expandByObject(mesh));
      return box;
    },
    // State is inspectable by the existing browser test harness.
    gizmo, target,
  };
}
