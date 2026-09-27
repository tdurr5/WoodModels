// Holes the model forgot. A bolt, rod or pin drawn going through a part
// needs a hole there; modelers often draw the bolt and never cut the hole.
// Walk along each shank's centre line through every part it crosses: where
// the part is solid wood under the centre line, the hole is missing. Works
// from the shapes alone, on any model. Pure: the caller says what's solid
// (inside(part, point)).
//
// shanks: [{ name, center: [x,y,z], axis: unit [x,y,z], length, dia }]
// parts:  [{ name, obb: {center, axes, half} (geometry.js obbFromDims) }]
// Returns [{ part, shank, dia, from: [x,y,z], to: [x,y,z], depth, axis }]:
// the stretch of the shank's line that's solid in the part (drill from
// `from` to `to`).

const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// the stretch [t0, t1] of the line c + a*t inside box B, or null
function lineInBox(c, a, B, lo, hi) {
  let t0 = lo, t1 = hi;
  const d = [c[0] - B.center[0], c[1] - B.center[1], c[2] - B.center[2]];
  for (let i = 0; i < 3; i++) {
    const p = dot(d, B.axes[i]), v = dot(a, B.axes[i]);
    if (Math.abs(v) < 1e-9) { if (Math.abs(p) > B.half[i]) return null; continue; }
    let e0 = (-B.half[i] - p) / v, e1 = (B.half[i] - p) / v;
    if (e0 > e1) [e0, e1] = [e1, e0];
    t0 = Math.max(t0, e0); t1 = Math.min(t1, e1);
    if (t0 >= t1) return null;
  }
  return [t0, t1];
}

export function findMissingHoles(shanks, parts, inside, { step = 1 / 16, minDepth = 1 / 8 } = {}) {
  const out = [];
  for (const s of shanks) {
    for (const P of parts) {
      const span = lineInBox(s.center, s.axis, P.obb, -s.length / 2, s.length / 2);
      if (!span || span[1] - span[0] < minDepth) continue;
      // solid runs along the centre line, inside the part's box
      const n = Math.max(3, Math.ceil((span[1] - span[0]) / step));
      let runStart = null, best = null;
      for (let k = 0; k <= n; k++) {
        const t = span[0] + ((span[1] - span[0]) * k) / n;
        const solid = k < n && inside(P, add(s.center, s.axis, t));
        if (solid && runStart === null) runStart = t;
        if (!solid && runStart !== null) {
          if (!best || t - runStart > best[1] - best[0]) best = [runStart, t];
          runStart = null;
        }
      }
      if (!best || best[1] - best[0] < Math.max(minDepth, s.dia / 2)) continue;
      out.push({
        part: P.name, shank: s.name, dia: s.dia, axis: s.axis,
        from: add(s.center, s.axis, best[0]), to: add(s.center, s.axis, best[1]), depth: best[1] - best[0],
      });
    }
  }
  return out;
}
