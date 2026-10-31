// Rounds UI controller. Rendering + input only; rules live in rules.js, state changes in game.js, opponents in ai.js.
import { h, $, clear, modal, confirm, toast, settingsPanel, drawer } from '../shared/ui.js';
import { onPress, elementAt } from '../shared/pointer.js';
import { makeSettings, load, save } from '../shared/storage.js';
import { makeRng, randomSeed } from '../shared/rng.js';
import { DEFAULTS, STRATEGIES, AI_NAMES, COLORS } from './config.js';
import * as R from './rules.js';
import * as G from './game.js';
import * as AI from './ai.js';

const SAVE_KEY = 'rounds.save';
const UI_KEY = 'rounds.ui';         // cards you have set aside in your phase slots (not part of the game state)
const settings = makeSettings('rounds.settings', DEFAULTS);
const rulesOpts = () => ({ allowSameNumberSets: !!settings.get('allowSameNumberSets'), goOutByHit: !!settings.get('goOutByHit') });

const stratOptions = [{ value: 'random', label: 'Random' }, ...Object.entries(STRATEGIES).map(([k, v]) => ({ value: k, label: v.name }))];
const SETTINGS_SCHEMA = [
  { key: 'opponents', label: 'Opponents', type: 'range', min: 1, max: 5, step: 1, help: 'Applies to the next new game' },
  { key: 'strat1', label: 'Seat 1 strategy', type: 'select', options: stratOptions },
  { key: 'strat2', label: 'Seat 2 strategy', type: 'select', options: stratOptions },
  { key: 'strat3', label: 'Seat 3 strategy', type: 'select', options: stratOptions },
  { key: 'strat4', label: 'Seat 4 strategy', type: 'select', options: stratOptions },
  { key: 'strat5', label: 'Seat 5 strategy', type: 'select', options: stratOptions },
  { key: 'aiDelayMs', label: 'AI delay (ms)', type: 'range', min: 0, max: 2000, step: 100, help: 'Pause between the visible steps of an opponent\'s turn' },
  { key: 'cardScale', label: 'Card size', type: 'range', min: 0.7, max: 1.3, step: 0.05, help: 'Upper limit; cards shrink to fit the screen' },
  { key: 'sortHand', label: 'Sort hand by', type: 'select', options: [{ value: 'number', label: 'Number' }, { value: 'color', label: 'Colour' }, { value: 'none', label: 'Draw order' }] },
  { key: 'promptLayDown', label: 'Ask to lay down when the slots are complete', type: 'bool' },
  { key: 'slotHints', label: 'Highlight groups a selected card can join', type: 'bool', help: 'Your phase slots and every laid-down group on the table. Off: spot the plays yourself' },
  { key: 'allowSameNumberSets', label: 'Two sets may share a number', type: 'bool', help: 'e.g. phase 1 with 5-5-5 and 5-5-5' },
  { key: 'goOutByHit', label: 'Go out by hitting the last card', type: 'bool', help: 'Off: a hand only ends with a discard' },
  { key: 'showOpponentHands', label: 'Show opponent hands', type: 'bool', help: 'Cheat / debug' },
];

// ---------------------------------------------------------------- state
let state = null;
const selected = new Set();       // card ids selected in your hand
let staged = [];                  // staged[k] = [cardId]: cards set aside in your phase slot k
let wildPos = [];                 // wildPos[k] = { cardId: value }: wilds of run slot k you moved to a chosen position
let picked = null;                // { slot, id }: a wild in one of your run slots, selected so it can be moved to an empty position
let aiRun = 0;                    // token: bumped to cancel a running AI turn (new game / restore)
let aiBusy = false;
let endShownFor = null;           // "hand:stage" key of the summary modal already shown
let layPromptedFor = null;        // "hand:turn" the lay-down prompt was already shown for
let humanTurnNo = 0;              // counts your draws, so the lay-down prompt appears at most once per turn
let logDrawer = null;
const HUMAN = 0;

const oppsEl = $('#opps'), deckEl = $('#deck'), discardEl = $('#discard'), logEl = $('#log');
const phaseEl = $('#phase'), hintEl = $('#hint'), stageEl = $('#stage'), handEl = $('#hand'), actionsEl = $('#actions'), statEl = $('#stat');
const main = $('.p10'), oppsBar = $('.opps-bar'), meHead = $('#me-head'), pilesEl = $('#piles'), handWrap = $('.hand-wrap');
const LANDSCAPE = window.matchMedia('(orientation: landscape) and (min-width: 640px)');

// ---------------------------------------------------------------- persistence
function persist() { save(SAVE_KEY, state); }
function persistUi() { save(UI_KEY, { seed: state.seed, hand: state.hand, staged, wildPos }); }
function restore() {
  const s = load(SAVE_KEY);
  if (!G.isValidState(s)) return false;
  state = s;
  const ui = load(UI_KEY);
  const mine = ui && ui.seed === state.seed && ui.hand === state.hand;
  staged = mine && Array.isArray(ui.staged) ? ui.staged.map(a => Array.isArray(a) ? a.map(Number) : []) : [];
  wildPos = mine && Array.isArray(ui.wildPos) ? ui.wildPos.map(o => (o && typeof o === 'object' ? { ...o } : {})) : [];
  return true;
}

// ---------------------------------------------------------------- helpers
const isHumanTurn = () => state.turn === HUMAN && (state.stage === 'draw' || state.stage === 'play');
const playing = () => isHumanTurn() && state.stage === 'play';
const drawing = () => isHumanTurn() && state.stage === 'draw';
const me = () => state.players[HUMAN];
const nameOf = (i) => state.players[i].name;
const profile = (p) => STRATEGIES[p.ai] || null;
const compsOf = (p) => (p.phase > 10 ? [] : R.phase(p.phase).comps);
const myComps = () => compsOf(me());
const groupsOf = (i) => state.table.filter(g => g.owner === i);

function sortedHand(ids) {
  const mode = settings.get('sortHand');
  if (mode === 'none') return ids;
  const kindRank = (c) => c.kind === 'num' ? 0 : c.kind === 'wild' ? 1 : 2;
  const colorRank = (c) => COLORS.indexOf(c.color);
  return [...ids].sort((a, b) => {
    const ca = R.card(a), cb = R.card(b);
    if (kindRank(ca) !== kindRank(cb)) return kindRank(ca) - kindRank(cb);
    if (ca.kind !== 'num') return a - b;
    if (mode === 'color') return colorRank(ca) - colorRank(cb) || ca.num - cb.num || a - b;
    return ca.num - cb.num || colorRank(ca) - colorRank(cb) || a - b;
  });
}

/** A card element. c may be null (missing slot). */
function cardEl(c, cls = '') {
  if (!c) return h('div.card.missing' + cls, {}, h('span.n', { text: '?' }));
  const kind = c.kind === 'num' ? `.c-${c.color}` : c.kind === 'wild' ? '.c-wild' : '.c-skip';
  const label = c.kind === 'num' ? String(c.num) : c.kind === 'wild' ? 'W' : 'S';
  return h(`div.card${kind}${cls}`, { data: { id: c.id } }, h('span.k', { text: label }), h('span.n', { text: label }), h('span.k.b', { text: label }));
}

/** Cards of a laid-down group; wilds in runs show the number they stand for. */
function groupCards(g, cls = '') {
  return g.cards.map((id, i) => {
    const el = cardEl(R.card(id), cls);
    if (g.type === 'run' && R.isWild(R.card(id))) el.append(h('span.as', { text: String(R.runValueAt(g, i)) }));
    return el;
  });
}

/** A fan of face-down cards standing for a hand of n cards. */
function fanEl(n) {
  const step = n <= 1 ? 0 : Math.max(2, Math.min(5, Math.floor(60 / (n - 1))));
  return h('div.fan', { style: { '--step': step + 'px' }, title: `${n} card${n === 1 ? '' : 's'}`, 'aria-label': `${n} cards` },
    n ? Array.from({ length: n }, () => h('div.card.back')) : h('span.none', { text: 'no cards' }));
}

const selectedCard = () => (selected.size === 1 ? R.card([...selected][0]) : null);

// ---------------------------------------------------------------- staging (your phase slots before laying down)
const stagedIds = () => staged.flat();
const stagedSet = () => new Set(stagedIds());
const isRunSlot = (k) => myComps()[k]?.type === 'run';

/** Keep the slot arrays in step with the current phase and hand. */
function syncStaged() {
  const p = me();
  const comps = compsOf(p);
  if (p.laidDown || !comps.length) { staged = []; wildPos = []; picked = null; return; }
  const inHand = new Set(p.hand);
  staged = comps.map((_, k) => (staged[k] || []).filter(id => inHand.has(id)));
  wildPos = comps.map((_, k) => {
    const o = wildPos[k] || {}, keep = {};
    for (const id of staged[k]) if (o[id] != null && R.isWild(R.card(id))) keep[id] = Number(o[id]);
    return keep;
  });
  if (picked && !(staged[picked.slot] || []).includes(picked.id)) picked = null;
}

/** How your slot k is shown: card positions, validity, what is still needed (see rules.js:layoutGroup). */
function layoutOf(k) {
  return R.layoutGroup(myComps()[k], R.cards(staged[k] || []), { wildPos: wildPos[k] || {}, picked: picked && picked.slot === k ? picked.id : null });
}
const layouts = () => myComps().map((_, k) => layoutOf(k));

/** Set cards aside in slot k. `value`: the run position a wild was dropped on (null = let the rules place it). */
function stageCards(k, ids, value = null) {
  syncStaged();
  if (k < 0 || k >= staged.length) return;
  const moving = new Set(ids);
  staged = staged.map(a => a.filter(id => !moving.has(id)));
  wildPos = wildPos.map(o => { const c = { ...o }; for (const id of ids) delete c[id]; return c; });
  staged[k].push(...ids);
  if (isRunSlot(k)) {
    // a natural landing on a pinned wild's value unpins it (it then floats like a newly added wild)
    for (const id of ids) { const c = R.card(id); if (R.isNum(c)) for (const [w, v] of Object.entries(wildPos[k])) if (v === c.num) delete wildPos[k][w]; }
    const w = ids.find(id => R.isWild(R.card(id)));
    if (value != null && w != null) wildPos[k][w] = Number(value);
  }
  for (const id of ids) selected.delete(id);
  picked = null;
  afterStageChange();
}

/** Return cards from your slots to your hand. */
function unstage(ids) {
  const moving = new Set(ids);
  staged = staged.map(a => a.filter(id => !moving.has(id)));
  picked = null;
  afterStageChange();
}

/** Move a wild of run slot k to the empty position standing for `value`. The other wilds stay where they are. */
function placeWild(k, id, value) {
  const pins = { ...(wildPos[k] || {}) };
  for (const q of layoutOf(k).positions) if (q.card && R.isWild(q.card) && q.card.id !== id && q.value != null) pins[q.card.id] = q.value;
  pins[id] = Number(value);
  wildPos[k] = pins;
  picked = null;
  afterStageChange();
}

function afterStageChange() {
  renderMe(); renderTargets(); renderActions(); fitCards();
  persistUi();
  maybePromptLayDown();
}

/** When your slots hold a complete phase during your turn, offer to lay them down (once per turn). */
async function maybePromptLayDown() {
  if (!settings.get('promptLayDown')) return;
  const p = me();
  if (!playing() || p.laidDown || p.phase > 10) return;
  const ids = stagedIds();
  if (!ids.length || !layouts().every(l => l.valid)) return;
  if (!state.opts.goOutByHit && ids.length === p.hand.length) return;
  const sig = `${state.hand}:${humanTurnNo}`;
  if (layPromptedFor === sig) return;
  layPromptedFor = sig;
  const ok = await confirm(`The cards in your slots complete phase ${p.phase} (${R.phase(p.phase).label}). Lay them down now?`, { ok: 'Lay down', cancel: 'Not yet', title: 'Phase complete' });
  if (ok && playing() && !me().laidDown) layDownSlots();
}

// ---------------------------------------------------------------- rendering
function render() {
  main.style.setProperty('--scale', settings.get('cardScale'));
  statEl.textContent = `Hand ${state.hand}`;
  renderOpponents();
  renderPiles();
  renderMe();
  renderTargets();
  renderActions();
  fitCards();
}

/** An empty position of a group you are assembling: the value it stands for, dashed. */
function posEl(p, layout) {
  const text = layout.type === 'color' || p.value == null ? (p.ext ? '+' : '?') : String(p.value);
  const cls = (p.need ? '.need' : '') + (p.ext ? '.ext' : '') + (layout.type === 'color' && p.value ? `.k-${p.value}` : '');
  const el = h('div.card.pos' + cls, {}, h('span.k', { text }), h('span.n', { text }), h('span.k.r', { text }));
  if (layout.type === 'run' && p.value != null) el.dataset.value = String(p.value);
  return el;
}

/** A card you have set aside; wilds in runs show the value they stand for. */
function stagedCardEl(p, layout) {
  const el = cardEl(p.card, picked && picked.id === p.card.id ? '.picked' : '');
  if (layout.type === 'run' && R.isWild(p.card) && p.value != null) el.append(h('span.as', { text: String(p.value) }));
  return el;
}

/** Phase slot: the laid-down group if there is one; for you before laying down, the positions of the group you are assembling. */
function slotEl(comp, k, { group = null, layout = null, owner = null } = {}) {
  let body = [], cls = '.empty';
  if (group) { body = groupCards(group, '.small'); cls = '.filled'; }
  else if (layout) {
    body = layout.positions.map(p => p.card ? stagedCardEl(p, layout) : posEl(p, layout));
    cls = (layout.valid ? '.complete' : '') + (layout.positions.some(p => p.card) ? '' : '.empty');
  }
  const data = { slot: k, owner };
  if (group) data.group = group.id;
  return h('div.slot' + cls, { data, style: { '--n': String(Math.max(1, body.length)) } },
    h('div.slot-cards', { style: { '--n': String(Math.max(1, body.length)) } }, body),
    h('div.slot-label', { text: R.compLabel(comp) }));
}

function renderOpponents() {
  clear(oppsEl);
  state.players.forEach((p, i) => {
    if (i === HUMAN) return;
    const prof = profile(p);
    const active = state.turn === i && (state.stage === 'draw' || state.stage === 'play');
    const groups = groupsOf(i);
    const comps = compsOf(p);
    const el = h('div.opp' + (active ? '.active' : '') + (p.skipped ? '.skipped' : '') + (p.laidDown ? '.done' : ''), { data: { player: i } },
      h('div.opp-head', {},
        h('span.name', { text: p.name }),
        prof ? h('span.badge', { text: prof.name, title: prof.name, style: { '--badge': prof.color } }) : null,
        p.skipped ? h('span.skipmark', { text: 'SKIPPED' }) : null),
      h('div.opp-meta', {},
        h('span', { html: p.phase > 10 ? '<b>Done</b>' : `Phase <b>${p.phase}</b>` }),
        h('span', { html: `<b>${p.score}</b> pts` }),
        h('span.spacer'),
        fanEl(p.hand.length)),
      comps.length ? h('div.slots', {}, comps.map((c, k) => slotEl(c, k, { group: groups[k] || null, owner: i }))) : null,
      settings.get('showOpponentHands') ? h('div.opp-hand', {}, sortedHand(p.hand).map(id => cardEl(R.card(id), '.small'))) : null,
    );
    oppsEl.append(el);
  });
  const act = oppsEl.querySelector('.opp.active');
  if (act && !LANDSCAPE.matches) act.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

function renderPiles() {
  clear(deckEl);
  deckEl.classList.toggle('ready', drawing());
  deckEl.classList.toggle('empty', !state.deck.length);
  deckEl.setAttribute('aria-disabled', String(!drawing()));
  if (state.deck.length) deckEl.append(h('div.card.back'), h('span.count', { text: String(state.deck.length) }));
  deckEl.append(h('span.label', { text: 'Deck' }));

  clear(discardEl);
  const top = G.discardTop(state);
  const takeable = drawing() && top && !R.isSkip(top);
  discardEl.classList.toggle('ready', !!takeable);
  discardEl.classList.toggle('empty', !top);
  discardEl.setAttribute('aria-disabled', String(!takeable && !playing()));
  if (top) discardEl.append(cardEl(top));
  discardEl.append(h('span.label', { text: 'Discard' }));

  clear(logEl);
  const lines = state.log.slice(-2);
  lines.forEach((l, i) => logEl.append(h('div' + (i === lines.length - 1 ? '.latest' : ''), { text: l })));
}

/** Light up every destination the current selection can go to. */
function renderTargets() {
  for (const el of main.querySelectorAll('.target')) el.classList.remove('target');
  const p = selectionPayload();
  if (!p) return;
  const allow = (t) => whyNot(p, t) == null;
  const hints = !!settings.get('slotHints');
  if (hints) for (const el of main.querySelectorAll('.slot[data-group]')) el.classList.toggle('target', allow({ kind: 'group', id: Number(el.dataset.group) }));
  for (const el of oppsEl.querySelectorAll('.opp[data-player]')) el.classList.toggle('target', allow({ kind: 'player', i: Number(el.dataset.player) }));
  for (const el of stageEl.querySelectorAll('.slot:not([data-group])')) {
    const k = Number(el.dataset.slot);
    if (p.from === 'hand') { if (hints) el.classList.toggle('target', allow({ kind: 'slot', k })); }
    else for (const pos of el.querySelectorAll('.card.pos[data-value]')) pos.classList.toggle('target', allow({ kind: 'slot', k, value: Number(pos.dataset.value) }));
  }
  discardEl.classList.toggle('target', allow({ kind: 'discard' }));
  handWrap.classList.toggle('target', allow({ kind: 'hand' }));
}

function renderMe() {
  const p = me();
  syncStaged();
  phaseEl.textContent = p.phase > 10 ? 'Done' : `Phase ${p.phase}`;
  hintEl.className = 'hint';
  if (state.stage === 'handEnd' || state.stage === 'gameEnd') hintEl.textContent = state.stage === 'gameEnd' ? 'Game over' : 'Hand over';
  else if (p.phase > 10) hintEl.textContent = 'All phases done';
  else if (p.laidDown) { hintEl.textContent = 'Laid down ✓'; hintEl.classList.add('ok'); }
  else {
    const d = G.deficitOf(state, HUMAN);
    if (d.need === 0) { hintEl.textContent = 'Complete — lay it down!'; hintEl.classList.add('ok'); }
    else hintEl.textContent = `${d.need} card${d.need === 1 ? '' : 's'} away`;
  }
  // phase slots: laid-down groups, or the groups you are assembling
  clear(stageEl);
  const comps = compsOf(p);
  const groups = groupsOf(HUMAN);
  const lays = p.laidDown ? null : layouts();
  comps.forEach((c, k) => stageEl.append(slotEl(c, k, lays ? { layout: lays[k], owner: HUMAN } : { group: groups[k] || null, owner: HUMAN })));
  // hand: everything not set aside
  clear(handEl);
  const inSlots = stagedSet();
  for (const id of [...selected]) if (!p.hand.includes(id) || inSlots.has(id)) selected.delete(id);   // drop stale selections
  const ids = sortedHand(p.hand.filter(id => !inSlots.has(id)));
  if (!ids.length) handEl.append(h('div.empty', { text: p.hand.length ? 'All cards are in your slots' : 'No cards' }));
  for (const id of ids) handEl.append(cardEl(R.card(id), selected.has(id) ? '.sel' : ''));
}

function renderActions() {
  clear(actionsEl);
  const p = me();
  if (state.stage === 'handEnd') { actionsEl.append(h('button.btn.btn-primary', { text: 'Next hand', onClick: () => showSummary() })); return; }
  if (state.stage === 'gameEnd') { actionsEl.append(h('button.btn.btn-primary', { text: 'Game over — results', onClick: () => showSummary() })); return; }
  if (!isHumanTurn()) {
    const cur = G.currentPlayer(state);
    actionsEl.append(h('div.status', { text: `${cur.name} is playing…` }));
    return;
  }
  if (state.stage === 'draw') {
    const top = G.discardTop(state);
    actionsEl.append(
      h('button.btn.btn-primary#btn-draw', { text: 'Draw', onClick: () => doDraw('deck') }),
      h('button.btn#btn-take', { text: 'Take discard', disabled: !top || R.isSkip(top), onClick: () => doDraw('discard') }),
    );
    return;
  }
  const n = selected.size;
  if (!p.laidDown && p.phase <= 10) {
    const any = stagedIds().length > 0;
    const ready = any && layouts().every(l => l.valid);
    actionsEl.append(h('button.btn#btn-lay' + (ready ? '.btn-primary' : ''), { text: 'Lay down', disabled: !any, onClick: doLayDown }));
  }
  if (p.laidDown) actionsEl.append(h('button.btn#btn-hit', { text: 'Hit', disabled: n !== 1, onClick: doHitPrompt }));
  actionsEl.append(h('button.btn' + (p.laidDown || n === 1 ? '.btn-primary' : '') + '#btn-discard', { text: 'Discard', disabled: n !== 1, onClick: () => { const c = selectedCard(); if (c) doDiscard(c.id); else toast('Select exactly one card to discard'); } }));
}

/** Size the cards in your slots and hand so both rows fit the space left by the other rows. */
function fitCards() {
  const max = Math.round(56 * (Number(settings.get('cardScale')) || 1));
  const landscape = LANDSCAPE.matches;
  const fixed = oppsBar.offsetHeight + meHead.offsetHeight + (landscape ? 0 : pilesEl.offsetHeight + actionsEl.offsetHeight);
  const chrome = 72;   // slot label, paddings, the raised selected card
  const avail = main.clientHeight - fixed - chrome;
  const w = Math.max(30, Math.min(max, Math.floor(avail / 2.8)));
  main.style.setProperty('--cw', w + 'px');
  // your slots (widths ∝ positions shown) shrink their cards only as far as needed to keep ≥ 55% of every card visible
  const counts = [...stageEl.querySelectorAll('.slot .slot-cards')].map(el => el.childElementCount || 1);
  let sw = w;
  if (counts.length) {
    const total = counts.reduce((a, b) => a + b, 0);
    const width = stageEl.clientWidth - 8 * (counts.length - 1);
    for (const n of counts) sw = Math.min(sw, Math.floor((width * n / total - 12) / (1 + 0.55 * (n - 1))));
    sw = Math.max(30, sw);
  }
  main.style.setProperty('--sw', sw + 'px');
}

// ---------------------------------------------------------------- game flow
function startNewGame(seed = randomSeed()) {
  const n = Math.min(5, Math.max(1, Number(settings.get('opponents')) || 3));
  const rng = makeRng((seed ^ 0x9e3779b9) >>> 0);
  // 'random' seats cycle through a shuffled list of profiles so a table gets distinct strategies when possible
  const keys = rng.shuffle(Object.keys(STRATEGIES));
  let next = 0;
  const players = [{ name: 'You', ai: null }];
  for (let i = 0; i < n; i++) {
    const pref = settings.get('strat' + (i + 1));
    players.push({ name: AI_NAMES[i], ai: STRATEGIES[pref] ? pref : keys[next++ % keys.length] });
  }
  aiRun++; aiBusy = false;
  selected.clear();
  staged = []; wildPos = []; picked = null;
  endShownFor = null; layPromptedFor = null; humanTurnNo = 0;
  state = G.newGame({ seed, players, opts: rulesOpts() });
  afterAction();
}

/** Common tail of every state change. */
function afterAction() {
  render();
  persist();
  persistUi();
  checkHandEnd();
  scheduleAi();
  maybePromptLayDown();
}

function gameInProgress() {
  return state.stage !== 'gameEnd' && (state.hand > 1 || state.table.length > 0 || state.players.some(p => p.hand.length !== 10) || state.stage === 'play');
}

// ---------------------------------------------------------------- moves: one model for taps and drags
// payload: what is being moved — { from: 'hand' | 'slot' | 'deck' | 'discard', ids: [cardId], slot?: k }
// target:  where it goes    — { kind: 'slot', k, value? } | { kind: 'hand' } | { kind: 'discard' } | { kind: 'group', id } | { kind: 'deck' }
//                              | { kind: 'player', i } (an opponent's panel: a Skip discarded onto them skips them)
// A target's `value` is the run position (see layoutGroup) that was tapped / dropped on; it only matters for wilds.

/** The current selection as a payload: a picked wild in one of your slots, or the selected hand cards. */
function selectionPayload() {
  if (picked) return { from: 'slot', ids: [picked.id], slot: picked.slot };
  return selected.size ? { from: 'hand', ids: [...selected] } : null;
}

/** Why the move can't happen: null = it can; '' = doesn't apply (stay silent); otherwise a message for the player. */
function whyNot(p, t) {
  if (p.from === 'deck') return drawing() && (t.kind === 'hand' || t.kind === 'slot') ? null : '';
  if (p.from === 'discard') {
    if (!drawing() || !(t.kind === 'hand' || t.kind === 'slot')) return '';
    return R.isSkip(R.card(p.ids[0])) ? 'A Skip can\'t be taken from the discard pile' : null;
  }
  const cs = R.cards(p.ids);
  switch (t.kind) {
    case 'hand': return p.from === 'slot' ? null : '';
    case 'discard':
      if (!playing() || p.from !== 'hand') return '';
      return cs.length === 1 ? null : 'Discard one card at a time';
    case 'player': {
      if (!playing() || p.from !== 'hand' || cs.length !== 1 || !R.isSkip(cs[0])) return '';
      return G.eligibleSkipTargets(state).includes(t.i) ? null : `${nameOf(t.i)} can't be skipped right now`;
    }
    case 'group': {
      if (!playing() || p.from !== 'hand') return '';
      if (!me().laidDown) return 'Lay down your phase first, then you can hit';
      if (cs.length !== 1) return 'Select exactly one card to hit with';
      const g = G.groupById(state, t.id);
      return g && R.canHit(g, cs[0]) ? null : `${R.cardName(cs[0])} doesn't fit on that group`;
    }
    case 'slot': {
      if (me().laidDown || t.k >= staged.length) return '';
      if (p.from === 'slot' && p.slot === t.k) {
        // a wild moving to an empty position of its own run
        if (t.value == null || cs.length !== 1 || !R.isWild(cs[0]) || !isRunSlot(t.k)) return '';
        return layoutOf(t.k).positions.some(q => !q.card && q.value === t.value) ? null : '';
      }
      const why = R.whyNotFitAll(myComps()[t.k], R.cards(staged[t.k]), cs);
      return why ? `${cs.length === 1 ? R.cardName(cs[0]) : 'Those cards'} can't go there: ${why}` : null;
    }
    default: return '';
  }
}

/** Carry out a move if whyNot allows it (toasting the reason otherwise). Returns whether something happened. */
function perform(p, t) {
  const why = whyNot(p, t);
  if (why != null) { if (why) toast(why, 2200); return false; }
  if (p.from === 'deck') { doDraw('deck'); return true; }
  if (p.from === 'discard') {
    const id = p.ids[0];
    doDraw('discard');
    if (t.kind === 'slot' && !me().laidDown && me().hand.includes(id) && R.whyNotFitAll(myComps()[t.k], R.cards(staged[t.k] || []), [R.card(id)]) == null) stageCards(t.k, [id], t.value);
    return true;
  }
  switch (t.kind) {
    case 'hand': unstage(p.ids); break;
    case 'discard': doDiscard(p.ids[0]); break;
    case 'player': doDiscard(p.ids[0], t.i); break;
    case 'group': doHit(p.ids[0], t.id); break;
    case 'slot': if (p.from === 'slot' && p.slot === t.k) placeWild(t.k, p.ids[0], t.value); else stageCards(t.k, p.ids, t.value); break;
  }
  return true;
}

/** Tap on a destination: move the selection there, or explain what to select. */
function tapTarget(t) {
  const p = selectionPayload();
  if (p) { perform(p, t); return; }
  if (t.kind === 'group') { if (playing()) toast(me().laidDown ? 'Select a card in your hand, then tap a group to hit it' : 'Lay down your phase first, then you can hit'); }
  else if (t.kind === 'slot' && !me().laidDown) toast('Select cards in your hand, then tap a slot to set them aside');
}

// ---------------------------------------------------------------- human actions
function doDraw(from) {
  if (!isHumanTurn()) return;
  const before = me().hand.length;
  const r = G.draw(state, from);
  if (!r.ok) { toast(r.reason); return; }
  humanTurnNo++;
  afterAction();
  if (me().hand.length > before) {
    const newId = me().hand[me().hand.length - 1];
    handEl.querySelector(`.card[data-id="${newId}"]`)?.classList.add('new');
  }
}

/** Lay down the cards in your slots, arranged exactly as shown. */
function doLayDown() {
  if (!playing()) return;
  if (!stagedIds().length) { toast('Put the cards of your phase in the slots above first'); return; }
  const comps = myComps(), lays = layouts();
  const bad = lays.findIndex(l => !l.valid);
  if (bad >= 0) { toast(`${R.compLabel(comps[bad])} ${lays[bad].reason}`, 2600); return; }
  layDownSlots();
}

function layDownSlots() {
  const lists = layouts().map(l => l.positions.filter(p => p.card).map(p => p.card.id));
  const r = G.layDownGroups(state, lists);
  if (!r.ok) { toast(r.reason, 2600); return; }
  selected.clear(); picked = null;
  staged = []; wildPos = [];
  afterAction();
  if (state.stage === 'play') toast('Laid down! Hit cards onto any group, then discard.');
}

function doHitPrompt() {
  const c = selectedCard();
  if (!c) { toast('Select exactly one card to hit with'); return; }
  const targets = state.table.filter(g => R.canHit(g, c));
  if (!targets.length) { toast(`${R.cardName(c)} doesn't fit on any group`); return; }
  if (targets.length === 1) { doHit(c.id, targets[0].id); return; }
  toast('Tap the highlighted group to hit');
}

async function doHit(id, groupId) {
  if (!playing()) return;
  if (!me().laidDown) { toast('Lay down your phase before hitting'); return; }
  const c = R.card(id);
  const g = G.groupById(state, groupId);
  if (!g) return;
  const options = R.hitOptions(g, c);
  if (!options.length) { toast(`${R.cardName(c)} doesn't fit on that group`); return; }
  let end = options[0];
  if (options.length > 1) {
    end = await modal({
      title: 'Which end of the run?',
      body: `Play the Wild as a ${g.lo - 1} (low end) or as a ${g.hi + 1} (high end)?`,
      buttons: [{ label: `Low (${g.lo - 1})`, value: 'low' }, { label: `High (${g.hi + 1})`, value: 'high', primary: true }],
    });
    if (!end || !playing()) return;
  }
  const r = G.hit(state, id, groupId, end);
  if (!r.ok) { toast(r.reason); return; }
  selected.clear();
  afterAction();
}

/** Discard a card; a Skip needs a `target` player (asked for when not given and more than one is eligible). */
async function doDiscard(id, target = null) {
  if (!playing()) return;
  const c = R.card(id);
  if (R.isSkip(c) && target == null) {
    const eligible = G.eligibleSkipTargets(state);
    if (eligible.length === 1) target = eligible[0];
    else if (eligible.length > 1) {
      target = await chooseSkipTarget(eligible);
      if (target == null || !playing()) return;
    }
  }
  const r = G.discard(state, id, target);
  if (!r.ok) { toast(r.reason); return; }
  selected.clear(); picked = null;
  afterAction();
}

function chooseSkipTarget(eligible) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; backdrop.remove(); resolve(v); } };
    const list = h('div.targets', {}, eligible.map(i => {
      const p = state.players[i];
      return h('button.btn', { onClick: () => finish(i) }, `${p.name}`, h('span.muted', { text: ` · ${p.hand.length} cards` }));
    }));
    const box = h('div.modal', {}, h('h2.modal-title', { text: 'Skip whom?' }), h('div.modal-body', {}, list),
      h('div.modal-buttons', {}, h('button.btn', { text: 'Cancel', onClick: () => finish(null) })));
    const backdrop = h('div.modal-backdrop', { onClick: (e) => { if (e.target === backdrop) finish(null); } }, box);
    document.body.append(backdrop);
  });
}

function refreshSelection() { renderMe(); renderTargets(); renderActions(); }
function toggleSelect(id) {
  picked = null;
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  refreshSelection();
}
function clearSelection() { selected.clear(); picked = null; refreshSelection(); }

// ---------------------------------------------------------------- drag: hand / slots / piles → slots / hand / discard / groups
let drag = null;   // { payload, ghost, over }
function startDrag(i, payload) {
  const ghost = payload.from === 'deck' ? h('div.card.back.ghost') : cardEl(R.card(payload.ids[0]), '.ghost');
  ghost.style.setProperty('--w', main.style.getPropertyValue('--cw') || '56px');
  if (payload.ids.length > 1) ghost.append(h('span.cnt', { text: String(payload.ids.length) }));
  document.body.append(ghost);
  drag = { payload, ghost, over: null };
  moveDrag(i);
  return true;
}

/** The drop target under a point for this payload, if any. */
function targetAt(x, y, payload) {
  const over = elementAt(x, y, [drag?.ghost]);
  if (!over || !over.closest) return null;
  const opp = over.closest('.opp[data-player]');
  if (opp && payload.ids.length === 1 && R.isSkip(R.card(payload.ids[0]))) return { kind: 'player', i: Number(opp.dataset.player) };
  const slot = over.closest('.slot');
  if (slot) {
    if (slot.dataset.group) return { kind: 'group', id: Number(slot.dataset.group) };
    if (Number(slot.dataset.owner) !== HUMAN) return null;
    const pos = over.closest('.card.pos');
    const single = payload.ids.length === 1 && R.card(payload.ids[0]);
    const value = pos?.dataset.value != null && single && R.isWild(single) ? Number(pos.dataset.value) : null;   // only wilds land on a chosen position
    return { kind: 'slot', k: Number(slot.dataset.slot), value };
  }
  if (over.closest('#discard')) return { kind: 'discard' };
  if (over.closest('#deck')) return { kind: 'deck' };
  if (over.closest('.hand-wrap, .me')) return { kind: 'hand' };
  return null;
}

/** The element that lights up while dragging over a target. */
function targetEl(t) {
  switch (t.kind) {
    case 'slot': {
      const slot = stageEl.querySelector(`.slot[data-slot="${t.k}"]:not([data-group])`);
      return (t.value != null && slot?.querySelector(`.card.pos[data-value="${t.value}"]`)) || slot;
    }
    case 'group': return main.querySelector(`.slot[data-group="${t.id}"]`);
    case 'player': return oppsEl.querySelector(`.opp[data-player="${t.i}"]`);
    case 'discard': return discardEl;
    case 'deck': return deckEl;
    case 'hand': return handWrap;
    default: return null;
  }
}

function moveDrag(i) {
  if (!drag) return;
  drag.ghost.style.left = i.clientX + 'px';
  drag.ghost.style.top = i.clientY + 'px';
  const t = targetAt(i.clientX, i.clientY, drag.payload);
  const el = t && whyNot(drag.payload, t) == null ? targetEl(t) : null;
  if (el !== drag.over) { drag.over?.classList.remove('dropping'); el?.classList.add('dropping'); drag.over = el; }
}

function endDrag(i, cancelled) {
  if (!drag) return;
  const { payload, ghost, over } = drag;
  drag = null;
  ghost.remove();
  over?.classList.remove('dropping');
  if (cancelled) return;
  const t = targetAt(i.clientX, i.clientY, payload);
  if (t) perform(payload, t);
}

const dragHandlers = { onDragMove(i) { moveDrag(i); }, onDragEnd(i, dx, dy, cancelled) { endDrag(i, cancelled); } };

// your hand: tap to select; with a wild picked in a slot, tapping the hand returns it
onPress(handWrap, {
  ...dragHandlers,
  onTap(i) {
    if (picked) { unstage([picked.id]); return; }
    const el = i.downTarget?.closest?.('.card');
    if (el && el.dataset.id != null) toggleSelect(Number(el.dataset.id));
    else if (selected.size) clearSelection();
  },
  onDragStart(i) {
    const el = i.downTarget?.closest?.('.card');
    if (!el || el.dataset.id == null) return false;
    if (me().laidDown && !playing()) return false;   // nowhere to drag to
    const id = Number(el.dataset.id);
    return startDrag(i, { from: 'hand', ids: selected.has(id) ? [...selected] : [id] });
  },
});

// your slots: tap a card to return it (a wild in a run: pick it, then tap the position it should move to); tap a slot to fill it
onPress(stageEl, {
  ...dragHandlers,
  onTap(i) {
    const slot = i.downTarget?.closest?.('.slot');
    if (!slot) return;
    if (slot.dataset.group) { tapTarget({ kind: 'group', id: Number(slot.dataset.group) }); return; }
    const k = Number(slot.dataset.slot);
    const card = i.downTarget?.closest?.('.card[data-id]');
    const pos = i.downTarget?.closest?.('.card.pos');
    const value = pos?.dataset.value != null ? Number(pos.dataset.value) : null;
    const id = card ? Number(card.dataset.id) : null;
    if (picked) {
      if (picked.slot === k && value != null) { perform(selectionPayload(), { kind: 'slot', k, value }); return; }
      const same = picked.id === id;
      picked = null;
      if (same || id == null) { refreshSelection(); return; }
      // another card was tapped: treat it as a fresh tap
    }
    if (selected.size) { tapTarget({ kind: 'slot', k, value }); return; }
    if (id == null) { tapTarget({ kind: 'slot', k }); return; }
    if (isRunSlot(k) && R.isWild(R.card(id))) { picked = { slot: k, id }; refreshSelection(); }
    else unstage([id]);
  },
  onDragStart(i) {
    const card = i.downTarget?.closest?.('.card[data-id]');
    const slot = i.downTarget?.closest?.('.slot');
    if (!card || !slot || slot.dataset.group) return false;
    return startDrag(i, { from: 'slot', ids: [Number(card.dataset.id)], slot: Number(slot.dataset.slot) });
  },
});

// opponents: their groups are hit targets; with a Skip selected, the panel itself is the target
onPress(oppsEl, {
  onTap(i) {
    const opp = i.downTarget?.closest?.('.opp[data-player]');
    const c = selectedCard();
    if (opp && c && R.isSkip(c)) { tapTarget({ kind: 'player', i: Number(opp.dataset.player) }); return; }
    const slot = i.downTarget?.closest?.('.slot');
    if (slot?.dataset.group) tapTarget({ kind: 'group', id: Number(slot.dataset.group) });
  },
  preventDefault: false,
});

// piles: tap or drag the deck / discard to draw; tap the discard with a card selected to discard it
onPress(pilesEl, {
  ...dragHandlers,
  onTap(i) {
    const t = i.downTarget;
    if (!t?.closest) return;
    if (t.closest('#log')) { openLog(); return; }
    if (t.closest('#deck')) { if (drawing()) doDraw('deck'); else if (playing()) toast('You already drew this turn'); return; }
    if (t.closest('#discard')) {
      if (drawing()) { doDraw('discard'); return; }
      const p = selectionPayload();
      if (p && p.from === 'hand') perform(p, { kind: 'discard' });
      else if (playing() && !picked) toast('Select a card in your hand, then tap here to discard it');
    }
  },
  onDragStart(i) {
    const t = i.downTarget;
    if (!t?.closest || !drawing()) return false;
    if (t.closest('#deck')) return startDrag(i, { from: 'deck', ids: [] });
    if (t.closest('#discard')) { const top = G.discardTop(state); return top && !R.isSkip(top) ? startDrag(i, { from: 'discard', ids: [top.id] }) : false; }
    return false;
  },
});

$('#btn-menu').addEventListener('click', showMenu);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') clearSelection(); });
window.addEventListener('resize', () => { if (state) fitCards(); });

// ---------------------------------------------------------------- AI turns
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function scheduleAi() {
  if (aiBusy || !state || !G.isAiTurn(state)) return;
  aiBusy = true;
  const run = ++aiRun;
  runAiTurn(run).catch(err => { console.error(err); toast('AI error: ' + err.message); }).finally(() => { if (run === aiRun) { aiBusy = false; } });
}

async function runAiTurn(run) {
  const alive = () => run === aiRun && state && G.isAiTurn(state);
  const pause = async () => { await sleep(Math.max(0, Number(settings.get('aiDelayMs')) || 0)); return alive(); };
  const idx = state.turn;
  const prof = AI.profileOf(state.players[idx].ai);
  if (!await pause()) return;
  if (state.stage === 'draw') {
    G.draw(state, AI.chooseDraw(state, idx, prof));
    render(); persist();
    if (!await pause()) return;
  }
  const plan = AI.choosePlays(state, idx, prof);
  if (plan.layDown) {
    G.layDown(state, plan.layDown);
    render(); persist();
    if (state.stage !== 'play') return finishAiTurn();
    if (!await pause()) return;
  }
  if (plan.hits.length) {
    for (const x of plan.hits) { if (state.stage !== 'play') break; G.hit(state, x.card, x.group, x.end); }
    render(); persist();
    if (state.stage !== 'play') return finishAiTurn();
    if (!await pause()) return;
  }
  if (plan.discard) G.discard(state, plan.discard.card, plan.discard.target);
  finishAiTurn();
}

function finishAiTurn() {
  aiBusy = false;
  const skippedYou = state.log.slice(-3).some(l => l === 'You were skipped');
  render(); persist(); checkHandEnd();
  if (isHumanTurn()) toast(skippedYou ? 'You were skipped — your next turn' : 'Your turn', 1200);
  scheduleAi();
}

// ---------------------------------------------------------------- hand end / game end
function checkHandEnd() {
  if (state.stage !== 'handEnd' && state.stage !== 'gameEnd') return;
  const key = `${state.hand}:${state.stage}`;
  if (endShownFor === key) return;
  endShownFor = key;
  setTimeout(showSummary, 250);
}

function summaryTable(sum) {
  const rows = sum.gameOver ? [...sum.rows].sort((a, b) => a.total - b.total) : sum.rows;
  return h('table.summary', {},
    h('thead', {}, h('tr', {}, h('th', { text: 'Player' }), h('th', { text: 'Phase' }), h('th', { text: 'Next' }), h('th', { text: '+Pts' }), h('th', { text: 'Total' }))),
    h('tbody', {}, rows.map(r => h('tr' + (sum.winners.includes(r.index) ? '.winner' : r.wentOut ? '.out' : ''), {},
      h('td', { text: r.name + (r.wentOut ? ' (out)' : '') }),
      h('td', {}, h('span' + (r.completed ? '.yes' : '.no'), { text: r.completed ? `${r.phaseBefore} ✓` : `${r.phaseBefore} ✗` })),
      h('td', { text: r.phaseAfter > 10 ? 'done' : String(r.phaseAfter) }),
      h('td', { text: r.points ? '+' + r.points : '—' }),
      h('td', { text: String(r.total) })))));
}

async function showSummary() {
  const sum = state.summary;
  if (!sum) return;
  if (sum.gameOver) {
    const winners = sum.winners.map(nameOf);
    const title = winners.includes('You') && winners.length === 1 ? 'You win! 🎉' : `${winners.join(' & ')} win${winners.length === 1 ? 's' : ''}`;
    const v = await modal({ title, body: h('div', {}, h('p.muted', { text: `Game over after ${sum.hand} hands. Lowest score among those who finished the final phase wins.` }), summaryTable(sum)),
      buttons: [{ label: 'Close', value: false }, { label: 'New game', value: true, primary: true }] });
    if (v) startNewGame();
    return;
  }
  const v = await modal({ title: `Hand ${sum.hand} — ${nameOf(sum.outPlayer)} went out`, body: summaryTable(sum), dismissable: false,
    buttons: [{ label: 'Next hand', value: true, primary: true }] });
  if (v && state.stage === 'handEnd') { G.nextHand(state); selected.clear(); staged = []; wildPos = []; picked = null; layPromptedFor = null; afterAction(); }
}

// ---------------------------------------------------------------- menu, settings, help, log
async function showMenu() {
  const choice = await modal({
    title: 'Rounds',
    body: h('div.muted', { text: `Seed ${state.seed} · hand ${state.hand} · ${state.players.length} players` }),
    buttons: [
      { label: 'Exit', value: 'exit' },
      { label: 'Settings', value: 'settings' },
      { label: 'Help', value: 'help' },
      { label: 'Log', value: 'log' },
      { label: 'New (seed…)', value: 'seed' },
      { label: 'New game', value: 'new', primary: true },
    ],
  });
  if (choice === 'exit') location.href = '../';
  else if (choice === 'new') { if (!gameInProgress() || await confirm('Abandon the current game and start a new one?', { ok: 'New game' })) startNewGame(); }
  else if (choice === 'seed') {
    const input = h('input', { type: 'number', value: state.seed, style: { width: '100%', padding: '8px', fontSize: '16px' } });
    const ok = await modal({ title: 'Game seed', body: h('div', {}, h('p.muted', { text: 'Same seed and settings = same deals.' }), input), buttons: [{ label: 'Cancel', value: false }, { label: 'Start', value: true, primary: true }] });
    if (ok && (!gameInProgress() || await confirm('Abandon the current game?', { ok: 'New game' }))) startNewGame(Number(input.value) >>> 0);
  }
  else if (choice === 'settings') openSettings();
  else if (choice === 'help') showHelp();
  else if (choice === 'log') openLog();
}

function openSettings() {
  const d = drawer({ title: 'Settings' });
  d.body.append(settingsPanel(SETTINGS_SCHEMA, settings, { onReset: () => { d.close(); openSettings(); } }));
  d.open();
}

settings.onChange((k) => {
  if (k === 'allowSameNumberSets' || k === 'goOutByHit' || k == null) state.opts = { ...state.opts, ...rulesOpts() };
  render();
  persist();
});

function openLog() {
  if (!logDrawer) logDrawer = drawer({ title: 'Game log' });
  clear(logDrawer.body);
  logDrawer.body.append(h('div.loglist', {}, state.log.map(l => h('div' + (l.startsWith('—') ? '.hand-mark' : ''), { text: l }))));
  logDrawer.open();
  requestAnimationFrame(() => { logDrawer.body.scrollTop = logDrawer.body.scrollHeight; });
}

function showHelp() {
  modal({
    title: 'How to play', wide: true,
    body: h('div.help', { style: { lineHeight: '1.5' } },
      h('p', {}, h('b', {}, 'Goal: '), 'complete phases 1–10 in order. A hand ends when someone has no cards left. Everyone who laid down their phase moves on; the rest repeat it. Cards left in hand count against you (1–9: 5, 10–12: 10, Skip: 15, Wild: 25). The game ends after a hand in which someone finished the final phase; lowest score among them wins.'),
      h('p', {}, h('b', {}, 'Turn: '), 'draw from the deck or take the top discard (not a Skip) → optionally lay down your whole phase at once → once laid down, hit any card that fits onto any group on the table → discard one card.'),
      h('p', {}, h('b', {}, 'Phase slots: '), 'the slots above your hand show what your phase needs, one dashed position per card. At any time, drag cards there from your hand (or select them and tap a slot); a card that doesn\'t belong in the group is refused. Runs arrange themselves by number — wilds fill the gaps lowest first and otherwise sit at the high end. Tap a wild in a run to pick it up, then tap any empty position (including beyond either end) to move it there, or tap your hand to take it back. Once a group is complete, an extra position opens at each end so you can add the cards you would otherwise hit afterwards. ', h('b', {}, 'Lay down'), ' plays the slots exactly as shown. Tap any other card in a slot to return it to your hand.'),
      h('p', {}, h('b', {}, 'Destinations: '), 'when a card is selected, everywhere it can go lights up: your slots, the groups on the table it can be hit onto, and the discard pile — tap one, or drag the card there. The deck and discard pile can be dragged into your hand to draw.'),
      h('p', {}, h('b', {}, 'Groups: '), 'set = same number, any colours · run = consecutive numbers, no wrap · colour = all one colour. Wilds stand in for anything; every group needs at least one real card. Discarding a Skip makes a player of your choice lose their next turn: select it and tap (or drag it onto) that player, or discard it and pick from the list.'),
      h('p', {}, h('b', {}, 'Hints: '), 'the line above your slots shows how many cards you are from completing your phase. Opponents each have a strategy badge: ', Object.values(STRATEGIES).map((s, i) => [i ? ', ' : '', h('b', { text: s.name })]), '. They all play well; the badges only change their priorities (points, defence, when to Skip whom).'),
    ),
  });
}

// ---------------------------------------------------------------- boot
window.__rounds = {
  get game() { return state; },
  get staged() { return staged; },
  get wildPos() { return wildPos; },
  get picked() { return picked; },
  get selected() { return [...selected]; },
  layouts, whyNot, perform,
  rules: R, ai: AI, G, settings, STRATEGIES,
  actions: {
    draw: (from = 'deck') => { const r = G.draw(state, from); if (r.ok) afterAction(); return r; },
    layDown: (ids) => { const r = G.layDown(state, ids); if (r.ok) { selected.clear(); staged = []; wildPos = []; picked = null; afterAction(); } return r; },
    layDownSlots,
    hit: (id, groupId, end) => { const r = G.hit(state, id, groupId, end); if (r.ok) { selected.clear(); afterAction(); } return r; },
    discard: (id, target = null) => { const r = G.discard(state, id, target); if (r.ok) { selected.clear(); afterAction(); } return r; },
    nextHand: () => { const r = G.nextHand(state); if (r.ok) afterAction(); return r; },
    select: (id) => toggleSelect(id),
    clearSelection,
    stage: (slot, ids, value = null) => stageCards(slot, ids, value),
    unstage: (ids) => unstage(ids),
    pick: (slot, id) => { picked = { slot, id }; refreshSelection(); },
    placeWild,
    newGame: (seed) => startNewGame(seed),
    showSummary, menu: showMenu,
  },
  render, persist,
};

if (!restore()) startNewGame();
else { render(); checkHandEnd(); scheduleAi(); maybePromptLayDown(); }
