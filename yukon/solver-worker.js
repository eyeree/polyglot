import { solve } from './solver.js';
import { replay } from './game.js';

self.onmessage = (e) => {
  const { id, seed, moves, opts } = e.data;
  const state = replay(seed, moves);
  const res = solve(state, { ...opts, onProgress: (n) => self.postMessage({ id, progress: n }) });
  self.postMessage({ id, done: true, ...res });
};
