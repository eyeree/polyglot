// Abstrackle UI controller. Rendering + input only; rules live in rules.js, the state machine in game.js, opponents in ai.js.
import { h, $, clear, modal, confirm, toast, settingsPanel, drawer } from '../shared/ui.js';
import { makeSettings, load, save } from '../shared/storage.js';
import { makeRng, randomSeed, hashString } from '../shared/rng.js';
import { DEFAULTS, SHAPES, COLORS, BONUS, STRATEGIES, STRATEGY_IDS, AI_NAMES, HAND_SIZE, END_BONUS, MODES, MODE_IDS, MAX_REDRAWS } from './config.js';
import * as R from './rules.js';
import * as G from './game.js';
import * as AI from './ai.js';

const SAVE_KEY = 'abstrackle.save';
const MARGIN = 2;                 // empty cells kept around the played area
const settings = makeSettings('abstrackle.settings', DEFAULTS);

const strategyOptions = [{ value: 'random', label: 'Random' }, ...STRATEGY_IDS.map(id => ({ value: id, label: STRATEGIES[id].name }))];
const boardSizeOptions = [{ value: 0, label: 'Unlimited' }];
for (let n = 9; n <= 25; n += 2) boardSizeOptions.push({ value: n, label: `${n} × ${n}` });
const SETTINGS_SCHEMA = [
  { key: 'mode', label: 'Game mode', type: 'select', options: MODE_IDS.map(id => ({ value: id, label: MODES[id].name })), help: 'Applies to new games · see Help for the rules' },
  { key: 'rounds', label: 'Rounds per game', type: 'range', min: 1, max: 10, step: 1, help: 'Turns, Goal and Bag modes' },
  { key: 'turnsPerRound', label: 'Turns per round', type: 'range', min: 3, max: 7, step: 1, help: 'Turns mode' },
  { key: 'boardSize', label: 'Board size', type: 'select', options: boardSizeOptions, help: 'Turns and Bag modes' },
  { key: 'pointsGoal', label: 'Points goal', type: 'range', min: 20, max: 300, step: 10, help: 'Goal mode: round points that end the round' },
  { key: 'opponents', label: 'Opponents', type: 'range', min: 1, max: 3, step: 1, help: 'Applies to new games' },
  { key: 'strategy1', label: 'Opponent 1 strategy', type: 'select', options: strategyOptions },
  { key: 'strategy2', label: 'Opponent 2 strategy', type: 'select', options: strategyOptions },
  { key: 'strategy3', label: 'Opponent 3 strategy', type: 'select', options: strategyOptions },
  { key: 'difficulty', label: 'AI difficulty', type: 'range', min: 0, max: 100, step: 5, help: 'How often opponents pick their best move' },
  { key: 'bonusTypes', label: 'Bonus cells', type: 'select', options: [{ value: 'all', label: '+n and ×n' }, { value: 'add', label: '+n only' }, { value: 'mul', label: '×n only' }, { value: 'none', label: 'None' }], help: 'Applies to new games' },
  { key: 'bonusDensity', label: 'Bonus cell density', type: 'range', min: 0, max: 0.25, step: 0.01, help: 'Applies to new games' },
  { key: 'bonusMode', label: '×n multiplies', type: 'select', options: [{ value: 'line', label: 'Lines through it' }, { value: 'move', label: 'Whole move' }], help: 'Applies to new games' },
  { key: 'tileSize', label: 'Tile size', type: 'range', min: 22, max: 72, step: 2 },
  { key: 'aiDelayMs', label: 'AI delay (ms)', type: 'range', min: 0, max: 2000, step: 100 },
  { key: 'showHints', label: 'Highlight legal cells', type: 'bool', help: 'For the selected hand tile' },
  { key: 'showAiHands', label: "Show opponents' tiles", type: 'bool', help: 'Debug / cheat' },
  { key: 'playerName', label: 'Your name', type: 'text', help: 'Applies to new games' },
];

// ---------------------------------------------------------------- state
let game = null;
let tentative = [];               // [{x, y, tile, handIdx}] tiles placed this turn, not yet committed
let selected = null;              // hand index of the tile to place next
let swapMode = false;
let swapSel = new Set();          // hand indices chosen for a swap
let aiToken = 0, aiBusy = false;
let layout = null;                // {minX, minY, cell} of the last board render (for stable scrolling)
let noticedTurn = -1, endShownFor = -1, roundShownFor = '';

const scroller = $('#board-scroll');
const boardEl = $('#board');

// ---------------------------------------------------------------- tiles as SVG
const STAR_POINTS = (() => {
  const pts = [];
  for (let k = 0; k < 16; k++) {
    const a = k * Math.PI / 8 - Math.PI / 2, r = k % 2 ? 18 : 40;
    pts.push((50 + r * Math.cos(a)).toFixed(1) + ',' + (50 + r * Math.sin(a)).toFixed(1));
  }
  return pts.join(' ');
})();
const SHAPE_SVG = {
  circle: '<circle cx="50" cy="50" r="32"/>',
  cross: '<path d="M50 36 L72 14 L86 28 L64 50 L86 72 L72 86 L50 64 L28 86 L14 72 L36 50 L14 28 L28 14 Z"/>',
  diamond: '<polygon points="50,12 88,50 50,88 12,50"/>',
  square: '<rect x="19" y="19" width="62" height="62" rx="4"/>',
  star: `<polygon points="${STAR_POINTS}"/>`,
  clover: '<circle cx="50" cy="30" r="18"/><circle cx="70" cy="50" r="18"/><circle cx="50" cy="70" r="18"/><circle cx="30" cy="50" r="18"/><rect x="34" y="34" width="32" height="32"/>',
};
function tileEl(t, cls = '') {
  const color = COLORS[R.colorOf(t)], shape = SHAPES[R.shapeOf(t)];
  return h('div.tile' + cls, { title: R.tileName(t), html: `<svg viewBox="0 0 100 100" fill="${color.hex}" aria-label="${color.id} ${shape}">${SHAPE_SVG[shape]}</svg>` });
}

// ---------------------------------------------------------------- persistence
function persist() { save(SAVE_KEY, { game: G.toJSON(game) }); }
function restore() {
  const o = load(SAVE_KEY);
  const g = o && G.fromJSON(o.game);
  if (!g || !g.players.length) return false;
  game = g;
  return true;
}

// ---------------------------------------------------------------- helpers
const human = () => game.players[0];
const isHumanTurn = () => !game.over && !game.roundOver && !aiBusy && game.players[game.turn].ai == null;
const mode = () => game.cfg.mode;
const modeName = () => MODES[mode()]?.name || 'Classic';
const inRounds = () => mode() !== 'classic';
const plain = (p) => ({ x: p.x, y: p.y, tile: p.tile });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let playsCache = { moves: -1, any: null };
function humanHasPlay() {
  if (playsCache.moves !== game.moves) playsCache = { moves: game.moves, any: G.hasPlay(game, human()) };
  return playsCache.any;
}

function describeScore(last) {
  const bd = last.breakdown;
  const parts = [];
  if (bd.lines.some(l => l.complete)) parts.push('Abstrackle!');
  for (const b of bd.bonuses) parts.push(b.label);
  if (last.endBonus) parts.push(`+${last.endBonus} for going out`);
  return `+${last.score}` + (parts.length ? ` · ${parts.join(' ')}` : '');
}

// ---------------------------------------------------------------- rendering
function renderAll(opts = {}) {
  renderTop();
  renderPlayers();
  renderBoard(opts);
  renderHand();
  renderButtons();
}

function renderTop() {
  const m = mode();
  $('#stat-round').textContent = inRounds() ? `Round ${game.round}/${game.cfg.rounds}` : '';
  $('#stat-bag').textContent = m === 'turns' ? `Turn ${Math.min(game.cfg.turnsPerRound, (game.players[game.turn]?.turns ?? 0) + (game.roundOver ? 0 : 1))}/${game.cfg.turnsPerRound}`
    : m === 'goal' ? `Goal ${game.cfg.pointsGoal}` : `Bag ${game.bag.length}`;
}

function renderPlayers() {
  const el = $('#players');
  clear(el);
  game.players.forEach((p, i) => {
    const cur = game.turn === i && !game.over;
    const last = p.last;
    const delta = !last ? '' : last.type === 'play' ? '+' + last.score : last.type === 'exchange' ? `swap ${last.count}` : 'pass';
    el.append(h('div.player' + (cur ? '.current' : ''), { data: { idx: i }, onClick: () => showPlayer(i) },
      h('div.phead', {}, h('span.pname', { text: p.name }), p.ai ? h('span.badge', { text: STRATEGIES[p.ai]?.name || p.ai }) : null),
      h('div.pscore', {}, h('span.score', { text: String(p.score) }), h('span.delta' + (last?.type === 'play' ? '.pos' : ''), { text: delta })),
      h('div.ptiles', { text: inRounds() ? `${p.roundScore} this round${mode() === 'bag' ? ` · ${p.hand.length} tiles` : ''}` : `${p.hand.length} tile${p.hand.length === 1 ? '' : 's'}` }),
      p.ai && settings.get('showAiHands') ? h('div.minihand', {}, p.hand.map(t => tileEl(t, '.mini'))) : null,
    ));
  });
}

function bounds() {
  const fixed = G.bounds(game);
  if (fixed) return fixed;
  let b = R.boardBounds(game.board);
  for (const t of tentative) {
    if (!b) b = { minX: t.x, maxX: t.x, minY: t.y, maxY: t.y };
    else { b.minX = Math.min(b.minX, t.x); b.maxX = Math.max(b.maxX, t.x); b.minY = Math.min(b.minY, t.y); b.maxY = Math.max(b.maxY, t.y); }
  }
  if (!b) b = { minX: -1, maxX: 1, minY: -1, maxY: 1 };
  return { minX: b.minX - MARGIN, maxX: b.maxX + MARGIN, minY: b.minY - MARGIN, maxY: b.maxY + MARGIN };
}

/** Board coordinate (fractional) currently at the centre of the viewport, from the previous layout. */
function viewCenter() {
  if (!layout) return null;
  return {
    x: layout.minX + (scroller.scrollLeft + scroller.clientWidth / 2 - boardEl.offsetLeft) / layout.cell,
    y: layout.minY + (scroller.scrollTop + scroller.clientHeight / 2 - boardEl.offsetTop) / layout.cell,
  };
}
function scrollToCoord(cx, cy, smooth = false) {
  const left = boardEl.offsetLeft + (cx - layout.minX) * layout.cell - scroller.clientWidth / 2;
  const top = boardEl.offsetTop + (cy - layout.minY) * layout.cell - scroller.clientHeight / 2;
  if (smooth) scroller.scrollTo({ left, top, behavior: 'smooth' });
  else { scroller.scrollLeft = left; scroller.scrollTop = top; }
}
function centerOf(cells) {
  const xs = cells.map(c => c.x), ys = cells.map(c => c.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2 + 0.5, y: (Math.min(...ys) + Math.max(...ys)) / 2 + 0.5 };
}
/** Smoothly scroll so that these cells are visible (no-op when they already are). */
function ensureVisible(cells) {
  const { minX, minY, cell } = layout;
  const xs = cells.map(c => c.x), ys = cells.map(c => c.y);
  const l = boardEl.offsetLeft + (Math.min(...xs) - minX) * cell, r = boardEl.offsetLeft + (Math.max(...xs) - minX + 1) * cell;
  const t = boardEl.offsetTop + (Math.min(...ys) - minY) * cell, b = boardEl.offsetTop + (Math.max(...ys) - minY + 1) * cell;
  const pad = cell / 2;
  const inside = l - pad >= scroller.scrollLeft && r + pad <= scroller.scrollLeft + scroller.clientWidth
    && t - pad >= scroller.scrollTop && b + pad <= scroller.scrollTop + scroller.clientHeight;
  if (!inside) { const c = centerOf(cells); scrollToCoord(c.x, c.y, true); }
}

function lastMoveKeys() {
  const m = new Map();
  game.players.forEach((p, i) => {
    if (p.last?.type !== 'play') return;
    for (const pl of p.last.placements) m.set(R.key(pl.x, pl.y), i === 0 ? 'last-me' : 'last-ai');
  });
  return m;
}

/** Cells where the selected hand tile can legally join the tentative tiles. */
function hintCells() {
  const out = new Set();
  if (!settings.get('showHints') || selected == null || swapMode || !isHumanTurn()) return out;
  const tile = human().hand[selected];
  if (tile == null) return out;
  const occupied = R.overlay(game.board, tentative);
  const cand = new Map();
  const consider = (x, y) => { for (const [dx, dy] of R.DIRS) { const k = R.key(x + dx, y + dy); if (!occupied.has(k) && !cand.has(k)) cand.set(k, { x: x + dx, y: y + dy }); } };
  for (const k of game.board.keys()) { const { x, y } = R.parseKey(k); consider(x, y); }
  for (const t of tentative) consider(t.x, t.y);
  if (game.board.size === 0 && tentative.length === 0) cand.set('0,0', { x: 0, y: 0 });
  const base = tentative.map(plain);
  const opts = G.rulesOpts(game);
  for (const [k, c] of cand) if (R.validate(game.board, [...base, { x: c.x, y: c.y, tile }], opts).ok) out.add(k);
  return out;
}

/**
 * Rebuild the grid. The viewport keeps showing the same board coordinate at its centre (so growing bounds or a
 * zoom don't jump); `opts.center` recentres on the played area, `opts.show` scrolls to those cells if hidden.
 */
function renderBoard(opts = {}) {
  const keep = viewCenter();
  const cell = settings.get('tileSize');
  const b = bounds();
  const cols = b.maxX - b.minX + 1, rows = b.maxY - b.minY + 1;
  clear(boardEl);
  boardEl.style.width = cols * cell + 'px';
  boardEl.style.height = rows * cell + 'px';
  boardEl.style.setProperty('--cell', cell + 'px');
  boardEl.classList.toggle('bounded', !!G.bounds(game));
  const lastKeys = lastMoveKeys();
  const hints = hintCells();
  const bonus = G.bonusFn(game);
  const emptyBoard = game.board.size === 0;
  const tent = new Map(tentative.map(t => [R.key(t.x, t.y), t]));
  const frag = document.createDocumentFragment();
  for (let y = b.minY; y <= b.maxY; y++) {
    for (let x = b.minX; x <= b.maxX; x++) {
      const k = R.key(x, y);
      const c = h('div.cell', { data: { x, y }, style: { left: (x - b.minX) * cell + 'px', top: (y - b.minY) * cell + 'px' } });
      const bn = bonus(x, y);
      if (bn) { c.classList.add('bonus', 'b-' + bn.id); c.append(h('span.blabel', { text: bn.label })); }
      if (game.board.has(k)) { const cls = lastKeys.get(k); c.classList.add('filled'); c.append(tileEl(game.board.get(k), cls ? '.' + cls : '')); }
      else if (tent.has(k)) { c.classList.add('filled'); c.append(tileEl(tent.get(k).tile, '.tentative')); }
      else {
        if (emptyBoard && x === 0 && y === 0 && tentative.length === 0) c.classList.add('origin');
        if (hints.has(k)) c.classList.add('hint');
      }
      frag.append(c);
    }
  }
  boardEl.append(frag);
  layout = { minX: b.minX, minY: b.minY, cell };
  if (opts.center || !keep) {
    const cells = game.board.size ? [...game.board.keys()].map(R.parseKey) : [{ x: 0, y: 0 }];
    const c = centerOf(cells);
    scrollToCoord(c.x, c.y, false);
  } else {
    scrollToCoord(keep.x, keep.y, false);
    if (opts.show) ensureVisible(opts.show);
  }
}

function renderHand() {
  const el = $('#hand');
  clear(el);
  const hand = human().hand;
  el.classList.toggle('disabled', !isHumanTurn());
  el.style.setProperty('--n', String(Math.max(HAND_SIZE, hand.length)));
  hand.forEach((t, i) => {
    const used = tentative.some(p => p.handIdx === i);
    const cls = (used ? '.used' : '') + (selected === i ? '.selected' : '') + (swapMode && swapSel.has(i) ? '.swapsel' : '');
    el.append(h('div.slot' + cls, { data: { idx: i }, onClick: () => onHandTap(i) }, used ? null : tileEl(t)));
  });
  for (let i = hand.length; i < HAND_SIZE; i++) el.append(h('div.slot.empty'));
}

function renderButtons() {
  const turn = isHumanTurn();
  const play = $('#btn-play'), swap = $('#btn-swap'), back = $('#btn-takeback'), pass = $('#btn-pass');
  if (game.roundOver && !game.over) {
    play.textContent = 'Next round'; play.disabled = false;
    swap.classList.add('hidden'); back.classList.add('hidden'); pass.classList.add('hidden');
    $('#turn-note').textContent = `Round ${game.round} over`;
    return;
  }
  swap.classList.toggle('hidden', mode() === 'bag');
  if (swapMode) {
    play.textContent = swapSel.size ? `Swap ${swapSel.size}` : 'Swap';
    play.disabled = !turn || swapSel.size === 0;
    swap.textContent = 'Cancel'; swap.disabled = false;
    back.classList.add('hidden'); pass.classList.add('hidden');
  } else {
    play.textContent = 'Play'; play.disabled = !turn || tentative.length === 0;
    swap.textContent = 'Swap'; swap.disabled = !turn || G.poolSize(game) === 0;
    back.classList.toggle('hidden', tentative.length === 0); back.disabled = !turn;
    pass.classList.toggle('hidden', !(turn && G.canPass(game)));
  }
  const note = $('#turn-note');
  note.textContent = game.over ? 'Game over' : turn ? (swapMode ? 'Pick tiles to swap' : tentative.length ? (G.rulesOpts(game).chain ? 'Add tiles next to yours, then Play' : 'Tap Play to commit') : selected != null ? 'Tap a cell' : (game.drew ? 'You drew a tile · play or pass' : '')) : `${game.players[game.turn].name} is thinking…`;
}

// ---------------------------------------------------------------- input
boardEl.addEventListener('click', (e) => {
  const c = e.target.closest('.cell');
  if (!c) return;
  onCellTap(Number(c.dataset.x), Number(c.dataset.y));
});

function onHandTap(i) {
  if (!isHumanTurn()) return;
  if (swapMode) {
    if (swapSel.has(i)) swapSel.delete(i); else swapSel.add(i);
    renderHand(); renderButtons();
    return;
  }
  if (tentative.some(p => p.handIdx === i)) return;
  selected = selected === i ? null : i;
  renderHand(); renderBoard(); renderButtons();
}

function onCellTap(x, y) {
  if (!isHumanTurn() || swapMode) return;
  const ti = tentative.findIndex(p => p.x === x && p.y === y);
  if (ti >= 0) { tentative.splice(ti, 1); renderHand(); renderBoard(); renderButtons(); return; }
  if (game.board.has(R.key(x, y))) return;
  if (selected == null) { toast('Pick a tile from your hand first'); return; }
  placeTentative(x, y, selected);
}

/** Put hand tile `handIdx` on (x,y) tentatively; nothing is validated until Play. */
function placeTentative(x, y, handIdx) {
  const tile = human().hand[handIdx];
  if (tile == null || tentative.some(p => p.handIdx === handIdx) || game.board.has(R.key(x, y))) return false;
  const ti = tentative.findIndex(p => p.x === x && p.y === y);
  if (ti >= 0) tentative.splice(ti, 1);
  tentative.push({ x, y, tile, handIdx });
  selected = null;
  renderHand(); renderBoard(); renderButtons();
  return true;
}

function takeBack() {
  tentative = []; selected = null;
  renderHand(); renderBoard(); renderButtons();
}

function commitPlay() {
  if (!isHumanTurn()) return false;
  if (!tentative.length) { toast(R.REASONS.empty); return false; }
  const move = { type: 'play', placements: tentative.map(plain) };
  const v = G.validateMove(game, move);
  if (!v.ok) { toast(v.message); return false; }
  game = G.applyMove(game, move);
  tentative = []; selected = null;
  toast(describeScore(human().last));
  afterHumanTurn();
  return true;
}

function toggleSwap() {
  if (!isHumanTurn()) return;
  if (swapMode) { swapMode = false; swapSel.clear(); }
  else {
    if (G.poolSize(game) === 0) { toast('The bag is empty'); return; }
    swapMode = true; swapSel.clear(); tentative = []; selected = null;
  }
  renderHand(); renderBoard(); renderButtons();
}

function commitSwap(indices = [...swapSel]) {
  if (!isHumanTurn()) return false;
  const tiles = indices.map(i => human().hand[i]).filter(t => t != null);
  const move = { type: 'exchange', tiles };
  const v = G.validateMove(game, move);
  if (!v.ok) { toast(v.message); return false; }
  game = G.applyMove(game, move);
  swapMode = false; swapSel.clear(); tentative = []; selected = null;
  toast(`Swapped ${tiles.length} tile${tiles.length === 1 ? '' : 's'}`);
  afterHumanTurn();
  return true;
}

async function doPass() {
  if (!isHumanTurn()) return false;
  const v = G.validateMove(game, { type: 'pass' });
  if (!v.ok) { toast(v.message); return false; }
  game = G.applyMove(game, { type: 'pass' });
  tentative = []; selected = null;
  afterHumanTurn();
  return true;
}

function afterHumanTurn() {
  persist();
  renderAll();
  if (game.over) showEnd(); else if (game.roundOver) showRoundEnd(); else runAI();
}

/** Called when the human's turn begins: explain automatic draws and nudge when nothing can be played. */
function onHumanTurn() {
  if (game.over || game.roundOver || game.players[game.turn].ai || noticedTurn === game.moves) return;
  noticedTurn = game.moves;
  const ev = game.turnEvent;
  const stuck = !humanHasPlay();
  if (ev?.type === 'draw') toast(stuck ? 'No possible play — you drew a tile and may pass' : 'No possible play — you drew a tile', 3000);
  else if (ev?.type === 'redraw') toast(stuck ? `No possible play even after ${ev.n} new hands — you can pass` : `No possible play — you got ${ev.n > 1 ? 'new tiles (' + ev.n + ' tries)' : 'new tiles'}`, 3000);
  else if (stuck) toast(mode() === 'classic' && game.bag.length ? 'No possible play — swap some tiles' : 'No possible play — you can pass', 3000);
}

async function doNextRound() {
  if (!game.roundOver || game.over) return false;
  game = G.nextRound(game);
  tentative = []; selected = null; swapMode = false; swapSel.clear();
  layout = null; noticedTurn = -1;
  persist();
  renderAll({ center: true });
  toast(`Round ${game.round} — ${game.players[game.turn].ai ? game.players[game.turn].name + ' opens' : 'you open'}`);
  onHumanTurn();
  runAI();
  return true;
}

// ---------------------------------------------------------------- AI turns
async function runAI() {
  const token = ++aiToken;
  while (!game.over && !game.roundOver && game.players[game.turn].ai) {
    aiBusy = true; renderButtons(); renderHand();
    await sleep(Math.max(30, settings.get('aiDelayMs')));
    if (token !== aiToken) return;
    aiStep();
  }
  if (token !== aiToken) return;
  aiBusy = false;
  renderButtons(); renderHand();
  if (game.over) showEnd(); else if (game.roundOver) showRoundEnd(); else onHumanTurn();
}

/** Play one AI move immediately (also used by the debug hook). */
function aiStep() {
  if (game.over || game.roundOver) return null;
  const idx = game.turn, p = game.players[idx];
  if (!p.ai) return null;
  const rng = makeRng(hashString(`${game.seed}:ai:${game.moves}`));
  const move = AI.chooseMove(game, idx, p.ai, settings.get('difficulty'), rng);
  game = G.applyMove(game, move);
  persist();
  renderTop(); renderPlayers();
  renderBoard(move.type === 'play' ? { show: move.placements } : {});
  renderHand(); renderButtons();
  return move;
}

// ---------------------------------------------------------------- game flow
function startNewGame(seed = randomSeed()) {
  aiToken++; aiBusy = false;
  const n = Math.max(1, Math.min(3, Number(settings.get('opponents')) || 1));
  const rng = makeRng(seed ^ 0x5bd1e995);
  const players = [{ name: String(settings.get('playerName') || 'You').trim() || 'You', ai: null }];
  for (let i = 1; i <= n; i++) {
    let s = settings.get('strategy' + i);
    if (!STRATEGIES[s]) s = rng.pick(STRATEGY_IDS);
    players.push({ name: AI_NAMES[i - 1], ai: s });
  }
  game = G.newGame({
    seed, players, mode: settings.get('mode'),
    bonusDensity: Number(settings.get('bonusDensity')), bonusMode: settings.get('bonusMode'), bonusTypes: settings.get('bonusTypes'),
    rounds: Number(settings.get('rounds')) || 1, turnsPerRound: Number(settings.get('turnsPerRound')) || 5,
    boardSize: Number(settings.get('boardSize')) || 0, pointsGoal: Number(settings.get('pointsGoal')) || 100,
  });
  tentative = []; selected = null; swapMode = false; swapSel.clear();
  layout = null; noticedTurn = -1; endShownFor = -1; roundShownFor = '';
  persist();
  renderAll({ center: true });
  onHumanTurn();
  runAI();
}

async function showEnd() {
  if (endShownFor === game.moves) return;
  endShownFor = game.moves;
  const rows = G.standings(game).map((p, i) => h('div.row.standing' + (game.winners.includes(p.idx) ? '.winner' : ''), {},
    h('span.place', { text: (i + 1) + '.' }),
    h('span.grow', { text: p.name + (p.ai ? ` (${STRATEGIES[p.ai].name})` : '') }),
    h('span.muted', { text: inRounds() ? '' : p.tiles ? `${p.tiles} left` : 'out' }),
    h('b', { text: String(p.score) })));
  const w = game.winners;
  const title = w.length > 1 ? 'Tie!' : w[0] === 0 ? 'You win! 🎉' : `${game.players[w[0]].name} wins`;
  const went = game.players.find(p => p.last?.endBonus);
  const why = inRounds() ? `${modeName()} mode · ${game.cfg.rounds} round${game.cfg.rounds === 1 ? '' : 's'} played. Highest total wins.`
    : went ? (went.ai ? `${went.name} emptied their hand (+${END_BONUS}).` : `You emptied your hand (+${END_BONUS}).`) : 'Nobody could move.';
  const v = await modal({
    title,
    body: h('div', {}, h('div.muted', { style: { marginBottom: '8px' }, text: why }), inRounds() ? roundTable(game.summary) : null, rows),
    buttons: [{ label: 'Close', value: false }, { label: 'New game', value: true, primary: true }],
  });
  if (v) startNewGame();
}

function roundTable(sum) {
  if (!sum) return null;
  return h('div.roundtable', {},
    h('div.row.rhead', {}, h('span.grow', { text: `Round ${sum.round}` }), h('span.col', { text: 'Round' }), h('span.col', { text: 'Total' })),
    sum.rows.map(r => h('div.row' + (sum.winners.includes(r.idx) ? '.winner' : ''), {},
      h('span.grow', { text: r.name }), h('span.col', { text: '+' + r.points }), h('b.col', { text: String(r.total) }))));
}

async function showRoundEnd() {
  const key = `${game.round}:${game.moves}`;
  if (!game.roundOver || game.over || roundShownFor === key) return;
  roundShownFor = key;
  const sum = game.summary;
  const lead = G.standings(game)[0];
  const v = await modal({
    title: `Round ${sum.round} of ${game.cfg.rounds} over`,
    body: h('div', {}, roundTable(sum), h('p.muted', { text: `${lead.idx === 0 ? 'You lead' : lead.name + ' leads'} with ${lead.score}. ${game.players[(game.firstPlayer + game.round) % game.players.length].ai ? game.players[(game.firstPlayer + game.round) % game.players.length].name : 'You'} open${game.players[(game.firstPlayer + game.round) % game.players.length].ai ? 's' : ''} the next round.` })),
    buttons: [{ label: 'Look at board', value: false }, { label: 'Next round', value: true, primary: true }],
  });
  if (v) doNextRound();
}

/** Explain a player's last move (score breakdown). */
function showPlayer(i) {
  const p = game.players[i];
  const last = p.last;
  const body = h('div.breakdown');
  if (!last) body.append(h('p.muted', { text: 'No move yet.' }));
  else if (last.type === 'exchange') body.append(h('p', { text: `Swapped ${last.count} tile${last.count === 1 ? '' : 's'} with the bag.` }));
  else if (last.type === 'pass') body.append(h('p', { text: 'Passed.' }));
  else {
    const bd = last.breakdown;
    for (const l of bd.lines) {
      body.append(h('div.row', {}, h('span', { text: `${l.cells.length > 1 && l.cells[1].x !== l.cells[0].x ? 'Row' : 'Column'} of ${l.len}${l.complete ? ' · Abstrackle' : ''}${l.mul > 1 ? ` ×${l.mul}` : ''}` }), h('span', { text: String(l.points * l.mul) })));
    }
    if (!bd.lines.length) body.append(h('div.row', {}, h('span', { text: `${last.placements.length} tile${last.placements.length === 1 ? '' : 's'} placed` }), h('span', { text: String(bd.base) })));
    if (bd.muls > 1) body.append(h('div.row', {}, h('span', { text: `Whole move ×${bd.muls}` }), h('span', { text: `${bd.base} → ${bd.base * bd.muls}` })));
    if (bd.adds) body.append(h('div.row', {}, h('span', { text: 'Bonus cells' }), h('span', { text: '+' + bd.adds })));
    if (last.endBonus) body.append(h('div.row', {}, h('span', { text: 'Emptied hand' }), h('span', { text: '+' + last.endBonus })));
    body.append(h('div.row.total', {}, h('span', { text: 'Total' }), h('span', { text: '+' + last.score })));
    body.append(h('div.shape-row', {}, last.placements.map(pl => tileEl(pl.tile))));
  }
  modal({ title: `${p.name}${p.ai ? ` · ${STRATEGIES[p.ai].name}` : ''} · ${p.score} points`, body, buttons: [{ label: 'OK', value: true, primary: true }] });
}

// ---------------------------------------------------------------- menu, settings, help
async function showMenu() {
  const choice = await modal({
    title: 'Abstrackle',
    body: h('div.muted', { text: `${modeName()} mode${inRounds() ? ` · round ${game.round}/${game.cfg.rounds}` : ''} · seed ${game.seed} · move ${game.moves} · bonus ${game.cfg.bonusTypes === 'none' ? 'off' : `${game.cfg.bonusMode} mode, density ${Math.round(game.cfg.bonusDensity * 100)}%`}` }),
    buttons: [
      { label: 'Exit', value: 'exit' },
      { label: 'Settings', value: 'settings' },
      { label: 'Help', value: 'help' },
      { label: 'New (seed…)', value: 'seed' },
      { label: 'New game', value: 'new', primary: true },
    ],
  });
  if (choice === 'exit') location.href = '../';
  else if (choice === 'new') { if (await confirmNew()) startNewGame(); }
  else if (choice === 'seed') {
    const input = h('input', { type: 'number', value: game.seed, style: { width: '100%', padding: '8px', fontSize: '16px' } });
    const ok = await modal({ title: 'Game seed', body: h('div', {}, h('p.muted', { text: 'Same seed = same tiles and bonus cells.' }), input), buttons: [{ label: 'Cancel', value: false }, { label: 'Start', value: true, primary: true }] });
    if (ok && await confirmNew()) startNewGame(Number(input.value) >>> 0);
  }
  else if (choice === 'settings') openSettings();
  else if (choice === 'help') showHelp();
}

async function confirmNew() {
  if (game.over || (game.moves === 0 && !game.roundOver)) return true;
  return confirm('Start a new game? The current one is abandoned.', { ok: 'New game' });
}

function openSettings() {
  const d = drawer({ title: 'Settings' });
  d.body.append(settingsPanel(SETTINGS_SCHEMA, settings, { onReset: () => { d.close(); openSettings(); } }));
  d.open();
}

settings.onChange((k) => {
  if (k == null || k === 'tileSize' || k === 'showHints') renderBoard();
  if (k == null || k === 'showAiHands') renderPlayers();
});

function showHelp() {
  const legend = BONUS.kinds.map(k => h('div.legend-row', {},
    h('span.legend-swatch', { style: { background: k.color + '40', boxShadow: `inset 0 0 0 1px ${k.color}`, color: k.color }, text: k.label }),
    h('span', { text: k.type === 'add' ? `adds ${k.min != null ? `${k.min} to ${k.max}` : k.n} to the move` : `multiplies ${settings.get('bonusMode') === 'move' ? 'the whole move' : 'the lines through that tile'} by ${k.n}` })));
  const modes = MODE_IDS.map(id => h('p', {}, h('b', {}, MODES[id].name + '. '), MODES[id].blurb));
  modal({
    title: 'How to play', wide: true,
    body: h('div.help', { style: { lineHeight: '1.5' } },
      h('div.shape-row', {}, SHAPES.map((_, s) => tileEl(R.tile(s, s)))),
      h('p', {}, h('b', {}, 'Lines. '), 'Tap a tile in your hand, then an empty cell. Tiles played in one turn sit in a single row or column and must touch what is already on the board. Every line of two or more tiles must share one colour (all different shapes) or one shape (all different colours), with no repeats; six is the most a line can hold.'),
      h('p', {}, h('b', {}, 'Scoring. '), 'Each line that includes one of your new tiles scores its length; completing a line of six is an Abstrackle and scores 12. You then draw back up to six. Instead of playing you may ', h('b', {}, 'Swap'), ' any tiles with the bag. ', h('b', {}, 'Pass'), ' is only possible when neither is. When the bag is empty, the player who goes out scores 6 more and the game ends. Tap a player to see how their last move scored.'),
      h('p', {}, h('b', {}, 'Bonus cells '), 'are scattered over the board (fixed by the seed, none near the centre) and pay out when you cover them:'),
      ...legend,
      h('p.muted', { text: 'Several bonuses in one move stack: adds are summed, multipliers multiplied. Bonus cells can be limited to +n or ×n, or turned off, in Settings. Opponents: Greedy maximises score, Blocker avoids opening 4- and 5-lines, Builder keeps a coherent hand, Opportunist chases multipliers and swaps freely.' }),
      h('h3', { text: 'Game modes', style: { margin: '12px 0 4px' } }),
      ...modes,
      h('p.muted', { text: `In Turns, Goal and Bag modes every round starts with one random tile in the centre; the first player is random in round 1 and rotates after that. Tiles played in a turn form a chain: each must touch another tile you played that turn (any shape, not just a line), so a 2×2 block scores four lines of two. If you cannot play, your hand is replaced (up to ${MAX_REDRAWS} times) in Turns and Goal modes; in Bag mode you draw one tile and may pass. Round points add up to your game total; highest total after the last round wins.` }),
    ),
  });
}

// ---------------------------------------------------------------- wiring
$('#btn-play').onclick = () => (game.roundOver && !game.over ? doNextRound() : swapMode ? commitSwap() : commitPlay());
$('#btn-swap').onclick = toggleSwap;
$('#btn-takeback').onclick = takeBack;
$('#btn-pass').onclick = async () => { if (await confirm('Pass this turn?', { ok: 'Pass' })) doPass(); };
$('#btn-menu').onclick = showMenu;
$('#zoom-in').onclick = () => settings.set('tileSize', Math.min(72, settings.get('tileSize') + 6));
$('#zoom-out').onclick = () => settings.set('tileSize', Math.max(22, settings.get('tileSize') - 6));
window.addEventListener('resize', () => renderBoard());
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (swapMode) toggleSwap(); else { selected = null; renderHand(); renderBoard(); renderButtons(); } }
  else if (e.key === 'Enter' && ((isHumanTurn() && (tentative.length || swapSel.size)) || (game.roundOver && !game.over))) $('#btn-play').click();
});

// ---------------------------------------------------------------- boot
window.__abstrackle = {
  get game() { return game; }, get tentative() { return tentative; }, get selected() { return selected; },
  rules: R, ai: AI, G, settings,
  actions: {
    newGame: startNewGame, select: onHandTap, cell: onCellTap, place: placeTentative, takeBack, play: commitPlay,
    swapMode: toggleSwap, swap: commitSwap, pass: doPass, aiStep, nextRound: doNextRound, menu: showMenu, help: showHelp, settings: openSettings,
    render: renderAll, player: showPlayer, roundEnd: showRoundEnd,
    /** Debug: replace the game with a serialised state (G.toJSON shape) and continue from it. */
    load(json) {
      const g = G.fromJSON(json);
      if (!g) throw new Error('bad state');
      aiToken++; aiBusy = false; game = g;
      tentative = []; selected = null; swapMode = false; swapSel.clear(); layout = null; noticedTurn = -1; endShownFor = -1; roundShownFor = '';
      persist(); renderAll({ center: true });
      if (game.over) showEnd(); else if (game.roundOver) showRoundEnd(); else { onHumanTurn(); runAI(); }
      return game;
    },
  },
};
if (!restore()) startNewGame();
else {
  renderAll({ center: true });
  if (game.over) showEnd(); else if (game.roundOver) showRoundEnd(); else { onHumanTurn(); runAI(); }
}
