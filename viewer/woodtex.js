// Realistic wood, drawn in the browser: no image files to download, so it
// works offline, and every species gets its own look - colour, growth rings,
// pores, oak's ray fleck, pine's knots - plus proper end grain on the ends
// of boards and a light surface relief so the grain catches the light.
//
// Textures are generated once per species (seeded, so they look the same on
// every load) and shared by every part cut from it.

import * as THREE from 'three';

// early/late: earlywood and latewood colour; rings: growth rings across one
// texture tile (~6" of board width); contrast: how dark the latewood bands
// read; pores: 'ring' (oak, ash: open pores in the earlywood), 'diffuse'
// (walnut, cherry), or none; rays: oak's fleck; knots: chance of a knot.
export const SPECIES = {
  'red-oak': { name: 'Red oak', early: '#cf9e73', late: '#9a6443', rings: 6, contrast: 0.45, pores: 'ring', rays: true, rough: 0.6, words: ['red oak', 'redoak', 'oak red', 'roble rojo', 'chene rouge'] },
  'white-oak': { name: 'White oak', early: '#cdad7f', late: '#94744c', rings: 6, contrast: 0.42, pores: 'ring', rays: true, rough: 0.6, words: ['white oak', 'whiteoak', 'oak', 'chene', 'eiche', 'roble'] },
  walnut: { name: 'Walnut', early: '#76533a', late: '#3f2a1c', rings: 4, contrast: 0.33, pores: 'diffuse', rough: 0.5, words: ['walnut', 'noyer', 'nussbaum', 'nogal'] },
  cherry: { name: 'Cherry', early: '#bd7b53', late: '#914f33', rings: 4, contrast: 0.27, pores: 'fine', rough: 0.45, words: ['cherry', 'merisier', 'kirsch', 'cerezo'] },
  maple: { name: 'Maple', early: '#ecd8b4', late: '#d6ba8f', rings: 5, contrast: 0.21, pores: 'fine', rough: 0.45, words: ['maple', 'erable', 'ahorn', 'arce'] },
  ash: { name: 'Ash', early: '#e2cb9f', late: '#a88a5c', rings: 5, contrast: 0.48, pores: 'ring', rough: 0.6, words: ['ash', 'frene', 'esche', 'fresno'] },
  hickory: { name: 'Hickory', early: '#dcbb90', late: '#9c7249', rings: 5, contrast: 0.42, pores: 'ring', rough: 0.6, words: ['hickory', 'pecan'] },
  beech: { name: 'Beech', early: '#e4bc97', late: '#c89a74', rings: 4, contrast: 0.21, pores: 'fine', rays: true, rough: 0.5, words: ['beech', 'hetre', 'buche', 'haya'] },
  birch: { name: 'Birch / plywood', early: '#eedcb9', late: '#d8be93', rings: 4, contrast: 0.21, pores: 'fine', rough: 0.5, words: ['birch', 'plywood', 'ply', 'bouleau', 'birke'] },
  poplar: { name: 'Poplar', early: '#dfd6ad', late: '#b3ab7a', rings: 4, contrast: 0.24, pores: 'fine', rough: 0.55, words: ['poplar', 'peuplier', 'pappel', 'tulip'] },
  mahogany: { name: 'Mahogany', early: '#a3563a', late: '#6f3423', rings: 4, contrast: 0.27, pores: 'diffuse', rough: 0.45, words: ['mahogany', 'sapele', 'acajou', 'caoba'] },
  pine: { name: 'Pine', early: '#ecd09a', late: '#c48c4c', rings: 4, contrast: 0.54, pores: '', knots: 0.8, rough: 0.6, words: ['pine', 'pin', 'pino', 'kiefer', 'sapin'] },
  larch: { name: 'Larch', early: '#dcb27b', late: '#9f5f2d', rings: 6, contrast: 0.57, pores: '', knots: 0.4, rough: 0.6, words: ['larch', 'meleze', 'melese', 'larche', 'alerce'] },
  fir: { name: 'Fir / spruce', early: '#e8cf9f', late: '#b88a55', rings: 5, contrast: 0.51, pores: '', knots: 0.5, rough: 0.6, words: ['fir', 'douglas', 'spruce', 'hemlock', 'fichte', 'epicea'] },
  cedar: { name: 'Cedar', early: '#cd8f62', late: '#8e5236', rings: 6, contrast: 0.42, pores: '', knots: 0.3, rough: 0.6, words: ['cedar', 'cedre', 'zeder', 'cedro', 'redwood'] },
};

const clean = (s) => String(s || '').normalize('NFKD').replace(/[^\x00-\x7F]/g, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z]+/g, ' ').trim();

// The species a material most likely is, from its names (label, SketchUp
// material name...), or null. Longer names win ("red oak" over "oak").
export function speciesFor(...names) {
  const text = ` ${names.map(clean).join(' ')} `;
  let best = null, bestLen = 0;
  Object.entries(SPECIES).forEach(([key, s]) => s.words.forEach((w) => {
    if (w.length > bestLen && text.includes(` ${w} `)) { best = key; bestLen = w.length; }
  }));
  return best;
}

// ---------- noise ----------
function hash(x, y, seed) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 982451653);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed), c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x, y, seed) => noise(x, y, seed) * 0.6 + noise(x * 2.1, y * 2.1, seed + 7) * 0.3 + noise(x * 4.3, y * 4.3, seed + 13) * 0.1;
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

// ---------- the textures ----------
// Side grain (face and edge of a board): a flat-sawn plank. The board is a
// plane cut past a log whose growth rings are warped cylinders, which gives
// the arches ("cathedrals") down the length; x runs across the board, y
// along it. Mirrored repeat hides the tile seams.
function sideGrain(sp, seed, W = 512, H = 1024) {
  const early = rgb(sp.early), late = rgb(sp.late);
  const color = new Uint8ClampedArray(W * H * 4), bump = new Uint8ClampedArray(W * H * 4);
  const knots = [];
  if (sp.knots && hash(seed, 3, 1) < sp.knots) knots.push({ x: 0.2 + 0.6 * hash(seed, 4, 1), y: 0.15 + 0.7 * hash(seed, 5, 1), r: 0.035 + 0.03 * hash(seed, 6, 1) });
  for (let j = 0; j < H; j++) {
    const Y = j / H;
    const depth = 0.3 + 0.25 * fbm(Y * 0.9, 0.5, seed); // how far the log's heart is below the face
    const drift = 0.3 * (fbm(Y * 0.7, 3.7, seed + 1) - 0.5);
    for (let i = 0; i < W; i++) {
      const X = i / W;
      let dx = X - 0.5 + drift;
      let dy = depth;
      // a knot pulls the rings round it
      let knot = 0;
      for (const k of knots) {
        const kx = (X - k.x) / k.r, ky = (Y - k.y) / (k.r * 2.2);
        const kd = Math.sqrt(kx * kx + ky * ky);
        if (kd < 3) { dx += (1 / (kd + 0.6)) * 0.02 * Math.sign(kx || 1); knot = Math.max(knot, 1 - smooth(0.6, 1.1, kd)); }
      }
      const r = Math.sqrt(dx * dx * 1.2 + dy * dy) + 0.02 * fbm(X * 6, Y * 24, seed + 2);
      const phase = (r * sp.rings) % 1;
      // latewood: a darker band at the end of each ring, soft on its inner edge
      const lateW = smooth(0.62, 0.86, phase) * (1 - smooth(0.95, 1, phase));
      const streak = fbm(X * 70, Y * 2.5, seed + 3); // fine fibre streaks along the grain
      const tone = fbm(X * 3, Y * 1.2, seed + 9); // broad colour variation across the board
      let t = lateW * sp.contrast + (streak - 0.5) * 0.14 + (tone - 0.5) * 0.25;
      let dark = 0;
      if (sp.pores === 'ring' && phase < 0.35 && noise(X * 260, Y * 14, seed + 4) > 0.78) dark = 0.35;
      else if (sp.pores === 'diffuse' && noise(X * 200, Y * 16, seed + 5) > 0.86) dark = 0.25;
      else if (sp.pores === 'fine' && noise(X * 320, Y * 30, seed + 6) > 0.9) dark = 0.12;
      let light = 0;
      if (sp.rays && noise(X * 110, Y * 9, seed + 7) > 0.88) light = 0.18;
      t = Math.min(1, Math.max(0, t + knot * 0.9));
      const shade = 1 - dark + light;
      const o = (j * W + i) * 4;
      for (let c = 0; c < 3; c++) color[o + c] = (early[c] + (late[c] - early[c]) * t) * shade;
      color[o + 3] = 255;
      const h = 150 + lateW * 60 - dark * 160 + (streak - 0.5) * 30;
      bump[o] = bump[o + 1] = bump[o + 2] = h; bump[o + 3] = 255;
    }
  }
  return [toTexture(color, W, H, true), toTexture(bump, W, H, false)];
}

// End grain: the rings seen head-on, around a heart off to one side of the
// board, with pores as dots and (oak) rays running out from the heart.
function endGrain(sp, seed, S = 512) {
  const early = rgb(sp.early), late = rgb(sp.late);
  const px = new Uint8ClampedArray(S * S * 4);
  const cx = -0.4 - 0.4 * hash(seed, 8, 2), cy = 0.5 + 0.8 * (hash(seed, 9, 2) - 0.5);
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const X = i / S, Y = j / S;
      const dx = X - cx, dy = Y - cy;
      const r = Math.sqrt(dx * dx + dy * dy) + 0.015 * fbm(X * 5, Y * 5, seed + 11);
      const phase = (r * sp.rings * 1.1) % 1;
      const lateW = smooth(0.62, 0.86, phase) * (1 - smooth(0.95, 1, phase));
      let t = lateW * sp.contrast * 1.2 + (noise(X * 60, Y * 60, seed + 12) - 0.5) * 0.1;
      let shade = 0.82; // end grain drinks finish and reads darker
      if (sp.pores && noise(X * 240, Y * 240, seed + 13) > (sp.pores === 'ring' && phase < 0.35 ? 0.7 : 0.9)) shade -= 0.2;
      if (sp.rays) { const a = Math.atan2(dy, dx) * 180; if (noise(a, r * 8, seed + 14) > 0.9) shade += 0.12; }
      t = Math.min(1, Math.max(0, t));
      const o = (j * S + i) * 4;
      for (let c = 0; c < 3; c++) px[o + c] = (early[c] + (late[c] - early[c]) * t) * shade;
      px[o + 3] = 255;
    }
  }
  return toTexture(px, S, S, true);
}

function toTexture(data, w, h, isColor) {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.MirroredRepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  if (isColor) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// A palette for wood that isn't a known species: the model's own colours.
function paletteSpecies(tex) {
  return { name: 'Wood', early: tex.base || '#c9975c', late: tex.ring || tex.streak || '#8a5a2c', rings: 4, contrast: 0.36, pores: 'fine', rough: 0.55 };
}

const cache = new Map();
function texturesFor(key, sp) {
  if (!cache.has(key)) {
    const seed = [...key].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);
    const [map, bumpMap] = sideGrain(sp, seed);
    cache.set(key, { map, bumpMap, endMap: endGrain(sp, seed) });
  }
  return cache.get(key);
}

// A material for wood of the given species (a SPECIES key) or, failing that,
// the colours in a model.json texture entry. Faces marked as end grain (the
// geometry's `endGrain` attribute, see app.js generateGrainUV) show endMap.
export function woodMaterial(species, fallbackTexture = {}) {
  const sp = SPECIES[species] || paletteSpecies(fallbackTexture);
  const key = SPECIES[species] ? species : `palette:${sp.early}:${sp.late}`;
  const { map, bumpMap, endMap } = texturesFor(key, sp);
  const mat = new THREE.MeshStandardMaterial({ map, bumpMap, bumpScale: 0.6, roughness: sp.rough, metalness: 0, envMapIntensity: 0.3 });
  addEndGrain(mat, endMap);
  return mat;
}

// Material.clone() doesn't carry shader hooks: call addEndGrain(clone,
// endMapOf(original)) on clones. (Kept out of userData, which clone() copies
// through JSON.)
const endMaps = new WeakMap();
export const endMapOf = (mat) => endMaps.get(mat);
export function addEndGrain(mat, endMap) {
  if (!endMap) return mat;
  endMaps.set(mat, endMap);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.endMap = { value: endMap };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float endGrain;\nvarying float vEndGrain;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvEndGrain = endGrain;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D endMap;\nvarying float vEndGrain;')
      .replace('#include <map_fragment>', `#ifdef USE_MAP
        vec4 sampledDiffuseColor = vEndGrain > 0.5 ? texture2D( endMap, vMapUv ) : texture2D( map, vMapUv );
        diffuseColor *= sampledDiffuseColor;
      #endif`);
  };
  mat.customProgramCacheKey = () => 'wood-end-grain';
  return mat;
}
