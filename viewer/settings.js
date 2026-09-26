// Per-viewer preferences (units, rough-stock allowances, which parts are
// ticked off as cut...). Kept in localStorage so they survive a reload; every
// access is guarded because storage can be unavailable (private windows,
// blocked site data) and the viewer must work without it.

const DEFAULTS = {
  units: 'in16',
  showRough: false,
  allowance: { length: 1, width: 0.25, thickness: 0.125 },
  hiddenCategories: [],
  cut: [],          // row keys ticked off as cut / done
  isolate: false,   // hide (rather than ghost) unselected parts
  stock: { length: 96, width: 8, kerf: 0.125 }, // lumber for cutting diagrams
};

let storageKey = 'woodmodels:settings';
let state = structuredClone(DEFAULTS);
const listeners = new Set();

export function initSettings(modelKey) {
  storageKey = `woodmodels:${modelKey}:settings`;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (saved && typeof saved === 'object') {
      state = {
        ...structuredClone(DEFAULTS), ...saved,
        allowance: { ...DEFAULTS.allowance, ...(saved.allowance || {}) },
        stock: { ...DEFAULTS.stock, ...(saved.stock || {}) },
      };
    }
  } catch { /* storage unavailable or corrupt - fall back to defaults */ }
  return state;
}

export function settings() { return state; }

export function updateSettings(patch) {
  state = { ...state, ...patch };
  try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* ignore */ }
  listeners.forEach((fn) => fn(state, patch));
}

export function onSettingsChange(fn) { listeners.add(fn); }
