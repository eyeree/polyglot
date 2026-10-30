// Abstrackle tweakables. Runtime-adjustable ones are also exposed in the ⚙ drawer (see SETTINGS_SCHEMA in main.js).
export const DEFAULTS = {
  // game mode (applied to new games): a key of MODES
  mode: 'classic',
  rounds: 5,                   // rounds per game (Turns / Goal / Bag modes)
  turnsPerRound: 5,            // Turns mode: turns each player gets per round
  boardSize: 15,               // Turns / Bag modes: side of the square board (0 = unlimited)
  pointsGoal: 100,             // Goal mode: round points that end the round
  // opponents (applied to new games)
  opponents: 2,                // 1–3 AI players
  strategy1: 'random',         // 'random' or a key of STRATEGIES
  strategy2: 'random',
  strategy3: 'random',
  difficulty: 85,              // 0–100: how often the AI picks its best move
  // bonus cells (applied to new games)
  bonusDensity: 0.08,          // fraction of cells that carry a bonus (0 = none)
  bonusTypes: 'all',           // 'all' | 'add' (+n only) | 'mul' (×n only) | 'none'
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
export const FULL_LINE_SCORE = 12;     // a completed line of 6
export const END_BONUS = 6;          // for emptying your hand once the bag is empty
export const STALL_LIMIT = 30;       // safety: consecutive turns without a play before the game (or round) is called
export const MAX_REDRAWS = 3;        // Turns / Goal modes: hand replacements tried when nothing can be played, then the turn is passed

// Game modes. 'classic' is the original game; the others follow "6 tiles in a row": every round starts with one
// random tile in the centre, the first player is random in round 1 and rotates after that, tiles played in a turn
// form a connected chain (each must touch another tile played that turn), and round points add up to a game total.
export const MODES = {
  classic: {
    name: 'Classic', pool: 'bag', chain: false, bounded: false,
    blurb: 'Unlimited board, one bag of 108 tiles, lines only. Ends when the bag is empty and someone goes out.',
  },
  turns: {
    name: 'Turns', pool: 'infinite', chain: true, bounded: true,
    blurb: 'Fixed-size board, endless tiles. Each player gets a set number of turns per round; most points after all rounds wins.',
  },
  goal: {
    name: 'Goal', pool: 'infinite', chain: true, bounded: false,
    blurb: 'Unlimited board, endless tiles. A round ends as soon as someone reaches the points goal.',
  },
  bag: {
    name: 'Bag', pool: 'bag', chain: true, bounded: true,
    blurb: 'One bag of 108 tiles per round. No swapping: if you cannot play you draw one extra tile and may pass. The round ends when the bag is empty and nobody can play.',
  },
};
export const MODE_IDS = Object.keys(MODES);

// Bonus cells: deterministic from the seed (see rules.js:bonusAt). `weight`s are relative. An 'add' kind pays a
// value drawn uniformly from min..max; a 'mul' kind multiplies by `n`. `bonusTypes` ('all' | 'add' | 'mul' | 'none')
// in the settings picks which kinds are in play.
export const BONUS = {
  safeRadius: 1,               // cells within this Manhattan distance of the origin are never bonus
  kinds: [
    { id: 'add', type: 'add', min: 4, max: 12, weight: 70, label: '+n', color: '#4fd18b' },
    { id: 'mul2', type: 'mul', n: 2, weight: 20, label: '×2', color: '#ffb347' },
    { id: 'mul3', type: 'mul', n: 3, weight: 10, label: '×3', color: '#ff5da2' },
  ],
};

// AI difficulty: with probability (100 − difficulty)/100 the AI picks uniformly among moves within `slack`
// points of the best (or the top `topK` if fewer than 2 qualify) instead of the best.
// `beam`: in chain modes the AI keeps only the best `beam` partial plays per extra tile (the full space is huge).
export const AI = { slack: 4, topK: 5, beam: 120 };

// Strategy weight sets consumed by ai.js:chooseMove.
export const STRATEGIES = {
  greedy: {
    name: 'Greedy', blurb: 'Always plays the highest-scoring move.',
    exchangeThreshold: 0,      // exchange instead of playing when the best play scores ≤ this (and the bag is full enough)
  },
  blocker: {
    name: 'Blocker', blurb: 'Avoids leaving 4- and 5-lines open for others to Abstrackle on.',
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
