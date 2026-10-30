# Design notes

Personal, mobile-first collection of four card and tile games. Not for distribution. The point is to be
able to tweak rules, opponent behaviour/UI and visuals easily, so:

* **No build step.** Plain HTML + CSS + ES modules. Edit a file, reload the page.
* **Pure logic modules, thin UI.** Every game splits into DOM-free modules (rules, AI, solver) that
  run under `node --test`, and a `main.js` that renders state and handles input. Logic modules never
  touch `document`/`window`.
* **Tweakables in two places.** Each game has a `config.js` exporting `DEFAULTS` (and other constants
  such as shape lists and strategy tables). The subset worth changing at runtime is exposed in a
  ⚙ settings drawer built with `shared/ui.js:settingsPanel()` and persisted with
  `shared/storage.js:makeSettings()`.
* **Mobile UX.** Portrait phone is the primary target (≈ 360–430 px wide), desktop must still work.
  Pointer events via `shared/pointer.js:onPress()` give tap + drag with one code path. Touch targets
  ≥ 40 px. No hover-only affordances. `touch-action: manipulation` kills double-tap zoom.
* **Deterministic randomness.** `shared/rng.js:makeRng(seed)`. Every game shows/accepts a seed so a
  deal/board can be replayed.
* **Persistence.** Game in progress + settings in `localStorage`, namespaced `"<game>.<thing>"`.
* **No music.** Sound effects optional and off by default (not implemented initially).

```
index.html            launcher
serve.js              zero-dependency static server (node serve.js), binds 0.0.0.0 for phone access
shared/  base.css     dark theme, .btn, .topbar, .modal, .drawer, .settings
         ui.js        h(), modal(), confirm(), toast(), settingsPanel(), drawer()
         pointer.js   onPress(el, {onTap,onDragStart,onDragMove,onDragEnd}), elementAt()
         rng.js       makeRng(seed) -> next/int/range/pick/shuffle, randomSeed(), hashString()
         storage.js   load/save/remove, makeSettings(key, defaults)
yukon/   rounds/   blocks/   xtiles/     one folder per game: index.html, <game>.css, config.js, main.js + logic modules
tests/   *.test.js   node --test tests/
```

Page skeleton used by every game:

```html
<div class="app">
  <div class="topbar"><div class="title">Name</div> …stats… …buttons… <button class="btn btn-icon" id="btn-menu">⋯</button></div>
  <div class="main"> …game… </div>
</div>
```

There is no back button: the ⋯ menu has an **Exit** item (back to the launcher) in every game. Games with a
player strip (Rounds, xTiles) have no top bar at all; the ⋯ button and the one stat sit at the right end
of the strip instead.

---

## 1. Yukon solitaire (`yukon/`)

### Rules
52 cards, 7 tableau columns. Column *i* (0-based) has *i* face-down cards topped by 5 face-up cards,
except column 0 which has a single face-up card (1 + 6+7+8+9+10+11 = 52). No stock. Four foundations
build A→K by suit. Any face-up card **and everything on top of it, regardless of order**, may be moved
onto a card of opposite colour and one rank higher. Only a King (plus what's on it) may fill an empty
column (configurable). When a column's face-up cards are all removed, the exposed face-down card flips.
Won when all four foundations reach K.

### Data model (`game.js`, pure)
```
card: int 0..51   rank = c % 13 (0=A … 12=K), suit = c / 13 | 0 (0♠ 1♥ 2♦ 3♣), red = suit 1|2
state: { cols: int[7][] (bottom→top), down: int[7] (face-down count at bottom of each col), found: int[4] (top rank per suit, -1 empty) }
move:  { from: col, idx: index in col, to: col | 'F' }
deal(seed) · legalMoves(state, rules) · applyMove(state, move) · isWon · stateKey (canonical: columns sorted so column order doesn't matter) · moveLabel(state, move) e.g. "7♥ → 8♠", "K♣ → empty", "A♠ → ♠ foundation"
safeFoundationMoves(state): top cards whose two opposite-colour rank−1 cards are already on foundations (never wrong to play)
```
Trivial moves are filtered out: moving a stack whose bottom card is a King from a column with nothing
under it into another empty column; moving to the 2nd/3rd empty column (only the first empty is offered).

### Game tree (`tree.js`, pure)
The history **is** a tree. Node = `{id, parent, move, children[], status, solver?}`; root is the deal.
States are not stored; they're rebuilt by replaying moves from the seed (52 cards, cheap).
* Playing a move adds a child (or re-uses an existing identical child) and makes it current.
* Undo = current → parent (child kept). Redo = current → last-visited child.
* **Branch point** = node whose state has ≥ 2 legal non-trivial moves. "Back to branch" jumps to the
  nearest ancestor branch point. Moves are also grouped by destination so the UI can show "contested"
  destinations (e.g. 7♥ *or* 7♦ onto 8♠) distinctly.
* Status: `open` (unexplored), `won`, `dead` (no moves, not won), plus solver verdicts
  `win` / `lose` / `unknown` (budget exhausted) cached on the node.
* Persisted as `{seed, nodes[], currentId}` in `localStorage["yukon.save"]`.

### Solver (`solver.js`, pure; run in `solver-worker.js`)
Iterative DFS with a transposition table on `stateKey`, node budget + time limit. Move ordering:
safe foundation moves are forced (taken alone), then moves that flip a face-down card, empty a column,
or lengthen a proper sequence; moves that break a sequence last. Returns
`{result: 'win'|'lose'|'unknown', path: move[], explored}`. UI actions: *Solve from here* (adds the
winning line to the tree as solver-found nodes) and *Analyse choices* (solve each child of the current
node and label the alternatives ✓/✗/?).

### UI (`main.js`)
Foundations row on top, 7 columns below; cards are absolutely-positioned divs inside a scrolling
layer. Card width is the smaller of the width limit ((W − 8·gap)/7) and the height limit that lets
the foundation row plus a column of `fitCards` face-up cards (default 11: the biggest starting stack
as if fully face-up) fit without scrolling; h = 1.4·w, times `cardScale`. Card offsets are never
squeezed: the face-up offset is at least `MIN_OVERLAP_UP` (0.27·h) so the rank + suit corner of every
stacked card stays visible, and a column taller than the board makes the board scroll (drag on the
felt or a face-down card, or use the wheel; dragging a card near the top/bottom edge auto-scrolls).
Input: drag a stack to a column/foundation, or tap to select then tap destination; tapping a
selectable top card when nothing is selected and it can go to the foundation sends it there.
Tree drawer: indented list, current path highlighted, unexplored alternatives shown as dimmed
"ghost" rows (tap to play them). Settings: card scale, overlap, felt/back colours, hints,
auto-play safe foundation moves, solver budget, Kings-only to empty column.

---

## 2. Rounds (`rounds/`)

### Rules
108 cards: 1–12 ×2 in red/blue/green/yellow (96) + 8 Wild + 4 Skip. 10 cards each. Turn: draw
(deck or discard top; Skips can't be taken from the discard) → optionally lay down the whole current
phase → if laid down (this hand), hit cards onto any laid-down groups on the table → discard.
Discarding a Skip makes a chosen player lose their next turn. Hand ends when someone has no cards
(by discard or by hitting the last card, configurable). Players who laid down advance a phase;
scoring is cards left in hand: 1–9 = 5, 10–12 = 10, Skip = 15, Wild = 25. Game ends when a player
finishes the final phase at the end of a hand; lowest score among them wins.

Phases: 1) 2 sets of 3 · 2) set of 3 + run of 4 · 3) set of 4 + run of 4 · 4) run of 7 · 5) run of 8
· 6) run of 9 · 7) 2 sets of 4 · 8) 7 cards of one colour · 9) set of 5 + set of 2 · 10) set of 5 + set of 3.
Set = same number any colours. Run = consecutive numbers, no wrap, any colours. Wilds fill anything.
Two sets in one phase may share a number (configurable `allowSameNumberSets`, default true).
Hits: set gets same number, run extends either end (1–12), colour group gets same colour; wilds anywhere valid.

### Data model (`rules.js`, pure)
```
card: {id, kind:'num'|'wild'|'skip', num?, color?}   PHASES[]: [{comps:[{type:'set'|'run'|'color', n}]}]
hand fit: canComplete(hand, phase) -> arrangement | null ; deficit(hand, phase) -> min cards still needed
          implemented by enumerating component "shapes" (set number / run start / colour) and running a
          small bipartite matching of cards→slots (wilds match any slot).
game: {players:[{name, ai?, hand, phase (1-10), laidDown:bool, score}], table:[{owner, comp, cards}], deck, discard, turn, phaseOfTurn:'draw'|'play'|'done', skipped:Set}
```

### AI (`ai.js`, pure)
Always plays strongly; **strategy profiles** change priorities, not competence. Each profile is a set
of weights over: deficit reduction, points held, defensive discarding (don't feed the next player
numbers they've picked up), when to use Skips (hold until an opponent has ≤ N cards vs. use at once),
whom to Skip (leader / next player / player closest to going out), wild-hoarding for hits.
Flow: draw (take discard if it lowers deficit or enables a hit) → lay down if complete → hit all
possible (unless that would leave nothing to discard and going out by hit is disabled) → discard the
card whose removal keeps deficit minimal, then by points, then defensively.

### UI
Every player has a panel with one **phase slot per component** of their current phase (labelled
"Set of 3", "Run of 4", …). Opponent panels (name, strategy badge, phase, score, a fan of face-down
cards for the hand size) sit in a strip at the top with the ⋯ menu button and hand number at its end;
their slots fill with the laid-down groups, which are the hit targets. Your panel (phase pill, deficit
hint, your slots) sits above your hand. Before laying down, your slots are a **staging area**: drag cards
there from the hand (or select and tap a slot) at any time, including during other players' turns, to keep
them apart from the rest of the hand; tap/drag a card back to return it. A slot turns green when its cards
form a valid group; when the slots hold a complete phase during your play stage you are asked whether to
lay down (`promptLayDown` setting, once per arrangement). *Lay down* plays the slots plus any selected hand
cards; laid-down groups then show in the slots. Staging lives in `localStorage["rounds.ui"]` keyed by
seed + hand, not in the game state.

Layout is one CSS grid with two arrangements (`rounds.css`): portrait = strip / deck + discard + log /
your slots / hand / action bar; landscape (`orientation: landscape` and ≥ 640 px) = strip across the top,
slots + hand on the left, deck/discard/log and the action buttons in a right column. `fitCards()` sets
`--cw` so the slot row and hand row both fit the remaining height (capped by the card-size setting).
Cards inside a slot spread out when there is room and overlap when there isn't (container-query units,
`--n` = card count). Buttons: Draw / Take discard, Lay down, Hit (selected card → tapped group), Discard.
Skip target chooser modal. Hand-end summary with scores/phase progress. Settings: opponent count (1–5),
strategy per seat (or random), AI delay, card size, hand sort, lay-down prompt, rule toggles, show
opponents' hands (cheat/debug).

---

## 3. Blocks (`blocks/`)

Turn-based block fitting (no gravity, no timer). Grid default 10×10. Each turn the tray offers 3 blocks
in random rotations; all 3 must be placed (or stashed) before the next 3 arrive. One **side slot**
holds a block; drop a tray block there to stash (swap allowed if occupied, configurable); the side
block can be placed on any turn. Rows and columns full after a placement are cleared simultaneously.

Scoring (all in `config.js`): place = cells in block; clear = `cellsCleared × linesCleared × clearMultiplier`
(so clearing more at once is worth disproportionately more). **Rotation points**: `+rotationPointsPerLine`
per line cleared; placing a block in a rotation other than the one it was dealt costs `rotationCost`
points (previewing rotations in the tray is free; cost is charged on placement; rotating back to the
dealt orientation costs nothing). Shapes: the 7 tetrominoes (I O T S Z J L) as a list of cell matrices
in `config.js` so more can be added.

**Game over** = the current turn can no longer be finished (`canFinishTurn` in `game.js`). The turn ends
when the tray is empty, and the side slot can absorb at most one leftover block (stash into an empty
slot, swap, or place the side block first and then stash), so the turn is finishable iff all but at
most one of the tray + side blocks can be placed in *some* order. That is decided by an exact
depth-first search over placements with a transposition set, counting the lines each placement clears
and the rotation points they earn (a clear mid-turn can make room or pay for a rotation). It is checked
after every action, so a position is flagged as soon as it is hopeless rather than after the player
places the last block that fits; the modal says which case applies and shows the final score and a
restart. `MAX_SEARCH_NODES` caps the search (60k placements; beyond it the position is assumed
playable). `anyMoves` remains as the cheap necessary condition.

**Greyed blocks**: a tray/side block that fits nowhere in any affordable rotation (`blockHasMove`
false) is drawn greyed; one that fits only after an affordable rotation (`blockFitsNow` false) is
dimmed with a ⟳ badge. Greyed blocks can still be stashed.

**Carry-over**: `newGame(seed, cfg, carryRotationPoints)` starts with `startRotationPoints + carry`;
the UI passes the previous game's unspent points when the `carryRotationPoints` setting is on
(default), whether the previous game ended or was abandoned.

Logic (`game.js`, pure): `newGame(seed, cfg, carry)`, `canPlace(board, shape, x, y)`, `commit(board, shape, x, y, type)`,
`place(state, source, x, y) -> {state, cleared, points}`, `rotate(shape)`, `canFinishTurn(state)`, `isGameOver(state)`,
`blockHasMove / blockFitsNow`, `dealTray(state)`. UI: board as CSS grid; drag from tray with a ghost
preview (block drawn above the finger with the grab-cell offset so it's visible), tap-to-select then
tap-cell as fallback; rotate button on the selected block showing the cost. High score in localStorage.

---

## 4. xTiles (`xtiles/`)

108 tiles: 6 shapes × 6 colours × 3. Hand of 6. A move places ≥ 1 tiles in one line sharing one attribute,
contiguous with existing tiles; every line (≥ 2) touched must be all-same-colour-different-shapes or
all-same-shape-different-colours, max 6. Score = sum of lengths of every line (≥ 2) containing a placed
tile; a 6-line scores 12 (xTiles). First move: any valid line, scores its length. Alternative turn:
exchange any tiles with the bag. Game ends when the bag is empty and someone empties their hand
(+6 bonus), or when nobody can move.

**Bonus cells** (added option): the board has deterministic bonus cells from the seed
(`bonusAt(seed, x, y)` hashing; density, kinds and weights in `config.js:BONUS`: `+n` with n drawn per cell from
4–12, `×2`, `×3`). A bonus is awarded when the cell is filled: `+n` adds to the move, `×n` multiplies the lines
containing that tile (`bonusMode: 'line'`) or the whole move (`'move'`). Centre area (first move) is bonus-free.
The `bonusTypes` setting limits them to `+n` only / `×n` only / none, in every mode. In the round modes the layout
is re-rolled per round (seed hashed with the round number).

**Game modes** (`config.js:MODES`, `cfg.mode`). *Classic* is the game above. The other three follow the Android game
"6 tiles in a row" and share these rules: every round starts with one random tile on the centre cell; the first
player of round 1 is random (seeded), then the opener rotates each round; tiles played in a turn form a **chain**
(the placed set must be 4-connected and touch the board — any shape, not just a line — so a 2×2 block scores four
lines of two); round points add into a game total and the highest total after the last round wins (`rounds`
setting, 1–10). Scoring per line is unchanged.

| mode | board | tiles | round ends | notes |
|---|---|---|---|---|
| `turns` | `boardSize`×`boardSize` (0 = unlimited) | endless pool (uniform random, drawn deterministically from `seed:pool:<draws>`) | every player has taken `turnsPerRound` turns, or everyone passed | a hand with no play is replaced at the start of the turn, up to `MAX_REDRAWS` times, then passing is allowed; swapping costs a turn |
| `goal` | unlimited | endless pool | the mover's round points reach `pointsGoal` (or everyone passed / stall limit) | same redraw rule |
| `bag` | `boardSize`×`boardSize` | a fresh shuffled bag of 108 per round | bag empty and everyone passed in turn | no swapping; a player with no play draws one extra tile at the start of the turn (hand can hold 7) and may then play or pass |

State additions: `cfg {mode, rounds, turnsPerRound, boardSize, pointsGoal, bonusTypes}`, `round`, `firstPlayer`,
`draws`, `drew`, `turnEvent` (`{type:'redraw', n}` / `{type:'draw'}`, set by `prepareTurn` for the UI toast),
`roundOver` + `summary` (the UI shows the round table and calls `nextRound(state)`), per player `roundScore` and
`turns`. `G.rulesOpts(state)` → `{chain, bounds}` is passed to `rules.js:validate / legalPlacements / hasAnyPlay`;
`R.squareBounds(n)` gives the limits of a bounded board. Old classic saves load via `fromJSON` defaults.

Logic (`rules.js`, pure): board as `Map("x,y" -> tile)`, `legalPlacements(board, hand, {chain, bounds, prune})`,
`scoreMove(board, placements, bonusFn)`, `validate(board, placements, {chain, bounds})`, `isConnected(cells)`.
AI (`ai.js`, pure): enumerates all placements. Line mode: anchor empty cell adjacent to tiles → extend along an
axis in both directions, skipping over existing tiles, pruning by the shared-attribute rule, dedupe. Chain mode:
breadth-first by tile count, growing each partial play into any empty cell next to one of its tiles; the full space
is huge for coherent hands, so `enumeratePlays` keeps only the `AI.beam` best-scoring partials per depth (beam 0 =
exhaustive, used by tests).
Strategies: *Greedy* (max score), *Blocker* (score − penalty for leaving open 4/5-lines others can score an
xTiles on), *Builder* (score + hand-synergy value of kept tiles), *Opportunist* (greedy but exchanges
aggressively when the best move is low). **Difficulty slider**: with probability `p` the AI picks a move
within `slack` points of the best, or from the top-k, instead of the best. Swapping follows `G.poolSize` (∞ in the
endless-pool modes, never in Bag mode).

UI: scrollable/pannable board with auto-expanding bounds (2-cell margin) or the fixed outlined square of a
bounded mode, zoom buttons, bonus cells drawn under tiles; tap a hand tile → tap a cell to place tentatively
(hints show where the selected tile can join the tentative tiles, which in chain modes means next to them); *Play*
commits (validates and scores), *Take back*, *Swap* mode (hidden in Bag mode), *Pass* when allowed. Opponent strip
with name/strategy/total score/round score (tile count in Classic and Bag) and last-move highlight; the stat
corner shows the bag, or round + turn/goal. Round end: modal with the round table and *Next round* (also on the
Play button). Settings: mode, rounds, turns per round, board size, points goal, opponent count/strategies,
difficulty, bonus types/density/mode, tile size.
