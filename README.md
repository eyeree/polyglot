# Games

Personal, mobile-first card and tile games, built to be tweaked. Plain HTML/CSS/ES modules,
no build step, no dependencies.

| Game | Folder | What's special |
|---|---|---|
| Yukon solitaire | `yukon/` | Every move is a node in a game tree; jump back to any choice, see untried alternatives, and run a solver to learn which choices keep the deal winnable |
| Rounds | `rounds/` | 1–5 AI opponents that always play well but with different strategy profiles |
| Blocks | `blocks/` | Turn-based block fitting with a side slot and rotation points earned by clearing lines |
| Abstrackle | `abstrackle/` | Bonus cells (+1, +2, ×2, ×3), several AI strategies, a difficulty slider |

## Run

```bash
node serve.js            # http://localhost:7659/  (also prints a LAN URL for your phone)
node --test tests/*.test.js   # logic tests
```

Any static server works (`python3 -m http.server`), but ES modules need http://, not file://.
On the phone, open the LAN URL and "Add to Home Screen" for a full-screen app.

## Tweaking

* Each game has a ⚙ **Settings** drawer (via the ⋯ menu) for the common knobs, persisted in localStorage.
* `<game>/config.js` holds `DEFAULTS` plus the tables that define the game (shape lists, strategy
  profiles, phase definitions, bonus weights…). Edit and reload.
* Rules/AI live in pure modules (`game.js`, `rules.js`, `ai.js`, `solver.js`) with tests in `tests/`.
  UI is in `main.js` + the game's CSS. See `docs/DESIGN.md` for the structure and the rules each game uses.
* Shared bits (dark theme, buttons, modal/drawer/toast, settings panel, seeded RNG, pointer tap/drag) are in `shared/`.

## Yukon notes

* **Tree** (bottom bar): rows are moves; ● is where you are, dimmed "+" rows are moves you haven't tried
  from that position (tap to play them), ⚖ marks a destination that several cards could go to.
  Forced moves (safe foundation plays) are collapsed.
* **⤺ Branch** jumps back to the last position where you had a real choice.
* **Solve** searches from the current position in a web worker. ✓ adds a winning line to the tree,
  ✗ means exhausted (unwinnable from here), ? means the budget ran out (raise it in Settings).
  A row's ⋯ menu offers *Analyse choices*, which solves each alternative so you can see which keep the game winnable.
* Deals are seeded; the menu shows the seed and lets you replay one.
