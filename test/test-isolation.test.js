import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createTestPass, getScopeCodes, isPassComplete, recordTestAnswer, scorePass } from '../js/test-pass.js';
import { SRS_STORAGE_KEY, MODE_STORAGE_KEY, loadStates, saveMode, saveStates } from '../js/storage.js';
import { recordAnswer as recordPracticeAnswer } from '../js/practice-round.js';

// Test mode must never write SRS state (PLAN decision 13). Two guards:
// behaviour (a full pass leaves storage byte-identical and makes no storage
// call) and source (the test-mode modules reference no storage function).

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const countries = JSON.parse(read('data/countries.json')).countries;

// A fake `localStorage` that records every call.
function makeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  const calls = [];
  return {
    calls,
    getItem(key) { calls.push(['getItem', key]); return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { calls.push(['setItem', key]); data.set(key, String(value)); },
    removeItem(key) { calls.push(['removeItem', key]); data.delete(key); },
    snapshot() { return JSON.stringify([...data.entries()].sort(([a], [b]) => (a < b ? -1 : 1))); }
  };
}

const TODAY = '2026-11-12';

// Real-looking progress: some cards seen, some due, one mature.
function seedStates() {
  const states = {};
  for (const [i, code] of ['fr', 'de', 'ke', 'jp'].entries()) {
    states[code] = {
      code,
      repetitions: i + 1,
      easeFactor: 2.5,
      intervalDays: i === 3 ? 30 : i + 1,
      dueDate: '2026-11-13',
      lapses: i % 2
    };
  }
  return states;
}

describe('a full test pass leaves storage untouched', () => {
  for (const filter of [
    { continent: null, subregion: null },
    { continent: 'africa', subregion: null },
    { continent: 'europe', subregion: 'western-europe' }
  ]) {
    it(`byte-identical and no writes for scope ${JSON.stringify(filter)}`, () => {
      const storage = makeStorage();
      saveStates(seedStates(), storage);
      saveMode('typing', storage);
      const before = storage.snapshot();
      const callsBefore = storage.calls.length;
      assert.ok(before.includes(SRS_STORAGE_KEY) && before.includes(MODE_STORAGE_KEY));

      // The whole pass, half right and half wrong, then the score.
      let pass = createTestPass({ countries, filter, rng: Math.random });
      pass.codes.forEach((code, i) => {
        pass = recordTestAnswer(pass, i % 2 === 0 ? code : getScopeCodes({ countries, filter: { continent: null, subregion: null } })[0]);
      });
      assert.equal(isPassComplete(pass), true);
      const score = scorePass(pass, countries);
      assert.equal(score.total, pass.codes.length);

      assert.equal(storage.snapshot(), before);
      assert.equal(storage.calls.length, callsBefore, 'the pass made a storage call');
      // And the states still read back unchanged.
      assert.deepEqual(loadStates(TODAY, storage), seedStates());
    });
  }

  it('sanity check: the practice write path does change what a state map holds', () => {
    // Guards the guard: if this stopped changing anything, "byte-identical"
    // above would prove nothing.
    const states = seedStates();
    const result = recordPracticeAnswer({ states, code: 'it', correct: true, today: TODAY });
    assert.notEqual(JSON.stringify(result.states), JSON.stringify(states));
  });
});

describe('test mode source calls no storage function', () => {
  const FILES = ['js/test-pass.js', 'js/test-map.js', 'js/data.js', 'js/views/test.js', 'js/views/results.js'];
  const FORBIDDEN = [
    /\blocalStorage\b/,
    /\bsessionStorage\b/,
    /\bsetItem\b/,
    /\bremoveItem\b/,
    /\bsaveStates\b/,
    /\bloadStates\b/,
    /\bsaveMode\b/,
    /\bpersistAnswer\b/,
    /\brecordAnswer\b/,
    /\bupdateCardState\b/,
    /\bcreateCardState\b/,
    /from '\.\.?\/storage\.js'/,
    /from '\.\.?\/practice-round\.js'/
  ];
  for (const file of FILES) {
    it(`${file} has no storage or SRS write references`, () => {
      // Strip comments first: they may name these functions to say they are not used.
      const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const pattern of FORBIDDEN) {
        assert.ok(!pattern.test(code), `${file} matches ${pattern}`);
      }
    });
  }
});
