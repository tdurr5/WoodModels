// The heights and clearances furniture is built to. Not rules of taste: a
// dining chair at 21in is uncomfortable for everyone, and a bench you have to
// stoop over is why your back hurts after an hour of planing.
//
// Standard dimensions are the Highland Woodworking furniture table (the one
// most shops have taped inside a cabinet door); the pairings - 10-12in between
// a seat and the underside of a table, 42in for a bar - are the industry
// figures. Workbench height is the shop rule: wrist height for hand work,
// lower if you plane a lot, higher for joinery and carving.

// Each entry: the usual size, and the range outside which something is off.
// heights in inches.
export const PIECES = {
  'dining table': { height: [29, 30], range: [28, 31], depth: [36, 42], note: 'with a 17-18in seat, which leaves 11-12in of knee room' },
  desk: { height: [29, 30], range: [28, 31], depth: [24, 30] },
  'coffee table': { height: [17, 19], range: [15, 20], note: 'about the height of the sofa seat beside it' },
  'end table': { height: [20, 25], range: [18, 27], note: 'level with the arm of the chair' },
  'side table': { height: [20, 25], range: [18, 27] },
  'kitchen counter': { height: [36, 36], range: [34, 38] },
  bar: { height: [42, 42], range: [40, 43] },
  'dining chair': { seat: [17, 18], range: [16, 19], depth: [16, 18], width: [16, 20], back: [32, 36] },
  'side chair': { seat: [17, 18], range: [16, 19] },
  stool: { seat: [17, 18], range: [16, 19], note: 'a counter stool is 24-26in, a bar stool 29-30in' },
  'counter stool': { seat: [24, 26], range: [23, 27] },
  'bar stool': { seat: [29, 30], range: [28, 31] },
  bench: { seat: [17, 18], range: [16, 19] },
  'workbench': { height: [33, 36], range: [30, 40], note: 'wrist height with your arms at your sides: lower for planing, higher for joinery' },
  'shaving horse': { seat: [18, 22], range: [16, 24], note: 'you sit astride it with your feet on the treadle, so it rides higher than a chair' },
  bookcase: { depth: [10, 12], range: [7, 14], note: '10in for hardbacks, 7in for paperbacks' },
  'blanket chest': { height: [22, 24], range: [18, 26] },
};

// Clearances that decide whether a piece is usable.
export const CLEARANCE = {
  kneeUnderTable: [10, 12],   // seat top to the underside of the top
  seatToCounter: [10, 12],
  apronToFloor: 24,           // a table you can get your legs under
  shelfForHardbacks: 12,      // shelf opening height
  aisle: 36,
};

const WORDS = Object.keys(PIECES).sort((a, b) => b.length - a.length);

// Guess what a model is from its title, or null. Longest name wins, so
// "counter stool" beats "stool".
export function pieceTypeFrom(...names) {
  const text = ` ${names.map((n) => String(n || '').toLowerCase().replace(/[^a-z]+/g, ' ')).join(' ')} `;
  for (const w of WORDS) if (text.includes(` ${w} `)) return w;
  // A couple of near-misses worth catching.
  if (/\btable\b/.test(text)) return 'dining table';
  if (/\bchair\b/.test(text)) return 'dining chair';
  if (/\bbench\b/.test(text)) return 'bench';
  return null;
}

// Does a height suit the piece? Returns null when we have nothing to say,
// else { ok, usual, range, what }.
export function checkHeight(piece, height) {
  const p = PIECES[piece];
  if (!p || !(height > 0)) return null;
  const usual = p.height || p.seat;
  const range = p.range;
  if (!usual || !range) return null;
  return {
    ok: height >= range[0] && height <= range[1],
    usual, range, note: p.note,
    what: p.height ? 'height' : 'seat height',
  };
}
