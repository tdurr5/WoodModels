// Lays rough-sized parts out on boards the way you'd break lumber down in a
// shop: crosscut the board into sections, rip each section into strips, then
// crosscut parts end-to-end out of each strip (a three-stage guillotine cut,
// every cut goes all the way across). First-fit-decreasing: longest parts
// first, each into the first place it fits, else a new strip / section /
// board. Not optimal, but close for typical furniture cut lists and it always
// produces a cut sequence you can actually follow.
//
// Pure data in/out (no DOM) so it's unit-tested under Node.

// pieces: [{ id, length, width, label }] (inches, rough size)
// stock:  { length, width, kerf }
// Returns { boards: [{ length, width, oversize, sections: [{ x, length, strips: [{ y, width, parts: [{ id, label, x, y, length, width }] }] }] }], unplaced: [] }
export function packBoards(pieces, stock) {
  const { length: boardLen, width: boardWid, kerf = 0.125 } = stock;
  const sorted = [...pieces].sort((a, b) => b.length - a.length || b.width - a.width);
  const boards = [];

  const newBoard = (piece) => {
    // Parts longer/wider than stock get their own oversize board so the list
    // still tells you what to buy.
    const length = Math.max(boardLen, piece.length);
    const width = Math.max(boardWid, piece.width);
    const b = { length, width, oversize: length > boardLen || width > boardWid, sections: [], usedLength: 0 };
    boards.push(b);
    return b;
  };

  const placeInStrip = (strip, section, piece) => {
    const x = section.x + strip.usedLength;
    strip.parts.push({ id: piece.id, rowKey: piece.rowKey, label: piece.label, x, y: strip.y, length: piece.length, width: piece.width });
    strip.usedLength += piece.length + kerf;
  };

  const tryPlace = (board, piece) => {
    for (const section of board.sections) {
      if (piece.length > section.length + 1e-9) continue;
      // existing strip wide enough with room left along its length
      for (const strip of section.strips) {
        if (piece.width <= strip.width + 1e-9 && strip.usedLength + piece.length <= section.length + 1e-9) {
          placeInStrip(strip, section, piece);
          return true;
        }
      }
      // new strip ripped from what's left of the section's width
      if (section.usedWidth + piece.width <= board.width + 1e-9) {
        const strip = { y: section.usedWidth, width: piece.width, usedLength: 0, parts: [] };
        section.strips.push(strip);
        section.usedWidth += piece.width + kerf;
        placeInStrip(strip, section, piece);
        return true;
      }
    }
    // new section crosscut from what's left of the board
    if (board.usedLength + piece.length <= board.length + 1e-9 && piece.width <= board.width + 1e-9) {
      const section = { x: board.usedLength, length: piece.length, usedWidth: 0, strips: [] };
      board.sections.push(section);
      board.usedLength += piece.length + kerf;
      const strip = { y: 0, width: piece.width, usedLength: 0, parts: [] };
      section.strips.push(strip);
      section.usedWidth = piece.width + kerf;
      placeInStrip(strip, section, piece);
      return true;
    }
    return false;
  };

  for (const piece of sorted) {
    if (!(piece.length > 0 && piece.width > 0)) continue;
    if (!boards.some((b) => tryPlace(b, piece))) tryPlace(newBoard(piece), piece);
  }

  return {
    boards: boards.map((b) => ({
      length: b.length,
      width: b.width,
      oversize: b.oversize,
      sections: b.sections.map((s) => ({
        x: s.x, length: s.length,
        strips: s.strips.map((st) => ({ y: st.y, width: st.width, parts: st.parts })),
      })),
    })),
  };
}

export function boardParts(board) {
  return board.sections.flatMap((s) => s.strips.flatMap((st) => st.parts));
}

// Fraction of the board's area that ends up as (rough) parts.
export function boardYield(board) {
  const used = boardParts(board).reduce((a, p) => a + p.length * p.width, 0);
  return used / (board.length * board.width);
}

// Expand cut-list rows into individual pieces grouped by material + rough
// thickness: { key, material, thickness: {label, inches}, pieces: [...] }.
// `roughFor(row)` returns the row's rough-stock size (see format.js roughStock).
export function piecesByStock(rows, roughFor) {
  const groups = new Map();
  rows.forEach((row) => {
    const rough = roughFor(row);
    if (!rough) return;
    const key = `${row.materialLabel}|${rough.thicknessLabel}`;
    if (!groups.has(key)) {
      groups.set(key, { key, material: row.materialLabel, thicknessLabel: rough.thicknessLabel, thickness: rough.thickness, pieces: [] });
    }
    for (let i = 0; i < row.count; i++) {
      groups.get(key).pieces.push({
        id: `${row.key}#${i}`, rowKey: row.key, label: row.letter ? `${row.letter} ${row.name}` : row.name,
        length: rough.length, width: rough.width,
      });
    }
  });
  // thinnest stock first, the order you'd list it on a lumber order
  return [...groups.values()].sort((a, b) => a.material.localeCompare(b.material) || a.thickness - b.thickness);
}
