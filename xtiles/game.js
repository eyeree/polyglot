// xTiles game state machine. Pure: states are plain objects (board is a Map) and applyMove returns a new state.
// Modes (config.js:MODES): 'classic' is the original game; 'turns' / 'goal' / 'bag' play in rounds that start with
// one random tile in the centre, use chain placement and add round points into a game total.
import { makeRng, hashString } from '../shared/rng.js';
import { HAND_SIZE, END_BONUS, STALL_LIMIT, MAX_REDRAWS, MODES } from './config.js';
import * as R from './rules.js';

const N_TILES = R.N_SHAPES * R.N_COLORS;

/**
 * newGame({ seed, players: [{name, ai: strategyId|null}], mode, bonusDensity, bonusMode, bonusTypes, rounds, turnsPerRound, boardSize, pointsGoal }) -> state
 * state: {
 *   seed, cfg, board: Map, bag: tile[], draws (tiles taken from the endless pool so far),
 *   players: [{name, ai, hand, score (game total), roundScore, turns (this round), last}],
 *   round (1-based), firstPlayer (who opened round 1), turn, passes, nonPlays, moves,
 *   drew (Bag mode: the current player drew an extra tile at the start of this turn), turnEvent,
 *   roundOver, summary (round standings while roundOver / over), over, winners
 * }
 * players[i].last: { type: 'play', score, placements, breakdown, endBonus } | { type: 'exchange', count } | { type: 'pass' } | null
 * turnEvent: null | { type: 'redraw', n } (hand replaced n times) | { type: 'draw' } (one extra tile drawn)
 */
export function newGame({ seed, players, mode = 'classic', bonusDensity = 0.08, bonusMode = 'line', bonusTypes = 'all',
  rounds = 5, turnsPerRound = 5, boardSize = 15, pointsGoal = 100 }) {
  if (!MODES[mode]) mode = 'classic';
  const ps = players.map(p => ({ name: p.name, ai: p.ai || null, hand: [], score: 0, roundScore: 0, turns: 0, last: null }));
  const s = {
    seed: seed >>> 0,
    cfg: { mode, bonusDensity, bonusMode, bonusTypes, rounds: mode === 'classic' ? 1 : Math.max(1, rounds | 0), turnsPerRound, boardSize, pointsGoal },
    board: new Map(), bag: [], draws: 0, players: ps,
    round: 1, firstPlayer: 0, turn: 0, passes: 0, nonPlays: 0, moves: 0,
    drew: false, turnEvent: null, roundOver: false, summary: null, over: false, winners: null,
  };
  if (mode === 'classic') {
    const rng = makeRng(s.seed);
    s.bag = rng.shuffle(R.makeBag());
    for (let i = 0; i < HAND_SIZE; i++) for (const p of ps) p.hand.push(s.bag.pop());
    return s;
  }
  s.firstPlayer = makeRng(hashString(`${s.seed}:first`)).int(ps.length);
  startRound(s);
  return s;
}

export const modeOf = (state) => MODES[state.cfg.mode] || MODES.classic;
export const isClassic = (state) => state.cfg.mode === 'classic';
const infinitePool = (state) => modeOf(state).pool === 'infinite';

/** Tiles available to draw/swap: the bag, or ∞ in the endless-pool modes. */
export function poolSize(state) { return infinitePool(state) ? Infinity : state.bag.length; }

/** Board limits for this game (null = unlimited). */
export function bounds(state) {
  return modeOf(state).bounded ? R.squareBounds(state.cfg.boardSize) : null;
}

/** Options for rules.js validate / legalPlacements / hasAnyPlay. */
export function rulesOpts(state) {
  return { chain: modeOf(state).chain, bounds: bounds(state) };
}

export function bonusFn(state) {
  const seed = isClassic(state) ? state.seed : hashString(`${state.seed}:round:${state.round}`);
  return R.makeBonusFn(seed, { density: state.cfg.bonusDensity, types: state.cfg.bonusTypes || 'all' });
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

export function hasPlay(state, player = current(state)) {
  return R.hasAnyPlay(state.board, player.hand, rulesOpts(state));
}

export function canPass(state) {
  if (state.over || state.roundOver) return false;
  const mode = state.cfg.mode;
  if (mode === 'classic') return state.bag.length === 0 && !hasPlay(state);
  if (mode === 'bag') return state.drew || !hasPlay(state);
  return !hasPlay(state);
}

/** validateMove(state, move) -> { ok } | { ok: false, reason, message } for the current player. */
export function validateMove(state, move) {
  const fail = (reason) => ({ ok: false, reason, message: R.REASONS[reason] || reason });
  if (state.over) return fail('over');
  if (state.roundOver) return fail('round-over');
  const p = current(state);
  if (move.type === 'play') {
    if (!move.placements || !move.placements.length) return fail('empty');
    if (!hasTiles(p.hand, move.placements.map(x => x.tile))) return fail('not-in-hand');
    return R.validate(state.board, move.placements, rulesOpts(state));
  }
  if (move.type === 'exchange') {
    if (state.cfg.mode === 'bag') return fail('no-swap');
    if (!move.tiles || !move.tiles.length) return fail('empty');
    if (!hasTiles(p.hand, move.tiles)) return fail('not-in-hand');
    if (poolSize(state) < move.tiles.length) return fail('bag-short');
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

/** One tile from the endless pool (deterministic from the seed and the draw counter). */
function poolTile(s) {
  return makeRng(hashString(`${s.seed}:pool:${s.draws++}`)).int(N_TILES);
}

function drawUp(s, p) {
  if (infinitePool(s)) { while (p.hand.length < HAND_SIZE) p.hand.push(poolTile(s)); return; }
  while (p.hand.length < HAND_SIZE && s.bag.length) p.hand.push(s.bag.pop());
}

/**
 * Get the current player ready: in the endless-pool modes a hand that cannot play is replaced (up to MAX_REDRAWS
 * times); in Bag mode one extra tile is drawn instead. Records what happened in state.turnEvent.
 */
function prepareTurn(s) {
  s.turnEvent = null; s.drew = false;
  if (isClassic(s)) return;
  const p = current(s);
  if (infinitePool(s)) {
    let n = 0;
    while (n < MAX_REDRAWS && !hasPlay(s, p)) { p.hand = []; drawUp(s, p); n++; }
    if (n) s.turnEvent = { type: 'redraw', n };
  } else if (s.bag.length && !hasPlay(s, p)) {
    p.hand.push(s.bag.pop());
    s.drew = true;
    s.turnEvent = { type: 'draw' };
  }
}

/** Reset the board, bag and hands for state.round and hand the turn to that round's opener (mutates). */
function startRound(s) {
  const rng = makeRng(hashString(`${s.seed}:round:${s.round}`));
  s.board = new Map([[R.key(0, 0), R.tile(rng.int(R.N_SHAPES), rng.int(R.N_COLORS))]]);
  s.bag = infinitePool(s) ? [] : rng.shuffle(R.makeBag());
  for (const p of s.players) { p.hand = []; p.roundScore = 0; p.turns = 0; p.last = null; drawUp(s, p); }
  s.turn = (s.firstPlayer + s.round - 1) % s.players.length;
  s.passes = 0; s.nonPlays = 0; s.roundOver = false; s.summary = null;
  prepareTurn(s);
}

function roundEnded(s, mover) {
  const n = s.players.length;
  switch (s.cfg.mode) {
    case 'turns': return s.players.every(p => p.turns >= s.cfg.turnsPerRound) || s.passes >= n;
    case 'goal': return mover.roundScore >= s.cfg.pointsGoal || s.passes >= n || s.nonPlays >= STALL_LIMIT;
    case 'bag': return s.bag.length === 0 && s.passes >= n;
    default: return false;
  }
}

/** applyMove(state, move) -> new state. Throws on an illegal move (check validateMove first). */
export function applyMove(state, move) {
  const v = validateMove(state, move);
  if (!v.ok) throw new Error('Illegal move: ' + v.message);
  const s = cloneState(state);
  const p = s.players[s.turn];
  const classic = isClassic(s);
  if (move.type === 'play') {
    const placements = move.placements.map(({ x, y, tile }) => ({ x, y, tile }));
    const breakdown = scorePlay(s, placements);
    for (const pl of placements) s.board.set(R.key(pl.x, pl.y), pl.tile);
    removeTiles(p.hand, placements.map(pl => pl.tile));
    drawUp(s, p);
    let endBonus = 0;
    if (classic && p.hand.length === 0 && s.bag.length === 0) { endBonus = END_BONUS; s.over = true; }
    p.score += breakdown.total + endBonus;
    p.roundScore += breakdown.total + endBonus;
    p.last = { type: 'play', score: breakdown.total + endBonus, placements, breakdown, endBonus };
    s.passes = 0; s.nonPlays = 0;
  } else if (move.type === 'exchange') {
    const tiles = move.tiles.slice();
    removeTiles(p.hand, tiles);
    if (infinitePool(s)) drawUp(s, p);
    else {
      for (let i = 0; i < tiles.length; i++) p.hand.push(s.bag.pop());
      s.bag.push(...tiles);
      makeRng(hashString(`${s.seed}:${s.moves}`)).shuffle(s.bag);
    }
    p.last = { type: 'exchange', count: tiles.length };
    s.passes = 0; s.nonPlays++;
  } else {
    p.last = { type: 'pass' };
    s.passes++; s.nonPlays++;
    if (classic && s.passes >= s.players.length) s.over = true;
  }
  if (classic && s.nonPlays >= STALL_LIMIT) s.over = true;
  p.turns++;
  s.moves++;
  s.drew = false; s.turnEvent = null;
  if (classic) {
    if (s.over) s.winners = winners(s);
    else s.turn = (s.turn + 1) % s.players.length;
    return s;
  }
  if (roundEnded(s, p)) {
    s.summary = roundSummary(s);
    if (s.round >= s.cfg.rounds) { s.over = true; s.winners = winners(s); }
    else s.roundOver = true;
    return s;
  }
  s.turn = (s.turn + 1) % s.players.length;
  prepareTurn(s);
  return s;
}

/** nextRound(state) -> new state with the next round set up. Only valid while state.roundOver. */
export function nextRound(state) {
  if (!state.roundOver || state.over) throw new Error('The round is still in progress');
  const s = cloneState(state);
  s.round++;
  startRound(s);
  return s;
}

function roundSummary(s) {
  const best = Math.max(...s.players.map(p => p.roundScore));
  return {
    round: s.round,
    rows: s.players.map((p, i) => ({ idx: i, name: p.name, ai: p.ai, points: p.roundScore, total: p.score, tiles: p.hand.length })),
    winners: s.players.map((p, i) => (p.roundScore === best ? i : -1)).filter(i => i >= 0),
  };
}

export function winners(state) {
  const best = Math.max(...state.players.map(p => p.score));
  return state.players.map((p, i) => (p.score === best ? i : -1)).filter(i => i >= 0);
}

export function standings(state) {
  return state.players.map((p, i) => ({ idx: i, name: p.name, ai: p.ai, score: p.score, roundScore: p.roundScore, tiles: p.hand.length }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx);
}

/** Count every tile in play (board + hands + bag); always 108 in the bag-based modes (minus the centre tile's extra in Bag mode). */
export function tileCount(state) {
  return state.board.size + state.bag.length + state.players.reduce((n, p) => n + p.hand.length, 0);
}

// ---------------------------------------------------------------- persistence
export function toJSON(state) {
  return { ...state, board: [...state.board.entries()] };
}

/** Accepts saves from before modes existed (classic, no round fields). */
export function fromJSON(o) {
  if (!o || !Array.isArray(o.board) || !Array.isArray(o.players)) return null;
  const s = { ...o, board: new Map(o.board) };
  s.cfg = { mode: 'classic', bonusTypes: 'all', rounds: 1, turnsPerRound: 5, boardSize: 15, pointsGoal: 100, ...(o.cfg || {}) };
  if (!MODES[s.cfg.mode]) s.cfg.mode = 'classic';
  s.draws ??= 0; s.round ??= 1; s.firstPlayer ??= 0; s.drew ??= false; s.turnEvent ??= null;
  s.roundOver ??= false; s.summary ??= null;
  for (const p of s.players) { p.roundScore ??= p.score; p.turns ??= 0; }
  return s;
}
