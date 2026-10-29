// Rounds UI controller. Rendering + input only; rules live in rules.js, state changes in game.js, opponents in ai.js.
import { h, $, clear, modal, confirm, toast, settingsPanel, drawer } from '../shared/ui.js';
import { onPress } from '../shared/pointer.js';
import { makeSettings, load, save } from '../shared/storage.js';
import { makeRng, randomSeed } from '../shared/rng.js';
import { DEFAULTS, STRATEGIES, AI_NAMES, COLORS } from './config.js';
import * as R from './rules.js';
import * as G from './game.js';
import * as AI from './ai.js';

const SAVE_KEY = 'rounds.save';
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
  { key: 'cardScale', label: 'Card size', type: 'range', min: 0.7, max: 1.3, step: 0.05 },
  { key: 'sortHand', label: 'Sort hand by', type: 'select', options: [{ value: 'number', label: 'Number' }, { value: 'color', label: 'Colour' }, { value: 'none', label: 'Draw order' }] },
  { key: 'allowSameNumberSets', label: 'Two sets may share a number', type: 'bool', help: 'e.g. phase 1 with 5-5-5 and 5-5-5' },
  { key: 'goOutByHit', label: 'Go out by hitting the last card', type: 'bool', help: 'Off: a hand only ends with a discard' },
  { key: 'showOpponentHands', label: 'Show opponent hands', type: 'bool', help: 'Cheat / debug' },
];

// ---------------------------------------------------------------- state
let state = null;
const selected = new Set();       // card ids in the player's hand
let aiRun = 0;                    // token: bumped to cancel a running AI turn (new game / restore)
let aiBusy = false;
let endShownFor = null;           // "hand:stage" key of the summary modal already shown
let logDrawer = null;
const HUMAN = 0;

const oppsEl = $('#opps'), deckEl = $('#deck'), discardEl = $('#discard'), logEl = $('#log'), tableEl = $('#table');
const phaseEl = $('#phase'), hintEl = $('#hint'), handEl = $('#hand'), actionsEl = $('#actions'), statEl = $('#stat');
const main = $('.p10');

// ---------------------------------------------------------------- persistence
function persist() { save(SAVE_KEY, state); }
function restore() {
  const s = load(SAVE_KEY);
  if (!G.isValidState(s)) return false;
  state = s;
  return true;
}

// ---------------------------------------------------------------- helpers
const isHumanTurn = () => state.turn === HUMAN && (state.stage === 'draw' || state.stage === 'play');
const me = () => state.players[HUMAN];
const nameOf = (i) => state.players[i].name;
const profile = (p) => STRATEGIES[p.ai] || null;

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

function groupKindLabel(g) {
  if (g.type === 'set') return `set of ${g.key}s`;
  if (g.type === 'run') return `run ${g.lo}–${g.hi}`;
  return `${g.key}s`;
}

/** Table group element; wilds in runs show the number they stand for. */
function groupEl(g, { target = false } = {}) {
  const cardsRow = h('div.cards', {}, g.cards.map((id, i) => {
    const el = cardEl(R.card(id), '.small');
    if (g.type === 'run' && R.isWild(R.card(id))) el.append(h('span.as', { text: String(R.runValueAt(g, i)) }));
    return el;
  }));
  return h('div.group' + (g.owner === HUMAN ? '.mine' : '') + (target ? '.target' : ''), { data: { group: g.id } },
    h('div.owner', {}, h('span', { text: nameOf(g.owner) }), h('span.kind', { text: groupKindLabel(g) })),
    cardsRow);
}

const selectedCard = () => (selected.size === 1 ? R.card([...selected][0]) : null);

// ---------------------------------------------------------------- rendering
function render() {
  main.style.setProperty('--scale', settings.get('cardScale'));
  statEl.textContent = `Hand ${state.hand}`;
  renderOpponents();
  renderPiles();
  renderTable();
  renderMe();
  renderActions();
}

function renderOpponents() {
  clear(oppsEl);
  state.players.forEach((p, i) => {
    if (i === HUMAN) return;
    const prof = profile(p);
    const active = state.turn === i && (state.stage === 'draw' || state.stage === 'play');
    const groups = state.table.filter(g => g.owner === i);
    const el = h('div.opp' + (active ? '.active' : '') + (p.skipped ? '.skipped' : '') + (p.laidDown ? '.done' : ''), { data: { player: i } },
      h('div.opp-head', {},
        h('span.name', { text: p.name }),
        prof ? h('span.badge', { text: prof.name, title: prof.name, style: { '--badge': prof.color } }) : null,
        p.skipped ? h('span.skipmark', { text: 'SKIPPED' }) : null),
      h('div.opp-meta', {},
        h('span', { html: p.phase > 10 ? '<b>Done</b>' : `Phase <b>${p.phase}</b>` }),
        h('span', { html: `<b>${p.hand.length}</b> card${p.hand.length === 1 ? '' : 's'}` }),
        h('span', { html: `<b>${p.score}</b> pts` })),
      h('div.opp-groups', {}, groups.length
        ? groups.map(g => h('div.mini', {}, g.cards.map(id => cardEl(R.card(id), '.small'))))
        : h('span.muted', { style: { fontSize: '11px' }, text: p.laidDown ? 'laid down' : 'not laid down' })),
      settings.get('showOpponentHands') ? h('div.opp-hand', {}, sortedHand(p.hand).map(id => cardEl(R.card(id), '.small'))) : null,
    );
    oppsEl.append(el);
  });
  const act = oppsEl.querySelector('.opp.active');
  if (act) act.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

function renderPiles() {
  const drawing = isHumanTurn() && state.stage === 'draw';
  clear(deckEl);
  deckEl.classList.toggle('ready', drawing);
  deckEl.classList.toggle('empty', !state.deck.length);
  deckEl.disabled = !drawing;
  if (state.deck.length) deckEl.append(h('div.card.back'), h('span.count', { text: String(state.deck.length) }));
  deckEl.append(h('span.label', { text: 'Deck' }));

  clear(discardEl);
  const top = G.discardTop(state);
  const takeable = drawing && top && !R.isSkip(top);
  discardEl.classList.toggle('ready', !!takeable);
  discardEl.classList.toggle('empty', !top);
  discardEl.disabled = !takeable;
  if (top) discardEl.append(cardEl(top));
  discardEl.append(h('span.label', { text: 'Discard' }));

  clear(logEl);
  const lines = state.log.slice(-2);
  lines.forEach((l, i) => logEl.append(h('div' + (i === lines.length - 1 ? '.latest' : ''), { text: l })));
}

function renderTable() {
  clear(tableEl);
  const sel = selectedCard();
  const canTarget = isHumanTurn() && state.stage === 'play' && me().laidDown && sel;
  for (const g of state.table) tableEl.append(groupEl(g, { target: !!canTarget && R.canHit(g, sel) }));
}

function renderMe() {
  const p = me();
  phaseEl.textContent = R.phaseLabel(p.phase);
  hintEl.className = 'hint';
  if (state.stage === 'handEnd' || state.stage === 'gameEnd') hintEl.textContent = state.stage === 'gameEnd' ? 'Game over' : 'Hand over';
  else if (p.phase > 10) hintEl.textContent = '';
  else if (p.laidDown) { hintEl.textContent = 'Laid down ✓'; hintEl.classList.add('ok'); }
  else {
    const d = G.deficitOf(state, HUMAN);
    if (d.need === 0) { hintEl.textContent = 'Complete — lay it down!'; hintEl.classList.add('ok'); }
    else hintEl.textContent = `${d.need} card${d.need === 1 ? '' : 's'} away`;
  }
  clear(handEl);
  for (const id of [...selected]) if (!p.hand.includes(id)) selected.delete(id);   // drop stale selections
  const ids = sortedHand(p.hand);
  if (!ids.length) handEl.append(h('div.empty', { text: 'No cards' }));
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
  if (!p.laidDown && p.phase <= 10) actionsEl.append(h('button.btn#btn-lay', { text: 'Lay down', disabled: n === 0, onClick: doLayDown }));
  if (p.laidDown) actionsEl.append(h('button.btn#btn-hit', { text: 'Hit', disabled: n !== 1, onClick: doHitPrompt }));
  actionsEl.append(h('button.btn.btn-primary#btn-discard', { text: 'Discard', disabled: n !== 1, onClick: doDiscard }));
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
  endShownFor = null;
  state = G.newGame({ seed, players, opts: rulesOpts() });
  afterAction();
}

/** Common tail of every state change. */
function afterAction() {
  render();
  persist();
  checkHandEnd();
  scheduleAi();
}

function gameInProgress() {
  return state.stage !== 'gameEnd' && (state.hand > 1 || state.table.length > 0 || state.players.some(p => p.hand.length !== 10) || state.stage === 'play');
}

// ---------------------------------------------------------------- human actions
function doDraw(from) {
  if (!isHumanTurn()) return;
  const before = me().hand.length;
  const r = G.draw(state, from);
  if (!r.ok) { toast(r.reason); return; }
  afterAction();
  if (me().hand.length > before) {
    const newId = me().hand[me().hand.length - 1];
    handEl.querySelector(`.card[data-id="${newId}"]`)?.classList.add('new');
  }
}

function doLayDown() {
  if (!isHumanTurn()) return;
  const ids = [...selected];
  if (!ids.length) { toast('Select the cards of your phase first'); return; }
  const r = G.layDown(state, ids);
  if (!r.ok) { toast(r.reason, 2600); return; }
  selected.clear();
  afterAction();
  if (state.stage === 'play') toast('Laid down! Hit cards onto any group, then discard.');
}

function doHitPrompt() {
  const c = selectedCard();
  if (!c) { toast('Select exactly one card to hit with'); return; }
  const targets = state.table.filter(g => R.canHit(g, c));
  if (!targets.length) { toast(`${R.cardName(c)} doesn't fit on any group`); return; }
  if (targets.length === 1) { doHit(targets[0].id); return; }
  toast('Tap the highlighted group to hit');
}

async function doHit(groupId) {
  if (!isHumanTurn() || state.stage !== 'play') return;
  const c = selectedCard();
  if (!c) { toast('Select one card, then tap a group to hit'); return; }
  if (!me().laidDown) { toast('Lay down your phase before hitting'); return; }
  const g = G.groupById(state, groupId);
  const options = R.hitOptions(g, c);
  if (!options.length) { toast(`${R.cardName(c)} doesn't fit on that group`); return; }
  let end = options[0];
  if (options.length > 1) {
    end = await modal({
      title: 'Which end of the run?',
      body: `Play the Wild as a ${g.lo - 1} (low end) or as a ${g.hi + 1} (high end)?`,
      buttons: [{ label: `Low (${g.lo - 1})`, value: 'low' }, { label: `High (${g.hi + 1})`, value: 'high', primary: true }],
    });
    if (!end) return;
  }
  const r = G.hit(state, c.id, groupId, end);
  if (!r.ok) { toast(r.reason); return; }
  selected.clear();
  afterAction();
}

async function doDiscard() {
  if (!isHumanTurn() || state.stage !== 'play') return;
  const c = selectedCard();
  if (!c) { toast('Select exactly one card to discard'); return; }
  let target = null;
  if (R.isSkip(c)) {
    const eligible = G.eligibleSkipTargets(state);
    if (eligible.length === 1) target = eligible[0];
    else if (eligible.length > 1) {
      target = await chooseSkipTarget(eligible);
      if (target == null) return;
    }
  }
  const r = G.discard(state, c.id, target);
  if (!r.ok) { toast(r.reason); return; }
  selected.clear();
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

function toggleSelect(id) {
  if (!isHumanTurn()) return;
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  renderMe();
  renderTable();
  renderActions();
}

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
  if (v && state.stage === 'handEnd') { G.nextHand(state); selected.clear(); afterAction(); }
}

// ---------------------------------------------------------------- input wiring
onPress(handEl, {
  onTap(i) { const el = i.downTarget?.closest?.('.card'); if (el && el.dataset.id != null) toggleSelect(Number(el.dataset.id)); },
});
onPress(tableEl, {
  onTap(i) {
    const el = i.downTarget?.closest?.('.group');
    if (!el) return;
    if (!isHumanTurn() || state.stage !== 'play') return;
    if (!me().laidDown) { toast('Lay down your phase first, then you can hit'); return; }
    if (selected.size !== 1) { toast('Select exactly one card to hit with'); return; }
    doHit(Number(el.dataset.group));
  },
});
deckEl.addEventListener('click', () => doDraw('deck'));
discardEl.addEventListener('click', () => doDraw('discard'));
logEl.addEventListener('click', openLog);
$('#btn-menu').addEventListener('click', showMenu);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { selected.clear(); render(); } });

// ---------------------------------------------------------------- menu, settings, help, log
async function showMenu() {
  const choice = await modal({
    title: 'Rounds',
    body: h('div.muted', { text: `Seed ${state.seed} · hand ${state.hand} · ${state.players.length} players` }),
    buttons: [
      { label: 'Settings', value: 'settings' },
      { label: 'Help', value: 'help' },
      { label: 'Log', value: 'log' },
      { label: 'New (seed…)', value: 'seed' },
      { label: 'New game', value: 'new', primary: true },
    ],
  });
  if (choice === 'new') { if (!gameInProgress() || await confirm('Abandon the current game and start a new one?', { ok: 'New game' })) startNewGame(); }
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
      h('p', {}, h('b', {}, 'Turn: '), 'draw from the deck or take the top discard (not a Skip) → optionally lay down your whole phase at once (select the cards, tap Lay down) → once laid down, hit any card that fits onto any group on the table (select one card, tap the group) → discard one card.'),
      h('p', {}, h('b', {}, 'Groups: '), 'set = same number, any colours · run = consecutive numbers, no wrap · colour = all one colour. Wilds stand in for anything; every group needs at least one real card. Discarding a Skip makes a player of your choice lose their next turn.'),
      h('p', {}, h('b', {}, 'Hints: '), 'the line above your hand shows how many cards you are from completing your phase. Opponents each have a strategy badge: ', Object.values(STRATEGIES).map((s, i) => [i ? ', ' : '', h('b', { text: s.name })]), '. They all play well; the badges only change their priorities (points, defence, when to Skip whom).'),
    ),
  });
}

// ---------------------------------------------------------------- boot
window.__rounds = {
  get game() { return state; },
  rules: R, ai: AI, G, settings, STRATEGIES,
  actions: {
    draw: (from = 'deck') => { const r = G.draw(state, from); if (r.ok) afterAction(); return r; },
    layDown: (ids) => { const r = G.layDown(state, ids); if (r.ok) { selected.clear(); afterAction(); } return r; },
    hit: (id, groupId, end) => { const r = G.hit(state, id, groupId, end); if (r.ok) { selected.clear(); afterAction(); } return r; },
    discard: (id, target = null) => { const r = G.discard(state, id, target); if (r.ok) { selected.clear(); afterAction(); } return r; },
    nextHand: () => { const r = G.nextHand(state); if (r.ok) afterAction(); return r; },
    select: (id) => toggleSelect(id),
    newGame: (seed) => startNewGame(seed),
    showSummary,
  },
  render, persist,
};

if (!restore()) startNewGame();
else { render(); checkHandEnd(); scheduleAi(); }
