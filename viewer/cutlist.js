// Sidebar cut list, totals, CSV export and the printable cut sheet.

import {
  formatLength, roughStock, displayName, toFraction, toCSV, escapeHtml, UNIT_OPTIONS,
} from './format.js';
import { settings, updateSettings } from './settings.js';

// ---------- row preparation ----------

// Decorate parts_report.json rows with what the UI needs. Rows are ordered by
// category, then assembly group, then name - the order everything (sidebar,
// arrow-key navigation, CSV, print) uses.
export function prepareRows(rawRows, config) {
  const mats = config.materials || {};
  const order = config.categoryOrder || ['Wood', 'Hardware', 'Leather', 'Other'];
  const rows = rawRows.map((r) => {
    const matName = (r.materials || []).find((m) => mats[m]) || (r.materials || [])[0] || '';
    const category = (mats[matName] && mats[matName].category) || 'Other';
    const [l, w, t] = r.dims;
    // parse_dae.py writes dims_str as sixteenths L x W x T; anything else is a
    // hand-written override (e.g. hex hardware) that should be shown as-is.
    const standard = `${toFraction(l)} x ${toFraction(w)} x ${toFraction(t)}`;
    const notes = [r.note, (config.notes || {})[r.label]].filter(Boolean);
    return {
      ...r,
      key: `${r.label}|${r.dims.join('x')}`,
      name: displayName(r.label, config.displayNames),
      groupName: displayName(String(r.top_group), config.displayNames),
      category,
      material: matName,
      materialLabel: (mats[matName] && mats[matName].label) || matName.replace(/^_+/, ''),
      color: (mats[matName] && mats[matName].color) || '#666',
      customDims: r.dims_str !== standard ? r.dims_str : null,
      notes,
      warn: !!(config.notes || {})[r.label],
      clickable: !!(r.obj_names && r.obj_names.length),
    };
  });
  const catRank = (c) => { const i = order.indexOf(c); return i < 0 ? order.length : i; };
  rows.sort((a, b) => catRank(a.category) - catRank(b.category)
    || String(a.top_group).localeCompare(String(b.top_group))
    || a.name.localeCompare(b.name));
  rows.forEach((r, i) => { r.__id = i; });
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
  const cutSet = new Set(settings().cut);
  const trackable = rows.filter((r) => r.category === 'Wood');
  const done = trackable.filter((r) => cutSet.has(r.key)).length;
  return { pieces, finishedBF, roughBF, byMaterial, done, trackable: trackable.length };
}

// ---------- sidebar ----------

let els = {};
let allRows = [];
let handlers = {};
let filterText = '';

export function renderCutList(container, rows, config, h) {
  allRows = rows;
  handlers = h;
  container.innerHTML = `
    <div class="cl-head">
      <h1>${escapeHtml(config.title || 'Cut List')}</h1>
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
  renderRows();
}

export function focusSearch() { if (els.search) { els.search.focus(); els.search.select(); } }

export function visibleRows() {
  const hidden = new Set(settings().hiddenCategories);
  return allRows.filter((r) => !hidden.has(r.category) && matchesFilter(r));
}

function matchesFilter(r) {
  if (!filterText) return true;
  return (`${r.name} ${r.label} ${r.top_group} ${r.materialLabel}`).toLowerCase().includes(filterText);
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
        const g = document.createElement('div');
        g.className = 'group-title';
        g.textContent = r.groupName;
        list.appendChild(g);
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
  renderSummary();
  if (activeKey) markActive(allRows.find((r) => r.key === activeKey), false);
}

function rowElement(r, isCut, s) {
  const el = document.createElement('div');
  el.className = 'row' + (r.clickable ? '' : ' disabled') + (isCut ? ' cut' : '');
  el.dataset.key = r.key;
  const rough = s.showRough && r.category === 'Wood'
    ? `<div class="rough">rough ${escapeHtml(roughDims(r, s.units))} · ${(roughFor(r).boardFeet * r.count).toFixed(2)} bf</div>` : '';
  const notes = r.notes.map((n) => `<div class="note${r.warn ? ' warn' : ''}">${r.warn ? '⚠ ' : ''}${escapeHtml(n)}</div>`).join('');
  const trackable = r.category === 'Wood';
  el.innerHTML = `
    ${trackable ? `<input type="checkbox" class="cut-box" title="Tick off when cut" ${isCut ? 'checked' : ''} />` : '<span class="cut-spacer"></span>'}
    <div class="row-main">
      <div class="name"><span class="mat-swatch" style="background:${r.color}"></span>${escapeHtml(r.name)}</div>
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
  if (r.clickable) el.addEventListener('click', () => handlers.onSelect(r));
  el.title = r.label !== r.name ? `${r.label} (${r.materialLabel})` : r.materialLabel;
  return el;
}

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
    <div class="muted small">Rough adds ${formatLength(s.allowance.length, s.units)} length, ${formatLength(s.allowance.width, s.units)} width, next 4/4-5/4-8/4… thickness. Buy ~20% extra for defects.</div>
    <div class="progress" title="Wood parts ticked off as cut"><div style="width:${pct}%"></div><span>${t.done}/${t.trackable} cut</span></div>
  `;
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
  const header = ['Category', 'Group', 'Part', 'Qty', 'Thickness', 'Width', 'Length', 'Material',
    'Rough thickness', 'Rough width', 'Rough length', 'Rough bf (total)', 'Notes', 'Source name'];
  const body = rows.map((r) => {
    const [l, w, t] = r.dims;
    const rough = roughFor(r);
    const fmt = (x) => formatLength(x, units);
    return [
      r.category, r.groupName, r.name, r.count,
      r.customDims ? r.customDims : fmt(t), r.customDims ? '' : fmt(w), r.customDims ? '' : fmt(l),
      r.materialLabel,
      rough ? (units.startsWith('in') ? rough.thicknessLabel : fmt(rough.thickness)) : '',
      rough ? fmt(rough.width) : '', rough ? fmt(rough.length) : '',
      rough ? (rough.boardFeet * r.count).toFixed(2) : '',
      r.notes.join(' / '), r.label,
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
    ${imageDataUrl ? `<img class="ps-img" src="${imageDataUrl}" alt="" />` : ''}
    ${sections.map((sec) => `
      <h2>${escapeHtml(sec.cat === 'Wood' ? 'Wood' : sec.cat)}</h2>
      <table>
        <thead><tr><th class="ps-chk">✓</th><th>Part</th><th>Qty</th><th>Finished (T × W × L)</th>
          ${sec.cat === 'Wood' ? '<th>Rough stock</th><th>bf</th>' : ''}<th>Notes</th></tr></thead>
        <tbody>${sec.rows.map((r) => `
          <tr>
            <td class="ps-chk"><span class="box"></span></td>
            <td><b>${escapeHtml(r.name)}</b><div class="ps-grp">${escapeHtml(r.groupName)} · ${escapeHtml(r.materialLabel)}</div></td>
            <td class="num">${r.count}</td>
            <td>${escapeHtml(finishedDims(r, s.units))}</td>
            ${sec.cat === 'Wood' ? `<td>${escapeHtml(roughDims(r, s.units))}</td><td class="num">${(roughFor(r).boardFeet * r.count).toFixed(2)}</td>` : ''}
            <td class="ps-note">${escapeHtml(r.notes.join(' / '))}</td>
          </tr>`).join('')}
        </tbody>
      </table>`).join('')}
    <div class="ps-tot">${t.pieces} wood pieces · ${t.finishedBF.toFixed(1)} bf finished · ${t.roughBF.toFixed(1)} bf rough
      (allowance +${formatLength(s.allowance.length, s.units)} L, +${formatLength(s.allowance.width, s.units)} W) — buy ~20% extra for defects.</div>
    ${extraHtml ? `<div class="ps-extra">${extraHtml}</div>` : ''}
  `;
}
