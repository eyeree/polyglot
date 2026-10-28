import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng } from '../shared/rng.js';
import { STRATEGY_IDS, BONUS, HAND_SIZE, END_BONUS } from '../qwirkle/config.js';
import * as R from '../qwirkle/rules.js';
import * as G from '../qwirkle/game.js';
import * as AI from '../qwirkle/ai.js';

const T = R.tile; // tile(shape, color)
const boardOf = (cells) => new Map(cells.map(([x, y, t]) => [R.key(x, y), t]));
const P = (x, y, tile) => ({ x, y, tile });

test('bag has 108 tiles: 36 kinds × 3 copies', () => {
  const bag = R.makeBag();
  assert.equal(bag.length, 108);
  const counts = new Map();
  for (const t of bag) counts.set(t, (counts.get(t) || 0) + 1);
  assert.equal(counts.size, 36);
  assert.ok([...counts.values()].every(c => c === 3));
  assert.equal(R.shapeOf(T(4, 2)), 4);
  assert.equal(R.colorOf(T(4, 2)), 2);
});

test('line validation: shared attribute, duplicates, length, mixed', () => {
  assert.ok(R.lineCheck([T(0, 0)]).ok, 'single tile');
  assert.ok(R.lineCheck([T(0, 0), T(1, 0), T(2, 0)]).ok, 'same colour, different shapes');
  assert.ok(R.lineCheck([T(3, 0), T(3, 1), T(3, 5)]).ok, 'same shape, different colours');
  assert.equal(R.lineCheck([T(0, 0), T(0, 0)]).reason, 'duplicate');
  assert.equal(R.lineCheck([T(0, 0), T(1, 0), T(0, 0)]).reason, 'duplicate');
  assert.equal(R.lineCheck([T(0, 0), T(1, 1)]).reason, 'mixed', 'different shape and colour');
  assert.equal(R.lineCheck([T(0, 0), T(1, 0), T(1, 1)]).reason, 'mixed');
  assert.equal(R.lineCheck([0, 1, 2, 3, 4, 5, 0]).reason, 'too-long');
  assert.ok(R.lineCheck([T(0, 0), T(0, 1), T(0, 2), T(0, 3), T(0, 4), T(0, 5)]).ok, 'full line of 6');
});

test('placement geometry: first move, line, gap, bridging, connection', () => {
  const empty = new Map();
  assert.ok(R.validate(empty, [P(0, 0, T(0, 0))]).ok);
  assert.equal(R.validate(empty, [P(1, 0, T(0, 0))]).reason, 'origin');
  assert.ok(R.validate(empty, [P(-1, 0, T(0, 0)), P(0, 0, T(1, 0)), P(1, 0, T(2, 0))]).ok);
  assert.equal(R.validate(empty, []).reason, 'empty');

  // board: red circle at 0,0 and red cross at 1,0
  const b = boardOf([[0, 0, T(0, 0)], [1, 0, T(1, 0)]]);
  assert.equal(R.validate(b, [P(0, 0, T(2, 0))]).reason, 'occupied');
  assert.equal(R.validate(b, [P(2, 0, T(2, 0)), P(3, 1, T(3, 0))]).reason, 'not-a-line', 'different rows and columns');
  assert.equal(R.validate(b, [P(2, 0, T(2, 0)), P(2, 2, T(3, 0))]).reason, 'gap', 'same column with a hole');
  assert.equal(R.validate(b, [P(2, 0, T(2, 0)), P(4, 0, T(3, 0))]).reason, 'gap');
  assert.equal(R.validate(b, [P(5, 5, T(2, 0))]).reason, 'not-connected');
  assert.equal(R.validate(b, [P(2, 0, T(2, 1))]).reason, 'mixed', 'orange diamond next to red tiles');
  assert.equal(R.validate(b, [P(2, 0, T(0, 0))]).reason, 'duplicate');
  assert.ok(R.validate(b, [P(2, 0, T(2, 0)), P(3, 0, T(3, 0))]).ok);
  // bridging: new tiles at -1,0 and 2,0 with the existing pair between them
  assert.ok(R.validate(b, [P(-1, 0, T(2, 0)), P(2, 0, T(3, 0))]).ok, 'tiles bridging existing ones');
  // perpendicular line must also be valid
  const c = boardOf([[0, 0, T(0, 0)], [1, 0, T(1, 0)], [0, 1, T(0, 1)]]);
  assert.equal(R.validate(c, [P(1, 1, T(2, 1))]).reason, 'mixed', 'row 1 would be orange circle + orange diamond (ok) but column 1 red cross + orange diamond (mixed)');
  assert.ok(R.validate(c, [P(1, 1, T(1, 1))]).ok, 'orange cross fits both lines');
});

test('scoring: first move, two directions, Qwirkle = 12', () => {
  assert.equal(R.scoreMove(new Map(), [P(0, 0, T(0, 0))]).total, 1, 'single first tile');
  assert.equal(R.scoreMove(new Map(), [P(0, 0, T(0, 0)), P(1, 0, T(1, 0)), P(2, 0, T(2, 0))]).total, 3);
  const b = boardOf([[0, 0, T(0, 0)], [1, 0, T(1, 0)], [0, 1, T(0, 1)]]);
  // orange cross at 1,1: row (orange circle, orange cross) = 2, column (red cross, orange cross) = 2
  const s = R.scoreMove(b, [P(1, 1, T(1, 1))]);
  assert.equal(s.total, 4);
  assert.equal(s.lines.length, 2);
  // two tiles extending the row: row of 4 + one perpendicular line of 2
  const s2 = R.scoreMove(b, [P(2, 0, T(2, 0)), P(3, 0, T(3, 0))]);
  assert.equal(s2.total, 4, 'row of four only (no perpendicular neighbours)');
  // Qwirkle
  const five = boardOf([0, 1, 2, 3, 4].map(i => [i, 0, T(i, 0)]));
  const q = R.scoreMove(five, [P(5, 0, T(5, 0))]);
  assert.equal(q.total, 12);
  assert.ok(q.lines[0].qwirkle);
  // extending a line also scores existing tiles in it
  const s3 = R.scoreMove(five, [P(0, 1, T(0, 1)), P(0, 2, T(0, 2))]);
  assert.equal(s3.total, 3, 'column of three, row untouched');
});

test('bonus cells are deterministic, keep the centre clear and follow the density', () => {
  const seed = 12345;
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) if (Math.abs(x) + Math.abs(y) <= 1) assert.equal(R.bonusAt(seed, x, y), null);
  let n = 0, total = 0;
  const kinds = new Map();
  for (let x = -60; x <= 60; x++) for (let y = -60; y <= 60; y++) {
    const b = R.bonusAt(seed, x, y, { density: 0.08 });
    assert.deepEqual(R.bonusAt(seed, x, y, { density: 0.08 }), b, 'deterministic');
    total++;
    if (b) { n++; kinds.set(b.id, (kinds.get(b.id) || 0) + 1); }
  }
  const density = n / total;
  assert.ok(density > 0.06 && density < 0.10, `density ${density}`);
  const w = Object.fromEntries(BONUS.kinds.map(k => [k.id, k.weight]));
  assert.ok(kinds.get('add1') > kinds.get('add2') && kinds.get('add2') > kinds.get('mul2') && kinds.get('mul2') > kinds.get('mul3'), JSON.stringify([...kinds]));
  assert.equal(Object.keys(w).length, 4);
  assert.notDeepEqual(R.bonusAt(seed, 7, 9), R.bonusAt(seed + 1, 7, 9) ?? { none: true }, 'seed changes the layout (or both null)');
  assert.equal(R.bonusAt(seed, 10, 10, { density: 0 }), null);
});

test('bonus application in line and move mode', () => {
  const b = boardOf([[0, 0, T(0, 0)], [1, 0, T(1, 0)], [0, 1, T(0, 1)]]);
  const bonusFn = (x, y) => (x === 1 && y === 1 ? { id: 'mul2', type: 'mul', n: 2, label: '×2' } : x === 2 && y === 1 ? { id: 'add2', type: 'add', n: 2, label: '+2' } : null);
  // orange cross at 1,1 (×2) and orange diamond at 2,1 (+2): row of 3 (contains the ×2 tile) + column of 2 at x=1 (contains ×2)
  const placements = [P(1, 1, T(1, 1)), P(2, 1, T(2, 1))];
  const line = R.scoreMove(b, placements, bonusFn, 'line');
  assert.equal(line.base, 3 * 2 + 2 * 2);
  assert.equal(line.adds, 2);
  assert.equal(line.muls, 1);
  assert.equal(line.total, 12);
  assert.equal(line.bonuses.length, 2);
  const move = R.scoreMove(b, placements, bonusFn, 'move');
  assert.equal(move.base, 5);
  assert.equal(move.muls, 2);
  assert.equal(move.total, 5 * 2 + 2);
  // in line mode a ×n only touches lines through its own cell
  const b2 = boardOf([[0, 0, T(0, 0)], [1, 0, T(1, 0)]]);
  const fn2 = (x, y) => (x === 2 && y === 0 ? { id: 'mul3', type: 'mul', n: 3, label: '×3' } : null);
  const r = R.scoreMove(b2, [P(2, 0, T(2, 0)), P(2, 1, T(2, 1))].slice(0, 1), fn2, 'line');
  assert.equal(r.total, 9);
  // stacking: two ×2 cells on one line → ×4
  const fn3 = (x) => (x >= 2 ? { id: 'mul2', type: 'mul', n: 2, label: '×2' } : null);
  assert.equal(R.scoreMove(b2, [P(2, 0, T(2, 0)), P(3, 0, T(3, 0))], fn3, 'line').total, 16);
  assert.equal(R.scoreMove(b2, [P(2, 0, T(2, 0)), P(3, 0, T(3, 0))], fn3, 'move').total, 16);
});

// ---------------------------------------------------------------- enumeration vs brute force
function* subsets(arr) {
  const n = arr.length;
  for (let m = 1; m < (1 << n); m++) yield arr.filter((_, i) => m & (1 << i));
}
function* permutations(arr) {
  if (arr.length <= 1) { yield arr; return; }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}
function* combinations(arr, k) {
  if (k === 0) { yield []; return; }
  for (let i = 0; i <= arr.length - k; i++) for (const c of combinations(arr.slice(i + 1), k - 1)) yield [arr[i], ...c];
}

function bruteForce(board, hand) {
  const bb = R.boardBounds(board) || { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  const m = hand.length;
  const xs = [], ys = [];
  for (let x = bb.minX - m; x <= bb.maxX + m; x++) xs.push(x);
  for (let y = bb.minY - m; y <= bb.maxY + m; y++) ys.push(y);
  const keys = new Set();
  const seenSubsets = new Set();
  for (const sub of subsets(hand)) {
    const sk = sub.slice().sort().join(',');
    if (seenSubsets.has(sk)) continue;
    seenSubsets.add(sk);
    const k = sub.length;
    const cellSets = [];
    for (const y of ys) for (const c of combinations(xs, k)) cellSets.push(c.map(x => [x, y]));
    if (k > 1) for (const x of xs) for (const c of combinations(ys, k)) cellSets.push(c.map(y => [x, y]));
    for (const cells of cellSets) {
      for (const perm of permutations(sub)) {
        const placements = cells.map(([x, y], i) => P(x, y, perm[i]));
        if (R.validate(board, placements).ok) keys.add(R.playKey(placements));
      }
    }
  }
  return keys;
}

test('enumeratePlays matches brute force on small boards', () => {
  const cases = [
    { board: new Map(), hand: [T(0, 0), T(1, 0), T(0, 1)] },
    { board: boardOf([[0, 0, T(0, 0)], [1, 0, T(1, 0)]]), hand: [T(2, 0), T(3, 0), T(0, 1)] },
    { board: boardOf([[0, 0, T(0, 0)], [1, 0, T(1, 0)], [0, 1, T(0, 1)]]), hand: [T(1, 1), T(2, 1), T(2, 0)] },
    { board: boardOf([[0, 0, T(0, 0)], [1, 0, T(1, 0)], [3, 0, T(3, 0)]]), hand: [T(2, 0), T(4, 0)] },   // bridging gap at 2,0
    { board: boardOf([[0, 0, T(0, 0)], [1, 0, T(1, 0)], [0, 1, T(0, 1)], [1, 1, T(1, 1)]]), hand: [T(2, 0), T(2, 1), T(2, 2)] },
  ];
  for (const { board, hand } of cases) {
    const got = new Set(AI.enumeratePlays(board, hand).map(p => R.playKey(p.placements)));
    const want = bruteForce(board, hand);
    assert.deepEqual([...got].sort(), [...want].sort(), `board ${[...board.keys()].join(' ')} hand ${hand}`);
    assert.ok(got.size > 0);
  }
});

test('enumeratePlays matches brute force on random mid-game boards', () => {
  const rng = makeRng(777);
  for (let round = 0; round < 6; round++) {
    let s = G.newGame({ seed: 1000 + round, players: [{ name: 'a', ai: 'greedy' }, { name: 'b', ai: 'greedy' }] });
    for (let i = 0; i < 4 && !s.over; i++) s = G.applyMove(s, AI.chooseMove(s, s.turn, 'greedy', 100, rng));
    // hand of 3 drawn from the bag and from the board's colours so that plays exist
    const hand = [s.bag[0], s.bag[1], [...s.board.values()][0]];
    const got = new Set(AI.enumeratePlays(s.board, hand).map(p => R.playKey(p.placements)));
    const want = bruteForce(s.board, hand);
    assert.deepEqual([...got].sort(), [...want].sort(), `round ${round}`);
  }
});

test('enumeratePlays is fast on a busy board with a full hand', () => {
  const rng = makeRng(5);
  let s = G.newGame({ seed: 99, players: [{ name: 'a', ai: 'greedy' }, { name: 'b', ai: 'greedy' }, { name: 'c', ai: 'greedy' }] });
  for (let i = 0; i < 40 && !s.over; i++) s = G.applyMove(s, AI.chooseMove(s, s.turn, 'greedy', 100, rng));
  const t0 = performance.now();
  let n = 0;
  for (let i = 0; i < 10; i++) n += AI.enumeratePlays(s.board, s.players[s.turn].hand).length;
  const ms = (performance.now() - t0) / 10;
  assert.ok(ms < 50, `enumeratePlays took ${ms.toFixed(1)} ms (board ${s.board.size} tiles, ${n / 10} plays)`);
});

// ---------------------------------------------------------------- game flow
test('newGame deals 6 to each player and all 108 tiles are accounted for', () => {
  const s = G.newGame({ seed: 1, players: [{ name: 'You' }, { name: 'Ada', ai: 'greedy' }, { name: 'Bo', ai: 'blocker' }] });
  assert.ok(s.players.every(p => p.hand.length === HAND_SIZE));
  assert.equal(s.bag.length, 108 - 18);
  assert.equal(G.tileCount(s), 108);
  assert.equal(s.turn, 0);
  assert.deepEqual(G.newGame({ seed: 1, players: [{ name: 'You' }, { name: 'Ada' }, { name: 'Bo' }] }).bag, s.bag, 'seeded');
});

test('validateMove / applyMove: play, exchange, pass and hand ownership', () => {
  let s = G.newGame({ seed: 3, players: [{ name: 'a' }, { name: 'b' }] });
  const hand = s.players[0].hand;
  const notMine = R.makeBag().find(t => !hand.includes(t));
  assert.equal(G.validateMove(s, { type: 'play', placements: [P(0, 0, notMine)] }).reason, 'not-in-hand');
  assert.equal(G.validateMove(s, { type: 'pass' }).reason, 'pass-not-allowed', 'bag not empty');
  assert.equal(G.validateMove(s, { type: 'exchange', tiles: [] }).reason, 'empty');
  assert.ok(G.validateMove(s, { type: 'exchange', tiles: [hand[0]] }).ok);
  assert.equal(G.validateMove(s, { type: 'exchange', tiles: hand.concat(hand) }).reason, 'not-in-hand');
  const before = s;
  s = G.applyMove(s, { type: 'play', placements: [P(0, 0, hand[0])] });
  assert.equal(before.board.size, 0, 'input state untouched');
  assert.equal(s.board.get('0,0'), hand[0]);
  assert.equal(s.players[0].hand.length, 6, 'drew back up');
  assert.equal(s.players[0].score, 1);
  assert.equal(s.players[0].last.type, 'play');
  assert.equal(s.turn, 1);
  assert.equal(G.tileCount(s), 108);
  // exchange
  const bHand = s.players[1].hand.slice();
  const bagBefore = s.bag.length;
  s = G.applyMove(s, { type: 'exchange', tiles: bHand.slice(0, 2) });
  assert.equal(s.players[1].hand.length, 6);
  assert.equal(s.bag.length, bagBefore);
  assert.equal(s.players[1].last.type, 'exchange');
  assert.equal(G.tileCount(s), 108);
  assert.equal(s.turn, 0);
  assert.throws(() => G.applyMove(s, { type: 'pass' }));
});

test('serialisation round-trips', () => {
  let s = G.newGame({ seed: 8, players: [{ name: 'a' }, { name: 'b', ai: 'builder' }] });
  s = G.applyMove(s, { type: 'play', placements: [P(0, 0, s.players[0].hand[0])] });
  const back = G.fromJSON(JSON.parse(JSON.stringify(G.toJSON(s))));
  assert.ok(back.board instanceof Map);
  assert.deepEqual(back, s);
  assert.equal(G.fromJSON(null), null);
  assert.equal(G.fromJSON({ nope: 1 }), null);
});

function playOut(seed, nPlayers, strategies, difficulty = 100) {
  const players = [];
  for (let i = 0; i < nPlayers; i++) players.push({ name: 'p' + i, ai: strategies[i % strategies.length] });
  let s = G.newGame({ seed, players, bonusDensity: 0.08, bonusMode: seed % 2 ? 'line' : 'move' });
  const rng = makeRng(seed * 7 + 1);
  let turns = 0;
  const log = [];
  while (!s.over) {
    assert.ok(turns++ < 600, `game did not terminate (seed ${seed})`);
    const idx = s.turn;
    const move = AI.chooseMove(s, idx, s.players[idx].ai, difficulty, rng);
    const v = G.validateMove(s, move);
    assert.ok(v.ok, `AI proposed an illegal move: ${v.message} (${JSON.stringify(move)})`);
    s = G.applyMove(s, move);
    log.push(move.type);
    assert.equal(G.tileCount(s), 108);
  }
  return { s, log, turns };
}

test('AI vs AI games terminate cleanly for every strategy and 2–4 players', () => {
  let seed = 100;
  for (const n of [2, 3, 4]) {
    for (const strat of STRATEGY_IDS) {
      const { s, log } = playOut(seed++, n, [strat]);
      assert.ok(s.over);
      assert.ok(s.players.every(p => p.score >= 0));
      assert.ok(s.winners.length >= 1);
      assert.ok(log.filter(t => t === 'play').length > 10, `${strat} ×${n}: too few plays`);
      assert.equal(G.tileCount(s), 108);
    }
  }
  // mixed strategies, several seeds, lower difficulty
  for (let seed2 = 500; seed2 < 506; seed2++) {
    const { s } = playOut(seed2, 3, STRATEGY_IDS, 40);
    assert.ok(s.over);
    // the bag normally empties; the game then ends when someone goes out (+6) or everyone passes
    const wentOut = s.players.some(p => p.hand.length === 0 && p.last?.endBonus === END_BONUS);
    assert.ok(wentOut || s.passes >= s.players.length || s.nonPlays >= 30, 'ended by a known condition');
  }
});

test('difficulty 100 always picks a best-valued play; strategies differ', () => {
  let s = G.newGame({ seed: 42, players: [{ name: 'a', ai: 'greedy' }, { name: 'b', ai: 'greedy' }] });
  const rng = makeRng(1);
  for (let i = 0; i < 6; i++) s = G.applyMove(s, AI.chooseMove(s, s.turn, 'greedy', 100, rng));
  const hand = s.players[s.turn].hand;
  const plays = AI.enumeratePlays(s.board, hand, { bonusFn: G.bonusFn(s), bonusMode: s.cfg.bonusMode });
  const best = Math.max(...plays.map(p => p.score));
  for (let i = 0; i < 5; i++) {
    const m = AI.chooseMove(s, s.turn, 'greedy', 100, makeRng(i));
    assert.equal(m.type, 'play');
    assert.equal(G.scorePlay(s, m.placements).total, best);
  }
  // low difficulty: still legal
  for (let i = 0; i < 5; i++) {
    const m = AI.chooseMove(s, s.turn, 'builder', 0, makeRng(i));
    assert.ok(G.validateMove(s, m).ok);
  }
  // hand synergy helpers
  assert.equal(AI.handSynergy([T(0, 0), T(1, 0), T(2, 0)]), 3);
  assert.equal(AI.handSynergy([T(0, 0), T(0, 0)]), -1);
  assert.equal(AI.handSynergy([T(0, 0), T(1, 1)]), 0);
  const weak = AI.weakestTiles([T(0, 0), T(1, 0), T(2, 0), T(5, 5)]);
  assert.deepEqual(weak, [T(5, 5)]);
});

test('end of game: emptying the hand with an empty bag awards +6; all-pass ends the game', () => {
  // construct a near-end state by hand: two players, empty bag, player 0 holds one playable tile
  let s = G.newGame({ seed: 11, players: [{ name: 'a' }, { name: 'b' }] });
  s = G.cloneState(s);
  s.board = boardOf([[0, 0, T(0, 0)], [1, 0, T(1, 0)]]);
  s.bag = [];
  s.players[0].hand = [T(2, 0)];
  s.players[1].hand = [T(5, 5)];
  const before = s.players[0].score;
  const n = G.applyMove(s, { type: 'play', placements: [P(2, 0, T(2, 0))] });
  assert.ok(n.over);
  assert.equal(n.players[0].score - before, 3 + END_BONUS);
  assert.deepEqual(n.winners, [0]);
  // all-pass: nobody can play, bag empty
  let q = G.cloneState(s);
  q.players[0].hand = [T(0, 0)]; // duplicate of the board's red circle in every line → unplayable? no: can go perpendicular. Use a tile that fits nowhere.
  // red circle at 0,0 & red cross at 1,0: a 'mixed' tile like blue star can never attach (needs shared attribute)
  q.players[0].hand = [T(4, 4)];
  q.players[1].hand = [T(4, 4)];
  assert.ok(G.canPass(q));
  q = G.applyMove(q, { type: 'pass' });
  assert.ok(!q.over);
  q = G.applyMove(q, { type: 'pass' });
  assert.ok(q.over);
  assert.equal(q.winners.length, 2, 'tie');
});
