// Qwirkle tweakables. Runtime-adjustable ones are also exposed in the ⚙ drawer (see SETTINGS_SCHEMA in main.js).
export const DEFAULTS = {
  // opponents (applied to new games)
  opponents: 2,                // 1–3 AI players
  strategy1: 'random',         // 'random' or a key of STRATEGIES
  strategy2: 'random',
  strategy3: 'random',
  difficulty: 85,              // 0–100: how often the AI picks its best move
  // bonus cells (applied to new games)
  bonusDensity: 0.08,          // fraction of cells that carry a bonus
  bonusMode: 'line',           // 'line': ×n multiplies the lines through that tile · 'move': ×n multiplies the whole move
  // visuals / pacing
  tileSize: 44,                // board cell size in px
  aiDelayMs: 600,              // pause before each AI move
  showHints: true,             // highlight the cells a selected tile can legally go
  showAiHands: false,          // debug: reveal opponents' tiles
  playerName: 'You',
};

export const SHAPES = ['circle', 'cross', 'diamond', 'square', 'star', 'clover'];
export const COLORS = [
  { id: 'red', hex: '#ef4a4a' },
  { id: 'orange', hex: '#ff8a1f' },
  { id: 'yellow', hex: '#ffd21f' },
  { id: 'green', hex: '#3ccf5a' },
  { id: 'blue', hex: '#3d8bff' },
  { id: 'purple', hex: '#b55cf0' },
];
export const COPIES = 3;             // of each shape/colour tile → 108 tiles
export const HAND_SIZE = 6;
export const QWIRKLE_SCORE = 12;     // a completed line of 6
export const END_BONUS = 6;          // for emptying your hand once the bag is empty
export const STALL_LIMIT = 30;       // safety: consecutive turns without a play before the game is called

// Bonus cells: deterministic from the seed (see rules.js:bonusAt). `weight`s are relative.
export const BONUS = {
  safeRadius: 1,               // cells within this Manhattan distance of the origin are never bonus
  kinds: [
    { id: 'add1', type: 'add', n: 1, weight: 40, label: '+1', color: '#4f8cff' },
    { id: 'add2', type: 'add', n: 2, weight: 30, label: '+2', color: '#4fd18b' },
    { id: 'mul2', type: 'mul', n: 2, weight: 20, label: '×2', color: '#ffb347' },
    { id: 'mul3', type: 'mul', n: 3, weight: 10, label: '×3', color: '#ff5da2' },
  ],
};

// AI difficulty: with probability (100 − difficulty)/100 the AI picks uniformly among moves within `slack`
// points of the best (or the top `topK` if fewer than 2 qualify) instead of the best.
export const AI = { slack: 4, topK: 5 };

// Strategy weight sets consumed by ai.js:chooseMove.
export const STRATEGIES = {
  greedy: {
    name: 'Greedy', blurb: 'Always plays the highest-scoring move.',
    exchangeThreshold: 0,      // exchange instead of playing when the best play scores ≤ this (and the bag is full enough)
  },
  blocker: {
    name: 'Blocker', blurb: 'Avoids leaving 4- and 5-lines open for others to Qwirkle on.',
    exchangeThreshold: 1,
    openLinePenalty: 3,        // per open 4/5-line the move creates or extends
    closeBonus: 2,             // per existing 4/5-line the move completes
  },
  builder: {
    name: 'Builder', blurb: 'Keeps a coherent hand; swaps weak hands.',
    exchangeThreshold: 3,
    weakHandMax: 2,            // only swap when the hand has ≤ this many pairing tiles
    handSynergy: 0.6,          // per pair of kept tiles sharing exactly one attribute
  },
  opportunist: {
    name: 'Opportunist', blurb: 'Hunts ×2/×3 cells and swaps freely when nothing scores.',
    exchangeThreshold: 4,
    aggressiveExchange: true,  // exchange whenever the bag has any tiles (others need bag ≥ hand size)
    multiplierBonus: 3,        // per multiplier step (×2 → 1 step, ×3 → 2) covered by the move
  },
};
export const STRATEGY_IDS = Object.keys(STRATEGIES);
export const AI_NAMES = ['Ada', 'Bo', 'Cy'];
