// Pure formatting / shop-math helpers. No three.js or DOM here so they can be
// unit-tested directly under Node (see tests/unit.test.mjs).

const MM_PER_INCH = 25.4;

function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }

// Inches -> nearest fraction, e.g. 12.47 -> 12-1/2". `denom` is the finest
// fraction to round to (16 = sixteenths, 32 = thirty-seconds...).
export function toFraction(inches, denom = 16) {
  const sign = inches < 0 ? '-' : '';
  const units = Math.round(Math.abs(inches) * denom);
  const whole = Math.floor(units / denom);
  const rem = units % denom;
  if (rem === 0) return `${sign}${whole}"`;
  const g = gcd(rem, denom);
  const frac = `${rem / g}/${denom / g}`;
  return whole ? `${sign}${whole}-${frac}"` : `${sign}${frac}"`;
}

export function toMillimeters(inches) {
  const mm = inches * MM_PER_INCH;
  return `${mm >= 100 ? Math.round(mm) : mm.toFixed(1).replace(/\.0$/, '')} mm`;
}

// Unit settings: 'in16' | 'in32' | 'in8' | 'dec' | 'mm'
export const UNIT_OPTIONS = [
  { id: 'in16', label: 'in (1/16)' },
  { id: 'in32', label: 'in (1/32)' },
  { id: 'in8', label: 'in (1/8)' },
  { id: 'dec', label: 'in (decimal)' },
  { id: 'mm', label: 'mm' },
];

export function formatLength(inches, units = 'in16') {
  switch (units) {
    case 'mm': return toMillimeters(inches);
    case 'dec': return `${inches.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}"`;
    case 'in32': return toFraction(inches, 32);
    case 'in8': return toFraction(inches, 8);
    default: return toFraction(inches, 16);
  }
}

export function formatDims(dims, units) {
  return dims.map((d) => formatLength(d, units)).join(' × ');
}

// Board feet = L x W x T (inches) / 144.
export function boardFeet(l, w, t) {
  return (l * w * t) / 144;
}

// Standard rough-sawn hardwood thicknesses, in quarters of an inch.
export const ROUGH_QUARTERS = [4, 5, 6, 8, 10, 12, 16];

// Smallest standard rough thickness that still leaves `planeAllowance` inches
// to flatten and thickness the part down to `finished`. Returns
// { quarters: 8, label: '8/4', inches: 2 }, or null if thicker than 16/4
// (glue-up or a turning blank).
export function roughThickness(finished, planeAllowance = 0.125) {
  const need = finished + planeAllowance;
  for (const q of ROUGH_QUARTERS) {
    if (q / 4 >= need - 1e-6) return { quarters: q, label: `${q}/4`, inches: q / 4 };
  }
  return null;
}

// Rough-stock size to buy/mill for a finished part: extra length for snipe
// and squaring ends, extra width for jointing/ripping, and the next standard
// thickness. Board feet are computed on that rough size, the way a lumberyard
// would charge for it.
export function roughStock(dims, allowance = {}) {
  const { length = 1, width = 0.25, thickness = 0.125 } = allowance;
  const [l, w, t] = dims;
  const rough = roughThickness(t, thickness);
  const roughT = rough ? rough.inches : t + thickness;
  const roughL = l + length, roughW = w + width;
  return {
    length: roughL,
    width: roughW,
    thickness: roughT,
    thicknessLabel: rough ? rough.label : 'glue-up',
    boardFeet: boardFeet(roughL, roughW, roughT),
  };
}

// SketchUp component names -> something readable. "Seat__2" -> "Seat",
// "Treadle_Jaw_Upper__8" -> "Treadle Jaw Upper". A per-model override map
// (model.json "displayNames") wins over the automatic cleanup.
// Names nobody chose: group_12, Component#3, instance_9, ID245, SketchUp's
// solid-tool results... (parse_dae.py GENERIC_NAME)
const GENERIC_NAME = /^(?:group|component|instance|mesh|object|geometry|node|id|sketchup|difference|outershell|union|intersection|trim|split|solid|untitled|default)?[\s_#.-]*\d*$/i;
export const isGenericName = (name) => GENERIC_NAME.test(name || '');

export function displayName(label, overrides = {}) {
  if (overrides[label]) return overrides[label];
  return label
    .replace(/__\d+$/, '')
    .replace(/_+/g, ' ')
    .trim();
}

// Quote a value for CSV (RFC 4180).
export function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Machine set-up groups for milling: parts that share a planer thickness, a
// rip width or a crosscut length, so each setting is dialed in once. Parts
// group together when their size displays the same (`keyOf`, e.g. to the
// nearest 1/16"), so the plan never shows the same setting twice. Largest
// first, since you plane and rip from thick/wide down.
// rows: [{ name, count, dims: [L, W, T] }]
export function millingPlan(rows, keyOf = (v) => formatLength(v)) {
  const group = (idx) => {
    const m = new Map();
    rows.forEach((r) => {
      const k = keyOf(r.dims[idx]);
      if (!m.has(k)) m.set(k, { label: k, value: r.dims[idx], parts: [] });
      const g = m.get(k);
      g.value = Math.max(g.value, r.dims[idx]);
      g.parts.push({ name: r.name, count: r.count });
    });
    return [...m.values()].sort((a, b) => b.value - a.value).map((g) => ({
      ...g, pieces: g.parts.reduce((n, p) => n + p.count, 0),
    }));
  };
  return { thickness: group(2), width: group(1), length: group(0) };
}
