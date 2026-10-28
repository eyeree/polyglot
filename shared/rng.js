// Seeded PRNG (mulberry32). Seeds make deals/boards reproducible, which the
// Yukon game tree relies on (states are rebuilt by replaying moves from the seed).

export function randomSeed() {
  return (Math.random() * 2 ** 32) >>> 0;
}

export function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function makeRng(seed) {
  let a = (typeof seed === 'string' ? hashString(seed) : seed) >>> 0;
  const rng = {
    seed: a,
    /** float in [0, 1) */
    next() {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    /** integer in [0, n) */
    int(n) { return Math.floor(rng.next() * n); },
    /** integer in [lo, hi] inclusive */
    range(lo, hi) { return lo + rng.int(hi - lo + 1); },
    pick(arr) { return arr[rng.int(arr.length)]; },
    chance(p) { return rng.next() < p; },
    /** in-place Fisher-Yates shuffle; returns the array */
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    },
  };
  return rng;
}
