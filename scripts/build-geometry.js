// Zero-dependency generator for the projected map geometry.
//
//   node scripts/build-geometry.js          write data/geometry/*.json
//   node scripts/build-geometry.js --check  exit 1 if any file is out of date
//
// Inputs are the vendored, unmodified Natural Earth GeoJSON files (read with
// `JSON.parse` only, after their SHA-256 is checked against the pin), the
// generated `data/countries.json`, and the rules in `scripts/country-overrides.js`.
// There is no network access. The output is deterministic, so
// `test/geometry.test.js` regenerates it and compares byte for byte.
//
// Pipeline (docs/DATA.md -> "Geometry"):
//   1. Map Natural Earth features to entries by `ISO_A2_EH` (or NE_FEATURE_CODES).
//   2. Split overseas parts out of their parent feature (OVERSEAS_SPLITS).
//   3. Apply the border policy with the breakaway/disputed layer (BREAKAWAY_RULINGS).
//   4. For each file: wrap longitudes around the projection centre, stitch
//      polygons cut at the antimeridian, dissolve internal edges, project.
//   5. Extract shared arcs, simplify each arc once (Visvalingam), quantise.
//   6. Derive symmetric neighbours: shared arcs, plus maritime ones for islands.
//      They are not written here: `scripts/build-map-meta.js` carries them into
//      `data/map-meta.json`.

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BREAKAWAY_RULINGS,
  GEOMETRY_FILES,
  MARITIME_NEIGHBOURS,
  NATURAL_EARTH,
  NE_FEATURE_CODES,
  NE_SKIPPED_FEATURES,
  OVERSEAS_SPLITS
} from './country-overrides.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const COUNTRIES_PATH = 'data/countries.json';
const OUTPUT_DIR = 'data/geometry';

/** Mean Earth radius in km (spherical projections). */
export const EARTH_RADIUS_KM = 6371;
/** Longitudes this close to the antimeridian count as on it (degrees). */
const SEAM_TOLERANCE_DEG = 1e-3;
/** Largest latitude gap bridged when stitching a polygon cut at the antimeridian. */
const SEAM_MAX_GAP_DEG = 1;
/** Breakaway-area vertices nearer than this to the parent's boundary are on it. */
const CUT_BOUNDARY_EPS_DEG = 0.02;
/** Breakaway boundaries are densified to this spacing before cutting. */
const CUT_DENSIFY_DEG = 0.05;
/** Per-arc tolerance never exceeds this share of the smallest ring using the arc. */
const ARC_TOLERANCE_RING_SHARE = 0.01;
/** Rounds of gentler re-simplification for arcs that cross after simplifying. */
const CROSSING_ROUNDS = 10;
/** How far (grid units) a label may move to land inside its ring. */
const LABEL_SEARCH_UNITS = 64;
/** Grid size for sampling breakaway areas. */
const BREAKAWAY_GRID = 20;
/** Land in another entry below this share of an area's samples is a sliver, not a move. */
const BREAKAWAY_SLIVER_SHARE = 0.05;
/** The ruled entry must own at least this share of each breakaway area. */
export const BREAKAWAY_MIN_SHARE = 0.95;
/** Arcs near a breakaway area are simplified at most this share of its area. */
const BREAKAWAY_TOLERANCE_SHARE = 0.002;
/** Islands at least this share of their entry's largest ring are always kept. */
const KEEP_RING_SHARE = 0.01;

// ---- Small geometry helpers (planar, on [lon, lat] or projected [x, y]) ----

/**
 * Twice the signed area of an open ring (positive when counter-clockwise).
 * @param {number[][]} ring
 * @returns {number}
 */
function doubleArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return sum;
}

/**
 * Ray-casting point-in-ring test.
 * @param {number[]} point
 * @param {number[][]} ring open or closed ring
 * @returns {boolean}
 */
export function pointInRing(point, ring) {
  if (!Array.isArray(point) || !Array.isArray(ring)) {
    throw new TypeError('`point` and `ring` must be arrays.');
  }
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Even-odd point-in-rings test, the way an SVG `fill-rule="evenodd"` path fills.
 * @param {number[]} point
 * @param {number[][][]} rings
 * @returns {boolean}
 */
export function pointInRings(point, rings) {
  if (!Array.isArray(rings)) throw new TypeError('`rings` must be an array of rings.');
  let inside = false;
  for (const ring of rings) if (pointInRing(point, ring)) inside = !inside;
  return inside;
}

function distanceToSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  let t = lengthSquared === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function distanceToRing(p, ring) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    best = Math.min(best, distanceToSegment(p, ring[j], ring[i]));
  }
  return best;
}

/** Intersection parameter of segment p->q with a->b, as [t on p->q, u on a->b], or null. */
function segmentIntersection(p, q, a, b) {
  const rx = q[0] - p[0];
  const ry = q[1] - p[1];
  const sx = b[0] - a[0];
  const sy = b[1] - a[1];
  const denominator = rx * sy - ry * sx;
  if (denominator === 0) return null;
  const t = ((a[0] - p[0]) * sy - (a[1] - p[1]) * sx) / denominator;
  const u = ((a[0] - p[0]) * ry - (a[1] - p[1]) * rx) / denominator;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t, u] : null;
}

function ringBbox(ring) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of ring) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

/**
 * A point inside a ring: the middle of the widest span on the horizontal line
 * through the ring's vertical middle.
 * @param {number[][]} ring
 * @returns {number[]}
 */
function pointOnSurface(ring) {
  const [, y0, , y1] = ringBbox(ring);
  // Nudge off any vertex latitude so the scanline never passes through a vertex.
  const y = (y0 + y1) / 2 + (y1 - y0) * 1e-7;
  const xs = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y)) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
  }
  xs.sort((a, b) => a - b);
  let best = [ring[0][0], ring[0][1]];
  let widest = -1;
  for (let k = 0; k + 1 < xs.length; k += 2) {
    if (xs[k + 1] - xs[k] > widest) {
      widest = xs[k + 1] - xs[k];
      best = [(xs[k] + xs[k + 1]) / 2, y];
    }
  }
  return best;
}

/** Drop the closing vertex of a GeoJSON ring and any consecutive duplicates. */
function openRing(ring) {
  const out = [];
  for (const [x, y] of ring) {
    const last = out[out.length - 1];
    if (!last || last[0] !== x || last[1] !== y) out.push([x, y]);
  }
  while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) {
    out.pop();
  }
  return out;
}

/** Remove back-and-forth spikes (a, b, a) that quantising can leave in a ring. */
function removeSpikes(ring) {
  const out = [...ring];
  let changed = true;
  while (changed && out.length >= 3) {
    changed = false;
    for (let i = 0; i < out.length && out.length >= 3; i += 1) {
      const before = out[(i - 1 + out.length) % out.length];
      const after = out[(i + 1) % out.length];
      if (before[0] === after[0] && before[1] === after[1]) {
        // Drop the spike tip and one copy of its base.
        const remove = [i, (i + 1) % out.length].sort((x, y) => y - x);
        for (const index of remove) out.splice(index, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** Orient a polygon: outer ring counter-clockwise, holes clockwise. */
function orientPolygon(polygon) {
  return polygon.map((ring, index) => {
    const ccw = doubleArea(ring) > 0;
    return (index === 0) === ccw ? ring : [...ring].reverse();
  });
}

const key = (point) => `${point[0]},${point[1]}`;

// ---- Inputs ----

/**
 * Read a vendored file, check its SHA-256 against the pin, and parse it.
 * @param {{path: string, sha256: string}} pin
 * @param {string} root repository root
 * @returns {object}
 */
export function readPinnedJson(pin, root = ROOT) {
  if (!pin || typeof pin.path !== 'string' || typeof pin.sha256 !== 'string') {
    throw new TypeError('`pin` must have string `path` and `sha256`.');
  }
  const bytes = readFileSync(resolve(root, pin.path));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== pin.sha256) {
    throw new RangeError(`\`${pin.path}\` does not match its pinned SHA-256; re-vendor it or update the pin.`);
  }
  return JSON.parse(bytes.toString('utf8'));
}

function featurePolygons(feature) {
  const { type, coordinates } = feature.geometry;
  const polygons = type === 'Polygon' ? [coordinates] : type === 'MultiPolygon' ? coordinates : null;
  if (polygons === null) throw new RangeError(`Unexpected geometry type \`${type}\`.`);
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const point of ring) {
        if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
          throw new RangeError(`Feature \`${feature.properties.ADM0_A3 ?? feature.properties.BRK_NAME}\` has a non-finite coordinate.`);
        }
      }
    }
  }
  return polygons.map((polygon) => orientPolygon(polygon.map(openRing).filter((ring) => ring.length >= 3)));
}

// ---- Step 1-3: entries in longitude/latitude ----

/**
 * Map Natural Earth features to entries, split overseas parts out, and apply
 * the breakaway rulings. Coordinates stay in degrees.
 * @param {{features: object[]}} countriesLayer NE admin-0 countries
 * @param {{features: object[]}} breakawayLayer NE breakaway/disputed areas
 * @param {Set<string>} codes every entry code in countries.json
 * @returns {Map<string, {polygons: number[][][][], label: number[] | null}>}
 */
export function assignEntries(countriesLayer, breakawayLayer, codes) {
  if (!countriesLayer || !Array.isArray(countriesLayer.features)) {
    throw new TypeError('`countriesLayer` must be a GeoJSON FeatureCollection.');
  }
  if (!breakawayLayer || !Array.isArray(breakawayLayer.features)) {
    throw new TypeError('`breakawayLayer` must be a GeoJSON FeatureCollection.');
  }
  if (!(codes instanceof Set)) throw new TypeError('`codes` must be a Set of entry codes.');

  const entries = new Map();
  const primaryArea = new Map();
  for (const feature of countriesLayer.features) {
    const p = feature.properties;
    if (Object.hasOwn(NE_SKIPPED_FEATURES, p.ADM0_A3)) continue;
    let code = p.ISO_A2_EH.toLowerCase();
    const mapped = Object.hasOwn(NE_FEATURE_CODES, p.ADM0_A3) ? NE_FEATURE_CODES[p.ADM0_A3].code : null;
    if (code === '-99') {
      if (mapped === null) {
        throw new RangeError(`Natural Earth feature \`${p.ADM0_A3}\` has no ISO code and no ruling in NE_FEATURE_CODES.`);
      }
      code = mapped;
    }
    if (!codes.has(code)) {
      throw new RangeError(`Natural Earth feature \`${p.ADM0_A3}\` maps to \`${code}\`, which is not an entry.`);
    }
    if (!entries.has(code)) entries.set(code, { polygons: [], label: null });
    const entry = entries.get(code);
    const polygons = featurePolygons(feature);
    entry.polygons.push(...polygons);
    // The label comes from the entry's own largest feature (France, not a ruling).
    if (mapped === null) {
      const area = polygons.reduce((sum, polygon) => sum + Math.abs(doubleArea(polygon[0])), 0);
      if (area > (primaryArea.get(code) ?? -1)) {
        if (!Number.isFinite(p.LABEL_X) || !Number.isFinite(p.LABEL_Y)) {
          throw new RangeError(`Natural Earth feature \`${p.ADM0_A3}\` has a non-finite LABEL_X/LABEL_Y.`);
        }
        primaryArea.set(code, area);
        entry.label = [p.LABEL_X, p.LABEL_Y];
      }
    }
  }

  for (const rule of OVERSEAS_SPLITS) {
    const parent = entries.get(rule.from);
    if (!parent) throw new RangeError(`Split rule for \`${rule.code}\` names unknown parent \`${rule.from}\`.`);
    const [w, s, e, n] = rule.box;
    const moved = [];
    parent.polygons = parent.polygons.filter((polygon) => {
      const [x0, y0, x1, y1] = ringBbox(polygon[0]);
      const inside = x0 >= w && x1 <= e && y0 >= s && y1 <= n;
      if (inside) moved.push(polygon);
      return !inside;
    });
    if (moved.length === 0) {
      throw new RangeError(`Split rule for \`${rule.code}\` (${rule.note}) matched no polygon part of \`${rule.from}\`.`);
    }
    if (!codes.has(rule.code)) throw new RangeError(`Split target \`${rule.code}\` is not an entry.`);
    if (!entries.has(rule.code)) entries.set(rule.code, { polygons: [], label: null });
    entries.get(rule.code).polygons.push(...moved);
  }

  for (const feature of breakawayLayer.features) {
    applyBreakaway(feature, entries);
  }

  for (const [code, entry] of entries) {
    const largest = largestRing(entry.polygons);
    if (entry.label === null || !pointInPolygons(entry.label, entry.polygons)) {
      entry.label = pointOnSurface(largest);
    }
    entries.set(code, entry);
  }
  return entries;
}

function largestRing(polygons) {
  let best = null;
  let bestArea = -1;
  for (const polygon of polygons) {
    const area = Math.abs(doubleArea(polygon[0]));
    if (area > bestArea) {
      bestArea = area;
      best = polygon[0];
    }
  }
  return best;
}

function pointInPolygon(point, polygon) {
  if (!pointInRing(point, polygon[0])) return false;
  for (let k = 1; k < polygon.length; k += 1) if (pointInRing(point, polygon[k])) return false;
  return true;
}

function pointInPolygons(point, polygons) {
  return polygons.some((polygon) => pointInPolygon(point, polygon));
}

const polygonBoxes = new WeakMap();

/** Find the entry and polygon index that contain a point. */
function locate(point, entries) {
  const inBox = (polygon) => {
    if (!polygonBoxes.has(polygon)) polygonBoxes.set(polygon, ringBbox(polygon[0]));
    const [x0, y0, x1, y1] = polygonBoxes.get(polygon);
    return point[0] >= x0 && point[0] <= x1 && point[1] >= y0 && point[1] <= y1;
  };
  for (const [code, entry] of entries) {
    const index = entry.polygons.findIndex((polygon) => inBox(polygon) && pointInPolygon(point, polygon));
    if (index !== -1) return { code, index };
  }
  return null;
}

/**
 * Sample points inside a ring on an n-by-n grid over its bounding box.
 * @param {number[][]} ring
 * @param {number} n
 * @returns {number[][]}
 */
export function samplePoints(ring, n) {
  if (!Array.isArray(ring) || !Number.isInteger(n) || n < 1) {
    throw new TypeError('`ring` must be a ring and `n` a positive integer.');
  }
  const [x0, y0, x1, y1] = ringBbox(ring);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      // Irrational-ish offsets keep samples off grid-aligned vertices and edges.
      const point = [x0 + ((x1 - x0) * (i + 0.382)) / n, y0 + ((y1 - y0) * (j + 0.618)) / n];
      if (pointInRing(point, ring)) out.push(point);
    }
  }
  return out;
}

/** Samples inside a breakaway area part: a 20 x 20 grid, finer for thin shapes. */
function areaSamples(region) {
  let samples = samplePoints(region, BREAKAWAY_GRID);
  if (samples.length < 40) samples = samplePoints(region, BREAKAWAY_GRID * 4);
  return [...samples, pointOnSurface(region)];
}

/**
 * Share of a breakaway area's sampled land that `code` owns. Samples over no
 * entry (sea, or slivers where the two layers were generalised differently
 * along a coast) are not counted.
 * @returns {number}
 */
function ownedShare(polygons, code, entries) {
  let owned = 0;
  let total = 0;
  for (const polygon of polygons) {
    for (const point of areaSamples(polygon[0])) {
      const found = locate(point, entries);
      if (found === null) continue;
      total += 1;
      if (found.code === code) owned += 1;
    }
  }
  return total === 0 ? 0 : owned / total;
}

/**
 * Give one breakaway/disputed area to the entry its ruling names. Every part
 * of the area is sampled; wherever a real share of it (not a sliver from the
 * two layers' different generalisation) lies in another entry, that land is
 * moved: the whole polygon part when the part *is* the area (equal area and
 * inside it), otherwise a cut along the area's boundary. Afterwards the ruled
 * entry must own at least BREAKAWAY_MIN_SHARE of the area, or the build stops.
 */
function applyBreakaway(feature, entries) {
  const name = feature.properties.BRK_NAME;
  if (!Object.hasOwn(BREAKAWAY_RULINGS, name)) {
    throw new RangeError(`Breakaway area \`${name}\` has no row in BREAKAWAY_RULINGS: escalate it for a ruling.`);
  }
  const target = BREAKAWAY_RULINGS[name].code;
  if (!entries.has(target)) throw new RangeError(`Ruling for \`${name}\` names \`${target}\`, which has no geometry.`);
  const polygons = featurePolygons(feature);
  for (const polygon of polygons) {
    const region = polygon[0];
    const samples = areaSamples(region);
    const groups = new Map();
    for (const point of samples) {
      const found = locate(point, entries);
      if (found === null || found.code === target) continue;
      const groupKey = `${found.code}|${found.index}`;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(point);
    }
    const ordered = [...groups.values()].sort((x, y) => y.length - x.length);
    for (const points of ordered) {
      if (points.length < BREAKAWAY_SLIVER_SHARE * samples.length) continue;
      // Earlier moves may have shifted polygon indices, so locate again.
      const probe = points[Math.floor(points.length / 2)];
      const found = locate(probe, entries);
      if (found === null || found.code === target) continue;
      const source = entries.get(found.code);
      const part = source.polygons[found.index];
      const ratio = Math.abs(doubleArea(part[0])) / Math.abs(doubleArea(region));
      const partSamples = areaSamples(part[0]);
      const inside = partSamples.filter((point) => pointInRing(point, region)).length / partSamples.length;
      if (part.length === 1 && ratio > 0.9 && ratio < 1.1 && inside >= 0.9) {
        source.polygons.splice(found.index, 1);
        entries.get(target).polygons.push(part);
        continue;
      }
      if (part.length !== 1) throw new RangeError(`Cannot cut \`${name}\` out of a polygon with holes.`);
      const [cutInside, cutOutside] = cutRing(part[0], region, probe);
      source.polygons[found.index] = [cutOutside];
      entries.get(target).polygons.push([cutInside]);
    }
  }
  const share = ownedShare(polygons, target, entries);
  if (share < BREAKAWAY_MIN_SHARE) {
    throw new RangeError(`Breakaway area \`${name}\` is only ${(share * 100).toFixed(1)}% \`${target}\` after applying its ruling.`);
  }
}

function densify(ring, step) {
  const out = [];
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k < n; k += 1) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/** Where the region boundary p->q leaves or enters `outer`, snapped to an existing vertex. */
function snapCrossing(p, q, outer, preferNearQ) {
  let bestIndex = -1;
  let bestT = preferNearQ ? -1 : 2;
  for (let i = 0; i < outer.length; i += 1) {
    const a = outer[i];
    const b = outer[(i + 1) % outer.length];
    const hit = segmentIntersection(p, q, a, b);
    if (hit === null) continue;
    const [t, u] = hit;
    if (preferNearQ ? t > bestT : t < bestT) {
      bestT = t;
      bestIndex = u < 0.5 ? i : (i + 1) % outer.length;
    }
  }
  if (bestIndex !== -1) return bestIndex;
  let nearest = 0;
  let nearestDistance = Infinity;
  for (let i = 0; i < outer.length; i += 1) {
    const d = Math.hypot(outer[i][0] - p[0], outer[i][1] - p[1]);
    if (d < nearestDistance) {
      nearestDistance = d;
      nearest = i;
    }
  }
  return nearest;
}

/**
 * Split `outer` in two along the stretch of `region`'s boundary that runs
 * through its interior. New vertices are only on the cut; the cut's ends snap
 * to existing vertices of `outer`, so borders shared with neighbours stay exact.
 * @returns {[number[][], number[][]]} [part containing `probe`, the rest]
 */
function cutRing(outer, region, probe) {
  const points = densify(region, CUT_DENSIFY_DEG);
  const deep = points.map((p) => pointInRing(p, outer) && distanceToRing(p, outer) > CUT_BOUNDARY_EPS_DEG);
  const start = deep.indexOf(false);
  if (start === -1) throw new RangeError('Breakaway area lies wholly inside its parent; a hole is not supported.');
  const n = points.length;
  let best = null;
  let bestLength = 0;
  for (let i = 0; i < n; i += 1) {
    const at = (start + i) % n;
    if (!deep[at] || deep[(at - 1 + n) % n]) continue;
    let length = 0;
    let end = at;
    while (deep[(end + 1) % n]) {
      length += Math.hypot(points[(end + 1) % n][0] - points[end][0], points[(end + 1) % n][1] - points[end][1]);
      end = (end + 1) % n;
    }
    if (length > bestLength) {
      bestLength = length;
      best = [at, end];
    }
  }
  if (best === null) throw new RangeError('Breakaway area boundary never runs through its parent.');
  const [first, last] = best;
  const run = [];
  for (let i = first; ; i = (i + 1) % n) {
    run.push(points[i]);
    if (i === last) break;
  }
  const ia = snapCrossing(points[(first - 1 + n) % n], points[first], outer, true);
  const ib = snapCrossing(points[last], points[(last + 1) % n], outer, false);
  const walk = (from, to) => {
    const out = [];
    for (let i = from; ; i = (i + 1) % outer.length) {
      out.push(outer[i]);
      if (i === to) break;
    }
    return out;
  };
  const ringA = [...walk(ia, ib), ...[...run].reverse()];
  const ringB = [...walk(ib, ia), ...run];
  const [inside, outside] = pointInRing(probe, ringA) ? [ringA, ringB] : [ringB, ringA];
  if (!pointInRing(probe, inside) || doubleArea(inside) <= 0 || doubleArea(outside) <= 0) {
    throw new RangeError('Cutting a breakaway area produced an invalid ring.');
  }
  return [inside, outside];
}

// ---- Step 4: per-file preparation ----

/**
 * Wrap a longitude into [centre - 180, centre + 180).
 * @param {number} lon
 * @param {number} centreLon
 * @returns {number}
 */
export function wrapLongitude(lon, centreLon) {
  if (!Number.isFinite(lon) || !Number.isFinite(centreLon)) {
    throw new TypeError('`lon` and `centreLon` must be finite numbers.');
  }
  let out = lon;
  while (out < centreLon - 180) out += 360;
  while (out >= centreLon + 180) out -= 360;
  return out;
}

/**
 * Re-join polygons that Natural Earth cut along the antimeridian: drop the
 * edges on the seam and reconnect the open chains across it.
 * @param {number[][][]} rings oriented rings, longitudes already wrapped
 * @param {number} seamLon 180 or -180
 * @returns {number[][][]}
 */
function stitchSeam(rings, seamLon) {
  const onSeam = (p) => Math.abs(p[0] - seamLon) < SEAM_TOLERANCE_DEG;
  const kept = [];
  const chains = [];
  for (const ring of rings) {
    const n = ring.length;
    const seamEdge = (i) => onSeam(ring[i]) && onSeam(ring[(i + 1) % n]);
    if (!ring.some((_, i) => seamEdge(i))) {
      kept.push(ring);
      continue;
    }
    const snapped = ring.map((p) => (onSeam(p) ? [seamLon, p[1]] : p));
    let begin = -1;
    for (let i = 0; i < n; i += 1) {
      if (seamEdge((i - 1 + n) % n) && !seamEdge(i)) {
        begin = i;
        break;
      }
    }
    if (begin === -1) continue; // the ring is all seam
    // `begin` follows a seam edge, so walking n edges ends on one too.
    let chain = null;
    for (let k = 0; k < n; k += 1) {
      const i = (begin + k) % n;
      if (seamEdge(i)) {
        if (chain !== null) {
          chain.push(snapped[i]);
          chains.push(chain);
          chain = null;
        }
        continue;
      }
      if (chain === null) chain = [];
      chain.push(snapped[i]);
    }
  }
  if (chains.length === 0) return kept;

  // Link every chain end to the nearest unused chain start on the seam.
  const used = new Set();
  const next = new Array(chains.length);
  chains.forEach((chain, c) => {
    const end = chain[chain.length - 1];
    let best = -1;
    let bestScore = Infinity;
    chains.forEach((other, o) => {
      if (used.has(o)) return;
      const gap = Math.abs(other[0][1] - end[1]);
      const score = gap + (o === c ? 1e-9 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = o;
      }
    });
    if (best === -1 || bestScore > SEAM_MAX_GAP_DEG) {
      throw new RangeError('Could not stitch a polygon across the antimeridian.');
    }
    used.add(best);
    next[c] = best;
  });
  const visited = new Set();
  chains.forEach((_, c) => {
    if (visited.has(c)) return;
    const ring = [];
    for (let at = c; !visited.has(at); at = next[at]) {
      visited.add(at);
      ring.push(...chains[at]);
    }
    const open = openRing(ring);
    if (open.length >= 3) kept.push(open);
  });
  return kept;
}

/**
 * Remove edges shared by two rings of the same entry and re-chain the rest.
 * @param {number[][][]} rings oriented rings (outer CCW, holes CW)
 * @returns {number[][][]}
 */
function dissolve(rings) {
  const edges = [];
  const live = new Map();
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const forward = `${key(a)}>${key(b)}`;
      const backward = `${key(b)}>${key(a)}`;
      const twins = live.get(backward);
      if (twins && twins.length > 0) {
        edges[twins.pop()].dead = true;
        continue;
      }
      edges.push({ a, b, dead: false });
      if (!live.has(forward)) live.set(forward, []);
      live.get(forward).push(edges.length - 1);
    }
  }
  const outgoing = new Map();
  edges.forEach((edge, index) => {
    if (edge.dead) return;
    const from = key(edge.a);
    if (!outgoing.has(from)) outgoing.set(from, []);
    outgoing.get(from).push(index);
  });
  const usedEdges = new Set();
  const out = [];
  edges.forEach((edge, index) => {
    if (edge.dead || usedEdges.has(index)) return;
    const ring = [];
    let at = index;
    while (at !== undefined && !usedEdges.has(at)) {
      usedEdges.add(at);
      ring.push(edges[at].a);
      const candidates = outgoing.get(key(edges[at].b)) ?? [];
      at = candidates.find((candidate) => !usedEdges.has(candidate));
    }
    const open = openRing(ring);
    if (open.length >= 3 && doubleArea(open) !== 0) out.push(open);
  });
  return out;
}

// ---- Projections ----

const EE = { A1: 1.340264, A2: -0.081106, A3: 0.000893, A4: 0.003796, M: Math.sqrt(3) / 2 };
const RAD = Math.PI / 180;

/**
 * Build the projection for one geometry file, from degrees to km.
 * @param {{projection: string, centre: number[]}} spec
 * @returns {(lon: number, lat: number) => number[]}
 */
export function makeProjection(spec) {
  if (!spec || !Array.isArray(spec.centre) || spec.centre.length !== 2) {
    throw new TypeError('`spec` must have a `centre` of [lon, lat].');
  }
  const [lon0, lat0] = spec.centre;
  if (spec.projection === 'laea') {
    const sinPhi0 = Math.sin(lat0 * RAD);
    const cosPhi0 = Math.cos(lat0 * RAD);
    return (lon, lat) => {
      const lambda = (wrapLongitude(lon, lon0) - lon0) * RAD;
      const phi = lat * RAD;
      const cosC = sinPhi0 * Math.sin(phi) + cosPhi0 * Math.cos(phi) * Math.cos(lambda);
      const k = Math.sqrt(2 / (1 + cosC));
      return [
        EARTH_RADIUS_KM * k * Math.cos(phi) * Math.sin(lambda),
        EARTH_RADIUS_KM * k * (cosPhi0 * Math.sin(phi) - sinPhi0 * Math.cos(phi) * Math.cos(lambda))
      ];
    };
  }
  if (spec.projection === 'equal-earth') {
    return (lon, lat) => {
      const lambda = (lon - lon0) * RAD;
      const theta = Math.asin(EE.M * Math.sin(lat * RAD));
      const t2 = theta * theta;
      const t6 = t2 * t2 * t2;
      const x = (2 * Math.sqrt(3) * lambda * Math.cos(theta))
        / (3 * (9 * EE.A4 * t6 * t2 + 7 * EE.A3 * t6 + 3 * EE.A2 * t2 + EE.A1));
      const y = theta * (EE.A1 + EE.A2 * t2 + t6 * (EE.A3 + EE.A4 * t2));
      return [EARTH_RADIUS_KM * x, EARTH_RADIUS_KM * y];
    };
  }
  throw new RangeError(`Unknown projection \`${spec.projection}\`.`);
}

// ---- Step 5: shared arcs, simplification, quantisation ----

/**
 * Visvalingam-Whyatt: drop interior points whose effective triangle area is
 * below `tolerance`. Endpoints always stay; closed arcs keep at least 4 points.
 * @param {number[][]} points
 * @param {number} tolerance
 * @param {boolean} closed first point repeated as last
 * @returns {number[][]}
 */
export function simplifyVisvalingam(points, tolerance, closed) {
  if (!Array.isArray(points)) throw new TypeError('`points` must be an array.');
  if (typeof tolerance !== 'number' || Number.isNaN(tolerance) || tolerance < 0) throw new RangeError('`tolerance` must be a number >= 0 (Infinity allowed).');
  const n = points.length;
  const minimum = closed ? 4 : 2;
  if (n <= minimum) return points;
  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  const area = new Float64Array(n);
  const triangle = (i) => Math.abs(
    (points[prev[i]][0] - points[i][0]) * (points[next[i]][1] - points[i][1])
    - (points[next[i]][0] - points[i][0]) * (points[prev[i]][1] - points[i][1])
  ) / 2;
  // A binary min-heap of indices ordered by (area, index), for determinism.
  const heap = [];
  const position = new Int32Array(n).fill(-1);
  const less = (a, b) => area[a] < area[b] || (area[a] === area[b] && a < b);
  const swap = (i, j) => {
    [heap[i], heap[j]] = [heap[j], heap[i]];
    position[heap[i]] = i;
    position[heap[j]] = j;
  };
  const up = (i) => {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!less(heap[i], heap[parent])) break;
      swap(i, parent);
      i = parent;
    }
  };
  const down = (i) => {
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let smallest = i;
      if (l < heap.length && less(heap[l], heap[smallest])) smallest = l;
      if (r < heap.length && less(heap[r], heap[smallest])) smallest = r;
      if (smallest === i) break;
      swap(i, smallest);
      i = smallest;
    }
  };
  const remove = (i) => {
    const at = position[i];
    const last = heap.pop();
    position[i] = -1;
    if (at < heap.length) {
      heap[at] = last;
      position[last] = at;
      up(at);
      down(position[last]);
    }
  };
  for (let i = 0; i < n; i += 1) {
    prev[i] = i - 1;
    next[i] = i + 1;
  }
  for (let i = 1; i < n - 1; i += 1) {
    area[i] = triangle(i);
    heap.push(i);
    position[i] = heap.length - 1;
    up(heap.length - 1);
  }
  let remaining = n;
  let floor = 0;
  while (heap.length > 0 && remaining > minimum) {
    const i = heap[0];
    if (Math.max(area[i], floor) >= tolerance) break;
    floor = Math.max(floor, area[i]);
    remove(i);
    remaining -= 1;
    const p = prev[i];
    const q = next[i];
    next[p] = q;
    prev[q] = p;
    for (const j of [p, q]) {
      if (j <= 0 || j >= n - 1) continue;
      area[j] = triangle(j);
      remove(j);
      heap.push(j);
      position[j] = heap.length - 1;
      up(heap.length - 1);
    }
  }
  const out = [];
  for (let i = 0; i !== n; i = next[i]) {
    out.push(points[i]);
    if (i === n - 1) break;
  }
  return out;
}

/** Sign of the turn a->b->c (integer coordinates, so exact). */
function orientation(a, b, c) {
  const value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

/** True when segments a-b and c-d cross at a point that is not a shared endpoint. */
function segmentsCross(a, b, c, d) {
  const same = (p, q) => p[0] === q[0] && p[1] === q[1];
  if (same(a, c) || same(a, d) || same(b, c) || same(b, d)) return false;
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0) return true;
  const onSegment = (p, q, r) => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0])
    && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  return (o1 === 0 && onSegment(a, b, c)) || (o2 === 0 && onSegment(a, b, d))
    || (o3 === 0 && onSegment(c, d, a)) || (o4 === 0 && onSegment(c, d, b));
}

/**
 * Ids of arcs that cross another arc or themselves, found with a uniform grid.
 * @param {Map<string, number[][]>} arcs quantised arcs
 * @returns {Set<string>}
 */
function findCrossingArcs(arcs) {
  const segments = [];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [id, points] of arcs) {
    for (let i = 0; i + 1 < points.length; i += 1) {
      segments.push({ id, i, a: points[i], b: points[i + 1], n: points.length - 1 });
      for (const p of [points[i], points[i + 1]]) {
        x0 = Math.min(x0, p[0]);
        y0 = Math.min(y0, p[1]);
        x1 = Math.max(x1, p[0]);
        y1 = Math.max(y1, p[1]);
      }
    }
  }
  const cell = Math.max(1, Math.max(x1 - x0, y1 - y0) / 512);
  const grid = new Map();
  segments.forEach((segment, index) => {
    const cx0 = Math.floor((Math.min(segment.a[0], segment.b[0]) - x0) / cell);
    const cx1 = Math.floor((Math.max(segment.a[0], segment.b[0]) - x0) / cell);
    const cy0 = Math.floor((Math.min(segment.a[1], segment.b[1]) - y0) / cell);
    const cy1 = Math.floor((Math.max(segment.a[1], segment.b[1]) - y0) / cell);
    for (let cx = cx0; cx <= cx1; cx += 1) {
      for (let cy = cy0; cy <= cy1; cy += 1) {
        const cellKey = cx * 1_000_003 + cy;
        if (!grid.has(cellKey)) grid.set(cellKey, []);
        grid.get(cellKey).push(index);
      }
    }
  });
  const crossing = new Set();
  const tested = new Set();
  for (const members of grid.values()) {
    for (let p = 0; p < members.length; p += 1) {
      for (let q = p + 1; q < members.length; q += 1) {
        const s = segments[members[p]];
        const t = segments[members[q]];
        if (s.id === t.id && Math.abs(s.i - t.i) <= 1) continue;
        const pairKey = members[p] * segments.length + members[q];
        if (tested.has(pairKey)) continue;
        tested.add(pairKey);
        if (segmentsCross(s.a, s.b, t.a, t.b)) {
          crossing.add(s.id);
          crossing.add(t.id);
        }
      }
    }
  }
  return crossing;
}

/**
 * Turn projected rings into shared arcs, simplify each arc once, quantise, and
 * rebuild the rings. Also reports which entries share an arc.
 * @param {{code: string, ring: number[][]}[]} rings projected rings (km), open
 * @param {{toleranceKm2: number, unitsPerKm: number}} spec
 * @param {number[]} origin [x0, y1] in km: top-left corner of the file
 * @param {{bbox: number[], areaKm2: number}[]} protectedAreas projected breakaway areas
 * @returns {{rings: Map<string, number[][][]>, adjacency: Set<string>}}
 */
function buildArcs(rings, spec, origin, protectedAreas) {
  const edgeOwners = new Map();
  const vertexRings = new Map();
  rings.forEach(({ ring }, r) => {
    for (let i = 0; i < ring.length; i += 1) {
      const a = key(ring[i]);
      const b = key(ring[(i + 1) % ring.length]);
      const edge = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (!edgeOwners.has(edge)) edgeOwners.set(edge, []);
      const owners = edgeOwners.get(edge);
      if (!owners.includes(r)) owners.push(r);
      if (!vertexRings.has(a)) vertexRings.set(a, new Set());
      vertexRings.get(a).add(r);
    }
  });
  const ownersOf = (ring, i) => {
    const a = key(ring[i]);
    const b = key(ring[(i + 1) % ring.length]);
    return edgeOwners.get(a < b ? `${a}|${b}` : `${b}|${a}`);
  };
  const ringArea = rings.map(({ ring }) => Math.abs(doubleArea(ring)) / 2);

  const arcs = new Map();
  const ringArcs = rings.map(({ ring }) => {
    const n = ring.length;
    const owners = ring.map((_, i) => ownersOf(ring, i).join(','));
    const isJunction = (i) => {
      const before = owners[(i - 1 + n) % n];
      if (before !== owners[i]) return true;
      return vertexRings.get(key(ring[i])).size !== owners[i].split(',').length;
    };
    const cuts = [];
    for (let i = 0; i < n; i += 1) if (isJunction(i)) cuts.push(i);
    const pieces = [];
    if (cuts.length === 0) {
      // A closed arc: start at the smallest vertex key so both users agree.
      let start = 0;
      for (let i = 1; i < n; i += 1) if (key(ring[i]) < key(ring[start])) start = i;
      const forward = [];
      for (let k = 0; k <= n; k += 1) forward.push(ring[(start + k) % n]);
      pieces.push(forward);
    } else {
      for (let c = 0; c < cuts.length; c += 1) {
        const from = cuts[c];
        const to = cuts[(c + 1) % cuts.length];
        const piece = [];
        for (let i = from; ; i = (i + 1) % n) {
          piece.push(ring[i]);
          if (piece.length > 1 && i === to) break;
        }
        pieces.push(piece);
      }
    }
    return pieces.map((piece) => {
      const forwardKey = `${key(piece[0])}>${key(piece[1])}>${key(piece[piece.length - 1])}>${piece.length}`;
      const last = piece.length - 1;
      const backwardKey = `${key(piece[last])}>${key(piece[last - 1])}>${key(piece[0])}>${piece.length}`;
      // A closed arc read backwards starts with the same vertex; compare its second.
      const reversed = backwardKey < forwardKey;
      const id = reversed ? backwardKey : forwardKey;
      if (!arcs.has(id)) arcs.set(id, { points: reversed ? [...piece].reverse() : piece, users: [] });
      return { id, reversed };
    });
  });
  rings.forEach((_, r) => {
    for (const { id } of ringArcs[r]) arcs.get(id).users.push(r);
  });

  const scale = spec.unitsPerKm;
  const quantise = ([x, y]) => [Math.round((x - origin[0]) * scale), Math.round((origin[1] - y) * scale)];
  const tolerances = new Map();
  for (const [id, arc] of arcs) {
    const smallest = Math.min(...arc.users.map((r) => ringArea[r]));
    let tolerance = Math.min(spec.toleranceKm2, ARC_TOLERANCE_RING_SHARE * smallest);
    // Borders around a disputed area must stay finer than the area itself, or
    // a coarse file (world.json) would hand the area to the wrong side.
    const arcBox = ringBbox(arc.points);
    const isBorder = new Set(arc.users.map((r) => rings[r].code)).size > 1;
    for (const area of isBorder ? protectedAreas : []) {
      if (arcBox[0] <= area.bbox[2] && area.bbox[0] <= arcBox[2] && arcBox[1] <= area.bbox[3] && area.bbox[1] <= arcBox[3]) {
        tolerance = Math.min(tolerance, BREAKAWAY_TOLERANCE_SHARE * area.areaKm2);
      }
    }
    tolerances.set(id, tolerance);
  }
  const simplifyArc = (id) => {
    const { points } = arcs.get(id);
    const first = points[0];
    const last = points[points.length - 1];
    const closed = first[0] === last[0] && first[1] === last[1];
    const out = [];
    for (const point of simplifyVisvalingam(points, tolerances.get(id), closed).map(quantise)) {
      const tail = out[out.length - 1];
      if (!tail || tail[0] !== point[0] || tail[1] !== point[1]) out.push(point);
    }
    return out;
  };
  const finalArcs = new Map();
  for (const id of arcs.keys()) finalArcs.set(id, simplifyArc(id));
  // Simplifying arcs independently can make two of them cross (two coasts of
  // a narrow estuary, say). Re-simplify the arcs involved more gently. An arc
  // that still crosses unsimplified does so because of the integer grid (a thin
  // atoll folding onto itself), so it is collapsed to its simplest form instead.
  for (let round = 0; round < CROSSING_ROUNDS; round += 1) {
    const crossing = findCrossingArcs(finalArcs);
    if (crossing.size === 0) break;
    for (const id of [...crossing].sort()) {
      const tolerance = tolerances.get(id);
      const next = tolerance === 0 ? Infinity : round >= CROSSING_ROUNDS - 4 ? 0 : tolerance / 2;
      tolerances.set(id, next);
      finalArcs.set(id, simplifyArc(id));
    }
  }
  const stillCrossing = findCrossingArcs(finalArcs);
  if (stillCrossing.size > 0) {
    const owners = [...stillCrossing].map((id) => arcs.get(id).users.map((r) => rings[r].code).join('+'));
    throw new RangeError(`Arcs still cross after simplification: ${[...new Set(owners)].sort().join(', ')}.`);
  }

  const adjacency = new Set();
  for (const arc of arcs.values()) {
    const codes = [...new Set(arc.users.map((r) => rings[r].code))].sort();
    if (codes.length === 2) adjacency.add(codes.join('|'));
  }

  const out = new Map();
  rings.forEach(({ code }, r) => {
    const ring = [];
    for (const { id, reversed } of ringArcs[r]) {
      const points = reversed ? [...finalArcs.get(id)].reverse() : finalArcs.get(id);
      for (const point of points) {
        const tail = ring[ring.length - 1];
        if (!tail || tail[0] !== point[0] || tail[1] !== point[1]) ring.push(point);
      }
    }
    const open = removeSpikes(openRing(ring));
    if (open.length < 3 || doubleArea(open) === 0) return;
    if (!out.has(code)) out.set(code, []);
    out.get(code).push([...open, open[0]]);
  });
  return { rings: out, adjacency };
}

/**
 * Keep a quantised label inside its rings. If rounding or simplification put it
 * outside, use the integer point inside the largest ring nearest that ring's
 * surface point. A ring too small to hold any interior grid point (Vatican City
 * in world.json) gets its surface point rounded, which is within one unit of it.
 * @param {number[]} label integer [x, y]
 * @param {number[][][]} rings closed integer rings
 * @returns {number[]}
 */
export function placeLabel(label, rings) {
  if (!Array.isArray(label) || !Array.isArray(rings) || rings.length === 0) {
    throw new TypeError('`label` must be [x, y] and `rings` a non-empty array.');
  }
  if (pointInRings(label, rings)) return label;
  let largest = rings[0];
  for (const ring of rings) if (Math.abs(doubleArea(ring)) > Math.abs(doubleArea(largest))) largest = ring;
  const surface = pointOnSurface(largest.slice(0, -1));
  const rounded = [Math.round(surface[0]), Math.round(surface[1])];
  if (pointInRings(rounded, rings)) return rounded;
  const [bx0, by0, bx1, by1] = ringBbox(largest);
  const reach = LABEL_SEARCH_UNITS;
  let best = null;
  let bestDistance = Infinity;
  for (let x = Math.max(bx0, rounded[0] - reach); x <= Math.min(bx1, rounded[0] + reach); x += 1) {
    for (let y = Math.max(by0, rounded[1] - reach); y <= Math.min(by1, rounded[1] + reach); y += 1) {
      const d = Math.hypot(x - surface[0], y - surface[1]);
      if (d < bestDistance && pointInRings([x, y], rings)) {
        bestDistance = d;
        best = [x, y];
      }
    }
  }
  return best ?? rounded;
}

/**
 * Build one geometry file.
 * @param {Map<string, {polygons: number[][][][], label: number[]}>} entries
 * @param {string[]} codes entries in this file, sorted
 * @param {object} spec a GEOMETRY_FILES row
 * @param {number[][][]} [areas] breakaway-area rings in degrees, kept finely simplified
 * @returns {{file: object, adjacency: Set<string>}}
 */
export function buildFile(entries, codes, spec, areas = []) {
  if (!(entries instanceof Map)) throw new TypeError('`entries` must be a Map.');
  if (!Array.isArray(codes)) throw new TypeError('`codes` must be an array of codes.');
  if (!Array.isArray(areas)) throw new TypeError('`areas` must be an array of rings.');
  const project = makeProjection(spec);
  const [centreLon] = spec.centre;
  const wrap = spec.projection === 'laea';
  const seamLon = centreLon > 0 ? 180 : -180;

  const candidates = [];
  const labels = new Map();
  for (const code of codes) {
    const entry = entries.get(code);
    if (!entry) throw new RangeError(`\`${code}\` has no geometry.`);
    let rings = entry.polygons.flat();
    if (wrap) {
      rings = rings.map((ring) => ring.map(([lon, lat]) => [wrapLongitude(lon, centreLon), lat]));
      rings = stitchSeam(rings, seamLon);
    }
    rings = dissolve(rings);
    const km = rings.map((ring) => openRing(ring.map(([lon, lat]) => project(lon, lat))));
    for (const ring of km) if (ring.length >= 3) candidates.push({ code, ring, area: Math.abs(doubleArea(ring)) / 2 });
    labels.set(code, project(entry.label[0], entry.label[1]));
  }

  // Drop tiny islands, but never a ring that shares an edge with another entry
  // (an enclave and its hole must survive together).
  const edgeCodes = new Map();
  for (const { code, ring } of candidates) {
    for (let i = 0; i < ring.length; i += 1) {
      const a = key(ring[i]);
      const b = key(ring[(i + 1) % ring.length]);
      const edge = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (!edgeCodes.has(edge)) edgeCodes.set(edge, new Set());
      edgeCodes.get(edge).add(code);
    }
  }
  const largest = new Map();
  for (const { code, area } of candidates) largest.set(code, Math.max(largest.get(code) ?? 0, area));
  const projected = candidates.filter(({ code, ring, area }) => {
    if (area === largest.get(code) || area >= spec.minRingKm2 || area >= KEEP_RING_SHARE * largest.get(code)) return true;
    return ring.some((point, i) => {
      const a = key(point);
      const b = key(ring[(i + 1) % ring.length]);
      return edgeCodes.get(a < b ? `${a}|${b}` : `${b}|${a}`).size > 1;
    });
  });

  let x0 = Infinity;
  let y1 = -Infinity;
  for (const { ring } of projected) {
    for (const [x, y] of ring) {
      x0 = Math.min(x0, x);
      y1 = Math.max(y1, y);
    }
  }
  const origin = [Math.floor(x0), Math.ceil(y1)];
  const protectedAreas = areas.map((ring) => {
    const km = ring.map(([lon, lat]) => project(wrap ? wrapLongitude(lon, centreLon) : lon, lat));
    return { bbox: ringBbox(km), areaKm2: Math.abs(doubleArea(km)) / 2 };
  });
  const { rings, adjacency } = buildArcs(projected, spec, origin, protectedAreas);

  const scale = spec.unitsPerKm;
  const out = {};
  for (const code of codes) {
    const entryRings = rings.get(code);
    if (!entryRings || entryRings.length === 0) throw new RangeError(`\`${code}\` lost all its rings.`);
    let bx0 = Infinity;
    let by0 = Infinity;
    let bx1 = -Infinity;
    let by1 = -Infinity;
    for (const ring of entryRings) {
      for (const [x, y] of ring) {
        bx0 = Math.min(bx0, x);
        by0 = Math.min(by0, y);
        bx1 = Math.max(bx1, x);
        by1 = Math.max(by1, y);
      }
    }
    const [lx, ly] = labels.get(code);
    out[code] = {
      rings: entryRings,
      bbox: [bx0, by0, bx1, by1],
      label: placeLabel([Math.round((lx - origin[0]) * scale), Math.round((origin[1] - ly) * scale)], entryRings)
    };
  }
  const projection = {
    name: spec.projection,
    centre: spec.centre,
    radiusKm: EARTH_RADIUS_KM,
    origin,
    note: 'x = round((X - origin[0]) * scale), y = round((origin[1] - Y) * scale), with (X, Y) the projection in km; y grows downwards.'
  };
  return { file: { projection, scale, entries: out }, adjacency };
}

// ---- Step 6: neighbours ----

function toUnitVector([lon, lat]) {
  const phi = lat * RAD;
  const lambda = lon * RAD;
  return [Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi)];
}

/**
 * Symmetric neighbours: entries sharing an arc, plus, for islands (entries
 * with no land neighbour), the nearest `count` entries within `capKm`, or
 * the single nearest entry when none is that close.
 * @param {Map<string, {polygons: number[][][][]}>} entries
 * @param {Set<string>} adjacency `a|b` pairs that share an arc
 * @returns {{land: Record<string, string[]>, neighbours: Record<string, string[]>}}
 */
export function deriveNeighbours(entries, adjacency) {
  if (!(entries instanceof Map) || !(adjacency instanceof Set)) {
    throw new TypeError('`entries` must be a Map and `adjacency` a Set.');
  }
  const codes = [...entries.keys()].sort();
  const neighbours = new Map(codes.map((code) => [code, new Set()]));
  for (const pair of adjacency) {
    const [a, b] = pair.split('|');
    neighbours.get(a).add(b);
    neighbours.get(b).add(a);
  }

  const vectors = new Map();
  const caps = new Map();
  for (const code of codes) {
    const points = entries.get(code).polygons.flatMap((polygon) => polygon[0]).map(toUnitVector);
    const centre = points.reduce((sum, v) => [sum[0] + v[0], sum[1] + v[1], sum[2] + v[2]], [0, 0, 0]);
    const length = Math.hypot(...centre) || 1;
    const unit = centre.map((c) => c / length);
    const radius = Math.max(...points.map((v) => Math.acos(Math.min(1, v[0] * unit[0] + v[1] * unit[1] + v[2] * unit[2]))));
    vectors.set(code, Float64Array.from(points.flat()));
    caps.set(code, { unit, radius });
  }
  const capRad = MARITIME_NEIGHBOURS.capKm / EARTH_RADIUS_KM;
  const islands = codes.filter((code) => neighbours.get(code).size === 0);
  const land = Object.fromEntries(codes.map((code) => [code, [...neighbours.get(code)].sort()]));
  // Islands with nothing inside the cap's bounding test are searched in full.
  const remote = new Set(islands.filter((island) => {
    const a = caps.get(island);
    return !codes.some((other) => {
      if (other === island) return false;
      const b = caps.get(other);
      const between = Math.acos(Math.min(1, a.unit[0] * b.unit[0] + a.unit[1] * b.unit[1] + a.unit[2] * b.unit[2]));
      return between - a.radius - b.radius <= capRad;
    });
  }));
  for (const island of islands) {
    const a = caps.get(island);
    const va = vectors.get(island);
    const candidates = [];
    for (const other of codes) {
      if (other === island) continue;
      const b = caps.get(other);
      const between = Math.acos(Math.min(1, a.unit[0] * b.unit[0] + a.unit[1] * b.unit[1] + a.unit[2] * b.unit[2]));
      if (between - a.radius - b.radius > capRad && !remote.has(island)) continue;
      const vb = vectors.get(other);
      let best = -1;
      for (let i = 0; i < va.length; i += 3) {
        for (let j = 0; j < vb.length; j += 3) {
          const dot = va[i] * vb[j] + va[i + 1] * vb[j + 1] + va[i + 2] * vb[j + 2];
          if (dot > best) best = dot;
        }
      }
      const distance = Math.acos(Math.min(1, best));
      candidates.push({ other, distance });
    }
    candidates.sort((x, y) => x.distance - y.distance || (x.other < y.other ? -1 : 1));
    // Within the cap, up to `count`; a remote island (Saint Helena) still gets
    // its single nearest entry, so no list is ever empty.
    const withinCap = candidates.filter(({ distance }) => distance <= capRad);
    const chosen = withinCap.length > 0 ? withinCap.slice(0, MARITIME_NEIGHBOURS.count) : candidates.slice(0, 1);
    for (const { other } of chosen) {
      neighbours.get(island).add(other);
      neighbours.get(other).add(island);
    }
  }
  return { land, neighbours: Object.fromEntries(codes.map((code) => [code, [...neighbours.get(code)].sort()])) };
}

// ---- Whole build ----

/**
 * Serialise a geometry file with one entry per line.
 * @param {{projection: object, scale: number, entries: object}} file
 * @returns {string}
 */
export function serialiseGeometry(file) {
  if (!file || typeof file.entries !== 'object') throw new TypeError('`file` must have `entries`.');
  const rows = Object.keys(file.entries).sort().map((code) => `${JSON.stringify(code)}:${JSON.stringify(file.entries[code])}`);
  return `{"projection":${JSON.stringify(file.projection)},"scale":${JSON.stringify(file.scale)},"entries":{\n${rows.join(',\n')}\n}}\n`;
}

/**
 * Build every output file from the vendored inputs.
 * @param {string} [root] repository root
 * @returns {Map<string, string>} repo-relative path -> exact file text
 */
export function buildGeometry(root = ROOT) {
  return buildGeometryFull(root).outputs;
}

/**
 * Build every output file, and also return the derived neighbour maps (which
 * `scripts/build-map-meta.js` writes into `data/map-meta.json`).
 * @param {string} [root] repository root
 * @returns {{outputs: Map<string, string>, land: Record<string, string[]>, neighbours: Record<string, string[]>}}
 */
export function buildGeometryFull(root = ROOT) {
  if (typeof root !== 'string') throw new TypeError('`root` must be a path string.');
  const countriesLayer = readPinnedJson(NATURAL_EARTH.files.countries, root);
  const breakawayLayer = readPinnedJson(NATURAL_EARTH.files.breakaway, root);
  const { countries, meta } = JSON.parse(readFileSync(resolve(root, COUNTRIES_PATH), 'utf8'));
  const codes = new Set(countries.map((country) => country.code));
  const entries = assignEntries(countriesLayer, breakawayLayer, codes);
  const areas = breakawayLayer.features.flatMap((feature) => featurePolygons(feature).map((polygon) => polygon[0]));
  for (const code of codes) {
    if (!entries.has(code) || entries.get(code).polygons.length === 0) {
      throw new RangeError(`\`${code}\` has no Natural Earth geometry: draw it or list it in NOT_DRAWN.`);
    }
  }

  const outputs = new Map();
  for (const continent of meta.continents) {
    const spec = GEOMETRY_FILES[continent];
    if (!spec) throw new RangeError(`No GEOMETRY_FILES row for \`${continent}\`.`);
    const members = countries.filter((country) => country.continent === continent).map((country) => country.code);
    const { file } = buildFile(entries, members, spec, areas);
    outputs.set(`${OUTPUT_DIR}/${continent}.json`, serialiseGeometry(file));
  }
  const { file: world, adjacency } = buildFile(entries, [...codes].sort(), GEOMETRY_FILES.world, areas);
  outputs.set(`${OUTPUT_DIR}/world.json`, serialiseGeometry(world));

  const { land, neighbours } = deriveNeighbours(entries, adjacency);
  return { outputs, land, neighbours };
}

/**
 * True when this module is the entry point, also through a symlink.
 * @returns {boolean}
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const outputs = buildGeometry();
  if (process.argv.includes('--check')) {
    let stale = false;
    for (const [path, text] of outputs) {
      let current = '';
      try {
        current = readFileSync(resolve(ROOT, path), 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (current !== text) {
        console.error(`${path} is out of date: run \`node scripts/build-geometry.js\`.`);
        stale = true;
      }
    }
    if (stale) process.exit(1);
    console.log('data/geometry is up to date.');
  } else {
    for (const [path, text] of outputs) {
      writeFileSync(resolve(ROOT, path), text);
      console.log(`Wrote ${path} (${(Buffer.byteLength(text) / 1024).toFixed(1)} KB).`);
    }
  }
}
