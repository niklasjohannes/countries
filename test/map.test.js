import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AMBIGUITY_RATIO,
  TAP_TOLERANCE_PX,
  MARKER_MIN_RADIUS_PX,
  computeInset,
  getPxPerUnit,
  hitTest,
  largestRingBbox,
  ringsToPathData,
} from '../js/map.js';

// Fixtures: `geometry-southern-africa.json` holds the real, unmodified
// entries for bw, km, ls, mz, na, sz, za and zw copied from
// `data/geometry/africa.json`, so South Africa's Lesotho hole ring is the
// real one. `map-meta-southern-africa.json` follows the `data/map-meta.json`
// contract; its frames are hand-picked and `km` (Comoros) is marked small to
// stand in for a small entry.

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const geometry = read('geometry-southern-africa.json');
const meta = read('map-meta-southern-africa.json');

const FRAME = meta.frames['southern-africa'];
const FRAME_WIDTH = FRAME[2] - FRAME[0];
const FRAME_HEIGHT = FRAME[3] - FRAME[1];
// Width-limited: the frame is wider than these boxes are, relative to height.
const PHONE_PX = { width: 375, height: 400 };
const DESKTOP_PX = { width: 1_500, height: 1_500 };
// Height-limited (`meet` letterboxes left and right).
const SHORT_PX = { width: 375, height: 150 };

// Independent point-to-segment distance, to derive expected results.
function distanceToEntry([px, py], code) {
  let best = Infinity;
  for (const ring of geometry.entries[code].rings) {
    for (let i = 1; i < ring.length; i += 1) {
      const [ax, ay] = ring[i - 1];
      const [bx, by] = ring[i];
      const lengthSquared = (bx - ax) ** 2 + (by - ay) ** 2;
      const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / lengthSquared));
      best = Math.min(best, Math.hypot(px - ax - t * (bx - ax), py - ay - t * (by - ay)));
    }
  }
  return best;
}

function buildEntries(codes = Object.keys(geometry.entries), overrides = {}) {
  return Object.fromEntries(codes.map((code) => [
    code,
    { rings: geometry.entries[code].rings, tappable: meta.entries[code].tappable, ...overrides[code] },
  ]));
}

function westmostPoint(code) {
  return geometry.entries[code].rings[0].reduce((best, point) => (point[0] < best[0] ? point : best));
}

// The coastal end of the South Africa / Mozambique border (Kosi Bay): the
// easternmost vertex the two outer rings share.
function zaMzCoastalBorderPoint() {
  const mozambique = new Set(geometry.entries.mz.rings[0].map((point) => point.join()));
  return geometry.entries.za.rings[0]
    .filter((point) => mozambique.has(point.join()))
    .reduce((best, point) => (point[0] > best[0] ? point : best));
}

describe('fixtures follow the data contracts', () => {
  it('geometry has integer, closed rings and a bbox matching them', () => {
    assert.deepEqual(Object.keys(geometry).sort(), ['entries', 'projection', 'scale']);
    for (const [code, entry] of Object.entries(geometry.entries)) {
      assert.deepEqual(Object.keys(entry).sort(), ['bbox', 'label', 'rings'], code);
      const points = entry.rings.flat();
      assert.ok(points.flat().every(Number.isInteger), code);
      for (const ring of entry.rings) {
        assert.deepEqual(ring[0], ring.at(-1), code);
      }
      const xs = points.map(([x]) => x);
      const ys = points.map(([, y]) => y);
      assert.deepEqual(entry.bbox, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], code);
    }
  });

  it('map-meta has frames, symmetric neighbours and `tappable` equal to `!small`', () => {
    for (const box of Object.values(meta.frames)) {
      assert.equal(box.length, 4);
      assert.ok(box[2] > box[0] && box[3] > box[1]);
    }
    assert.deepEqual(Object.keys(meta.entries).sort(), Object.keys(geometry.entries).sort());
    for (const [code, entry] of Object.entries(meta.entries)) {
      assert.equal(entry.tappable, !entry.small, code);
      for (const neighbour of entry.neighbours) {
        assert.ok(meta.entries[neighbour].neighbours.includes(code), `${code} ↔ ${neighbour}`);
      }
    }
  });

  it('South Africa has the Lesotho hole as a ring', () => {
    const lesotho = geometry.entries.ls.rings[0];
    const hasHole = geometry.entries.za.rings.some((ring) =>
      ring.length === lesotho.length && ring.every(([x, y]) => lesotho.some(([lx, ly]) => lx === x && ly === y)));
    assert.ok(hasHole);
  });
});

describe('ringsToPathData', () => {
  it('builds M/L/Z commands and replaces the closing point with Z', () => {
    const rings = [
      [[0, 0], [10, 0], [10, 10], [0, 0]],
      [[-5, 3], [7, -2], [1, 1]],
    ];
    assert.equal(ringsToPathData(rings), 'M0 0L10 0L10 10ZM-5 3L7 -2L1 1Z');
    assert.equal(ringsToPathData([]), '');
  });

  it('outputs a numeric path string only for real geometry', () => {
    for (const entry of Object.values(geometry.entries)) {
      assert.match(ringsToPathData(entry.rings), /^(M-?\d+ -?\d+(L-?\d+ -?\d+)*Z)+$/);
    }
  });

  it('throws on non-finite, non-integer or malformed input', () => {
    const bad = [NaN, Infinity, -Infinity, 1.5, '1', null];
    for (const value of bad) {
      assert.throws(() => ringsToPathData([[[0, 0], [value, 0], [1, 1]]]), TypeError, String(value));
    }
    assert.throws(() => ringsToPathData('M0 0'), TypeError);
    assert.throws(() => ringsToPathData([[[0, 0], [1, 1]]]), TypeError);
    assert.throws(() => ringsToPathData([[[0, 0], [1e21, 0], [1, 1]]]), TypeError);
    assert.throws(() => ringsToPathData([[[0, 0], [2 ** 53, 0], [1, 1]]]), TypeError);
    assert.throws(() => ringsToPathData([[[0, 0, 0], [1, 0], [1, 1]]]), TypeError);
    assert.throws(() => ringsToPathData([[[0, 0], [1, 0], [1, 1]], 'x']), /`rings\[1\]`/);
  });
});

describe('hitTest', () => {
  const entries = buildEntries();

  it('returns Lesotho, not South Africa, for a tap in the Lesotho hole', () => {
    const point = geometry.entries.ls.label;
    assert.deepEqual(hitTest(point, entries, FRAME, PHONE_PX), { code: 'ls' });
  });

  it('treats the hole as outside South Africa even without Lesotho drawn', () => {
    // Non-tappable, so only a true inside test could return it.
    const southAfricaOnly = buildEntries(['za'], { za: { tappable: false } });
    assert.equal(hitTest(geometry.entries.ls.label, southAfricaOnly, FRAME, PHONE_PX), null);
    assert.deepEqual(hitTest(geometry.entries.za.label, southAfricaOnly, FRAME, PHONE_PX), { code: 'za' });
  });

  it('returns the country for a tap inside it', () => {
    for (const code of ['bw', 'na', 'sz', 'za', 'zw']) {
      assert.deepEqual(hitTest(geometry.entries[code].label, entries, FRAME, PHONE_PX), { code }, code);
    }
  });

  it('returns the only country within tolerance for a sea tap', () => {
    const [x, y] = westmostPoint('na');
    assert.deepEqual(hitTest([x - 1_000, y], entries, FRAME, PHONE_PX), { code: 'na' });
  });

  it('returns an ambiguous pair, nearest first, for a tap between two close countries', () => {
    const [x, y] = zaMzCoastalBorderPoint();
    const point = [x + 300, y];
    const expected = ['mz', 'za'].sort((a, b) => distanceToEntry(point, a) - distanceToEntry(point, b));
    assert.notEqual(distanceToEntry(point, 'mz'), distanceToEntry(point, 'za'));
    assert.deepEqual(hitTest(point, entries, FRAME, PHONE_PX), { ambiguous: expected });
  });

  it('returns null for a tap far out at sea', () => {
    assert.equal(hitTest([FRAME[0] + 100, FRAME[3] - 100], entries, FRAME, PHONE_PX), null);
  });

  it('never proximity-matches a non-tappable (small) entry, but does match an inside tap', () => {
    const comoros = geometry.entries.km;
    const nearby = [comoros.bbox[2] + 300, comoros.bbox[3]];
    assert.equal(hitTest(nearby, entries, FRAME, PHONE_PX), null);
    const tappableComoros = buildEntries(['km'], { km: { tappable: true } });
    assert.deepEqual(hitTest(nearby, tappableComoros, FRAME, PHONE_PX), { code: 'km' });
    assert.deepEqual(hitTest(comoros.label, entries, FRAME, PHONE_PX), { code: 'km' });
  });

  it('scales the tolerance with the rendered width', () => {
    const [x, y] = westmostPoint('na');
    const phoneToleranceUnits = TAP_TOLERANCE_PX * FRAME_WIDTH / PHONE_PX.width;
    const desktopToleranceUnits = TAP_TOLERANCE_PX * FRAME_WIDTH / DESKTOP_PX.width;
    const between = (phoneToleranceUnits + desktopToleranceUnits) / 2;
    assert.deepEqual(hitTest([x - between, y], entries, FRAME, PHONE_PX), { code: 'na' });
    assert.equal(hitTest([x - between, y], entries, FRAME, DESKTOP_PX), null);
    const near = desktopToleranceUnits / 2;
    assert.deepEqual(hitTest([x - near, y], entries, FRAME, DESKTOP_PX), { code: 'na' });
  });

  it('uses the height scale when a frame is height-limited', () => {
    assert.equal(getPxPerUnit(FRAME, PHONE_PX), PHONE_PX.width / FRAME_WIDTH);
    assert.equal(getPxPerUnit(FRAME, SHORT_PX), SHORT_PX.height / FRAME_HEIGHT);
    const [x, y] = westmostPoint('na');
    const widthOnlyToleranceUnits = TAP_TOLERANCE_PX * FRAME_WIDTH / SHORT_PX.width;
    const meetToleranceUnits = TAP_TOLERANCE_PX * FRAME_HEIGHT / SHORT_PX.height;
    const between = (widthOnlyToleranceUnits + meetToleranceUnits) / 2;
    assert.deepEqual(hitTest([x - between, y], entries, FRAME, SHORT_PX), { code: 'na' });
    assert.equal(hitTest([x - meetToleranceUnits - 1, y], entries, FRAME, SHORT_PX), null);
  });

  it('uses a precomputed `bbox` when given', () => {
    const withBbox = Object.fromEntries(Object.entries(entries).map(([code, entry]) =>
      [code, { ...entry, bbox: geometry.entries[code].bbox }]));
    const [x, y] = zaMzCoastalBorderPoint();
    for (const point of [geometry.entries.ls.label, [x + 300, y], [FRAME[0] + 100, FRAME[3] - 100]]) {
      assert.deepEqual(hitTest(point, withBbox, FRAME, PHONE_PX), hitTest(point, entries, FRAME, PHONE_PX));
    }
    assert.throws(() => hitTest([0, 0], { za: { ...withBbox.za, bbox: [0, 0, 1] } }, FRAME, PHONE_PX), /`entries.za.bbox`/);
  });

  it('applies the tolerance and ambiguity ratio at their boundaries', () => {
    // Two vertical squares; the tap sits on the x-axis between them.
    const square = (x0) => [[[x0, -10], [x0 + 10, -10], [x0 + 10, 10], [x0, 10], [x0, -10]]];
    const frame = [0, -50, 100, 50];
    const viewportPx = { width: 100, height: 100 }; // 1 CSS px per unit
    const pair = (gapA, gapB) => ({
      a: { rings: square(50 - gapA - 10), tappable: true },
      b: { rings: square(50 + gapB), tappable: true },
    });
    assert.deepEqual(hitTest([50, 0], pair(TAP_TOLERANCE_PX, 40), frame, viewportPx), { code: 'a' });
    assert.equal(hitTest([50, 0], pair(TAP_TOLERANCE_PX + 1, 40), frame, viewportPx), null);
    assert.deepEqual(hitTest([50, 0], pair(10, 10 * AMBIGUITY_RATIO), frame, viewportPx), { ambiguous: ['a', 'b'] });
    assert.deepEqual(hitTest([50, 0], pair(10, 10 * AMBIGUITY_RATIO + 1), frame, viewportPx), { code: 'a' });
    assert.deepEqual(hitTest([50, 0], pair(12, 8), frame, viewportPx), { ambiguous: ['b', 'a'] });
  });

  it('is deterministic and independent of entry order', () => {
    const [x, y] = zaMzCoastalBorderPoint();
    const point = [x + 300, y];
    const reversed = Object.fromEntries(Object.entries(entries).reverse());
    const first = hitTest(point, entries, FRAME, PHONE_PX);
    assert.deepEqual(hitTest(point, entries, FRAME, PHONE_PX), first);
    assert.deepEqual(hitTest(point, reversed, FRAME, PHONE_PX), first);
  });

  it('picks the smaller entry when a small square lies inside a large one, in either entry order', () => {
    const square = (x0, y0, size) => [[[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size], [x0, y0]]];
    const big = { rings: square(0, 0, 1_000), tappable: true };
    const small = { rings: square(400, 400, 100), tappable: true };
    const frame = [0, 0, 1_000, 1_000];
    const inside = [450, 450]; // in both squares
    const bigOnly = [100, 100];
    for (const order of [{ big, small }, { small, big }]) {
      assert.deepEqual(hitTest(inside, order, frame, PHONE_PX), { code: 'small' });
      assert.deepEqual(hitTest(bigOnly, order, frame, PHONE_PX), { code: 'big' });
    }
  });

  it('validates its inputs', () => {
    const point = [0, 0];
    assert.throws(() => hitTest([0], entries, FRAME, PHONE_PX), /`point`/);
    assert.throws(() => hitTest([NaN, 0], entries, FRAME, PHONE_PX), /`point`/);
    assert.throws(() => hitTest(point, [], FRAME, PHONE_PX), /`entries`/);
    assert.throws(() => hitTest(point, { za: { rings: geometry.entries.za.rings } }, FRAME, PHONE_PX), /`entries.za.tappable`/);
    assert.throws(() => hitTest(point, { za: { rings: [[[0, 0], [0.5, 1], [1, 0]]], tappable: true } }, FRAME, PHONE_PX), /`entries.za.rings\[0\]\[1\]`/);
    assert.throws(() => hitTest(point, entries, [0, 0, 0, 10], PHONE_PX), RangeError);
    assert.throws(() => hitTest(point, entries, [0, 0, 10], PHONE_PX), /`frame`/);
    for (const viewportPx of [375, { width: 0, height: 1 }, { width: 375 }, { width: NaN, height: 1 }, { width: 1, height: Infinity }]) {
      assert.throws(() => hitTest(point, entries, FRAME, viewportPx), /`viewportPx`/);
    }
  });
});

describe('computeInset', () => {
  const frame = meta.frames['eastern-africa'];
  const comoros = geometry.entries.km;
  const contains = (outer, inner) =>
    outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];

  it('magnifies a padded square around the entry and places it inside the frame', () => {
    const { marker, source, target } = computeInset(comoros, frame, PHONE_PX);
    // The largest island, not the union of all four.
    assert.ok(contains(source, largestRingBbox(comoros.rings)));
    assert.equal(source[2] - source[0], source[3] - source[1]);
    assert.ok(contains(frame, target));
    assert.equal(target[2] - target[0], target[3] - target[1]);
    const [bx0, by0, bx1, by1] = largestRingBbox(comoros.rings);
    assert.deepEqual([marker.cx, marker.cy], [(bx0 + bx1) / 2, (by0 + by1) / 2]);
    assert.ok(marker.r >= Math.hypot(bx1 - bx0, by1 - by0) / 2);
  });

  it('puts the inset in the frame corner farthest from the entry', () => {
    const [fx0, fy0, fx1, fy1] = [0, 0, 1_000, 1_000];
    const at = (x, y) => ({ bbox: [x, y, x + 2, y + 2] });
    const corner = (entry) => {
      const { target } = computeInset(entry, [fx0, fy0, fx1, fy1], PHONE_PX);
      return [target[0] > 500 ? 'right' : 'left', target[1] > 500 ? 'bottom' : 'top'];
    };
    assert.deepEqual(corner(at(10, 10)), ['right', 'bottom']);
    assert.deepEqual(corner(at(900, 10)), ['left', 'bottom']);
    assert.deepEqual(corner(at(10, 900)), ['right', 'top']);
    assert.deepEqual(corner(at(900, 900)), ['left', 'top']);
  });

  it('sizes the minimum marker in CSS px, also for a height-limited frame', () => {
    const point = { bbox: [500, 500, 500, 500] };
    const tall = [0, 0, 1_000, 4_000];
    for (const viewportPx of [{ width: 375, height: 8_000 }, { width: 375, height: 500 }]) {
      const { marker } = computeInset(point, tall, viewportPx);
      assert.ok(Math.abs(marker.r * getPxPerUnit(tall, viewportPx) - MARKER_MIN_RADIUS_PX) < 1e-9);
    }
  });

  it('rings and magnifies the largest ring of a scattered archipelago, not its union bbox', () => {
    const square = (x0, y0, size) => [[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size], [x0, y0]];
    // Two islands 20,000 units apart: the union bbox is 20,100 wide, the big island 100.
    const rings = [square(10_000, 10_000, 100), square(30_000, 10_000, 20)];
    const entry = { bbox: [10_000, 10_000, 30_020, 10_100], rings };
    const frame = [0, 0, 40_000, 40_000];
    const viewport = { width: 400, height: 400 };
    const { marker, source } = computeInset(entry, frame, viewport);
    assert.deepEqual([marker.cx, marker.cy], [10_050, 10_050]);
    assert.ok(marker.r <= MARKER_MIN_RADIUS_PX / getPxPerUnit(frame, viewport) + 1e-9, `the ring must hug the big island, got r=${marker.r}`);
    assert.equal(source[2] - source[0], 200, 'source is the big island plus padding, so the inset magnifies');
    // Without rings the union bbox is still used.
    assert.equal(computeInset({ bbox: entry.bbox }, frame, viewport).source[2] - computeInset({ bbox: entry.bbox }, frame, viewport).source[0], 40_040);
  });

  it('keeps a visible marker and a non-empty source for a point-sized entry', () => {
    const { marker, source } = computeInset({ bbox: [500, 500, 500, 500] }, [0, 0, 1_000, 1_000], PHONE_PX);
    assert.ok(marker.r > 0);
    assert.ok(source[2] > source[0] && source[3] > source[1]);
  });

  it('validates its inputs', () => {
    assert.throws(() => computeInset(null, frame, PHONE_PX), /`entry`/);
    assert.throws(() => computeInset({ bbox: [0, 0, 1] }, frame, PHONE_PX), /`entry.bbox`/);
    assert.throws(() => computeInset({ bbox: [2, 0, 1, 1] }, frame, PHONE_PX), RangeError);
    assert.throws(() => computeInset(comoros, [0, 0, 0, 0], PHONE_PX), /`frame`/);
    assert.throws(() => computeInset(comoros, frame, 375), /`viewportPx`/);
  });
});
