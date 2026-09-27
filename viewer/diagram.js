// Cutting diagrams: boards to buy per species/thickness with the rough parts
// laid out on them (see nesting.js), as SVG. Shown in a modal and appended to
// the printed cut sheet.

import { packBoards, boardParts, boardYield, piecesByStock } from './nesting.js';
import { formatLength, boardFeet, escapeHtml, SHEET } from './format.js';
import { settings, updateSettings } from './settings.js';
import { roughFor, isRod, finishedDims, millingPlanHTML, sheetLayouts, sheetLine } from './cutlist.js';

export const STOCK_DEFAULTS = { length: 96, width: 8, kerf: 0.125 };

const PART_COLORS = ['#e0b27a', '#c99b62', '#d6a56b', '#b98a55', '#e8c08e', '#cf9f68', '#bf9160', '#dcb483'];

export function computeLayouts(rows) {
  const stock = { ...STOCK_DEFAULTS, ...(settings().stock || {}) };
  return piecesByStock(rows.filter((r) => r.category === 'Wood'), roughFor).map((g) => {
    const { boards } = packBoards(g.pieces, stock);
    const bf = boards.reduce((a, b) => a + boardFeet(b.length, b.width, g.thickness), 0);
    const partsBf = g.pieces.reduce((a, p) => a + boardFeet(p.length, p.width, g.thickness), 0);
    return { ...g, stock, boards, bf, partsBf };
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
      <ul>${shop.map((s) => `<li><b>${escapeHtml(s.label)}</b>: ${escapeHtml(s.list)} — ${s.bf.toFixed(1)} bf${s.cost != null ? ` ≈ ${money(s.cost)}` : ''}, ${Math.round(s.yield * 100)}% used</li>`).join('')}</ul>` : ''}
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
        <h3>${escapeHtml(g.thicknessLabel)} ${escapeHtml(g.material)} <span class="muted">— ${g.boards.length} board${g.boards.length === 1 ? '' : 's'}, ${g.pieces.length} part${g.pieces.length === 1 ? '' : 's'}</span></h3>
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
    const longest = Math.max(...layouts.flatMap((g) => g.boards.map((b) => b.length)), ...sheets.flatMap((g) => g.sheets.map((b) => b.length)), stock.length);
    renderPrices(layouts);
    body.innerHTML = layoutsHTML(layouts, { pxPerInch: avail / longest, units: s.units, colorFor, hardware: rows, finishArea: finishArea(), sheets })
      + `<details class="cd-mill" open><summary>Milling plan: parts that share a machine setting</summary>${millingPlanHTML(rows, s.units)}</details>`;
    body.querySelectorAll('.part').forEach((el) => el.addEventListener('click', () => {
      const row = rows.find((r) => r.key === el.dataset.row);
      if (row) { close(); onSelectRow(row); }
    }));
  }

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
