// Qwirkle game state machine. Pure: states are plain objects (board is a Map) and applyMove returns a new state.
import { makeRng, hashString } from '../shared/rng.js';
import { HAND_SIZE, END_BONUS, STALL_LIMIT } from './config.js';
import * as R from './rules.js';

/**
 * newGame({ seed, players: [{name, ai: strategyId|null}], bonusDensity, bonusMode }) -> state
 * state: { seed, cfg, board: Map, bag: tile[], players: [{name, ai, hand, score, last}], turn, passes, nonPlays, moves, over, winners }
 * players[i].last: { type: 'play', score, placements, breakdown, endBonus } | { type: 'exchange', count } | { type: 'pass' } | null
 */
export function newGame({ seed, players, bonusDensity = 0.08, bonusMode = 'line' }) {
  const rng = makeRng(seed);
  const bag = rng.shuffle(R.makeBag());
  const ps = players.map(p => ({ name: p.name, ai: p.ai || null, hand: [], score: 0, last: null }));
  for (let i = 0; i < HAND_SIZE; i++) for (const p of ps) p.hand.push(bag.pop());
  return {
    seed: seed >>> 0, cfg: { bonusDensity, bonusMode },
    board: new Map(), bag, players: ps,
    turn: 0, passes: 0, nonPlays: 0, moves: 0, over: false, winners: null,
  };
}

export function bonusFn(state) {
  return R.makeBonusFn(state.seed, { density: state.cfg.bonusDensity });
}

export function current(state) { return state.players[state.turn]; }

/** Human-readable score for a play, including bonuses. */
export function scorePlay(state, placements) {
  return R.scoreMove(state.board, placements, bonusFn(state), state.cfg.bonusMode);
}

function hasTiles(hand, tiles) {
  const pool = hand.slice();
  for (const t of tiles) { const i = pool.indexOf(t); if (i < 0) return false; pool.splice(i, 1); }
  return true;
}

export function canPass(state) {
  return state.bag.length === 0 && !R.hasAnyPlay(state.board, current(state).hand);
}

/** validateMove(state, move) -> { ok } | { ok: false, reason, message } for the current player. */
export function validateMove(state, move) {
  const fail = (reason) => ({ ok: false, reason, message: R.REASONS[reason] || reason });
  if (state.over) return fail('over');
  const p = current(state);
  if (move.type === 'play') {
    if (!move.placements || !move.placements.length) return fail('empty');
    if (!hasTiles(p.hand, move.placements.map(x => x.tile))) return fail('not-in-hand');
    return R.validate(state.board, move.placements);
  }
  if (move.type === 'exchange') {
    if (!move.tiles || !move.tiles.length) return fail('empty');
    if (!hasTiles(p.hand, move.tiles)) return fail('not-in-hand');
    if (state.bag.length < move.tiles.length) return fail('bag-short');
    return { ok: true };
  }
  if (move.type === 'pass') return canPass(state) ? { ok: true } : fail('pass-not-allowed');
  return fail('unknown move');
}

export function cloneState(s) {
  return { ...s, cfg: { ...s.cfg }, board: new Map(s.board), bag: s.bag.slice(), players: s.players.map(p => ({ ...p, hand: p.hand.slice() })) };
}

function removeTiles(hand, tiles) {
  for (const t of tiles) hand.splice(hand.indexOf(t), 1);
}

function drawUp(p, bag) {
  while (p.hand.length < HAND_SIZE && bag.length) p.hand.push(bag.pop());
}

/** applyMove(state, move) -> new state. Throws on an illegal move (check validateMove first). */
export function applyMove(state, move) {
  const v = validateMove(state, move);
  if (!v.ok) throw new Error('Illegal move: ' + v.message);
  const s = cloneState(state);
  const p = s.players[s.turn];
  if (move.type === 'play') {
    const placements = move.placements.map(({ x, y, tile }) => ({ x, y, tile }));
    const breakdown = scorePlay(s, placements);
    for (const pl of placements) s.board.set(R.key(pl.x, pl.y), pl.tile);
    removeTiles(p.hand, placements.map(pl => pl.tile));
    drawUp(p, s.bag);
    let endBonus = 0;
    if (p.hand.length === 0 && s.bag.length === 0) { endBonus = END_BONUS; s.over = true; }
    p.score += breakdown.total + endBonus;
    p.last = { type: 'play', score: breakdown.total + endBonus, placements, breakdown, endBonus };
    s.passes = 0; s.nonPlays = 0;
  } else if (move.type === 'exchange') {
    const tiles = move.tiles.slice();
    removeTiles(p.hand, tiles);
    for (let i = 0; i < tiles.length; i++) p.hand.push(s.bag.pop());
    s.bag.push(...tiles);
    makeRng(hashString(`${s.seed}:${s.moves}`)).shuffle(s.bag);
    p.last = { type: 'exchange', count: tiles.length };
    s.passes = 0; s.nonPlays++;
  } else {
    p.last = { type: 'pass' };
    s.passes++; s.nonPlays++;
    if (s.passes >= s.players.length) s.over = true;
  }
  if (s.nonPlays >= STALL_LIMIT) s.over = true;
  s.moves++;
  if (s.over) s.winners = winners(s);
  else s.turn = (s.turn + 1) % s.players.length;
  return s;
}

export function winners(state) {
  const best = Math.max(...state.players.map(p => p.score));
  return state.players.map((p, i) => (p.score === best ? i : -1)).filter(i => i >= 0);
}

export function standings(state) {
  return state.players.map((p, i) => ({ idx: i, name: p.name, ai: p.ai, score: p.score, tiles: p.hand.length }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx);
}

/** Count every tile in play (board + hands + bag); should always be 108. */
export function tileCount(state) {
  return state.board.size + state.bag.length + state.players.reduce((n, p) => n + p.hand.length, 0);
}

// ---------------------------------------------------------------- persistence
export function toJSON(state) {
  return { ...state, board: [...state.board.entries()] };
}

export function fromJSON(o) {
  if (!o || !Array.isArray(o.board) || !Array.isArray(o.players)) return null;
  return { ...o, board: new Map(o.board) };
}
