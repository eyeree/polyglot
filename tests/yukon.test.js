import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deal, legalMoves, applyMove, isWon, stateKey, replay, rank, suit, isSafeFoundationMove, moveLabel, cardName } from '../yukon/game.js';
import { solve } from '../yukon/solver.js';
import { GameTree } from '../yukon/tree.js';

test('deal lays out 52 cards in the Yukon pattern', () => {
  const s = deal(42);
  assert.equal(s.cols.flat().length, 52);
  assert.equal(new Set(s.cols.flat()).size, 52);
  assert.deepEqual(s.cols.map(c => c.length), [1, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(s.down, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(deal(42), s, 'same seed, same deal');
  assert.notDeepEqual(deal(43), s);
});

test('legal moves respect colour/rank and kings-only empty columns', () => {
  const s = { cols: [[], [12], [1, 11 + 13], [0], [], [], []], down: [0, 0, 0, 0, 0, 0, 0], found: [-1, -1, -1, -1] };
  // col1: K♠ (12), col2: 2♠ then Q♥ (24) on top, col3: A♠ (0)
  const moves = legalMoves(s);
  const labels = moves.map(m => moveLabel(s, m)).sort();
  assert.ok(labels.includes('Q♥ → K♠'), labels.join(';'));
  assert.ok(labels.includes('A♠ → ♠ found.'));
  assert.ok(!labels.some(l => l.startsWith('K♠ → empty')), 'whole-column king to another empty is pointless');
  const anyRule = legalMoves(s, { kingsOnlyToEmpty: false }).map(m => moveLabel(s, m));
  assert.ok(anyRule.includes('Q♥ → empty'));
  assert.equal(anyRule.filter(l => l === 'Q♥ → empty').length, 1, 'only first empty column offered');
});

test('applyMove flips exposed face-down cards and moves whole stacks', () => {
  const s = { cols: [[5, 6, 7], [21], [], [], [], [], []], down: [2, 0, 0, 0, 0, 0, 0], found: [-1, -1, -1, -1] };
  // col0: 6♠(down) 7♠(down) 8♠(up); col1: 9♥ (21 = rank 8, suit 1) -> 8♠ fits on 9♥
  const m = legalMoves(s).find(x => x.from === 0 && x.to === 1);
  assert.ok(m);
  const n = applyMove(s, m);
  assert.deepEqual(n.cols[1], [21, 7]);
  assert.deepEqual(n.cols[0], [5, 6]);
  assert.equal(n.down[0], 1, 'top face-down card flipped');
  assert.deepEqual(s.cols[0], [5, 6, 7], 'original untouched');
});

test('safe foundation detection', () => {
  const s = { cols: [[2], [15], [], [], [], [], []], down: [0, 0, 0, 0, 0, 0, 0], found: [1, 1, 1, -1] };
  // col0: 3♠ (2), col1: 3♥ (15); ♠♥♦ at 2, ♣ empty. 3♠ safe needs 2♥,2♦ on found (yes). 3♥ needs 2♠,2♣: ♣ missing.
  const ms = legalMoves(s).filter(m => m.to === 'F');
  const safe = ms.filter(m => isSafeFoundationMove(s, m)).map(m => cardName(s.cols[m.from][m.idx]));
  assert.deepEqual(safe, ['3♠']);
});

test('stateKey is column-order independent', () => {
  const a = deal(7);
  const b = { cols: [...a.cols].reverse(), down: [...a.down].reverse(), found: a.found };
  assert.equal(stateKey(a), stateKey(b));
});

test('solver finds wins on random deals and the path replays to a won state', () => {
  let wins = 0, tried = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const s = deal(seed);
    const r = solve(s, { maxNodes: 60000, timeLimitMs: 4000 });
    tried++;
    if (r.result === 'win') {
      wins++;
      const end = replay(seed, r.path);
      assert.ok(isWon(end), `seed ${seed}: path should win`);
    }
  }
  assert.ok(wins >= 3, `expected several winnable deals, got ${wins}/${tried}`);
});

test('solver reports lose on an unwinnable position', () => {
  // All kings buried under a face-down card in a column whose only face-up card can't move:
  // simplest: a position with no legal moves and not won.
  const s = { cols: [[0, 25], [], [], [], [], [], []], down: [1, 0, 0, 0, 0, 0, 0], found: [-1, -1, -1, -1] };
  // col0: A♠ face down under K♥(25)? 25 = rank 12 suit 1 -> K♥. K♥ can move to empty? idx=1>0 so yes, exposing A♠ -> then A♠ to found... that wins nothing (needs all).
  const r = solve(s, { maxNodes: 1000 });
  assert.equal(r.result, 'lose');
});

test('game tree: play/undo/redo/branch points/serialisation', () => {
  const t = new GameTree(5);
  const s0 = t.state;
  const moves = legalMoves(s0);
  assert.ok(moves.length > 0);
  const id1 = t.play(moves[0]);
  assert.equal(t.currentId, id1);
  assert.equal(t.depth(id1), 1);
  assert.ok(t.undo()); assert.equal(t.currentId, 0);
  assert.ok(t.redo()); assert.equal(t.currentId, id1);
  // replaying the same move reuses the node
  t.undo(); assert.equal(t.play(moves[0]), id1);
  if (moves.length > 1) { t.undo(); const id2 = t.play(moves[1]); assert.notEqual(id2, id1); assert.equal(t.root.children.length, 2); }
  const json = JSON.parse(JSON.stringify(t.toJSON()));
  const t2 = GameTree.fromJSON(json);
  assert.equal(t2.currentId, t.currentId);
  assert.equal(stateKey(t2.state), stateKey(t.state));
  // expand + verdict propagation
  const kids = t2.expand(0);
  assert.equal(t2.unexplored(0).length, 0);
  t2.setVerdict(kids[0], 'win');
  assert.equal(t2.effectiveVerdict(0), 'win');
  t2.setVerdict(kids[1] ?? kids[0], 'lose');
  // delete subtree keeps tree consistent
  const before = t2.size();
  t2.deleteSubtree(kids[0]);
  assert.equal(t2.size(), before - 1);
  for (const n of t2.nodes) { assert.equal(n.id, t2.nodes.indexOf(n)); for (const c of n.children) assert.equal(t2.nodes[c].parent, n.id); }
});
