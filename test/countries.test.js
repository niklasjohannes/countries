import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  buildCountries,
  invertSubregions,
  renderCountries,
  serialiseCountries
} from '../scripts/build-countries.js';
import { M49_SUBREGIONS, SUBREGIONS } from '../scripts/country-overrides.js';

const FILE_URL = new URL('../data/countries.json', import.meta.url);
const text = readFileSync(FILE_URL, 'utf8');
const data = JSON.parse(text);
const byCode = new Map(data.countries.map((country) => [country.code, country]));
const quizzed = data.countries.filter((country) => country.quizzed);

const CLOSED_SUBREGIONS = [
  'northern-africa', 'western-africa', 'middle-africa', 'eastern-africa', 'southern-africa',
  'northern-america', 'central-america', 'caribbean',
  'south-america',
  'central-asia', 'eastern-asia', 'south-eastern-asia', 'southern-asia', 'western-asia',
  'northern-europe', 'western-europe', 'eastern-europe', 'southern-europe',
  'australia-and-new-zealand', 'melanesia', 'micronesia', 'polynesia'
];

describe('quizzed deck', () => {
  it('has exactly 206 quizzed entries', () => {
    assert.equal(quizzed.length, 206);
  });

  it('is 193 UN members, 4 named extras and 9 territories', () => {
    const extras = ['va', 'ps', 'xk', 'tw'];
    const territories = ['gl', 'eh', 'gf', 'pr', 'nc', 'fk', 'pf', 'sj', 'hk'];
    // `sovereign` is "UN member or observer": 193 members + va + ps.
    const sovereign = quizzed.filter((country) => country.sovereign);
    assert.equal(sovereign.length - 2, 193);
    assert.deepEqual(
      quizzed.filter((c) => !c.sovereign).map((c) => c.code).sort(),
      [...extras.filter((c) => c !== 'va' && c !== 'ps'), ...territories].sort()
    );
    for (const code of [...extras, ...territories]) {
      assert.equal(byCode.get(code)?.quizzed, true, `${code} must be quizzed`);
    }
  });

  it('marks every sovereign entry as quizzed', () => {
    for (const country of data.countries.filter((c) => c.sovereign)) {
      assert.equal(country.quizzed, true, country.code);
    }
  });

  it('keeps context-only territories non-sovereign with a parent', () => {
    for (const country of data.countries.filter((c) => !c.quizzed)) {
      assert.equal(country.sovereign, false, country.code);
      assert.ok(country.parentCode, `${country.code} needs a parentCode`);
    }
  });
});

describe('continents and sub-regions', () => {
  it('uses the closed list of 22 sub-regions', () => {
    assert.deepEqual(Object.keys(data.meta.subregions).sort(), [...CLOSED_SUBREGIONS].sort());
    assert.equal(Object.keys(SUBREGIONS).length, 22);
  });

  it('puts every entry in a listed sub-region that maps to its continent', () => {
    for (const country of data.countries) {
      assert.ok(data.meta.continents.includes(country.continent), `${country.code} continent`);
      assert.equal(
        data.meta.subregions[country.subregion],
        country.continent,
        `${country.code}: ${country.subregion} must belong to ${country.continent}`
      );
    }
  });

  it('has the six continents and uses each one', () => {
    assert.deepEqual(data.meta.continents, [
      'africa', 'asia', 'europe', 'north-america', 'south-america', 'oceania'
    ]);
    for (const continent of data.meta.continents) {
      assert.ok(data.countries.some((c) => c.continent === continent), continent);
    }
  });

  it('transcribes M49 without placing a code twice', () => {
    const all = Object.values(M49_SUBREGIONS).flat();
    assert.equal(all.length, 247);
    assert.equal(new Set(all).size, all.length);
  });
});

describe('references and shape', () => {
  it('resolves every parentCode', () => {
    for (const country of data.countries) {
      if (country.parentCode !== null) {
        assert.ok(byCode.has(country.parentCode), `${country.code} -> ${country.parentCode}`);
      }
    }
  });

  it('gives sovereign entries no parent and never parents a territory to a territory', () => {
    for (const country of data.countries) {
      if (country.sovereign) assert.equal(country.parentCode, null, country.code);
      if (country.parentCode !== null) {
        assert.equal(byCode.get(country.parentCode).sovereign, true, country.code);
      }
    }
  });

  it('is sorted by code with unique lowercase two-letter codes', () => {
    const codes = data.countries.map((c) => c.code);
    assert.deepEqual(codes, [...codes].sort());
    assert.equal(new Set(codes).size, codes.length);
    for (const code of codes) assert.match(code, /^[a-z]{2}$/);
  });

  it('gives every entry the contract fields with the right types', () => {
    for (const c of data.countries) {
      assert.deepEqual(
        Object.keys(c),
        ['code', 'name', 'aliases', 'continent', 'subregion', 'sovereign', 'parentCode', 'quizzed'],
        c.code
      );
      assert.ok(typeof c.name === 'string' && c.name.length > 0, c.code);
      assert.ok(Array.isArray(c.aliases) && c.aliases.every((a) => typeof a === 'string'), c.code);
      assert.equal(typeof c.sovereign, 'boolean');
      assert.equal(typeof c.quizzed, 'boolean');
    }
  });

  it('has meta with source, policy and excluded', () => {
    assert.equal(data.meta.source.accessed, '2026-11-12');
    assert.match(data.meta.source.url, /^https:\/\/unstats\.un\.org\//);
    assert.ok(data.meta.excluded.aq);
    assert.ok(!byCode.has('aq'));
  });

  it('keeps aliases from duplicating a name or each other', () => {
    const names = new Map();
    for (const c of data.countries) {
      for (const label of [c.name, ...c.aliases]) {
        const key = label.toLowerCase();
        assert.ok(!names.has(key), `"${label}" is used by ${names.get(key)} and ${c.code}`);
        names.set(key, c.code);
      }
    }
  });
});

describe('spot checks', () => {
  it('places Russia in eastern-europe', () => {
    assert.equal(byCode.get('ru').subregion, 'eastern-europe');
    assert.equal(byCode.get('ru').continent, 'europe');
  });

  it('places Türkiye and Cyprus in western-asia', () => {
    assert.equal(byCode.get('tr').subregion, 'western-asia');
    assert.equal(byCode.get('cy').subregion, 'western-asia');
  });

  it('makes Greenland northern-america with parent dk', () => {
    assert.equal(byCode.get('gl').subregion, 'northern-america');
    assert.equal(byCode.get('gl').parentCode, 'dk');
  });

  it('gives Hong Kong parent cn', () => {
    assert.equal(byCode.get('hk').parentCode, 'cn');
  });

  it('gives Western Sahara a null parent', () => {
    assert.equal(byCode.get('eh').parentCode, null);
    assert.equal(byCode.get('eh').sovereign, false);
  });

  it('adds Kosovo with alias Kosova, placed by geography', () => {
    const xk = byCode.get('xk');
    assert.equal(xk.name, 'Kosovo');
    assert.deepEqual(xk.aliases, ['Kosova']);
    assert.equal(xk.subregion, 'southern-europe');
    assert.equal(xk.parentCode, null);
  });

  it('places Taiwan by geography in eastern-asia', () => {
    assert.equal(byCode.get('tw').subregion, 'eastern-asia');
    assert.equal(byCode.get('tw').parentCode, null);
  });

  it('has no separate entries for places the border policy folds into a state', () => {
    const names = data.countries.flatMap((c) => [c.name, ...c.aliases]).map((n) => n.toLowerCase());
    for (const folded of [
      'crimea', 'northern cyprus', 'somaliland', 'abkhazia', 'south ossetia', 'transnistria', 'kashmir'
    ]) {
      assert.ok(!names.includes(folded), folded);
    }
  });
});

describe('border policy', () => {
  it('has a meta.policy.borders row for every case in the table', () => {
    for (const key of [
      'crimea', 'northern-cyprus', 'somaliland', 'abkhazia', 'south-ossetia',
      'transnistria', 'kashmir', 'western-sahara', 'kosovo', 'aksai-chin', 'arunachal-pradesh',
      'occupied-ukraine', 'golan-heights', 'halaib-triangle', 'bir-tawil', 'akrotiri-dhekelia',
      'nagorno-karabakh'
    ]) {
      assert.ok(data.meta.policy.borders[key], key);
    }
  });

  it('lists every case as its own row in docs/DATA.md', () => {
    const doc = readFileSync(new URL('../docs/DATA.md', import.meta.url), 'utf8');
    for (const row of [
      'Crimea', 'Northern Cyprus', 'Somaliland', 'Abkhazia', 'South Ossetia',
      'Transnistria', 'Kashmir', 'Western Sahara', 'Kosovo', 'Aksai Chin and the Trans-Karakoram Tract',
      'Arunachal Pradesh', 'Occupied Ukraine beyond Crimea', 'Golan Heights', 'Hala\'ib Triangle',
      'Bir Tawil', 'Akrotiri and Dhekelia', 'Nagorno-Karabakh'
    ]) {
      assert.match(doc, new RegExp(`^\\| ${row}( \\(.*\\))? \\|`, 'm'), `${row} needs its own table row`);
    }
  });
});

describe('regeneration', () => {
  it('matches the committed file byte for byte', () => {
    assert.equal(renderCountries(), text);
  });

  it('round-trips through the serialiser', () => {
    assert.deepEqual(JSON.parse(serialiseCountries(buildCountries())), data);
  });
});

describe('generator validation', () => {
  it('rejects a code placed in two sub-regions', () => {
    assert.throws(
      () => invertSubregions({ caribbean: ['aa'], polynesia: ['aa'] }, {}),
      /two sub-regions/
    );
  });

  it('rejects an unknown sub-region', () => {
    assert.throws(() => invertSubregions({ atlantis: ['aa'] }, {}), /Unknown sub-region/);
  });

  it('rejects an invalid code', () => {
    assert.throws(() => invertSubregions({ caribbean: ['AA'] }, {}), /Invalid code/);
  });

  it('rejects non-object input', () => {
    assert.throws(() => invertSubregions(null, {}), TypeError);
    assert.throws(() => invertSubregions({}, null), TypeError);
    assert.throws(() => serialiseCountries({}), TypeError);
  });
});
