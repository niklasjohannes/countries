// Seeded PRNG for tests, so random draws are reproducible.

/**
 * Mulberry32: small, fast, deterministic PRNG.
 * @param {number} seed any integer
 * @returns {() => number} a function returning numbers in [0, 1)
 */
export function createRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
