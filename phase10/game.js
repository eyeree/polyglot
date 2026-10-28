// Phase 10 game state machine (pure, no DOM). All actions mutate the state in place and return { ok, reason }.
//
// state: {
//   seed, hand, opts: { allowSameNumberSets, goOutByHit },
//   players: [{ name, ai: strategyKey|null, hand: [cardId], phase: 1..11, laidDown, score, skipped, taken: [cardId] }],
//   table: [{ id, owner: playerIndex, type, key, cards: [cardId], lo?, hi? }],
//   deck: [cardId] (top = last), discard: [cardId] (top = last),
//   turn: playerIndex, stage: 'draw' | 'play' | 'handEnd' | 'gameEnd',
//   log: [string], turnLog: [string], summary: null | { hand, outPlayer, rows, gameOver, winners },
// }
import { makeRng, hashString } from '../shared/rng.js';
import * as R from './rules.js';

const ok = () => ({ ok: true });
const fail = (reason) => ({ ok: false, reason });
const LOG_MAX = 300;

export function newGame({ seed, players, opts = {} }) {
  const state = {
    seed: seed >>> 0,
    hand: 0,
    opts: { allowSameNumberSets: true, goOutByHit: true, ...opts },
    players: players.map(p => ({ name: p.name, ai: p.ai || null, hand: [], phase: 1, laidDown: false, score: 0, skipped: false, taken: [] })),
    table: [], deck: [], discard: [], turn: 0, stage: 'draw',
    log: [], turnLog: [], summary: null, nextGroupId: 1, reshuffles: 0,
  };
  dealHand(state);
  return state;
}

/** Deterministic rng per (seed, hand, purpose) so a saved game can be serialised without rng internals. */
function rngFor(state, tag) { return makeRng(hashString(`${state.seed}:${state.hand}:${tag}`)); }

export function currentPlayer(state) { return state.players[state.turn]; }
export function isAiTurn(state) { return (state.stage === 'draw' || state.stage === 'play') && !!currentPlayer(state).ai; }
export function discardTop(state) { return state.discard.length ? R.card(state.discard[state.discard.length - 1]) : null; }
export function handCards(state, i) { return R.cards(state.players[i].hand); }
export function deficitOf(state, i) {
  const p = state.players[i];
  if (p.phase > 10) return { need: 0, groups: [], ways: 0 };
  return R.deficit(handCards(state, i), p.phase, state.opts);
}
export function groupById(state, id) { return state.table.find(g => g.id === id) || null; }

function pushLog(state, line) {
  state.log.push(line);
  if (state.log.length > LOG_MAX) state.log.splice(0, state.log.length - LOG_MAX);
}
function flushTurnLog(state) {
  if (!state.turnLog.length) return;
  pushLog(state, `${currentPlayer(state).name}: ${state.turnLog.join(' · ')}`);
  state.turnLog = [];
}

// ---------------------------------------------------------------- hands & turns
export function dealHand(state) {
  state.hand += 1;
  const deck = rngFor(state, 'deal').shuffle(R.makeDeckIds());
  for (const p of state.players) { p.hand = []; p.laidDown = false; p.skipped = false; p.taken = []; }
  for (let i = 0; i < 10; i++) for (const p of state.players) p.hand.push(deck.pop());
  state.deck = deck;
  state.discard = [deck.pop()];
  state.table = [];
  state.reshuffles = 0;
  state.summary = null;
  state.turnLog = [];
  state.turn = (state.hand - 1) % state.players.length;   // the deal rotates
  pushLog(state, `— Hand ${state.hand} —`);
  // a Skip turned up as the first discard skips the first player
  if (R.isSkip(discardTop(state))) state.players[state.turn].skipped = true;
  beginTurn(state);
}

function beginTurn(state) {
  for (let guard = 0; guard < state.players.length && currentPlayer(state).skipped; guard++) {
    const p = currentPlayer(state);
    p.skipped = false;
    pushLog(state, `${p.name} was skipped`);
    state.turn = (state.turn + 1) % state.players.length;
  }
  state.stage = 'draw';
  state.turnLog = [];
}

function endTurn(state) {
  flushTurnLog(state);
  state.turn = (state.turn + 1) % state.players.length;
  beginTurn(state);
}

/** When the deck runs out the discard pile (minus its top card) is shuffled back in. */
function reshuffle(state) {
  if (state.discard.length <= 1) return;
  const top = state.discard.pop();
  state.reshuffles += 1;
  state.deck = rngFor(state, 'reshuffle' + state.reshuffles).shuffle(state.discard);
  state.discard = [top];
  pushLog(state, 'Deck reshuffled');
}

// ---------------------------------------------------------------- actions
/** draw(state, 'deck' | 'discard') */
export function draw(state, from) {
  if (state.stage !== 'draw') return fail('Not the time to draw');
  const p = currentPlayer(state);
  if (from === 'discard') {
    const top = discardTop(state);
    if (!top) return fail('The discard pile is empty');
    if (R.isSkip(top)) return fail('A Skip can\'t be taken from the discard pile');
    state.discard.pop();
    p.hand.push(top.id);
    p.taken.push(top.id);
    state.turnLog.push(`took the ${R.cardName(top)}`);
  } else {
    if (!state.deck.length) reshuffle(state);
    if (state.deck.length) { p.hand.push(state.deck.pop()); state.turnLog.push('drew'); }
    else state.turnLog.push('found nothing to draw');
  }
  state.stage = 'play';
  return ok();
}

function removeFromHand(p, ids) { p.hand = p.hand.filter(id => !ids.includes(id)); }

/** Lay down the current phase with exactly these cards (extras must extend the groups). */
export function layDown(state, ids) {
  if (state.stage !== 'play') return fail('Draw a card first');
  const p = currentPlayer(state);
  if (p.laidDown) return fail('You have already laid down this hand');
  if (p.phase > 10) return fail('All phases are complete');
  if (new Set(ids).size !== ids.length || !ids.every(id => p.hand.includes(id))) return fail('Those cards are not in your hand');
  const cs = R.cards(ids);
  const groups = R.canLayDown(cs, p.phase, state.opts);
  if (!groups) return fail(R.explainLayDown(cs, p.phase, state.opts));
  if (!state.opts.goOutByHit && ids.length === p.hand.length) return fail('Keep one card to discard');
  for (const g of groups) {
    state.table.push({ id: state.nextGroupId++, owner: state.turn, type: g.type, key: g.key, cards: g.cards.map(c => c.id), lo: g.lo, hi: g.hi });
  }
  removeFromHand(p, ids);
  p.laidDown = true;
  state.turnLog.push(`laid down phase ${p.phase}`);
  if (!p.hand.length) finishHand(state, state.turn);
  return ok();
}

/** Hit one card onto a table group. `end` ('low'|'high') matters only for wilds on runs. */
export function hit(state, id, groupId, end) {
  if (state.stage !== 'play') return fail('Draw a card first');
  const p = currentPlayer(state);
  if (!p.laidDown) return fail('Lay down your phase before hitting');
  if (!p.hand.includes(id)) return fail('That card is not in your hand');
  const g = groupById(state, groupId);
  if (!g) return fail('No such group');
  const c = R.card(id);
  const options = R.hitOptions(g, c);
  if (!options.length) return fail(`${R.cardName(c)} doesn't fit on that group`);
  if (!state.opts.goOutByHit && p.hand.length === 1) return fail('Keep one card to discard');
  R.applyHit(g, c, options.includes(end) ? end : options[0]);
  removeFromHand(p, [id]);
  state.turnLog.push(`hit ${R.cardName(c)}`);
  if (!p.hand.length) finishHand(state, state.turn);
  return ok();
}

/** Players who can be skipped right now (not yourself, not already skipped). */
export function eligibleSkipTargets(state) {
  return state.players.map((p, i) => i).filter(i => i !== state.turn && !state.players[i].skipped);
}

/** Discard a card and end the turn. A Skip needs a `target` player index (unless nobody is eligible). */
export function discard(state, id, target = null) {
  if (state.stage !== 'play') return fail('Draw a card first');
  const p = currentPlayer(state);
  if (!p.hand.includes(id)) return fail('That card is not in your hand');
  const c = R.card(id);
  if (R.isSkip(c)) {
    const eligible = eligibleSkipTargets(state);
    if (target == null) { if (eligible.length) return fail('Choose a player to skip'); }
    else if (!eligible.includes(target)) return fail('That player can\'t be skipped right now');
    if (target != null) { state.players[target].skipped = true; state.turnLog.push(`skipped ${state.players[target].name}`); }
    else state.turnLog.push('discarded a Skip (nobody to skip)');
  } else {
    state.turnLog.push(`discarded ${R.cardName(c)}`);
  }
  removeFromHand(p, [id]);
  state.discard.push(id);
  if (!p.hand.length) finishHand(state, state.turn);
  else endTurn(state);
  return ok();
}

/** Score the hand, advance phases, and either queue the next hand or end the game. */
function finishHand(state, outIdx) {
  flushTurnLog(state);
  const rows = state.players.map((p, i) => {
    const points = R.handPoints(R.cards(p.hand));
    const row = { index: i, name: p.name, completed: p.laidDown, phaseBefore: p.phase, points, wentOut: i === outIdx };
    p.score += points;
    if (p.laidDown) p.phase += 1;
    row.phaseAfter = p.phase;
    row.total = p.score;
    return row;
  });
  const finished = state.players.filter(p => p.phase > 10);
  const summary = { hand: state.hand, outPlayer: outIdx, rows, gameOver: finished.length > 0, winners: [] };
  if (finished.length) {
    const best = Math.min(...finished.map(p => p.score));
    summary.winners = state.players.map((p, i) => i).filter(i => state.players[i].phase > 10 && state.players[i].score === best);
    state.stage = 'gameEnd';
  } else {
    state.stage = 'handEnd';
  }
  state.summary = summary;
  pushLog(state, `${state.players[outIdx].name} went out`);
}

export function nextHand(state) {
  if (state.stage !== 'handEnd') return fail('The hand is still in progress');
  dealHand(state);
  return ok();
}

/** Sanity check for restored saves. */
export function isValidState(s) {
  return !!s && Array.isArray(s.players) && s.players.length >= 2 && Array.isArray(s.deck) && Array.isArray(s.discard)
    && Array.isArray(s.table) && typeof s.turn === 'number' && ['draw', 'play', 'handEnd', 'gameEnd'].includes(s.stage);
}
