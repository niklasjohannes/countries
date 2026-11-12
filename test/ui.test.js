import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONTINENTS, SUBREGIONS } from '../js/srs.js';
import { QUIZ_MODES } from '../js/storage.js';
import { MODE_LABELS, SUBREGION_LABELS, formatSubregion, getSubregionChoices } from '../js/ui.js';

describe('getSubregionChoices', () => {
  it('offers none for South America (a single sub-region)', () => {
    assert.deepEqual(getSubregionChoices('south-america'), []);
  });

  it('offers every sub-region of the other continents', () => {
    for (const continent of CONTINENTS.filter((c) => c !== 'south-america')) {
      const expected = Object.keys(SUBREGIONS).filter((key) => SUBREGIONS[key] === continent);
      assert.deepEqual(getSubregionChoices(continent), expected);
    }
  });

  it('rejects an unknown continent', () => {
    assert.throws(() => getSubregionChoices('atlantis'), RangeError);
  });
});

describe('labels', () => {
  it('has a `SUBREGION_LABELS` entry for exactly the 22 sub-regions', () => {
    assert.equal(Object.keys(SUBREGIONS).length, 22);
    assert.deepEqual(Object.keys(SUBREGION_LABELS).sort(), Object.keys(SUBREGIONS).sort());
  });

  it('has a `MODE_LABELS` entry for exactly the `QUIZ_MODES`', () => {
    assert.deepEqual(Object.keys(MODE_LABELS).sort(), [...QUIZ_MODES].sort());
  });
});

describe('formatSubregion', () => {
  it('uses the M49 names', () => {
    assert.equal(formatSubregion('south-eastern-asia'), 'South-eastern Asia');
    assert.equal(formatSubregion('western-africa'), 'Western Africa');
    assert.equal(formatSubregion('australia-and-new-zealand'), 'Australia and New Zealand');
  });

  it('rejects an unknown sub-region', () => {
    assert.throws(() => formatSubregion('nowhere'), RangeError);
  });
});
