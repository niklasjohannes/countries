import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTINENTS, SUBREGIONS } from '../js/srs.js';

// Guards the hand-written fixtures against drifting from the data contracts
// in SPEC.md ("Data contracts"), so the engine tests stay meaningful.

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const { meta, countries } = read('countries.json');
const { frames, entries } = read('map-meta.json');

// `names.json` is a hand-picked subset of names and aliases taken from the
// flags app's data; it is not part of the countries.json contract, so it is
// not checked here.

describe('test/fixtures/countries.json', () => {
  it('lists the closed continents and 22 sub-regions', () => {
    assert.deepEqual(meta.continents, [...CONTINENTS]);
    assert.deepEqual(meta.subregions, { ...SUBREGIONS });
    assert.equal(Object.keys(meta.subregions).length, 22);
  });

  it('is sorted by code and has well-formed, consistent entries', () => {
    const codes = countries.map((country) => country.code);
    assert.deepEqual(codes, [...codes].sort());
    assert.equal(new Set(codes).size, codes.length);
    for (const country of countries) {
      assert.match(country.code, /^[a-z]{2}$/);
      assert.equal(meta.subregions[country.subregion], country.continent, country.code);
      assert.equal(typeof country.quizzed, 'boolean', country.code);
      assert.equal(country.sovereign, country.parentCode === null, country.code);
      assert.ok(country.parentCode === null || codes.includes(country.parentCode), country.code);
    }
  });
});

describe('test/fixtures/map-meta.json', () => {
  it('has an entry for every country and symmetric neighbours', () => {
    assert.equal(typeof frames, 'object');
    assert.deepEqual(Object.keys(entries).sort(), countries.map((country) => country.code));
    for (const [code, entry] of Object.entries(entries)) {
      assert.equal(entry.tappable, !entry.small, code);
      for (const neighbour of entry.neighbours) {
        assert.ok(entries[neighbour].neighbours.includes(code), `${code} <-> ${neighbour}`);
      }
    }
  });
});
