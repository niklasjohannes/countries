import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DIRECTION_MAP_TO_NAME,
  DIRECTION_NAME_TO_TAP,
  MATURE_INTERVAL_DAYS,
  isMature,
  TAP_CARD_SHARE,
  pickDirection,
  pickFrame,
} from '../js/cards.js';
import { createCardState } from '../js/srs.js';
import { createRng } from '../test-support/rng.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const meta = JSON.parse(readFileSync(join(FIXTURES, 'map-meta-southern-africa.json'), 'utf8'));

const SOUTH_AFRICA = { code: 'za', continent: 'africa', subregion: 'southern-africa' };

function withInterval(intervalDays) {
  return { ...createCardState('za'), intervalDays };
}

describe('pickDirection', () => {
  const tappable = meta.entries.za;
  const small = meta.entries.km;

  it('splits tappable entries at `TAP_CARD_SHARE`', () => {
    assert.equal(pickDirection(tappable, () => 0), DIRECTION_NAME_TO_TAP);
    assert.equal(pickDirection(tappable, () => TAP_CARD_SHARE - 1e-9), DIRECTION_NAME_TO_TAP);
    assert.equal(pickDirection(tappable, () => TAP_CARD_SHARE), DIRECTION_MAP_TO_NAME);
    assert.equal(pickDirection(tappable, () => 0.999), DIRECTION_MAP_TO_NAME);
  });

  it('gives roughly `TAP_CARD_SHARE` tap cards over many draws', () => {
    const rng = createRng(7);
    const draws = 10_000;
    let nTap = 0;
    for (let i = 0; i < draws; i += 1) {
      nTap += pickDirection(tappable, rng) === DIRECTION_NAME_TO_TAP ? 1 : 0;
    }
    assert.ok(Math.abs(nTap / draws - TAP_CARD_SHARE) < 0.02, String(nTap / draws));
  });

  it('never makes a small entry a tap card, and does not consume `rng` for it', () => {
    let nCalls = 0;
    const rng = () => {
      nCalls += 1;
      return 0;
    };
    assert.equal(small.small, true);
    for (let i = 0; i < 100; i += 1) {
      assert.equal(pickDirection(small, rng), DIRECTION_MAP_TO_NAME);
    }
    assert.equal(pickDirection({ tappable: false }, rng), DIRECTION_MAP_TO_NAME);
    assert.equal(nCalls, 0);
  });

  it('is deterministic for a given `rng`', () => {
    const codes = Object.keys(meta.entries);
    const run = () => {
      const rng = createRng(42);
      return Array.from({ length: 50 }, (_, i) => pickDirection(meta.entries[codes[i % codes.length]], rng));
    };
    const first = run();
    assert.deepEqual(run(), first);
    assert.ok(first.includes(DIRECTION_NAME_TO_TAP) && first.includes(DIRECTION_MAP_TO_NAME));
  });

  it('validates its inputs', () => {
    assert.throws(() => pickDirection(null, () => 0), /`entry`/);
    assert.throws(() => pickDirection({ small: false }, () => 0), /`entry.tappable`/);
    assert.throws(() => pickDirection({ small: 'no', tappable: true }, () => 0), /`entry.small`/);
    assert.throws(() => pickDirection({ small: true, tappable: true }, () => 0), /`entry.small`/);
    assert.throws(() => pickDirection({ small: false, tappable: false }, () => 0), /`entry.small`/);
    assert.throws(() => pickDirection(tappable, 0.5), /`rng`/);
    for (const draw of [1, -0.1, NaN, '0.5']) {
      assert.throws(() => pickDirection(tappable, () => draw), RangeError, String(draw));
    }
  });
});

describe('pickFrame', () => {
  const MAP = DIRECTION_MAP_TO_NAME;
  const TAP = DIRECTION_NAME_TO_TAP;

  it('switches a map → name card from sub-region to continent at exactly `MATURE_INTERVAL_DAYS`', () => {
    assert.equal(MATURE_INTERVAL_DAYS, 21);
    assert.equal(pickFrame(withInterval(20), SOUTH_AFRICA, MAP), 'southern-africa');
    assert.equal(pickFrame(withInterval(21), SOUTH_AFRICA, MAP), 'africa');
    assert.equal(pickFrame(withInterval(365), SOUTH_AFRICA, MAP), 'africa');
  });

  it('keeps a name → tap card on the sub-region however mature', () => {
    for (const intervalDays of [0, 20, 21, 365]) {
      assert.equal(pickFrame(withInterval(intervalDays), SOUTH_AFRICA, TAP), 'southern-africa', String(intervalDays));
    }
    assert.equal(pickFrame(null, SOUTH_AFRICA, TAP), 'southern-africa');
  });

  it('frames new and unseen cards on the sub-region', () => {
    assert.equal(pickFrame(createCardState('za'), SOUTH_AFRICA, MAP), 'southern-africa');
    assert.equal(pickFrame(null, SOUTH_AFRICA, MAP), 'southern-africa');
  });

  it('returns a key into map-meta `frames`', () => {
    for (const direction of [MAP, TAP]) {
      for (const intervalDays of [0, 20, 21]) {
        assert.ok(Object.hasOwn(meta.frames, pickFrame(withInterval(intervalDays), SOUTH_AFRICA, direction)));
      }
    }
  });

  it('validates its inputs', () => {
    assert.throws(() => pickFrame(undefined, SOUTH_AFRICA, MAP), /`state`/);
    assert.throws(() => pickFrame(withInterval(-1), SOUTH_AFRICA, MAP), /`state.intervalDays`/);
    assert.throws(() => pickFrame(withInterval(2.5), SOUTH_AFRICA, MAP), /`state.intervalDays`/);
    assert.throws(() => pickFrame(null, null, MAP), /`entry`/);
    assert.throws(() => pickFrame(null, { continent: 'africa', subregion: 'atlantis' }, MAP), /`entry.subregion`/);
    assert.throws(() => pickFrame(null, { continent: 'europe', subregion: 'southern-africa' }, MAP), /`entry.continent`/);
    for (const direction of [undefined, 'tap', true]) {
      assert.throws(() => pickFrame(null, SOUTH_AFRICA, direction), /`direction`/);
    }
  });
});

describe('isMature', () => {
  it('is false for an unseen card and flips at exactly `MATURE_INTERVAL_DAYS`', () => {
    assert.equal(isMature(null), false);
    assert.equal(isMature({ intervalDays: MATURE_INTERVAL_DAYS - 1 }), false);
    assert.equal(isMature({ intervalDays: MATURE_INTERVAL_DAYS }), true);
  });

  it('rejects a malformed state', () => {
    assert.throws(() => isMature({ intervalDays: -1 }), TypeError);
    assert.throws(() => isMature('x'), TypeError);
  });
});
