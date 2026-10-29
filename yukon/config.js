// Yukon tweakables. Runtime-adjustable ones are also exposed in the ⚙ drawer (see SETTINGS_SCHEMA in main.js).
export const DEFAULTS = {
  // rules
  kingsOnlyToEmpty: true,      // false = any card/stack may fill an empty column
  autoSafeFoundation: true,    // automatically play foundation moves that can never hurt
  // visuals
  fitCards: 11,                // cards are sized so a column of this many face-up cards fits without scrolling (11 = the biggest starting stack, fully face-up)
  cardScale: 1.0,              // 0.5–1.0, extra shrink on top of the fitted size
  overlapUp: 0.32,             // face-up card vertical offset as a fraction of card height (never squeezed; ≥ MIN_OVERLAP_UP keeps the corner readable)
  overlapDown: 0.14,           // face-down offset
  feltColor: '#1f6b3a',
  backColor: '#2b4c9b',
  showHints: true,             // outline legal destinations when a stack is selected
  tapToFoundation: true,       // tapping an unselected top card that can go up sends it to the foundation
  animMs: 180,
  // solver
  solverAlgorithm: 'auto',     // 'auto' | 'best' | 'dfs'
  solverMaxNodes: 400000,
  solverTimeMs: 15000,
  solverWorkers: 2,
};

/** Smallest face-up offset (fraction of card height) that still shows the rank + suit corner. */
export const MIN_OVERLAP_UP = 0.27;

export const SUITS = ['♠', '♥', '♦', '♣'];
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
