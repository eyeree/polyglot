// Blocks tweakables. Runtime-adjustable ones are also exposed in the settings drawer (see SETTINGS_SCHEMA in main.js).

// Shapes as cell matrices (1 = filled), in their "dealt rotation 0" orientation.
// Add more shapes here; each type also needs a PALETTE colour.
export const SHAPES = {
  I: [[1, 1, 1, 1]],
  O: [[1, 1], [1, 1]],
  T: [[1, 1, 1], [0, 1, 0]],
  S: [[0, 1, 1], [1, 1, 0]],
  Z: [[1, 1, 0], [0, 1, 1]],
  J: [[1, 0, 0], [1, 1, 1]],
  L: [[0, 0, 1], [1, 1, 1]],
};
export const SHAPE_TYPES = Object.keys(SHAPES);

// Default colour per shape type (overridable per type in settings as `color<Type>`).
export const PALETTE = {
  I: '#39c0e8',
  O: '#f5c542',
  T: '#b36cf0',
  S: '#5fd17a',
  Z: '#f0616d',
  J: '#4f8cff',
  L: '#ff9a3c',
};

export const TRAY_SIZE = 3;

export const DEFAULTS = {
  // rules
  gridSize: 10,                // 8 | 10 | 12; applies to the next new game
  rotationCost: 2,             // rotation points charged when a block is placed in a rotation other than the one dealt
  rotationPointsPerLine: 1,    // rotation points earned per line cleared
  clearMultiplier: 2,          // clear score = cellsCleared × linesCleared × clearMultiplier
  allowSwap: true,             // dropping a tray block on an occupied side slot swaps the two
  startRotationPoints: 0,
  // visuals
  animMs: 200,                 // line-clear flash / snap-back duration
  cellGap: 3,                  // px between board cells
  ...Object.fromEntries(SHAPE_TYPES.map(t => ['color' + t, PALETTE[t]])),
};
