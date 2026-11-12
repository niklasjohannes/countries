// Pure card logic: which way a card is asked, and which frame it is shown on.
//
// Pure module: no DOM, no `localStorage`, no clock, no `Math.random`. The
// caller injects `rng` (`() => number` in `[0, 1)`).

import { SUBREGIONS } from './srs.js';

// ---- Tunables ----

/** Share of tappable cards asked as name → tap (the rest are map → name). */
export const TAP_CARD_SHARE = 0.25;

/** From this `intervalDays` on, a card is mature and framed on its continent. */
export const MATURE_INTERVAL_DAYS = 21;

// ---- Directions ----

/** The map shows an unlabelled outline; the user names it. */
export const DIRECTION_MAP_TO_NAME = 'map-to-name';

/** The prompt names a country; the user taps it on the map. */
export const DIRECTION_NAME_TO_TAP = 'name-to-tap';

// ---- Validation helpers ----

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---- Public API ----

/**
 * Whether a card is mature: its interval has reached `MATURE_INTERVAL_DAYS`.
 * A card that has never been answered (`state` is `null`) is young.
 *
 * @param {{ intervalDays: number } | null} state The card's SRS state, or `null` if unseen.
 * @returns {boolean} `true` from `intervalDays >= MATURE_INTERVAL_DAYS` on.
 */
export function isMature(state) {
  if (state === null) {
    return false;
  }
  if (!isPlainObject(state)) {
    throw new TypeError('`state` must be a card state object or `null`.');
  }
  if (!Number.isInteger(state.intervalDays) || state.intervalDays < 0) {
    throw new TypeError('`state.intervalDays` must be a non-negative integer.');
  }
  return state.intervalDays >= MATURE_INTERVAL_DAYS;
}

/**
 * Picks the direction of a card. Entries that are not tappable (`small`
 * entries) are always map → name and do not consume `rng`; a tappable entry
 * draws once from `rng` and is name → tap with probability `TAP_CARD_SHARE`.
 * `small`, when given, must equal `!tappable` (the map-meta contract).
 *
 * @param {{ tappable: boolean, small?: boolean }} entry The entry's `data/map-meta.json` record.
 * @param {() => number} rng Random source returning numbers in `[0, 1)`.
 * @returns {'map-to-name' | 'name-to-tap'} The card direction.
 */
export function pickDirection(entry, rng) {
  if (!isPlainObject(entry)) {
    throw new TypeError('`entry` must be a map-meta entry object.');
  }
  if (typeof entry.tappable !== 'boolean') {
    throw new TypeError('`entry.tappable` must be a boolean.');
  }
  if (entry.small !== undefined && typeof entry.small !== 'boolean') {
    throw new TypeError('`entry.small` must be a boolean when given.');
  }
  if (entry.small === entry.tappable) {
    throw new RangeError('`entry.small` must be the opposite of `entry.tappable`.');
  }
  if (typeof rng !== 'function') {
    throw new TypeError('`rng` must be a function returning a number in `[0, 1)`.');
  }

  if (!entry.tappable) {
    return DIRECTION_MAP_TO_NAME;
  }
  const draw = rng();
  if (!Number.isFinite(draw) || draw < 0 || draw >= 1) {
    throw new RangeError('`rng` must return a finite number in `[0, 1)`.');
  }
  return draw < TAP_CARD_SHARE ? DIRECTION_NAME_TO_TAP : DIRECTION_MAP_TO_NAME;
}

/**
 * Picks the frame a card is shown on.
 *
 * - name → tap cards always use the fixed sub-region frame: `tappable` /
 *   `small` are measured at sub-region zoom, so zooming out could make the
 *   target too small to tap.
 * - map → name cards use the sub-region while young, and the continent once
 *   `state.intervalDays >= MATURE_INTERVAL_DAYS`.
 *
 * A card that has never been answered (`state` is `null`) is young.
 *
 * @param {{ intervalDays: number } | null} state The card's SRS state, or `null` if unseen.
 * @param {{ continent: string, subregion: string }} entry The country's `data/countries.json` record.
 * @param {'map-to-name' | 'name-to-tap'} direction The card direction, from `pickDirection`.
 * @returns {string} A key into `data/map-meta.json` → `frames` (a sub-region or continent).
 */
export function pickFrame(state, entry, direction) {
  if (state !== null) {
    if (!isPlainObject(state)) {
      throw new TypeError('`state` must be a card state object or `null`.');
    }
    if (!Number.isInteger(state.intervalDays) || state.intervalDays < 0) {
      throw new TypeError('`state.intervalDays` must be a non-negative integer.');
    }
  }
  if (!isPlainObject(entry)) {
    throw new TypeError('`entry` must be a `{ continent, subregion }` object.');
  }
  if (!Object.hasOwn(SUBREGIONS, entry.subregion)) {
    throw new RangeError('`entry.subregion` must be one of the 22 known sub-regions.');
  }
  if (SUBREGIONS[entry.subregion] !== entry.continent) {
    throw new RangeError('`entry.continent` must be the continent of `entry.subregion`.');
  }
  if (direction !== DIRECTION_MAP_TO_NAME && direction !== DIRECTION_NAME_TO_TAP) {
    throw new RangeError(`\`direction\` must be '${DIRECTION_MAP_TO_NAME}' or '${DIRECTION_NAME_TO_TAP}'.`);
  }

  if (direction === DIRECTION_NAME_TO_TAP) {
    return entry.subregion;
  }
  return isMature(state) ? entry.continent : entry.subregion;
}
