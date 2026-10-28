// Yukon tweakables. Runtime-adjustable ones are also exposed in the ⚙ drawer (see SETTINGS_SCHEMA in main.js).
export const DEFAULTS = {
  // rules
  kingsOnlyToEmpty: true,      // false = any card/stack may fill an empty column
  autoSafeFoundation: true,    // automatically play foundation moves that can never hurt
  // visuals
  cardScale: 1.0,              // 0.7–1.0, fraction of the width-limited card size
  overlapUp: 0.32,             // face-up card vertical offset as a fraction of card height
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

export const SUITS = ['♠', '♥', '♦', '♣'];
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
