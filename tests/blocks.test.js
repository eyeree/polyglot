import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, SHAPES, SHAPE_TYPES, TRAY_SIZE } from '../blocks/config.js';
import * as G from '../blocks/game.js';

const cfg = (over = {}) => ({ ...DEFAULTS, ...over });
const N = 10;

/** Build a state by hand. `fill` is a list of [x, y] cells (or a predicate) to fill with 'X'. */
function mk({ n = N, fill = [], tray = [null, null, null], side = null, rotPoints = 0, score = 0 } = {}) {
  const board = G.emptyBoard(n);
  if (typeof fill === 'function') { for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (fill(x, y)) board[y][x] = 'X'; }
  else for (const [x, y] of fill) board[y][x] = 'X';
  const t = tray.slice(); while (t.length < TRAY_SIZE) t.push(null);
  return { seed: 1, board, tray: t, side, score, rotPoints, deals: 1, nextId: 100, over: false };
}
const count = (board) => board.flat().filter(Boolean).length;

// ---------------------------------------------------------------- shapes
test('every shape rotates through 4 rotations back to itself and keeps its cell count', () => {
  for (const t of SHAPE_TYPES) {
    const s = SHAPES[t];
    const cells0 = G.cells(s).length;
    let r = s;
    for (let i = 1; i <= 4; i++) {
      r = G.rotate(r);
      assert.equal(G.cells(r).length, cells0, `${t} rotation ${i} keeps ${cells0} cells`);
      assert.deepEqual(r, G.rotateN(s, i), `${t} rotateN(${i}) matches repeated rotate`);
    }
    assert.deepEqual(r, s, `${t} returns to itself after 4 rotations`);
  }
});

test('rotation is clockwise and symmetric shapes collapse', () => {
  assert.deepEqual(G.rotate([[1, 1, 1, 1]]), [[1], [1], [1], [1]]);
  assert.deepEqual(G.rotate(SHAPES.T), [[0, 1], [1, 1], [0, 1]]);
  assert.deepEqual(G.rotate(SHAPES.J), [[1, 1], [1, 0], [1, 0]]);
  assert.deepEqual(G.rotate(SHAPES.L), [[1, 0], [1, 0], [1, 1]]);
  assert.equal(G.distinctRotations('I'), 2);
  assert.equal(G.distinctRotations('O'), 1);
  assert.equal(G.distinctRotations('S'), 2);
  assert.equal(G.distinctRotations('Z'), 2);
  for (const t of ['T', 'J', 'L']) assert.equal(G.distinctRotations(t), 4, t);
  assert.ok(G.sameShape(G.rotateN(SHAPES.I, 2), SHAPES.I));
  assert.ok(G.sameShape(G.rotateN(SHAPES.S, 2), SHAPES.S));
  assert.ok(!G.sameShape(G.rotateN(SHAPES.T, 2), SHAPES.T));
});

// ---------------------------------------------------------------- placement
test('canPlace enforces bounds and overlap', () => {
  const b = G.emptyBoard(N);
  assert.ok(G.canPlace(b, SHAPES.I, 0, 0));
  assert.ok(G.canPlace(b, SHAPES.I, 6, 9));
  assert.ok(!G.canPlace(b, SHAPES.I, 7, 0), 'runs off the right edge');
  assert.ok(!G.canPlace(b, SHAPES.I, -1, 0), 'negative x');
  assert.ok(!G.canPlace(b, SHAPES.I, 0, 10), 'below the board');
  assert.ok(!G.canPlace(b, G.rotate(SHAPES.I), 0, 7), 'vertical I off the bottom');
  b[0][2] = 'X';
  assert.ok(!G.canPlace(b, SHAPES.I, 0, 0), 'overlaps a filled cell');
  assert.ok(G.canPlace(b, SHAPES.I, 3, 0));
  // T's empty corners don't collide
  b[1][0] = 'X'; b[1][2] = 'X';
  assert.ok(!G.canPlace(b, SHAPES.T, 0, 0), 'top row blocked by (2,0)');
  b[0][2] = null;
  assert.ok(G.canPlace(b, SHAPES.T, 0, 0), 'corners under the T are filled but unused');
});

test('fitsAnywhere scans every origin', () => {
  const full = G.emptyBoard(4).map(r => r.map(() => 'X'));
  assert.ok(!G.fitsAnywhere(full, SHAPES.O));
  full[3][3] = null; full[2][3] = null;
  assert.ok(!G.fitsAnywhere(full, SHAPES.O));
  full[3][2] = null; full[2][2] = null;
  assert.ok(G.fitsAnywhere(full, SHAPES.O));
});

// ---------------------------------------------------------------- clearing & scoring
test('placing clears a full row and scores place + cells×lines×multiplier', () => {
  // row 0 full except x 0..3; horizontal I completes it
  const s = mk({ fill: (x, y) => y === 0 && x >= 4, tray: [G.blockOf('I', 0, 1)] });
  const res = G.place(s, 0, 0, 0);
  assert.ok(res);
  assert.deepEqual(res.cleared.rows, [0]);
  assert.deepEqual(res.cleared.cols, []);
  assert.equal(res.cleared.cells.length, 10);
  assert.equal(res.points.place, 4);
  assert.equal(res.points.clear, 10 * 1 * 2);
  assert.equal(res.points.total, 24);
  assert.equal(res.state.score, 24);
  assert.equal(res.state.rotPoints, 1, '+1 rotation point per line');
  assert.equal(count(res.state.board), 0, 'row emptied');
  assert.equal(count(s.board), 6, 'original state untouched');
});

test('placing clears a full column', () => {
  const s = mk({ fill: (x, y) => x === 0 && y >= 4, tray: [G.blockOf('I', 1, 1)] });
  const res = G.place(s, 0, 0, 0);
  assert.ok(res);
  assert.deepEqual(res.cleared.rows, []);
  assert.deepEqual(res.cleared.cols, [0]);
  assert.equal(res.points.clear, 20);
  assert.equal(count(res.state.board), 0);
});

test('simultaneous row + column counts the shared cell once', () => {
  // row 9 full except x 0..2, column 0 full except y 8..9; J at (0,8) covers (0,8),(0,9),(1,9),(2,9)
  const s = mk({ fill: (x, y) => (y === 9 && x >= 3) || (x === 0 && y <= 7), tray: [G.blockOf('J', 0, 1)], rotPoints: 0 });
  assert.ok(G.canPlace(s.board, SHAPES.J, 0, 8));
  const res = G.place(s, 0, 0, 8, cfg());
  assert.ok(res);
  assert.deepEqual(res.cleared.rows, [9]);
  assert.deepEqual(res.cleared.cols, [0]);
  assert.equal(res.cleared.cells.length, 19, '10 + 10 − 1 shared');
  assert.equal(res.points.lines, 2);
  assert.equal(res.points.clear, 19 * 2 * 2);
  assert.equal(res.state.score, 4 + 76);
  assert.equal(res.state.rotPoints, 2);
  assert.equal(count(res.state.board), 0);
  // multiplier and points-per-line come from cfg
  const res3 = G.place(s, 0, 0, 8, cfg({ clearMultiplier: 3, rotationPointsPerLine: 2 }));
  assert.equal(res3.points.clear, 19 * 2 * 3);
  assert.equal(res3.state.rotPoints, 4);
});

test('placement without a clear scores the block size only', () => {
  const s = mk({ tray: [G.blockOf('O', 0, 1), G.blockOf('T', 0, 2), null] });
  const res = G.place(s, 1, 3, 3);
  assert.equal(res.points.total, 4);
  assert.equal(res.points.lines, 0);
  assert.deepEqual(res.placedCells, [[3, 3], [4, 3], [5, 3], [4, 4]]);
  assert.equal(res.state.tray[1], null);
  assert.equal(res.state.tray[0].type, 'O', 'other tray block kept');
  assert.equal(G.place(s, 2, 0, 0), null, 'empty source');
  assert.equal(G.place(s, 1, 8, 0), null, 'out of bounds');
});

// ---------------------------------------------------------------- rotation points
test('rotation preview is refused when unaffordable and free back to the dealt orientation', () => {
  const s0 = mk({ tray: [G.blockOf('T', 0, 1)], rotPoints: 0 });
  assert.equal(G.rotateBlock(s0, 0, 1), null, 'no points: cannot rotate');
  const s2 = { ...s0, rotPoints: 2 };
  const r1 = G.rotateBlock(s2, 0, 1);
  assert.ok(r1);
  assert.equal(r1.tray[0].cur, 1);
  assert.equal(r1.tray[0].rot, 0, 'dealt rotation remembered');
  assert.equal(G.rotationCost(r1.tray[0]), 2);
  const r2 = G.rotateBlock(r1, 0, 1);
  assert.equal(r2.tray[0].cur, 2);
  assert.equal(G.rotationCost(r2.tray[0]), 2, 'flat cost, not per quarter turn');
  const back = G.rotateBlock(r1, 0, -1);
  assert.equal(back.tray[0].cur, 0);
  assert.equal(G.rotationCost(back.tray[0]), 0);
  // a 180° I is the same shape as dealt → free; 90° costs
  const i0 = mk({ tray: [G.blockOf('I', 0, 1)], rotPoints: 2 });
  assert.equal(G.rotationCost({ ...i0.tray[0], cur: 2 }), 0);
  assert.equal(G.rotationCost({ ...i0.tray[0], cur: 1 }), 2);
  assert.equal(G.rotationCost(G.blockOf('O', 0, 1)), 0);
  assert.deepEqual(G.affordableRotations(mk({ rotPoints: 0 }), G.blockOf('I', 0)), [0, 2]);
  assert.deepEqual(G.affordableRotations(mk({ rotPoints: 2 }), G.blockOf('I', 0)), [0, 1, 2, 3]);
});

test('placing a rotated block charges the cost once; earned points are added after', () => {
  let s = mk({ tray: [G.blockOf('T', 0, 1), G.blockOf('O', 0, 2)], rotPoints: 3 });
  s = G.rotateBlock(s, 0, 1);
  const res = G.place(s, 0, 0, 0);
  assert.equal(res.rotationCost, 2);
  assert.equal(res.state.rotPoints, 1);
  assert.equal(res.state.score, 4);
  // placing in the dealt rotation is free
  const free = G.place(mk({ tray: [G.blockOf('T', 3, 1)], rotPoints: 0 }), 0, 0, 0);
  assert.equal(free.rotationCost, 0);
  // can't place a rotated block the player can no longer afford
  const broke = { ...s, rotPoints: 1 };
  assert.equal(G.place(broke, 0, 0, 0), null);
  assert.ok(!G.canPlaceBlock(broke, 0, 0, 0));
  // accrual: clearing a row while rotated nets −2 +1
  const row = mk({ fill: (x, y) => y === 0 && x >= 4, tray: [G.blockOf('I', 1, 1), G.blockOf('O', 0, 2)], rotPoints: 2 });
  const rr = G.place(G.rotateBlock(row, 0, 1), 0, 0, 0);
  assert.equal(rr.rotationCost, 2);
  assert.equal(rr.rotationPointsEarned, 1);
  assert.equal(rr.state.rotPoints, 1);
});

test('after points are spent, other previewed rotations that became unaffordable snap back', () => {
  let s = mk({ tray: [G.blockOf('T', 0, 1), G.blockOf('L', 0, 2)], rotPoints: 2 });
  s = G.rotateBlock(s, 0, 1);
  s = G.rotateBlock(s, 1, 1);
  assert.equal(s.tray[1].cur, 1);
  const res = G.place(s, 0, 0, 0);
  assert.equal(res.state.rotPoints, 0);
  assert.equal(res.state.tray[1].cur, 0, 'L snapped back to its dealt orientation');
});

// ---------------------------------------------------------------- dealing
test('newGame deals 3 blocks deterministically from the seed', () => {
  const a = G.newGame(42), b = G.newGame(42), c = G.newGame(43);
  assert.equal(a.board.length, 10);
  assert.equal(a.tray.length, 3);
  assert.ok(a.tray.every(bl => bl && SHAPE_TYPES.includes(bl.type) && bl.rot >= 0 && bl.rot < 4 && bl.cur === bl.rot));
  assert.equal(a.deals, 1);
  assert.equal(a.side, null);
  assert.equal(a.over, false);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.tray, c.tray);
  assert.equal(G.newGame(1, cfg({ gridSize: 8 })).board.length, 8);
  assert.equal(new Set(a.tray.map(t => t.id)).size, 3, 'unique ids');
  // many deals, all types appear and all rotations appear
  const seen = new Set(), rots = new Set();
  let s = G.newGame(7);
  for (let i = 0; i < 40; i++) { s.tray.forEach(t => { seen.add(t.type); rots.add(t.rot); }); s = G.dealTray(s); }
  assert.equal(seen.size, SHAPE_TYPES.length);
  assert.equal(rots.size, 4);
});

test('the next 3 arrive only after all 3 are used', () => {
  let s = G.newGame(5);
  const ids = s.tray.map(t => t.id);
  const placeFirst = (st) => {
    const i = st.tray.findIndex(Boolean);
    const b = st.tray[i];
    const shape = G.shapeOf(b);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) if (G.canPlace(st.board, shape, x, y)) return G.place(st, i, x, y).state;
    throw new Error('no fit');
  };
  s = placeFirst(s);
  assert.equal(G.trayCount(s), 2); assert.equal(s.deals, 1);
  s = placeFirst(s);
  assert.equal(G.trayCount(s), 1); assert.equal(s.deals, 1);
  assert.ok(s.tray.some(t => t && ids.includes(t.id)), 'remaining block is from the first deal');
  s = placeFirst(s);
  assert.equal(G.trayCount(s), 3, 'refilled');
  assert.equal(s.deals, 2);
  assert.ok(s.tray.every(t => !ids.includes(t.id)), 'all new blocks');
  assert.equal(count(s.board), 12);
});

// ---------------------------------------------------------------- stash / swap
test('stash moves a tray block to the side slot and counts as using it', () => {
  const s = mk({ tray: [G.blockOf('T', 0, 1), G.blockOf('O', 0, 2), G.blockOf('I', 0, 3)] });
  const a = G.stash(s, 1);
  assert.equal(a.tray[1], null);
  assert.equal(a.side.type, 'O');
  assert.equal(a.deals, 1, 'tray not empty yet, no new deal');
  assert.equal(G.stash(a, 1), null, 'empty slot');
  // swap when occupied
  const b = G.stash(a, 0);
  assert.equal(b.side.type, 'T');
  assert.equal(b.tray[0].type, 'O', 'old side block comes back to the tray slot');
  assert.equal(G.trayCount(b), 2);
  // swap disabled
  assert.equal(G.stash(a, 0, cfg({ allowSwap: false })), null);
  // stashing the last tray block completes the turn → new deal
  const last = mk({ tray: [null, null, G.blockOf('I', 0, 3)] });
  const c = G.stash(last, 2);
  assert.equal(c.side.type, 'I');
  assert.equal(c.deals, 2);
  assert.equal(G.trayCount(c), 3);
});

test('the side block can be placed on any turn and its rotation costs apply', () => {
  const s = mk({ tray: [G.blockOf('T', 0, 1)], side: G.blockOf('L', 0, 9), rotPoints: 2 });
  const r = G.rotateBlock(s, 'side', 1);
  assert.equal(r.side.cur, 1);
  const res = G.place(r, 'side', 0, 0);
  assert.ok(res);
  assert.equal(res.state.side, null);
  assert.equal(res.rotationCost, 2);
  assert.equal(res.state.rotPoints, 0);
  assert.equal(G.trayCount(res.state), 1, 'placing the side block does not use a tray slot');
  assert.equal(res.state.deals, 1);
});

// ---------------------------------------------------------------- game over
test('game over when nothing fits and the turn cannot be finished by stashing', () => {
  const almostFull = (x, y) => !(x === 9 && y === 9); // one free cell
  // 3 tray blocks, nothing fits → over
  assert.equal(G.anyMoves(mk({ fill: almostFull, tray: [G.blockOf('T'), G.blockOf('O'), G.blockOf('I')] })), false);
  // 2 tray blocks, side empty → over (stashing one leaves one that doesn't fit)
  assert.equal(G.anyMoves(mk({ fill: almostFull, tray: [G.blockOf('T'), G.blockOf('O')] })), false);
  // exactly 1 tray block + empty side → NOT over (stash finishes the turn)
  assert.equal(G.anyMoves(mk({ fill: almostFull, tray: [null, G.blockOf('T'), null] })), true);
  // exactly 1 tray block + occupied side → over
  assert.equal(G.anyMoves(mk({ fill: almostFull, tray: [null, G.blockOf('T'), null], side: G.blockOf('O') })), false);
  // the side block fitting rescues
  const gap = (x, y) => !(y === 9 && x >= 6); // 4 free cells in a row
  assert.equal(G.anyMoves(mk({ fill: gap, tray: [G.blockOf('T'), G.blockOf('O')], side: G.blockOf('I', 0) })), true);
  // the exact test agrees in all of these
  assert.equal(G.canFinishTurn(mk({ fill: almostFull, tray: [G.blockOf('T'), G.blockOf('O'), G.blockOf('I')] })), false);
  assert.equal(G.canFinishTurn(mk({ fill: almostFull, tray: [G.blockOf('T'), G.blockOf('O')] })), false);
  assert.equal(G.canFinishTurn(mk({ fill: almostFull, tray: [null, G.blockOf('T'), null] })), true);
  assert.equal(G.canFinishTurn(mk({ fill: almostFull, tray: [null, G.blockOf('T'), null], side: G.blockOf('O') })), false);
  assert.equal(G.canFinishTurn(mk({ fill: gap, tray: [G.blockOf('T'), G.blockOf('O')], side: G.blockOf('I', 0) })), true, 'the side I completes row 9 (and the full columns) → everything clears');
});

// ---------------------------------------------------------------- exact game-over (turn look-ahead)
test('game over is detected as soon as the turn cannot be finished, not after the last block that fits', () => {
  // Isolated single holes on the diagonal keep every row and column from clearing; one T-shaped pocket.
  const holes = new Set();
  for (let i = 0; i < 10; i++) holes.add(`${i},${i}`);
  for (const c of ['5,1', '6,1', '7,1', '6,2']) holes.add(c);
  const fill = (x, y) => !holes.has(`${x},${y}`);
  const s = mk({ fill, tray: [G.blockOf('T', 0, 1), G.blockOf('O', 0, 2), null], side: G.blockOf('I', 0, 3), rotPoints: 0 });
  assert.ok(G.blockHasMove(s, s.tray[0]), 'T fits in the pocket');
  assert.ok(!G.blockHasMove(s, s.tray[1]) && !G.blockHasMove(s, s.side), 'O and I fit nowhere');
  assert.equal(G.anyMoves(s), true, 'a move exists…');
  assert.equal(G.canFinishTurn(s), false, '…but after it O and the side I both still need homes and have none');
  assert.equal(G.refresh(s).over, true);
  // with the side slot empty the lone leftover can be stashed → still playable
  assert.equal(G.canFinishTurn({ ...s, side: null }), true);
  // T plus the side I only (no O): place T, keep I → playable
  assert.equal(G.canFinishTurn({ ...s, tray: [s.tray[0], null, null] }), true);
  // and playing it out confirms the dead end
  const res = G.place(s, 0, 5, 1);
  assert.equal(res.points.lines, 0);
  assert.equal(res.state.over, true);
});

test('a clear mid-turn can make room and pay for a rotation; the search accounts for both', () => {
  // Every row/column keeps an isolated hole so nothing clears by accident, except row 9 (x 6..9 free)
  // which the horizontal I completes. Row 8 has (0,8) and (1,8) free.
  const holes = new Set(['2,0', '7,1', '3,2', '8,3', '4,4', '9,5', '5,6', '6,7', '0,8', '1,8', '6,9', '7,9', '8,9', '9,9']);
  const fill = (x, y) => !holes.has(`${x},${y}`);
  const base = mk({ fill, tray: [G.blockOf('I', 0, 1), G.blockOf('O', 0, 2), null], side: G.blockOf('L', 0, 3), rotPoints: 0 });
  assert.ok(!G.blockHasMove(base, base.tray[1]), 'O has no 2×2 yet');
  assert.ok(!G.blockHasMove(base, base.side), 'L fits nowhere');
  assert.equal(G.canFinishTurn(base), true, 'I clears row 9, then O fits at (0,8); L stays in the side slot');
  const r1 = G.place(base, 0, 6, 9);
  assert.deepEqual(r1.cleared.rows, [9]);
  assert.deepEqual(r1.cleared.cols, []);
  assert.equal(r1.state.over, false);
  assert.ok(G.canPlace(r1.state.board, SHAPES.O, 0, 8));
  // T instead of O: as dealt it never fits; rotated 180° it fits after the clear, if affordable.
  const withT = { ...base, tray: [G.blockOf('I', 0, 1), G.blockOf('T', 0, 2), null] };
  assert.equal(G.canFinishTurn(withT, cfg({ rotationCost: 2 })), false, 'the clear earns 1 point, the rotation costs 2');
  assert.equal(G.canFinishTurn(withT, cfg({ rotationCost: 1 })), true, 'a 1-point rotation is paid for by the clear');
  assert.equal(G.canFinishTurn({ ...withT, rotPoints: 2 }), true, 'or by points already banked');
  assert.equal(G.refresh(withT).over, true);
});

test('blockFitsNow vs blockHasMove drive the greying', () => {
  const colGap = (x, y) => !(x === 9 && y >= 6); // vertical 4-cell gap only
  const s = mk({ fill: colGap, tray: [G.blockOf('I', 0, 1), G.blockOf('O', 0, 2)], rotPoints: 2 });
  assert.equal(G.blockFitsNow(s, s.tray[0]), false, 'horizontal I does not fit as shown');
  assert.equal(G.blockHasMove(s, s.tray[0]), true, 'but it can be rotated for 2 points');
  assert.equal(G.blockHasMove({ ...s, rotPoints: 1 }, s.tray[0]), false, 'not when unaffordable');
  assert.equal(G.blockHasMove(s, s.tray[1]), false, 'O never fits here');
  assert.deepEqual(G.placeableShapes(G.blockOf('I', 0), 0).map(p => p.cost), [0]);
  assert.deepEqual(G.placeableShapes(G.blockOf('I', 0), 2).map(p => p.cost), [0, 2]);
  const ps = G.placeableShapes(G.blockOf('T', 1), 2);
  assert.equal(ps.length, 4);
  assert.deepEqual(ps.filter(p => p.cost === 0).map(p => p.rot), [1], 'only the dealt rotation is free');
});

test('rotation points carry into the next game', () => {
  const a = G.newGame(3, cfg(), 5);
  assert.equal(a.rotPoints, 5);
  assert.equal(a.score, 0);
  assert.equal(G.newGame(3, cfg({ startRotationPoints: 1 }), 5).rotPoints, 6);
  assert.equal(G.newGame(3).rotPoints, 0);
  assert.equal(G.newGame(3, cfg(), -2).rotPoints, 0, 'never negative');
  assert.ok(G.rotateBlock(a, 0, 1), 'carried points are usable at once');
});

test('game over counts only rotations the player can afford', () => {
  const colGap = (x, y) => !(x === 9 && y >= 6); // vertical 4-cell gap
  const horizI = mk({ fill: colGap, tray: [G.blockOf('I', 0), G.blockOf('O')], rotPoints: 0 });
  assert.equal(G.anyMoves(horizI), false, 'I dealt horizontal, no points');
  assert.equal(G.anyMoves({ ...horizI, rotPoints: 2 }), true, 'can afford to rotate the I');
  assert.equal(G.anyMoves({ ...horizI, rotPoints: 1 }), false);
  assert.equal(G.anyMoves({ ...horizI, rotPoints: 1 }, cfg({ rotationCost: 1 })), true, 'cheaper rotation');
});

test('1 tray block + empty side after a placement is not game over, then stashing may end it', () => {
  // Holes: isolated singles on the diagonal + a 4-wide strip at row 9 (x 5..8). Every row and column
  // keeps a hole so nothing clears; only the I fits (in the strip), the T fits nowhere.
  const holes = new Set(['0,8', '8,0', '9,0', '0,9', '5,9', '6,9', '7,9', '8,9']);
  for (let i = 0; i < 8; i++) holes.add(`${i},${i}`);
  const fill = (x, y) => !holes.has(`${x},${y}`);
  const s = mk({ fill, tray: [G.blockOf('T'), G.blockOf('I', 0), null], rotPoints: 0 });
  assert.ok(!G.blockHasMove(s, s.tray[0]), 'T fits nowhere');
  const res = G.place(s, 1, 5, 9);
  assert.ok(res);
  assert.equal(res.points.lines, 0, 'nothing cleared');
  assert.equal(G.trayCount(res.state), 1);
  assert.equal(res.state.over, false, 'lone T with an empty side slot: the turn can be finished by stashing');
  const st = G.stash(res.state, 0);
  assert.equal(st.side.type, 'T');
  assert.equal(st.deals, 2, 'stashing the last tray block dealt a new tray');
  assert.equal(st.over, true, 'new tetrominoes cannot fit isolated holes');
  // refresh() recomputes the flag when rules change
  const horizI = mk({ fill: (x, y) => !(x === 9 && y >= 6), tray: [G.blockOf('I', 0), G.blockOf('O')], rotPoints: 1 });
  assert.equal(G.refresh(horizI).over, true);
  assert.equal(G.refresh(horizI, cfg({ rotationCost: 1 })).over, false);
});

// ---------------------------------------------------------------- tap-to-place helper
test('placementAtCell centres the block on the tapped cell and falls back to a covering placement', () => {
  const s = mk({ tray: [G.blockOf('I', 0, 1), G.blockOf('T', 0, 2)] });
  assert.deepEqual(G.anchorCell(SHAPES.I), [1, 0]);
  assert.deepEqual(G.anchorCell(SHAPES.T), [1, 0]);
  assert.deepEqual(G.anchorCell(SHAPES.J), [1, 1]);
  assert.deepEqual(G.placementAtCell(s, 0, 5, 5), { x: 4, y: 5 });
  assert.deepEqual(G.placementAtCell(s, 1, 5, 5), { x: 4, y: 5 });
  assert.deepEqual(G.placementAtCell(s, 0, 0, 0), { x: 0, y: 0 }, 'shifted to stay on the board');
  assert.deepEqual(G.placementAtCell(s, 0, 9, 9), { x: 6, y: 9 });
  const blocked = mk({ fill: (x, y) => y === 5 && x !== 9, tray: [G.blockOf('I', 0, 1)] });
  assert.equal(G.placementAtCell(blocked, 0, 9, 5), null);
});
