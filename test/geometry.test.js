import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import {
  BREAKAWAY_MIN_SHARE,
  buildGeometryFull,
  deriveNeighbours,
  hashPoints,
  makeProjection,
  placeLabel,
  pointInRings,
  samplePoints,
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
// One build (in `before()`) serves the regeneration test and the neighbour
// tests. The neighbours are written to data/map-meta.json by
// scripts/build-map-meta.js.
let built;
let land;
let neighbours;
before(() => {
  built = buildGeometryFull(ROOT);
  ({ land, neighbours } = built);
});

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
    .filter(([, entry]) => overlaps([point[0], point[1], point[0], point[1]], entry.bbox) && pointInRings(point, entry.rings))
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

/**
 * True when some ring has a path from p to q (either way round) of at most
 * `maxEdges` edges, every edge passing `edgeOk`, staying within a sliver's
 * width of the straight segment p-q.
 */
function shortDetour(rings, p, q, edgeOk, maxEdges = 64) {
  const same = (u, v) => u[0] === v[0] && u[1] === v[1];
  const limit = Math.max(2, 0.5 * Math.hypot(q[0] - p[0], q[1] - p[1]));
  for (const ring of rings) {
    const n = ring.length - 1;
    const start = ring.findIndex((v, i) => i < n && same(v, p));
    if (start === -1) continue;
    for (const step of [1, -1]) {
      for (let k = 1, at = start; k <= maxEdges; k += 1) {
        const next = (at + step + n) % n;
        if (!edgeOk(ring[at], ring[next])) break;
        if (distanceToSegment(ring[next], p, q) > limit) break;
        if (same(ring[next], q)) return k > 1;
        at = next;
      }
    }
  }
  return false;
}

function overlaps(a, b, margin = 0) {
  return a[0] - margin <= b[2] && b[0] - margin <= a[2] && a[1] - margin <= b[3] && b[1] - margin <= a[3];
}

describe('geometry regeneration', () => {
  it('is byte for byte what the generator produces', () => {
    const { outputs } = built;
    assert.equal(outputs.size, 7, 'six continents and world.json');
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
    assert.ok(meta.policy.scope.includes(`(${Object.keys(NOT_DRAWN).join(', ')})`), 'policy scope names NOT_DRAWN');
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

  it('keeps every label inside its rings, or within a unit of a sub-grid ring', () => {
    for (const [name, file] of Object.entries(files)) {
      for (const [code, entry] of Object.entries(file.entries)) {
        if (pointInRings(entry.label, entry.rings)) continue;
        // Only a ring too small to hold any interior grid point may miss.
        const segments = segmentsOf(entry.rings);
        const distance = Math.min(...segments.map(([a, b]) => distanceToSegment(entry.label, a, b)));
        const [x0, y0, x1, y1] = entry.bbox;
        const lattice = [];
        for (let x = x0; x <= x1; x += 1) for (let y = y0; y <= y1; y += 1) lattice.push([x, y]);
        assert.ok(!lattice.some((p) => pointInRings(p, entry.rings)), `${name}: ${code} label is outside its rings`);
        assert.ok(distance <= 1, `${name}: ${code} label is ${distance} units from its ring`);
      }
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

describe('context land', () => {
  const CONTEXT_PRESENT = {
    europe: ['tr', 'kz', 'ir', 'gl', 'dz', 'ma'],
    asia: ['ru', 'eg'],
    africa: ['sa', 'es'],
    'north-america': ['ve', 'co'],
    'south-america': ['pa'],
    oceania: ['id', 'ph']
  };

  it('is a separate key in each continent file, never in world.json', () => {
    assert.equal(files.world.context, undefined);
    for (const name of CONTINENTS) {
      const context = files[name].context;
      assert.equal(typeof context, 'object', name);
      assert.ok(Object.keys(context).length > 0, name);
      assert.deepEqual(Object.keys(files[name]), ['projection', 'scale', 'entries', 'context']);
    }
  });

  it('holds only other continents, with rings and a bbox but no label', () => {
    for (const name of CONTINENTS) {
      for (const [code, entry] of Object.entries(files[name].context)) {
        const country = countries.find((c) => c.code === code);
        assert.ok(country, `${name}: ${code} is not an entry`);
        assert.notEqual(country.continent, name, `${name}.context holds its own ${code}`);
        assert.equal(files[name].entries[code], undefined, `${name}: ${code} in entries and context`);
        assert.deepEqual(Object.keys(entry), ['rings', 'bbox'], `${name}.context.${code}`);
        assert.ok(entry.rings.length > 0, `${name}.context.${code}`);
        for (const ring of entry.rings) {
          assert.deepEqual(ring[0], ring.at(-1), `${name}.context.${code} has an open ring`);
          assert.ok(ring.flat().every(Number.isInteger), `${name}.context.${code} has non-integer coordinates`);
        }
      }
    }
  });

  it('draws the neighbouring land the frames reach', () => {
    for (const [name, codes] of Object.entries(CONTEXT_PRESENT)) {
      for (const code of codes) assert.ok(files[name].context[code], `${name}.context lacks ${code}`);
    }
    assert.ok(files.asia.entries.tr && files.europe.context.tr, 'tr is own in asia and context in europe');
  });

  it('has a bbox that matches its rings', () => {
    for (const name of CONTINENTS) {
      for (const [code, { rings, bbox }] of Object.entries(files[name].context)) {
        const xs = rings.flat().map((p) => p[0]);
        const ys = rings.flat().map((p) => p[1]);
        assert.deepEqual(bbox, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], `${name}.context.${code}`);
      }
    }
  });
});

describe('hashPoints (arc ids)', () => {
  const one = [[0, 0], [1, 5], [2, 9], [4, 4]];
  const two = [[0, 0], [1, 5], [3, 8], [4, 4]]; // same first, second, last and length
  it('tells apart arcs that share their ends and their length', () => {
    assert.notEqual(hashPoints(one), hashPoints(two));
  });

  it('reads the same arc the same way from either end', () => {
    assert.equal(hashPoints(one, true), hashPoints([...one].reverse()));
    assert.match(hashPoints(one), /^[0-9a-f]{8}$/);
  });
});

describe('deriveNeighbours: the single-nearest fallback', () => {
  // `aa` is a speck at (0, 0). `cc` is a ring 50 degrees around it: its cap
  // reaches `aa`, so it passes the cap filter, but its nearest vertex is 50
  // degrees away. `bb` lies 40 degrees away and its cap is far enough to be
  // filtered out. Nothing is within the 1,500 km cap, so the fallback must
  // search every code and pick `bb`, the true nearest.
  const entry = (ring) => ({ polygons: [[[...ring, ring[0]]]], label: ring[0] });
  const entries = new Map([
    ['aa', entry([[0, 0], [0.1, 0], [0, 0.1]])],
    ['bb', entry([[40, 0], [70, 30], [100, 0], [70, -30]])],
    ['cc', entry([[50, 0], [0, 50], [-50, 0], [0, -50]])]
  ]);

  it('gives an island with nothing in reach its true nearest entry, not the nearest that passed the filter', () => {
    const { neighbours: result } = deriveNeighbours(entries, new Set());
    assert.deepEqual(result.aa, ['bb']);
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

  it('gives every entry at least one neighbour', () => {
    for (const [code, list] of Object.entries(neighbours)) assert.ok(list.length > 0, `${code} has no neighbours`);
    assert.ok(neighbours.sh.length >= 1, 'Saint Helena falls back to its nearest entry');
  });

  it('keeps the land map symmetric and inside the full map', () => {
    for (const [code, list] of Object.entries(land)) {
      for (const other of list) {
        assert.ok(land[other].includes(code), `land ${code} -> ${other} is one-way`);
        assert.ok(neighbours[code].includes(other), `land ${code} -> ${other} missing from neighbours`);
      }
    }
  });

  it('gives islands maritime neighbours', () => {
    for (const code of ['is', 'jp', 'mg', 'lk', 'cu', 'mt', 'fj', 'nz', 'tw']) {
      assert.ok(neighbours[code].length > 0, `${code} has no neighbours`);
    }
    assert.ok(neighbours.lk.includes('in'));
    assert.ok(neighbours.tw.includes('cn'));
  });
});

// Borders between context land and own land, or two context entries, that
// must meet exactly (listed pairs are sorted by code).
const CONTEXT_BORDERS = {
  europe: [['bg', 'tr'], ['gr', 'tr'], ['kz', 'ru'], ['ge', 'ru']],
  asia: [['kz', 'ru'], ['mn', 'ru']],
  africa: [['dz', 'ma'], ['il', 'jo']],
  'south-america': [['co', 'pa']],
  'north-america': [['co', 'pa'], ['gy', 've']],
  oceania: [['id', 'pg']]
};

describe('shared borders', () => {
  const edgeKey = (a, b) => {
    const p = `${a[0]},${a[1]}`;
    const q = `${b[0]},${b[1]}`;
    return p < q ? `${p}|${q}` : `${q}|${p}`;
  };

  /** Undirected edge -> the codes of every ring that uses it (one per use). */
  const edgeOwners = (entries) => {
    const owners = new Map();
    for (const [code, entry] of Object.entries(entries)) {
      for (const [a, b] of segmentsOf(entry.rings)) {
        const k = edgeKey(a, b);
        if (!owners.has(k)) owners.set(k, []);
        owners.get(k).push(code);
      }
    }
    return owners;
  };

  const orientation = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  const properlyCross = (a, b, c, d) => {
    const o1 = orientation(a, b, c);
    const o2 = orientation(a, b, d);
    const o3 = orientation(c, d, a);
    const o4 = orientation(c, d, b);
    return o1 * o2 < 0 && o3 * o4 < 0;
  };

  for (const name of [...CONTINENTS, 'world']) {
    // Other continents' land (`context`) takes part in the topology, so its borders with own land are checked too.
    const merged = { ...files[name].entries, ...(files[name].context ?? {}) };
    const own = files[name].entries;
    const pairs = [];
    before(() => {
      for (const [a, list] of Object.entries(land)) {
        for (const b of list) if (a < b && merged[a] && merged[b]) pairs.push([a, b]);
      }
      sharedPairs = pairs.filter(([a, b]) => (own[a] && own[b]) || (CONTEXT_BORDERS[name] ?? []).some(([x, y]) => x === a && y === b));
    });
    const owners = edgeOwners(merged);
    // Every pair of own entries must share an edge; for pairs with context land (some of whose rings are left out) only the listed ones must.
    let sharedPairs = [];

    it(`${name}.json: no edge has more than two owners, or one owner twice`, () => {
      for (const [k, codes] of owners) {
        assert.ok(codes.length <= 2, `${name}: edge ${k} has ${codes.length} owners`);
        if (codes.length === 2) assert.notEqual(codes[0], codes[1], `${name}: ${codes[0]} uses edge ${k} twice`);
      }
    });

    it(`${name}.json: every land pair shares an edge and meets exactly along it`, () => {
      if (name !== 'oceania') assert.ok(pairs.length > 0, 'no land pairs in this file');
      for (const [a, b] of CONTEXT_BORDERS[name] ?? []) assert.ok(sharedPairs.some(([x, y]) => x === a && y === b), `${name}: ${a}/${b} should be present`);
      for (const [a, b] of sharedPairs) {
        const shared = [];
        for (const [s, t] of segmentsOf(merged[a].rings)) {
          const codes = owners.get(edgeKey(s, t));
          if (codes.includes(b)) shared.push([s, t]);
        }
        assert.ok(shared.length > 0, `${name}: ${a} and ${b} are land neighbours but share no edge`);
        // Both sides of every shared edge: one side is a, the other is b.
        for (const [s, t] of shared) {
          const length = Math.hypot(t[0] - s[0], t[1] - s[1]);
          if (length < 2) continue;
          const mid = [(s[0] + t[0]) / 2, (s[1] + t[1]) / 2];
          const normal = [(-(t[1] - s[1]) / length) * 0.3, ((t[0] - s[0]) / length) * 0.3];
          const left = [mid[0] + normal[0], mid[1] + normal[1]];
          const right = [mid[0] - normal[0], mid[1] - normal[1]];
          const inA = [pointInRings(left, merged[a].rings), pointInRings(right, merged[a].rings)];
          const inB = [pointInRings(left, merged[b].rings), pointInRings(right, merged[b].rings)];
          assert.ok(inA[0] !== inA[1] && inB[0] !== inB[1] && inA[0] !== inB[0],
            `${name}: ${a}/${b} do not meet cleanly along ${s}-${t}`);
        }
      }
    });

    it(`${name}.json: land pairs never cross or run alongside each other`, () => {
      for (const [first, second] of pairs) {
        for (const [a, b] of [[first, second], [second, first]]) {
          const segmentsB = segmentsOf(merged[b].rings);
          const verticesB = new Set(merged[b].rings.flat().map((v) => `${v[0]},${v[1]}`));
          for (const [p, q] of segmentsOf(merged[a].rings)) {
            const box = [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])];
            if (!overlaps(box, merged[b].bbox, 1)) continue;
            for (const [s, t] of segmentsB) {
              if (Math.max(s[0], t[0]) < box[0] - 1 || Math.min(s[0], t[0]) > box[2] + 1) continue;
              if (Math.max(s[1], t[1]) < box[1] - 1 || Math.min(s[1], t[1]) > box[3] + 1) continue;
              assert.ok(!properlyCross(p, q, s, t), `${name}: ${a} ${p}-${q} crosses ${b} ${s}-${t}`);
            }
            // A gap: an edge of a between two of b's vertices, where b goes a
            // short, nearby way of its own (edges a does not share). Then the
            // two sides of one border took different paths. A coast that
            // collapsed to one segment between two border ends is not a gap:
            // b's way round between those points is long or far away.
            if (owners.get(edgeKey(p, q)).includes(b)) continue;
            if (!verticesB.has(`${p[0]},${p[1]}`) || !verticesB.has(`${q[0]},${q[1]}`)) continue;
            const detour = shortDetour(merged[b].rings, p, q, (s, t) => owners.get(edgeKey(s, t)).length === 1);
            assert.ok(!detour, `${name}: ${a} edge ${p}-${q} and ${b} take different paths along their border`);
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

  it('draws Kiribati and the Aleutians in one piece across 180°', () => {
    // Every island must sit next to its own vertices, with no copy thrown to
    // the far side of the file.
    const nearest = (name, code, lon, lat) => {
      const p = toFile(name, lon, lat);
      return Math.min(...files[name].entries[code].rings.flat().map((v) => Math.hypot(v[0] - p[0], v[1] - p[1])));
    };
    const kiribati = [[172.98, 1.4, 'Tarawa'], [-171.7, -2.8, 'Kanton'], [-157.4, 1.9, 'Kiritimati']];
    const aleutians = [[173.1, 52.9, 'Attu'], [179.0, 51.5, 'Amchitka'], [-176.6, 51.85, 'Adak'], [-166.5, 53.9, 'Unalaska']];
    for (const [name, code, islands] of [['oceania', 'ki', kiribati], ['north-america', 'us', aleutians]]) {
      const scale = files[name].scale;
      for (const [lon, lat, label] of islands) {
        assert.ok(nearest(name, code, lon, lat) < 30 * scale, `${name}: ${label} is not drawn where it is`);
      }
      const [x0, , x1] = files[name].entries[code].bbox;
      assert.ok(x1 - x0 < 10_000 * scale, `${name}: ${code} spans the whole file, so something wrapped`);
    }
  });

  it('gives each breakaway area to its ruled entry, 95% or more, in its continent file and world.json', () => {
    const layer = JSON.parse(read('vendor/natural-earth/ne_50m_admin_0_breakaway_disputed_areas.geojson'));
    const continentOf = Object.fromEntries(countries.map((country) => [country.code, country.continent]));
    for (const feature of layer.features) {
      const name = feature.properties.BRK_NAME;
      const code = BREAKAWAY_RULINGS[name].code;
      const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
      for (const fileName of [continentOf[code], 'world']) {
        let owned = 0;
        let total = 0;
        for (const polygon of polygons) {
          for (const [lon, lat] of samplePoints(polygon[0], 30)) {
            const owners = ownersAt(fileName, lon, lat);
            if (owners.length === 0) continue; // sea, along a coast
            total += 1;
            if (owners.length === 1 && owners[0] === code) owned += 1;
          }
        }
        assert.ok(total > 0, `${name}: no samples on land`);
        assert.ok(owned / total >= BREAKAWAY_MIN_SHARE, `${fileName}: ${name} is only ${(100 * owned / total).toFixed(1)}% ${code}`);
      }
    }
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

  it('simplifyVisvalingam with Infinity collapses a closed arc to its minimum', () => {
    const ring = [[0, 0], [4, 0], [5, 2], [4, 4], [0, 4], [-1, 2], [0, 0]];
    assert.equal(simplifyVisvalingam(ring, Infinity, true).length, 4);
    assert.throws(() => simplifyVisvalingam(ring, Number.NaN, true), RangeError);
  });

  it('placeLabel keeps an inside label and moves an outside one inside', () => {
    const square = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    assert.deepEqual(placeLabel([5, 5], [square]), [5, 5]);
    assert.ok(pointInRings(placeLabel([20, 20], [square]), [square]));
    assert.throws(() => placeLabel([0, 0], []), TypeError);
  });

  it('samplePoints only returns points inside the ring', () => {
    const triangle = [[0, 0], [10, 0], [0, 10]];
    const points = samplePoints(triangle, 10);
    assert.ok(points.length > 20 && points.every((p) => pointInRings(p, [triangle])));
    assert.throws(() => samplePoints(triangle, 0), TypeError);
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
