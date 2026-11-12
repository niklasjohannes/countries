// Zero-dependency generator for `data/countries.json`.
//
//   node scripts/build-countries.js          write data/countries.json
//   node scripts/build-countries.js --check  exit 1 if the file is out of date
//
// All input is in `scripts/country-overrides.js`; there is no network access.
// The output is deterministic, so `test/countries.test.js` can regenerate it
// and compare byte for byte.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONTINENTS,
  ENTRIES,
  EXCLUDED,
  HAND_PLACED,
  M49_SUBREGIONS,
  NOT_DRAWN,
  POLICY,
  QUIZZED_EXTRAS,
  QUIZZED_TERRITORIES,
  SOURCE,
  SUBREGIONS
} from './country-overrides.js';

const OUTPUT_PATH = fileURLToPath(new URL('../data/countries.json', import.meta.url));
const QUIZZED_TOTAL = 206;
const CODE_PATTERN = /^[a-z]{2}$/;

/**
 * Invert the grouped M49 table into a code -> sub-region lookup.
 * @param {Record<string, string[]>} grouped sub-region -> codes
 * @param {Record<string, string>} handPlaced code -> sub-region for codes M49 lacks
 * @returns {Map<string, string>}
 */
export function invertSubregions(grouped, handPlaced) {
  if (grouped === null || typeof grouped !== 'object') {
    throw new TypeError('`grouped` must be an object of sub-region -> codes.');
  }
  if (handPlaced === null || typeof handPlaced !== 'object') {
    throw new TypeError('`handPlaced` must be an object of code -> sub-region.');
  }
  const lookup = new Map();
  const add = (code, subregion) => {
    if (!CODE_PATTERN.test(code)) {
      throw new RangeError(`Invalid code \`${code}\` in the sub-region table.`);
    }
    if (!Object.hasOwn(SUBREGIONS, subregion)) {
      throw new RangeError(`Unknown sub-region \`${subregion}\` for \`${code}\`.`);
    }
    if (lookup.has(code)) {
      throw new RangeError(`\`${code}\` is placed in two sub-regions.`);
    }
    lookup.set(code, subregion);
  };
  for (const [subregion, codes] of Object.entries(grouped)) {
    for (const code of codes) add(code, subregion);
  }
  for (const [code, subregion] of Object.entries(handPlaced)) add(code, subregion);
  return lookup;
}

/**
 * Build the full `countries.json` object from the overrides.
 * @returns {{meta: object, countries: object[]}}
 */
export function buildCountries() {
  const subregionOf = invertSubregions(M49_SUBREGIONS, HAND_PLACED);
  const quizzedTerritories = new Set(QUIZZED_TERRITORIES);
  const quizzedExtras = new Set(QUIZZED_EXTRAS);

  for (const code of [...quizzedTerritories, ...quizzedExtras]) {
    if (!Object.hasOwn(ENTRIES, code)) {
      throw new RangeError(`Quizzed code \`${code}\` has no entry in ENTRIES.`);
    }
  }
  for (const code of Object.keys(EXCLUDED)) {
    if (Object.hasOwn(ENTRIES, code)) {
      throw new RangeError(`\`${code}\` is both excluded and an entry.`);
    }
  }
  // Territories Natural Earth does not draw keep their ENTRIES row (so the
  // tables stay complete) but are left out of countries.json.
  for (const code of Object.keys(NOT_DRAWN)) {
    if (!Object.hasOwn(ENTRIES, code)) {
      throw new RangeError(`NOT_DRAWN code \`${code}\` has no entry in ENTRIES.`);
    }
    if (quizzedTerritories.has(code) || quizzedExtras.has(code) || ENTRIES[code].sovereign) {
      throw new RangeError(`Quizzed entry \`${code}\` cannot be NOT_DRAWN.`);
    }
  }

  const countries = [];
  for (const code of Object.keys(ENTRIES).sort()) {
    if (Object.hasOwn(NOT_DRAWN, code)) continue;
    const entry = ENTRIES[code];
    if (!CODE_PATTERN.test(code)) {
      throw new RangeError(`Invalid entry code \`${code}\`.`);
    }
    const subregion = subregionOf.get(code);
    if (subregion === undefined) {
      throw new RangeError(`\`${code}\` has no sub-region: add it to M49_SUBREGIONS or HAND_PLACED.`);
    }
    if (entry.parentCode !== null && !Object.hasOwn(ENTRIES, entry.parentCode)) {
      throw new RangeError(`\`${code}\` has unknown parentCode \`${entry.parentCode}\`.`);
    }
    countries.push({
      code,
      name: entry.name,
      aliases: entry.aliases,
      continent: SUBREGIONS[subregion],
      subregion,
      sovereign: entry.sovereign,
      parentCode: entry.parentCode,
      quizzed: entry.sovereign || quizzedExtras.has(code) || quizzedTerritories.has(code)
    });
  }

  const byCode = new Map(countries.map((country) => [country.code, country]));
  const quizzedCount = countries.filter((country) => country.quizzed).length;
  if (quizzedCount !== QUIZZED_TOTAL) {
    throw new RangeError(`Expected ${QUIZZED_TOTAL} quizzed entries, got ${quizzedCount}.`);
  }
  for (const country of countries) {
    if (quizzedTerritories.has(country.code) && country.sovereign) {
      throw new RangeError(`Quizzed territory \`${country.code}\` must not be sovereign.`);
    }
    if (country.parentCode !== null && !byCode.get(country.parentCode).sovereign) {
      throw new RangeError(`Parent \`${country.parentCode}\` of \`${country.code}\` must be sovereign.`);
    }
  }

  for (const code of subregionOf.keys()) {
    if (!Object.hasOwn(ENTRIES, code)) {
      throw new RangeError(`\`${code}\` is in the sub-region table but is not an entry.`);
    }
  }

  return {
    meta: {
      source: SOURCE,
      continents: CONTINENTS,
      subregions: SUBREGIONS,
      policy: POLICY,
      excluded: { ...EXCLUDED, ...NOT_DRAWN }
    },
    countries
  };
}

/**
 * Serialise with the meta block indented and one country per line, so a diff of
 * a single change touches a single line.
 * @param {{meta: object, countries: object[]}} data
 * @returns {string}
 */
export function serialiseCountries(data) {
  if (data === null || typeof data !== 'object' || !Array.isArray(data.countries)) {
    throw new TypeError('`data` must be an object with a `countries` array.');
  }
  const meta = JSON.stringify(data.meta, null, 2).replace(/\n/g, '\n  ');
  const rows = data.countries.map((country) => `    ${JSON.stringify(country)}`);
  return `{\n  "meta": ${meta},\n  "countries": [\n${rows.join(',\n')}\n  ]\n}\n`;
}

/** @returns {string} the exact text `data/countries.json` should contain. */
export function renderCountries() {
  return serialiseCountries(buildCountries());
}

/**
 * True when this module is the entry point, also through a symlink or when the
 * script was started without its `.js` extension.
 * @returns {boolean}
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const text = renderCountries();
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(OUTPUT_PATH, 'utf8');
    } catch (error) {
      // A missing file counts as out of date; anything else is a real failure.
      if (error.code !== 'ENOENT') throw error;
    }
    if (current !== text) {
      console.error('data/countries.json is out of date: run `node scripts/build-countries.js`.');
      process.exit(1);
    }
    console.log('data/countries.json is up to date.');
  } else {
    writeFileSync(OUTPUT_PATH, text);
    console.log(`Wrote data/countries.json (${JSON.parse(text).countries.length} entries).`);
  }
}
