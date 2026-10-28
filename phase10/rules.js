// Phase 10 rules (pure): cards, phase fitting (deficit / canLayDown), hits, scoring. No DOM.
import { PHASES, COLORS } from './config.js';

// ---------------------------------------------------------------- cards
// card: { id, kind: 'num'|'wild'|'skip', num?, color? }. Ids are stable (0..107) so game state can hold ids.
export const CARDS = buildCards();
function buildCards() {
  const out = [];
  for (const color of COLORS) for (let copy = 0; copy < 2; copy++) for (let num = 1; num <= 12; num++) out.push({ id: out.length, kind: 'num', num, color });
  for (let i = 0; i < 8; i++) out.push({ id: out.length, kind: 'wild' });
  for (let i = 0; i < 4; i++) out.push({ id: out.length, kind: 'skip' });
  return out;
}
export const card = (id) => CARDS[id];
export const cards = (ids) => ids.map(card);
export const isWild = (c) => c.kind === 'wild';
export const isSkip = (c) => c.kind === 'skip';
export const isNum = (c) => c.kind === 'num';

/** Unshuffled deck of card ids (108). The caller shuffles with its rng. */
export function makeDeckIds() { return CARDS.map(c => c.id); }

export function cardPoints(c) {
  if (c.kind === 'wild') return 25;
  if (c.kind === 'skip') return 15;
  return c.num >= 10 ? 10 : 5;
}
export function handPoints(cs) { return cs.reduce((a, c) => a + cardPoints(c), 0); }

export function cardName(c) {
  if (c.kind === 'wild') return 'Wild';
  if (c.kind === 'skip') return 'Skip';
  return `${c.color} ${c.num}`;
}
export function shortName(c) {
  if (c.kind === 'wild') return 'W';
  if (c.kind === 'skip') return 'S';
  return c.color[0].toUpperCase() + c.num;
}

// ---------------------------------------------------------------- phases
export function phase(n) { return PHASES[n - 1]; }
export function phaseLabel(n) { return n > 10 ? 'All phases done' : `Phase ${n}: ${PHASES[n - 1].label}`; }
export function phaseMinCards(n) { return PHASES[n - 1].comps.reduce((a, c) => a + c.n, 0); }

/** Does a slot accept a card? slot = {num} (set/run position) or {color}. Wilds fit anywhere; Skips nowhere. */
function accept(slot, c) {
  if (c.kind === 'wild') return true;
  if (c.kind !== 'num') return false;
  return slot.num != null ? c.num === slot.num : c.color === slot.color;
}

/** All shapes a component can take with `size` slots: set → each number, run → each start, colour → each colour. */
function shapesFor(comp, size) {
  const out = [];
  if (comp.type === 'set') {
    for (let num = 1; num <= 12; num++) out.push({ type: 'set', key: num, size, slots: Array.from({ length: size }, () => ({ num })) });
  } else if (comp.type === 'run') {
    for (let s = 1; s + size - 1 <= 12; s++) out.push({ type: 'run', key: s, size, slots: Array.from({ length: size }, (_, i) => ({ num: s + i })) });
  } else {
    for (const color of COLORS) out.push({ type: 'color', key: color, size, slots: Array.from({ length: size }, () => ({ color })) });
  }
  return out;
}

/**
 * Enumerate shape combinations for a phase. sizesOf(compIndex) -> allowed slot counts for that component.
 * Symmetric components (same type and n, same size) are enumerated once (a ≤ b); two set components may not
 * share a number unless opts.allowSameNumberSets.
 */
function* combos(comps, sizesOf, opts, filterTotal) {
  const lists = comps.map((c, i) => sizesOf(i).flatMap(size => shapesFor(c, size)));
  if (comps.length === 1) {
    for (const a of lists[0]) if (!filterTotal || filterTotal(a.size)) yield [a];
    return;
  }
  const [c0, c1] = comps;
  const symmetric = c0.type === c1.type && c0.n === c1.n;
  for (let i = 0; i < lists[0].length; i++) {
    const a = lists[0][i];
    for (let j = 0; j < lists[1].length; j++) {
      const b = lists[1][j];
      if (filterTotal && !filterTotal(a.size + b.size)) continue;
      // symmetric components: (a,b) and (b,a) describe the same arrangement, enumerate once
      if (symmetric && (a.size > b.size || (a.size === b.size && b.key < a.key))) continue;
      if (a.type === 'set' && b.type === 'set' && a.key === b.key && opts.allowSameNumberSets === false) continue;
      yield [a, b];
    }
  }
}

/**
 * Maximum bipartite matching of cards → slots (Kuhn's augmenting paths). Naturals are matched first so wilds are
 * only used where no natural fits. `fixed` (slot → card index) pins cards; `blocked` slots are left empty.
 * Returns cardOf: slot index → card index or -1.
 */
function match(cs, slots, fixed, blocked) {
  const cardOf = new Array(slots.length).fill(-1);
  const slotOf = new Array(cs.length).fill(-1);
  const pinned = new Set();
  for (const [si, x] of fixed) { cardOf[si] = x; slotOf[x] = si; pinned.add(x); }
  const tryFill = (si, seen, allowWild) => {
    for (let x = 0; x < cs.length; x++) {
      const c = cs[x];
      if (seen[x] || pinned.has(x) || c.kind === 'skip' || (c.kind === 'wild' && !allowWild) || !accept(slots[si], c)) continue;
      seen[x] = 1;
      if (slotOf[x] < 0 || tryFill(slotOf[x], seen, allowWild)) { slotOf[x] = si; cardOf[si] = x; return true; }
    }
    return false;
  };
  for (const allowWild of [false, true]) {
    for (let si = 0; si < slots.length; si++) {
      if (cardOf[si] >= 0 || blocked.has(si)) continue;
      tryFill(si, new Uint8Array(cs.length), allowWild);
    }
  }
  return cardOf;
}

/**
 * Fill the slots of one shape combination with the cards, requiring at least one natural card per component
 * (a group may not be all wilds). Returns { need, cardOf }: need = slots left empty.
 * When the unconstrained matching leaves a component without a natural we branch on which natural anchors it;
 * if no natural fits that component at all, one of its slots is reserved for a future natural (counts as missing).
 */
function fill(cs, slots, nComps, fixed = new Map(), waived = new Set(), blocked = new Set()) {
  const cardOf = match(cs, slots, fixed, blocked);
  for (let ci = 0; ci < nComps; ci++) {
    if (waived.has(ci)) continue;
    if (slots.some((sl, si) => sl.comp === ci && cardOf[si] >= 0 && cs[cardOf[si]].kind === 'num')) continue;
    // component ci has no natural: try anchoring each distinct natural that fits one of its free slots
    let best = null;
    const used = new Set(fixed.values());
    const tried = new Set();
    for (let x = 0; x < cs.length; x++) {
      const c = cs[x];
      if (c.kind !== 'num' || used.has(x)) continue;
      const sig = c.num + c.color;
      if (tried.has(sig)) continue;
      tried.add(sig);
      const si = slots.findIndex((sl, i) => sl.comp === ci && !fixed.has(i) && !blocked.has(i) && accept(sl, c));
      if (si < 0) continue;
      const f2 = new Map(fixed); f2.set(si, x);
      const w2 = new Set(waived); w2.add(ci);
      const r = fill(cs, slots, nComps, f2, w2, blocked);
      if (!best || r.need < best.need) best = r;
      if (best.need === 0) break;
    }
    if (!best) {
      // nothing natural fits here: reserve a slot for a card still to be drawn
      const si = slots.findIndex((sl, i) => sl.comp === ci && !fixed.has(i) && !blocked.has(i));
      const b2 = new Set(blocked); b2.add(si);
      const w2 = new Set(waived); w2.add(ci);
      best = fill(cs, slots, nComps, fixed, w2, b2);
    }
    return best;
  }
  const matched = cardOf.filter(x => x >= 0).length;
  return { need: slots.length - matched, cardOf };
}

function flattenSlots(combo) {
  const slots = [];
  combo.forEach((sh, ci) => sh.slots.forEach(sl => slots.push({ ...sl, comp: ci })));
  return slots;
}

/** Build group descriptions from a filled combination. Missing slots are null entries. */
function groupsOf(cs, combo, slots, cardOf) {
  return combo.map((sh, ci) => {
    const members = [];
    slots.forEach((sl, si) => { if (sl.comp === ci) members.push(cardOf[si] >= 0 ? cs[cardOf[si]] : null); });
    const g = { type: sh.type, key: sh.key, cards: members };
    if (sh.type === 'run') { g.lo = sh.key; g.hi = sh.key + sh.size - 1; }
    return g;
  });
}

/**
 * deficit(hand, phaseNo, opts) -> { need, groups, ways }
 *   need   minimum number of additional cards needed to complete the phase (0 = can lay down now)
 *   groups best arrangement found (cards in slot order; null = missing card)
 *   ways   how many shape combinations achieve that minimum (a rough "flexibility" measure)
 * hand: card objects (Skips are ignored).
 */
export function deficit(hand, phaseNo, opts = {}) {
  return scanMinimal(hand, phaseNo, opts, 0).best;
}

/** All minimum-size arrangements that complete the phase right now (need 0), up to `limit`. */
export function arrangements(hand, phaseNo, opts = {}, limit = 12) {
  return scanMinimal(hand, phaseNo, opts, limit).complete;
}

function scanMinimal(hand, phaseNo, opts, collect) {
  const comps = phase(phaseNo).comps;
  const cs = hand.filter(c => c.kind !== 'skip');
  let best = null, ways = 0;
  const complete = [];
  for (const combo of combos(comps, (i) => [comps[i].n], opts)) {
    const slots = flattenSlots(combo);
    const r = fill(cs, slots, combo.length);
    if (!best || r.need < best.need) { best = { need: r.need, groups: groupsOf(cs, combo, slots, r.cardOf) }; ways = 1; }
    else if (r.need === best.need) ways++;
    if (r.need === 0 && complete.length < collect) complete.push(groupsOf(cs, combo, slots, r.cardOf));
    if (best.need === 0 && ways > 8 && complete.length >= collect) break;
  }
  best.ways = ways;
  return { best, complete };
}

/**
 * Every arrangement that completes the phase using exactly the given cards (used by the AI to pick the lay-down
 * that leaves the best hand). Each entry is a groups[] array; cards beyond the minimum extend the groups.
 */
export function layDownOptions(selected, phaseNo, opts = {}, limit = 40) {
  if (selected.some(c => c.kind === 'skip')) return [];
  const comps = phase(phaseNo).comps;
  const total = selected.length;
  const minTotal = comps.reduce((a, c) => a + c.n, 0);
  if (total < minTotal) return [];
  const maxSize = (c) => c.type === 'run' ? 12 : total;
  const sizesOf = (i) => {
    const sizes = [];
    for (let s = comps[i].n; s <= Math.min(maxSize(comps[i]), total - (minTotal - comps[i].n)); s++) sizes.push(s);
    return sizes;
  };
  const out = [];
  for (const combo of combos(comps, sizesOf, opts, (sum) => sum === total)) {
    const slots = flattenSlots(combo);
    const r = fill(selected, slots, combo.length);
    if (r.need === 0) { out.push(groupsOf(selected, combo, slots, r.cardOf)); if (out.length >= limit) break; }
  }
  return out;
}

/**
 * canLayDown(selected, phaseNo, opts) -> groups[] | null. All selected cards must be used: each component gets at
 * least its minimum, extra cards may extend a group (longer run, bigger set) as the rules allow.
 */
export function canLayDown(selected, phaseNo, opts = {}) {
  const options = layDownOptions(selected, phaseNo, opts, 1);
  return options.length ? options[0] : null;
}

/** Human-readable reason why canLayDown failed. */
export function explainLayDown(selected, phaseNo, opts = {}) {
  const label = phaseLabel(phaseNo);
  if (!selected.length) return 'Select the cards that make up your phase first';
  if (selected.some(c => c.kind === 'skip')) return 'Skip cards can\'t be laid down';
  const min = phaseMinCards(phaseNo);
  if (selected.length < min) return `${label} needs at least ${min} cards (you selected ${selected.length})`;
  const d = deficit(selected, phaseNo, opts);
  if (d.need > 0) return `Those cards are ${d.need} short of ${label}`;
  return `Some selected cards don't fit into ${label} — leave the extras in your hand (you can hit them afterwards)`;
}

// ---------------------------------------------------------------- hits
// table group: { id, owner, type:'set'|'run'|'color', key, cards: [ids], lo?, hi? }  (run cards ordered low→high)

/** Ways a card can be added to a group: [] (no), ['add'] for sets/colours, ['low'|'high'...] for runs. */
export function hitOptions(group, c) {
  if (c.kind === 'skip') return [];
  if (group.type === 'set') return c.kind === 'wild' || c.num === group.key ? ['add'] : [];
  if (group.type === 'color') return c.kind === 'wild' || c.color === group.key ? ['add'] : [];
  const ends = [];
  if (c.kind === 'wild') { if (group.hi < 12) ends.push('high'); if (group.lo > 1) ends.push('low'); return ends; }
  if (c.num === group.lo - 1) ends.push('low');
  if (c.num === group.hi + 1) ends.push('high');
  return ends;
}
export function canHit(group, c) { return hitOptions(group, c).length > 0; }

/** Add card id to a group (mutates). `end` is one of hitOptions(); defaults to the first. */
export function applyHit(group, c, end) {
  const options = hitOptions(group, c);
  if (!options.length) throw new Error('card does not fit group');
  if (!options.includes(end)) end = options[0];
  if (group.type !== 'run') { group.cards.push(c.id); return group; }
  if (end === 'low') { group.cards.unshift(c.id); group.lo -= 1; }
  else { group.cards.push(c.id); group.hi += 1; }
  return group;
}

/** The number a run card stands for (wilds take the position's value). */
export function runValueAt(group, index) { return group.lo + index; }
