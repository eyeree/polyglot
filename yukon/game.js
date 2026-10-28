// Yukon solitaire rules. Pure: no DOM. See docs/DESIGN.md.
import { makeRng } from '../shared/rng.js';
import { SUITS, RANKS } from './config.js';

export const rank = (c) => c % 13;            // 0=A … 12=K
export const suit = (c) => (c / 13) | 0;      // 0♠ 1♥ 2♦ 3♣
export const isRed = (c) => { const s = suit(c); return s === 1 || s === 2; };
export const cardName = (c) => RANKS[rank(c)] + SUITS[suit(c)];
export const NCOLS = 7;

export const DEFAULT_RULES = { kingsOnlyToEmpty: true };

export function deal(seed) {
  const rng = makeRng(seed);
  const deck = rng.shuffle([...Array(52).keys()]);
  const cols = [], down = [];
  let p = 0;
  for (let i = 0; i < NCOLS; i++) {
    const nDown = i === 0 ? 0 : i;
    const nUp = i === 0 ? 1 : 5;
    cols.push(deck.slice(p, p + nDown + nUp));
    p += nDown + nUp;
    down.push(nDown);
  }
  return { cols, down, found: [-1, -1, -1, -1] };
}

export function cloneState(s) {
  return { cols: s.cols.map(c => c.slice()), down: s.down.slice(), found: s.found.slice() };
}

export function isWon(s) { return s.found.every(r => r === 12); }

/** True when a card at `c` could legally sit on `top` in the tableau. */
export function fitsOn(c, top) { return rank(top) === rank(c) + 1 && isRed(top) !== isRed(c); }

export function legalMoves(s, rules = DEFAULT_RULES) {
  const moves = [];
  const { cols, down, found } = s;
  for (let f = 0; f < NCOLS; f++) {
    const col = cols[f];
    if (!col.length) continue;
    const top = col[col.length - 1];
    if (found[suit(top)] === rank(top) - 1) moves.push({ from: f, idx: col.length - 1, to: 'F' });
  }
  const firstEmpty = cols.findIndex(c => c.length === 0);
  for (let f = 0; f < NCOLS; f++) {
    const col = cols[f];
    for (let i = down[f]; i < col.length; i++) {
      const c = col[i];
      for (let t = 0; t < NCOLS; t++) {
        if (t === f) continue;
        const tc = cols[t];
        if (tc.length === 0) {
          if (t !== firstEmpty) continue;              // all empty columns are equivalent
          if (rules.kingsOnlyToEmpty && rank(c) !== 12) continue;
          if (i === 0) continue;                       // whole column → other empty column: pointless
          moves.push({ from: f, idx: i, to: t });
        } else if (fitsOn(c, tc[tc.length - 1])) {
          moves.push({ from: f, idx: i, to: t });
        }
      }
    }
  }
  return moves;
}

export function applyMove(s, m) {
  const cols = s.cols.slice();
  const down = s.down.slice();
  const found = s.found.slice();
  const src = cols[m.from];
  const moving = src.slice(m.idx);
  const rest = src.slice(0, m.idx);
  cols[m.from] = rest;
  if (rest.length > 0 && rest.length === down[m.from]) down[m.from]--;   // flip exposed card
  if (m.to === 'F') found[suit(moving[0])] = rank(moving[0]);
  else cols[m.to] = cols[m.to].concat(moving);
  return { cols, down, found };
}

export function sameMove(a, b) { return a.from === b.from && a.idx === b.idx && a.to === b.to; }

/** Canonical compact key: column order doesn't matter, so columns are sorted. One char per card. */
export function stateKey(s) {
  const parts = new Array(NCOLS);
  for (let i = 0; i < NCOLS; i++) {
    const col = s.cols[i];
    let str = String.fromCharCode(48 + s.down[i]);
    for (let j = 0; j < col.length; j++) str += String.fromCharCode(48 + col[j]);
    parts[i] = str;
  }
  parts.sort();
  return parts.join('|') + '#' + String.fromCharCode(50 + s.found[0], 50 + s.found[1], 50 + s.found[2], 50 + s.found[3]);
}

export function replay(seed, moves) {
  let s = deal(seed);
  for (const m of moves) s = applyMove(s, m);
  return s;
}

/**
 * Foundation moves that can never hurt: the card is an A/2, or both opposite-colour cards of one
 * rank lower are already on their foundations (so nothing will ever need this card as a target).
 */
export function isSafeFoundationMove(s, m) {
  if (m.to !== 'F') return false;
  const c = s.cols[m.from][m.idx];
  const r = rank(c);
  if (r <= 1) return true;
  const opp = isRed(c) ? [0, 3] : [1, 2];
  return s.found[opp[0]] >= r - 1 && s.found[opp[1]] >= r - 1;
}

export function safeFoundationMoves(s, rules) {
  return legalMoves(s, rules).filter(m => isSafeFoundationMove(s, m));
}

/** Legal moves excluding safe foundation moves (the ones that represent real choices). */
export function choiceMoves(s, rules) {
  return legalMoves(s, rules).filter(m => !isSafeFoundationMove(s, m));
}

/** Destination key: a column index, or the foundation of the moved card's suit. */
export function destKey(s, m) { return m.to === 'F' ? 'F' + suit(s.cols[m.from][m.idx]) : String(m.to); }

/** Group moves by destination; destinations with >1 candidate source are "contested". */
export function movesByDestination(s, moves) {
  const groups = new Map();
  for (const m of moves) {
    const k = destKey(s, m);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  return groups;
}

export function moveLabel(s, m) {
  const col = s.cols[m.from];
  const c = col[m.idx];
  const n = col.length - m.idx;
  const head = cardName(c) + (n > 1 ? ` +${n - 1}` : '');
  if (m.to === 'F') return `${head} → ${SUITS[suit(c)]} found.`;
  const tc = s.cols[m.to];
  return `${head} → ${tc.length ? cardName(tc[tc.length - 1]) : 'empty'}`;
}

/** Everything face-up and every column a proper descending alternating sequence → trivially finishable. */
export function isTriviallyWon(s) {
  if (s.down.some(d => d > 0)) return false;
  for (const col of s.cols) for (let i = 1; i < col.length; i++) if (!fitsOn(col[i], col[i - 1])) return false;
  return true;
}

/** Longest proper sequence ending at the top of a column (for heuristics). */
export function topSequenceLength(col, from = 0) {
  let n = 0;
  for (let i = col.length - 1; i >= from; i--) {
    if (i === col.length - 1 || fitsOn(col[i + 1], col[i])) n++; else break;
  }
  return n;
}
