import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createTestPass,
  formatScore,
  getScopeCodes,
  isPassComplete,
  recordTestAnswer,
  scorePass
} from '../js/test-pass.js';

const countries = JSON.parse(readFileSync(new URL('../data/countries.json', import.meta.url), 'utf8')).countries;
const ALL = { continent: null, subregion: null };

// Deterministic rng: a simple LCG in [0, 1).
function makeRng(seed = 1) {
  let value = seed;
  return () => {
    value = (value * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return value / 4_294_967_296;
  };
}

const small = [
  { code: 'aa', name: 'Aland', continent: 'europe', subregion: 'northern-europe', quizzed: true },
  { code: 'bb', name: 'Bland', continent: 'europe', subregion: 'western-europe', quizzed: true },
  { code: 'cc', name: 'Cland', continent: 'asia', subregion: 'central-asia', quizzed: true },
  { code: 'dd', name: 'Dland', continent: 'asia', subregion: 'central-asia', quizzed: false }
];

describe('getScopeCodes', () => {
  it('returns only quizzed entries, in data order', () => {
    assert.deepEqual(getScopeCodes({ countries: small, filter: ALL }), ['aa', 'bb', 'cc']);
  });

  it('filters by continent and sub-region', () => {
    assert.deepEqual(getScopeCodes({ countries: small, filter: { continent: 'europe' } }), ['aa', 'bb']);
    assert.deepEqual(getScopeCodes({ countries: small, filter: { continent: 'europe', subregion: 'western-europe' } }), ['bb']);
    assert.deepEqual(getScopeCodes({ countries: small, filter: { subregion: 'central-asia' } }), ['cc']);
  });

  it('matches the real data: 206 quizzed entries, each once', () => {
    const codes = getScopeCodes({ countries, filter: ALL });
    assert.equal(codes.length, 206);
    assert.equal(new Set(codes).size, 206);
  });

  it('validates input', () => {
    assert.throws(() => getScopeCodes({ countries: 'x', filter: ALL }), /`countries`/);
    assert.throws(() => getScopeCodes({ countries: small, filter: null }), /`filter`/);
    assert.throws(() => getScopeCodes({ countries: small, filter: { continent: 'atlantis' } }), /`filter.continent`/);
    assert.throws(() => getScopeCodes({ countries: small, filter: { subregion: 'nowhere' } }), /`filter.subregion`/);
    assert.throws(() => getScopeCodes({ countries: small, filter: { continent: 'asia', subregion: 'western-europe' } }), /belong/);
  });
});

describe('createTestPass', () => {
  it('asks every entry in scope exactly once, shuffled, with no answers yet', () => {
    const pass = createTestPass({ countries, filter: ALL, rng: makeRng() });
    assert.equal(pass.codes.length, 206);
    assert.deepEqual([...pass.codes].sort(), [...getScopeCodes({ countries, filter: ALL })].sort());
    assert.notDeepEqual([...pass.codes], getScopeCodes({ countries, filter: ALL }));
    assert.deepEqual([...pass.answers], []);
    assert.equal(isPassComplete(pass), false);
    assert.deepEqual({ ...pass.filter }, ALL);
  });

  it('is deterministic for a given rng and frozen', () => {
    const a = createTestPass({ countries, filter: { continent: 'africa' }, rng: makeRng(7) });
    const b = createTestPass({ countries, filter: { continent: 'africa' }, rng: makeRng(7) });
    assert.deepEqual([...a.codes], [...b.codes]);
    assert.ok(Object.isFrozen(a) && Object.isFrozen(a.codes) && Object.isFrozen(a.answers) && Object.isFrozen(a.filter));
  });

  it('rejects an empty scope, a bad rng and an rng out of range', () => {
    assert.throws(() => createTestPass({ countries: [], filter: ALL, rng: makeRng() }), /at least one/);
    assert.throws(() => createTestPass({ countries, filter: ALL }), /`rng`/);
    assert.throws(() => createTestPass({ countries, filter: ALL, rng: () => 1 }), /\[0, 1\)/);
  });
});

describe('recordTestAnswer and scorePass', () => {
  const start = () => createTestPass({ countries: small, filter: ALL, rng: makeRng(3) });

  it('records answers without mutating the earlier pass', () => {
    const pass = start();
    const next = recordTestAnswer(pass, 'aa');
    assert.deepEqual([...pass.answers], []);
    assert.deepEqual([...next.answers], ['aa']);
  });

  it('completes after one answer per entry and refuses more', () => {
    let pass = start();
    for (const code of pass.codes) {
      pass = recordTestAnswer(pass, code);
    }
    assert.equal(isPassComplete(pass), true);
    assert.throws(() => recordTestAnswer(pass, 'aa'), /already complete/);
  });

  it('scores a perfect pass', () => {
    let pass = start();
    for (const code of pass.codes) {
      pass = recordTestAnswer(pass, code);
    }
    const score = scorePass(pass, small);
    assert.deepEqual({ ...score, missed: [...score.missed] }, { total: 3, correct: 3, percent: 100, missed: [] });
    assert.equal(formatScore(score), '3/3 · 100%');
  });

  it('lists misses in asking order with the chosen name, and rounds the percent down', () => {
    let pass = start();
    // Answer every entry wrongly except the first asked.
    pass.codes.forEach((code, i) => {
      pass = recordTestAnswer(pass, i === 0 ? code : small.find((c) => c.code !== code).code);
    });
    const score = scorePass(pass, small);
    assert.equal(score.correct, 1);
    assert.equal(score.percent, 33);
    assert.deepEqual(score.missed.map((m) => m.code), pass.codes.slice(1));
    assert.ok(score.missed.every((m) => m.chosenCode !== m.code && typeof m.chosenName === 'string'));
  });

  it('refuses an incomplete pass and unknown codes', () => {
    const pass = start();
    assert.throws(() => scorePass(pass, small), /complete/);
    let done = pass;
    for (const code of pass.codes) {
      done = recordTestAnswer(done, 'zz');
    }
    assert.throws(() => scorePass(done, small), /not in `countries`/);
  });

  it('validates arguments', () => {
    const pass = start();
    assert.throws(() => recordTestAnswer(pass, ''), /`chosenCode`/);
    assert.throws(() => recordTestAnswer({}, 'aa'), /`pass`/);
    assert.throws(() => formatScore({ correct: 5, total: 3, percent: 100 }), /`score`/);
  });
});
