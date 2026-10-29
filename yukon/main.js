// Yukon UI controller. Rendering + input only; rules live in game.js, history in tree.js.
import { h, $, clear, modal, confirm, toast, settingsPanel, drawer } from '../shared/ui.js';
import { onPress } from '../shared/pointer.js';
import { makeSettings, load, save } from '../shared/storage.js';
import { randomSeed } from '../shared/rng.js';
import { DEFAULTS, SUITS, RANKS, MIN_OVERLAP_UP } from './config.js';
import * as G from './game.js';
import { GameTree } from './tree.js';
import { SolverPool } from './solver-client.js';

const SAVE_KEY = 'yukon.save';
const settings = makeSettings('yukon.settings', DEFAULTS);
const rules = () => ({ kingsOnlyToEmpty: !!settings.get('kingsOnlyToEmpty') });

const SETTINGS_SCHEMA = [
  { key: 'fitCards', label: 'Column to fit without scrolling', type: 'range', min: 8, max: 24, step: 1, help: 'Face-up cards per column that must fit on screen; cards are sized to suit, longer columns scroll' },
  { key: 'cardScale', label: 'Card size', type: 'range', min: 0.5, max: 1, step: 0.02, help: 'Extra shrink on top of the fitted size' },
  { key: 'overlapUp', label: 'Face-up overlap', type: 'range', min: MIN_OVERLAP_UP, max: 0.5, step: 0.01, help: 'Vertical offset between face-up cards (fraction of card height); never squeezed, so the corner stays readable' },
  { key: 'overlapDown', label: 'Face-down overlap', type: 'range', min: 0.06, max: 0.3, step: 0.01 },
  { key: 'feltColor', label: 'Table colour', type: 'color' },
  { key: 'backColor', label: 'Card back colour', type: 'color' },
  { key: 'animMs', label: 'Animation (ms)', type: 'range', min: 0, max: 500, step: 20 },
  { key: 'showHints', label: 'Highlight legal destinations', type: 'bool' },
  { key: 'tapToFoundation', label: 'Tap a card to send it to its foundation', type: 'bool', help: 'When nothing is selected and the card can go up' },
  { key: 'autoSafeFoundation', label: 'Auto-play safe foundation moves', type: 'bool', help: 'Moves that can never hurt are played for you (and recorded as forced moves)' },
  { key: 'kingsOnlyToEmpty', label: 'Only Kings may fill empty columns', type: 'bool' },
  { key: 'solverAlgorithm', label: 'Solver algorithm', type: 'select', options: [{ value: 'auto', label: 'Auto (DFS probe, then best-first)' }, { value: 'best', label: 'Best-first' }, { value: 'dfs', label: 'Depth-first' }] },
  { key: 'solverMaxNodes', label: 'Solver budget (states)', type: 'select', options: [100000, 200000, 400000, 800000, 1500000].map(v => ({ value: v, label: v.toLocaleString() })) },
  { key: 'solverTimeMs', label: 'Solver time limit', type: 'select', options: [5000, 15000, 30000, 60000, 120000].map(v => ({ value: v, label: (v / 1000) + ' s' })) },
  { key: 'solverWorkers', label: 'Parallel solver workers', type: 'range', min: 1, max: 6, step: 1 },
];

// ---------------------------------------------------------------- state
let tree = null;
let selected = null;             // { col, idx }
let cardEls = new Map();         // card -> element
let positions = new Map();       // card -> { x, y, col, idx }
let L = null;                    // layout
let drag = null;
let autoTimer = null;
const solving = new Set();       // node ids being solved
const pool = new SolverPool(() => settings.get('solverWorkers'));

const board = $('#board');
const statEl = $('#stat');
let layer = null;                // scrolling layer inside the board that holds every felt element

// ---------------------------------------------------------------- persistence
function persist() {
  save(SAVE_KEY, tree.toJSON());
}
/** Every card exactly once across the columns and foundations. */
function validState(s) {
  if (!s || !Array.isArray(s.cols) || s.cols.length !== 7 || !Array.isArray(s.found) || s.found.length !== 4) return false;
  const seen = new Set();
  for (const col of s.cols) for (const c of col) { if (!Number.isInteger(c) || c < 0 || c > 51 || seen.has(c)) return false; seen.add(c); }
  for (let suit = 0; suit < 4; suit++) for (let r = 0; r <= s.found[suit]; r++) { const c = suit * 13 + r; if (seen.has(c)) return false; seen.add(c); }
  return seen.size === 52;
}

function restore() {
  const o = load(SAVE_KEY);
  if (!o || !o.nodes) return false;
  try {
    tree = GameTree.fromJSON(o);
    tree.rules = rules();
    if (!validState(tree.state)) throw new Error('corrupt save');
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------- layout & rendering
function computeLayout() {
  const W = board.clientWidth, H = board.clientHeight;
  const gap = Math.max(3, Math.round(W * 0.012));
  const byWidth = Math.floor((W - gap * 8) / 7);
  // Height limit: the foundation row plus a column of `fitCards` face-up cards must fit without scrolling.
  const u = Math.max(MIN_OVERLAP_UP, settings.get('overlapUp'));
  const n = Math.max(1, Number(settings.get('fitCards')) || DEFAULTS.fitCards);
  const byHeight = Math.floor((H - gap * 4) / (2 + (n - 1) * u) / 1.4);
  const cw = Math.max(24, Math.floor(Math.min(byWidth, byHeight) * settings.get('cardScale')));
  const ch = Math.round(cw * 1.4);
  const x0 = Math.floor((W - (cw * 7 + gap * 6)) / 2);
  const foundY = gap;
  const colTop = foundY + ch + gap * 2;
  const avail = H - colTop - gap;
  return { W, H, gap, cw, ch, x0, foundY, colTop, avail, colX: (i) => x0 + i * (cw + gap) };
}

function buildBoard() {
  clear(board);
  layer = h('div.layer');
  board.append(layer);
  cardEls = new Map();
  for (let s = 0; s < 4; s++) layer.append(h('div.slot.foundation', { data: { suit: s }, text: SUITS[s] }));
  for (let c = 0; c < 7; c++) layer.append(h('div.colzone', { data: { col: c } }));
  layer.append(h('div.board-info#info'));
  for (let c = 0; c < 52; c++) {
    const el = h('div.card' + (G.isRed(c) ? '.red' : ''), { data: { card: c } },
      h('div.corner', {}, h('span', { text: RANKS[G.rank(c)] }), h('span.s', { text: SUITS[G.suit(c)] })),
      h('div.pip', { text: SUITS[G.suit(c)] }));
    cardEls.set(c, el);
    layer.append(el);
  }
}

function applyTheme() {
  board.style.setProperty('--felt', settings.get('feltColor'));
  board.style.setProperty('--back', settings.get('backColor'));
  board.style.setProperty('--anim', settings.get('animMs') + 'ms');
}

function render(animate = true) {
  L = computeLayout();
  const s = tree.state;
  board.style.setProperty('--cw', L.cw + 'px');
  board.style.setProperty('--ch', L.ch + 'px');
  const { cw, ch, gap, colTop, avail } = L;

  for (let i = 0; i < 4; i++) {
    const el = board.querySelector(`.foundation[data-suit="${i}"]`);
    el.style.transform = `translate(${L.colX(3 + i)}px, ${L.foundY}px)`;
  }
  for (let c = 0; c < 7; c++) {
    const z = board.querySelector(`.colzone[data-col="${c}"]`);
    z.style.transform = `translate(${L.colX(c)}px, ${colTop}px)`;
    z.style.width = cw + 'px';
  }
  const info = $('#info');
  info.style.transform = `translate(${L.colX(0)}px, ${L.foundY}px)`;
  info.style.width = (cw * 3 + gap * 2) + 'px';
  const depth = tree.depth(tree.currentId);
  const foundCount = s.found.reduce((a, r) => a + r + 1, 0);
  info.innerHTML = `<b>${depth}</b> moves · <b>${foundCount}</b>/52 up<br>seed <b>${tree.seed}</b><br>tree <b>${tree.size()}</b> positions`;

  const newPos = new Map();
  const onF = new Set();
  // foundation cards
  for (let suit = 0; suit < 4; suit++) {
    for (let r = 0; r <= s.found[suit]; r++) {
      const c = suit * 13 + r;
      onF.add(c);
      newPos.set(c, { x: L.colX(3 + suit), y: L.foundY, col: 'F', idx: r, z: r + 1, down: false });
    }
  }
  // Offsets are never squeezed (the rank + suit corner must stay visible); a column taller than the
  // board makes the layer, and so the board, scroll.
  const uOff = Math.round(ch * Math.max(MIN_OVERLAP_UP, settings.get('overlapUp')));
  const dOff = Math.round(ch * settings.get('overlapDown'));
  let bottom = colTop + ch;
  for (let i = 0; i < 7; i++) {
    const col = s.cols[i];
    const nDown = s.down[i];
    let y = colTop;
    for (let j = 0; j < col.length; j++) {
      newPos.set(col[j], { x: L.colX(i), y, col: i, idx: j, z: j + 1, down: j < nDown, dOff, uOff });
      bottom = Math.max(bottom, y + ch);
      y += j < nDown ? dOff : uOff;
    }
  }
  const layerH = Math.max(L.H, bottom + gap);
  layer.style.height = layerH + 'px';
  for (let c = 0; c < 7; c++) board.querySelector(`.colzone[data-col="${c}"]`).style.height = Math.max(avail, layerH - colTop - gap) + 'px';

  for (const [c, el] of cardEls) {
    const p = newPos.get(c);
    if (!p) { el.style.display = 'none'; continue; } // not in this state (should not happen; never blank the board)
    el.style.display = '';
    const old = positions.get(c);
    const moved = !old || old.x !== p.x || old.y !== p.y;
    el.classList.toggle('notransition', !animate);
    el.classList.toggle('down', p.down);
    el.classList.remove('dragging');
    el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    if (moved && animate && old && (old.col !== p.col)) {
      el.style.zIndex = 100 + p.z;
      setTimeout(() => { if (positions.get(c) === p) el.style.zIndex = p.z; }, settings.get('animMs') + 20);
    } else el.style.zIndex = p.z;
    el.classList.toggle('selected', !!selected && p.col === selected.col && p.idx >= selected.idx);
  }
  positions = newPos;
  renderHints();
  updateButtons();
  renderStat();
}

function renderHints() {
  board.querySelectorAll('.hint').forEach(e => e.classList.remove('hint'));
  if (!selected || !settings.get('showHints')) return;
  const s = tree.state;
  for (const m of G.legalMoves(s, rules())) {
    if (m.from !== selected.col || m.idx !== selected.idx) continue;
    if (m.to === 'F') board.querySelector(`.foundation[data-suit="${G.suit(s.cols[m.from][m.idx])}"]`).classList.add('hint');
    else if (s.cols[m.to].length === 0) board.querySelector(`.colzone[data-col="${m.to}"]`).classList.add('hint');
    else cardEls.get(s.cols[m.to][s.cols[m.to].length - 1]).classList.add('hint');
  }
}

function renderStat() {
  const v = tree.effectiveVerdict(tree.currentId);
  statEl.textContent = v === 'win' ? '✓ winnable' : v === 'lose' ? '✗ lost' : v === 'unknown' ? '? undetermined' : '';
  statEl.style.color = v === 'win' ? 'var(--ok)' : v === 'lose' ? 'var(--danger)' : '';
}

function updateButtons() {
  const n = tree.current;
  $('#btn-undo').disabled = n.parent == null;
  $('#btn-redo').disabled = n.lastChild == null;
  $('#btn-branch').disabled = tree.lastBranchPoint() == null;
  const s = tree.state;
  $('#btn-finish').classList.toggle('hidden', G.isWon(s) || !G.isTriviallyWon(s));
}

// ---------------------------------------------------------------- game flow
function newGame(seed = randomSeed()) {
  tree = new GameTree(seed, rules());
  selected = null;
  positions = new Map();
  board.scrollTop = 0;
  render(false);
  persist();
  scheduleAuto();
}

function playMove(m, source = 'player') {
  tree.play(m, source);
  selected = null;
  afterChange();
}

function afterChange(animate = true) {
  render(animate);
  persist();
  scheduleAuto();
  checkEnd();
}

function scheduleAuto() {
  clearTimeout(autoTimer);
  if (!settings.get('autoSafeFoundation')) return;
  const s = tree.state;
  let safe = G.safeFoundationMoves(s, rules());
  // once everything is face-up and ordered, every foundation move is fine: just finish
  if (!safe.length && G.isTriviallyWon(s)) safe = G.legalMoves(s, rules()).filter(m => m.to === 'F');
  if (!safe.length) return;
  autoTimer = setTimeout(() => { tree.play(safe[0], 'auto'); selected = null; render(true); persist(); treeRefresh(); scheduleAuto(); checkEnd(); }, Math.max(60, settings.get('animMs') * 0.8));
}

let endShownFor = -1;
function checkEnd() {
  const s = tree.state;
  if (G.isWon(s)) {
    if (endShownFor === tree.currentId) return;
    endShownFor = tree.currentId;
    setTimeout(() => modal({
      title: 'Won! 🎉',
      body: `Finished in ${tree.depth(tree.currentId)} moves. The tree has ${tree.size()} positions.`,
      buttons: [{ label: 'Stay', value: false }, { label: 'New game', value: true, primary: true }],
    }).then(v => { if (v) newGame(); }), settings.get('animMs') + 150);
  } else if (G.legalMoves(s, rules()).length === 0) {
    toast('No moves left — try ⤺ Branch or the Tree');
  }
}

function undo() {
  let n = tree.current;
  if (n.parent == null) return;
  for (;;) {
    const src = n.source;
    tree.goto(n.parent);
    n = tree.current;
    if (src !== 'auto' || n.parent == null) break;
  }
  selected = null;
  render(true); persist(); updateButtons();
}

function redo() {
  if (!tree.redo()) return;
  selected = null;
  afterChange();
}

function gotoNode(id) {
  tree.goto(id);
  selected = null;
  afterChange();
}

function finish() {
  const step = () => {
    const s = tree.state;
    const m = G.legalMoves(s, rules()).find(x => x.to === 'F');
    if (!m) { persist(); checkEnd(); return; }
    tree.play(m, 'auto'); render(true);
    setTimeout(step, Math.max(40, settings.get('animMs') * 0.6));
  };
  clearTimeout(autoTimer);
  step();
}

// ---------------------------------------------------------------- input
function cardAt(target) {
  const el = target?.closest?.('.card');
  if (!el) return null;
  const c = Number(el.dataset.card);
  return { c, el, p: positions.get(c) };
}

function destinationAt(target, x, y) {
  // explicit element first, then geometry
  const f = target?.closest?.('.foundation');
  if (f) return 'F';
  const card = cardAt(target);
  if (card && card.p.col !== 'F') return card.p.col;
  if (card && card.p.col === 'F') return 'F';
  const z = target?.closest?.('.colzone');
  if (z) return Number(z.dataset.col);
  return destinationByPoint(...layerPoint(x, y));
}

/** Client coordinates -> coordinates inside the (scrolled) board layer. */
function layerPoint(clientX, clientY) {
  const r = board.getBoundingClientRect();
  return [clientX - r.left + board.scrollLeft, clientY - r.top + board.scrollTop];
}

/** Destination under a point given in layer coordinates. */
function destinationByPoint(bx, by) {
  if (by < L.colTop - L.gap && bx >= L.colX(3) - L.gap) return 'F';
  let best = null, bestD = Infinity;
  for (let c = 0; c < 7; c++) {
    const cx = L.colX(c) + L.cw / 2;
    const d = Math.abs(bx - cx);
    if (d < bestD) { bestD = d; best = c; }
  }
  return bestD <= L.cw ? best : null;
}

function findMove(from, idx, to) {
  return G.legalMoves(tree.state, rules()).find(m => m.from === from && m.idx === idx && (to === 'F' ? m.to === 'F' : m.to === to)) || null;
}

function tryMove(from, idx, to) {
  if (to == null) return false;
  const m = findMove(from, idx, to);
  if (!m) return false;
  playMove(m);
  return true;
}

onPress(board, {
  onTap(i) {
    clearTimeout(autoTimer); // give the user a beat; auto resumes after the move
    const card = cardAt(i.downTarget);
    const s = tree.state;
    if (!selected) {
      if (card && card.p.col !== 'F' && !card.p.down) {
        const col = s.cols[card.p.col];
        if (settings.get('tapToFoundation') && card.p.idx === col.length - 1) {
          const fm = findMove(card.p.col, card.p.idx, 'F');
          if (fm) { playMove(fm); return; }
        }
        selected = { col: card.p.col, idx: card.p.idx };
        render(false);
      }
      scheduleAuto();
      return;
    }
    // something is selected: try to move it to the tapped destination
    if (card && card.p.col === selected.col && card.p.idx >= selected.idx) { selected = null; render(false); scheduleAuto(); return; }
    const dest = destinationAt(i.downTarget, i.clientX, i.clientY);
    if (tryMove(selected.col, selected.idx, dest)) return;
    if (card && card.p.col !== 'F' && !card.p.down) { selected = { col: card.p.col, idx: card.p.idx }; render(false); }
    else { selected = null; render(false); }
    scheduleAuto();
  },
  onDragStart(i) {
    const card = cardAt(i.downTarget);
    if (!card || card.p.col === 'F' || card.p.down) {
      // Not a movable card: dragging the felt (or a face-down card) scrolls a board taller than the screen.
      drag = { scroll: true, top0: board.scrollTop };
      return true;
    }
    clearTimeout(autoTimer);
    const col = tree.state.cols[card.p.col];
    const cards = col.slice(card.p.idx);
    drag = { col: card.p.col, idx: card.p.idx, cards, scroll0: board.scrollTop, dx: 0, dy: 0, clientY: i.clientY };
    cards.forEach((c, k) => { const el = cardEls.get(c); el.classList.add('dragging'); el.style.zIndex = 500 + k; });
    selected = null;
    board.querySelectorAll('.selected').forEach(e => e.classList.remove('selected'));
    return true;
  },
  onDragMove(i, dx, dy) {
    if (!drag) return;
    if (drag.scroll) { board.scrollTop = drag.top0 - dy; return; }
    drag.dx = dx; drag.dy = dy; drag.clientY = i.clientY;
    positionDragged();
    edgeAutoScroll();
  },
  onDragEnd(i, dx, dy, cancelled) {
    if (!drag) return;
    const d = drag; drag = null;
    stopAutoScroll();
    if (d.scroll) return;
    if (!cancelled) {
      // drop target: by the top card's centre position, falling back to the pointer
      const p0 = positions.get(d.cards[0]);
      const sdy = dy + (board.scrollTop - d.scroll0);
      let dest = destinationByPoint(p0.x + dx + L.cw / 2, p0.y + sdy + L.ch / 2);
      if (dest === d.col) dest = destinationByPoint(...layerPoint(i.clientX, i.clientY));
      if (dest !== d.col && tryMove(d.col, d.idx, dest)) return;
    }
    render(true);
    scheduleAuto();
  },
});

/** Keep the dragged cards under the finger, allowing for any scrolling since the drag began. */
function positionDragged() {
  if (!drag || drag.scroll) return;
  const sdy = drag.dy + (board.scrollTop - drag.scroll0);
  for (const c of drag.cards) { const p = positions.get(c); cardEls.get(c).style.transform = `translate(${p.x + drag.dx}px, ${p.y + sdy}px)`; }
}

// Holding a dragged card near the top or bottom edge scrolls the board under it.
const EDGE = 40;                 // px band at each edge
let autoScrollRaf = null;
function edgeVelocity() {
  if (!drag || drag.scroll) return 0;
  const r = board.getBoundingClientRect(), y = drag.clientY;
  if (y < r.top + EDGE) return -(r.top + EDGE - y) / EDGE;
  if (y > r.bottom - EDGE) return (y - (r.bottom - EDGE)) / EDGE;
  return 0;
}
function edgeAutoScroll() {
  if (autoScrollRaf || !edgeVelocity()) return;
  const step = () => {
    autoScrollRaf = null;
    const v = edgeVelocity();
    if (!v) return;
    // Cap at the layer's own height: cards dragged past the bottom edge extend the scrollable area.
    const maxTop = Math.max(0, layer.offsetHeight - board.clientHeight);
    const before = board.scrollTop;
    board.scrollTop = Math.max(0, Math.min(maxTop, before + v * 12));
    if (board.scrollTop === before) return; // reached the end
    positionDragged();
    autoScrollRaf = requestAnimationFrame(step);
  };
  autoScrollRaf = requestAnimationFrame(step);
}
function stopAutoScroll() { if (autoScrollRaf) cancelAnimationFrame(autoScrollRaf); autoScrollRaf = null; }

$('#btn-undo').onclick = undo;
$('#btn-redo').onclick = redo;
$('#btn-branch').onclick = () => { const id = tree.lastBranchPoint(); if (id == null) toast('No earlier branch point'); else { gotoNode(id); toast(`Back to move ${tree.depth(id)} — ${G.choiceMoves(tree.state, rules()).length} options here`); } };
$('#btn-tree').onclick = () => openTree();
$('#btn-solve').onclick = () => solveNode(tree.currentId, true);
$('#btn-finish').onclick = finish;
$('#btn-menu').onclick = showMenu;

window.addEventListener('resize', () => render(false));
window.addEventListener('keydown', (e) => {
  if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (e.key === 'Escape') { selected = null; render(false); }
});

// ---------------------------------------------------------------- menu & settings
async function showMenu() {
  const choice = await modal({
    title: 'Yukon',
    body: h('div.muted', { text: `Seed ${tree.seed} · ${tree.depth(tree.currentId)} moves · ${tree.size()} positions in tree` }),
    buttons: [
      { label: 'Settings', value: 'settings' },
      { label: 'Help', value: 'help' },
      { label: 'Restart deal', value: 'restart' },
      { label: 'New (seed…)', value: 'seed' },
      { label: 'New game', value: 'new', primary: true },
    ],
  });
  if (choice === 'new') { if (tree.size() <= 1 || await confirm('Start a new deal? The current tree is discarded.', { ok: 'New game' })) newGame(); }
  else if (choice === 'restart') gotoNode(0);
  else if (choice === 'seed') {
    const input = h('input', { type: 'number', value: tree.seed, style: { width: '100%', padding: '8px', fontSize: '16px' } });
    const ok = await modal({ title: 'Deal seed', body: h('div', {}, h('p.muted', { text: 'Same seed = same deal. Useful for retrying a specific game.' }), input), buttons: [{ label: 'Cancel', value: false }, { label: 'Deal', value: true, primary: true }] });
    if (ok) newGame(Number(input.value) >>> 0);
  }
  else if (choice === 'settings') openSettings();
  else if (choice === 'help') showHelp();
}

function openSettings() {
  const d = drawer({ title: 'Settings' });
  d.body.append(settingsPanel(SETTINGS_SCHEMA, settings, { onReset: () => { d.close(); openSettings(); } }));
  d.open();
}

settings.onChange((k) => {
  applyTheme();
  if (k === 'kingsOnlyToEmpty') tree.rules = rules();
  render(false);
  if (k === 'autoSafeFoundation') scheduleAuto();
});

function showHelp() {
  modal({
    title: 'How this works', wide: true,
    body: h('div', { style: { lineHeight: '1.5' } },
      h('p', {}, h('b', {}, 'Yukon: '), 'build the four foundations A→K by suit. Any face-up card and everything on top of it can move onto a card of the opposite colour one rank higher, in any order. Only Kings fill empty columns. Exposed face-down cards flip.'),
      h('p', {}, h('b', {}, 'Tree: '), 'every move you make is a node. Undo keeps the branch, so playing a different move from an earlier position creates a new branch. ', h('b', {}, '⤺ Branch'), ' jumps back to the last position where you had a real choice (forced foundation moves don\'t count). Alternatives you never tried are listed as dimmed "+" rows; tap one to play it from that position.'),
      h('p', {}, h('b', {}, 'Solve: '), 'searches from the current position. ✓ means a winning line exists (it is added to the tree so you can follow it), ✗ means every continuation has been exhausted and loses, ? means the budget ran out. "Analyse choices" on a tree row solves each alternative so you can see which choice keeps the game winnable.'),
      h('p', {}, h('b', {}, 'Rows: '), '● current · ○ on your path · ⚖ a destination with more than one candidate card · ★ won · ⊘ no moves left.'),
      h('p', {}, h('b', {}, 'Long columns: '), 'cards are never squeezed together, so a column taller than the screen scrolls. Drag on the felt or a face-down card (or use the wheel) to scroll; holding a dragged card near the top or bottom edge scrolls too. Settings sets how many face-up cards must fit without scrolling.'),
    ),
  });
}

// ---------------------------------------------------------------- solver
function solverOpts() {
  return { algorithm: settings.get('solverAlgorithm'), maxNodes: settings.get('solverMaxNodes'), timeLimitMs: settings.get('solverTimeMs'), rules: rules() };
}

/** Solve a node; with `interactive` shows a progress modal and a result modal. */
async function solveNode(id, interactive = false) {
  if (solving.has(id)) { toast('Already solving that position'); return null; }
  const s = tree.stateAt(id);
  if (G.isWon(s)) { if (interactive) toast('Already won'); return 'win'; }
  solving.add(id);
  treeRefresh();
  const countEl = h('div.count', { text: '0' });
  let cancelled = false;
  const job = pool.run({ seed: tree.seed, moves: tree.pathMoves(id), opts: solverOpts() }, (n) => { countEl.textContent = n.toLocaleString() + ' positions'; });
  let closeProgress = null;
  if (interactive) {
    const backdrop = h('div.modal-backdrop', {}, h('div.modal', {},
      h('h2.modal-title', { text: 'Solving…' }),
      h('div.progress', {}, countEl, h('div.muted', { text: `budget ${settings.get('solverMaxNodes').toLocaleString()} positions / ${settings.get('solverTimeMs') / 1000} s` })),
      h('div.modal-buttons', {}, h('button.btn', { text: 'Cancel', onClick: () => { cancelled = true; job.cancel(); } }))));
    document.body.append(backdrop);
    closeProgress = () => backdrop.remove();
  }
  const res = await job.promise;
  solving.delete(id);
  closeProgress?.();
  if (res.result === 'cancelled' || cancelled) { treeRefresh(); return null; }
  let lineIds = [];
  if (res.result === 'win') {
    lineIds = tree.addLine(id, res.path);
    tree.setVerdict(id, 'win', { explored: res.explored, len: res.path.length });
  } else {
    tree.setVerdict(id, res.result, { explored: res.explored });
  }
  persist(); render(false); treeRefresh();
  if (interactive) {
    const msg = res.result === 'win' ? `Winnable from here: a ${res.path.length}-move line was added to the tree (${res.explored.toLocaleString()} positions searched).`
      : res.result === 'lose' ? `Not winnable from here — every continuation was exhausted (${res.explored.toLocaleString()} positions). Use ⤺ Branch to go back to a choice.`
      : `Undetermined: budget exhausted after ${res.explored.toLocaleString()} positions. Raise the solver budget in Settings and try again, or play on.`;
    const v = await modal({ title: res.result === 'win' ? '✓ Winnable' : res.result === 'lose' ? '✗ Not winnable' : '? Unknown', body: msg,
      buttons: res.result === 'win' ? [{ label: 'OK', value: false }, { label: 'Show in tree', value: true, primary: true }] : [{ label: 'OK', value: false, primary: true }] });
    if (v) { expanded.add(id); for (const x of lineIds) expanded.add(x); openTree(); }
  }
  return res.result;
}

/** Expand all moves of a node and solve every child. */
async function analyseChoices(id) {
  tree.expand(id);
  persist(); treeRefresh();
  const kids = tree.node(id).children.filter(c => !tree.effectiveVerdict(c));
  toast(`Analysing ${kids.length} option${kids.length === 1 ? '' : 's'}…`);
  await Promise.all(kids.map(c => solveNode(c, false)));
  toast('Analysis done');
}

// ---------------------------------------------------------------- tree drawer
let treeDrawer = null;
const expanded = new Set();     // node ids whose children are shown even if off-path
const altsOpen = new Set();     // node ids whose unexplored alternatives are shown
const chainsOpen = new Set();   // chain-head ids expanded

function openTree() {
  if (!treeDrawer) treeDrawer = drawer({ title: 'Game tree' });
  treeDrawer.el.classList.add('tree-drawer');
  treeDrawer.open();
  renderTree();
}
function treeRefresh() { if (treeDrawer && treeDrawer.isOpen()) renderTree(); }

function labelFor(id) {
  const n = tree.node(id);
  if (n.parent == null) return 'Deal';
  return G.moveLabel(tree.stateAt(n.parent), n.move);
}
function colorize(label) {
  // wrap red suits for colour
  return label.replace(/([^\s]*[♥♦])/g, '<span class="red">$1</span>');
}

function verdictGlyph(id) {
  const v = tree.effectiveVerdict(id);
  if (solving.has(id)) return h('span.v.solving', { text: '◌', title: 'solving…' });
  const t = tree.terminal(id);
  if (t === 'won') return h('span.v.win', { text: '★', title: 'won' });
  if (t === 'dead') return h('span.v.lose', { text: '⊘', title: 'no moves left' });
  if (v === 'win') return h('span.v.win', { text: '✓', title: 'winnable' });
  if (v === 'lose') return h('span.v.lose', { text: '✗', title: 'not winnable' });
  if (v === 'unknown') return h('span.v.unknown', { text: '?', title: 'undetermined' });
  return h('span.v', { text: '' });
}

function renderTree() {
  const body = treeDrawer.body;
  clear(body);
  const cur = tree.currentId;
  const pathSet = new Set([cur, ...tree.ancestors(cur)]);
  const nBranch = [...pathSet].filter(id => id !== cur && tree.isBranchPoint(id)).length;

  body.append(h('div.tree-summary', {},
    h('span', { text: `Move ${tree.depth(cur)} · ${tree.size()} positions · ${nBranch} branch point${nBranch === 1 ? '' : 's'} on your path` })));
  body.append(h('div.tree-actions', {},
    h('button.btn', { text: 'Solve here', onClick: () => solveNode(cur, true) }),
    h('button.btn', { text: 'Analyse choices', title: 'Solve every alternative move from the current position', onClick: () => analyseChoices(cur) }),
    h('button.btn', { text: 'Expand all here', onClick: () => { tree.expand(cur); altsOpen.delete(cur); persist(); renderTree(); } }),
    h('button.btn', { text: '⤺ Branch', onClick: () => { const id = tree.lastBranchPoint(); if (id != null) gotoNode(id); } }),
  ));

  const rows = h('div.tree-rows');
  body.append(rows);

  const addRow = (opts) => {
    const { id, indent, cls = '', label, onTap, onMore, tick = '', count = '', ghost = false, verdict = true } = opts;
    const row = h('div.trow' + (cls ? '.' + cls.split(' ').join('.') : ''), { style: { paddingLeft: (4 + Math.min(indent, 14) * 14) + 'px' } },
      h('span.tick', { text: tick }),
      h('span.lbl', { html: colorize(label) }),
      count !== '' ? h('span.n', { text: count }) : null,
      verdict && id != null && !ghost ? verdictGlyph(id) : null,
      onMore ? h('button.btn.more', { text: '⋯', onClick: (e) => { e.stopPropagation(); onMore(); } }) : null,
    );
    row.addEventListener('click', onTap);
    rows.append(row);
    return row;
  };

  const visit = (id, indent) => {
    const n = tree.node(id);
    const isCur = id === cur, onPath = pathSet.has(id);
    const state = tree.stateAt(id);
    const contested = n.parent != null && isContested(n.parent, n.move);
    const chainEnd = chainEndOf(id);   // last id of a forced chain starting at id (id itself if none)
    const chainLen = chainEnd === id ? 0 : tree.depth(chainEnd) - tree.depth(id);

    addRow({
      id, indent, label: labelFor(id),
      cls: (isCur ? 'current ' : '') + (onPath ? 'onpath ' : '') + (contested ? 'contested' : ''),
      tick: isCur ? '●' : onPath ? '○' : '·',
      count: n.parent == null ? '' : String(tree.depth(id)),
      onTap: () => { gotoNode(id); renderTree(); },
      onMore: () => nodeMenu(id),
    });

    // forced chain: compress unless opened or the chain contains the current node
    if (chainLen > 0) {
      // expand the chain only when the current node sits inside it (strictly after the head)
      const chainHasCur = cur !== id && tree.depth(cur) <= tree.depth(chainEnd) && isDescendantOf(cur, id);
      if (chainsOpen.has(id) || chainHasCur) {
        let x = n.children[0];
        for (;;) {
          const xn = tree.node(x);
          const xc = x === cur;
          addRow({ id: x, indent: indent + 1, label: labelFor(x), cls: 'chain ' + (xc ? 'current ' : '') + (pathSet.has(x) ? 'onpath' : ''), tick: xc ? '●' : pathSet.has(x) ? '○' : '·', count: String(tree.depth(x)), onTap: () => { gotoNode(x); renderTree(); }, onMore: () => nodeMenu(x) });
          if (x === chainEnd) break;
          x = xn.children[0];
        }
        if (chainsOpen.has(id) && !chainHasCur) addRow({ indent: indent + 1, cls: 'toggle', label: '▴ collapse forced moves', onTap: () => { chainsOpen.delete(id); renderTree(); }, verdict: false });
      } else {
        addRow({ indent: indent + 1, cls: 'chain', label: `▾ ${chainLen} forced move${chainLen === 1 ? '' : 's'}…`, onTap: () => { chainsOpen.add(id); renderTree(); }, verdict: false });
      }
      // continue from the chain's end
      visitChildren(chainEnd, indent, tree.node(chainEnd), tree.stateAt(chainEnd));
      return;
    }
    visitChildren(id, indent, n, state);
  };

  const visitChildren = (id, indent, n, state) => {
    const isCur = id === cur, onPath = pathSet.has(id);
    const kids = n.children;
    const unexplored = tree.unexplored(id);
    const childIndent = indent + (kids.length + (unexplored.length ? 1 : 0) > 1 ? 1 : 0);
    // untried alternatives first, right under the node they branch from
    if (unexplored.length) {
      const open = isCur || altsOpen.has(id);
      if (!open) {
        addRow({ indent: childIndent, cls: 'toggle', label: `▸ ${unexplored.length} untried move${unexplored.length === 1 ? '' : 's'}`, onTap: () => { altsOpen.add(id); renderTree(); }, verdict: false });
      } else {
        const groups = G.movesByDestination(state, unexplored);
        for (const m of unexplored) {
          const k = G.destKey(state, m);
          const cont = groups.get(k).length + n.children.filter(c => G.destKey(state, tree.node(c).move) === k).length > 1;
          addRow({ indent: childIndent, cls: 'ghost' + (cont ? ' contested' : ''), ghost: true, label: G.moveLabel(state, m), onTap: () => { tree.goto(id); playMove(m); renderTree(); } });
        }
        if (!isCur) addRow({ indent: childIndent, cls: 'toggle', label: '▴ hide untried moves', onTap: () => { altsOpen.delete(id); renderTree(); }, verdict: false });
      }
    }
    const showKids = onPath || expanded.has(id);
    if (kids.length && !showKids) {
      addRow({ indent: childIndent, cls: 'toggle', label: `▸ ${kids.length} continuation${kids.length === 1 ? '' : 's'}`, onTap: () => { expanded.add(id); renderTree(); }, verdict: false });
    } else {
      for (const c of kids) visit(c, childIndent);
      if (!onPath && kids.length) addRow({ indent: childIndent, cls: 'toggle', label: '▴ collapse', onTap: () => { expanded.delete(id); renderTree(); }, verdict: false });
    }
  };

  visit(0, 0);
  body.append(h('div.legend', { html: '● current · ○ on your path · + untried move · ⚖ contested destination (several cards could go there) · ✓ winnable · ✗ lost · ? undetermined · ★ won · ⊘ dead end' }));

  // scroll current row into view
  const curRow = rows.querySelector('.trow.current');
  if (curRow) curRow.scrollIntoView({ block: 'center' });
}

function isDescendantOf(id, anc) {
  for (let x = id; x != null; x = tree.node(x).parent) if (x === anc) return true;
  return false;
}

/** Follow single-child, non-branch-point nodes; returns the last node of the forced chain (or id). */
function chainEndOf(id) {
  let x = id;
  for (let guard = 0; guard < 10000; guard++) {
    const n = tree.node(x);
    if (n.children.length !== 1) return x;
    const next = n.children[0];
    // the step is "forced" if the position at x has no other legal choice
    if (tree.unexplored(x).length > 0 || tree.isBranchPoint(x)) return x;
    x = next;
  }
  return x;
}

function isContested(parentId, move) {
  const s = tree.stateAt(parentId);
  const k = G.destKey(s, move);
  return G.legalMoves(s, tree.rules).filter(m => G.destKey(s, m) === k).length > 1;
}

async function nodeMenu(id) {
  const n = tree.node(id);
  const v = tree.effectiveVerdict(id);
  const info = n.verdictInfo ? ` · ${(n.verdictInfo.explored ?? 0).toLocaleString()} positions searched` : '';
  const choice = await modal({
    title: labelFor(id),
    body: h('div.muted', { text: `Move ${tree.depth(id)} · ${n.children.length} continuation(s) · ${tree.unexplored(id).length} untried · ${v ? 'verdict: ' + v : 'unsolved'}${info}` }),
    buttons: [
      { label: 'Go here', value: 'goto', primary: true },
      { label: 'Solve from here', value: 'solve' },
      { label: 'Analyse choices', value: 'analyse' },
      { label: 'Expand all moves', value: 'expand' },
      id !== 0 ? { label: 'Delete branch', value: 'delete' } : null,
    ].filter(Boolean),
  });
  if (choice === 'goto') gotoNode(id);
  else if (choice === 'solve') solveNode(id, true);
  else if (choice === 'analyse') analyseChoices(id);
  else if (choice === 'expand') { tree.expand(id); altsOpen.delete(id); persist(); }
  else if (choice === 'delete') {
    if (await confirm('Delete this move and everything after it?', { ok: 'Delete' })) {
      const moved = tree.deleteSubtree(id);
      expanded.clear(); altsOpen.clear(); chainsOpen.clear();
      if (moved) afterChange(); else { persist(); render(false); }
    }
  }
  treeRefresh();
}

// ---------------------------------------------------------------- boot
// debug/test hook
window.__yukon = { get tree() { return tree; }, G, settings, playMove, gotoNode, solveNode, render, newGame };
buildBoard();
applyTheme();
if (!restore()) tree = new GameTree(randomSeed(), rules());
render(false);
persist();
scheduleAuto();
