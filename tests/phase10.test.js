import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../phase10/rules.js';
import * as G from '../phase10/game.js';
import * as AI from '../phase10/ai.js';
import { PHASES, STRATEGIES, COLORS } from '../phase10/config.js';
import { makeRng } from '../shared/rng.js';

// ---------------------------------------------------------------- card helpers
const nums = (num, color) => R.CARDS.filter(c => c.kind === 'num' && c.num === num && (!color || c.color === color));
const N = (num, color = 'red', copy = 0) => nums(num, color)[copy];
const W = (i = 0) => R.CARDS.filter(R.isWild)[i];
const S = (i = 0) => R.CARDS.filter(R.isSkip)[i];
const names = (groups) => groups.map(g => g.cards.map(c => (c ? R.shortName(c) : '_')));

test('deck has 108 cards: 96 numbers (1–12 ×2 per colour), 8 wilds, 4 skips', () => {
  assert.equal(R.CARDS.length, 108);
  assert.equal(R.CARDS.filter(R.isWild).length, 8);
  assert.equal(R.CARDS.filter(R.isSkip).length, 4);
  for (const color of COLORS) for (let n = 1; n <= 12; n++) assert.equal(nums(n, color).length, 2, `${color} ${n}`);
  assert.equal(new Set(R.makeDeckIds()).size, 108);
  assert.deepEqual(R.CARDS.map(c => c.id), R.CARDS.map((_, i) => i), 'ids are positions');
});

test('scoring: 1–9 = 5, 10–12 = 10, Skip = 15, Wild = 25', () => {
  assert.equal(R.cardPoints(N(1)), 5);
  assert.equal(R.cardPoints(N(9)), 5);
  assert.equal(R.cardPoints(N(10)), 10);
  assert.equal(R.cardPoints(N(12)), 10);
  assert.equal(R.cardPoints(S()), 15);
  assert.equal(R.cardPoints(W()), 25);
  assert.equal(R.handPoints([N(3), N(11), S(), W()]), 55);
  assert.equal(R.handPoints([]), 0);
});

test('phase table: ten phases with the standard components', () => {
  assert.equal(PHASES.length, 10);
  assert.deepEqual(PHASES.map(p => p.comps.map(c => c.type + c.n).join('+')), [
    'set3+set3', 'set3+run4', 'set4+run4', 'run7', 'run8', 'run9', 'set4+set4', 'color7', 'set5+set2', 'set5+set3',
  ]);
  assert.equal(R.phaseMinCards(1), 6);
  assert.equal(R.phaseMinCards(6), 9);
  assert.equal(R.phaseLabel(3), 'Phase 3: set of 4 + run of 4');
});

// ---------------------------------------------------------------- deficit / canLayDown per phase
test('phase 1: two sets of 3', () => {
  assert.equal(R.deficit([N(5), N(5, 'blue'), N(5, 'green'), N(7), N(7, 'blue'), N(7, 'green')], 1).need, 0);
  assert.equal(R.deficit([N(5), N(5, 'blue'), N(5, 'green'), N(7), N(7, 'blue'), N(9)], 1).need, 1);
  assert.equal(R.deficit([N(1), N(2), N(3), N(4), N(5), N(6), N(7), N(8), N(9), N(10)], 1).need, 4, 'no pairs at all');
  assert.equal(R.deficit([N(5), N(5, 'blue'), W(), N(7), N(7, 'blue'), W(1)], 1).need, 0, 'wilds fill gaps');
  // same number for both sets
  const sixFives = [N(5), N(5, 'blue'), N(5, 'green'), N(5, 'yellow'), N(5, 'red', 1), N(5, 'blue', 1)];
  assert.equal(R.deficit(sixFives, 1, { allowSameNumberSets: true }).need, 0);
  assert.equal(R.deficit(sixFives, 1).need, 0, 'default allows same-number sets');
  assert.equal(R.deficit(sixFives, 1, { allowSameNumberSets: false }).need, 3);
  assert.ok(R.canLayDown(sixFives, 1));
  assert.equal(R.canLayDown(sixFives, 1, { allowSameNumberSets: false }), null);
  // extras extend the sets; non-fitting extras are refused
  const g = R.canLayDown([N(5), N(5, 'blue'), N(5, 'green'), N(5, 'yellow'), N(7), N(7, 'blue'), N(7, 'green')], 1);
  assert.ok(g);
  assert.deepEqual(g.map(x => x.cards.length).sort(), [3, 4]);
  assert.equal(R.canLayDown([N(5), N(5, 'blue'), N(5, 'green'), N(7), N(7, 'blue'), N(7, 'green'), N(9)], 1), null);
  assert.equal(R.canLayDown([N(5), N(5, 'blue'), N(7), N(7, 'blue'), N(7, 'green')], 1), null, 'too few');
  assert.match(R.explainLayDown([N(5), N(5, 'blue'), N(7), N(7, 'blue'), N(7, 'green')], 1), /at least 6/);
  assert.match(R.explainLayDown([N(5), N(5, 'blue'), N(5, 'green'), N(7), N(7, 'blue'), N(7, 'green'), N(9)], 1), /don't fit/);
  assert.match(R.explainLayDown([N(5), N(5, 'blue'), N(5, 'green'), N(7), N(7, 'blue'), N(9)], 1), /1 short/);
});

test('a group needs at least one natural card', () => {
  assert.equal(R.deficit([W(), W(1), W(2), W(3), W(4), W(5)], 1).need, 2, 'six wilds still need a natural per set');
  assert.equal(R.deficit([N(5), W(), W(1), W(2), W(3), W(4)], 1).need, 1);
  const d = R.deficit([N(5), N(5, 'blue'), N(5, 'green'), W(), W(1), W(2)], 1);
  assert.equal(d.need, 0, 'naturals are spread so both sets have one');
  for (const g of d.groups) assert.ok(g.cards.some(c => c && R.isNum(c)), 'each group has a natural: ' + JSON.stringify(names(d.groups)));
  assert.equal(R.canLayDown([W(), W(1), W(2), W(3), W(4), W(5), W(6)], 4), null, 'all-wild run refused');
  assert.ok(R.canLayDown([W(), W(1), W(2), W(3), W(4), W(5), N(6)], 4), 'one natural suffices');
});

test('phase 2 & 3: set + run, sharing numbers between components', () => {
  // 9 9 9 + 2 W 4 5
  const g = R.canLayDown([N(9), N(9, 'blue'), N(9, 'green'), N(2), W(), N(4, 'blue'), N(5)], 2);
  assert.ok(g);
  const run = g.find(x => x.type === 'run');
  assert.equal(run.lo, 2); assert.equal(run.hi, 5);
  assert.deepEqual(run.cards.map(c => R.shortName(c)), ['R2', 'W', 'B4', 'R5']);
  // the set's number can also appear inside the run (4 4 4 and 3 4 5 6 uses a fourth 4)
  assert.equal(R.deficit([N(4), N(4, 'blue'), N(4, 'green'), N(3), N(4, 'yellow'), N(5), N(6)], 2).need, 0);
  // only three 4s: the set and the run compete for one → 1 short
  assert.equal(R.deficit([N(4), N(4, 'blue'), N(4, 'green'), N(3), N(5), N(6)], 2).need, 1);
  // phase 3 needs a set of 4
  assert.equal(R.deficit([N(9), N(9, 'blue'), N(9, 'green'), N(2), N(3), N(4, 'blue'), N(5)], 3).need, 1);
  assert.equal(R.deficit([N(9), N(9, 'blue'), N(9, 'green'), N(9, 'yellow'), N(2), N(3), N(4, 'blue'), N(5)], 3).need, 0);
});

test('phases 4–6: runs with gaps, wilds, no wrap-around, no duplicates', () => {
  const run7 = [N(3), N(4, 'blue'), N(5, 'green'), N(6), N(7), N(8, 'yellow'), N(9)];
  assert.equal(R.deficit(run7, 4).need, 0);
  assert.equal(R.deficit([N(3), N(4, 'blue'), N(6, 'green'), N(7), N(8), N(9, 'yellow'), N(10)], 4).need, 1, 'gap at 5');
  assert.equal(R.deficit([N(3), N(4, 'blue'), N(6, 'green'), N(7), N(8), N(9, 'yellow'), W()], 4).need, 0, 'wild plugs the gap');
  assert.equal(R.deficit([N(3), N(3, 'blue'), N(4), N(4, 'blue'), N(5), N(5, 'blue'), N(6)], 4).need, 3, 'duplicates do not count twice');
  assert.equal(R.deficit([N(10), N(11), N(12), N(1), N(2), N(3), N(4)], 4).need, 3, 'no wrap-around 10-11-12-1-2-3-4');
  assert.equal(R.deficit([N(1), N(2), N(3), N(4), N(5), N(6), N(7), N(8)], 5).need, 0);
  assert.equal(R.deficit([N(1), N(2), N(3), N(4), N(5), N(6), N(7), N(8), N(9)], 6).need, 0);
  assert.equal(R.deficit([N(1), N(2), N(3), N(4), N(5), N(6), N(7), N(8), N(12)], 6).need, 1);
  // a longer run may be laid down at once; 13 cards can't be a run
  const g = R.canLayDown([N(2), N(3), N(4), N(5), N(6), N(7), N(8), N(9), N(10)], 4);
  assert.ok(g); assert.equal(g[0].lo, 2); assert.equal(g[0].hi, 10);
  assert.equal(R.canLayDown([N(1), N(2), N(3), N(4), N(5), N(6), N(7), N(8), N(9), N(10), N(11), N(12), W()], 4), null);
  const wildRun = R.canLayDown([W(), N(5), N(6), N(7), N(8), N(9), W(1)], 4);
  assert.ok(wildRun);
  assert.equal(wildRun[0].hi - wildRun[0].lo, 6);
});

test('phase 7: two sets of 4', () => {
  assert.equal(R.deficit([N(2), N(2, 'blue'), N(2, 'green'), N(2, 'yellow'), N(8), N(8, 'blue'), N(8, 'green'), N(8, 'yellow')], 7).need, 0);
  assert.equal(R.deficit([N(2), N(2, 'blue'), N(2, 'green'), N(8), N(8, 'blue'), N(8, 'green'), N(1), N(12)], 7).need, 2);
  assert.equal(R.deficit([N(2), N(2, 'blue'), N(2, 'green'), N(8), N(8, 'blue'), N(8, 'green'), W(), W(1)], 7).need, 0);
});

test('phase 8: seven cards of one colour', () => {
  const sevenRed = [N(1), N(2), N(3), N(4), N(5), N(6), N(7)];
  assert.equal(R.deficit(sevenRed, 8).need, 0);
  assert.equal(R.deficit([...sevenRed.slice(0, 5), N(8, 'blue'), N(9, 'green')], 8).need, 2);
  assert.equal(R.deficit([...sevenRed.slice(0, 5), W(), N(9, 'green')], 8).need, 1);
  assert.equal(R.deficit([N(1), N(1, 'red', 1), N(2), N(2, 'red', 1), N(3), N(3, 'red', 1), N(4)], 8).need, 0, 'duplicates are fine in a colour group');
  const g = R.canLayDown([...sevenRed, N(8), N(9)], 8);
  assert.ok(g); assert.equal(g[0].cards.length, 9); assert.equal(g[0].key, 'red');
  assert.equal(R.canLayDown([...sevenRed, N(8, 'blue')], 8), null);
});

test('phases 9 & 10: set of 5 + set of 2 / set of 3', () => {
  const fives = [N(5), N(5, 'blue'), N(5, 'green'), N(5, 'yellow'), N(5, 'red', 1)];
  assert.equal(R.deficit([...fives, N(9), N(9, 'blue')], 9).need, 0);
  assert.equal(R.deficit([...fives, N(9), N(9, 'blue')], 10).need, 1);
  assert.equal(R.deficit([...fives, N(9), N(9, 'blue'), N(9, 'green')], 10).need, 0);
  assert.equal(R.deficit([...fives, N(5, 'blue', 1), N(5, 'green', 1)], 9).need, 0, 'seven 5s = set of 5 + set of 2 of the same number');
  assert.equal(R.deficit([...fives, N(5, 'blue', 1), N(5, 'green', 1)], 9, { allowSameNumberSets: false }).need, 2);
  assert.equal(R.deficit([N(1), N(2), N(3), N(4), N(6), N(7), N(8), N(9), N(10), N(11)], 10).need, 6, 'nothing pairs: 5 + 3 − 2 anchors');
  const g = R.canLayDown([...fives, N(5, 'blue', 1), N(9), N(9, 'blue'), N(9, 'green')], 10);
  assert.ok(g, 'extra 5 extends the set of 5');
});

test('deficit ignores Skips and reports the best arrangement', () => {
  const d = R.deficit([N(5), N(5, 'blue'), N(5, 'green'), S(), N(7), N(7, 'blue'), N(7, 'green')], 1);
  assert.equal(d.need, 0);
  assert.equal(d.groups.length, 2);
  assert.ok(d.ways >= 1);
  assert.equal(R.canLayDown([N(5), N(5, 'blue'), N(5, 'green'), S(), N(7), N(7, 'blue'), N(7, 'green')], 1), null, 'skips never lay down');
  assert.equal(R.deficit([], 1).need, 6);
  assert.equal(R.deficit([S(), S(1)], 4).need, 7);
});

test('deficit is consistent on random hands: padding with `need` wilds completes the phase, one fewer does not', () => {
  const rng = makeRng(99);
  for (let trial = 0; trial < 40; trial++) {
    const hand = rng.shuffle(R.makeDeckIds()).slice(0, 7).map(R.card).filter(c => !R.isSkip(c));
    const phaseNo = 1 + rng.int(10);
    const min = R.phaseMinCards(phaseNo);
    const d = R.deficit(hand, phaseNo);
    // check: an arrangement with `need` missing cards exists → padding with that many fresh wilds must complete it,
    // and with one wild fewer it must not (wilds fit any slot, so they are the best possible extra cards).
    const spareWilds = R.CARDS.filter(c => R.isWild(c) && !hand.includes(c));
    const padded = [...hand, ...spareWilds.slice(0, d.need)];
    assert.equal(R.deficit(padded, phaseNo).need, 0, `trial ${trial} phase ${phaseNo}`);
    if (d.need > 0) assert.ok(R.deficit([...hand, ...spareWilds.slice(0, d.need - 1)], phaseNo).need > 0, `trial ${trial} phase ${phaseNo} too pessimistic`);
    assert.ok(d.need <= min, 'never needs more than the phase size');
    // every completed group of the best arrangement has a natural
    for (const g of d.groups) if (g.cards.every(c => c != null)) assert.ok(g.cards.some(c => R.isNum(c)), 'complete group has a natural');
  }
});

// ---------------------------------------------------------------- hits
test('hit validation: sets, run ends, colour groups, wilds, invalid cases', () => {
  const set = { id: 1, owner: 0, type: 'set', key: 7, cards: [] };
  assert.deepEqual(R.hitOptions(set, N(7, 'blue')), ['add']);
  assert.deepEqual(R.hitOptions(set, N(8)), []);
  assert.deepEqual(R.hitOptions(set, W()), ['add']);
  assert.deepEqual(R.hitOptions(set, S()), []);
  const run = { id: 2, owner: 0, type: 'run', key: 4, lo: 4, hi: 7, cards: [N(4).id, N(5).id, N(6).id, N(7).id] };
  assert.deepEqual(R.hitOptions(run, N(3)), ['low']);
  assert.deepEqual(R.hitOptions(run, N(8, 'green')), ['high']);
  assert.deepEqual(R.hitOptions(run, N(5)), [], 'inside the run');
  assert.deepEqual(R.hitOptions(run, N(9)), [], 'not adjacent');
  assert.deepEqual(R.hitOptions(run, W()).sort(), ['high', 'low']);
  R.applyHit(run, N(8, 'green'), 'high');
  assert.equal(run.hi, 8);
  R.applyHit(run, W(), 'low');
  assert.equal(run.lo, 3);
  assert.equal(run.cards[0], W().id);
  assert.equal(R.runValueAt(run, 0), 3);
  const top = { id: 3, owner: 0, type: 'run', key: 9, lo: 9, hi: 12, cards: [] };
  assert.deepEqual(R.hitOptions(top, W()), ['low'], 'nothing above 12');
  assert.deepEqual(R.hitOptions(top, N(1)), [], 'no wrap');
  const bottom = { id: 4, owner: 0, type: 'run', key: 1, lo: 1, hi: 4, cards: [] };
  assert.deepEqual(R.hitOptions(bottom, W()), ['high'], 'nothing below 1');
  const full = { id: 5, owner: 0, type: 'run', key: 1, lo: 1, hi: 12, cards: [] };
  assert.deepEqual(R.hitOptions(full, W()), []);
  const color = { id: 6, owner: 0, type: 'color', key: 'green', cards: [] };
  assert.deepEqual(R.hitOptions(color, N(11, 'green')), ['add']);
  assert.deepEqual(R.hitOptions(color, N(11, 'red')), []);
  assert.deepEqual(R.hitOptions(color, W()), ['add']);
  assert.throws(() => R.applyHit(color, N(1, 'red')));
});

// ---------------------------------------------------------------- game state machine
function twoPlayer(seed = 1) {
  return G.newGame({ seed, players: [{ name: 'You', ai: null }, { name: 'Ada', ai: 'steady' }] });
}

test('deal: 10 cards each, one discard, rest in deck; same seed = same deal', () => {
  const s = twoPlayer(5);
  assert.equal(s.hand, 1);
  for (const p of s.players) assert.equal(p.hand.length, 10);
  assert.equal(s.discard.length, 1);
  assert.equal(s.deck.length + s.discard.length + 20, 108);
  const all = [...s.deck, ...s.discard, ...s.players.flatMap(p => p.hand)];
  assert.equal(new Set(all).size, 108);
  assert.deepEqual(twoPlayer(5).players[0].hand, s.players[0].hand);
  assert.notDeepEqual(twoPlayer(6).players[0].hand, s.players[0].hand);
  assert.ok(['draw'].includes(s.stage));
});

test('turn flow: draw → lay down → hit → discard, with validation messages', () => {
  const s = twoPlayer(1);
  s.turn = 0; s.stage = 'draw'; s.players[0].skipped = false;
  // rig the hand: 5 5 5 7 7 7 + 9 10 11 12 and make the discard a 9
  s.players[0].hand = [N(5).id, N(5, 'blue').id, N(5, 'green').id, N(7).id, N(7, 'blue').id, N(7, 'green').id, N(9).id, N(10).id, N(11).id, N(12).id];
  s.discard = [N(9, 'blue').id];
  s.deck = s.deck.filter(id => !s.players[0].hand.includes(id) && id !== N(9, 'blue').id);
  assert.equal(G.layDown(s, [N(5).id]).ok, false, 'must draw first');
  assert.equal(G.discard(s, N(9).id).ok, false);
  assert.ok(G.draw(s, 'discard').ok);
  assert.equal(s.stage, 'play');
  assert.equal(s.players[0].hand.length, 11);
  assert.deepEqual(s.players[0].taken, [N(9, 'blue').id]);
  assert.equal(G.draw(s, 'deck').ok, false, 'only one draw');
  assert.equal(G.hit(s, N(9).id, 1).ok, false, 'no hitting before laying down');
  const bad = G.layDown(s, [N(5).id, N(5, 'blue').id, N(5, 'green').id, N(7).id, N(7, 'blue').id]);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /at least 6/);
  const lay = G.layDown(s, [N(5).id, N(5, 'blue').id, N(5, 'green').id, N(7).id, N(7, 'blue').id, N(7, 'green').id]);
  assert.ok(lay.ok, lay.reason);
  assert.equal(s.table.length, 2);
  assert.ok(s.players[0].laidDown);
  assert.equal(s.players[0].hand.length, 5);
  assert.equal(G.layDown(s, [N(9).id]).ok, false, 'once per hand');
  const setOf5 = s.table.find(g => g.key === 5);
  assert.equal(G.hit(s, N(9).id, setOf5.id).ok, false, '9 does not fit a set of 5s');
  // add a run to the table owned by the opponent and hit its end
  s.table.push({ id: 99, owner: 1, type: 'run', key: 6, lo: 6, hi: 8, cards: [N(6, 'blue').id, N(7, 'yellow').id, N(8, 'blue').id] });
  assert.ok(G.hit(s, N(9).id, 99).ok);
  assert.equal(G.groupById(s, 99).hi, 9);
  assert.ok(G.hit(s, N(10).id, 99, 'high').ok);
  assert.equal(s.players[0].hand.length, 3);
  assert.ok(G.discard(s, N(12).id).ok);
  assert.equal(s.turn, 1);
  assert.equal(s.stage, 'draw');
  assert.equal(s.discard[s.discard.length - 1], N(12).id);
  assert.match(s.log[s.log.length - 1], /You: took the blue 9 · laid down phase 1 · hit red 9 · hit red 10 · discarded red 12/);
});

test('skips: cannot be taken, skip a chosen player, first-discard skip, no double skip', () => {
  const s = twoPlayer(2);
  s.turn = 0; s.stage = 'draw'; s.players.forEach(p => { p.skipped = false; });
  s.discard = [S().id];
  assert.equal(G.draw(s, 'discard').ok, false);
  s.players[0].hand[0] = S(1).id;
  assert.ok(G.draw(s, 'deck').ok);
  assert.equal(G.discard(s, S(1).id).ok, false, 'needs a target');
  assert.equal(G.discard(s, S(1).id, 0).ok, false, 'not yourself');
  assert.ok(G.discard(s, S(1).id, 1).ok);
  // Ada is skipped: the turn comes straight back to the human
  assert.equal(s.turn, 0);
  assert.equal(s.players[1].skipped, false, 'flag consumed');
  assert.ok(s.log.some(l => l === 'Ada was skipped'));
  // three players: an already-skipped player is not eligible again
  const t = G.newGame({ seed: 3, players: [{ name: 'A' }, { name: 'B', ai: 'steady' }, { name: 'C', ai: 'steady' }] });
  t.turn = 0; t.stage = 'draw'; t.players.forEach(p => { p.skipped = false; });
  t.players[2].skipped = true;
  assert.deepEqual(G.eligibleSkipTargets(t), [1]);
  // a Skip as the very first discard skips the starting player
  let found = false;
  for (let seed = 1; seed < 400 && !found; seed++) {
    const u = G.newGame({ seed, players: [{ name: 'A' }, { name: 'B', ai: 'steady' }] });
    const log = u.log.join('\n');
    if (/was skipped/.test(log)) { found = true; assert.equal(u.turn, 1); }
  }
  assert.ok(found, 'some seed starts with a Skip on the discard');
});

test('going out: by discard, by hit (toggle), scoring and phase advance', () => {
  const s = twoPlayer(4);
  s.turn = 0; s.stage = 'play'; s.players.forEach(p => { p.skipped = false; });
  s.players[0].laidDown = true;
  s.players[0].hand = [N(3).id];
  s.players[1].hand = [N(2).id, N(11).id, W().id, S().id];
  s.players[1].laidDown = false;
  s.table = [{ id: 1, owner: 0, type: 'set', key: 3, cards: [N(3, 'blue').id, N(3, 'green').id, N(3, 'yellow').id] }];
  // goOutByHit off: the last card can't be hit
  s.opts.goOutByHit = false;
  assert.equal(G.hit(s, N(3).id, 1).ok, false);
  s.opts.goOutByHit = true;
  assert.ok(G.hit(s, N(3).id, 1).ok);
  assert.equal(s.stage, 'handEnd');
  const sum = s.summary;
  assert.equal(sum.outPlayer, 0);
  assert.equal(sum.rows[0].points, 0);
  assert.equal(sum.rows[0].phaseAfter, 2);
  assert.equal(sum.rows[1].points, 5 + 10 + 25 + 15);
  assert.equal(sum.rows[1].phaseAfter, 1, 'did not lay down → repeats phase 1');
  assert.equal(s.players[1].score, 55);
  assert.ok(G.nextHand(s).ok);
  assert.equal(s.hand, 2);
  assert.equal(s.turn, 1, 'deal rotates');
  assert.equal(s.table.length, 0);
  for (const p of s.players) { assert.equal(p.hand.length, 10); assert.equal(p.laidDown, false); }
});

test('game ends after a hand in which someone finishes phase 10; lowest score among them wins', () => {
  const s = G.newGame({ seed: 7, players: [{ name: 'A' }, { name: 'B', ai: 'steady' }, { name: 'C', ai: 'hoarder' }] });
  s.turn = 1; s.stage = 'play'; s.players.forEach(p => { p.skipped = false; });
  s.players[0].phase = 10; s.players[0].laidDown = true; s.players[0].score = 100; s.players[0].hand = [N(1).id];
  s.players[1].phase = 10; s.players[1].laidDown = true; s.players[1].score = 90; s.players[1].hand = [N(2).id];
  s.players[2].phase = 6; s.players[2].laidDown = false; s.players[2].score = 20; s.players[2].hand = [N(3).id];
  assert.ok(G.discard(s, N(2).id).ok);
  assert.equal(s.stage, 'gameEnd');
  assert.ok(s.summary.gameOver);
  assert.deepEqual(s.summary.winners, [1], 'B: 90 beats A: 105; C did not finish');
  assert.equal(G.nextHand(s).ok, false);
});

test('deck exhaustion reshuffles the discard pile except its top card', () => {
  const s = twoPlayer(8);
  s.turn = 0; s.stage = 'draw'; s.players.forEach(p => { p.skipped = false; });
  s.discard = [...s.deck.slice(0, 30), s.discard[0]];
  s.deck = [];
  const top = s.discard[s.discard.length - 1];
  assert.ok(G.draw(s, 'deck').ok);
  assert.equal(s.players[0].hand.length, 11);
  assert.deepEqual(s.discard, [top]);
  assert.equal(s.deck.length, 29);
  assert.ok(s.log.includes('Deck reshuffled'));
});

// ---------------------------------------------------------------- AI
test('AI takes a useful discard, lays down when complete, hits, and never discards a wild', () => {
  const s = twoPlayer(11);
  s.turn = 1; s.stage = 'draw'; s.players.forEach(p => { p.skipped = false; });
  const ai = s.players[1];
  ai.hand = [N(5).id, N(5, 'blue').id, N(7).id, N(7, 'blue').id, N(7, 'green').id, W().id, N(1).id, N(12).id, N(12, 'blue').id, N(2).id];
  s.discard = [N(5, 'green').id];
  s.deck = s.deck.filter(id => !ai.hand.includes(id) && id !== N(5, 'green').id);
  const prof = STRATEGIES.steady;
  assert.equal(AI.chooseDraw(s, 1, prof), 'discard', 'the green 5 completes phase 1');
  G.draw(s, 'discard');
  const plan = AI.choosePlays(s, 1, prof);
  assert.ok(plan.layDown, 'lays down');
  assert.equal(plan.layDown.length, 6);
  assert.ok(plan.discard);
  assert.notEqual(plan.discard.card, W().id, 'keeps the wild');
  assert.ok(plan.hits.some(x => x.card === W().id), 'the wild is hit after laying down');
  // the discard goes to a high-point card not needed for anything
  assert.ok([N(12).id, N(12, 'blue').id].includes(plan.discard.card), 'dumps a 12');
  AI.playTurn(s, prof);
  assert.equal(s.turn, 0);
  assert.ok(ai.laidDown);
  assert.equal(s.table.length, 2);
});

test('AI discards a Skip according to its policy and picks a legal target', () => {
  const s = G.newGame({ seed: 12, players: [{ name: 'A' }, { name: 'B', ai: 'steady' }, { name: 'C', ai: 'guardian' }] });
  s.turn = 1; s.stage = 'play'; s.players.forEach(p => { p.skipped = false; });
  const b = s.players[1];
  b.hand = [S().id, N(1).id, N(2).id, N(3).id, N(4).id, N(6).id, N(8).id, N(10).id, N(12).id, N(1, 'blue').id];
  s.players[0].hand = s.players[0].hand.slice(0, 3);
  const plan = AI.choosePlays(s, 1, STRATEGIES.steady);
  assert.equal(plan.discard.card, S().id, 'Steady skips immediately');
  assert.equal(plan.discard.target, 0, 'fewest cards');
  const g = AI.choosePlays(s, 1, STRATEGIES.guardian);
  assert.notEqual(g.discard.card, S().id, 'Guardian holds the skip while nobody threatens');
  s.players[0].laidDown = true; s.players[0].hand = s.players[0].hand.slice(0, 2);
  const g2 = AI.choosePlays(s, 1, STRATEGIES.guardian);
  assert.equal(g2.discard.card, S().id, 'Guardian skips once an opponent is close to going out');
  assert.equal(g2.discard.target, 0);
});

test('AI-vs-AI games with 2–6 players terminate with a declared winner', () => {
  const keys = Object.keys(STRATEGIES);
  let seed = 100;
  for (const n of [2, 3, 4, 5, 6]) {
    const players = Array.from({ length: n }, (_, i) => ({ name: 'P' + i, ai: keys[(i + seed) % keys.length] }));
    const s = G.newGame({ seed: seed++, players });
    let turns = 0;
    while (s.stage !== 'gameEnd') {
      if (s.stage === 'handEnd') { assert.ok(G.nextHand(s).ok); continue; }
      const before = JSON.stringify(s);
      AI.playTurn(s);
      assert.notEqual(JSON.stringify(s), before, 'the turn changed the state');
      assert.notEqual(s.stage, 'play', 'turn finished');
      // invariants
      const all = [...s.deck, ...s.discard, ...s.players.flatMap(p => p.hand), ...s.table.flatMap(g => g.cards)];
      assert.equal(all.length, 108, 'card conservation');
      assert.equal(new Set(all).size, 108);
      for (const g of s.table) {
        assert.ok(g.cards.some(id => R.isNum(R.card(id))), 'group has a natural');
        if (g.type === 'run') {
          assert.equal(g.cards.length, g.hi - g.lo + 1);
          g.cards.forEach((id, i) => { const c = R.card(id); if (R.isNum(c)) assert.equal(c.num, g.lo + i); });
        }
        if (g.type === 'set') for (const id of g.cards) { const c = R.card(id); if (R.isNum(c)) assert.equal(c.num, g.key); }
        if (g.type === 'color') for (const id of g.cards) { const c = R.card(id); if (R.isNum(c)) assert.equal(c.color, g.key); }
      }
      assert.ok(++turns < 5000, 'terminates');
    }
    assert.ok(s.summary.gameOver);
    assert.ok(s.summary.winners.length >= 1, 'a winner is declared');
    for (const w of s.summary.winners) assert.ok(s.players[w].phase > 10);
    assert.ok(s.hand >= 10, 'at least ten hands are needed to finish phase 10');
    assert.ok(turns < 2000, `sane turn count (${turns})`);
  }
});

test('state survives a JSON round trip (persistence format)', () => {
  const s = twoPlayer(21);
  AI.playTurn(s, STRATEGIES.steady);
  const copy = JSON.parse(JSON.stringify(s));
  assert.ok(G.isValidState(copy));
  assert.deepEqual(copy, s);
  assert.ok(!G.isValidState({}));
  assert.ok(!G.isValidState(null));
});
