// Blocks UI controller. Rendering + input only; rules live in game.js.
import { h, $, clear, modal, confirm, toast, settingsPanel, drawer } from '../shared/ui.js';
import { onPress, elementAt } from '../shared/pointer.js';
import { makeSettings, load, save } from '../shared/storage.js';
import { randomSeed } from '../shared/rng.js';
import { DEFAULTS, SHAPE_TYPES, PALETTE } from './config.js';
import * as G from './game.js';

const SAVE_KEY = 'blocks.save';
const BEST_KEY = 'blocks.best';
const LIFT = 60;                 // px the drag ghost floats above the finger (touch/pen only)
const settings = makeSettings('blocks.settings', DEFAULTS);
const RULE_KEYS = ['rotationCost', 'rotationPointsPerLine', 'clearMultiplier', 'allowSwap'];
const cfg = () => ({
  gridSize: Number(settings.get('gridSize')),
  rotationCost: Number(settings.get('rotationCost')),
  rotationPointsPerLine: Number(settings.get('rotationPointsPerLine')),
  clearMultiplier: Number(settings.get('clearMultiplier')),
  allowSwap: !!settings.get('allowSwap'),
  startRotationPoints: Number(settings.get('startRotationPoints')) || 0,
});

const SETTINGS_SCHEMA = [
  { key: 'gridSize', label: 'Grid size', type: 'select', options: [8, 10, 12].map(v => ({ value: v, label: `${v} × ${v}` })), help: 'Applies to the next new game' },
  { key: 'rotationCost', label: 'Rotation cost', type: 'range', min: 0, max: 6, step: 1, help: 'Points charged when a block is placed in a rotation other than the one it was dealt' },
  { key: 'rotationPointsPerLine', label: 'Rotation points per line', type: 'range', min: 0, max: 5, step: 1 },
  { key: 'clearMultiplier', label: 'Clear multiplier', type: 'range', min: 1, max: 6, step: 1, help: 'Clear score = cells × lines × multiplier' },
  { key: 'allowSwap', label: 'Swap with the side block', type: 'bool', help: 'Dropping a tray block on an occupied side slot swaps the two' },
  { key: 'animMs', label: 'Animation (ms)', type: 'range', min: 0, max: 250, step: 10 },
  { key: 'cellGap', label: 'Cell gap (px)', type: 'range', min: 0, max: 6, step: 1 },
  ...SHAPE_TYPES.map(t => ({ key: 'color' + t, label: `${t} block colour`, type: 'color' })),
];

// ---------------------------------------------------------------- state
let state = null;
let best = Number(load(BEST_KEY, 0)) || 0;
let selected = null;             // tray index | 'side' | null
let drag = null;                 // see onDragStart
let L = null;                    // layout
let pendingClear = null;         // { cells: [[x, y, type]] } flashing until clearTimer fires
let clearTimer = null;
let justPlaced = null;           // cells to animate on the next board render
let overShownFor = null;
let cellEls = [];                // [y][x] -> element
let hl = [];                     // highlighted cell elements during a drag

const main = $('#main'), board = $('#board'), tray = $('#tray'), trayWrap = $('#tray-wrap'), actions = $('#actions'), pop = $('#pop');
const sideSlot = $('.slot.side');

const colorOf = (type) => settings.get('color' + type) || PALETTE[type] || '#888';
const parseSource = (v) => (v === 'side' ? 'side' : Number(v));

// ---------------------------------------------------------------- persistence
function persist() { save(SAVE_KEY, state); }
function restore() {
  const s = load(SAVE_KEY);
  if (!s || !Array.isArray(s.board) || !Array.isArray(s.tray) || typeof s.seed !== 'number') return false;
  state = s;
  return true;
}
function updateBest() {
  if (state.score > best) { best = state.score; save(BEST_KEY, best); }
}

// ---------------------------------------------------------------- layout & rendering
function buildBoard(n) {
  clear(board);
  cellEls = [];
  for (let y = 0; y < n; y++) {
    const row = [];
    for (let x = 0; x < n; x++) {
      const el = h('div.cell', { data: { x, y } });
      row.push(el);
      board.append(el);
    }
    cellEls.push(row);
  }
}

function computeLayout() {
  const n = state.board.length;
  const gap = Number(settings.get('cellGap'));
  const miniGap = Math.max(1, Math.round(gap * 0.7));
  const mainW = main.clientWidth || 390, mainH = main.clientHeight || 700;
  const maxW = mainW - 32;
  const trayHeightFor = (px) => {
    const cell = Math.floor((px - (n + 1) * gap) / n);
    const slotW = (px - 3 * 8 - 8) / 4;
    const mini = Math.max(6, Math.min(Math.round(cell * 0.6), Math.floor((slotW - 12 - 3 * miniGap) / 4)));
    const slotH = 4 * mini + 3 * miniGap + 16;
    return { cell, mini, slotH, trayH: slotH + 10 + 44 };
  };
  // Largest board that still leaves room for the tray (whose height grows with the cell size).
  const fits = (px) => px + trayHeightFor(px).trayH + 24 + 12 <= mainH;
  let lo = 160, hi = Math.max(160, maxW);
  if (fits(hi)) lo = hi;
  else while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (fits(mid)) lo = mid; else hi = mid; }
  const px = lo;
  const { cell, mini, slotH } = trayHeightFor(px);
  const boardPx = n * cell + (n + 1) * gap;
  return { n, gap, cell, mini, miniGap, slotH, boardPx };
}

function applyLayout() {
  const r = document.documentElement.style;
  r.setProperty('--cell', L.cell + 'px');
  r.setProperty('--gap', L.gap + 'px');
  r.setProperty('--mini', L.mini + 'px');
  r.setProperty('--mini-gap', L.miniGap + 'px');
  r.setProperty('--slot-h', L.slotH + 'px');
  r.setProperty('--anim', settings.get('animMs') + 'ms');
  board.style.gridTemplateColumns = `repeat(${L.n}, ${L.cell}px)`;
  board.style.width = board.style.height = L.boardPx + 'px';
  trayWrap.style.width = L.boardPx + 'px';
}

function render() {
  if (cellEls.length !== state.board.length) buildBoard(state.board.length);
  L = computeLayout();
  applyLayout();
  renderBoard();
  renderTray();
  renderActions();
  renderStats();
}

function renderBoard() {
  const n = L.n;
  const pend = new Map();
  if (pendingClear) for (const [x, y, t] of pendingClear.cells) pend.set(y * n + x, t);
  const placed = new Set((justPlaced || []).map(([x, y]) => y * n + x));
  justPlaced = null;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const el = cellEls[y][x];
      const t = state.board[y][x], p = pend.get(y * n + x);
      el.className = 'cell';
      if (t) {
        el.classList.add('filled');
        el.style.background = colorOf(t);
        if (placed.has(y * n + x)) el.classList.add('placed');
      } else if (p) {
        el.classList.add('filled', 'clearing');
        el.style.background = colorOf(p);
      } else {
        el.style.background = '';
      }
    }
  }
  hl = [];
  board.classList.toggle('over', !!state.over);
}

function blockEl(block, source) {
  const shape = G.shapeOf(block);
  const w = shape[0].length;
  const el = h('div.block', {
    class: (selected === source ? 'selected' : '') + (drag && drag.source === source ? ' dragging' : ''),
    data: { source }, style: { gridTemplateColumns: `repeat(${w}, var(--mini))` },
  });
  for (const row of shape) for (const v of row) el.append(h('div.bcell' + (v ? '.on' : ''), { style: v ? { background: colorOf(block.type) } : null }));
  const cost = G.rotationCost(block, cfg());
  if (cost > 0) el.append(h('div.badge', { text: `⟳ −${cost}`, title: 'Rotated: placing costs rotation points' }));
  return el;
}

function renderTray() {
  for (const slotEl of tray.children) {
    const src = parseSource(slotEl.dataset.source);
    slotEl.querySelector('.block')?.remove();
    const b = G.getBlock(state, src);
    if (b) slotEl.append(blockEl(b, src));
    slotEl.classList.toggle('empty', !b);
  }
  sideSlot.classList.remove('target', 'bad-target');
}

function renderActions() {
  clear(actions);
  if (state.over) {
    actions.append(h('div.hint', { text: 'Game over — no block fits' }), h('button.btn.btn-primary', { text: 'New game', onClick: () => newGame() }));
    return;
  }
  if (selected == null) {
    actions.append(h('div.hint', { text: 'Drag a block onto the board, or tap one to select it' }));
    return;
  }
  const b = G.getBlock(state, selected);
  if (!b) { selected = null; return renderActions(); }
  const c = cfg();
  const nextCost = G.rotationCost({ ...b, cur: (b.cur + 1) % 4 }, c);
  const distinct = G.distinctRotations(b.type);
  const affordable = nextCost <= state.rotPoints;
  actions.append(h('button.btn#btn-rotate', {
    disabled: distinct < 2 || !affordable,
    title: distinct < 2 ? 'This shape looks the same in every rotation' : affordable ? 'Rotate 90° clockwise' : `Needs ${nextCost} rotation points`,
    onClick: () => doRotate(selected, 1),
  }, '⟳ Rotate', h('span.cost', { text: distinct < 2 ? '' : nextCost ? ` · ${nextCost} pt` : ' · free' })));
  if (selected !== 'side' && (!state.side || c.allowSwap)) {
    actions.append(h('button.btn#btn-stash', { text: state.side ? '⇄ Swap' : '⤓ Stash', title: state.side ? 'Swap with the side block' : 'Move to the side slot', onClick: () => doStash(selected) }));
  }
  actions.append(h('button.btn.btn-icon', { text: '✕', 'aria-label': 'Deselect', onClick: () => { selected = null; render(); } }));
}

function renderStats() {
  $('#score').textContent = state.score.toLocaleString();
  $('#best').textContent = best.toLocaleString();
  $('#rot').textContent = String(state.rotPoints);
}

function showPop(points) {
  if (!points.lines) return;
  clear(pop);
  pop.append(
    h('span', { text: `+${points.clear} · ${points.lines} line${points.lines === 1 ? '' : 's'}` }),
    h('small', { text: `${points.cells} cells × ${points.lines} × ${cfg().clearMultiplier} · +${points.place} placed` }),
  );
  pop.classList.remove('show');
  void pop.offsetWidth; // restart the animation
  pop.classList.add('show');
}

// ---------------------------------------------------------------- game flow
async function newGame(seed = randomSeed()) {
  state = G.newGame(seed >>> 0, cfg());
  selected = null; drag = null; pendingClear = null; justPlaced = null; overShownFor = null;
  clearTimeout(clearTimer);
  buildBoard(state.board.length);
  afterChange();
}

function afterChange() {
  render();
  persist();
  updateBest();
  renderStats();
  checkEnd();
}

function doPlace(source, x, y) {
  const res = G.place(state, source, x, y, cfg());
  if (!res) return false;
  state = res.state;
  selected = null;
  justPlaced = res.placedCells;
  clearTimeout(clearTimer);
  pendingClear = null;
  if (res.cleared.cells.length) {
    pendingClear = res.cleared;
    clearTimer = setTimeout(() => { pendingClear = null; render(); }, Number(settings.get('animMs')));
  }
  showPop(res.points);
  afterChange();
  return true;
}

function doStash(index) {
  const s = G.stash(state, index, cfg());
  if (!s) { toast(state.side ? 'The side slot is occupied' : 'Nothing to stash'); return false; }
  state = s;
  selected = null;
  afterChange();
  return true;
}

function doRotate(source, dir = 1) {
  const s = G.rotateBlock(state, source, dir, cfg());
  if (!s) { toast(`Not enough rotation points (costs ${cfg().rotationCost})`); return false; }
  state = s;
  render();
  persist();
  return true;
}

function checkEnd() {
  if (!state.over) { overShownFor = null; return; }
  const key = `${state.seed}:${state.deals}:${state.score}`;
  if (overShownFor === key) return;
  overShownFor = key;
  setTimeout(showGameOver, Number(settings.get('animMs')) + 150);
}

async function showGameOver() {
  const v = await modal({
    title: 'Game over',
    body: h('div', {},
      h('p', {}, 'No block fits anywhere. Score: ', h('b', { text: state.score.toLocaleString() }), state.score >= best && state.score > 0 ? ' — new best!' : ''),
      h('p.muted', { text: `Best ${best.toLocaleString()} · ${state.deals} turns · seed ${state.seed}` })),
    buttons: [{ label: 'Close', value: false }, { label: 'New game', value: true, primary: true }],
  });
  if (v) newGame();
}

// ---------------------------------------------------------------- input
function makeGhost(block) {
  const shape = G.shapeOf(block);
  const w = shape[0].length, hgt = shape.length;
  const el = h('div.ghost', { style: { gridTemplateColumns: `repeat(${w}, ${L.cell}px)` } });
  for (const row of shape) for (const v of row) el.append(h('div.gcell' + (v ? '.on' : ''), { style: v ? { background: colorOf(block.type) } : null }));
  document.body.append(el);
  return { el, gw: w * L.cell + (w - 1) * L.gap, gh: hgt * L.cell + (hgt - 1) * L.gap };
}

function moveGhost(cx, cy) {
  drag.gx = cx - drag.grabX;
  drag.gy = cy - drag.grabY - drag.lift;
  drag.el.style.transform = `translate(${drag.gx}px, ${drag.gy}px)`;
}

/** Where a drop would land: {kind:'board', x, y, ok} | {kind:'side', ok} | null. */
function dropTarget(cx, cy) {
  const r = board.getBoundingClientRect();
  const pitch = L.cell + L.gap;
  const ox = r.left + L.gap, oy = r.top + L.gap;
  const gcx = drag.gx + drag.gw / 2, gcy = drag.gy + drag.gh / 2;
  const inside = (rect, px, py) => px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom;
  // The board claims the drop only while the ghost's centre is over it; the side slot takes it when
  // either the ghost's centre or the finger itself is over the slot (the ghost floats above the finger).
  if (inside(r, gcx, gcy)) {
    const x = Math.round((drag.gx - ox) / pitch), y = Math.round((drag.gy - oy) / pitch);
    return { kind: 'board', x, y, ok: G.canPlaceBlock(state, drag.source, x, y, cfg()) };
  }
  if (drag.source !== 'side') {
    const sr = sideSlot.getBoundingClientRect();
    const under = elementAt(cx, cy, [drag.el]);
    if (inside(sr, gcx, gcy) || inside(sr, cx, cy) || under?.closest?.('.slot.side')) return { kind: 'side', ok: !state.side || cfg().allowSwap };
  }
  return null;
}

function setHighlights(t) {
  for (const el of hl) el.classList.remove('ok', 'bad');
  hl = [];
  sideSlot.classList.remove('target', 'bad-target');
  if (!t) return;
  if (t.kind === 'board') {
    const n = L.n;
    for (const [dx, dy] of G.cells(G.shapeOf(drag.block))) {
      const x = t.x + dx, y = t.y + dy;
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      const el = cellEls[y][x];
      el.classList.add(t.ok ? 'ok' : 'bad');
      hl.push(el);
    }
  } else if (t.kind === 'side') {
    sideSlot.classList.add(t.ok ? 'target' : 'bad-target');
  }
}

function snapBack(d) {
  const slotBlock = tray.querySelector(`.block[data-source="${d.source}"]`);
  const r = (slotBlock || sideSlot).getBoundingClientRect();
  const k = (r.width - 12) / d.gw;
  d.el.classList.add('snap');
  d.el.style.opacity = '0.4';
  d.el.style.transform = `translate(${r.left + 6}px, ${r.top + 6}px) scale(${k})`;
  setTimeout(() => { d.el.remove(); renderTray(); }, Number(settings.get('animMs')) + 20);
}

onPress(main, {
  filter: (ev) => !ev.target.closest('button, a'),
  onTap(i) {
    if (state.over) return;
    const t = i.downTarget;
    const blockEl = t?.closest?.('.block');
    if (blockEl) {
      const src = parseSource(blockEl.dataset.source);
      selected = selected === src ? null : src;
      render();
      return;
    }
    const slotEl = t?.closest?.('.slot');
    if (slotEl) {
      const src = parseSource(slotEl.dataset.source);
      if (src === 'side' && selected != null && selected !== 'side') { doStash(selected); return; }
      if (selected != null) { selected = null; render(); }
      return;
    }
    const cellEl = t?.closest?.('.cell');
    if (cellEl && selected != null) {
      const p = G.placementAtCell(state, selected, Number(cellEl.dataset.x), Number(cellEl.dataset.y), cfg());
      if (p) doPlace(selected, p.x, p.y);
      else toast("Doesn't fit there");
      return;
    }
    if (selected != null) { selected = null; render(); }
  },
  onDragStart(i) {
    if (state.over) return false;
    const el = i.downTarget?.closest?.('.block');
    if (!el) return false;
    const source = parseSource(el.dataset.source);
    const block = G.getBlock(state, source);
    if (!block) return false;
    const r = el.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (i.clientX - r.left) / r.width));
    const fy = Math.min(1, Math.max(0, (i.clientY - r.top) / r.height));
    const g = makeGhost(block);
    const lift = i.ev?.pointerType === 'mouse' ? 0 : LIFT;
    drag = { source, block, ...g, grabX: fx * g.gw, grabY: fy * g.gh, lift, target: null, gx: 0, gy: 0 };
    selected = null;
    renderTray();
    renderActions();
    moveGhost(i.clientX, i.clientY);
    drag.target = dropTarget(i.clientX, i.clientY);
    setHighlights(drag.target);
    return true;
  },
  onDragMove(i) {
    if (!drag) return;
    moveGhost(i.clientX, i.clientY);
    drag.target = dropTarget(i.clientX, i.clientY);
    setHighlights(drag.target);
  },
  onDragEnd(i, dx, dy, cancelled) {
    if (!drag) return;
    const d = drag;
    drag = null;
    setHighlights(null);
    const t = cancelled ? null : d.target;
    if (t?.kind === 'board' && t.ok && doPlace(d.source, t.x, t.y)) { d.el.remove(); return; }
    if (t?.kind === 'side' && t.ok && doStash(d.source)) { d.el.remove(); return; }
    if (t?.kind === 'board' && !t.ok && G.rotationCost(d.block, cfg()) > state.rotPoints) toast('Not enough rotation points for that rotation');
    else if (t?.kind === 'side' && !t.ok) toast('The side slot is occupied');
    snapBack(d);
  },
});

$('#btn-menu').onclick = showMenu;
window.addEventListener('resize', () => render());
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { selected = null; render(); }
  else if ((e.key === 'r' || e.key === 'R') && selected != null) doRotate(selected, e.shiftKey ? -1 : 1);
});

// ---------------------------------------------------------------- menu & settings
async function showMenu() {
  const n = state.board.length;
  const choice = await modal({
    title: 'Blocks',
    body: h('div.muted', { text: `Seed ${state.seed} · turn ${state.deals} · ${n}×${n} · score ${state.score.toLocaleString()} · best ${best.toLocaleString()}` }),
    buttons: [
      { label: 'Settings', value: 'settings' },
      { label: 'Help', value: 'help' },
      { label: 'New (seed…)', value: 'seed' },
      { label: 'New game', value: 'new', primary: true },
    ],
  });
  if (choice === 'new') { if (state.over || state.score === 0 || await confirm('Start a new game? The current one is discarded.', { ok: 'New game' })) newGame(); }
  else if (choice === 'seed') {
    const input = h('input', { type: 'number', value: state.seed, style: { width: '100%', padding: '8px', fontSize: '16px' } });
    const ok = await modal({ title: 'Game seed', body: h('div', {}, h('p.muted', { text: 'Same seed = same sequence of blocks.' }), input), buttons: [{ label: 'Cancel', value: false }, { label: 'Start', value: true, primary: true }] });
    if (ok) newGame(Number(input.value) >>> 0);
  }
  else if (choice === 'settings') openSettings();
  else if (choice === 'help') showHelp();
}

function openSettings() {
  const d = drawer({ title: 'Settings', onClose: () => setTimeout(() => d.el.remove(), 300) });
  d.body.append(settingsPanel(SETTINGS_SCHEMA, settings, { onReset: () => { d.close(); openSettings(); } }));
  d.open();
}

settings.onChange(async (k) => {
  if (RULE_KEYS.includes(k) || k === null) { state = G.refresh(state, cfg()); persist(); }
  render();
  checkEnd();
  if (k === 'gridSize' || k === null) {
    const n = cfg().gridSize;
    if (n !== state.board.length) {
      if (await confirm(`Start a new ${n}×${n} game now? The current game is discarded.`, { ok: 'New game' })) newGame();
      else toast('The new grid size applies to your next new game');
    }
  }
});

function showHelp() {
  const c = cfg();
  modal({
    title: 'How to play', wide: true,
    body: h('div.help', { style: { lineHeight: '1.5' } },
      h('p', {}, h('b', {}, 'Goal: '), `fit the blocks into the ${state.board.length}×${state.board.length} grid. Each turn the tray offers 3 blocks; all 3 must be placed or stashed before the next 3 arrive. There is no gravity and no timer.`),
      h('p', {}, h('b', {}, 'Placing: '), 'drag a block onto the board (the ghost shows green where it fits, red where it doesn\'t), or tap a block to select it and then tap a board cell.'),
      h('p', {}, h('b', {}, 'Clearing: '), `full rows and columns clear together. Placing scores the block's cells; a clear scores cells × lines × ${c.clearMultiplier}, so clearing several lines at once is worth much more.`),
      h('p', {}, h('b', {}, 'Side slot: '), `drop a tray block there to keep it for later${c.allowSwap ? ' (dropping onto an occupied slot swaps the two)' : ''}. Stashing counts as using the block. The side block can be placed on any turn.`),
      h('p', {}, h('b', {}, 'Rotation points ⟳: '), `blocks must be placed as dealt unless you pay. Every cleared line earns ${c.rotationPointsPerLine}; placing a block in a different rotation costs ${c.rotationCost}, charged when you place it. Rotating back to the dealt orientation is free. Select a block to see the ⟳ Rotate button and its cost (keyboard: R).`),
      h('p', {}, h('b', {}, 'Game over: '), 'when no tray or side block fits anywhere (counting rotations you can afford) and the turn can\'t be finished by stashing.'),
    ),
  });
}

// ---------------------------------------------------------------- boot
window.__blocks = {
  get state() { return state; },
  set state(s) { setState(s); },
  game: G, settings,
  place: doPlace, stash: doStash, rotate: doRotate, newGame, render,
  setState,
};
function setState(s) {
  clearTimeout(clearTimer);
  pendingClear = null; selected = null; overShownFor = null;
  state = G.refresh(s, cfg());
  buildBoard(state.board.length);
  afterChange();
}

if (!restore()) state = G.newGame(randomSeed(), cfg());
buildBoard(state.board.length);
render();
persist();
checkEnd();
