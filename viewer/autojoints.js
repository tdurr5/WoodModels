// Conservative contact-driven joinery. Explicit joints win; automatic joints
// are resolved afresh from placements so moving a board never leaves old cuts.
import { instanceBasis } from './design.js';
import { tenonFor, dadoFor } from './joinery.js';
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const add = (a, b, k = 1) => a.map((v, i) => v + b[i] * k);
export const jointKey = (j) => `${j.from}:${j.fromInstance ?? '*'}:${j.end ?? '*'}:${j.into}:${j.intoInstance ?? '*'}`;
function choices(design, joints) {
  return joints.map((j) => {
    const type = design.jointChoices?.[jointKey(j)];
    return type && type !== j.type ? { ...j, type, tenon: undefined } : j;
  });
}
export function resolvedJoints(design) {
  const explicit = (design.joints || []).filter((j) => !j.automatic);
  if (design.autoJoinery !== true) return choices(design, explicit);
  const pieces = (design.parts || []).flatMap((part) => part.instances.map((inst, index) => ({ part, inst, index, basis: instanceBasis(inst), at: inst.at || [0, 0, 0] })));
  const joints = [...explicit], tolerance = 1 / 64;
  for (const a of pieces) for (const end of [0, 1]) {
    if (explicit.some((j) => j.from === a.part.id && (j.fromInstance == null || j.fromInstance === a.index) && (j.end ?? 0) === end)) continue;
    const tip = add(a.at, a.basis[0], (end ? 1 : -1) * a.part.size[0] / 2);
    for (const b of pieces) {
      if (a.part === b.part || explicit.some((j) => j.from === b.part.id && j.into === a.part.id)) continue;
      const axis = b.basis.findIndex((v) => Math.abs(dot(a.basis[0], v)) > 0.999);
      if (axis < 1) continue; // end-to-side only; not edge glue or end-to-end
      const local = b.basis.map((v) => dot(sub(tip, b.at), v));
      const separation = Math.abs(local[axis]) - b.part.size[axis] / 2;
      if (Math.abs(separation) > tolerance) continue;
      const fits = b.basis.every((v, i) => i === axis || Math.abs(local[i]) + Math.abs(dot(a.basis[1], v))*a.part.size[1]/2 + Math.abs(dot(a.basis[2], v))*a.part.size[2]/2 <= b.part.size[i]/2 + tolerance);
      if (!fits) continue;
      // A post supporting a slab is a bearing contact, not an inferred socket.
      if (Math.abs(a.basis[0][1]) > 0.98 && a.part.size[1] < a.part.size[2] * 2 && b.part.size[1] > b.part.size[2] * 3) continue;
      const housing = b.part.size[1] > b.part.size[2] * 3 && a.part.size[1] > a.part.size[2] * 2;
      const type = design.joineryStyle === 'dado' ? 'dado' : design.joineryStyle === 'mortise-tenon' ? 'mortise-tenon' : design.joineryStyle === 'dovetail' ? 'dovetail' : housing ? 'dado' : 'mortise-tenon';
      const depth = Math.min(dadoFor(b.part.size[axis]).depth, b.part.size[axis] / 3);
      const tenon = tenonFor({ railThickness: a.part.size[2], railWidth: a.part.size[1], intoThickness: b.part.size[axis] });
      tenon.length = Math.min(tenon.length, b.part.size[axis] / 2 - 1 / 32);
      if (tenon.length <= 0 || depth <= 0) continue;
      joints.push({ from: a.part.id, fromInstance: a.index, end, into: b.part.id, intoInstance: b.index,
        type, automatic: true, ...(type === 'dado' ? { extension: depth + separation } : { tenon }) });
      break;
    }
  }
  // Coplanar crossing rails: complementary half-laps, never two full overlaps.
  if (!design.joineryStyle || design.joineryStyle === 'auto') for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) {
    const a = pieces[i], b = pieces[j];
    if (a.part === b.part || explicit.some((q) => [q.from, q.into].includes(a.part.id) && [q.from, q.into].includes(b.part.id))) continue;
    if (Math.abs(dot(a.basis[0], b.basis[0])) > 0.001 || Math.abs(dot(a.basis[2], b.basis[2])) < 0.999) continue;
    if (a.part.size[0] < 2*a.part.size[1] || b.part.size[0] < 2*b.part.size[1]) continue;
    if (Math.abs(a.part.size[2]-b.part.size[2]) > tolerance || Math.abs(dot(sub(a.at,b.at),a.basis[2])) > tolerance) continue;
    const crosses = [a,b].every((p,k) => Math.abs(dot(sub([b,a][k].at,p.at),p.basis[0])) + [b,a][k].part.size[1]/2 < p.part.size[0]/2 - tolerance);
    if (crosses) joints.push({ from: a.part.id, fromInstance:a.index, into:b.part.id, intoInstance:b.index, type:'half-lap', automatic:true });
  }
  return choices(design, joints);
}
