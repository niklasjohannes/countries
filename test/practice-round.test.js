import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DIRECTION_MAP_TO_NAME,
  DIRECTION_NAME_TO_TAP,
  MATURE_INTERVAL_DAYS,
} from '../js/cards.js';
import { FRAME_LEVEL_CONTINENT, FRAME_LEVEL_SUBREGION } from '../js/map-view.js';
import {
  ANSWER_MODE_TAP,
  HIT_ADVANCE_MS,
  answerCurrent,
  createRound,
  getCurrentCode,
  getFeedbackPlan,
  getMissed,
  getProgress,
  getScore,
  isReask,
  isRoundComplete,
  persistAnswer,
  planCard,
} from '../js/practice-round.js';
import { REQUEUE_GAP, ROUND_SIZE, createCardState, pickRound } from '../js/srs.js';
import { loadStates, SRS_STORAGE_KEY } from '../js/storage.js';
import { createRng } from '../test-support/rng.js';

// ---- Fixtures ----

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => JSON.parse(readFileSync(join(ROOT, ...parts), 'utf8'));
const countries = read('data', 'countries.json').countries;
const meta = read('data', 'map-meta.json');
const TODAY = '2026-11-12';

// In-memory `Storage`, so the SRS writes can be read back.
function createStorage() {
  const items = new Map();
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
  };
}

const seenState = (code, intervalDays, dueDate = TODAY) => ({
  ...createCardState(code),
  repetitions: 3,
  intervalDays,
  dueDate,
});

const plan = (code, state, mode, rng) => planCard({ code, state, countries, meta, mode, rng });

// ---- Round state ----

describe('round state', () => {
  it('asks cards in order and ends when the queue is empty', () => {
    let round = createRound(['md', 'ro']);
    assert.equal(getCurrentCode(round), 'md');
    round = answerCurrent(round, true).round;
    assert.equal(getCurrentCode(round), 'ro');
    round = answerCurrent(round, true).round;
    assert.equal(isRoundComplete(round), true);
    assert.deepEqual(getScore(round), { correct: 2, total: 2, percent: 100 });
  });

  it('re-queues a first-answer miss REQUEUE_GAP questions later, once', () => {
    const codes = ['a1', 'a2', 'a3', 'a4', 'a5'];
    let step = answerCurrent(createRound(codes), false);
    assert.equal(step.isFirstAnswer, true);
    assert.equal(REQUEUE_GAP, 3);
    assert.deepEqual(step.round.queue, ['a2', 'a3', 'a4', 'a1', 'a5']);
    // Re-ask: missed again, not re-queued, not scored.
    let round = step.round;
    while (getCurrentCode(round) !== 'a1') {
      round = answerCurrent(round, true).round;
    }
    assert.equal(isReask(round), true);
    step = answerCurrent(round, false);
    assert.equal(step.isFirstAnswer, false);
    assert.equal(step.round.queue.includes('a1'), false);
    assert.equal(step.round.results.a1, false);
  });

  it('does not advance progress on a re-ask', () => {
    let round = createRound(['a1', 'a2']);
    round = answerCurrent(round, false).round; // a1 missed -> [a2, a1]
    round = answerCurrent(round, true).round; // a2
    assert.equal(isReask(round), true);
    assert.deepEqual(getProgress(round), { position: 2, total: 2 });
  });
});

// ---- Card plan ----

describe('planCard', () => {
  it('a seeded round includes both directions, in both answer modes', () => {
    for (const mode of ['mc', 'typing']) {
      const rng = createRng(2026);
      const codes = pickRound({ states: {}, countries, today: TODAY, rng, n: 40 });
      const plans = codes.map((code) => plan(code, null, mode, rng));
      const directions = new Set(plans.map((item) => item.direction));
      assert.deepEqual(directions, new Set([DIRECTION_MAP_TO_NAME, DIRECTION_NAME_TO_TAP]));
      for (const item of plans) {
        assert.equal(
          item.answerMode,
          item.direction === DIRECTION_NAME_TO_TAP ? ANSWER_MODE_TAP : mode,
        );
      }
      const mapShare = plans.filter((item) => item.direction === DIRECTION_MAP_TO_NAME).length / plans.length;
      assert.ok(mapShare > 0.5, `map → name is the primary card (got ${mapShare})`);
    }
  });

  it('is deterministic for a given seed', () => {
    const run = () => {
      const rng = createRng(7);
      return ['md', 'fr', 'br', 'ke'].map((code) => plan(code, null, 'mc', rng));
    };
    assert.deepEqual(run(), run());
  });

  it('never makes a small entry a tap card', () => {
    const small = Object.keys(meta.entries).filter((code) => meta.entries[code].small);
    assert.ok(small.length > 0);
    const rng = createRng(1);
    for (let i = 0; i < 20; i += 1) {
      for (const code of small) {
        assert.equal(plan(code, null, 'mc', rng).direction, DIRECTION_MAP_TO_NAME);
      }
    }
  });

  it('frames a young card on its sub-region and a mature one on its continent', () => {
    // Always map → name: `rng` returns above TAP_CARD_SHARE.
    const rng = () => 0.99;
    const young = plan('md', seenState('md', MATURE_INTERVAL_DAYS - 1), 'mc', rng);
    assert.equal(young.frameKey, 'eastern-europe');
    assert.equal(young.frameLevel, FRAME_LEVEL_SUBREGION);
    assert.deepEqual(young.frame, meta.frames['eastern-europe']);

    const mature = plan('md', seenState('md', MATURE_INTERVAL_DAYS), 'mc', rng);
    assert.equal(mature.frameKey, 'europe');
    assert.equal(mature.frameLevel, FRAME_LEVEL_CONTINENT);
    assert.deepEqual(mature.frame, meta.frames.europe);
  });

  it('keeps a mature name → tap card on the sub-region frame', () => {
    const tap = plan('md', seenState('md', 100), 'mc', () => 0);
    assert.equal(tap.direction, DIRECTION_NAME_TO_TAP);
    assert.equal(tap.frameKey, 'eastern-europe');
    assert.equal(tap.frameLevel, FRAME_LEVEL_SUBREGION);
  });

  it('decides the level of `south-america` (continent and sub-region) itself', () => {
    const young = plan('br', null, 'mc', () => 0.99);
    const mature = plan('br', seenState('br', 30), 'mc', () => 0.99);
    const tap = plan('br', seenState('br', 30), 'mc', () => 0);
    assert.equal(young.frameKey, 'south-america');
    assert.equal(young.frameLevel, FRAME_LEVEL_SUBREGION);
    assert.equal(mature.frameKey, 'south-america');
    assert.equal(mature.frameLevel, FRAME_LEVEL_CONTINENT);
    assert.equal(tap.frameLevel, FRAME_LEVEL_SUBREGION);
  });

  it('passes the neighbours on for the MC distractors', () => {
    assert.deepEqual([...plan('md', null, 'mc', () => 0.99).neighbours], meta.entries.md.neighbours);
  });

  it('rejects bad input', () => {
    assert.throws(() => plan('zz', null, 'mc', () => 0.5), RangeError);
    assert.throws(() => plan('md', null, 'tap', () => 0.5), RangeError);
    assert.throws(() => plan('md', null, 'mc', 'nope'), TypeError);
  });
});

// ---- Feedback ----

describe('getMissed', () => {
  it('lists first-answer misses in asked order, ignoring hits and re-asks', () => {
    let round = createRound(['aa', 'bb', 'cc']);
    round = answerCurrent(round, false).round; // aa missed, re-queued
    round = answerCurrent(round, true).round; // bb
    round = answerCurrent(round, false).round; // cc missed
    assert.deepEqual(getMissed(round), ['aa', 'cc']);
    round = answerCurrent(round, true).round; // aa re-ask: the miss stays
    assert.deepEqual(getMissed(round), ['aa', 'cc']);
  });

  it('is empty before any answer and rejects a non-round', () => {
    assert.deepEqual(getMissed(createRound(['aa'])), []);
    assert.throws(() => getMissed({}));
  });
});

describe('getFeedbackPlan', () => {
  it('advances a hit by itself, without labels', () => {
    assert.deepEqual(getFeedbackPlan(true), { advance: 'auto', advanceMs: HIT_ADVANCE_MS });
  });

  it('makes a miss wait for Next', () => {
    assert.deepEqual(getFeedbackPlan(false), { advance: 'next', advanceMs: null });
  });

  it('rejects a non-boolean', () => {
    assert.throws(() => getFeedbackPlan('yes'), TypeError);
  });
});

// ---- SRS writes ----

describe('persistAnswer', () => {
  it('writes a new card on its first answer', () => {
    const storage = createStorage();
    const { changed, states } = persistAnswer({ code: 'md', correct: true, today: TODAY, storage });
    assert.equal(changed, true);
    assert.deepEqual(states, loadStates(TODAY, storage));
    const saved = loadStates(TODAY, storage);
    assert.equal(saved.md.repetitions, 1);
    assert.equal(saved.md.intervalDays, 1);
    assert.equal(saved.md.lapses, 0);
  });

  it('records a miss as a lapse', () => {
    const storage = createStorage();
    persistAnswer({ code: 'md', correct: false, today: TODAY, storage });
    assert.equal(loadStates(TODAY, storage).md.lapses, 1);
  });

  it('writes at most once per code per visit', () => {
    const storage = createStorage();
    const first = persistAnswer({ code: 'md', correct: true, today: TODAY, storage });
    const raw = storage.getItem(SRS_STORAGE_KEY);
    const second = persistAnswer({
      code: 'md',
      correct: false,
      today: TODAY,
      persistedCodes: first.persistedCodes,
      storage,
    });
    assert.equal(second.changed, false);
    assert.equal(storage.getItem(SRS_STORAGE_KEY), raw);
  });

  it('keeps the state of a not-yet-due card answered correctly (early review)', () => {
    const storage = createStorage();
    storage.setItem(SRS_STORAGE_KEY, JSON.stringify({ md: seenState('md', 6, '2026-11-18') }));
    const { changed } = persistAnswer({ code: 'md', correct: true, today: TODAY, storage });
    assert.equal(changed, false);
    assert.equal(loadStates(TODAY, storage).md.intervalDays, 6);
  });

  it('still lapses a not-yet-due card that is missed', () => {
    const storage = createStorage();
    storage.setItem(SRS_STORAGE_KEY, JSON.stringify({ md: seenState('md', 6, '2026-11-18') }));
    assert.equal(persistAnswer({ code: 'md', correct: false, today: TODAY, storage }).changed, true);
    assert.equal(loadStates(TODAY, storage).md.lapses, 1);
  });
});

// ---- A whole round, as the view drives it ----

describe('a full round', () => {
  it('scores first answers, persists each country once, never persists a re-ask', () => {
    const storage = createStorage();
    const rng = createRng(11);
    const codes = pickRound({ states: {}, countries, today: TODAY, rng, n: ROUND_SIZE });
    let round = createRound(codes);
    let persistedCodes = new Set();
    const missed = new Set(codes.slice(0, 3));
    const writes = [];
    let asked = 0;
    while (!isRoundComplete(round)) {
      const code = getCurrentCode(round);
      const state = loadStates(TODAY, storage)[code] ?? null;
      plan(code, state, asked % 2 === 0 ? 'mc' : 'typing', rng);
      // Missed countries are missed on every ask, including the re-ask.
      const result = answerCurrent(round, !missed.has(code));
      if (result.isFirstAnswer) {
        const saved = persistAnswer({ code, correct: !missed.has(code), today: TODAY, persistedCodes, storage });
        persistedCodes = saved.persistedCodes;
        writes.push(code);
      }
      round = result.round;
      asked += 1;
    }
    assert.equal(asked, ROUND_SIZE + missed.size);
    assert.deepEqual(writes.sort(), [...codes].sort());
    assert.deepEqual(getScore(round), { correct: ROUND_SIZE - 3, total: ROUND_SIZE, percent: 70 });
    const saved = loadStates(TODAY, storage);
    for (const code of codes) {
      assert.equal(saved[code].lapses, missed.has(code) ? 1 : 0, code);
    }
  });
});
