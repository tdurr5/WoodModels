// Design review: the standard-practice checks a cabinetmaker would make
// looking over your drawing, run against the model on screen.
//
// Every finding says three things, because a warning you can't learn from is
// just noise: what it found, *why* it matters, and what to do instead. None
// of them block anything - real work breaks these rules on purpose, and the
// panel is there to make sure it's on purpose.
//
// Pure: plain objects in, findings out, no three.js and no DOM, so it runs
// under Node in the tests. app.js builds the `parts` array from what it
// already knows about the model (sizes, what touches what, tenons, cuts,
// holes) and every rule skips quietly when the data it needs isn't there -
// an uploaded Warehouse model knows less about itself than a designed one.
//
// A part looks like:
// {
//   key, name, letter, count, category, dims: [length, width, thickness],
//   props,                        // woodprops.js entry, or null if unknown
//   sawn,                         // 'flatsawn' | 'quartersawn' | 'unknown'
//   grain: [x, y, z] | null,      // unit vector along the grain (its length)
//   horizontal: bool,             // its face is up: a shelf, seat or top
//   touches: [{ key, name, grain, span }],
//   tenons: [{ into, intoKey, thickness, length, width, through, fromEnd }],
//   butts:  [{ key, name }],      // ends that only meet another part
//   cuts:   [{ kind, depth, through }],
//   holes:  [{ diameter, fromEnd }],
//   supportSpan,                  // clear distance between its supports
// }

import { formatLength } from './format.js';
import { angleBetween } from './angles.js';
import { movement, slotAllowance, RIGID_CROSS_GRAIN_LIMIT, DEFAULT_ENV, mcSwing } from './movement.js';
import { TYPICAL_HARDWOOD } from './woodprops.js';
import { checkTenon, recommendJoints, DADO, SCREW, JOINTS } from './joinery.js';
import { sag, maxSpan, thicknessFor, SAG_LIMITS, LOADS_PSF, EDGE_LIP_NOTE } from './spans.js';
import { hardwoodStock, dimensionalSize, boardFeetOf } from './stock.js';
import { pieceTypeFrom, checkHeight } from './ergonomics.js';

// problem: it will fail or split. watch: it will work, but there's a better
// way. note: worth knowing, nothing wrong.
export const SEVERITY = { problem: 3, watch: 2, note: 1 };

const RULES = [];
const rule = (id, family, fn) => RULES.push({ id, family, fn });

// ---------- wood movement ----------

// A wide solid board moves across its grain with the seasons, and the number
// surprises people: a 32in maple top swings over half an inch.
rule('wide-board', 'movement', (m, c) => {
  const out = [];
  for (const p of m.parts) {
    if (!p.wood || p.props?.moves === false) continue;
    const width = p.dims[1];
    if (width < 6) continue;
    const props = p.props || TYPICAL_HARDWOOD;
    const mv = movement(width, props, { env: m.env, sawn: p.sawn });
    if (mv.total < 1 / 16) continue;
    out.push(finding(p, 'note', 'Moves with the seasons',
      `is ${c.f(width)} across the grain, so it grows and shrinks about ${c.f(mv.total)} over the year${props.typical ? ' (for a typical hardwood - name the species for its own figure)' : ` in ${props.name.toLowerCase()}`}.`,
      `Wood barely moves along the grain and a lot across it. Over a ${Math.round(mv.swing)}-point moisture swing this board changes ${mv.percent.toFixed(1)}% of its width, and anything holding that width fixed loses.`,
      `Nothing to fix on its own - just don't trap it. Fasten it so it can slide, and leave ${c.f(mv.each)} of room wherever it sits in a groove or against a stop.`));
  }
  return out;
});

// The classic splitter: a wide board's grain crossed and held by another
// part. What decides whether it matters is how far the movement adds up to,
// not that the grain crosses - grain crosses at every joint in furniture.
// Under a sixteenth the joint absorbs it; a tabletop's half inch tears
// itself apart. One finding per board, listing everything that crosses it.
rule('cross-grain', 'movement', (m, c) => {
  const out = [];
  for (const p of m.parts) {
    // Only a board wide enough to move meaningfully: a 2in rail crossing a
    // 3in one is every frame ever built, and none of them split.
    if (!p.wood || !p.grain || p.props?.moves === false || p.dims[1] < 6) continue;
    const crossing = [];
    let widest = 0;
    for (const t of p.touches || []) {
      const other = m.byKey.get(t.key);
      if (!other?.wood || !other.grain || other.props?.moves === false) continue;
      // Grain has no direction, so 170 degrees apart is the same as 10.
      const raw = angleBetween(p.grain, other.grain);
      if (Math.min(raw, 180 - raw) < 45) continue;
      const across = Math.min(t.span ?? 0, p.dims[1]);
      if (!(across > RIGID_CROSS_GRAIN_LIMIT)) continue;
      crossing.push(other);
      widest = Math.max(widest, across);
    }
    if (!crossing.length) continue;
    const props = p.props || TYPICAL_HARDWOOD;
    const slot = slotAllowance(widest, props, { env: m.env, sawn: p.sawn });
    // A sixteenth is nothing; an eighth is a gap you can see; past three
    // sixteenths something has to give, and it will be the wood.
    if (slot.total < 1 / 16) continue;
    const severity = slot.total >= 3 / 16 ? 'problem' : 'watch';
    const names = crossing.map((x) => x.name);
    out.push(finding(p, severity, 'Cross-grain joint',
      `is held across its grain by ${list(names)}, over about ${c.f(widest)}.`,
      `${nameOf(p)} moves ${c.f(slot.total)} across its width over a season and the parts crossing it barely move along their length. Fixed solid over that distance, one of them has to give${severity === 'problem' ? ' - this is the commonest way a good-looking piece fails a year later' : ''}.`,
      severity === 'problem'
        ? `Let it slide: slotted screw holes ${c.f(slot.slot)} long with the screw centred, buttons in a groove, or figure-8 fasteners. Fix it solid only in the middle ${c.f(RIGID_CROSS_GRAIN_LIMIT)} and let the movement run out to both edges.`
        : `Fine bolted or screwed at one line of fixings. If it is glued or screwed at both edges, slot the outer holes ${c.f(slot.slot)} so the wood can still move.`,
      crossing.map((x) => x.key)));
  }
  return out;
});

// ---------- joinery ----------

rule('tenon-proportions', 'joinery', (m, c) => {
  const out = [];
  for (const p of m.parts) {
    for (const t of p.tenons || []) {
      const into = m.byKey.get(t.intoKey);
      const problems = checkTenon({
        thickness: t.thickness, length: t.length, width: t.width, through: t.through,
        railThickness: p.dims[2], intoThickness: into?.dims[2], fromEnd: t.fromEnd,
      }, c.f);
      for (const pr of problems) {
        out.push(finding(p, pr.id === 'tenon-fat' ? 'note' : 'watch', 'Tenon proportions',
          `has a tenon into ${t.into} that ${pr.text}.`,
          'A tenon is sized to get the most long-grain glue area it can without weakening either part: a third of the rail thick, at least five times its own thickness long, and no wider than six times its thickness.',
          capitalise(`${pr.fix}.`), into ? [into.key] : []));
      }
    }
  }
  return out;
});

// An end that just meets another part, with nothing cut into either one.
rule('butt-joint', 'joinery', (m) => {
  const out = [];
  for (const p of m.parts) {
    if (!p.wood || !(p.butts || []).length) continue;
    if (p.dims[0] < 8) continue;               // a short block is usually captured
    const conn = p.horizontal ? 'shelf-to-side' : 'rail-to-leg';
    const picks = recommendJoints(conn, { tools: m.tools }).filter((j) => j.key !== 'butt-screw');
    for (const b of p.butts) {
      out.push(finding(p, 'watch', 'Butt joint',
        `meets ${b.name} end grain to face, with no joint cut into either part.`,
        'Glue onto end grain holds almost nothing: the fibres are cut across, the glue soaks in, and there is no long grain to bond to. Whatever holds this joint together is the screws or nothing.',
        `For ${describeConn(conn)}, cut ${picks.slice(0, 2).map((j) => j.name.toLowerCase()).join(' or ')}${picks[0]?.note ? ` - ${picks[0].note}` : ''}.`,
        [b.key]));
    }
  }
  return out;
});

rule('dado-depth', 'joinery', (m, c) => {
  const out = [];
  for (const p of m.parts) {
    const t = p.dims[2];
    for (const cut of p.cuts || []) {
      if (!['dado', 'groove', 'rabbet'].includes(cut.kind) || cut.through || !cut.depth) continue;
      if (cut.depth <= t * DADO.maxDepthRatio + 1 / 64) continue;
      out.push(finding(p, 'watch', 'Deep housing',
        `has a ${cut.kind} ${c.f(cut.depth)} deep in ${c.f(t)} stock - over half way through.`,
        'A housing carries the load on the wood under it. Past half the thickness you are removing more than the joint gains, and the remaining tongue snaps along the grain.',
        `A third of the thickness (${c.f(t * DADO.depthRatio)}) is the usual depth, and half is the most it should ever be.`));
    }
  }
  return out;
});

// ---------- stiffness ----------

rule('sag', 'span', (m, c) => {
  const out = [];
  for (const p of m.parts) {
    const span = p.supportSpan;
    const props = p.props || (p.wood ? TYPICAL_HARDWOOD : null);
    if (!span || !props?.moe || !p.horizontal) continue;
    const [, depth, thickness] = p.dims;
    if (span < 18 || thickness > 2) continue;
    const psf = m.load ?? LOADS_PSF.books;
    const s = sag({ span, depth, thickness, moe: props.moe, psf });
    if (!s) continue;
    const allowed = span / SAG_LIMITS.loose;
    if (s.inches <= allowed) continue;
    const need = thicknessFor({ span, depth, moe: props.moe, psf });
    const ok = maxSpan({ depth, thickness, moe: props.moe, psf });
    out.push(finding(p, s.inches > allowed * 2 ? 'problem' : 'watch', 'Will sag',
      `spans ${c.f(span)} at ${c.f(thickness)} thick: about ${c.f(s.inches)} of sag under ${psf} lb/ft² of load, past the ${c.f(allowed)} a span this long should show.`,
      `Stiffness goes with the cube of thickness and against the cube of span, so small changes swing it hard. ${props.typical ? 'Figured for a typical hardwood' : `Figured for ${props.name.toLowerCase()}`} at ${(props.moe / 1e6).toFixed(2)} million psi.`,
      `Shorten the span to ${c.f(ok)}, go to ${c.f(need.buy)} stock, or ${EDGE_LIP_NOTE}.`));
  }
  return out;
});

// ---------- stock ----------

rule('off-the-rack', 'stock', (m) => {
  const out = [];
  for (const p of m.parts) {
    if (!p.wood || p.props?.type !== 'softwood') continue;
    const name = dimensionalSize(p.dims[2], p.dims[1]);
    if (!name) continue;
    out.push(finding(p, 'note', 'Buy it surfaced',
      `is exactly a ${name}: buy it off the rack, no milling.`,
      'Dimensional lumber is already planed to these sizes. Drawing a part at the actual size of a stocked board (not the nominal one) is free money.',
      'Nothing to change.'));
  }
  return out;
});

// Thicknesses that land just over a quarter and cost you the next board up.
rule('thickness-waste', 'stock', (m, c) => {
  const out = [];
  for (const p of m.parts) {
    if (!p.wood || p.props?.type === 'softwood' || p.props?.panel) continue;
    const t = p.dims[2];
    const s = hardwoodStock(t);
    if (!s?.thinner || s.waste < 0.3) continue;
    const drop = t - s.thinner.maxFinished;
    if (drop > 0.25) continue;             // too big a change to be the same part
    const saved = (boardFeetOf(p.dims[0], p.dims[1], s.rough) - boardFeetOf(p.dims[0], p.dims[1], s.thinner.rough)) * (p.count || 1);
    if (saved < 0.5) continue;           // true, but not worth a line of your attention
    out.push(finding(p, 'note', 'Costs a thicker board',
      `is ${c.f(t)} thick, so it has to come out of ${s.quarter} stock and ${c.f(s.waste)} of it becomes shavings.`,
      `Hardwood is sold by the quarter inch and priced by the board foot of the rough board, not the finished part.`,
      `Taking it to ${c.f(s.thinner.maxFinished)} puts it in ${s.thinner.quarter}, saving about ${saved.toFixed(1)} board feet${(p.count || 1) > 1 ? ` across all ${p.count}` : ''}.`));
  }
  return out;
});

// ---------- fastenings ----------

rule('hole-near-end', 'fastening', (m, c) => {
  const out = [];
  for (const p of m.parts) {
    if (!p.wood) continue;
    for (const h of p.holes || []) {
      if (!h.diameter || h.fromEnd == null) continue;
      const min = h.diameter * SCREW.minEndDistanceRatio;
      if (h.fromEnd >= min) continue;
      out.push(finding(p, 'watch', 'Hole close to the end',
        `has a ${c.f(h.diameter)} hole ${c.f(h.fromEnd)} from its end.`,
        'A bolt or screw wedges the wood apart as it tightens, and end grain splits along its length. Under about five diameters from the end there is not enough wood to hold it.',
        `Move it to ${c.f(min)} from the end, or leave the part long, drill it, and cut it to length after.`));
    }
  }
  return out;
});

// ---------- how it will be used ----------

rule('height', 'use', (m, c) => {
  const piece = m.pieceType || pieceTypeFrom(m.title);
  if (!piece) return [];
  // A seat height is the top of the seat, not the top of the piece: a chair
  // measured over its back is half a metre out.
  const seated = !!checkHeight(piece, 1)?.what?.startsWith('seat');
  const height = seated ? m.seatHeight : m.height;
  if (!(height > 0)) return [];
  const h = checkHeight(piece, height);
  if (!h || h.ok) return [];
  return [finding(null, 'watch', 'Height',
    `${seated ? `has its seat ${c.f(height)} off the ground` : `stands ${c.f(height)} tall`}, and a ${piece} is usually ${h.usual[0]}-${h.usual[1]}in.`,
    `Furniture heights are set by the body, not by taste: ${h.note || `${piece}s outside ${h.range[0]}-${h.range[1]}in are uncomfortable for most people`}.`,
    `Check the ${h.what} before you cut the legs - it is the one dimension you cannot adjust later.`)];
});

rule('short-grain', 'grain', (m, c) => {
  const out = [];
  for (const p of m.parts) {
    if (!p.wood || p.props?.moves === false) continue;
    const [len, wid] = p.dims;
    if (!(wid > len * 1.5) || len > 24) continue;
    out.push(finding(p, 'watch', 'Short grain',
      `is ${c.f(wid)} across and only ${c.f(len)} along, so the grain runs the short way.`,
      'Wood is strong along the grain and splits along it. A part whose length is its short dimension has no long fibres running end to end, and breaks where it is narrowest.',
      'Turn the part on the board so the grain runs its long way, or cut it from a wider board.'));
  }
  return out;
});

// ---------- running them ----------

function finding(part, severity, title, what, why, fix, also = []) {
  return {
    severity, title, why, fix,
    key: part?.key || null,
    name: part?.name || null,
    letter: part?.letter || '',
    text: what,
    parts: [part?.key, ...also].filter(Boolean),
  };
}

const nameOf = (p) => p?.name || 'the other part';
// "A, B and C", because a list of parts reads badly with commas alone.
const list = (names) => (names.length < 2 ? names[0] || '' : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const describeConn = (key) => (key === 'shelf-to-side' ? 'a shelf into a side' : 'a rail into a leg');

// Runs every rule over a model.
// model: { title, parts, env, tools, load, pieceType, height }
// Returns findings worst-first, each tagged with the rule and family that
// found it, plus a count per severity for the panel's heading.
export function reviewModel(model, { units = 'in16', only = null } = {}) {
  const m = {
    ...model,
    env: model.env || DEFAULT_ENV,
    byKey: new Map((model.parts || []).map((p) => [p.key, p])),
  };
  const ctx = { f: (x) => formatLength(x, units) };
  const findings = [];
  for (const r of RULES) {
    if (only && !only.includes(r.family) && !only.includes(r.id)) continue;
    let got = [];
    try {
      got = r.fn(m, ctx) || [];
    } catch {
      // A rule that trips over an odd model must never take the panel down
      // with it: the rest of the review is still worth showing.
      got = [];
    }
    for (const f of got) findings.push({ ...f, rule: r.id, family: r.family });
  }
  findings.sort((a, b) => SEVERITY[b.severity] - SEVERITY[a.severity] || a.rule.localeCompare(b.rule));
  const count = (s) => findings.filter((f) => f.severity === s).length;
  return {
    findings,
    counts: { problem: count('problem'), watch: count('watch'), note: count('note') },
    swing: mcSwing(m.env),
  };
}

export const RULE_FAMILIES = ['movement', 'joinery', 'span', 'stock', 'fastening', 'grain', 'use'];
export const ruleIds = () => RULES.map((r) => r.id);
export { JOINTS };
