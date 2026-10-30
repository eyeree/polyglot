// Abstrackle AI. Pure: enumerates every legal play, scores it, applies a strategy's weights and a
// difficulty-controlled amount of randomness. Strategies live in config.js:STRATEGIES.
import { STRATEGIES, AI } from './config.js';
import * as R from './rules.js';
import { bonusFn as gameBonusFn, rulesOpts, poolSize } from './game.js';

/**
 * enumeratePlays(board, hand, rules?) -> [{ placements, score, breakdown }]
 * rules: { bonusFn, bonusMode, chain, bounds, beam } (optional; without bonusFn plays are scored without bonuses).
 * In chain mode the space of connected plays is far too big to list, so when `beam` is set (default AI.beam) only
 * the `beam` best-scoring partial plays are grown at each tile count; beam 0 enumerates everything.
 */
export function enumeratePlays(board, hand, rules = {}) {
  const score = (placements) => R.scoreMove(board, placements, rules.bonusFn || null, rules.bonusMode || 'line');
  const opts = { chain: !!rules.chain, bounds: rules.bounds || null };
  if (opts.chain) {
    const beam = rules.beam ?? AI.beam;
    const scores = new Map();
    const scored = (pl) => { const k = R.playKey(pl); let v = scores.get(k); if (!v) { v = score(pl); scores.set(k, v); } return v; };
    if (beam > 0) opts.prune = (level) => level.length <= beam ? level : level.map(pl => ({ pl, t: scored(pl).total })).sort((a, b) => b.t - a.t).slice(0, beam).map(x => x.pl);
    return R.legalPlacements(board, hand, opts).map(placements => { const breakdown = scored(placements); return { placements, score: breakdown.total, breakdown }; });
  }
  return R.legalPlacements(board, hand, opts).map(placements => {
    const breakdown = score(placements);
    return { placements, score: breakdown.total, breakdown };
  });
}

/** Pairs of hand tiles that share exactly one attribute, minus identical pairs (which can never share a line). */
export function handSynergy(hand) {
  let n = 0;
  for (let i = 0; i < hand.length; i++) for (let j = i + 1; j < hand.length; j++) {
    if (hand[i] === hand[j]) n -= 1;
    else if (R.sharesOne(hand[i], hand[j])) n += 1;
  }
  return n;
}

/** Per-tile synergy: how many other tiles it pairs with (identical copies count against it). */
export function tileSynergy(hand, i) {
  let n = 0;
  for (let j = 0; j < hand.length; j++) {
    if (j === i) continue;
    if (hand[j] === hand[i]) n -= 1;
    else if (R.sharesOne(hand[i], hand[j])) n += 1;
  }
  return n;
}

/**
 * The tiles that pair least with the rest of the hand: everything with synergy ≤ 1 (at least one tile),
 * capped at `max` tiles. Returned as tile values.
 */
export function weakestTiles(hand, max = hand.length) {
  const scored = hand.map((t, i) => ({ t, s: tileSynergy(hand, i), i })).sort((a, b) => a.s - b.s || a.i - b.i);
  const weak = scored.filter(x => x.s <= 1);
  const picked = (weak.length ? weak : scored.slice(0, 1)).slice(0, Math.max(1, max));
  return picked.map(x => x.t);
}

function remainingHand(hand, placements) {
  const rest = hand.slice();
  for (const p of placements) rest.splice(rest.indexOf(p.tile), 1);
  return rest;
}

/** Lines of length 4–5 through the played tiles that still have an empty end cell (an Abstrackle invitation). */
export function openLinesAfter(board, play) {
  const view = R.overlay(board, play.placements);
  let n = 0;
  for (const l of play.breakdown.lines) {
    if (l.len < 4 || l.len > 5) continue;
    const a = l.cells[0], b = l.cells[l.cells.length - 1];
    const horiz = l.cells.length > 1 && l.cells[1].x !== a.x;
    const before = horiz ? R.key(a.x - 1, a.y) : R.key(a.x, a.y - 1);
    const after = horiz ? R.key(b.x + 1, b.y) : R.key(b.x, b.y + 1);
    if (!view.has(before) || !view.has(after)) n++;
  }
  return n;
}

/** Lines the move completes to 6 that already had ≥ 4 tiles before the move. */
export function closedLines(board, play) {
  const placed = new Set(play.placements.map(p => R.key(p.x, p.y)));
  let n = 0;
  for (const l of play.breakdown.lines) {
    if (!l.complete) continue;
    const pre = l.cells.filter(c => !placed.has(R.key(c.x, c.y))).length;
    if (pre >= 4) n++;
  }
  return n;
}

/** Strategy value of a play (higher is better). */
export function evaluatePlay(play, hand, board, strat) {
  let v = play.score;
  if (strat.openLinePenalty) v -= strat.openLinePenalty * openLinesAfter(board, play);
  if (strat.closeBonus) v += strat.closeBonus * closedLines(board, play);
  if (strat.handSynergy) v += strat.handSynergy * handSynergy(remainingHand(hand, play.placements));
  if (strat.multiplierBonus) {
    for (const b of play.breakdown.bonuses) if (b.type === 'mul') v += strat.multiplierBonus * (b.n - 1);
  }
  return v;
}

/**
 * chooseMove(state, playerIdx, strategyId, difficulty, rng) -> move
 * move: { type: 'play', placements } | { type: 'exchange', tiles } | { type: 'pass' }
 */
export function chooseMove(state, playerIdx, strategyId, difficulty = 100, rng = null) {
  const strat = STRATEGIES[strategyId] || STRATEGIES.greedy;
  const player = state.players[playerIdx];
  const hand = player.hand;
  const board = state.board;
  const supply = poolSize(state);
  const canSwap = state.cfg.mode !== 'bag' && supply > 0;
  const rnd = rng || { next: () => 0, int: () => 0 };

  const plays = enumeratePlays(board, hand, { bonusFn: gameBonusFn(state), bonusMode: state.cfg.bonusMode, ...rulesOpts(state) });
  const exchange = () => {
    const tiles = weakestTiles(hand, Math.min(hand.length, supply));
    return { type: 'exchange', tiles };
  };
  if (plays.length === 0) return canSwap ? exchange() : { type: 'pass' };

  for (const p of plays) p.value = evaluatePlay(p, hand, board, strat);
  plays.sort((a, b) => b.value - a.value);
  const best = plays[0];

  // Exchange instead of a weak play: never on the first move, never twice in a row (keeps games moving),
  // only when the bag is full enough, and (for hand builders) only when the hand itself is weak.
  const bagEnough = canSwap && (strat.aggressiveExchange ? supply >= 1 : supply >= hand.length);
  const weakHand = strat.weakHandMax == null || handSynergy(hand) <= strat.weakHandMax;
  if (best.score <= (strat.exchangeThreshold ?? 0) && bagEnough && board.size > 0 && player.last?.type !== 'exchange' && weakHand) return exchange();

  const d = Math.max(0, Math.min(100, Number(difficulty) || 0));
  let pool;
  if (d < 100 && rnd.next() < (100 - d) / 100) {
    pool = plays.filter(p => p.value >= best.value - AI.slack);
    if (pool.length < 2) pool = plays.slice(0, AI.topK);
  } else {
    pool = plays.filter(p => p.value === best.value);
  }
  const pick = pool[Math.min(pool.length - 1, Math.floor(rnd.next() * pool.length))];
  return { type: 'play', placements: pick.placements };
}
