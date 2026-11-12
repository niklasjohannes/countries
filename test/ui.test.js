import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONTINENTS, SUBREGIONS } from '../js/srs.js';
import { formatSubregion, getSubregionChoices } from '../js/ui.js';

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

describe('formatSubregion', () => {
  it('title-cases slugs and keeps "and" lowercase', () => {
    assert.equal(formatSubregion('western-africa'), 'Western Africa');
    assert.equal(formatSubregion('australia-and-new-zealand'), 'Australia and New Zealand');
  });

  it('rejects an unknown sub-region', () => {
    assert.throws(() => formatSubregion('nowhere'), RangeError);
  });
});
