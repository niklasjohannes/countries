// Test-mode pass (PLAN decision 13): every quizzed entry in the filter
// exactly once, in random order, answered blind, then scored. Pure: no DOM, no
// storage, no clock; the caller injects `rng`. Test mode never touches SRS
// card state, so nothing here reads or writes it: no storage or SRS write
// function is referenced (test/test-isolation.test.js guards that).
//
// A pass is a frozen `{ filter, codes, answers }`:
//   filter   `{ continent, subregion }`, each a slug or `null` for All.
//   codes    The entries to ask, in asking order.
//   answers  The code chosen for each asked entry so far (`answers[i]` is the
//            answer to `codes[i]`). The pass is complete when both have the
//            same length.

import { CONTINENTS, SUBREGIONS } from './srs.js';
import { isPlainObject } from './validate.js';

function isNonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

function assertCountries(countries) {
  if (!Array.isArray(countries)) {
    throw new TypeError('`countries` must be an array.');
  }
  countries.forEach((country, i) => {
    if (!isPlainObject(country) || !isNonEmptyString(country.code) || !isNonEmptyString(country.name)) {
      throw new TypeError(`\`countries[${i}]\` must be an object with a \`code\` and a \`name\`.`);
    }
  });
}

// Normalises a filter: missing fields become `null`.
function normaliseFilter(filter) {
  if (!isPlainObject(filter)) {
    throw new TypeError('`filter` must be an object `{ continent, subregion }`.');
  }
  const continent = filter.continent ?? null;
  const subregion = filter.subregion ?? null;
  if (continent !== null && !CONTINENTS.includes(continent)) {
    throw new RangeError(`\`filter.continent\` must be one of ${CONTINENTS.join(', ')}, or null.`);
  }
  if (subregion !== null && !Object.hasOwn(SUBREGIONS, subregion)) {
    throw new RangeError('`filter.subregion` must be one of the 22 known sub-regions, or null.');
  }
  if (continent !== null && subregion !== null && SUBREGIONS[subregion] !== continent) {
    throw new RangeError('`filter.subregion` must belong to `filter.continent`.');
  }
  return { continent, subregion };
}

function assertPass(pass) {
  const isPass = isPlainObject(pass) &&
    Array.isArray(pass.codes) &&
    Array.isArray(pass.answers) &&
    pass.answers.length <= pass.codes.length &&
    pass.codes.every(isNonEmptyString) &&
    pass.answers.every(isNonEmptyString);
  if (!isPass) {
    throw new TypeError('`pass` must be a test pass from `createTestPass`.');
  }
  normaliseFilter(pass.filter);
}

function freezePass(filter, codes, answers) {
  return Object.freeze({
    filter: Object.freeze({ ...filter }),
    codes: Object.freeze(codes),
    answers: Object.freeze(answers)
  });
}

/**
 * Codes of the quizzed entries in a scope, in data order, each once.
 *
 * @param {object} options
 * @param {object[]} options.countries The `countries` array of
 *   `data/countries.json`; only `quizzed` entries count.
 * @param {{ continent?: string | null, subregion?: string | null }} options.filter
 *   The scope.
 * @returns {string[]} Country codes.
 */
export function getScopeCodes({ countries, filter } = {}) {
  assertCountries(countries);
  const { continent, subregion } = normaliseFilter(filter);
  const seen = new Set();
  const codes = [];
  for (const country of countries) {
    const isInScope = country.quizzed === true &&
      (continent === null || country.continent === continent) &&
      (subregion === null || country.subregion === subregion);
    if (isInScope && !seen.has(country.code)) {
      seen.add(country.code);
      codes.push(country.code);
    }
  }
  return codes;
}

/**
 * Start a test pass: every quizzed entry in the scope once, shuffled.
 *
 * @param {object} options
 * @param {object[]} options.countries The `countries` array of
 *   `data/countries.json`.
 * @param {{ continent?: string | null, subregion?: string | null }} options.filter
 *   The scope.
 * @param {() => number} options.rng Random source returning `[0, 1)` (e.g.
 *   `Math.random`).
 * @returns {{ filter: object, codes: string[], answers: string[] }} The pass
 *   (frozen), with no answers yet.
 */
export function createTestPass({ countries, filter, rng } = {}) {
  const codes = getScopeCodes({ countries, filter });
  if (typeof rng !== 'function') {
    throw new TypeError('`rng` must be a function returning a number in [0, 1).');
  }
  if (codes.length === 0) {
    throw new RangeError('`filter` must contain at least one entry.');
  }
  // Fisher-Yates.
  for (let i = codes.length - 1; i > 0; i -= 1) {
    const r = rng();
    if (typeof r !== 'number' || !(r >= 0 && r < 1)) {
      throw new RangeError('`rng` must return a number in [0, 1).');
    }
    const j = Math.floor(r * (i + 1));
    [codes[i], codes[j]] = [codes[j], codes[i]];
  }
  return freezePass(normaliseFilter(filter), codes, []);
}

/**
 * Whether every entry of a pass has been answered.
 *
 * @param {{ codes: string[], answers: string[] }} pass From `createTestPass`.
 * @returns {boolean} `true` when complete.
 */
export function isPassComplete(pass) {
  assertPass(pass);
  return pass.answers.length === pass.codes.length;
}

/**
 * Record the answer to the pass's current entry (`codes[answers.length]`).
 *
 * @param {{ filter: object, codes: string[], answers: string[] }} pass From
 *   `createTestPass` or a previous `recordTestAnswer`; not complete.
 * @param {string} chosenCode The code the user picked.
 * @returns {{ filter: object, codes: string[], answers: string[] }} A new pass
 *   (frozen); `pass` is unchanged.
 */
export function recordTestAnswer(pass, chosenCode) {
  assertPass(pass);
  if (!isNonEmptyString(chosenCode)) {
    throw new TypeError('`chosenCode` must be a non-empty string.');
  }
  if (pass.answers.length === pass.codes.length) {
    throw new RangeError('`pass` is already complete.');
  }
  return freezePass(pass.filter, [...pass.codes], [...pass.answers, chosenCode]);
}

/**
 * Score a complete pass.
 *
 * @param {{ codes: string[], answers: string[] }} pass A complete pass.
 * @param {object[]} countries The `countries` array of `data/countries.json`,
 *   for the names.
 * @returns {{
 *   total: number,
 *   correct: number,
 *   percent: number,
 *   missed: { code: string, name: string, chosenCode: string, chosenName: string }[]
 * }} The score (frozen). `percent` is rounded down, so 100 means a perfect
 *   pass. `missed` is in asking order.
 */
export function scorePass(pass, countries) {
  assertPass(pass);
  assertCountries(countries);
  if (pass.answers.length !== pass.codes.length) {
    throw new RangeError('`pass` must be complete.');
  }
  const names = new Map(countries.map((country) => [country.code, country.name]));
  const getName = (code) => {
    if (!names.has(code)) {
      throw new RangeError(`\`pass\` has code \`${code}\`, which is not in \`countries\`.`);
    }
    return names.get(code);
  };
  const missed = [];
  pass.codes.forEach((code, i) => {
    const chosenCode = pass.answers[i];
    const name = getName(code);
    const chosenName = getName(chosenCode);
    if (chosenCode !== code) {
      missed.push(Object.freeze({ code, name, chosenCode, chosenName }));
    }
  });
  const total = pass.codes.length;
  const correct = total - missed.length;
  return Object.freeze({
    total,
    correct,
    percent: total === 0 ? 0 : Math.floor((correct * 100) / total),
    missed: Object.freeze(missed)
  });
}

/**
 * Format a score for display.
 *
 * @param {{ correct: number, total: number, percent: number }} score From
 *   `scorePass`.
 * @returns {string} e.g. `'182/206 · 88%'`.
 */
export function formatScore(score) {
  const isScore = isPlainObject(score) &&
    [score.correct, score.total, score.percent].every(Number.isInteger) &&
    score.correct >= 0 && score.correct <= score.total;
  if (!isScore) {
    throw new TypeError('`score` must be a score from `scorePass`.');
  }
  return `${score.correct}/${score.total} · ${score.percent}%`;
}
