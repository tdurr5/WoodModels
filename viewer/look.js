// How a model looks on screen, whatever model it is: the stage it stands on
// (a ground grid and soft shadow sized to it, wherever it was drawn), lights
// that follow its size, smooth shading on round parts, and real-looking
// materials for the parts that aren't wood (steel, brass, paint, leather...).
//
// Models come from anywhere - a SketchUp export drawn a long way from the
// origin, a 6" box or a 20' shed, in any units - so nothing here assumes a
// size or position: fitStage() measures the model and lays everything out
// around it.

import * as THREE from 'three';

// ---------- corners ----------
// Corners that are the same point in the model (to 1/10000", so float
// rounding doesn't split them) get one id: `vid` per corner, `pts` per id.
// Worked out once per part and shared by the passes below; orientFaces keeps
// it in step when it turns faces.
const welds = new WeakMap();
function weld(geometry) {
  const pos = geometry.attributes.position;
  let w = welds.get(geometry);
  if (w && w.vid.length === pos.count) return w;
  const q = 1e4;
  const ids = new Map();
  const pts = [];
  const vid = new Int32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
    let id = ids.get(key);
    if (id === undefined) { ids.set(key, (id = ids.size)); pts.push(x, y, z); }
    vid[i] = id;
  }
  w = { vid, pts, n: ids.size };
  welds.set(geometry, w);
  return w;
}
// the same triangle whichever way round its corners are listed
function faceKey(a, b, c) {
  if (a > b) [a, b] = [b, a];
  if (b > c) [b, c] = [c, b];
  if (a > b) [a, b] = [b, a];
  return `${a},${b},${c}`;
}

// ---------- smooth shading ----------
// The OBJ has no normals, so every triangle is shaded flat and a dowel shows
// its 24 facets. Average each corner's normal with the neighbouring faces
// that meet it at less than `creaseDeg` - round things go smooth, while a
// board's square edges (90°) and a chamfer (45°) stay crisp. SketchUp's
// back-to-back face pairs point opposite ways and never mix.
export function smoothNormals(geometry, creaseDeg = 35) {
  const pos = geometry.attributes.position;
  if (geometry.index || !pos || pos.count < 3) return geometry;
  const n = pos.count;
  const tris = n / 3 | 0;
  const fn = new Float32Array(tris * 3); // per triangle: its normal, scaled by its area
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < tris; t++) {
    a.fromBufferAttribute(pos, t * 3); b.fromBufferAttribute(pos, t * 3 + 1); c.fromBufferAttribute(pos, t * 3 + 2);
    c.sub(b); a.sub(b); c.cross(a); // |c| = 2 x area
    fn[t * 3] = c.x; fn[t * 3 + 1] = c.y; fn[t * 3 + 2] = c.z;
  }
  // the corners at each point
  const { vid, n: points } = weld(geometry);
  const start = new Int32Array(points + 1);
  for (let i = 0; i < tris * 3; i++) start[vid[i] + 1]++;
  for (let p = 0; p < points; p++) start[p + 1] += start[p];
  const fill = start.slice(0, points);
  const corners = new Int32Array(tris * 3);
  for (let i = 0; i < tris * 3; i++) corners[fill[vid[i]]++] = i;
  const cosCrease = Math.cos(THREE.MathUtils.degToRad(creaseDeg));
  const out = new Float32Array(n * 3);
  const units = new Array(tris);
  for (let t = 0; t < tris; t++) {
    const x = fn[t * 3], y = fn[t * 3 + 1], z = fn[t * 3 + 2];
    const l = Math.hypot(x, y, z) || 1;
    units[t] = [x / l, y / l, z / l];
  }
  for (let p = 0; p < points; p++) {
    for (let ci = start[p]; ci < start[p + 1]; ci++) {
      const i = corners[ci], ni = units[i / 3 | 0];
      let x = 0, y = 0, z = 0;
      for (let cj = start[p]; cj < start[p + 1]; cj++) {
        const tj = corners[cj] / 3 | 0, nj = units[tj];
        if (ni[0] * nj[0] + ni[1] * nj[1] + ni[2] * nj[2] < cosCrease) continue;
        x += fn[tj * 3]; y += fn[tj * 3 + 1]; z += fn[tj * 3 + 2];
      }
      const l = Math.hypot(x, y, z);
      if (l > 1e-12) { out[i * 3] = x / l; out[i * 3 + 1] = y / l; out[i * 3 + 2] = z / l; }
      else { out[i * 3] = ni[0]; out[i * 3 + 1] = ni[1]; out[i * 3 + 2] = ni[2]; }
    }
  }
  geometry.setAttribute('normal', new THREE.BufferAttribute(out, 3));
  return geometry;
}

// ---------- faces that point the wrong way ----------
// SketchUp writes every face twice, back to back, so a part looks solid from
// any side. Other exporters (Blender, Fusion, Rhino...) write each face once,
// and a face wound the wrong way is invisible from outside - a hole in the
// part. For a part drawn single-sided: turn each face to agree with its
// neighbours across shared edges, then each connected piece so it faces out
// (positive volume). Returns true when the part is single-sided, so it can
// also be drawn from both sides in case it's an open surface.
export function isBackToBack(geometry) {
  const pos = geometry.attributes.position;
  const tris = pos.count / 3 | 0;
  if (!tris) return true;
  const { vid } = weld(geometry);
  const seen = new Map();
  let paired = 0;
  for (let t = 0; t < tris; t++) {
    const key = faceKey(vid[t * 3], vid[t * 3 + 1], vid[t * 3 + 2]);
    const n = seen.get(key) || 0;
    if (n % 2 === 1) paired += 2;
    seen.set(key, n + 1);
  }
  return paired >= tris * 0.9;
}

export function orientFaces(geometry) {
  if (geometry.index || isBackToBack(geometry)) return false;
  const pos = geometry.attributes.position;
  const tris = pos.count / 3 | 0;
  const { vid } = weld(geometry);
  // undirected edge -> [triangle, direction (+1: a->b with a<b)]
  const edges = new Map();
  for (let t = 0; t < tris; t++) {
    for (let e = 0; e < 3; e++) {
      const a = vid[t * 3 + e], b = vid[t * 3 + (e + 1) % 3];
      if (a === b) continue;
      const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      let list = edges.get(key);
      if (!list) edges.set(key, (list = []));
      list.push([t, a < b ? 1 : -1]);
    }
  }
  const flip = new Int8Array(tris); // 0 unvisited, 1 keep, -1 flip
  const comp = new Int32Array(tris).fill(-1);
  const volumes = [];
  const stack = [];
  const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), p2 = new THREE.Vector3();
  for (let start = 0; start < tris; start++) {
    if (flip[start]) continue;
    const c = volumes.length;
    volumes.push(0);
    flip[start] = 1; comp[start] = c;
    stack.push(start);
    while (stack.length) {
      const t = stack.pop();
      for (let e = 0; e < 3; e++) {
        const a = vid[t * 3 + e], b = vid[t * 3 + (e + 1) % 3];
        if (a === b) continue;
        const list = edges.get(a < b ? a * 4294967296 + b : b * 4294967296 + a);
        if (list.length !== 2) continue; // an open edge, or three faces on one edge: no clear neighbour
        const mine = (a < b ? 1 : -1) * flip[t];
        const [u, dirU] = list[0][0] === t ? list[1] : list[0];
        if (u === t || flip[u]) continue;
        // neighbours agree when they run along their shared edge in opposite directions
        flip[u] = dirU === mine ? -1 : 1;
        comp[u] = c;
        stack.push(u);
      }
    }
  }
  for (let t = 0; t < tris; t++) {
    p0.fromBufferAttribute(pos, t * 3); p1.fromBufferAttribute(pos, t * 3 + 1); p2.fromBufferAttribute(pos, t * 3 + 2);
    volumes[comp[t]] += flip[t] * p0.dot(p1.cross(p2));
  }
  let changed = false;
  for (let t = 0; t < tris; t++) {
    if (flip[t] * (volumes[comp[t]] < 0 ? -1 : 1) > 0) continue;
    changed = true;
    // swap corners 1 and 2
    const i = t * 3 + 1, j = t * 3 + 2;
    [vid[i], vid[j]] = [vid[j], vid[i]];
    for (const attr of Object.values(geometry.attributes)) {
      for (let c = 0; c < attr.itemSize; c++) {
        const v = attr.getComponent(i, c);
        attr.setComponent(i, c, attr.getComponent(j, c));
        attr.setComponent(j, c, v);
      }
      attr.needsUpdate = true;
    }
  }
  if (changed) geometry.computeVertexNormals(); // flat: one normal per face, now facing out
  return true;
}

// ---------- edge lines ----------
// The part's outline, like SketchUp draws it: every edge where two faces meet
// at more than `creaseDeg` (a board's corners, a chamfer, a tenon's
// shoulder), and the edge of an open surface - but not the diagonals across
// a flat face or the seams between a dowel's facets. Returns line-segment
// positions (x,y,z pairs) for THREE.LineSegments.
export function featureEdges(geometry, creaseDeg = 30) {
  const pos = geometry.attributes.position;
  const tris = pos.count / 3 | 0;
  const { vid, pts } = weld(geometry);
  // each face once (SketchUp's back-to-back copies share their corners), with its unit normal
  const faces = new Map();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < tris; t++) {
    const v = [vid[t * 3], vid[t * 3 + 1], vid[t * 3 + 2]];
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
    const key = faceKey(v[0], v[1], v[2]);
    if (faces.has(key)) continue;
    a.fromBufferAttribute(pos, t * 3); b.fromBufferAttribute(pos, t * 3 + 1); c.fromBufferAttribute(pos, t * 3 + 2);
    const n = c.sub(b).cross(a.sub(b));
    if (n.lengthSq() < 1e-20) continue;
    faces.set(key, { v, n: n.normalize().clone() });
  }
  const edges = new Map();
  faces.forEach((f) => {
    for (let e = 0; e < 3; e++) {
      const i = f.v[e], j = f.v[(e + 1) % 3];
      const key = i < j ? i * 4294967296 + j : j * 4294967296 + i;
      let list = edges.get(key);
      if (!list) edges.set(key, (list = { i, j, normals: [] }));
      list.normals.push(f.n);
    }
  });
  const cos = Math.cos(THREE.MathUtils.degToRad(creaseDeg));
  const out = [];
  edges.forEach(({ i, j, normals }) => {
    // faces may face either way here (one of each back-to-back pair was
    // kept), so compare the planes, not the directions
    let crease = normals.length === 1;
    for (let m = 0; m < normals.length && !crease; m++) {
      for (let n = m + 1; n < normals.length; n++) if (Math.abs(normals[m].dot(normals[n])) < cos) { crease = true; break; }
    }
    if (crease) out.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2], pts[j * 3], pts[j * 3 + 1], pts[j * 3 + 2]);
  });
  return new Float32Array(out);
}

// Lines drawn exactly on a part's edges lose the depth test to its faces half
// the time (flicker). Pull them a hair towards the camera in the vertex
// shader - the picture doesn't move, only the depth. (Polygon offset can't do
// it: the logarithmic depth buffer writes its own depth.)
export function edgeMaterial(color, opacity) {
  const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      if (isPerspectiveMatrix(projectionMatrix)) {
        gl_Position = projectionMatrix * vec4(mvPosition.xyz * 0.9985, 1.0);
      } else {
        gl_Position = projectionMatrix * vec4(mvPosition.xy, mvPosition.z + 0.02, 1.0);
      }`);
  };
  m.customProgramCacheKey = () => 'edge-nudge';
  return m;
}

// ---------- materials for what isn't wood ----------
// What a material most likely is, from its names: metal (and which), glass,
// leather, rubber, paint - else plain. Several languages, like woodtex.js.
const KINDS = [
  { kind: 'brass', words: ['brass', 'laiton', 'messing', 'laton', 'bronze', 'gold', 'or'] },
  { kind: 'copper', words: ['copper', 'cuivre', 'kupfer', 'cobre'] },
  { kind: 'blackMetal', words: ['black iron', 'cast iron', 'wrought', 'blackened', 'fonte', 'gusseisen', 'oxide', 'anthracite'] },
  { kind: 'metal', words: ['steel', 'stainless', 'iron', 'metal', 'metallic', 'chrome', 'aluminum', 'aluminium', 'zinc', 'nickel', 'galvanized', 'acier', 'metal', 'stahl', 'eisen', 'acero', 'hierro', 'inox', 'bolt', 'screw', 'nut', 'washer', 'rod', 'hinge', 'nail', 'hardware'] },
  { kind: 'glass', words: ['glass', 'glazing', 'verre', 'glas', 'vidrio', 'cristal', 'translucent', 'acrylic', 'plexi', 'mirror'] },
  { kind: 'leather', words: ['leather', 'cuir', 'leder', 'cuero', 'suede'] },
  { kind: 'rubber', words: ['rubber', 'caoutchouc', 'gummi', 'goma', 'foam', 'vinyl', 'plastic', 'nylon', 'pvc'] },
  { kind: 'fabric', words: ['fabric', 'cloth', 'canvas', 'linen', 'cotton', 'wool', 'felt', 'upholstery', 'cushion', 'tissu', 'stoff', 'tela'] },
  { kind: 'stone', words: ['stone', 'concrete', 'marble', 'granite', 'brick', 'tile', 'slate', 'beton', 'pierre', 'stein', 'piedra', 'hormigon'] },
  { kind: 'paint', words: ['paint', 'painted', 'lacquer', 'enamel', 'milk paint', 'peinture', 'lack', 'pintura', 'color', 'colour'] },
];
const cleanName = (s) => ` ${String(s || '').normalize('NFKD').replace(/[^\x00-\x7F]/g, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z]+/g, ' ').trim()} `;
export function materialKind(category, ...names) {
  const text = names.map(cleanName).join(' ');
  for (const { kind, words } of KINDS) if (words.some((w) => text.includes(` ${w} `))) return kind;
  if (category === 'Hardware') return 'metal';
  if (category === 'Leather') return 'leather';
  return 'plain';
}

// A physically based material (lit like the wood, with reflections from the
// studio environment) for a non-wood part: `color` from the model, `kind`
// from materialKind().
export function surfaceMaterial(kind, color) {
  const c = new THREE.Color(color);
  const lum = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
  const opts = { color: c, roughness: 0.6, metalness: 0, envMapIntensity: 0.5 };
  switch (kind) {
    case 'metal':
      // SketchUp's greys are often very light or very dark; keep steel steel-ish
      if (Math.abs(c.r - c.g) < 0.06 && Math.abs(c.g - c.b) < 0.08) c.setScalar(THREE.MathUtils.clamp(lum, 0.45, 0.8));
      Object.assign(opts, { roughness: 0.38, metalness: 0.85, envMapIntensity: 1.1 });
      break;
    case 'blackMetal': Object.assign(opts, { roughness: 0.55, metalness: 0.7, envMapIntensity: 0.9 }); break;
    case 'brass': case 'copper': Object.assign(opts, { roughness: 0.32, metalness: 0.9, envMapIntensity: 1.2 }); break;
    case 'glass': Object.assign(opts, { roughness: 0.05, transparent: true, opacity: 0.3, envMapIntensity: 1.5, depthWrite: false }); break;
    case 'leather': Object.assign(opts, { roughness: 0.62, envMapIntensity: 0.4 }); break;
    case 'rubber': Object.assign(opts, { roughness: 0.85, envMapIntensity: 0.25 }); break;
    case 'fabric': Object.assign(opts, { roughness: 0.95, envMapIntensity: 0.15 }); break;
    case 'stone': Object.assign(opts, { roughness: 0.85, envMapIntensity: 0.25 }); break;
    case 'paint': Object.assign(opts, { roughness: 0.45, envMapIntensity: 0.5 }); break;
    default: break;
  }
  const m = new THREE.MeshStandardMaterial(opts);
  m.userData.kind = kind;
  return m;
}

// ---------- the stage: lights, ground, shadows ----------
const GRID_VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
    #include <logdepthbuf_vertex>
  }`;
// Minor and major lines, anti-aliased with screen-space derivatives; minor
// lines fade out where they'd crowd into a grey smear (seen edge-on or from
// far away), and the whole grid fades out towards its edge instead of
// stopping at a hard square.
const GRID_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 minorColor;
  uniform vec3 majorColor;
  uniform float cell;
  uniform float major;
  uniform vec2 center;
  uniform float radius;
  varying vec3 vWorld;
  float lineAt(vec2 p, float size, out float density) {
    vec2 g = p / size;
    vec2 w = fwidth(g);
    density = max(w.x, w.y);
    vec2 d = abs(fract(g - 0.5) - 0.5) / max(w, 1e-5);
    return 1.0 - min(min(d.x, d.y), 1.0);
  }
  void main() {
    #include <logdepthbuf_fragment>
    float dMinor, dMajor;
    float minor = lineAt(vWorld.xz, cell, dMinor) * (1.0 - smoothstep(0.08, 0.3, dMinor));
    float maj = lineAt(vWorld.xz, cell * major, dMajor) * (1.0 - smoothstep(0.3, 0.7, dMajor));
    float fade = 1.0 - smoothstep(radius * 0.45, radius, length(vWorld.xz - center));
    float a = max(minor * 0.55, maj) * fade;
    if (a < 0.003) discard;
    gl_FragColor = vec4(mix(minorColor, majorColor, maj), a);
  }`;

const GROUND_THEMES = {
  dark: { minor: 0x34363b, major: 0x4b4e55, shadow: 0.55 },
  light: { minor: 0xe6e0d6, major: 0xcdc5b8, shadow: 0.2 },
};

// Grid squares that suit the model's size: inches for a box, a foot for
// furniture, four feet for a shed. [minor, lines per major]
export function gridSpacing(footprint) {
  if (footprint <= 8) return [0.25, 4];      // 1/4", with inch lines
  if (footprint <= 20) return [1, 6];        // 1", every 6"
  if (footprint <= 150) return [1, 12];      // 1", every foot
  if (footprint <= 400) return [6, 8];       // 6", every 4'
  return [12, 10];                           // 1', every 10'
}

export function createStage(scene, renderer) {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // with a radius: a soft edge (PCFSoft ignores it)

  // Sky above, warm bounce from a wooden shop floor below: tops read lighter
  // than sides even where the key light doesn't reach, so boards don't go flat.
  const hemi = new THREE.HemisphereLight(0xfbf6ee, 0x6b5a48, 0.55);
  scene.add(hemi);
  const ambient = new THREE.AmbientLight(0xffffff, 0.12);
  scene.add(ambient);
  // key: casts the shadows; fill from the other side, and a little rim from behind
  const key = new THREE.DirectionalLight(0xfff4e6, 1.35);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 3;
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(0xe8f0ff, 0.45);
  scene.add(fill, fill.target);
  const rim = new THREE.DirectionalLight(0xffffff, 0.3);
  scene.add(rim, rim.target);

  const ground = new THREE.Group();
  ground.name = 'ground';
  const gridMat = new THREE.ShaderMaterial({
    uniforms: {
      minorColor: { value: new THREE.Color() }, majorColor: { value: new THREE.Color() },
      cell: { value: 1 }, major: { value: 12 }, center: { value: new THREE.Vector2() }, radius: { value: 100 },
    },
    vertexShader: GRID_VERT, fragmentShader: GRID_FRAG,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    extensions: { derivatives: true },
  });
  const gridMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), gridMat);
  gridMesh.renderOrder = -2;
  gridMesh.raycast = () => {}; // never picked or measured
  const shadowMat = new THREE.ShadowMaterial({ opacity: 0.5, depthWrite: false, transparent: true });
  const shadowMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), shadowMat);
  shadowMesh.receiveShadow = true;
  shadowMesh.renderOrder = -1;
  shadowMesh.raycast = () => {};
  ground.add(gridMesh, shadowMesh);
  scene.add(ground);

  const stage = { ground, key, fill, rim, hemi, size: 100, box: null };

  // Lay the stage out around `box` (world): the ground at its foot (or at
  // `floor`, lower, when exploded parts hang below it), lights aimed from
  // `viewDir` (the model's 3D preset, so the key light comes from over the
  // viewer's shoulder and its shadow falls behind and to the side).
  stage.fit = (box, viewDir = [0.7, 0.5, 0.7], floor = box?.min.y) => {
    if (!box || box.isEmpty()) return;
    stage.box = box.clone();
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const R = Math.max(size.length() / 2, 0.5);
    stage.size = R;
    const footprint = Math.max(size.x, size.z, size.y * 0.5, 1);
    const y = Math.min(floor, box.min.y) - R * 0.0005; // just under the feet, so they don't z-fight

    const [cell, major] = gridSpacing(footprint);
    const extent = Math.max(footprint * 3.2, R * 4);
    gridMesh.scale.set(extent * 2, 1, extent * 2);
    gridMesh.position.set(center.x, y, center.z);
    gridMat.uniforms.cell.value = cell;
    gridMat.uniforms.major.value = major;
    gridMat.uniforms.center.value.set(center.x, center.z);
    gridMat.uniforms.radius.value = extent;
    shadowMesh.scale.set(extent * 2, 1, extent * 2);
    shadowMesh.position.set(center.x, y + R * 0.0002, center.z);

    // lights: the key over the viewer's right shoulder, high; fill low from
    // the viewer's left; rim from behind
    const v = new THREE.Vector3(...viewDir);
    v.y = 0;
    if (v.lengthSq() < 1e-6) v.set(0.7, 0, 0.7);
    v.normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const around = (deg, elev) => v.clone().applyAxisAngle(up, THREE.MathUtils.degToRad(deg))
      .multiplyScalar(Math.cos(THREE.MathUtils.degToRad(elev))).setY(Math.sin(THREE.MathUtils.degToRad(elev))).normalize();
    const kDir = around(-50, 52), fDir = around(70, 25), rDir = around(170, 40);
    [[key, kDir], [fill, fDir], [rim, rDir]].forEach(([l, d]) => {
      l.target.position.copy(center);
      l.position.copy(center).addScaledVector(d, R * 4);
      l.target.updateMatrixWorld();
      l.updateMatrixWorld();
    });

    // shadow camera: just big enough for the model and the shadow it throws on the ground
    const cam = key.shadow.camera;
    const look = new THREE.Matrix4().lookAt(key.position, center, Math.abs(kDir.y) > 0.99 ? new THREE.Vector3(0, 0, 1) : up);
    const inv = look.clone().invert();
    const lb = new THREE.Box3();
    const p = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : y, i & 4 ? box.max.z : box.min.z);
      lb.expandByPoint(p.clone().sub(key.position).applyMatrix4(inv));
      // where that corner's shadow lands on the ground
      const drop = (p.y - y) / Math.max(kDir.y, 0.1);
      p.addScaledVector(kDir, -drop);
      lb.expandByPoint(p.clone().sub(key.position).applyMatrix4(inv));
    }
    const pad = R * 0.08;
    cam.left = lb.min.x - pad; cam.right = lb.max.x + pad;
    cam.bottom = lb.min.y - pad; cam.top = lb.max.y + pad;
    cam.near = Math.max(0.01, -lb.max.z - R); cam.far = -lb.min.z + R;
    cam.updateProjectionMatrix();
    // bias in world terms: a couple of shadow-map texels, so boards don't
    // shadow themselves in stripes (acne) but stay in contact with what they touch
    const texel = Math.max(cam.right - cam.left, cam.top - cam.bottom) / key.shadow.mapSize.x;
    key.shadow.normalBias = texel * 1.5;
    key.shadow.bias = -0.0004;
    key.shadow.needsUpdate = true;
  };

  stage.setTheme = (name) => {
    const t = GROUND_THEMES[name] || GROUND_THEMES.dark;
    gridMat.uniforms.minorColor.value.setHex(t.minor);
    gridMat.uniforms.majorColor.value.setHex(t.major);
    shadowMat.opacity = t.shadow;
  };
  stage.setTheme('dark');
  return stage;
}
