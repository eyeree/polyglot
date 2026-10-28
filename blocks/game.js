// Blocks rules. Pure: no DOM. States are treated as immutable; every action returns a new state
// (or null when the action is not allowed).
//
// state: {
//   seed, board: (type|null)[n][n], tray: (block|null)[3], side: block|null,
//   score, rotPoints, deals (trays dealt so far = turn number), nextId, over
// }
// block: { id, type: 'I'|'O'|…, rot: dealt rotation 0..3, cur: current rotation 0..3 }
// source: tray index (0..2) or 'side'
import { makeRng } from '../shared/rng.js';
import { DEFAULTS, SHAPES, SHAPE_TYPES, TRAY_SIZE } from './config.js';

// ---------------------------------------------------------------- shapes
/** Rotate a cell matrix 90° clockwise. */
export function rotate(m) {
  const hgt = m.length, w = m[0].length;
  const out = Array.from({ length: w }, () => Array(hgt).fill(0));
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) out[x][hgt - 1 - y] = m[y][x];
  return out;
}

export function rotateN(m, n) {
  let r = m;
  for (let i = 0, k = ((n % 4) + 4) % 4; i < k; i++) r = rotate(r);
  return r;
}

export function sameShape(a, b) {
  return a.length === b.length && a[0].length === b[0].length && a.every((row, y) => row.every((v, x) => !!v === !!b[y][x]));
}

/** [[dx, dy], …] of the filled cells of a matrix. */
export function cells(m) {
  const out = [];
  m.forEach((row, y) => row.forEach((v, x) => { if (v) out.push([x, y]); }));
  return out;
}

export function shapeOf(block) { return rotateN(SHAPES[block.type], block.cur); }
export function dealtShapeOf(block) { return rotateN(SHAPES[block.type], block.rot); }

/** Number of visually distinct rotations of a shape type (I/S/Z → 2, O → 1, T/J/L → 4). */
export function distinctRotations(type) {
  const seen = [];
  for (let r = 0; r < 4; r++) {
    const s = rotateN(SHAPES[type], r);
    if (!seen.some(t => sameShape(t, s))) seen.push(s);
  }
  return seen.length;
}

export function blockOf(type, rot = 0, id = 0) { return { id, type, rot, cur: rot }; }

/** Rotation points that placing this block in its current rotation would cost. A rotation that
 *  yields the same cells as the dealt one (I/S/Z by 180°, any O rotation) is free. */
export function rotationCost(block, cfg = DEFAULTS) {
  return sameShape(shapeOf(block), dealtShapeOf(block)) ? 0 : cfg.rotationCost;
}

// ---------------------------------------------------------------- board
export function emptyBoard(n) { return Array.from({ length: n }, () => Array(n).fill(null)); }

export function canPlace(board, shape, x, y) {
  const n = board.length;
  for (const [dx, dy] of cells(shape)) {
    const bx = x + dx, by = y + dy;
    if (bx < 0 || by < 0 || bx >= n || by >= n || board[by][bx] != null) return false;
  }
  return true;
}

export function fitsAnywhere(board, shape) {
  const n = board.length, w = shape[0].length, hgt = shape.length;
  for (let y = 0; y + hgt <= n; y++) for (let x = 0; x + w <= n; x++) if (canPlace(board, shape, x, y)) return true;
  return false;
}

export function fullLines(board) {
  const n = board.length, rows = [], cols = [];
  for (let i = 0; i < n; i++) {
    if (board[i].every(v => v != null)) rows.push(i);
    if (board.every(r => r[i] != null)) cols.push(i);
  }
  return { rows, cols };
}

// ---------------------------------------------------------------- blocks in tray / side
export function getBlock(state, source) { return source === 'side' ? state.side : (state.tray[source] ?? null); }

function setBlock(state, source, block) {
  if (source === 'side') return { ...state, side: block };
  const tray = state.tray.slice();
  tray[source] = block;
  return { ...state, tray };
}

/** Sources that currently hold a block: tray indices first, then 'side'. */
export function sources(state) {
  const out = [];
  state.tray.forEach((b, i) => { if (b) out.push(i); });
  if (state.side) out.push('side');
  return out;
}

export function trayCount(state) { return state.tray.filter(Boolean).length; }

export function affordableRotations(state, block, cfg = DEFAULTS) {
  const out = [];
  for (let r = 0; r < 4; r++) if (rotationCost({ ...block, cur: r }, cfg) <= state.rotPoints) out.push(r);
  return out;
}

export function blockHasMove(state, block, cfg = DEFAULTS) {
  return affordableRotations(state, block, cfg).some(r => fitsAnywhere(state.board, rotateN(SHAPES[block.type], r)));
}

/** False = game over: nothing fits (counting affordable rotations) and the turn can't be finished by stashing. */
export function anyMoves(state, cfg = DEFAULTS) {
  for (const s of sources(state)) if (blockHasMove(state, getBlock(state, s), cfg)) return true;
  return trayCount(state) === 1 && !state.side;
}

export function canPlaceBlock(state, source, x, y, cfg = DEFAULTS) {
  const b = getBlock(state, source);
  return !!b && rotationCost(b, cfg) <= state.rotPoints && canPlace(state.board, shapeOf(b), x, y);
}

/** Filled cell nearest the centre of the shape's bounding box (used for tap-to-place). */
export function anchorCell(shape) {
  const cx = (shape[0].length - 1) / 2, cy = (shape.length - 1) / 2;
  let best = null, bd = Infinity;
  for (const [x, y] of cells(shape)) {
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d < bd) { bd = d; best = [x, y]; }
  }
  return best;
}

/** Placement origin that puts the block's centre-ish cell on (tx, ty); falls back to any valid
 *  placement covering the tapped cell (nearest-to-centre first). null if none. */
export function placementAtCell(state, source, tx, ty, cfg = DEFAULTS) {
  const b = getBlock(state, source);
  if (!b) return null;
  const shape = shapeOf(b);
  const [ax, ay] = anchorCell(shape);
  if (canPlaceBlock(state, source, tx - ax, ty - ay, cfg)) return { x: tx - ax, y: ty - ay };
  const cx = (shape[0].length - 1) / 2, cy = (shape.length - 1) / 2;
  let best = null, bd = Infinity;
  for (const [dx, dy] of cells(shape)) {
    const x = tx - dx, y = ty - dy;
    if (!canPlaceBlock(state, source, x, y, cfg)) continue;
    const d = (dx - cx) ** 2 + (dy - cy) ** 2;
    if (d < bd) { bd = d; best = { x, y }; }
  }
  return best;
}

// ---------------------------------------------------------------- dealing
/** Refill the tray with TRAY_SIZE random blocks. Deterministic in (seed, deals). */
export function dealTray(state, cfg = DEFAULTS) {
  const rng = makeRng(`${state.seed}:${state.deals}`);
  let nextId = state.nextId;
  const tray = [];
  for (let i = 0; i < TRAY_SIZE; i++) {
    const type = rng.pick(SHAPE_TYPES);
    const rot = rng.int(4);
    tray.push({ id: nextId++, type, rot, cur: rot });
  }
  return { ...state, tray, deals: state.deals + 1, nextId };
}

export function newGame(seed, cfg = DEFAULTS) {
  const n = cfg.gridSize;
  let s = {
    seed, board: emptyBoard(n), tray: Array(TRAY_SIZE).fill(null), side: null,
    score: 0, rotPoints: cfg.startRotationPoints ?? 0, deals: 0, nextId: 1, over: false,
  };
  s = dealTray(s, cfg);
  s.over = !anyMoves(s, cfg);
  return s;
}

// ---------------------------------------------------------------- actions
/** Snap any block whose current rotation is no longer affordable back to its dealt orientation. */
function enforceAffordable(state, cfg) {
  const fix = (b) => (b && rotationCost(b, cfg) > state.rotPoints ? { ...b, cur: b.rot } : b);
  return { ...state, tray: state.tray.map(fix), side: fix(state.side) };
}

/** Housekeeping after an action: affordability, refill an empty tray, game-over flag. */
function settle(state, cfg) {
  let s = enforceAffordable(state, cfg);
  if (trayCount(s) === 0) s = dealTray(s, cfg);
  s.over = !anyMoves(s, cfg);
  return s;
}

/** Re-evaluate derived state after a rules change. */
export function refresh(state, cfg = DEFAULTS) { return settle(state, cfg); }

/**
 * Place the block from `source` with its top-left at (x, y).
 * -> { state, cleared: { rows, cols, cells: [[x, y, type], …] }, points: { place, clear, total, lines, cells },
 *      rotationCost, rotationPointsEarned, placedCells: [[x, y], …] } or null if not allowed.
 */
export function place(state, source, x, y, cfg = DEFAULTS) {
  const block = getBlock(state, source);
  if (!block) return null;
  const shape = shapeOf(block);
  const cost = rotationCost(block, cfg);
  if (cost > state.rotPoints) return null;
  if (!canPlace(state.board, shape, x, y)) return null;

  const n = state.board.length;
  const board = state.board.map(r => r.slice());
  const placedCells = cells(shape).map(([dx, dy]) => [x + dx, y + dy]);
  for (const [bx, by] of placedCells) board[by][bx] = block.type;

  const { rows, cols } = fullLines(board);
  const clearedCells = [];
  for (const r of rows) for (let cx = 0; cx < n; cx++) clearedCells.push([cx, r, board[r][cx]]);
  for (const c of cols) for (let cy = 0; cy < n; cy++) if (!rows.includes(cy)) clearedCells.push([c, cy, board[cy][c]]);
  for (const [cx, cy] of clearedCells) board[cy][cx] = null;

  const lines = rows.length + cols.length;
  const placePts = placedCells.length;
  const clearPts = clearedCells.length * lines * cfg.clearMultiplier;
  const earned = lines * cfg.rotationPointsPerLine;

  let next = setBlock({ ...state, board, score: state.score + placePts + clearPts, rotPoints: state.rotPoints - cost + earned }, source, null);
  next = settle(next, cfg);
  return {
    state: next,
    cleared: { rows, cols, cells: clearedCells },
    points: { place: placePts, clear: clearPts, total: placePts + clearPts, lines, cells: clearedCells.length },
    rotationCost: cost,
    rotationPointsEarned: earned,
    placedCells,
  };
}

/** Move tray block `index` to the side slot (swapping if occupied and allowed). Counts as using it. */
export function stash(state, index, cfg = DEFAULTS) {
  const b = state.tray[index];
  if (!b) return null;
  if (state.side && !cfg.allowSwap) return null;
  const tray = state.tray.slice();
  tray[index] = state.side ?? null;
  return settle({ ...state, tray, side: b }, cfg);
}

/** Rotate the block at `source` by `dir` quarter turns (preview only; cost is charged at placement).
 *  Refused (null) when the resulting rotation is unaffordable. */
export function rotateBlock(state, source, dir = 1, cfg = DEFAULTS) {
  const b = getBlock(state, source);
  if (!b) return null;
  const nb = { ...b, cur: (((b.cur + dir) % 4) + 4) % 4 };
  if (rotationCost(nb, cfg) > state.rotPoints) return null;
  return setBlock(state, source, nb);
}
