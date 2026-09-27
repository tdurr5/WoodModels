// Boards you already have (on the rack, offcuts worth keeping), kept in this
// browser for every project. The cutting diagram uses them before planning
// boards to buy. Each: { material ('' = any species), thickness ('8/4'),
// width, length (inches), count }.

const KEY = 'woodmodels:inventory';

export function getInventory() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

export function setInventory(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
}

// The boards (one entry per board) usable for a species + rough thickness.
export function ownedFor(list, material, thicknessLabel) {
  const m = (material || '').trim().toLowerCase();
  return list
    .filter((b) => b.thickness === thicknessLabel && (!b.material || b.material.trim().toLowerCase() === m) && b.width > 0 && b.length > 0)
    .flatMap((b, i) => Array.from({ length: Math.max(1, Math.min(50, Math.round(b.count || 1))) }, (_, k) => ({ length: +b.length, width: +b.width, label: `${i}.${k}` })));
}
