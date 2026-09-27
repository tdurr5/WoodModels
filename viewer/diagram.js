// Cutting diagrams: boards to buy per species/thickness with the rough parts
// laid out on them (see nesting.js), as SVG. Shown in a modal and appended to
// the printed cut sheet.

import { packWithOwned, boardParts, boardYield, piecesByStock } from './nesting.js';
import { getInventory, setInventory, ownedFor } from './inventory.js';
import { formatLength, boardFeet, escapeHtml, SHEET } from './format.js';
import { settings, updateSettings } from './settings.js';
import { roughFor, isRod, finishedDims, millingPlanHTML, sheetLayouts, sheetLine } from './cutlist.js';

export const STOCK_DEFAULTS = { length: 96, width: 8, kerf: 0.125 };

const PART_COLORS = ['#e0b27a', '#c99b62', '#d6a56b', '#b98a55', '#e8c08e', '#cf9f68', '#bf9160', '#dcb483'];

export function computeLayouts(rows) {
  const stock = { ...STOCK_DEFAULTS, ...(settings().stock || {}) };
  const inventory = getInventory();
  return piecesByStock(rows.filter((r) => r.category === 'Wood'), roughFor).map((g) => {
    // your own boards first (inventory.js), then boards to buy for the rest
    const { owned, boards } = packWithOwned(g.pieces, ownedFor(inventory, g.material, g.thicknessLabel), stock);
    const bf = boards.reduce((a, b) => a + boardFeet(b.length, b.width, g.thickness), 0);
    const ownedBf = owned.reduce((a, b) => a + boardFeet(b.length, b.width, g.thickness), 0);
    const boughtParts = g.pieces.filter((p) => !owned.some((b) => boardParts(b).some((q) => q.id === p.id)));
    const partsBf = boughtParts.reduce((a, p) => a + boardFeet(p.length, p.width, g.thickness), 0);
    return { ...g, stock, owned, boards, bf, ownedBf, partsBf };
  });
}

function feetInches(inches) {
  const ft = Math.floor(inches / 12), inch = Math.round(inches - ft * 12);
  if (inch === 12) return `${ft + 1}'`;
  return inch ? `${ft}' ${inch}"` : `${ft}'`;
}

// Board feet you actually have to buy: whole boards, except a mostly-empty
// last board, which is counted only as far as it's used (to the next 6"),
// since a short board or an offcut will do.
function buyInfo(g) {
  const last = g.boards[g.boards.length - 1];
  const used = Math.max(0, ...boardParts(last).map((p) => p.x + p.length));
  const partial = used < last.length * 0.5 ? Math.min(last.length, Math.ceil(used / 6) * 6) : null;
  const bf = g.boards.reduce((a, b) => a + boardFeet(b === last && partial ? partial : b.length, b.width, g.thickness), 0);
  return { partial, bf };
}

// Shopping list line per group, e.g. "8/4 Wood: 2 × 8' × 8" (21.3 bf)".
export function shoppingList(layouts) {
  const prices = settings().prices || {};
  return layouts.map((g) => {
    const mine = g.owned.length ? `${g.owned.length} of your boards` : '';
    if (!g.boards.length) return { label: `${g.thicknessLabel} ${g.material}`, material: g.material, list: `all from ${mine}`, bf: 0, yield: 1, cost: null, none: true };
    const sizes = new Map();
    g.boards.forEach((b) => {
      const k = `${feetInches(b.length)} × ${formatLength(b.width, 'in8')}${b.oversize ? ' (oversize)' : ''}`;
      sizes.set(k, (sizes.get(k) || 0) + 1);
    });
    let list = [...sizes].map(([k, n]) => `${n} × ${k}`).join(', ');
    const { partial, bf } = buyInfo(g);
    if (partial) {
      list += ` — only ${feetInches(partial)} of ${g.boards.length > 1 ? 'the last one' : 'it'} is used; a shorter board or an offcut will do`;
    }
    if (mine) list += `, plus ${mine}`;
    const price = prices[g.material];
    return { label: `${g.thicknessLabel} ${g.material}`, material: g.material, list, bf, yield: g.partsBf / g.bf, cost: price > 0 ? bf * price : null };
  });
}

// Hardware and other non-wood parts to buy. Rods are totalled per size so you
// can buy stock lengths and cut them: 1/8" per saw cut, rounded up to the
// next foot.
export function hardwareList(rows, units) {
  const rods = new Map();
  const other = [];
  rows.filter((r) => r.category !== 'Wood' && r.category !== SHEET).forEach((r) => {
    if (isRod(r)) {
      const k = `${r.name}|${r.dims[1].toFixed(3)}`;
      const e = rods.get(k) || { name: r.name, dia: r.dims[1], pieces: [] };
      for (let i = 0; i < r.count; i++) e.pieces.push(r.dims[0]);
      rods.set(k, e);
    } else {
      other.push({ name: r.name, count: r.count, size: finishedDims(r, units), category: r.category });
    }
  });
  const rodLines = [...rods.values()].map((e) => {
    const total = e.pieces.reduce((a, b) => a + b, 0);
    const buy = Math.ceil((total + 0.125 * e.pieces.length) / 12) * 12;
    const counts = new Map();
    e.pieces.forEach((l) => counts.set(l, (counts.get(l) || 0) + 1));
    const cut = [...counts].map(([l, n]) => `${formatLength(l, units)}${n > 1 ? ` ×${n}` : ''}`).join(', ');
    return { name: e.name, text: `${e.pieces.length} piece${e.pieces.length > 1 ? 's' : ''} (${cut}), ${formatLength(total, units)} total — buy ${feetInches(buy)}` };
  });
  return { rods: rodLines, other };
}

export function boardSVG(board, g, { pxPerInch = 9, units = 'in16', colorFor = () => PART_COLORS[0] } = {}) {
  const W = board.length * pxPerInch, H = board.width * pxPerInch;
  const pad = 2;
  const parts = boardParts(board);
  const rects = parts.map((p) => {
    const x = p.x * pxPerInch, y = p.y * pxPerInch, w = p.length * pxPerInch, h = p.width * pxPerInch;
    const name = escapeHtml(p.label);
    const dims = escapeHtml(`${formatLength(p.length, units)} × ${formatLength(p.width, units)}`);
    // shrink labels to fit the piece; drop them (tooltip only) if too small
    const fit = (str, maxFs) => Math.min(maxFs, (w - 6) / (str.length * 0.58), h * 0.42);
    const nameFs = fit(p.label, 12);
    const dimFs = Math.min(nameFs * 0.85, fit(dims.replace(/&[a-z]+;/g, 'x'), 10));
    let text = '';
    if (nameFs >= 6.5 && h >= 20 && dimFs >= 6) {
      text = `<text x="${x + w / 2}" y="${y + h / 2 - 1}" font-size="${nameFs}" text-anchor="middle" font-weight="600">${name}</text>
         <text x="${x + w / 2}" y="${y + h / 2 + dimFs + 1}" font-size="${dimFs}" text-anchor="middle" class="dim">${dims}</text>`;
    } else if (nameFs >= 6.5) {
      text = `<text x="${x + w / 2}" y="${y + h / 2 + nameFs * 0.35}" font-size="${nameFs}" text-anchor="middle" font-weight="600">${name}</text>`;
    }
    return `<g class="part" data-row="${escapeHtml(p.rowKey || '')}"><title>${name} — rough ${dims}</title>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${colorFor(p.rowKey)}" />${text}</g>`;
  }).join('');
  return `<svg class="board-svg" viewBox="${-pad} ${-pad} ${W + pad * 2} ${H + pad * 2}" width="${W + pad * 2}" height="${H + pad * 2}" xmlns="http://www.w3.org/2000/svg">
    <defs><pattern id="waste" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" class="hatch" /></pattern></defs>
    <rect x="0" y="0" width="${W}" height="${H}" class="board" />
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#waste)" />
    ${rects}
  </svg>`;
}

export function layoutsHTML(layouts, { pxPerInch, units, colorFor, hardware = null, finishArea = 0, sheets = [] }) {
  const shop = shoppingList(layouts);
  const totalCost = shop.reduce((a, s) => a + (s.cost || 0), 0);
  const money = (v) => `$${v.toFixed(2)}`;
  const hw = hardware ? hardwareList(hardware, units) : { rods: [], other: [] };
  const otherLine = (o) => `<li><b>${escapeHtml(o.name)}</b> ×${o.count}: ${escapeHtml(o.size)}${o.category !== 'Hardware' && o.category !== 'Other' ? ` <span class="muted">(${escapeHtml(o.category.toLowerCase())})</span>` : ''}</li>`;
  const hwMain = hw.other.filter((o) => o.category !== 'Other');
  const hwOther = hw.other.filter((o) => o.category === 'Other');
  return `
    <div class="cd-shop">${shop.length ? `<b>Lumber to buy</b> (rough, before the ~20% defect allowance):
      <ul>${shop.map((s) => `<li><b>${escapeHtml(s.label)}</b>: ${escapeHtml(s.list)}${s.none ? ' - nothing to buy' : ` — ${s.bf.toFixed(1)} bf${s.cost != null ? ` ≈ ${money(s.cost)}` : ''}, ${Math.round(s.yield * 100)}% used`}</li>`).join('')}</ul>` : ''}
      ${sheets.length ? `<b>Sheet goods to buy</b>:
        <ul>${sheets.map((g) => `<li><b>${escapeHtml(sheetLine(g))}</b> — ${Math.round((g.sheets.reduce((a, b) => a + boardYield(b), 0) / g.sheets.length) * 100)}% used${g.sheets.some((b) => b.oversize) ? ' <span class="warn">⚠ a part is bigger than the sheet</span>' : ''}</li>`).join('')}</ul>` : ''}
      ${totalCost ? `<div>Lumber estimate: <b>${money(totalCost)}</b> (${money(totalCost * 1.2)} with 20% extra)</div>` : ''}
      ${hw.rods.length || hwMain.length ? `<b>Hardware</b>:
        <ul>${hw.rods.map((r) => `<li><b>${escapeHtml(r.name)}</b>: ${escapeHtml(r.text)}</li>`).join('')}
        ${hwMain.map(otherLine).join('')}</ul>` : ''}
      ${hwOther.length ? `<details class="cd-other"><summary>Other parts (${hwOther.reduce((n, o) => n + o.count, 0)}) <span class="muted">- not wood or hardware; set aside anything that isn't part of the build</span></summary>
        <ul>${hwOther.map(otherLine).join('')}</ul></details>` : ''}
      ${finishArea > 0 ? `<b>Finish</b>: about <b>${(finishArea / 144).toFixed(1)} sq ft</b> of wood surface per coat <span class="muted">(a quart of most oil or varnish finishes covers roughly 100-125 sq ft per coat)</span>` : ''}
    </div>
    ${sheets.map((g) => `
      <div class="cd-group">
        <h3>${escapeHtml(g.thicknessLabel)} ${escapeHtml(g.material)} <span class="muted">— ${g.sheets.length} sheet${g.sheets.length === 1 ? '' : 's'}, ${g.pieces.length} part${g.pieces.length === 1 ? '' : 's'}, finished size</span></h3>
        ${g.sheets.map((b, i) => `
          <div class="cd-board">
            <div class="cd-board-title">Sheet ${i + 1}: ${formatLength(b.width, units)} × ${formatLength(b.length, units)} · ${Math.round(boardYield(b) * 100)}% used
              ${b.oversize ? '<span class="warn">⚠ larger than your sheet size</span>' : ''}</div>
            ${boardSVG(b, g, { pxPerInch, units, colorFor })}
          </div>`).join('')}
      </div>`).join('')}
    ${layouts.map((g) => `
      <div class="cd-group">
        <h3>${escapeHtml(g.thicknessLabel)} ${escapeHtml(g.material)} <span class="muted">— ${g.owned.length ? `${g.owned.length} of your board${g.owned.length === 1 ? '' : 's'}, ` : ''}${g.boards.length} board${g.boards.length === 1 ? '' : 's'}${g.owned.length ? ' to buy' : ''}, ${g.pieces.length} part${g.pieces.length === 1 ? '' : 's'}</span></h3>
        ${g.owned.map((b, i) => `
          <div class="cd-board owned">
            <div class="cd-board-title">Your board ${i + 1}: ${feetInches(b.length)} × ${formatLength(b.width, units)}
              · ${boardFeet(b.length, b.width, g.thickness).toFixed(1)} bf · ${Math.round(boardYield(b) * 100)}% used</div>
            ${boardSVG(b, g, { pxPerInch, units, colorFor })}
          </div>`).join('')}
        ${g.boards.map((b, i) => `
          <div class="cd-board">
            <div class="cd-board-title">Board ${i + 1}: ${feetInches(b.length)} × ${formatLength(b.width, units)}
              · ${boardFeet(b.length, b.width, g.thickness).toFixed(1)} bf · ${Math.round(boardYield(b) * 100)}% yield
              ${b.oversize ? '<span class="warn">⚠ larger than your stock setting — buy wider/longer or glue up</span>' : ''}</div>
            ${boardSVG(b, g, { pxPerInch, units, colorFor })}
          </div>`).join('')}
      </div>`).join('')}
    ${layouts.length ? `<p class="muted small">Cut sequence per board: crosscut at each section line, rip each section into strips, then crosscut parts from the strips. Parts are rough size (finished + your allowances); ${formatLength(layouts[0]?.stock.kerf ?? STOCK_DEFAULTS.kerf, units)} kerf between cuts. Hatched = offcut.</p>` : ''}
  `;
}

// ---------- modal ----------
export function initDiagramModal({ rows, onSelectRow, finishArea = () => 0 }) {
  const modal = document.getElementById('diagram');
  const body = modal.querySelector('.cd-body');
  let rowColor = new Map(rows.map((r, i) => [r.key, PART_COLORS[i % PART_COLORS.length]]));
  // parts renamed, deleted or set aside
  function setRows(next) {
    rows = next;
    rowColor = new Map(rows.map((r, i) => [r.key, PART_COLORS[i % PART_COLORS.length]]));
  }
  const colorFor = (k) => rowColor.get(k) || PART_COLORS[0];

  const sheetSel = modal.querySelector('#cdSheet');
  sheetSel.addEventListener('change', () => {
    const [sheetLength, sheetWidth] = sheetSel.value.split('x').map(Number);
    updateSettings({ stock: { ...STOCK_DEFAULTS, ...(settings().stock || {}), sheetLength, sheetWidth } });
    render();
  });
  const inputs = {
    length: modal.querySelector('#cdLength'),
    width: modal.querySelector('#cdWidth'),
    kerf: modal.querySelector('#cdKerf'),
  };

  function render() {
    const s = settings();
    const stock = { ...STOCK_DEFAULTS, ...(s.stock || {}) };
    inputs.length.value = String(stock.length);
    inputs.width.value = String(stock.width);
    inputs.kerf.value = String(stock.kerf);
    const layouts = computeLayouts(rows);
    const sheets = sheetLayouts(rows);
    sheetSel.closest('label').style.display = sheets.length ? '' : 'none';
    sheetSel.value = `${sheets[0]?.stock.length || stock.sheetLength || 96}x${sheets[0]?.stock.width || stock.sheetWidth || 48}`;
    const avail = Math.max(320, body.clientWidth - 24);
    const longest = Math.max(...layouts.flatMap((g) => [...g.owned, ...g.boards].map((b) => b.length)), ...sheets.flatMap((g) => g.sheets.map((b) => b.length)), stock.length);
    renderPrices(layouts);
    body.innerHTML = inventoryHTML(layouts) + layoutsHTML(layouts, { pxPerInch: avail / longest, units: s.units, colorFor, hardware: rows, finishArea: finishArea(), sheets })
      + `<details class="cd-mill" open><summary>Milling plan: parts that share a machine setting</summary>${millingPlanHTML(rows, s.units)}</details>`;
    body.querySelectorAll('.part').forEach((el) => el.addEventListener('click', () => {
      const row = rows.find((r) => r.key === el.dataset.row);
      if (row) { close(); onSelectRow(row); }
    }));
  }

  // "My boards": boards you already have, used before any are bought
  let invOpen = false;
  const THICK = ['4/4', '5/4', '6/4', '8/4', '10/4', '12/4', '16/4'];
  function inventoryHTML(layouts) {
    const list = getInventory();
    const mats = [...new Set([...layouts.map((g) => g.material), ...list.map((b) => b.material).filter(Boolean)])];
    const used = layouts.reduce((n, g) => n + g.owned.length, 0);
    const opt = (v, cur, text = v) => `<option value="${escapeHtml(v)}"${v === cur ? ' selected' : ''}>${escapeHtml(text)}</option>`;
    return `<details class="cd-inv"${invOpen || list.length ? ' open' : ''}><summary>My boards${list.length ? ` (${list.length} kind${list.length > 1 ? 's' : ''}${used ? `, ${used} used here` : ''})` : ''} <span class="muted">- boards you already have are used first; you only buy the rest</span></summary>
      <table class="cd-inv-table">${list.length ? '<thead><tr><th>Species</th><th>Thickness</th><th>Width (in)</th><th>Length (in)</th><th>Qty</th><th></th></tr></thead>' : ''}<tbody>
      ${list.map((b, i) => `<tr data-i="${i}">
        <td><select data-k="material">${opt('', b.material, 'Any species')}${mats.map((m) => opt(m, b.material)).join('')}</select></td>
        <td><select data-k="thickness">${THICK.map((t) => opt(t, b.thickness)).join('')}</select></td>
        <td><input data-k="width" type="number" min="1" step="0.25" value="${b.width}" /></td>
        <td><input data-k="length" type="number" min="1" step="1" value="${b.length}" /></td>
        <td><input data-k="count" type="number" min="1" step="1" value="${b.count || 1}" /></td>
        <td><button class="cd-inv-del" title="Remove">×</button></td></tr>`).join('')}
      </tbody></table>
      <button class="card-btn cd-inv-add">+ Add a board</button></details>`;
  }
  body.addEventListener('toggle', (e) => { if (e.target.classList?.contains('cd-inv')) invOpen = e.target.open; }, true);
  body.addEventListener('change', (e) => {
    const tr = e.target.closest('.cd-inv-table tr[data-i]');
    if (!tr) return;
    const list = getInventory();
    const b = list[+tr.dataset.i];
    const k = e.target.dataset.k;
    b[k] = k === 'material' || k === 'thickness' ? e.target.value : Math.max(0, parseFloat(e.target.value) || 0);
    setInventory(list);
    render();
  });
  body.addEventListener('click', (e) => {
    if (e.target.classList.contains('cd-inv-add')) {
      const layouts = computeLayouts(rows);
      const g = layouts[0];
      setInventory([...getInventory(), { material: g?.material || '', thickness: g?.thicknessLabel || '4/4', width: 6, length: 72, count: 1 }]);
      invOpen = true;
      render();
    } else if (e.target.classList.contains('cd-inv-del')) {
      const i = +e.target.closest('tr').dataset.i;
      setInventory(getInventory().filter((_, k) => k !== i));
      render();
    }
  });

  // $/bf per species; blank = no cost estimate
  const pricesEl = modal.querySelector('.cd-prices');
  function renderPrices(layouts) {
    const prices = settings().prices || {};
    const materials = [...new Set(layouts.map((g) => g.material))];
    pricesEl.innerHTML = materials.map((m) => `<label>${escapeHtml(m)} $/bf <input type="number" min="0" step="0.25" data-mat="${escapeHtml(m)}" value="${prices[m] ?? ''}" placeholder="–" /></label>`).join('');
  }
  pricesEl.addEventListener('change', (e) => {
    const m = e.target.dataset.mat;
    if (!m) return;
    const v = parseFloat(e.target.value);
    const prices = { ...(settings().prices || {}) };
    if (v > 0) prices[m] = v; else delete prices[m];
    updateSettings({ prices });
    render();
  });

  function open() { modal.style.display = 'flex'; render(); }
  function close() { modal.style.display = 'none'; }

  Object.entries(inputs).forEach(([k, el]) => el.addEventListener('change', () => {
    const v = parseFloat(el.value);
    if (!(v > 0) && !(k === 'kerf' && v === 0)) return;
    updateSettings({ stock: { ...STOCK_DEFAULTS, ...(settings().stock || {}), [k]: v } });
    render();
  }));
  modal.querySelector('.cd-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  return { open, close, isOpen: () => modal.style.display === 'flex', render, colorFor, setRows };
}

// The shopping list as plain text, to send to your phone or the lumber yard.
export function shoppingText(rows, title) {
  const units = settings().units;
  const lines = [`${title} - shopping list`];
  const shop = shoppingList(computeLayouts(rows));
  if (shop.length) {
    lines.push('', 'Lumber (rough):');
    shop.forEach((s) => lines.push(`- ${s.label}: ${s.list}${s.none ? '' : ` (${s.bf.toFixed(1)} bf)`}`));
  }
  const sheets = sheetLayouts(rows);
  if (sheets.length) {
    lines.push('', 'Sheet goods:');
    sheets.forEach((g) => lines.push(`- ${sheetLine(g)}`));
  }
  const hw = hardwareList(rows, units);
  const main = hw.other.filter((o) => o.category !== 'Other');
  if (hw.rods.length || main.length) {
    lines.push('', 'Hardware:');
    hw.rods.forEach((r) => lines.push(`- ${r.name}: ${r.text}`));
    main.forEach((o) => lines.push(`- ${o.name} ×${o.count}: ${o.size}`));
  }
  if (shop.some((s) => !s.none)) lines.push('', 'Buy about 20% extra lumber for defects.');
  return lines.join('\n');
}
