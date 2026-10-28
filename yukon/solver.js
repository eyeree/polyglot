// Yukon solver. Pure; the UI runs it in a worker.
// Two algorithms:
//  - 'best'  greedy best-first search on a position heuristic (default; rarely gets lost)
//  - 'dfs'   depth-first with heuristic move ordering (lower memory)
// Both use a transposition table on the canonical stateKey and stop on a node budget or time limit.
import { legalMoves, applyMove, isWon, stateKey, isSafeFoundationMove, fitsOn, rank, NCOLS, DEFAULT_RULES } from './game.js';

/** Heuristic ordering for DFS: higher score = try first. */
export function orderMoves(s, moves) {
  const scored = moves.map((m) => {
    let p = 0;
    const src = s.cols[m.from];
    const c = src[m.idx];
    const rest = m.idx;
    if (m.to === 'F') p += 100;
    if (rest > 0 && rest === s.down[m.from]) p += 60;            // flips a face-down card
    if (rest === 0) p += 35;                                        // empties a column
    if (rest > 0 && fitsOn(c, src[rest - 1])) p -= 25;              // breaks a proper sequence
    if (m.to !== 'F') {
      const n = src.length - m.idx;
      let seq = 1;
      for (let i = m.idx + 1; i < src.length; i++) { if (fitsOn(src[i], src[i - 1])) seq++; else break; }
      if (seq === n) p += 10; else p -= 5;
      if (rank(c) === 12 && s.cols[m.to].length === 0) p += 5;
      p += Math.min(n, 6);
    }
    return { m, p };
  });
  scored.sort((a, b) => b.p - a.p);
  return scored.map(x => x.m);
}

/** Position value for best-first search: bigger is better. Weights are exported for tweaking. */
export const EVAL_WEIGHTS = { found: 10, faceUp: 6, ordered: 4, empty: 3, block: 0 };
export function evaluate(s, w = EVAL_WEIGHTS) {
  let found = 0, down = 0, ordered = 0, empties = 0, blocks = 0;
  for (let i = 0; i < 4; i++) found += s.found[i] + 1;
  for (let i = 0; i < NCOLS; i++) {
    const col = s.cols[i];
    down += s.down[i];
    if (col.length === 0) empties++;
    for (let j = Math.max(1, s.down[i]); j < col.length; j++) if (fitsOn(col[j], col[j - 1])) ordered++;
    // same-suit inversions: a higher card lying above a lower one of its suit blocks that suit's foundation
    for (let j = 0; j < col.length; j++) {
      const cj = col[j];
      for (let k = j + 1; k < col.length; k++) {
        const ck = col[k];
        if (((ck / 13) | 0) === ((cj / 13) | 0) && ck % 13 > cj % 13) blocks++;
      }
    }
  }
  return found * w.found + (21 - down) * w.faceUp + ordered * w.ordered + empties * w.empty - blocks * w.block;
}

/** Children of a state with safe-foundation forcing applied. */
function successors(s, rules) {
  const all = legalMoves(s, rules);
  for (const m of all) if (isSafeFoundationMove(s, m)) return [m];
  return all;
}

/**
 * solve(state, opts) -> { result: 'win'|'lose'|'unknown', path: move[], explored, elapsedMs }
 * opts: { algorithm: 'best'|'dfs', maxNodes, timeLimitMs, rules, onProgress(explored), shouldStop() }
 */
export function solve(state, opts = {}) {
  const algo = opts.algorithm || 'auto';
  if (algo === 'dfs') return solveDFS(state, opts);
  if (algo === 'best') return solveBestFirst(state, opts);
  // auto: a short DFS probe (cheap, wins many deals instantly), then best-first with the rest of the budget
  const maxNodes = opts.maxNodes ?? 300000;
  const timeLimitMs = opts.timeLimitMs ?? 10000;
  const probe = Math.min(30000, Math.floor(maxNodes * 0.1));
  const r1 = solveDFS(state, { ...opts, maxNodes: probe, timeLimitMs: timeLimitMs * 0.2 });
  if (r1.result !== 'unknown') return r1;
  const r2 = solveBestFirst(state, { ...opts, maxNodes: maxNodes - r1.explored, timeLimitMs: timeLimitMs - r1.elapsedMs });
  return { ...r2, explored: r1.explored + r2.explored, elapsedMs: r1.elapsedMs + r2.elapsedMs };
}

export function solveDFS(state, opts = {}) {
  const maxNodes = opts.maxNodes ?? 300000;
  const timeLimitMs = opts.timeLimitMs ?? 10000;
  const rules = opts.rules ?? DEFAULT_RULES;
  const t0 = Date.now();
  const seen = new Set([stateKey(state)]);
  let explored = 0;
  const stack = [{ s: state, moves: null, i: 0, m: null }];

  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.moves === null) {
      explored++;
      if (isWon(frame.s)) return done('win');
      if ((explored & 4095) === 0) {
        if (opts.onProgress) opts.onProgress(explored);
        if (opts.shouldStop && opts.shouldStop()) return done('unknown');
        if (Date.now() - t0 > timeLimitMs) return done('unknown');
      }
      if (explored > maxNodes) return done('unknown');
      const succ = successors(frame.s, rules);
      frame.moves = succ.length === 1 ? succ : orderMoves(frame.s, succ);
      frame.i = 0;
    }
    if (frame.i >= frame.moves.length) { stack.pop(); continue; }
    const m = frame.moves[frame.i++];
    const ns = applyMove(frame.s, m);
    const key = stateKey(ns);
    if (seen.has(key)) continue;
    seen.add(key);
    stack.push({ s: ns, moves: null, i: 0, m });
  }
  return done('lose');

  function done(result) {
    return { result, path: result === 'win' ? stack.slice(1).map(f => f.m) : [], explored, elapsedMs: Date.now() - t0 };
  }
}

// --- best-first -----------------------------------------------------------------------------

class MaxHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(pri, item) {
    const a = this.a; a.push({ pri, item });
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].pri >= a[i].pri) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a; const top = a[0]; const last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let b = i;
        if (l < a.length && a[l].pri > a[b].pri) b = l;
        if (r < a.length && a[r].pri > a[b].pri) b = r;
        if (b === i) break; [a[b], a[i]] = [a[i], a[b]]; i = b;
      }
    }
    return top.item;
  }
}

export function solveBestFirst(state, opts = {}) {
  const maxNodes = opts.maxNodes ?? 300000;
  const timeLimitMs = opts.timeLimitMs ?? 10000;
  const rules = opts.rules ?? DEFAULT_RULES;
  const t0 = Date.now();
  const rootKey = stateKey(state);
  const parent = new Map([[rootKey, null]]);    // key -> [parentKey, move]
  const heap = new MaxHeap();
  heap.push(evaluate(state), { s: state, key: rootKey, depth: 0 });
  let explored = 0;

  while (heap.size) {
    const { s, key, depth } = heap.pop();
    explored++;
    if (isWon(s)) return done('win', key);
    if ((explored & 2047) === 0) {
      if (opts.onProgress) opts.onProgress(explored);
      if (opts.shouldStop && opts.shouldStop()) return done('unknown');
      if (Date.now() - t0 > timeLimitMs) return done('unknown');
    }
    if (explored > maxNodes) return done('unknown');
    for (const m of successors(s, rules)) {
      const ns = applyMove(s, m);
      const nk = stateKey(ns);
      if (parent.has(nk)) continue;
      parent.set(nk, [key, m]);
      // small depth penalty keeps paths from wandering; foundation progress dominates
      heap.push(evaluate(ns) - depth * 0.01, { s: ns, key: nk, depth: depth + 1 });
    }
  }
  return done('lose');

  function done(result, winKey) {
    const path = [];
    if (result === 'win') {
      for (let k = winKey; parent.get(k); k = parent.get(k)[0]) path.push(parent.get(k)[1]);
      path.reverse();
    }
    return { result, path, explored, elapsedMs: Date.now() - t0 };
  }
}
