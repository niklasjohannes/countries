import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RESUME_RESET_MS, isStaleResume } from '../js/resume.js';

const base = { hiddenAt: 1_000_000, resumedAt: 1_000_000, shownOn: '2026-11-12', resumedOn: '2026-11-12' };

describe('isStaleResume', () => {
  it('is false after a short absence on the same day', () => {
    assert.equal(isStaleResume({ ...base, resumedAt: base.hiddenAt + RESUME_RESET_MS - 1 }), false);
  });

  it('is true after `RESUME_RESET_MS` away', () => {
    assert.equal(isStaleResume({ ...base, resumedAt: base.hiddenAt + RESUME_RESET_MS }), true);
  });

  it('is true when the local date changed', () => {
    assert.equal(isStaleResume({ ...base, resumedOn: '2026-11-13' }), true);
  });

  it('rejects bad arguments', () => {
    assert.throws(() => isStaleResume({ ...base, hiddenAt: NaN }), TypeError);
    assert.throws(() => isStaleResume({ ...base, shownOn: 'today' }), TypeError);
  });
});
