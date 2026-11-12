import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SUGGESTION_LIMIT,
  DISTRACTOR_COUNT,
  MATCH_TIERS,
  buildChoices,
  filterSuggestions,
  getTypoThreshold,
  normalizeText,
  pickDistractors
} from '../js/quiz.js';

// ---- Helpers ----

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(REPO_ROOT, 'test', 'fixtures');

function readFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

// Small committed fixtures shaped like the `data/countries.json` and
// `data/map-meta.json` contracts (SPEC.md, Data contracts).
const { countries } = readFixture('countries.json');
const { entries: mapEntries } = readFixture('map-meta.json');
// Names and aliases for the typing-mode tests.
const names = readFixture('names.json');
const byCode = new Map(countries.map((country) => [country.code, country]));

function neighboursOf(code) {
  return mapEntries[code].neighbours;
}

function pick(code, rng, list = countries) {
  return pickDistractors({ code, countries: list, neighbours: neighboursOf(code), rng });
}

// Mulberry32: small, fast, deterministic PRNG returning [0, 1).
function createRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function deepFreeze(value) {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

// Independent statement of the exclusion rule: the target, its parent, its
// siblings, its dependents and context-only entries.
function getExcluded(code, list) {
  const target = list.find((country) => country.code === code);
  const parent = target.parentCode ?? null;
  const excluded = new Set([code]);
  for (const country of list) {
    const isSibling = parent !== null && country.parentCode === parent;
    const isDependent = country.parentCode === code;
    if (country.code === parent || isSibling || isDependent || country.quizzed === false) {
      excluded.add(country.code);
    }
  }
  return excluded;
}

// Independent statement of the ranking: how many distractors each tier can
// supply, in order (neighbours, same sub-region, same continent, any).
function expectedTierCounts(code, list, neighbours) {
  const target = list.find((country) => country.code === code);
  const excluded = getExcluded(code, list);
  let remaining = list.filter((country) => !excluded.has(country.code));
  const counts = [];
  let needed = DISTRACTOR_COUNT;
  for (const inTier of [
    (c) => neighbours.includes(c.code),
    (c) => c.subregion === target.subregion,
    (c) => c.continent === target.continent,
    () => true
  ]) {
    const taken = Math.min(needed, remaining.filter(inTier).length);
    counts.push(taken);
    needed -= taken;
    remaining = remaining.filter((c) => !inTier(c));
  }
  return counts;
}

function tierOf(candidate, target, neighbours) {
  if (neighbours.includes(candidate.code)) {
    return 0;
  }
  if (candidate.subregion === target.subregion) {
    return 1;
  }
  return candidate.continent === target.continent ? 2 : 3;
}

function assertValidDistractors(distractors, code, list) {
  const listByCode = new Map(list.map((country) => [country.code, country]));
  const excluded = getExcluded(code, list);
  assert.equal(distractors.length, DISTRACTOR_COUNT, `${code}: wrong count`);
  assert.equal(new Set(distractors).size, DISTRACTOR_COUNT, `${code}: duplicates in ${distractors}`);
  for (const distractor of distractors) {
    assert.ok(listByCode.has(distractor), `${code}: unknown code ${distractor}`);
    assert.ok(!excluded.has(distractor), `${code}: related distractor ${distractor}`);
  }
}

function codesOf(suggestions) {
  return suggestions.map((suggestion) => suggestion.code);
}

// ---- Multiple choice: fixture data ----

describe('pickDistractors on the countries fixture', () => {
  it('returns 3 distinct, valid, unrelated codes for every entry', () => {
    const rng = createRng(1);
    for (const { code } of countries.filter((country) => country.quizzed)) {
      for (let round = 0; round < 20; round += 1) {
        assertValidDistractors(pick(code, rng), code, countries);
      }
    }
  });

  it('fills the tiers in order: neighbours, sub-region, continent, any', () => {
    const rng = createRng(2);
    for (const target of countries.filter((country) => country.quizzed)) {
      const neighbours = neighboursOf(target.code);
      const expected = expectedTierCounts(target.code, countries, neighbours);
      for (let round = 0; round < 20; round += 1) {
        const tiers = pick(target.code, rng)
          .map((distractor) => tierOf(byCode.get(distractor), target, neighbours))
          .sort();
        const actual = [0, 0, 0, 0];
        tiers.forEach((tier) => { actual[tier] += 1; });
        assert.deepEqual(actual, expected, `${target.code}: wrong tier mix`);
      }
    }
  });

  it('prefers neighbours: Togo always gets Benin or Ghana', () => {
    const rng = createRng(20);
    assert.deepEqual(neighboursOf('tg'), ['bf', 'bj', 'gh']);
    for (let round = 0; round < 500; round += 1) {
      const distractors = pick('tg', rng);
      assert.ok(distractors.includes('bj') || distractors.includes('gh'), `got ${distractors}`);
    }
  });

  it('uses every neighbour before looking further', () => {
    const rng = createRng(21);
    for (let round = 0; round < 200; round += 1) {
      assert.deepEqual([...pick('tg', rng)].sort(), ['bf', 'bj', 'gh']);
      // Germany has five neighbours; any three of them.
      const german = pick('de', rng);
      assert.ok(german.every((code) => neighboursOf('de').includes(code)), `de got ${german}`);
    }
  });

  it('tops up from the same sub-region when neighbours run short', () => {
    // Benin has 4 neighbours; with only one of them valid the rest must come
    // from western-africa before anywhere else.
    const rng = createRng(22);
    for (let round = 0; round < 300; round += 1) {
      const distractors = pickDistractors({ code: 'tg', countries, neighbours: ['gh'], rng });
      assert.ok(distractors.includes('gh'));
      const others = distractors.filter((code) => code !== 'gh');
      assert.ok(others.every((code) => byCode.get(code).subregion === 'western-africa'), `got ${distractors}`);
    }
  });

  it('never gives Hong Kong China (its parent) or Macao (its sibling)', () => {
    const rng = createRng(23);
    assert.ok(neighboursOf('hk').includes('cn'), 'fixture should list China as a neighbour');
    for (let round = 0; round < 500; round += 1) {
      const distractors = pick('hk', rng);
      assert.ok(!distractors.includes('cn'), `got ${distractors}`);
      assert.ok(!distractors.includes('mo'), `got ${distractors}`);
      assertValidDistractors(distractors, 'hk', countries);
    }
  });

  it('never offers a context-only entry as a distractor or neighbour', () => {
    const rng = createRng(24);
    assert.ok(neighboursOf('ma').includes('eh'), 'fixture should list Western Sahara next to Morocco');
    assert.equal(byCode.get('eh').quizzed, false);
    for (const { code } of countries) {
      for (let round = 0; round < 50; round += 1) {
        assert.ok(!pick(code, rng).includes('eh'), `${code} was offered eh`);
      }
    }
  });

  it('still yields 3 valid distractors for a Polynesia-sized pool', () => {
    // Only 3 entries in the target's sub-region and continent, none of them
    // a neighbour: everything else has to come from other continents.
    const small = countries.filter((country) => (
      country.subregion === 'polynesia' && ['ws', 'to', 'tv'].includes(country.code)
    ) || ['fr', 'de', 'jp', 'ng', 'ca'].includes(country.code));
    const rng = createRng(25);
    const seen = new Set();
    for (let round = 0; round < 500; round += 1) {
      const distractors = pickDistractors({ code: 'ws', countries: small, neighbours: [], rng });
      assertValidDistractors(distractors, 'ws', small);
      assert.ok(distractors.includes('to') && distractors.includes('tv'), `got ${distractors}`);
      distractors.forEach((code) => seen.add(code));
    }
    assert.ok(['fr', 'de', 'jp', 'ng', 'ca'].every((code) => seen.has(code)), 'fallback tier is not uniform');
  });

  it('never pairs Puerto Rico and the United States, in either direction', () => {
    const rng = createRng(3);
    for (let round = 0; round < 500; round += 1) {
      assert.ok(!pick('pr', rng).includes('us'));
      assert.ok(!pick('us', rng).includes('pr'));
    }
  });

  it('never pairs US territories with each other or with the United States', () => {
    const usFamily = new Set(['us', ...countries.filter((c) => c.parentCode === 'us').map((c) => c.code)]);
    assert.ok(usFamily.has('gu') && usFamily.has('as') && usFamily.has('pr'));
    const rng = createRng(4);
    for (const code of usFamily) {
      for (let round = 0; round < 200; round += 1) {
        const related = pick(code, rng).filter((d) => usFamily.has(d));
        assert.deepEqual(related, [], `${code} got ${related}`);
      }
    }
  });

  it('handles Oceania: stays on the continent and unrelated for gu, as, au, nz and ck', () => {
    const rng = createRng(5);
    const expectedExclusions = {
      gu: ['us', 'as', 'pr'],
      as: ['us', 'gu', 'pr'],
      au: [],
      nz: ['ck', 'nu', 'tk'],
      ck: ['nz', 'nu', 'tk']
    };
    for (const [code, related] of Object.entries(expectedExclusions)) {
      const excluded = getExcluded(code, countries);
      for (const relative of related) {
        assert.ok(excluded.has(relative), `${code} should exclude ${relative}`);
      }
      for (let round = 0; round < 200; round += 1) {
        const distractors = pick(code, rng);
        assertValidDistractors(distractors, code, countries);
        for (const distractor of distractors) {
          assert.equal(byCode.get(distractor).continent, 'oceania', `${code} got ${distractor}`);
          assert.ok(!related.includes(distractor), `${code} got ${distractor}`);
        }
      }
    }
  });

  it('draws every valid candidate of a tier, roughly uniformly', () => {
    const rng = createRng(6);
    const code = 'fr';
    const excluded = getExcluded(code, countries);
    const pool = countries
      .filter((c) => c.subregion === 'western-europe' && !excluded.has(c.code))
      .map((c) => c.code);
    const counts = new Map(pool.map((candidate) => [candidate, 0]));
    const draws = 6_000;
    for (let round = 0; round < draws; round += 1) {
      for (const distractor of pickDistractors({ code, countries, neighbours: [], rng })) {
        counts.set(distractor, counts.get(distractor) + 1);
      }
    }
    const expected = (draws * DISTRACTOR_COUNT) / pool.length;
    for (const [candidate, count] of counts) {
      assert.ok(Math.abs(count - expected) < expected * 0.15, `${candidate}: ${count} vs ~${expected}`);
    }
  });

  it('is deterministic for a given rng seed', () => {
    const first = pick('fj', createRng(7));
    const second = pick('fj', createRng(7));
    assert.deepEqual(first, second);
  });

  it('does not modify `countries`', () => {
    const frozen = deepFreeze(structuredClone(countries));
    const rng = createRng(8);
    pickDistractors({ code: 'pr', countries: frozen, neighbours: ['us'], rng });
    buildChoices({ code: 'au', countries: frozen, neighbours: ['nz'], rng });
    assert.deepEqual(frozen, countries);
  });
});

// ---- Multiple choice: synthetic small sub-region ----

describe('pickDistractors fallback for a small sub-region', () => {
  // `t1` is a territory of sovereign `p` in a tiny sub-region; its
  // siblings `t2` (same sub-region) and `t3` (another continent) and the parent
  // itself are off limits. Only `o1` is a valid same-region option.
  const place = { europe: 'western-europe', oceania: 'polynesia', asia: 'eastern-asia' };
  const entry = (code, continent, parentCode = null) => ({
    code, continent, subregion: place[continent], sovereign: parentCode === null, parentCode, quizzed: true
  });
  const tiny = [
    entry('p', 'europe'),
    entry('t1', 'oceania', 'p'),
    entry('t2', 'oceania', 'p'),
    entry('t3', 'asia', 'p'),
    entry('o1', 'oceania'),
    entry('e1', 'europe'),
    entry('e2', 'europe'),
    entry('a1', 'asia')
  ];

  it('keeps every valid same-sub-region option and fills the rest from further afield', () => {
    const rng = createRng(9);
    const seen = new Set();
    for (let round = 0; round < 500; round += 1) {
      const distractors = pickDistractors({ code: 't1', countries: tiny, rng });
      assertValidDistractors(distractors, 't1', tiny);
      assert.ok(distractors.includes('o1'), `missing o1 in ${distractors}`);
      distractors.forEach((distractor) => seen.add(distractor));
    }
    assert.deepEqual([...seen].sort(), ['a1', 'e1', 'e2', 'o1']);
  });

  it('excludes a sovereign target\'s dependents in every continent', () => {
    const rng = createRng(10);
    for (let round = 0; round < 500; round += 1) {
      const distractors = pickDistractors({ code: 'p', countries: tiny, rng });
      assertValidDistractors(distractors, 'p', tiny);
      for (const dependent of ['t1', 't2', 't3']) {
        assert.ok(!distractors.includes(dependent), `p got ${dependent}`);
      }
    }
  });

  it('returns 4 valid options from buildChoices', () => {
    const rng = createRng(11);
    for (let round = 0; round < 200; round += 1) {
      const choices = buildChoices({ code: 't1', countries: tiny, rng });
      assert.equal(choices.length, DISTRACTOR_COUNT + 1);
      assert.equal(choices.filter((choice) => choice === 't1').length, 1);
      assertValidDistractors(choices.filter((choice) => choice !== 't1'), 't1', tiny);
    }
  });

  it('throws when the whole dataset has too few valid options', () => {
    const tooSmall = tiny.filter((country) => !['e1', 'e2'].includes(country.code));
    assert.throws(
      () => pickDistractors({ code: 't1', countries: tooSmall, rng: createRng(12) }),
      { name: 'RangeError', message: /only 2 valid distractors/ }
    );
  });

  it('counts duplicate codes once', () => {
    const duplicated = [...tiny, entry('o1', 'oceania')];
    const rng = createRng(13);
    for (let round = 0; round < 200; round += 1) {
      assertValidDistractors(pickDistractors({ code: 't1', countries: duplicated, rng }), 't1', tiny);
    }
  });
});

// ---- Multiple choice: buildChoices ----

describe('buildChoices', () => {
  it('returns 4 distinct codes including the target exactly once', () => {
    const rng = createRng(14);
    for (const { code } of countries.filter((country) => country.quizzed)) {
      const choices = buildChoices({ code, countries, neighbours: neighboursOf(code), rng });
      assert.equal(choices.length, DISTRACTOR_COUNT + 1);
      assert.equal(new Set(choices).size, choices.length);
      assert.ok(choices.includes(code));
      assertValidDistractors(choices.filter((choice) => choice !== code), code, countries);
    }
  });

  it('puts the correct answer in each position roughly equally often', () => {
    const rng = createRng(15);
    const rounds = 8_000;
    const counts = [0, 0, 0, 0];
    for (let round = 0; round < rounds; round += 1) {
      counts[buildChoices({ code: 'fr', countries, neighbours: neighboursOf('fr'), rng }).indexOf('fr')] += 1;
    }
    const expected = rounds / counts.length;
    for (const [position, count] of counts.entries()) {
      assert.ok(Math.abs(count - expected) < expected * 0.1, `position ${position}: ${count} vs ~${expected}`);
    }
  });
});

// ---- Multiple choice: validation ----

describe('pickDistractors and buildChoices validation', () => {
  const rng = createRng(16);

  it('rejects a bad or unknown `code`', () => {
    assert.throws(() => pickDistractors({ code: 42, countries, rng }), { name: 'TypeError', message: /`code`/ });
    assert.throws(() => pickDistractors({ code: 'zz', countries, rng }), { name: 'RangeError', message: /`code` `zz`/ });
    assert.throws(() => buildChoices({ code: 'zz', countries, rng }), RangeError);
  });

  it('rejects bad `countries`', () => {
    assert.throws(() => pickDistractors({ code: 'fr', countries: {}, rng }), { name: 'TypeError', message: /`countries`/ });
    assert.throws(
      () => pickDistractors({ code: 'fr', countries: [null], rng }),
      { name: 'TypeError', message: /`countries\[0\]`/ }
    );
    assert.throws(
      () => pickDistractors({ code: 'fr', countries: [{ code: 'fr' }], rng }),
      { name: 'TypeError', message: /`countries\[0\]\.continent`/ }
    );
    assert.throws(
      () => pickDistractors({ code: 'fr', countries: [{ code: 'fr', continent: 'europe' }], rng }),
      { name: 'TypeError', message: /`countries\[0\]\.subregion`/ }
    );
    const placed = { code: 'fr', continent: 'europe', subregion: 'western-europe' };
    assert.throws(
      () => pickDistractors({ code: 'fr', countries: [{ ...placed, quizzed: 'yes' }], rng }),
      { name: 'TypeError', message: /`countries\[0\]\.quizzed`/ }
    );
    assert.throws(
      () => pickDistractors({ code: 'fr', countries: [{ ...placed, parentCode: 7 }], rng }),
      { name: 'TypeError', message: /`countries\[0\]\.parentCode`/ }
    );
  });

  it('rejects bad `neighbours`', () => {
    assert.throws(
      () => pickDistractors({ code: 'fr', countries, neighbours: 'de', rng }),
      { name: 'TypeError', message: /`neighbours`/ }
    );
    assert.throws(
      () => pickDistractors({ code: 'fr', countries, neighbours: ['de', 7], rng }),
      { name: 'TypeError', message: /`neighbours\[1\]`/ }
    );
  });

  it('works without `neighbours`', () => {
    assertValidDistractors(pickDistractors({ code: 'fr', countries, rng }), 'fr', countries);
  });

  it('rejects a bad `rng`', () => {
    assert.throws(() => pickDistractors({ code: 'fr', countries }), { name: 'TypeError', message: /`rng`/ });
    assert.throws(() => pickDistractors({ code: 'fr', countries, rng: () => 1 }), { name: 'RangeError', message: /`rng`/ });
    assert.throws(() => pickDistractors({ code: 'fr', countries, rng: () => NaN }), RangeError);
  });

  it('rejects a missing or non-object options argument', () => {
    assert.throws(() => pickDistractors(), TypeError);
    assert.throws(() => buildChoices(), TypeError);
    for (const options of [null, 'fr', ['fr']]) {
      assert.throws(() => pickDistractors(options), { name: 'TypeError', message: /`options`/ });
      assert.throws(() => buildChoices(options), { name: 'TypeError', message: /`options`/ });
    }
  });
});

// ---- Typing mode: normalization ----

describe('normalizeText', () => {
  it('folds case, diacritics, punctuation and whitespace', () => {
    assert.equal(normalizeText("Côte d'Ivoire"), 'cote d ivoire');
    assert.equal(normalizeText('  COTE   d IVOIRE '), 'cote d ivoire');
    assert.equal(normalizeText('São Tomé and Príncipe'), 'sao tome and principe');
    assert.equal(normalizeText('Guinea-Bissau'), 'guinea bissau');
    assert.equal(normalizeText('U.S. Virgin Islands'), 'u s virgin islands');
    assert.equal(normalizeText('Åland'), 'aland');
    assert.equal(normalizeText("'.- "), '');
  });

  it('splits ligatures and full-width forms (NFKD)', () => {
    assert.equal(normalizeText('ﬁji'), 'fiji');
    assert.equal(normalizeText('ＵＳＡ'), 'usa');
  });

  it('folds letters that decomposition leaves whole', () => {
    assert.equal(normalizeText('Straße'), 'strasse');
    assert.equal(normalizeText('Færøerne'), 'faeroerne');
    assert.equal(normalizeText('Œuvre'), 'oeuvre');
    assert.equal(normalizeText('Łódź'), 'lodz');
    assert.equal(normalizeText('Đakovo'), 'dakovo');
    assert.equal(normalizeText('Diyarbakır'), 'diyarbakir');
    assert.equal(normalizeText('Þórshöfn'), 'thorshofn');
  });

  it('rejects non-strings', () => {
    assert.throws(() => normalizeText(null), { name: 'TypeError', message: /`text`/ });
  });
});

describe('getTypoThreshold', () => {
  it('scales with query length', () => {
    assert.equal(getTypoThreshold('br'), 0);
    assert.equal(getTypoThreshold('bra'), 1);
    assert.equal(getTypoThreshold('braz'), 2);
    assert.equal(getTypoThreshold('brazl'), 2);
    assert.equal(getTypoThreshold('phillipi'), 2);
    assert.equal(getTypoThreshold('a b'), 0);
    assert.equal(getTypoThreshold('a b c'), 1);
  });

  it('never decreases as the query grows', () => {
    let previous = 0;
    for (let length = 1; length <= 30; length += 1) {
      const threshold = getTypoThreshold('x'.repeat(length));
      assert.ok(threshold >= previous, `length ${length}`);
      previous = threshold;
    }
  });

  it('rejects non-strings', () => {
    assert.throws(() => getTypoThreshold(3), { name: 'TypeError', message: /`query`/ });
  });
});

// ---- Typing mode: filterSuggestions ----

describe('filterSuggestions', () => {
  function top(query, options) {
    return filterSuggestions(query, names, options)[0];
  }

  it('matches aliases', () => {
    assert.deepEqual(top('holland'), { code: 'nl', name: 'Netherlands', matched: 'Holland' });
    assert.equal(top('usa').code, 'us');
    assert.equal(top('usa').matched, 'USA');
    assert.deepEqual(top('burma'), { code: 'mm', name: 'Myanmar', matched: 'Burma' });
    assert.equal(top('ivory coast').code, 'ci');
    assert.equal(top('turkey').code, 'tr');
    for (const query of ['england', 'scotland', 'wales', 'northern ireland', 'great britain']) {
      assert.equal(top(query).code, 'gb', query);
    }
    assert.equal(top('ireland').code, 'ie');
  });

  it('matches a missing-letter subsequence', () => {
    assert.equal(top('grmny').code, 'de');
    assert.equal(top('nwzlnd').code, 'nz');
  });

  it('ignores case, diacritics and punctuation', () => {
    for (const query of ["cote d'ivoire", "Côte d'Ivoire", 'cote d ivoire', 'CÔTE', 'cotedivoire']) {
      assert.equal(top(query).code, 'ci', query);
    }
    assert.equal(top('sao tome').code, 'st');
    assert.equal(top('TÜRKIYE').code, 'tr');
  });

  it('matches partial input', () => {
    assert.equal(top('swit').code, 'ch');
    assert.equal(top('zeal').code, 'nz');
  });

  it('tolerates typos', () => {
    assert.equal(top('brazl').code, 'br');
    assert.equal(top('jermany').code, 'de');
    assert.equal(top('phillipines').code, 'ph');
    assert.equal(top('nwe zealand').code, 'nz');
    assert.equal(top('morroco').code, 'ma');
    assert.equal(top('sirya').code, 'sy');
  });

  it('ranks a one-edit typo above a widely spread subsequence', () => {
    // Each query is also a subsequence of the second, longer name.
    const cases = [
      ['fratce', 'fr', 'fm'],
      ['bahrein', 'bh', 'ba'],
      ['kenia', 'ke', 'cc'],
      ['brzzil', 'br', 'cg']
    ];
    for (const [query, expected, spread] of cases) {
      const codes = codesOf(filterSuggestions(query, names, { limit: 50 }));
      assert.equal(codes[0], expected, query);
      assert.ok(codes.includes(spread), `${query} should still list ${spread}`);
    }
  });

  it('does not drop a country while the user types on past a typo', () => {
    function isShown(query, code) {
      return codesOf(filterSuggestions(query, names, { limit: 300 })).includes(code);
    }
    function assertStaysShown(typed, code) {
      let wasShown = false;
      for (let length = 1; length <= typed.length; length += 1) {
        const shown = isShown(typed.slice(0, length), code);
        assert.ok(shown || !wasShown, `${typed.slice(0, length)} dropped ${code}`);
        wasShown = shown;
      }
      assert.ok(wasShown, `${typed} never showed ${code}`);
    }
    assertStaysShown('morroco', 'ma');
    assertStaysShown('sirya', 'sy');
    assertStaysShown('phillipines', 'ph');
    assertStaysShown('jermany', 'de');
    assertStaysShown('brzzil', 'br');
    // One typo (deletion or substitution) in the middle of every real name;
    // the letters after it are typed correctly.
    for (const { code, name } of names.filter((entry) => entry.quizzed !== false)) {
      const normalized = normalizeText(name);
      const middle = Math.floor(normalized.length / 2);
      const substituted = normalized[middle] === 'x' ? 'q' : 'x';
      assertStaysShown(normalized.slice(0, middle) + normalized.slice(middle + 1), code);
      assertStaysShown(normalized.slice(0, middle) + substituted + normalized.slice(middle + 1), code);
    }
  });

  it('returns both sides of a shared bare name', () => {
    assert.deepEqual(codesOf(filterSuggestions('korea', names)).slice(0, 2).sort(), ['kp', 'kr']);
    assert.deepEqual(codesOf(filterSuggestions('congo', names)).slice(0, 2).sort(), ['cd', 'cg']);
  });

  it('ranks by tier: exact, prefix, word-prefix, substring, fuzzy', () => {
    const list = [
      { code: 'e', name: 'Mali', aliases: [] },
      { code: 'p', name: 'Malibu', aliases: [] },
      { code: 'w', name: 'North Mali', aliases: [] },
      { code: 's', name: 'Somalia', aliases: [] },
      { code: 'q', name: 'Mxaxlxi', aliases: [] },
      { code: 't', name: 'Mlai', aliases: [] },
      { code: 'n', name: 'Chad', aliases: [] }
    ];
    assert.deepEqual(MATCH_TIERS, ['exact', 'prefix', 'word-prefix', 'substring', 'fuzzy']);
    // Both last two are fuzzy: 'mlai' is one swap (cost 1), 'mxaxlxi' skips
    // three letters (cost 1.5).
    assert.deepEqual(codesOf(filterSuggestions('mali', list)), ['e', 'p', 'w', 's', 't', 'q']);
  });

  it('orders shorter matches first within a tier, then by name', () => {
    const list = [
      { code: 'c', name: 'Grenadines', aliases: [] },
      { code: 'b', name: 'Grenada Bay', aliases: [] },
      { code: 'a', name: 'Grenada', aliases: [] },
      { code: 'd', name: 'Greece', aliases: [] },
      { code: 'z', name: 'Gren Zeta', aliases: [] },
      { code: 'y', name: 'Gren Alfa', aliases: [] }
    ];
    // Greece is one typo away ('gree'), so it comes last.
    assert.deepEqual(codesOf(filterSuggestions('gren', list)), ['a', 'y', 'z', 'c', 'b', 'd']);
  });

  it('lists each country once, under its best match', () => {
    const results = filterSuggestions('united states', names, { limit: 50 });
    assert.equal(new Set(codesOf(results)).size, results.length);
    assert.deepEqual(results[0], { code: 'us', name: 'United States', matched: 'United States' });
    for (const query of ['a', 'us', 'island', 'saint', 'guinea']) {
      const codes = codesOf(filterSuggestions(query, names, { limit: 300 }));
      assert.equal(new Set(codes).size, codes.length, query);
    }
  });

  it('never suggests a context-only entry', () => {
    assert.ok(names.some((entry) => entry.code === 'eh' && entry.quizzed === false));
    assert.deepEqual(filterSuggestions('western sahara', names), []);
    assert.ok(!codesOf(filterSuggestions('sahrawi republic', names)).includes('eh'));
    const suggested = filterSuggestions('wes', [
      { code: 'eh', name: 'Western Sahara', quizzed: false },
      { code: 'ws', name: 'Western Samoa', quizzed: true },
      { code: 'xx', name: 'Westland' }
    ]);
    assert.deepEqual(codesOf(suggested).sort(), ['ws', 'xx']);
  });

  it('respects `limit`', () => {
    assert.equal(filterSuggestions('a', names).length, DEFAULT_SUGGESTION_LIMIT);
    assert.equal(filterSuggestions('a', names, { limit: 3 }).length, 3);
    assert.equal(filterSuggestions('holland', names, { limit: 1 }).length, 1);
    assert.ok(filterSuggestions('a', names, { limit: 300 }).length > DEFAULT_SUGGESTION_LIMIT);
  });

  it('returns [] for an empty, whitespace or punctuation-only query', () => {
    assert.deepEqual(filterSuggestions('', names), []);
    assert.deepEqual(filterSuggestions('   ', names), []);
    assert.deepEqual(filterSuggestions(" ' - ", names), []);
  });

  it('returns [] when nothing matches', () => {
    assert.deepEqual(filterSuggestions('xqzwv', names), []);
  });

  it('counts duplicate codes once and accepts missing aliases', () => {
    const list = [
      { code: 'fr', name: 'France' },
      { code: 'fr', name: 'France', aliases: ['French Republic'] }
    ];
    assert.deepEqual(filterSuggestions('fra', list), [{ code: 'fr', name: 'France', matched: 'France' }]);
  });

  it('does not modify `countries`', () => {
    const frozen = deepFreeze(structuredClone(names));
    filterSuggestions('cote', frozen);
    assert.deepEqual(frozen, names);
  });

  it('is fast enough to run on every keystroke', () => {
    // A generous bound on the median, so a loaded CI machine cannot flake it;
    // a laptop takes well under 1 ms.
    const queries = ['g', 'ge', 'ger', 'germ', 'grmny', 'xqzwv', 'cote d iv', 'phillipines'];
    const timings = [];
    for (let i = 0; i < 200; i += 1) {
      const start = performance.now();
      filterSuggestions(queries[i % queries.length], names);
      timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    const median = timings[timings.length / 2];
    assert.ok(median < 25, `median ${median.toFixed(2)} ms per call`);
  });

  it('rejects bad arguments', () => {
    assert.throws(() => filterSuggestions(null, names), { name: 'TypeError', message: /`query`/ });
    assert.throws(() => filterSuggestions('a', 'x'), { name: 'TypeError', message: /`countries`/ });
    assert.throws(
      () => filterSuggestions('a', [{ code: 'fr' }]),
      { name: 'TypeError', message: /`countries\[0\]\.name`/ }
    );
    assert.throws(
      () => filterSuggestions('a', [{ code: 'fr', name: 'France', aliases: 'Gaul' }]),
      { name: 'TypeError', message: /`countries\[0\]\.aliases`/ }
    );
    for (const options of [null, 'x', [8]]) {
      assert.throws(() => filterSuggestions('a', names, options), { name: 'TypeError', message: /`options`/ });
    }
    for (const limit of [0, -1, 1.5, '3']) {
      assert.throws(() => filterSuggestions('a', names, { limit }), { name: 'RangeError', message: /`limit`/ });
    }
  });
});
