import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createTestPass, isPassComplete, recordTestAnswer, scorePass } from '../js/test-pass.js';
import { SRS_STORAGE_KEY, MODE_STORAGE_KEY, loadStates, saveMode, saveStates } from '../js/storage.js';
import { recordAnswer as recordPracticeAnswer } from '../js/practice-round.js';

// Test mode must never write SRS state (PLAN decision 13). Two guards:
// behaviour (a full pass, with the modules it imports, leaves a recording
// `globalThis.localStorage` byte-identical and makes no storage call) and source (the test-mode modules reference no storage function).

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

// Runs `fn` with `fake` installed as `globalThis.localStorage`, then restores
// whatever was there. `storage.js` falls back to `globalThis.localStorage`, so
// any call that forgets to pass storage explicitly lands on the fake.
async function withGlobalStorage(fake, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (descriptor === undefined) {
      delete globalThis.localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', descriptor);
    }
  }
}

describe('a full test pass leaves storage untouched', () => {
  for (const filter of [
    { continent: null, subregion: null },
    { continent: 'africa', subregion: null },
    { continent: 'europe', subregion: 'western-europe' }
  ]) {
    it(`byte-identical and no storage calls for scope ${JSON.stringify(filter)}`, async () => {
      const storage = makeStorage();
      saveStates(seedStates(), storage);
      saveMode('typing', storage);
      const before = storage.snapshot();
      assert.ok(before.includes(SRS_STORAGE_KEY) && before.includes(MODE_STORAGE_KEY));
      storage.calls.length = 0;

      await withGlobalStorage(storage, async () => {
        // Import every module a test pass loads, fresh, so any storage use at
        // import time or in a function would hit the recording fake.
        const query = `?isolation=${Math.random()}`;
        const pass = await import(`../js/test-pass.js${query}`);
        await import(`../js/test-map.js${query}`);
        await import(`../js/question.js${query}`);
        await import(`../js/quiz.js${query}`);

        let current = pass.createTestPass({ countries, filter, rng: Math.random });
        current.codes.forEach((code, i) => {
          current = pass.recordTestAnswer(current, i % 2 === 0 ? code : 'fr');
        });
        assert.equal(pass.isPassComplete(current), true);
        assert.equal(pass.scorePass(current, countries).total, current.codes.length);
      });

      assert.deepEqual(storage.calls, [], 'the pass made a storage call');
      assert.equal(storage.snapshot(), before);
      assert.deepEqual(loadStates(TODAY, storage), seedStates());
    });
  }

  it('sanity check: the recording fake catches a write through the global', async () => {
    // Guards the guard: if a write could slip past the fake, the tests above
    // would prove nothing.
    const storage = makeStorage();
    const before = storage.snapshot();
    await withGlobalStorage(storage, () => {
      saveStates(seedStates());
      saveMode('typing');
    });
    assert.notEqual(storage.snapshot(), before);
    assert.ok(storage.calls.some(([method]) => method === 'setItem'));
  });

  it('sanity check: the practice write path does change what a state map holds', () => {
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
