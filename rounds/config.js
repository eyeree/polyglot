// Rounds tweakables. Runtime-adjustable ones are also exposed in the ⚙ drawer (see SETTINGS_SCHEMA in main.js).
export const DEFAULTS = {
  // table
  opponents: 3,                // 1–5
  strat1: 'random',            // strategy per opponent seat: 'random' | a key of STRATEGIES
  strat2: 'random',
  strat3: 'random',
  strat4: 'random',
  strat5: 'random',
  aiDelayMs: 500,              // pause between visible AI steps
  // rules
  allowSameNumberSets: true,   // both sets of a two-set phase may use the same number
  goOutByHit: true,            // the hand can end when the last card is hit (otherwise a discard is required)
  // visuals / debug
  cardScale: 1.0,              // 0.7–1.3, scales the cards in the player's hand
  sortHand: 'number',          // 'number' | 'color' | 'none'
  promptLayDown: true,         // ask to lay down as soon as the cards in your phase slots complete the phase
  showOpponentHands: false,    // cheat/debug: reveal the AI players' cards
};

export const COLORS = ['red', 'blue', 'green', 'yellow'];

/**
 * The ten phases. comps: components to lay down together.
 *   set   n cards of one number (any colours)
 *   run   n consecutive numbers (any colours, no wrap)
 *   color n cards of one colour
 */
export const PHASES = [
  { label: '2 sets of 3', comps: [{ type: 'set', n: 3 }, { type: 'set', n: 3 }] },
  { label: 'set of 3 + run of 4', comps: [{ type: 'set', n: 3 }, { type: 'run', n: 4 }] },
  { label: 'set of 4 + run of 4', comps: [{ type: 'set', n: 4 }, { type: 'run', n: 4 }] },
  { label: 'run of 7', comps: [{ type: 'run', n: 7 }] },
  { label: 'run of 8', comps: [{ type: 'run', n: 8 }] },
  { label: 'run of 9', comps: [{ type: 'run', n: 9 }] },
  { label: '2 sets of 4', comps: [{ type: 'set', n: 4 }, { type: 'set', n: 4 }] },
  { label: '7 cards of one colour', comps: [{ type: 'color', n: 7 }] },
  { label: 'set of 5 + set of 2', comps: [{ type: 'set', n: 5 }, { type: 'set', n: 2 }] },
  { label: 'set of 5 + set of 3', comps: [{ type: 'set', n: 5 }, { type: 'set', n: 3 }] },
];

/**
 * AI strategy profiles. Every profile plays the same strong core (take useful discards, lay down as soon as the
 * phase is complete, hit everything, discard the card that keeps the phase closest). The knobs only change
 * priorities among otherwise equal choices.
 *
 *   pointsWeight   how much dumping high-point cards matters when the phase deficit is unaffected
 *   defensive      how much to avoid discarding numbers/colours the next player has visibly collected
 *   denyDraw       take a deficit-neutral discard just to keep it from the next player (if they want it)
 *   skipPolicy     'immediate' = discard a Skip as soon as you hold one; 'threat' = hold it until an opponent
 *                  has laid down and holds ≤ skipThreatCards cards (or until you are about to go out yourself)
 *   skipHoldCost   how reluctant to discard a Skip before the trigger fires (relative to one deficit step = 1000)
 *   skipTarget     'fewestCards' | 'nearestOut' (laid-down players with fewest cards) | 'leader' (lowest score) | 'next'
 *   holdWilds      after laying down, keep wilds in hand (for later hits) while going out is still far away
 */
export const STRATEGIES = {
  steady: {
    name: 'Steady', badge: 'S', color: '#4f8cff',
    pointsWeight: 1, defensive: 0.5, denyDraw: false,
    skipPolicy: 'immediate', skipThreatCards: 0, skipHoldCost: 0, skipTarget: 'fewestCards',
    holdWilds: false,
  },
  guardian: {
    name: 'Guardian', badge: 'G', color: '#4fd18b',
    pointsWeight: 0.5, defensive: 3, denyDraw: true,
    skipPolicy: 'threat', skipThreatCards: 4, skipHoldCost: 400, skipTarget: 'nearestOut',
    holdWilds: false,
  },
  hoarder: {
    name: 'Hoarder', badge: 'H', color: '#ffb347',
    pointsWeight: 1, defensive: 1, denyDraw: false,
    skipPolicy: 'threat', skipThreatCards: 5, skipHoldCost: 300, skipTarget: 'leader',
    holdWilds: true,
  },
};

export const AI_NAMES = ['Ada', 'Ben', 'Cleo', 'Dov', 'Eve'];
