// Sidebar cut list, totals, CSV export and the printable cut sheet.

import {
  formatLength, roughStock, displayName, toFraction, toCSV, escapeHtml, UNIT_OPTIONS, millingPlan, isGenericName,
  SHEET, looksLikeSheetGoods, isCut,
} from './format.js';
import { packBoards } from './nesting.js';
import { settings, updateSettings } from './settings.js';
import { normalizeEdits, rowStatus } from './edits.js';

// ---------- row preparation ----------

// Decorate parts_report.json rows with what the UI needs. Rows are ordered by
// category, then assembly group, then name - the order everything (sidebar,
// arrow-key navigation, CSV, print) uses. `edits` (edits.js) renames parts and
// groups and gives each row a status: null (in the build), 'aside' or 'deleted'.
export function prepareRows(rawRows, config, edits = config.edits) {
  const mats = config.materials || {};
  const order = [...(config.categoryOrder || ['Wood', 'Hardware', 'Leather', 'Other'])];
  if (!order.includes(SHEET)) order.splice(order.indexOf('Wood') + 1, 0, SHEET);
  const ed = normalizeEdits(edits);
  // groups nobody named (group_12, instance_9) are numbered Group 1, 2, ...
  const generic = [...new Set(rawRows.map((r) => String(r.top_group)))].filter(isGenericName).sort();
  const groupName = (g) => ed.groups[g] || (generic.includes(g) ? `Group ${generic.indexOf(g) + 1}` : displayName(g, config.displayNames));
  // single pieces deleted or set aside split off into their own row
  const split = [];
  rawRows.forEach((r) => {
    const names = r.obj_names || [];
    const off = (n) => ed.pieces[n] === 'deleted' || ed.pieces[n] === 'aside';
    const moved = names.filter(off);
    if (!moved.length || r.count !== names.length) { split.push(r); return; }
    const rest = names.filter((n) => !off(n));
    if (rest.length) split.push({ ...r, obj_names: rest, count: rest.length });
    ['deleted', 'aside'].forEach((st) => {
      const these = moved.filter((n) => ed.pieces[n] === st);
      if (these.length) split.push({ ...r, obj_names: these, count: these.length, pieceStatus: st });
    });
  });
  const rows = split.map((r) => {
    // parts with no material use the model's "(none)" setting, if it has one
    const matName = (r.materials || []).find((m) => mats[m]) || (r.materials || [])[0] || (mats['(none)'] ? '(none)' : '');
    let category = (mats[matName] && mats[matName].category) || 'Other';
    // plywood, MDF, a part named "1/8 Masonite"...: sheet goods, unless chosen otherwise in Set up
    if ((category === 'Wood' || category === 'Other') && !mats[matName]?.userCategory
      && looksLikeSheetGoods(matName, mats[matName]?.label, r.label)) category = SHEET;
    const [l, w, t] = r.dims;
    // parse_dae.py writes dims_str as sixteenths L x W x T; anything else is a
    // hand-written override (e.g. hex hardware) that should be shown as-is.
    const standard = `${toFraction(l)} x ${toFraction(w)} x ${toFraction(t)}`;
    // r.warning: parse_dae.py found the part's name disagrees with its geometry;
    // model.json notes are extra warnings the plan author adds by hand
    const configNote = (config.notes || {})[r.label];
    const warning = r.warning || configNote;
    const notes = [r.note, r.warning, configNote].filter(Boolean);
    const baseKey = `${r.label}|${r.dims.join('x')}`;
    const key = r.pieceStatus ? `${baseKey}#${r.pieceStatus}` : baseKey;
    return {
      ...r,
      key,
      baseKey,
      name: ed.names[baseKey] || displayName(r.label, config.displayNames),
      groupName: groupName(String(r.top_group)),
      category,
      material: matName,
      materialLabel: (mats[matName] && mats[matName].label) || (matName === '(none)' ? 'No material' : matName.replace(/^_+/, '')),
      color: (mats[matName] && mats[matName].color) || '#666',
      customDims: r.dims_str !== standard ? r.dims_str : null,
      notes,
      warn: !!warning,
      clickable: !!(r.obj_names && r.obj_names.length),
    };
  });
  rows.forEach((r) => {
    const s = rowStatus({ ...r, key: r.baseKey }, ed);
    r.status = s === 'deleted' || r.pieceStatus === 'deleted' ? 'deleted' : (s || r.pieceStatus || null);
  });
  const catRank = (c) => { const i = order.indexOf(c); return i < 0 ? order.length : i; };
  rows.sort((a, b) => catRank(a.category) - catRank(b.category)
    || String(a.top_group).localeCompare(String(b.top_group))
    || a.name.localeCompare(b.name));
  // Plan-style part letters: A, B, ... Z, AA, AB ...
  const letter = (i) => (i < 26 ? String.fromCharCode(65 + i) : letter(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));
  // only parts in the build get letters, so the plan reads A, B, C... without gaps
  let n = 0;
  rows.forEach((r, i) => { r.__id = i; r.letter = r.status ? '' : letter(n++); });
  return rows;
}

// Finished size in shop order: thickness x width x length.
export function finishedDims(row, units = settings().units) {
  if (row.customDims) return row.customDims;
  const [l, w, t] = row.dims;
  return `${formatLength(t, units)} × ${formatLength(w, units)} × ${formatLength(l, units)}`;
}

// A long round hardware part: a rod/bolt that needs a hole.
export const isRod = (row) => row.category === 'Hardware' && !row.customDims
  && Math.abs(row.dims[1] - row.dims[2]) < 0.02 && row.dims[0] > 3 * row.dims[1];

export function userNote(row) {
  return ((settings().userNotes || {})[row.key] || '').trim();
}

export function roughFor(row) {
  if (row.category !== 'Wood') return null;
  return roughStock(row.dims, settings().allowance);
}

export function roughDims(row, units = settings().units) {
  const r = roughFor(row);
  if (!r) return '';
  const t = units.startsWith('in') ? r.thicknessLabel : formatLength(r.thickness, units);
  return `${t} × ${formatLength(r.width, units)} × ${formatLength(r.length, units)}`;
}

export function totals(rows) {
  const wood = rows.filter((r) => r.category === 'Wood');
  const byMaterial = {};
  let roughBF = 0, finishedBF = 0, pieces = 0;
  wood.forEach((r) => {
    const rough = roughFor(r);
    const [l, w, t] = r.dims;
    const fin = (l * w * t) / 144 * r.count;
    const rb = rough.boardFeet * r.count;
    finishedBF += fin; roughBF += rb; pieces += r.count;
    const m = (byMaterial[r.materialLabel] = byMaterial[r.materialLabel] || { roughBF: 0, byThickness: {} });
    m.roughBF += rb;
    m.byThickness[rough.thicknessLabel] = (m.byThickness[rough.thicknessLabel] || 0) + rb;
  });
  // progress counts pieces, so ticking off "Bench x2" counts as two
  const cutSet = new Set(settings().cut);
  const done = wood.filter((r) => cutSet.has(r.key)).reduce((n, r) => n + r.count, 0);
  return { pieces, finishedBF, roughBF, byMaterial, done, trackable: pieces };
}

// ---------- sidebar ----------

let els = {};
let allRows = [];     // parts in the build
let asideRows = [];   // set aside: in the model, not in the build
let deletedRows = [];
let handlers = {};
let filterText = '';

// rows: every prepared row; the sidebar splits them by status
function splitRows(rows) {
  allRows = rows.filter((r) => !r.status);
  asideRows = rows.filter((r) => r.status === 'aside');
  deletedRows = rows.filter((r) => r.status === 'deleted');
}

// after parts are renamed, deleted or set aside
export function setCutListRows(rows) {
  splitRows(rows);
  renderRows();
}

export function renderCutList(container, rows, config, h) {
  splitRows(rows);
  handlers = h;
  container.innerHTML = `
    <div class="cl-head">
      <div class="cl-title-row">
        <h1>${escapeHtml(config.title || 'Cut List')}</h1>
        <div class="cl-model-btns">
          <button id="clBuild" class="primary" title="Step-by-step build guide for the shop: one part at a time, big, with the model assembling as you go">▶ Build</button>
          ${h.onSetup ? '<button id="clSetup" title="Name, which materials are wood, which way is front">Set up</button>' : ''}
          <button id="clLibrary" title="Upload a model (3D Warehouse Collada / KMZ) or switch models (M)">Models</button>
        </div>
      </div>
      ${config.subtitle ? `<div class="sub">${escapeHtml(config.subtitle)}</div>` : ''}
    </div>
    <div class="cl-controls">
      <input id="clSearch" type="search" placeholder="Filter parts…  ( / )" autocomplete="off" />
      <div class="cl-row">
        <label>Units <select id="clUnits">${UNIT_OPTIONS.map((u) => `<option value="${u.id}">${u.label}</option>`).join('')}</select></label>
        <label class="chk" title="Show the rough lumber to buy for each wood part: next standard thickness (4/4, 5/4, 8/4...) plus length/width allowance"><input id="clRough" type="checkbox" /> Rough stock</label>
      </div>
      <details id="clAllowance" class="cl-allow">
        <summary>Rough-stock allowances</summary>
        <label>Extra length <input data-k="length" type="number" step="0.125" min="0" /> in</label>
        <label>Extra width <input data-k="width" type="number" step="0.0625" min="0" /> in</label>
        <label>Planing (thickness) <input data-k="thickness" type="number" step="0.0625" min="0" /> in</label>
      </details>
      <div class="cl-row">
        <button id="clCsv" title="Download the cut list as a spreadsheet (CSV)">Export CSV</button>
        <button id="clPrint" title="Print a shop cut sheet with checkboxes">Print cut sheet</button>
      </div>
      <div class="cl-row">
        <button id="clDiagram" title="Lay the parts out on boards: what lumber to buy and how to cut it (C)">Shopping list &amp; cutting diagram</button>
      </div>
    </div>
    <div id="clSummary" class="cl-summary"></div>
    <div id="clList"></div>
    <div class="cl-foot">Dimensions are finished size, <b>T × W × L</b>. Drag to orbit, scroll to zoom, right-drag to pan. Press <kbd>?</kbd> for shortcuts.</div>
  `;
  els = {
    search: container.querySelector('#clSearch'),
    units: container.querySelector('#clUnits'),
    rough: container.querySelector('#clRough'),
    allowance: container.querySelector('#clAllowance'),
    list: container.querySelector('#clList'),
    summary: container.querySelector('#clSummary'),
  };
  const s = settings();
  els.units.value = s.units;
  els.rough.checked = s.showRough;
  els.allowance.querySelectorAll('input').forEach((inp) => { inp.value = s.allowance[inp.dataset.k]; });

  els.search.addEventListener('input', () => { filterText = els.search.value.trim().toLowerCase(); renderRows(); });
  els.units.addEventListener('change', () => updateSettings({ units: els.units.value }));
  els.rough.addEventListener('change', () => updateSettings({ showRough: els.rough.checked }));
  els.allowance.addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (!(v >= 0)) return;
    updateSettings({ allowance: { ...settings().allowance, [e.target.dataset.k]: v } });
  });
  container.querySelector('#clCsv').addEventListener('click', () => downloadCSV(allRows, config));
  container.querySelector('#clPrint').addEventListener('click', () => handlers.onPrint && handlers.onPrint());
  container.querySelector('#clDiagram').addEventListener('click', () => handlers.onDiagram && handlers.onDiagram());
  container.querySelector('#clLibrary').addEventListener('click', () => handlers.onLibrary && handlers.onLibrary());
  container.querySelector('#clSetup')?.addEventListener('click', () => handlers.onSetup());
  container.querySelector('#clBuild').addEventListener('click', () => handlers.onBuild && handlers.onBuild());
  renderRows();
}

export function focusSearch() { if (els.search) { els.search.focus(); els.search.select(); } }

export function visibleRows() {
  const hidden = new Set(settings().hiddenCategories);
  return allRows.filter((r) => !hidden.has(r.category) && matchesFilter(r));
}

function matchesFilter(r) {
  if (!filterText) return true;
  return (`${r.name} ${r.label} ${r.top_group} ${r.materialLabel} ${userNote(r)}`).toLowerCase().includes(filterText);
}

let activeKey = null;

export function renderRows() {
  if (!els.list) return;
  const s = settings();
  const hidden = new Set(s.hiddenCategories);
  const cut = new Set(s.cut);
  const list = els.list;
  list.innerHTML = '';

  const byCat = new Map();
  allRows.forEach((r) => { if (!byCat.has(r.category)) byCat.set(r.category, []); byCat.get(r.category).push(r); });

  byCat.forEach((catRows, cat) => {
    const isHidden = hidden.has(cat);
    const header = document.createElement('div');
    header.className = 'cat-title' + (isHidden ? ' hidden-cat' : '');
    const pieces = catRows.reduce((n, r) => n + r.count, 0);
    header.innerHTML = `<span>${escapeHtml(cat === 'Wood' ? 'Wood Cut List' : cat)} <small>${pieces} pc</small></span>
      <button class="eye" title="${isHidden ? 'Show' : 'Hide'} ${escapeHtml(cat)} in the 3D view">${isHidden ? 'Show' : 'Hide'}</button>`;
    header.querySelector('.eye').addEventListener('click', () => {
      const next = new Set(settings().hiddenCategories);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      updateSettings({ hiddenCategories: [...next] });
    });
    list.appendChild(header);
    if (isHidden) return;

    const shown = catRows.filter(matchesFilter);
    let lastGroup = null;
    shown.forEach((r) => {
      if (r.top_group !== lastGroup) {
        lastGroup = r.top_group;
        list.appendChild(groupTitle(r));
      }
      list.appendChild(rowElement(r, cut.has(r.key), s));
    });
    if (!shown.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No matching parts';
      list.appendChild(empty);
    }
  });
  renderSetAside(list, s);
  renderSummary();
  if (activeKey) markActive([...allRows, ...asideRows].find((r) => r.key === activeKey), false);
}

// Section heading for an assembly group, with rename / set aside / delete for
// the whole group (e.g. a group of tools drawn on the bench).
function groupTitle(r) {
  const g = document.createElement('div');
  g.className = 'group-title' + (r.top_group === activeGroup ? ' active' : '');
  g.dataset.group = r.top_group;
  g.innerHTML = `<span class="gt-name" role="button" tabindex="0" title="Show this whole group in 3D">${escapeHtml(r.groupName)}</span>
    <span class="gt-actions">
      <button data-act="rename" title="Rename this group">Rename</button>
      <button data-act="aside" title="Set the whole group aside: keeps its sizes, leaves it out of the build (e.g. tools drawn on the bench)">Set aside</button>
      <button data-act="delete" title="Delete the whole group from this model (you can restore it)">Delete</button>
    </span>`;
  const group = r.top_group;
  const nameEl = g.querySelector('.gt-name');
  nameEl.addEventListener('click', () => handlers.onSelectGroup?.(group));
  nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlers.onSelectGroup?.(group); } });
  g.querySelector('[data-act="rename"]').addEventListener('click', () => {
    inlineEdit(g.querySelector('.gt-name'), r.groupName, (name) => handlers.onRenameGroup?.(group, name));
  });
  g.querySelector('[data-act="aside"]').addEventListener('click', () => handlers.onSetStatus?.(allRows.filter((x) => x.top_group === group), 'aside'));
  g.querySelector('[data-act="delete"]').addEventListener('click', () => handlers.onSetStatus?.(allRows.filter((x) => x.top_group === group), 'deleted'));
  return g;
}

// Replace an element's text with an input; Enter saves, Escape cancels.
export function inlineEdit(el, value, onSave) {
  const input = document.createElement('input');
  input.className = 'inline-edit';
  input.value = value;
  el.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    input.replaceWith(el);
    if (save && input.value.trim() !== value) onSave(input.value.trim());
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('blur', () => finish(true));
}

// Parts set aside (kept, with sizes, but not in the build) and deleted parts.
function renderSetAside(list, s) {
  const section = (title, rowsIn, open, extra, actions) => {
    if (!rowsIn.length) return;
    const shown = rowsIn.filter(matchesFilter);
    const d = document.createElement('details');
    d.className = 'aside-section';
    d.open = open;
    const pieces = rowsIn.reduce((n, r) => n + r.count, 0);
    d.innerHTML = `<summary><span>${title} <small>${pieces} pc</small></span>${extra}</summary>`;
    let lastGroup = null;
    shown.forEach((r) => {
      if (r.top_group !== lastGroup) {
        lastGroup = r.top_group;
        const g = document.createElement('div');
        g.className = 'group-title';
        g.textContent = r.groupName;
        d.appendChild(g);
      }
      const el = document.createElement('div');
      el.className = 'row aside' + (r.clickable ? '' : ' disabled');
      el.dataset.key = r.key;
      el.innerHTML = `<span class="cut-spacer"></span>
        <div class="row-main">
          <div class="name"><span class="mat-swatch" style="background:${r.color}"></span>${escapeHtml(r.name)}</div>
          <div class="dims">${escapeHtml(finishedDims(r, s.units))}${r.flat && r.status === 'aside' ? ' · <span class="muted">no thickness (a loose face)</span>' : ''}</div>
        </div>
        <div class="qty">×${r.count}</div>
        <div class="aside-actions">${actions.map(([act, label, tip]) => `<button data-act="${act}" title="${tip}">${label}</button>`).join('')}</div>`;
      el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation();
        handlers.onSetStatus?.([r], b.dataset.act === 'build' ? null : b.dataset.act);
      }));
      if (r.clickable && r.status === 'aside') el.addEventListener('click', () => handlers.onSelect(r));
      d.appendChild(el);
    });
    d.addEventListener('toggle', () => { sectionOpen[title] = d.open; });
    list.appendChild(d);
    return d;
  };
  const aside = section('Set aside · not in the build', asideRows, sectionOpen['Set aside · not in the build'] ?? false,
    `<label class="chk" title="Show set-aside parts in the 3D view"><input type="checkbox" class="show-aside" ${s.showAside ? 'checked' : ''} /> Show</label>`,
    [['build', 'Put back', 'Put this part back in the build'], ['deleted', 'Delete', 'Delete this part from the model (you can restore it)']]);
  const box = aside?.querySelector('.show-aside');
  if (box) {
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('change', () => updateSettings({ showAside: box.checked }));
  }
  section('Deleted', deletedRows, sectionOpen.Deleted ?? false, '',
    [['build', 'Restore', 'Put this part back in the build'], ['aside', 'Set aside', 'Keep it, but not in the build']]);
}
const sectionOpen = {};

function rowElement(r, ticked, s) {
  const el = document.createElement('div');
  el.className = 'row' + (r.clickable ? '' : ' disabled') + (ticked ? ' cut' : '');
  el.dataset.key = r.key;
  const rough = s.showRough && r.category === 'Wood'
    ? `<div class="rough">rough ${escapeHtml(roughDims(r, s.units))} · ${(roughFor(r).boardFeet * r.count).toFixed(2)} bf</div>` : '';
  const mine = userNote(r);
  const notes = r.notes.map((n) => `<div class="note${r.warn ? ' warn' : ''}">${r.warn ? '⚠ ' : ''}${escapeHtml(n)}</div>`).join('')
    + (mine ? `<div class="note mine">✎ ${escapeHtml(mine)}</div>` : '');
  const trackable = isCut(r);
  el.innerHTML = `
    ${trackable ? `<input type="checkbox" class="cut-box" title="Tick off when cut" ${ticked ? 'checked' : ''} />` : '<span class="cut-spacer"></span>'}
    <div class="row-main">
      <div class="name"><span class="letter">${r.letter}</span><span class="mat-swatch" style="background:${r.color}"></span>${escapeHtml(r.name)}</div>
      <div class="dims">${escapeHtml(finishedDims(r, s.units))}</div>
      ${rough}${notes}
    </div>
    <div class="qty">×${r.count}</div>
  `;
  const box = el.querySelector('.cut-box');
  if (box) {
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('change', () => {
      const next = new Set(settings().cut);
      if (box.checked) next.add(r.key); else next.delete(r.key);
      updateSettings({ cut: [...next] });
    });
  }
  if (r.clickable) {
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.addEventListener('click', () => handlers.onSelect(r));
    el.addEventListener('keydown', (e) => {
      if (e.target !== el || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      handlers.onSelect(r);
    });
  }
  el.title = r.label !== r.name ? `${r.label} (${r.materialLabel})` : r.materialLabel;
  return el;
}

// ---------- sheet goods ----------
export function sheetStock() {
  const st = settings().stock || {};
  return { length: st.sheetLength || 96, width: st.sheetWidth || 48, kerf: st.kerf ?? 0.125 };
}

// What to call a sheet material: the sheet word in its names ("Masonite",
// "Plywood", "MDF"), else the material's label.
const SHEET_NAMES = { plywood: 'Plywood', ply: 'Plywood', mdf: 'MDF', osb: 'OSB', masonite: 'Masonite', hardboard: 'Hardboard', particleboard: 'Particleboard', chipboard: 'Chipboard', melamine: 'Melamine', baltic: 'Baltic birch plywood', luan: 'Luan plywood', lauan: 'Luan plywood' };
export function sheetName(r) {
  const words = `${r.materialLabel} ${r.label}`.normalize('NFKD').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z]+/g, ' ').split(' ');
  const hit = words.find((w) => SHEET_NAMES[w]) || (words.join(' ').includes('particle board') ? 'particleboard' : null);
  return hit ? SHEET_NAMES[hit] : r.materialLabel;
}

// Sheet-goods parts laid out on sheets, per material and thickness:
// [{ key, material, thicknessLabel, thickness, pieces, stock, sheets }]
// (sheets are nesting.js boards; parts at finished size, cut with the grain
// - the part's length - along the sheet's length).
export function sheetLayouts(rows, stock = sheetStock()) {
  const groups = new Map();
  rows.filter((r) => r.category === SHEET).forEach((r) => {
    const material = sheetName(r), thicknessLabel = toFraction(r.dims[2]);
    const key = `${material}|${thicknessLabel}`;
    if (!groups.has(key)) groups.set(key, { key, material, thicknessLabel, thickness: r.dims[2], pieces: [] });
    for (let i = 0; i < r.count; i++) {
      groups.get(key).pieces.push({ id: `${r.key}#${i}`, rowKey: r.key, label: r.letter ? `${r.letter} ${r.name}` : r.name, length: r.dims[0], width: r.dims[1] });
    }
  });
  return [...groups.values()].sort((a, b) => a.material.localeCompare(b.material) || a.thickness - b.thickness)
    .map((g) => ({ ...g, stock, sheets: packBoards(g.pieces, stock).boards }));
}
const sheetSize = (st) => `${Math.round(st.width / 12 * 10) / 10}' × ${Math.round(st.length / 12 * 10) / 10}'`;
export const sheetLine = (g) => `${g.sheets.length} sheet${g.sheets.length === 1 ? '' : 's'} of ${g.thicknessLabel} ${g.material} (${sheetSize(g.stock)})`;

function renderSummary() {
  const t = totals(allRows);
  const s = settings();
  const mats = Object.entries(t.byMaterial).map(([m, v]) => {
    const thick = Object.entries(v.byThickness).sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
      .map(([q, bf]) => `${q}: ${bf.toFixed(1)}`).join(', ');
    return `<div>${escapeHtml(m)}: <b>${v.roughBF.toFixed(1)} bf</b> rough <span class="muted">(${thick})</span></div>`;
  }).join('');
  const pct = t.trackable ? Math.round((t.done / t.trackable) * 100) : 0;
  els.summary.innerHTML = `
    <div class="sum-line"><b>${t.pieces}</b> wood pieces · <b>${t.finishedBF.toFixed(1)}</b> bf finished</div>
    ${mats}
    ${sheetLayouts(allRows).map((g) => `<div>Sheet goods: <b>${escapeHtml(sheetLine(g))}</b></div>`).join('')}
    <div class="muted small">Rough adds ${formatLength(s.allowance.length, s.units)} length, ${formatLength(s.allowance.width, s.units)} width, next 4/4-5/4-8/4… thickness. Buy ~20% extra for defects.</div>
    <div class="progress" title="Wood pieces ticked off as cut"><div style="width:${pct}%"></div><span>${t.done} of ${t.trackable} pieces cut</span></div>
  `;
}

// the group shown with onSelectGroup (its heading is highlighted)
let activeGroup = null;
export function markActiveGroup(group) {
  activeGroup = group;
  if (!els.list) return;
  els.list.querySelectorAll('.group-title').forEach((e) => e.classList.toggle('active', group !== null && e.dataset.group === String(group)));
}

export function markActive(row, scroll = true) {
  activeKey = row ? row.key : null;
  if (!els.list) return;
  els.list.querySelectorAll('.row.active').forEach((e) => e.classList.remove('active'));
  if (!row) return;
  const el = els.list.querySelector(`.row[data-key="${CSS.escape(row.key)}"]`);
  if (el) {
    el.classList.add('active');
    if (scroll) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

// ---------- CSV ----------

export function cutListTable(rows, units = settings().units) {
  const header = ['Ref', 'Category', 'Group', 'Part', 'Qty', 'Thickness', 'Width', 'Length', 'Material',
    'Rough thickness', 'Rough width', 'Rough length', 'Rough bf (total)', 'Notes', 'Source name'];
  const body = rows.map((r) => {
    const [l, w, t] = r.dims;
    const rough = roughFor(r);
    const fmt = (x) => formatLength(x, units);
    return [
      r.letter, r.category, r.groupName, r.name, r.count,
      r.customDims ? r.customDims : fmt(t), r.customDims ? '' : fmt(w), r.customDims ? '' : fmt(l),
      r.materialLabel,
      rough ? (units.startsWith('in') ? rough.thicknessLabel : fmt(rough.thickness)) : '',
      rough ? fmt(rough.width) : '', rough ? fmt(rough.length) : '',
      rough ? (rough.boardFeet * r.count).toFixed(2) : '',
      [...r.notes, userNote(r)].filter(Boolean).join(' / '), r.label,
    ];
  });
  return [header, ...body];
}

function downloadCSV(rows, config) {
  const blob = new Blob([toCSV(cutListTable(rows))], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(config.title || 'cut-list').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-cut-list.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- printable cut sheet ----------

// extraHtml: drilling list and cutting diagrams, appended after the totals
// imageDataUrl: one picture or several (assembled + exploded with letters)
export function buildPrintSheet(target, rows, config, imageDataUrl, extraHtml = '') {
  const s = settings();
  const t = totals(rows);
  const sections = [];
  let cat = null;
  rows.forEach((r) => {
    if (r.category !== cat) { cat = r.category; sections.push({ cat, rows: [] }); }
    sections[sections.length - 1].rows.push(r);
  });
  const date = new Date().toLocaleDateString();
  target.innerHTML = `
    <h1>${escapeHtml(config.title || 'Cut List')} — Cut Sheet</h1>
    <div class="ps-sub">${escapeHtml(config.subtitle || '')} · printed ${escapeHtml(date)} · finished sizes T × W × L</div>
    ${imageDataUrl ? `<div class="ps-imgs">${[].concat(imageDataUrl).filter(Boolean).map((u) => `<img class="ps-img" src="${u}" alt="" />`).join('')}</div>` : ''}
    ${sections.map((sec) => `
      <h2>${escapeHtml(sec.cat === 'Wood' ? 'Wood' : sec.cat)}</h2>
      <table>
        <thead><tr><th class="ps-chk">✓</th><th>Part</th><th>Qty</th><th>Finished (T × W × L)</th>
          ${sec.cat === 'Wood' ? '<th>Rough stock</th><th>bf</th>' : ''}<th>Notes</th></tr></thead>
        <tbody>${sec.rows.map((r) => `
          <tr>
            <td class="ps-chk"><span class="box"></span></td>
            <td><b>${r.letter} · ${escapeHtml(r.name)}</b><div class="ps-grp">${escapeHtml(r.groupName)} · ${escapeHtml(r.materialLabel)}</div></td>
            <td class="num">${r.count}</td>
            <td>${escapeHtml(finishedDims(r, s.units))}</td>
            ${sec.cat === 'Wood' ? `<td>${escapeHtml(roughDims(r, s.units))}</td><td class="num">${(roughFor(r).boardFeet * r.count).toFixed(2)}</td>` : ''}
            <td class="ps-note">${escapeHtml(r.notes.join(' / '))}${userNote(r) ? `<div class="ps-mine">✎ ${escapeHtml(userNote(r))}</div>` : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table>`).join('')}
    <div class="ps-tot">${t.pieces} wood pieces · ${t.finishedBF.toFixed(1)} bf finished · ${t.roughBF.toFixed(1)} bf rough
      (allowance +${formatLength(s.allowance.length, s.units)} L, +${formatLength(s.allowance.width, s.units)} W) — buy ~20% extra for defects.</div>
    ${extraHtml ? `<div class="ps-extra">${extraHtml}</div>` : ''}
  `;
}

// ---------- milling plan ----------

// Wood parts grouped by planer / rip / crosscut setting (finished sizes).
export function millingPlanHTML(rows, units = settings().units) {
  const wood = rows.filter((r) => r.category === 'Wood' && !r.customDims);
  if (!wood.length) return '';
  const plan = millingPlan(wood, (v) => formatLength(v, units));
  const col = (title, groups) => `
    <div class="mp-col"><h4>${title}</h4>
      ${groups.map((g) => `<div class="mp-g"><b>${escapeHtml(g.label)}</b> <span class="muted">${g.pieces} pc</span>
        <div class="mp-parts">${g.parts.map((p) => `${escapeHtml(p.name)}${p.count > 1 ? ` ×${p.count}` : ''}`).join(', ')}</div></div>`).join('')}
    </div>`;
  return `<div class="mp">
    ${col('1. Plane to thickness', plan.thickness)}
    ${col('2. Rip to width', plan.width)}
    ${col('3. Crosscut to length', plan.length)}
  </div>`;
}
