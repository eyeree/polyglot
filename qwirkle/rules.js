// Qwirkle rules: tiles, the board, placement validation, scoring, bonus cells and the
// enumeration of every legal play for a hand. Pure: no DOM, no randomness.
import { SHAPES, COLORS, COPIES, QWIRKLE_SCORE, BONUS } from './config.js';

export const N_SHAPES = SHAPES.length;
export const N_COLORS = COLORS.length;

// ---------------------------------------------------------------- tiles
// A tile is an int 0..35: shape * 6 + colour. The bag holds 3 copies of each.
export const tile = (shape, color) => shape * N_COLORS + color;
export const shapeOf = (t) => Math.floor(t / N_COLORS);
export const colorOf = (t) => t % N_COLORS;
export const tileName = (t) => `${COLORS[colorOf(t)].id} ${SHAPES[shapeOf(t)]}`;

export function makeBag() {
  const bag = [];
  for (let s = 0; s < N_SHAPES; s++) for (let c = 0; c < N_COLORS; c++) for (let k = 0; k < COPIES; k++) bag.push(tile(s, c));
  return bag;
}

/** Two different tiles "pair" when they share exactly one attribute (so they can sit in one line). */
export function sharesOne(a, b) {
  return a !== b && (shapeOf(a) === shapeOf(b) || colorOf(a) === colorOf(b));
}

// ---------------------------------------------------------------- board
// board: Map("x,y" -> tile). Unbounded; the first tile goes on the origin.
export const key = (x, y) => x + ',' + y;
export function parseKey(k) { const i = k.indexOf(','); return { x: Number(k.slice(0, i)), y: Number(k.slice(i + 1)) }; }
export const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function boardBounds(board) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const k of board.keys()) {
    const { x, y } = parseKey(k);
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return board.size ? { minX, maxX, minY, maxY } : null;
}

/** Empty cells orthogonally adjacent to a tile (or just the origin on an empty board). */
export function anchorCells(board) {
  if (board.size === 0) return [{ x: 0, y: 0 }];
  const out = new Map();
  for (const k of board.keys()) {
    const { x, y } = parseKey(k);
    for (const [dx, dy] of DIRS) {
      const nk = key(x + dx, y + dy);
      if (!board.has(nk) && !out.has(nk)) out.set(nk, { x: x + dx, y: y + dy });
    }
  }
  return [...out.values()];
}

export function hasNeighbor(board, x, y) {
  return DIRS.some(([dx, dy]) => board.has(key(x + dx, y + dy)));
}

/** A read-only view of board + placements without copying the board. */
export function overlay(board, placements) {
  const extra = new Map();
  for (const p of placements) extra.set(key(p.x, p.y), p.tile);
  return {
    has: (k) => extra.has(k) || board.has(k),
    get: (k) => extra.has(k) ? extra.get(k) : board.get(k),
  };
}

/** Maximal contiguous run of tiles through (x,y) along (dx,dy), ordered from the low end. */
export function lineThrough(view, x, y, dx, dy) {
  let sx = x, sy = y;
  while (view.has(key(sx - dx, sy - dy))) { sx -= dx; sy -= dy; }
  const cells = [];
  while (view.has(key(sx, sy))) { cells.push({ x: sx, y: sy, tile: view.get(key(sx, sy)) }); sx += dx; sy += dy; }
  return cells;
}

// ---------------------------------------------------------------- bonus cells
function mix(a, b, c) {
  let h = (a >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ Math.imul(b | 0, 0x85ebca6b), 0xc2b2ae35) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h ^ Math.imul(c | 0, 0x27d4eb2d), 0x165667b1) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x9e3779b1) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

/**
 * Deterministic bonus for a cell: null or { id, type: 'add'|'mul', n, label, color }.
 * opts: { density (default BONUS default 0.08), kinds, safeRadius }.
 */
export function bonusAt(seed, x, y, opts = {}) {
  const density = opts.density ?? 0.08;
  const safe = opts.safeRadius ?? BONUS.safeRadius;
  if (density <= 0 || Math.abs(x) + Math.abs(y) <= safe) return null;
  const h1 = mix(seed, x, y);
  if (h1 / 4294967296 >= density) return null;
  const kinds = opts.kinds || BONUS.kinds;
  const total = kinds.reduce((s, k) => s + k.weight, 0);
  let r = (mix(h1, y, x) / 4294967296) * total;
  for (const k of kinds) { r -= k.weight; if (r < 0) return k; }
  return kinds[kinds.length - 1];
}

/** bonus lookup bound to a game seed/config. */
export function makeBonusFn(seed, opts) {
  return (x, y) => bonusAt(seed, x, y, opts);
}

// ---------------------------------------------------------------- validation
export const REASONS = {
  empty: 'Place at least one tile',
  occupied: 'That cell is already taken',
  'not-a-line': 'Tiles must be in one row or column',
  gap: 'Tiles must form one unbroken line',
  'not-connected': 'Tiles must touch tiles already on the board',
  origin: 'The first move must cover the centre cell',
  'too-long': 'A line can hold at most 6 tiles',
  duplicate: 'Duplicate tile in a line',
  mixed: 'Every tile in a line must share one colour or one shape',
  'not-in-hand': 'Those tiles are not in your hand',
  'bag-short': 'The bag does not have enough tiles for that swap',
  'pass-not-allowed': 'You can only pass when no play and no swap is possible',
  over: 'The game is over',
};
const fail = (reason) => ({ ok: false, reason, message: REASONS[reason] || reason });
const OK = { ok: true };

/** Is this sequence of tiles a valid Qwirkle line? (length 1 is trivially fine) */
export function lineCheck(tiles) {
  if (tiles.length < 2) return OK;
  if (tiles.length > N_SHAPES) return fail('too-long');
  const shapes = new Set(), colors = new Set(), seen = new Set();
  for (const t of tiles) {
    if (seen.has(t)) return fail('duplicate');
    seen.add(t); shapes.add(shapeOf(t)); colors.add(colorOf(t));
  }
  if (shapes.size === 1 && colors.size === tiles.length) return OK;
  if (colors.size === 1 && shapes.size === tiles.length) return OK;
  return fail('mixed');
}

/** Every maximal line (length ≥ 2) that contains a placed tile, deduplicated. */
export function affectedLines(view, placements) {
  const lines = [], seen = new Set();
  for (const p of placements) {
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const cells = lineThrough(view, p.x, p.y, dx, dy);
      if (cells.length < 2) continue;
      const id = key(cells[0].x, cells[0].y) + (dx ? 'h' : 'v');
      if (seen.has(id)) continue;
      seen.add(id);
      lines.push(cells);
    }
  }
  return lines;
}

/**
 * validate(board, placements) -> { ok } | { ok: false, reason, message }
 * placements: [{x, y, tile}]. Checks geometry (one line, contiguous, connected) and every affected line.
 */
export function validate(board, placements) {
  if (!placements || placements.length === 0) return fail('empty');
  const seen = new Set();
  for (const p of placements) {
    const k = key(p.x, p.y);
    if (board.has(k) || seen.has(k)) return fail('occupied');
    seen.add(k);
  }
  const sameRow = placements.every(p => p.y === placements[0].y);
  const sameCol = placements.every(p => p.x === placements[0].x);
  if (!sameRow && !sameCol) return fail('not-a-line');
  if (board.size === 0) {
    if (!placements.some(p => p.x === 0 && p.y === 0)) return fail('origin');
  } else if (!placements.some(p => hasNeighbor(board, p.x, p.y))) {
    return fail('not-connected');
  }
  const view = overlay(board, placements);
  if (placements.length > 1) {
    const horiz = sameRow;
    const coords = placements.map(p => horiz ? p.x : p.y);
    const lo = Math.min(...coords), hi = Math.max(...coords);
    for (let i = lo; i <= hi; i++) {
      if (!view.has(horiz ? key(i, placements[0].y) : key(placements[0].x, i))) return fail('gap');
    }
  }
  for (const cells of affectedLines(view, placements)) {
    const r = lineCheck(cells.map(c => c.tile));
    if (!r.ok) return r;
  }
  return OK;
}

// ---------------------------------------------------------------- scoring
/**
 * scoreMove(board, placements, bonusFn?, bonusMode?) -> breakdown
 * { lines: [{cells, len, points, qwirkle, mul}], base, adds, muls, bonuses, total }
 * base = Σ line points × line multipliers (or 1 per tile if the move forms no line — first move only);
 * total = base × move multiplier + adds.
 */
export function scoreMove(board, placements, bonusFn = null, bonusMode = 'line') {
  const view = overlay(board, placements);
  const lines = affectedLines(view, placements).map(cells => ({
    cells, len: cells.length, points: cells.length === N_SHAPES ? QWIRKLE_SCORE : cells.length, qwirkle: cells.length === N_SHAPES, mul: 1,
  }));
  const bonuses = [];
  let adds = 0, muls = 1;
  if (bonusFn) {
    for (const p of placements) {
      const b = bonusFn(p.x, p.y);
      if (!b) continue;
      bonuses.push({ x: p.x, y: p.y, id: b.id, type: b.type, n: b.n, label: b.label });
      if (b.type === 'add') adds += b.n;
      else if (bonusMode === 'move') muls *= b.n;
      else for (const l of lines) if (l.cells.some(c => c.x === p.x && c.y === p.y)) l.mul *= b.n;
    }
  }
  const base = lines.length ? lines.reduce((s, l) => s + l.points * l.mul, 0) : placements.length;
  return { lines, base, adds, muls, bonuses, total: base * muls + adds };
}

// ---------------------------------------------------------------- enumeration
/** Canonical identity of a play (order-independent). */
export function playKey(placements) {
  return placements.map(p => `${p.x},${p.y}:${p.tile}`).sort().join('|');
}

function nextEmpty(view, x, y, dx, dy) {
  do { x += dx; y += dy; } while (view.has(key(x, y)));
  return { x, y };
}

/**
 * legalPlacements(board, hand) -> [placements[]]: every legal play (as a list of {x,y,tile}) for this hand.
 * Anchors are empty cells next to a tile; from an anchor each distinct tile is tried, then the line is
 * grown along each axis — first towards +∞, then towards −∞ (so each cell set is generated once per
 * anchor) — skipping over existing tiles and validating every step. Deduplicated by playKey.
 */
export function legalPlacements(board, hand) {
  const out = new Map();
  const distinct = [...new Set(hand)];
  const anchors = anchorCells(board);
  const remove = (arr, t) => { const i = arr.indexOf(t); const c = arr.slice(); c.splice(i, 1); return c; };

  const grow = (placements, rest, dx, dy, allowPos) => {
    if (rest.length === 0) return;
    const view = overlay(board, placements);
    let lo = placements[0], hi = placements[0];
    for (const p of placements) {
      if (dx ? p.x < lo.x : p.y < lo.y) lo = p;
      if (dx ? p.x > hi.x : p.y > hi.y) hi = p;
    }
    const ends = [];
    if (allowPos) ends.push({ cell: nextEmpty(view, hi.x, hi.y, dx, dy), pos: true });
    ends.push({ cell: nextEmpty(view, lo.x, lo.y, -dx, -dy), pos: false });
    for (const t of new Set(rest)) {
      for (const e of ends) {
        const next = [...placements, { x: e.cell.x, y: e.cell.y, tile: t }];
        if (!validate(board, next).ok) continue;
        const k = playKey(next);
        if (!out.has(k)) out.set(k, next);
        grow(next, remove(rest, t), dx, dy, e.pos);
      }
    }
  };

  for (const a of anchors) {
    for (const t of distinct) {
      const first = [{ x: a.x, y: a.y, tile: t }];
      if (!validate(board, first).ok) continue;
      out.set(playKey(first), first);
      const rest = remove(hand, t);
      grow(first, rest, 1, 0, true);
      grow(first, rest, 0, 1, true);
    }
  }
  return [...out.values()];
}

export function hasAnyPlay(board, hand) {
  // cheap check: a single tile somewhere is enough for "a play exists"
  const distinct = [...new Set(hand)];
  for (const a of anchorCells(board)) for (const t of distinct) if (validate(board, [{ x: a.x, y: a.y, tile: t }]).ok) return true;
  return false;
}
