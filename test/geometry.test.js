import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import {
  buildGeometry,
  makeProjection,
  pointInRings,
  simplifyVisvalingam,
  wrapLongitude
} from '../scripts/build-geometry.js';
import { BREAKAWAY_RULINGS, NE_FEATURE_CODES, NOT_DRAWN, POLICY } from '../scripts/country-overrides.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTINENTS = ['africa', 'asia', 'europe', 'north-america', 'south-america', 'oceania'];
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');
const { countries } = JSON.parse(read('data/countries.json'));
const files = Object.fromEntries(
  [...CONTINENTS, 'world'].map((name) => [name, JSON.parse(read(`data/geometry/${name}.json`))])
);
const { neighbours } = JSON.parse(read('data/geometry/neighbours.json'));

/** Project [lon, lat] into a file's integer coordinate space (unrounded). */
function toFile(name, lon, lat) {
  const file = files[name];
  const project = makeProjection({ projection: file.projection.name, centre: file.projection.centre });
  const [x, y] = project(lon, lat);
  return [(x - file.projection.origin[0]) * file.scale, (file.projection.origin[1] - y) * file.scale];
}

/** Codes whose rings contain [lon, lat] in a file. */
function ownersAt(name, lon, lat) {
  const point = toFile(name, lon, lat);
  return Object.entries(files[name].entries)
    .filter(([, entry]) => pointInRings(point, entry.rings))
    .map(([code]) => code);
}

function distanceToSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function segmentsOf(rings) {
  const out = [];
  for (const ring of rings) for (let i = 0; i + 1 < ring.length; i += 1) out.push([ring[i], ring[i + 1]]);
  return out;
}

function overlaps(a, b, margin = 0) {
  return a[0] - margin <= b[2] && b[0] - margin <= a[2] && a[1] - margin <= b[3] && b[1] - margin <= a[3];
}

describe('geometry regeneration', () => {
  let outputs;
  before(() => {
    outputs = buildGeometry(ROOT);
  });

  it('is byte for byte what the generator produces', () => {
    assert.ok(outputs.size >= 8);
    for (const [path, text] of outputs) {
      assert.equal(read(path), text, `${path} is out of date: run \`node scripts/build-geometry.js\``);
    }
  });
});

describe('geometry coverage', () => {
  it('has every quizzed code in its continent file and in world.json', () => {
    const quizzed = countries.filter((country) => country.quizzed);
    assert.equal(quizzed.length, 206);
    for (const { code, continent } of quizzed) {
      assert.ok(files[continent].entries[code], `${code} missing from ${continent}.json`);
      assert.ok(files.world.entries[code], `${code} missing from world.json`);
    }
  });

  it('draws every countries.json entry, context-only ones included, and nothing else', () => {
    const codes = countries.map((country) => country.code).sort();
    assert.deepEqual(Object.keys(files.world.entries).sort(), codes);
    for (const continent of CONTINENTS) {
      const members = countries.filter((country) => country.continent === continent).map((country) => country.code).sort();
      assert.deepEqual(Object.keys(files[continent].entries).sort(), members, continent);
    }
  });

  it('drops the territories Natural Earth does not draw from countries.json', () => {
    const meta = JSON.parse(read('data/countries.json')).meta;
    for (const code of Object.keys(NOT_DRAWN)) {
      assert.ok(!countries.some((country) => country.code === code), code);
      assert.ok(meta.excluded[code], code);
    }
  });
});

describe('geometry file contract', () => {
  for (const [name, file] of Object.entries(files)) {
    it(`${name}.json has integer, closed rings with matching bbox and label`, () => {
      assert.equal(typeof file.projection, 'object');
      assert.ok(Number.isFinite(file.scale) && file.scale > 0);
      for (const [code, entry] of Object.entries(file.entries)) {
        assert.ok(entry.rings.length > 0, code);
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        for (const ring of entry.rings) {
          assert.ok(ring.length >= 4, `${code}: ring too short`);
          assert.deepEqual(ring[0], ring[ring.length - 1], `${code}: ring not closed`);
          for (const point of ring) {
            assert.equal(point.length, 2);
            for (const value of point) assert.ok(Number.isSafeInteger(value), `${code}: non-integer ${value}`);
            x0 = Math.min(x0, point[0]);
            y0 = Math.min(y0, point[1]);
            x1 = Math.max(x1, point[0]);
            y1 = Math.max(y1, point[1]);
          }
        }
        assert.deepEqual(entry.bbox, [x0, y0, x1, y1], `${code}: bbox`);
        assert.equal(entry.label.length, 2);
        for (const value of entry.label) assert.ok(Number.isSafeInteger(value), `${code}: label`);
      }
    });
  }

  it('keeps every quizzed label inside its entry in its continent file', () => {
    for (const { code, continent, quizzed } of countries) {
      if (!quizzed) continue;
      const entry = files[continent].entries[code];
      const [x0, y0, x1, y1] = entry.bbox;
      const [lx, ly] = entry.label;
      assert.ok(lx >= x0 && lx <= x1 && ly >= y0 && ly <= y1, `${code}: label outside bbox`);
    }
  });
});

describe('geometry size budget', () => {
  it('keeps the continent files at 1 MB or less in total', () => {
    const total = CONTINENTS.reduce((sum, name) => sum + statSync(resolve(ROOT, `data/geometry/${name}.json`)).size, 0);
    assert.ok(total <= 1_000_000, `continent files total ${total} bytes`);
  });

  it('keeps world.json at 250 KB or less', () => {
    const size = statSync(resolve(ROOT, 'data/geometry/world.json')).size;
    assert.ok(size <= 250_000, `world.json is ${size} bytes`);
  });
});

describe('neighbours', () => {
  it('covers every entry and is symmetric', () => {
    assert.deepEqual(Object.keys(neighbours).sort(), countries.map((country) => country.code).sort());
    for (const [code, list] of Object.entries(neighbours)) {
      assert.deepEqual(list, [...new Set(list)].sort(), code);
      assert.ok(!list.includes(code), `${code} lists itself`);
      for (const other of list) assert.ok(neighbours[other].includes(code), `${code} -> ${other} is one-way`);
    }
  });

  it('finds land neighbours from shared borders', () => {
    const pairs = [
      ['fr', 'es'], ['us', 'ca'], ['ru', 'ua'], ['cn', 'in'], ['eh', 'ma'], ['eh', 'mr'], ['sy', 'il'],
      ['za', 'ls'], ['it', 'va'], ['it', 'sm'], ['gf', 'br'], ['gf', 'sr'], ['sx', 'mf'], ['rs', 'xk'],
      ['ru', 'pl'], ['in', 'pk'], ['ie', 'gb'], ['ht', 'do']
    ];
    for (const [a, b] of pairs) assert.ok(neighbours[a].includes(b), `${a} and ${b} should be neighbours`);
    assert.ok(!neighbours.fr.includes('br'), 'French Guiana is split out of France');
  });

  it('gives islands maritime neighbours', () => {
    for (const code of ['is', 'jp', 'mg', 'lk', 'cu', 'mt', 'fj', 'nz', 'tw']) {
      assert.ok(neighbours[code].length > 0, `${code} has no neighbours`);
    }
    assert.ok(neighbours.lk.includes('in'));
    assert.ok(neighbours.tw.includes('cn'));
  });
});

describe('shared borders', () => {
  // Each pair of land neighbours in a file must share its border exactly: any
  // vertex of one lying on the other's boundary must be a vertex of the other
  // (no gap), and no sampled point may be inside both (no overlap).
  const landPairs = (name) => {
    const entries = files[name].entries;
    const pairs = [];
    for (const [a, list] of Object.entries(neighbours)) {
      for (const b of list) {
        if (a < b && entries[a] && entries[b] && overlaps(entries[a].bbox, entries[b].bbox, 1)) pairs.push([a, b]);
      }
    }
    return pairs;
  };

  for (const name of [...CONTINENTS, 'world']) {
    it(`${name}.json: neighbours meet without gaps along shared arcs (sampled)`, () => {
      const entries = files[name].entries;
      let checked = 0;
      for (const [a, b] of landPairs(name)) {
        const vertices = new Set(entries[b].rings.flat().map((p) => `${p[0]},${p[1]}`));
        const segments = segmentsOf(entries[b].rings);
        const points = entries[a].rings.flat();
        for (let i = 0; i < points.length; i += 3) {
          const p = points[i];
          if (!overlaps([p[0], p[1], p[0], p[1]], entries[b].bbox, 1)) continue;
          const near = segments.some(([s, t]) => distanceToSegment(p, s, t) < 0.5);
          if (near) {
            checked += 1;
            assert.ok(vertices.has(`${p[0]},${p[1]}`), `${name}: ${a} vertex ${p} lies on ${b}'s border but is not shared`);
          }
        }
      }
      // Oceania has no land border inside the file (Papua New Guinea's is with Indonesia, in Asia).
      if (name !== 'oceania') assert.ok(checked > 0, 'no shared border vertices were sampled');
    });

    it(`${name}.json: neighbours do not overlap (sampled)`, () => {
      const entries = files[name].entries;
      const grid = 24;
      for (const [a, b] of landPairs(name)) {
        const [ax0, ay0, ax1, ay1] = entries[a].bbox;
        const [bx0, by0, bx1, by1] = entries[b].bbox;
        const x0 = Math.max(ax0, bx0);
        const y0 = Math.max(ay0, by0);
        const x1 = Math.min(ax1, bx1);
        const y1 = Math.min(ay1, by1);
        for (let i = 0; i < grid; i += 1) {
          for (let j = 0; j < grid; j += 1) {
            // Offsets avoid landing exactly on integer vertices and edges.
            const p = [x0 + ((x1 - x0) * (i + 0.37)) / grid, y0 + ((y1 - y0) * (j + 0.61)) / grid];
            assert.ok(!(pointInRings(p, entries[a].rings) && pointInRings(p, entries[b].rings)),
              `${name}: ${a} and ${b} overlap at ${p}`);
          }
        }
      }
    });
  }
});

describe('spot checks', () => {
  it('puts Crimea, Sevastopol included, inside Ukraine', () => {
    for (const name of ['europe', 'world']) {
      assert.deepEqual(ownersAt(name, 34.1, 45.0), ['ua'], `${name}: Simferopol`);
      // Inland in the Sevastopol municipality, clear of the simplified coast.
      assert.deepEqual(ownersAt(name, 33.8, 44.6), ['ua'], `${name}: Sevastopol`);
    }
  });

  it('cuts Lesotho out of South Africa as a hole', () => {
    for (const name of ['africa', 'world']) {
      const { za, ls } = files[name].entries;
      const outline = (ring) => [...new Set(ring.map((p) => `${p[0]},${p[1]}`))].sort().join(';');
      assert.equal(ls.rings.length, 1);
      assert.ok(za.rings.some((ring) => outline(ring) === outline(ls.rings[0])), `${name}: no Lesotho hole in za`);
      assert.deepEqual(ownersAt(name, 28.2, -29.5), ['ls'], `${name}: Maseru area`);
    }
  });

  it('keeps Kaliningrad part of Russia', () => {
    assert.deepEqual(ownersAt('europe', 20.5, 54.7), ['ru']);
    assert.deepEqual(ownersAt('world', 20.5, 54.7), ['ru']);
  });

  it('puts Alaska in north-america as part of the United States', () => {
    assert.deepEqual(ownersAt('north-america', -150, 64), ['us']);
    assert.equal(countries.find((country) => country.code === 'us').continent, 'north-america');
  });

  it('draws Fiji and Chukotka without an antimeridian seam', () => {
    for (const [name, code, lats] of [['oceania', 'fj', [-17.2, -16]], ['europe', 'ru', [64, 72]]]) {
      const meridian = [];
      for (let lat = lats[0]; lat <= lats[1]; lat += 0.01) meridian.push(toFile(name, 180, lat));
      const seamSegments = segmentsOf(files[name].entries[code].rings).filter(([a, b]) => {
        const onMeridian = (p) => meridian.some((m, i) => i > 0 && distanceToSegment(p, meridian[i - 1], m) < 1);
        return Math.hypot(b[0] - a[0], b[1] - a[1]) > 2 && onMeridian(a) && onMeridian(b);
      });
      assert.deepEqual(seamSegments, [], `${name}: ${code} has edges along the antimeridian`);
    }
    // Taveuni straddles 180: its halves either side must be one ring.
    const west = toFile('oceania', 179.95, -16.9);
    const east = toFile('oceania', -179.91, -16.83);
    const ring = files.oceania.entries.fj.rings.find((r) => pointInRings(west, [r]));
    assert.ok(ring, 'Taveuni west of 180 not found');
    assert.ok(pointInRings(east, [ring]), 'Taveuni east of 180 is a separate ring');
  });

  it('applies the border policy table', () => {
    const cases = [
      ['asia', 35.75, 33.0, 'sy', 'Golan Heights'],
      ['africa', -13.2, 27.15, 'eh', 'Laayoune, Western Sahara'],
      ['africa', -14.5, 24.5, 'eh', 'Southern Western Sahara'],
      ['asia', 33.6, 35.25, 'cy', 'Northern Cyprus'],
      ['africa', 44.06, 9.56, 'so', 'Somaliland'],
      ['asia', 41.0, 43.0, 'ge', 'Abkhazia'],
      ['asia', 43.96, 42.23, 'ge', 'South Ossetia'],
      ['europe', 29.6, 46.84, 'md', 'Transnistria'],
      ['asia', 46.75, 39.82, 'az', 'Nagorno-Karabakh'],
      ['asia', 74.8, 34.08, 'in', 'Indian-administered Kashmir'],
      ['asia', 74.3, 35.9, 'pk', 'Gilgit-Baltistan'],
      ['asia', 79.5, 35.2, 'cn', 'Aksai Chin'],
      ['asia', 93.5, 28.0, 'in', 'Arunachal Pradesh'],
      ['europe', 37.8, 48.0, 'ua', 'Donetsk'],
      ['africa', 36.0, 22.6, 'eg', "Hala'ib Triangle"],
      ['africa', 33.75, 21.8, 'sd', 'Bir Tawil'],
      ['europe', 21.17, 42.66, 'xk', 'Kosovo'],
      ['south-america', -52.3, 4.9, 'gf', 'French Guiana'],
      ['europe', 15.6, 78.2, 'sj', 'Svalbard']
    ];
    for (const [name, lon, lat, code, label] of cases) {
      assert.deepEqual(ownersAt(name, lon, lat), [code], label);
      assert.deepEqual(ownersAt('world', lon, lat), [code], `${label} (world)`);
    }
  });

  it('rules on every breakaway area with a row of the policy table', () => {
    const layer = JSON.parse(read('vendor/natural-earth/ne_50m_admin_0_breakaway_disputed_areas.geojson'));
    for (const feature of layer.features) {
      assert.ok(Object.hasOwn(BREAKAWAY_RULINGS, feature.properties.BRK_NAME), feature.properties.BRK_NAME);
    }
    for (const [name, ruling] of Object.entries(BREAKAWAY_RULINGS)) {
      assert.ok(Object.hasOwn(POLICY.borders, ruling.policy), `${name} needs a row in POLICY.borders`);
      assert.ok(!Object.hasOwn(ruling, 'provisional'), `${name} is still provisional`);
    }
    for (const [adm0, ruling] of Object.entries(NE_FEATURE_CODES)) {
      assert.ok(Object.hasOwn(POLICY.borders, ruling.policy), `${adm0} needs a row in POLICY.borders`);
    }
  });
});

describe('geometry helpers', () => {
  it('simplifyVisvalingam keeps endpoints and drops collinear points', () => {
    const line = [[0, 0], [1, 0], [2, 0], [3, 1], [4, 0]];
    const out = simplifyVisvalingam(line, 0.1, false);
    assert.deepEqual(out[0], [0, 0]);
    assert.deepEqual(out[out.length - 1], [4, 0]);
    assert.ok(!out.some((p) => p[0] === 1));
    assert.ok(out.some((p) => p[0] === 3));
    assert.throws(() => simplifyVisvalingam(line, -1, false), RangeError);
  });

  it('simplifyVisvalingam keeps closed arcs at four points or more', () => {
    const square = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
    assert.equal(simplifyVisvalingam(square, 1e9, true).length, 4);
  });

  it('wrapLongitude wraps around the centre', () => {
    assert.equal(wrapLongitude(-170, 170), 190);
    assert.equal(wrapLongitude(173, -95), -187);
    assert.equal(wrapLongitude(10, 15), 10);
    assert.throws(() => wrapLongitude(Number.NaN, 0), TypeError);
  });

  it('makeProjection maps the centre to the origin and rejects unknown names', () => {
    const [x, y] = makeProjection({ projection: 'laea', centre: [20, 2] })(20, 2);
    assert.ok(Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9);
    assert.throws(() => makeProjection({ projection: 'mercator', centre: [0, 0] }), RangeError);
    assert.throws(() => makeProjection({}), TypeError);
  });
});
