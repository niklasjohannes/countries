// Practice round logic: which card is asked next, how it is shown, which
// answer counts, what feedback it gets and what is saved. Adapted from the
// flags repo's `practice-round.js` and extended with the map-specific parts
// (`planCard`, `getFeedbackPlan`, `persistAnswer`).
//
// Pure module apart from `persistAnswer`, which reads and writes the storage
// it is given: no DOM, no clock, no `Math.random`. A round is an immutable
// value; every function returns a new one.
//
//   let persistedCodes = new Set();          // once per practice visit
//   let round = createRound(pickRound(...));
//   while (!isRoundComplete(round)) {
//     const code = getCurrentCode(round);
//     const plan = planCard({ code, state, countries, meta, mode, rng });
//     ...ask it, then:
//     const { round: next, isFirstAnswer } = answerCurrent(round, correct);
//     if (isFirstAnswer) {
//       const result = persistAnswer({ code, correct, today, persistedCodes });
//       persistedCodes = result.persistedCodes;
//     }
//     round = next;
//   }
//   getScore(round); // { correct, total, percent }
//
// Round rules (js/srs.js module header):
//   - The FIRST answer to each country in the round is the one that counts:
//     it is scored, and offered to `recordAnswer` for persisting.
//   - A first-answer miss puts the country back into the queue `REQUEUE_GAP`
//     questions later (`requeueLapse`). That re-ask is reinforcement only:
//     never scored, never persisted. Each country is re-asked at most once
//     per round, even if the re-ask is missed too.
//   - Progress counts distinct countries, so re-asks do not advance it.
//
// Persistence rules (`recordAnswer`). Once due cards run out, `pickRound`
// fills rounds with cards that are not due yet, often the ones answered
// minutes ago. Without these rules each Keep going would grow their
// intervals again, e.g. 1 -> 6 -> 16 days in one sitting.
//   - Early review: a seen card that is not due yet (`dueDate > today`)
//     answered correctly keeps its persisted state. A miss is still a real
//     lapse. Due and never-seen cards always update.
//   - Once per practice visit: a code whose state was changed since the
//     practice view mounted is never changed again during that visit.
//
// Card plan (`planCard`): direction from `pickDirection`, frame from
// `pickFrame`, and the frame level the renderer needs. The `south-america`
// key is both a continent and a sub-region frame, so the level is decided
// here from the direction and the card's maturity, never from the key.

import {
  DIRECTION_MAP_TO_NAME,
  DIRECTION_NAME_TO_TAP,
  isMature,
  pickDirection,
  pickFrame
} from './cards.js';
import { FRAME_LEVEL_CONTINENT, FRAME_LEVEL_SUBREGION } from './map-view.js';
import { createCardState, isNewCard, requeueLapse, updateCardState } from './srs.js';
import { QUIZ_MODES, loadStates, saveStates } from './storage.js';
import { isPlainObject } from './validate.js';

/** Answer mode of a name → tap card (it has no MC or typing UI). */
export const ANSWER_MODE_TAP = 'tap';

function assertCodes(codes) {
  if (!Array.isArray(codes) || !codes.every((code) => typeof code === 'string' && code !== '')) {
    throw new TypeError('`codes` must be an array of country code strings.');
  }
  if (new Set(codes).size !== codes.length) {
    throw new RangeError('`codes` must not contain duplicates.');
  }
}

function assertRound(round) {
  const isRound = isPlainObject(round) &&
    Number.isInteger(round.total) && Array.isArray(round.queue) &&
    isPlainObject(round.results);
  if (!isRound) {
    throw new TypeError('`round` must be a round from `createRound`.');
  }
}

function freezeRound(total, queue, results) {
  return Object.freeze({
    total,
    queue: Object.freeze(queue),
    results: Object.freeze(results)
  });
}

// ---- Round state ----

/**
 * Start a round.
 *
 * @param {string[]} codes The round's distinct countries, in asking order
 *   (from `pickRound`). May be empty, giving a round that is already complete.
 * @returns {{ total: number, queue: string[], results: Object<string, boolean> }}
 *   Frozen round. `queue` holds the upcoming codes, the current one first;
 *   `results` maps each country answered so far to whether its first answer
 *   was correct.
 */
export function createRound(codes) {
  assertCodes(codes);
  return freezeRound(codes.length, [...codes], {});
}

/**
 * The country being asked now.
 *
 * @param {object} round A round from `createRound`.
 * @returns {string | null} Its code, or `null` once the round is complete.
 */
export function getCurrentCode(round) {
  assertRound(round);
  return round.queue[0] ?? null;
}

/**
 * Whether the current question is a re-ask of a country already answered
 * (and missed) in this round.
 *
 * @param {object} round A round from `createRound`.
 * @returns {boolean} `false` for a first ask, or once the round is complete.
 */
export function isReask(round) {
  assertRound(round);
  const code = getCurrentCode(round);
  return code !== null && Object.hasOwn(round.results, code);
}

/**
 * Whether every question, re-asks included, has been answered.
 *
 * @param {object} round A round from `createRound`.
 * @returns {boolean}
 */
export function isRoundComplete(round) {
  assertRound(round);
  return round.queue.length === 0;
}

/**
 * Answer the current question.
 *
 * @param {object} round A round from `createRound`; must not be complete.
 * @param {boolean} correct Whether the answer was correct.
 * @returns {{ round: object, code: string, isFirstAnswer: boolean }} The next
 *   round state, the code just answered, and whether this was its first
 *   answer in the round (scored, and to be persisted by the caller).
 */
export function answerCurrent(round, correct) {
  assertRound(round);
  if (typeof correct !== 'boolean') {
    throw new TypeError('`correct` must be a boolean.');
  }
  const code = getCurrentCode(round);
  if (code === null) {
    throw new RangeError('`round` is already complete.');
  }
  const isFirstAnswer = !Object.hasOwn(round.results, code);
  const results = isFirstAnswer ? { ...round.results, [code]: correct } : { ...round.results };
  const rest = round.queue.slice(1);
  // Only a first-answer miss is re-queued: one re-ask per country per round.
  const queue = correct || !isFirstAnswer ? rest : requeueLapse(rest, code);
  return { round: freezeRound(round.total, queue, results), code, isFirstAnswer };
}

/**
 * Progress through the round's distinct countries.
 *
 * @param {object} round A round from `createRound`.
 * @returns {{ position: number, total: number }} `position` is the 1-based
 *   number of the country being asked for the first time; during a re-ask (or
 *   once complete) it is the number answered so far.
 */
export function getProgress(round) {
  assertRound(round);
  const answered = Object.keys(round.results).length;
  const isFirstAsk = getCurrentCode(round) !== null && !isReask(round);
  return { position: answered + (isFirstAsk ? 1 : 0), total: round.total };
}

/**
 * The round's score: first answers only.
 *
 * @param {object} round A round from `createRound`.
 * @returns {{ correct: number, total: number, percent: number }} `percent`
 *   is rounded down.
 */
export function getScore(round) {
  assertRound(round);
  const correct = Object.values(round.results).filter(Boolean).length;
  const { total } = round;
  return { correct, total, percent: total === 0 ? 0 : Math.floor((correct * 100) / total) };
}

/**
 * The countries missed on their first answer, in the order they were asked.
 *
 * @param {object} round A round from `createRound`.
 * @returns {string[]} Codes of the first-answer misses.
 */
export function getMissed(round) {
  assertRound(round);
  return Object.entries(round.results).filter(([, correct]) => !correct).map(([code]) => code);
}

// ---- Persisting ----

/**
 * Apply a first answer in a round to the persisted card states, following the
 * early-review and once-per-visit rules (module header).
 *
 * @param {object} options
 * @param {Object<string, object>} options.states Card states keyed by code
 *   (from `loadStates`).
 * @param {string} options.code The answered country.
 * @param {boolean} options.correct Whether the answer was correct.
 * @param {string} options.today Local date, `YYYY-MM-DD`.
 * @param {ReadonlySet<string>} [options.persistedCodes=new Set()] Codes
 *   already changed during this practice visit.
 * @returns {{ states: Object<string, object>, persistedCodes: ReadonlySet<string>, changed: boolean }}
 *   `changed` says whether the answer changed the card's state (save
 *   `states` only then). Neither input is modified.
 */
export function recordAnswer({ states, code, correct, today, persistedCodes = new Set() } = {}) {
  if (!isPlainObject(states)) {
    throw new TypeError('`states` must be an object mapping country codes to card states.');
  }
  if (!(persistedCodes instanceof Set)) {
    throw new TypeError('`persistedCodes` must be a `Set` of country codes, or omitted.');
  }
  const current = Object.hasOwn(states, code) ? states[code] : createCardState(code);
  // Validates `current`, `correct` and `today` even when nothing changes.
  const updated = updateCardState(current, correct, today);
  const isEarlyReview = !isNewCard(current) && current.dueDate > today;
  if (persistedCodes.has(code) || (isEarlyReview && correct)) {
    return { states, persistedCodes, changed: false };
  }
  return {
    states: { ...states, [code]: updated },
    persistedCodes: new Set([...persistedCodes, code]),
    changed: true
  };
}

/**
 * Load the stored states fresh, apply a first answer and save if it changed
 * anything. Loading right before writing means the save never rolls back
 * state written elsewhere since the round started.
 *
 * @param {object} options
 * @param {string} options.code The answered country.
 * @param {boolean} options.correct Whether the answer was correct.
 * @param {string} options.today Local date, `YYYY-MM-DD`.
 * @param {ReadonlySet<string>} [options.persistedCodes=new Set()] See `recordAnswer`.
 * @param {Storage | null} [options.storage] Storage to use; defaults to `localStorage`.
 * @returns {{ states: Object<string, object>, persistedCodes: ReadonlySet<string>, changed: boolean }}
 *   The states as they are stored now (so a caller can keep them instead of
 *   parsing storage again), the updated visit set, and whether the stored
 *   state changed.
 */
export function persistAnswer({ code, correct, today, persistedCodes = new Set(), storage } = {}) {
  const recorded = recordAnswer({
    states: loadStates(today, storage),
    code,
    correct,
    today,
    persistedCodes
  });
  if (recorded.changed) {
    saveStates(recorded.states, storage);
  }
  return { states: recorded.states, persistedCodes: recorded.persistedCodes, changed: recorded.changed };
}

// ---- Card plan ----

/**
 * Decide how one card is shown.
 *
 * - Direction: `pickDirection` (name → tap only for tappable entries).
 * - Frame: `pickFrame` (name → tap always on the sub-region; map → name on
 *   the continent once `intervalDays >= MATURE_INTERVAL_DAYS`).
 * - `frameLevel` matches the frame: continent only for a mature map → name
 *   card. Decided here because the `south-america` key is both.
 * - `answerMode`: the user's MC / typing choice for map → name, and
 *   `ANSWER_MODE_TAP` for name → tap.
 *
 * @param {object} options
 * @param {string} options.code The country to ask.
 * @param {{ intervalDays: number } | null} options.state Its SRS state, or `null` if unseen.
 * @param {object[]} options.countries The `countries` array of `data/countries.json`.
 * @param {{ frames: object, entries: object }} options.meta Parsed `data/map-meta.json`.
 * @param {string} options.mode One of `QUIZ_MODES`.
 * @param {() => number} options.rng Random source returning `[0, 1)`.
 * @returns {{ code: string, direction: string, answerMode: string, frameKey: string, frame: number[], frameLevel: string, neighbours: string[] }}
 *   Frozen plan.
 */
export function planCard({ code, state, countries, meta, mode, rng } = {}) {
  if (typeof code !== 'string' || code === '') {
    throw new TypeError('`code` must be a country code string.');
  }
  if (!Array.isArray(countries)) {
    throw new TypeError('`countries` must be an array.');
  }
  if (!isPlainObject(meta) || !isPlainObject(meta.frames) || !isPlainObject(meta.entries)) {
    throw new TypeError('`meta` must be a map-meta object with `frames` and `entries`.');
  }
  if (!QUIZ_MODES.includes(mode)) {
    throw new RangeError(`\`mode\` must be one of ${QUIZ_MODES.join(', ')}.`);
  }
  const country = countries.find((item) => item.code === code);
  if (country === undefined) {
    throw new RangeError('`code` must be the code of one of `countries`.');
  }
  const info = meta.entries[code];
  if (!isPlainObject(info)) {
    throw new RangeError('`code` must have an entry in `meta.entries`.');
  }

  const direction = pickDirection(info, rng);
  const frameKey = pickFrame(state, country, direction);
  if (!Object.hasOwn(meta.frames, frameKey)) {
    throw new RangeError(`\`meta.frames\` has no frame \`${frameKey}\`.`);
  }
  const isContinent = direction === DIRECTION_MAP_TO_NAME && isMature(state);
  return Object.freeze({
    code,
    direction,
    answerMode: direction === DIRECTION_NAME_TO_TAP ? ANSWER_MODE_TAP : mode,
    frameKey,
    frame: meta.frames[frameKey],
    frameLevel: isContinent ? FRAME_LEVEL_CONTINENT : FRAME_LEVEL_SUBREGION,
    neighbours: Object.freeze([...(info.neighbours ?? [])])
  });
}

// ---- Feedback ----

/** Delay (ms) between revealing a hit and the next question. */
export const HIT_ADVANCE_MS = 700;

/**
 * How an answer advances (PLAN decision 12).
 *
 * - A hit advances by itself after `HIT_ADVANCE_MS`.
 * - A miss waits for a Next tap.
 *
 * Labels follow the same split (the map view shows them on a miss only), and
 * re-queueing is `answerCurrent`'s job, not part of this plan.
 *
 * @param {boolean} correct Whether the answer was correct.
 * @returns {{ advance: 'auto' | 'next', advanceMs: number | null }} Frozen description.
 */
export function getFeedbackPlan(correct) {
  if (typeof correct !== 'boolean') {
    throw new TypeError('`correct` must be a boolean.');
  }
  return Object.freeze(correct
    ? { advance: 'auto', advanceMs: HIT_ADVANCE_MS }
    : { advance: 'next', advanceMs: null });
}
