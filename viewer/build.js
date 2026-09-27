// Build mode: the cut list as a step-by-step guide for the shop. One step per
// part (row), in one of two orders:
//  'assembly' - as you'd put it together: assemblies from the ground up, and
//               within one its wood parts from the bottom up (bigger parts
//               first at the same height), then its hardware
//  'cutting'  - as you'd mill it: wood grouped by species and stock
//               thickness (all the 8/4 walnut together), widest and longest
//               first, then everything else

// rows: parts in the build; boxOf(row) -> { minY, volume } of its pieces in
// the model (null when it has none); thicknessOf(row) -> rough stock
// thickness (cutting order). Returns the rows in build order.
// boards and sheet goods: the parts you cut
const cut = (r) => r.category === 'Wood' || r.category === 'Sheet goods';

export function buildOrder(rows, boxOf, mode = 'assembly', thicknessOf = (r) => r.dims[2]) {
  if (mode === 'cutting') {
    const wood = rows.filter(cut).sort((a, b) => String(a.materialLabel).localeCompare(String(b.materialLabel))
      || thicknessOf(a) - thicknessOf(b) || b.dims[1] - a.dims[1] || b.dims[0] - a.dims[0]);
    return [...wood, ...buildOrder(rows.filter((r) => !cut(r)), boxOf)];
  }
  const info = new Map(rows.map((r) => [r, boxOf(r) || { minY: Infinity, volume: 0 }]));
  const groups = new Map();
  rows.forEach((r) => {
    const g = String(r.top_group);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  });
  const lowest = (list) => Math.min(...list.map((r) => info.get(r).minY));
  const byHeight = (a, b) => {
    const ia = info.get(a), ib = info.get(b);
    const dy = ia.minY - ib.minY;
    return Math.abs(dy) > 0.25 ? dy : ib.volume - ia.volume;
  };
  return [...groups.values()]
    .sort((a, b) => lowest(a) - lowest(b) || String(a[0].groupName).localeCompare(String(b[0].groupName)))
    .flatMap((list) => [
      ...list.filter(cut).sort(byHeight),
      ...list.filter((r) => !cut(r)).sort(byHeight),
    ]);
}

// Assembly order with an "assemble" step after each sub-assembly that has
// two or more wood parts: its parts are all cut by then, so dry-fit it, then
// glue or fasten it. The step is { assemble: true, key: 'assemble:<group>',
// group, groupName, rows } in among the rows.
export function withAssemblySteps(order) {
  const out = [];
  order.forEach((r, i) => {
    out.push(r);
    const g = String(r.top_group);
    if (order[i + 1] && String(order[i + 1].top_group) === g) return; // not the group's last part
    const rows = order.filter((x) => String(x.top_group) === g);
    const woodPieces = rows.filter(cut).reduce((n, x) => n + (x.count || 1), 0);
    if (woodPieces < 2) return;
    out.push({ assemble: true, key: `assemble:${g}`, group: r.top_group, groupName: r.groupName, rows, letter: '', name: `Assemble ${r.groupName}` });
  });
  return out;
}
