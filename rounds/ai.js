// Rounds AI (pure). One decision engine; STRATEGIES profiles (config.js) only change priorities.
//
//   chooseDraw(state, me, profile)  -> 'deck' | 'discard'
//   choosePlays(state, me, profile) -> { layDown: [ids] | null, hits: [{ card, group, end }], discard: { card, target } | null }
//
// choosePlays simulates its own plan on a cloned state (using game.js) so later choices see earlier ones.
import * as R from './rules.js';
import * as G from './game.js';
import { STRATEGIES } from './config.js';

const DEFICIT_STEP = 1000;     // cost of being one card further from the phase
const clone = (s) => (typeof structuredClone === 'function' ? structuredClone(s) : JSON.parse(JSON.stringify(s)));

export function profileOf(key) { return STRATEGIES[key] || STRATEGIES.steady; }

// ---------------------------------------------------------------- what others want
/** Penalty for handing card c to player `idx`, based on what they visibly took from the discard this hand. */
function feedPenalty(state, idx, c) {
  const p = state.players[idx];
  if (p.laidDown || c.kind !== 'num') return 0;
  const comps = R.phase(Math.min(p.phase, 10)).comps;
  const wantsRuns = comps.some(x => x.type === 'run');
  const wantsColor = comps.some(x => x.type === 'color');
  let pen = 0;
  for (const id of p.taken) {
    const t = R.card(id);
    if (t.kind !== 'num') continue;
    if (t.num === c.num) pen += 2;
    else if (wantsRuns && Math.abs(t.num - c.num) <= 3) pen += 1;
    if (wantsColor && t.color === c.color) pen += 2;
  }
  return pen;
}

function nextPlayerIdx(state, me) {
  const n = state.players.length;
  for (let k = 1; k < n; k++) {
    const i = (me + k) % n;
    if (!state.players[i].skipped) return i;
  }
  return (me + 1) % n;
}

// ---------------------------------------------------------------- draw
export function chooseDraw(state, me, profile) {
  const p = state.players[me];
  const top = G.discardTop(state);
  if (!top || R.isSkip(top)) return 'deck';
  if (R.isWild(top)) return 'discard';
  const hand = R.cards(p.hand);
  if (p.laidDown || p.phase > 10) return state.table.some(g => R.canHit(g, top)) ? 'discard' : 'deck';
  const base = R.deficit(hand, p.phase, state.opts);
  const withTop = R.deficit([...hand, top], p.phase, state.opts);
  if (withTop.need < base.need) return 'discard';
  if (base.need === 0) {
    // we are laying down this turn: is the top card an immediate hit on our groups or anything on the table?
    const mine = base.groups.map(g => ({ type: g.type, key: g.key, lo: g.lo, hi: g.hi }));
    if ([...mine, ...state.table].some(g => R.canHit(g, top))) return 'discard';
  }
  if (profile.denyDraw && withTop.need === base.need) {
    const nxt = nextPlayerIdx(state, me);
    if (nxt !== me && feedPenalty(state, nxt, top) >= 2) return 'discard';
  }
  return 'deck';
}

// ---------------------------------------------------------------- lay down
/** Pick the lay-down (if any) that leaves the smallest, cheapest hand after hitting. */
function chooseLayDown(sim, me, profile) {
  const p = sim.players[me];
  if (p.laidDown || p.phase > 10) return null;
  const hand = R.cards(p.hand);
  if (R.deficit(hand, p.phase, sim.opts).need > 0) return null;
  // candidate card subsets: the whole hand minus each possible "discard keeper" is too many; instead try the
  // minimal arrangements and let hits absorb the extras.
  const options = R.layDownOptions(hand.filter(c => !R.isSkip(c)), p.phase, sim.opts, 12);
  const minimal = minimalArrangements(hand, p.phase, sim.opts);
  const candidates = [...minimal, ...options];
  let best = null;
  for (const groups of candidates) {
    const ids = groups.flatMap(g => g.cards.map(c => c.id));
    if (!sim.opts.goOutByHit && ids.length === p.hand.length) continue;
    const s2 = clone(sim);
    if (!G.layDown(s2, ids).ok) continue;
    if (s2.stage === 'play') planHits(s2, me, profile);
    const left = R.cards(s2.players[me].hand);
    const score = left.length * 100 + R.handPoints(left);
    if (!best || score < best.score) best = { ids, score };
  }
  return best ? best.ids : null;
}

/** Zero-deficit arrangements using only the minimum number of cards (one per shape combination). */
function minimalArrangements(hand, phaseNo, opts) {
  return R.arrangements(hand, phaseNo, opts, 12);
}

// ---------------------------------------------------------------- hits
/** Hit everything that fits (own groups first). Mutates sim; returns the hits made. */
function planHits(sim, me, profile) {
  const hits = [];
  const p = sim.players[me];
  for (let guard = 0; guard < 20; guard++) {
    if (sim.stage !== 'play' || !p.laidDown) break;
    const hand = R.cards(p.hand);
    if (!sim.opts.goOutByHit && hand.length <= 1) break;
    const naturals = hand.filter(R.isNum).sort((a, b) => R.cardPoints(b) - R.cardPoints(a));
    const wilds = hand.filter(R.isWild);
    const others = hand.length - wilds.length;
    // Hoarders keep wilds for later hits unless they can finish (or nearly finish) the hand now
    const useWilds = !profile.holdWilds || others <= 1 || wilds.length + others <= 2;
    const order = useWilds ? [...naturals, ...wilds] : naturals;
    const groups = [...sim.table].sort((a, b) => (a.owner === me ? 0 : 1) - (b.owner === me ? 0 : 1));
    let made = false;
    for (const c of order) {
      const g = groups.find(x => R.canHit(x, c));
      if (!g) continue;
      const opts = R.hitOptions(g, c);
      const end = opts.includes('high') ? 'high' : opts[0];
      if (!G.hit(sim, c.id, g.id, end).ok) continue;
      hits.push({ card: c.id, group: g.id, end });
      made = true;
      break;
    }
    if (!made) break;
  }
  return hits;
}

// ---------------------------------------------------------------- skips
function skipTriggered(sim, me, profile, handSize) {
  if (profile.skipPolicy === 'immediate') return true;
  const p = sim.players[me];
  if (p.laidDown || handSize <= 3) return true;              // about to go out: don't get caught with 15 points
  return sim.players.some((o, i) => i !== me && o.laidDown && o.hand.length <= profile.skipThreatCards);
}

export function chooseSkipTarget(sim, me, profile) {
  const eligible = G.eligibleSkipTargets(sim);
  if (!eligible.length) return null;
  const ps = sim.players;
  const byFewest = (a, b) => ps[a].hand.length - ps[b].hand.length || (ps[b].laidDown ? 1 : 0) - (ps[a].laidDown ? 1 : 0) || ps[b].phase - ps[a].phase;
  const sorted = [...eligible];
  switch (profile.skipTarget) {
    case 'leader':
      sorted.sort((a, b) => ps[a].score - ps[b].score || ps[b].phase - ps[a].phase || byFewest(a, b));
      return sorted[0];
    case 'nearestOut': {
      const laid = sorted.filter(i => ps[i].laidDown);
      const pool = laid.length ? laid : sorted;
      pool.sort(byFewest);
      return pool[0];
    }
    case 'next': {
      const n = ps.length;
      for (let k = 1; k < n; k++) { const i = (me + k) % n; if (eligible.includes(i)) return i; }
      return sorted[0];
    }
    default:
      sorted.sort(byFewest);
      return sorted[0];
  }
}

// ---------------------------------------------------------------- discard
function chooseDiscard(sim, me, profile) {
  const p = sim.players[me];
  const hand = R.cards(p.hand);
  if (!hand.length) return null;
  const nxt = nextPlayerIdx(sim, me);
  const laid = p.laidDown || p.phase > 10;
  const base = laid ? null : R.deficit(hand, p.phase, sim.opts);
  const skipNow = hand.some(R.isSkip) && skipTriggered(sim, me, profile, hand.length);
  const allWild = hand.every(R.isWild);
  let best = null;
  for (const c of hand) {
    let cost = 0;
    if (R.isWild(c)) { if (!allWild) continue; }
    else if (R.isSkip(c)) { cost += skipNow ? -DEFICIT_STEP : profile.skipHoldCost; }
    else {
      if (!laid) {
        const rest = R.deficit(hand.filter(x => x !== c), p.phase, sim.opts);
        cost += (rest.need - base.need) * DEFICIT_STEP;
        cost -= Math.min(rest.ways, 8) * 2;                    // keep flexible hands
      }
      cost -= R.cardPoints(c) * 10 * profile.pointsWeight;      // dump points
      if (nxt !== me) cost += feedPenalty(sim, nxt, c) * 30 * profile.defensive;
    }
    if (!best || cost < best.cost) best = { card: c, cost };
  }
  if (!best) best = { card: hand[0], cost: 0 };
  const target = R.isSkip(best.card) ? chooseSkipTarget(sim, me, profile) : null;
  return { card: best.card.id, target };
}

// ---------------------------------------------------------------- the turn
export function choosePlays(state, me, profile) {
  const sim = clone(state);
  const plan = { layDown: null, hits: [], discard: null };
  const ids = chooseLayDown(sim, me, profile);
  if (ids) {
    G.layDown(sim, ids);
    plan.layDown = ids;
    if (sim.stage !== 'play') return plan;          // went out by laying everything down
  }
  if (sim.players[me].laidDown) {
    plan.hits = planHits(sim, me, profile);
    if (sim.stage !== 'play') return plan;          // went out by hitting
  }
  plan.discard = chooseDiscard(sim, me, profile);
  return plan;
}

/** Play a whole AI turn on the real state (used by tests and the debug hook). Returns the plan. */
export function playTurn(state, profile = profileOf(state.players[state.turn].ai)) {
  const me = state.turn;
  if (state.stage === 'draw') G.draw(state, chooseDraw(state, me, profile));
  const plan = choosePlays(state, me, profile);
  if (plan.layDown) G.layDown(state, plan.layDown);
  for (const hItem of plan.hits) { if (state.stage !== 'play') break; G.hit(state, hItem.card, hItem.group, hItem.end); }
  if (state.stage === 'play' && plan.discard) G.discard(state, plan.discard.card, plan.discard.target);
  return plan;
}
