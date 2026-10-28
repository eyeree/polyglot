// Game tree = history. Pure; see docs/DESIGN.md.
import { deal, applyMove, legalMoves, choiceMoves, safeFoundationMoves, isWon, sameMove, DEFAULT_RULES } from './game.js';

export class GameTree {
  constructor(seed, rules = DEFAULT_RULES) {
    this.seed = seed;
    this.rules = rules;
    this.nodes = [this._mk(0, null, null)];
    this.currentId = 0;
    this._stateCache = new Map();
  }

  _mk(id, parent, move, source = 'player') {
    return { id, parent, move, children: [], lastChild: null, source, verdict: null, verdictInfo: null };
  }

  node(id) { return this.nodes[id]; }
  get current() { return this.nodes[this.currentId]; }
  get root() { return this.nodes[0]; }

  depth(id) { let d = 0; for (let n = this.nodes[id]; n.parent != null; n = this.nodes[n.parent]) d++; return d; }

  pathMoves(id) {
    const moves = [];
    for (let n = this.nodes[id]; n.parent != null; n = this.nodes[n.parent]) moves.push(n.move);
    return moves.reverse();
  }

  ancestors(id) {        // root … parent (excluding id)
    const out = [];
    for (let n = this.nodes[id]; n.parent != null; n = this.nodes[n.parent]) out.push(n.parent);
    return out.reverse();
  }

  stateAt(id) {
    if (this._stateCache.has(id)) return this._stateCache.get(id);
    const n = this.nodes[id];
    const s = n.parent == null ? deal(this.seed) : applyMove(this.stateAt(n.parent), n.move);
    if (this._stateCache.size > 2000) this._stateCache.clear();
    this._stateCache.set(id, s);
    return s;
  }

  get state() { return this.stateAt(this.currentId); }

  /** Add (or reuse) a child of `parentId` for `move`; returns child id. Does not move the cursor. */
  addChild(parentId, move, source = 'player') {
    const p = this.nodes[parentId];
    for (const cid of p.children) if (sameMove(this.nodes[cid].move, move)) return cid;
    const child = this._mk(this.nodes.length, parentId, move, source);
    this.nodes.push(child);
    p.children.push(child.id);
    return child.id;
  }

  /** Play a move from the current node. */
  play(move, source = 'player') {
    const id = this.addChild(this.currentId, move, source);
    this.nodes[this.currentId].lastChild = id;
    this.currentId = id;
    return id;
  }

  goto(id) { if (this.nodes[id]) this.currentId = id; }
  undo() { const n = this.current; if (n.parent != null) { this.currentId = n.parent; return true; } return false; }
  redo() { const n = this.current; if (n.lastChild != null) { this.currentId = n.lastChild; return true; } return false; }

  /**
   * Legal moves at a node not yet represented by a child. When a safe foundation move is
   * available the position is treated as forced (that move is never wrong), so only it counts.
   */
  unexplored(id) {
    const s = this.stateAt(id);
    const kids = this.nodes[id].children.map(c => this.nodes[c].move);
    const safe = safeFoundationMoves(s, this.rules);
    const candidates = safe.length ? safe.slice(0, 1) : legalMoves(s, this.rules);
    return candidates.filter(m => !kids.some(k => sameMove(k, m)));
  }

  /** A real decision: no safe foundation move pending and at least two choices. */
  isBranchPoint(id) {
    const s = this.stateAt(id);
    if (safeFoundationMoves(s, this.rules).length) return false;
    return choiceMoves(s, this.rules).length >= 2;
  }

  /** Nearest ancestor (strictly before `id`) that is a branch point, or null. */
  lastBranchPoint(id = this.currentId) {
    const anc = this.ancestors(id);
    for (let i = anc.length - 1; i >= 0; i--) if (this.isBranchPoint(anc[i])) return anc[i];
    return null;
  }

  /** 'won' | 'dead' | 'open' from the state alone. */
  terminal(id) {
    const s = this.stateAt(id);
    if (isWon(s)) return 'won';
    if (legalMoves(s, this.rules).length === 0) return 'dead';
    return 'open';
  }

  /** Create children for every unexplored move at `id`. Returns new child ids. */
  expand(id) {
    return this.unexplored(id).map(m => this.addChild(id, m, 'expand'));
  }

  /** Append a solver line (array of moves) below `id`; marks nodes verdict 'win'. Returns ids. */
  addLine(id, moves, verdict = 'win') {
    const ids = [];
    let cur = id;
    for (const m of moves) { cur = this.addChild(cur, m, 'solver'); this.nodes[cur].verdict = verdict; ids.push(cur); }
    return ids;
  }

  setVerdict(id, verdict, info = null) {
    const n = this.nodes[id];
    n.verdict = verdict; n.verdictInfo = info;
    if (verdict === 'win') for (const a of this.ancestors(id)) { const an = this.nodes[a]; if (an.verdict !== 'win') { an.verdict = 'win'; an.verdictInfo = an.verdictInfo || { via: id }; } }
  }

  /** Effective verdict considering ancestors (lose propagates down) and terminal states. */
  effectiveVerdict(id) {
    const n = this.nodes[id];
    if (n.verdict === 'win') return 'win';
    for (let a = n.parent; a != null; a = this.nodes[a].parent) if (this.nodes[a].verdict === 'lose') return 'lose';
    if (n.verdict) return n.verdict;
    const t = this.terminal(id);
    if (t === 'won') return 'win';
    if (t === 'dead') return 'lose';
    return null;
  }

  /** Remove a node and its subtree (never the root). Returns true if the cursor moved. */
  deleteSubtree(id) {
    if (id === 0) return false;
    const n = this.nodes[id];
    const p = this.nodes[n.parent];
    p.children = p.children.filter(c => c !== id);
    if (p.lastChild === id) p.lastChild = p.children[p.children.length - 1] ?? null;
    const doomed = new Set();
    const walk = (x) => { doomed.add(x); for (const c of this.nodes[x].children) walk(c); };
    walk(id);
    for (const d of doomed) { this.nodes[d] = null; this._stateCache.delete(d); }
    let moved = false;
    if (doomed.has(this.currentId)) { this.currentId = n.parent; moved = true; }
    this._compact();
    return moved;
  }

  _compact() {
    const remap = new Map();
    const live = [];
    for (const n of this.nodes) if (n) { remap.set(n.id, live.length); live.push(n); }
    for (const n of live) {
      n.id = remap.get(n.id);
      n.parent = n.parent == null ? null : remap.get(n.parent);
      n.children = n.children.map(c => remap.get(c));
      n.lastChild = n.lastChild == null ? null : (remap.get(n.lastChild) ?? null);
    }
    this.currentId = remap.get(this.currentId);
    this.nodes = live;
    this._stateCache.clear();
  }

  size() { return this.nodes.length; }

  toJSON() {
    return { seed: this.seed, rules: this.rules, currentId: this.currentId,
      nodes: this.nodes.map(n => ({ id: n.id, p: n.parent, m: n.move, c: n.children, l: n.lastChild, s: n.source, v: n.verdict, vi: n.verdictInfo })) };
  }

  static fromJSON(o) {
    const t = new GameTree(o.seed, o.rules || DEFAULT_RULES);
    t.nodes = o.nodes.map(n => ({ id: n.id, parent: n.p, move: n.m, children: n.c || [], lastChild: n.l ?? null, source: n.s || 'player', verdict: n.v ?? null, verdictInfo: n.vi ?? null }));
    t.currentId = o.currentId ?? 0;
    return t;
  }
}
