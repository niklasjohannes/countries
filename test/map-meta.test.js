import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import {
  FRAME_PADDING,
  SMALL_LIMIT_PX,
  SMALL_VIEWPORT_PX,
  buildMapMeta,
  computeFrame,
  isSmall,
  largestRingBbox,
  projectLonLatBox
} from '../scripts/build-map-meta.js';
import { getPxPerUnit } from '../js/map.js';
import { FRAME_OVERRIDES } from '../scripts/frame-overrides.js';
import { escapeXml, pathOf } from '../scripts/render-contact-sheet.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');
const { meta, countries } = JSON.parse(read('data/countries.json'));
const mapMeta = JSON.parse(read('data/map-meta.json'));
const { frames, entries } = mapMeta;
const files = Object.fromEntries(meta.continents.map((c) => [c, JSON.parse(read(`data/geometry/${c}.json`))]));
const codes = countries.map((country) => country.code);

const inside = (point, box) => point[0] >= box[0] && point[0] <= box[2] && point[1] >= box[1] && point[1] <= box[3];

describe('map-meta regeneration', () => {
  it('is byte for byte what the generator produces', () => {
    const { text } = buildMapMeta(ROOT);
    assert.equal(read('data/map-meta.json'), text, 'data/map-meta.json is out of date: run `node scripts/build-map-meta.js`');
  });

  it('replaced data/geometry/neighbours.json', () => {
    assert.equal(existsSync(resolve(ROOT, 'data/geometry/neighbours.json')), false);
  });
});

describe('map-meta contract shape', () => {
  it('has exactly the keys `frames` and `entries`', () => {
    assert.deepEqual(Object.keys(mapMeta), ['frames', 'entries']);
  });

  it('has one frame per continent and sub-region (south-america is both)', () => {
    const expected = [...new Set([...meta.continents, ...Object.keys(meta.subregions)])].sort();
    assert.equal(expected.length, 27);
    assert.deepEqual(Object.keys(frames).sort(), expected);
    for (const [key, frame] of Object.entries(frames)) {
      assert.equal(frame.length, 4, key);
      assert.ok(frame.every(Number.isInteger), `${key} has non-integer coordinates`);
      assert.ok(frame[0] < frame[2] && frame[1] < frame[3], `${key} is empty`);
    }
  });

  it('has an entry for every country with exactly neighbours, small, tappable and smallInContinent', () => {
    assert.deepEqual(Object.keys(entries).sort(), [...codes].sort());
    for (const [code, entry] of Object.entries(entries)) {
      assert.deepEqual(Object.keys(entry), ['neighbours', 'small', 'tappable', 'smallInContinent'], code);
      assert.equal(typeof entry.smallInContinent, 'boolean', code);
      assert.ok(Array.isArray(entry.neighbours), code);
      assert.equal(typeof entry.small, 'boolean', code);
      assert.equal(typeof entry.tappable, 'boolean', code);
    }
  });

  it('has tappable === !small', () => {
    for (const [code, entry] of Object.entries(entries)) assert.equal(entry.tappable, !entry.small, code);
  });

  it('has symmetric, sorted, non-empty neighbours of known codes', () => {
    for (const [code, { neighbours }] of Object.entries(entries)) {
      assert.deepEqual(neighbours, [...new Set(neighbours)].sort(), code);
      assert.ok(neighbours.length > 0, `${code} has no neighbours`);
      assert.ok(!neighbours.includes(code), `${code} lists itself`);
      for (const other of neighbours) {
        assert.ok(entries[other], `${code} -> ${other} is not an entry`);
        assert.ok(entries[other].neighbours.includes(code), `${code} -> ${other} is one-way`);
      }
    }
  });

  it('keeps the spot-check neighbours of the geometry pipeline', () => {
    const { neighbours } = entries.fr;
    for (const other of ['es', 'be', 'de', 'it']) assert.ok(neighbours.includes(other), `fr -> ${other}`);
    assert.ok(!neighbours.includes('br'), 'French Guiana is split out of France');
    assert.ok(entries.lk.neighbours.includes('in'));
    assert.ok(entries.tw.neighbours.includes('cn'));
  });
});

describe('frames', () => {
  it('put every quizzed label point inside its sub-region frame and its continent frame', () => {
    for (const { code, continent, subregion, quizzed } of countries) {
      if (!quizzed) continue;
      const label = files[continent].entries[code].label;
      assert.ok(inside(label, frames[subregion]), `${code}: label outside the ${subregion} frame`);
      assert.ok(inside(label, frames[continent]), `${code}: label outside the ${continent} frame`);
    }
  });

  it('keep every sub-region frame within its continent frame, padded once more', () => {
    // A sub-region's box is part of the continent's box, so its padded frame
    // exceeds the continent frame by at most FRAME_PADDING of the continent
    // frame's longer side.
    for (const [subregion, continent] of Object.entries(meta.subregions)) {
      const outer = frames[continent];
      const slack = FRAME_PADDING * Math.max(outer[2] - outer[0], outer[3] - outer[1]);
      const frame = frames[subregion];
      assert.ok(frame[0] >= outer[0] - slack && frame[1] >= outer[1] - slack && frame[2] <= outer[2] + slack && frame[3] <= outer[3] + slack,
        `${subregion} leaves the ${continent} frame`);
    }
  });

  it('keep the padding on every side of every quizzed bbox', () => {
    for (const { code, continent, subregion, quizzed } of countries) {
      if (!quizzed) continue;
      const bbox = files[continent].entries[code].bbox;
      for (const key of new Set([continent, subregion])) {
        if (FRAME_OVERRIDES[key]?.clip?.[code]) continue;
        const frame = frames[key];
        const longer = Math.max(frame[2] - frame[0], frame[3] - frame[1]) / (1 + 2 * FRAME_PADDING);
        const pad = Math.floor(FRAME_PADDING * longer) - 1;
        assert.ok(bbox[0] - frame[0] >= pad && bbox[1] - frame[1] >= pad && frame[2] - bbox[2] >= pad && frame[3] - bbox[3] >= pad,
          `${code} is closer than the padding to the ${key} frame edge`);
      }
    }
  });

  it('contain the whole bbox of every quizzed entry, except where an override crops it', () => {
    for (const { code, continent, subregion, quizzed } of countries) {
      if (!quizzed) continue;
      const bbox = files[continent].entries[code].bbox;
      for (const key of new Set([continent, subregion])) {
        if (FRAME_OVERRIDES[key]?.clip?.[code]) continue;
        const frame = frames[key];
        assert.ok(bbox[0] >= frame[0] && bbox[1] >= frame[1] && bbox[2] <= frame[2] && bbox[3] <= frame[3], `${code} leaves ${key}`);
      }
    }
  });

  it('crop Europe around the Urals', () => {
    const russia = files.europe.entries.ru.bbox;
    assert.ok(frames.europe[2] < russia[2], 'the Europe frame follows Russia east');
    assert.ok(frames['eastern-europe'][2] < russia[2], 'the eastern-europe frame follows Russia east');
    assert.ok(frames['southern-europe'][3] < files.europe.entries.es.bbox[3], 'the Canary Islands stretch southern-europe');
  });

  it('have a one-line reason for every override', () => {
    assert.ok(Object.keys(FRAME_OVERRIDES).length > 0);
    for (const [key, override] of Object.entries(FRAME_OVERRIDES)) {
      assert.ok(frames[key], `${key} names no frame`);
      assert.equal(typeof override.reason, 'string', key);
      assert.ok(override.reason.length > 0 && !override.reason.includes('\n'), `${key} needs a one-line reason`);
    }
  });
});

describe('small entries', () => {
  // Independent of the generator: rebuilds the phone viewport from the contract numbers.
  const phoneSideOf = (code, continent, frame) => {
    const [x0, y0, x1, y1] = largestRingBbox(files[continent].entries[code].rings);
    const pxPerUnit = getPxPerUnit(frame, { width: 331, height: 400 });
    return [(x1 - x0) * pxPerUnit, (y1 - y0) * pxPerUnit];
  };

  it('follow the contract rule: largest ring at the sub-region frame on a phone viewport, under 12 x 12 px', () => {
    for (const { code, continent, subregion } of countries) {
      const [w, h] = phoneSideOf(code, continent, frames[subregion]);
      assert.equal(entries[code].small, w < 12 && h < 12, code);
    }
  });

  it('gives every non-small entry a ring of at least 12 px on a phone', () => {
    for (const { code, continent, subregion } of countries) {
      if (entries[code].small) continue;
      assert.ok(Math.max(...phoneSideOf(code, continent, frames[subregion])) >= 12, `${code} is tappable but renders as a speck`);
    }
  });

  it('includes microstates and islands, and not large or archipelago countries', () => {
    for (const code of ['va', 'mc', 'sm', 'li', 'mt', 'bh', 'sg', 'nr', 'tv', 'ps', 'ki', 'fm', 'mh', 'pw', 'to', 'pf', 'cv', 'st', 'km']) {
      assert.equal(entries[code].small, true, code);
      assert.equal(entries[code].tappable, false, code);
    }
    for (const code of ['fr', 'br', 'au', 'is', 'jp', 'cu', 'ru', 'nz']) assert.equal(entries[code].small, false, code);
  });

  it('are never tappable', () => {
    const small = Object.entries(entries).filter(([, entry]) => entry.small);
    assert.ok(small.length > 0);
    for (const [code, entry] of small) assert.equal(entry.tappable, false, code);
  });
});

describe('small entries in the continent frame', () => {
  it('follow the same rule at the continent frame', () => {
    for (const { code, continent } of countries) {
      const [x0, y0, x1, y1] = largestRingBbox(files[continent].entries[code].rings);
      const pxPerUnit = getPxPerUnit(frames[continent], { width: 331, height: 400 });
      const small = (x1 - x0) * pxPerUnit < 12 && (y1 - y0) * pxPerUnit < 12;
      assert.equal(entries[code].smallInContinent, small, code);
    }
  });

  it('include every small entry (a continent frame is wider) and more', () => {
    for (const [code, entry] of Object.entries(entries)) {
      if (entry.small) assert.equal(entry.smallInContinent, true, `${code} is small in its sub-region but not its continent`);
    }
    const n = (key) => Object.values(entries).filter((entry) => entry[key]).length;
    assert.ok(n('smallInContinent') > n('small'));
  });

  it('leave small and tappable as the sub-region rule defines them', () => {
    assert.equal(entries.mt.small, true);
    for (const [code, entry] of Object.entries(entries)) assert.equal(entry.tappable, !entry.small, code);
  });
});

describe('frame helpers', () => {
  const file = {
    projection: { name: 'laea', centre: [0, 0], origin: [-1000, 1000] },
    scale: 10,
    entries: {
      aa: { bbox: [100, 100, 300, 200] },
      bb: { bbox: [500, 400, 900, 800] },
      cc: { bbox: [0, 0, 1000, 1000] }
    }
  };

  it('pads the box of the quizzed entries by 4% of its longer side', () => {
    assert.deepEqual(computeFrame(file, ['aa', 'bb']), [100 - 32, 100 - 32, 900 + 32, 800 + 32]);
  });

  it('does not clamp the padded frame', () => {
    assert.deepEqual(computeFrame(file, ['cc']), [-40, -40, 1040, 1040]);
  });

  it('rejects bad input', () => {
    assert.throws(() => computeFrame(file, []), /`codes`/);
    assert.throws(() => computeFrame(file, ['zz']), /missing/);
    assert.throws(() => computeFrame(file, ['aa'], { bb: [0, 0, 1, 1] }), /not in this frame/);
    assert.throws(() => projectLonLatBox(file, [10, 0, 5, 1]), /west < east/);
    assert.throws(() => projectLonLatBox(file, [0, 0, 1]), /`box`/);
    assert.throws(() => isSmall([0, 0, 1, 1], [0, 0, 0, 5]), /positive width/);
    assert.throws(() => largestRingBbox([]), /non-empty/);
  });

  it('applies the 12 px rule on both sides and strictly', () => {
    const viewport = { width: 400, height: 400 };
    const frame = [0, 0, 4000, 4000]; // 10 units per px
    assert.equal(isSmall([0, 0, 119, 119], frame, viewport), true);
    assert.equal(isSmall([0, 0, 120, 10], frame, viewport), false);
    assert.equal(isSmall([0, 0, 10, 120], frame, viewport), false);
    assert.equal(SMALL_LIMIT_PX, 12);
  });

  it('measures a tall frame at its height-limited scale (phone viewport)', () => {
    // 100 wide x 1000 tall frame: the width alone would give 3.31 px / unit, the height 0.4.
    const frame = [0, 0, 100, 1000];
    assert.equal(getPxPerUnit(frame, SMALL_VIEWPORT_PX), SMALL_VIEWPORT_PX.height / 1000);
    assert.equal(isSmall([0, 0, 20, 20], frame), true); // 8 px, not 66 px
    assert.equal(isSmall([0, 0, 40, 5], frame), false); // 16 px wide
  });

  it('uses the largest ring, not the union bbox', () => {
    const rings = [[[0, 0], [10, 0], [10, 10], [0, 0]], [[1000, 1000], [1100, 1000], [1100, 1100], [1000, 1000]]];
    assert.deepEqual(largestRingBbox(rings), [1000, 1000, 1100, 1100]);
  });
});

describe('contact sheet', () => {
  it('builds path data from numbers only', () => {
    assert.equal(pathOf([[[0, 0], [10, 0], [10, 5], [0, 0]]]), 'M0 0L10 0L10 5L0 0Z');
    assert.throws(() => pathOf([[['0', 0], [1, 1]]]), /finite numbers/);
    assert.throws(() => pathOf([[[Number.NaN, 0]]]), /finite numbers/);
  });

  it('escapes text from data files', () => {
    assert.equal(escapeXml('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;');
  });

  it('is not referenced by the app', () => {
    const appFiles = ['index.html', ...readdirSync(resolve(ROOT, 'js')).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`)];
    if (existsSync(resolve(ROOT, 'sw.js'))) appFiles.push('sw.js');
    for (const path of appFiles) assert.ok(!/contact-sheet/.test(read(path)), `${path} mentions the contact sheet`);
  });
});
