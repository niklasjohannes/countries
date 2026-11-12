// Pure helpers for test mode's maps (PLAN decision 13): which geometry and
// frame each question and the results map use. No DOM, no fetch.
//
//   - Every question is asked on the entry's own continent frame
//     (`FRAME_LEVEL_CONTINENT`), whatever the scope.
//   - The results map uses the continent frame for a continent or sub-region
//     scope, and `world.json` for "All".

import { getPxPerUnit, largestRingBbox } from './map.js';
import { CONTINENTS, SUBREGIONS } from './srs.js';
import { isPlainObject } from './validate.js';

/** Geometry key of the world file (`data/geometry/world.json`). */
export const WORLD_KEY = 'world';

/** An entry is small when both sides are under this many CSS px (as in `map-meta.json`). */
export const SMALL_SIDE_PX = 12;

/**
 * CSS px size assumed for the results map before it has a layout (about a
 * phone's results box: 375 px less the gutters wide, `min(60vw, 18rem)` high).
 */
export const FALLBACK_RESULTS_VIEWPORT_PX = Object.freeze({ width: 335, height: 225 });

/**
 * The continent a scope sits in, or `null` for "All".
 *
 * @param {{ continent?: string | null, subregion?: string | null }} filter The scope.
 * @returns {string | null} A continent slug, or `null`.
 */
export function getScopeContinent(filter) {
  if (!isPlainObject(filter)) {
    throw new TypeError('`filter` must be an object `{ continent, subregion }`.');
  }
  const continent = filter.continent ?? null;
  const subregion = filter.subregion ?? null;
  if (continent !== null && !CONTINENTS.includes(continent)) {
    throw new RangeError(`\`filter.continent\` must be one of ${CONTINENTS.join(', ')}, or null.`);
  }
  if (subregion !== null && !Object.hasOwn(SUBREGIONS, subregion)) {
    throw new RangeError('`filter.subregion` must be one of the 22 known sub-regions, or null.');
  }
  if (subregion !== null) {
    if (continent !== null && SUBREGIONS[subregion] !== continent) {
      throw new RangeError('`filter.subregion` must belong to `filter.continent`.');
    }
    return SUBREGIONS[subregion];
  }
  return continent;
}

/**
 * Which geometry file the results map draws.
 *
 * @param {{ continent?: string | null, subregion?: string | null }} filter The scope.
 * @returns {string} A continent slug, or `WORLD_KEY` for "All".
 */
export function getResultsGeometryKey(filter) {
  return getScopeContinent(filter) ?? WORLD_KEY;
}

/**
 * The tight `[x0, y0, x1, y1]` box around every entry of a geometry file.
 *
 * @param {{ entries: Object<string, { bbox: number[] }> }} geometry A parsed geometry file.
 * @returns {[number, number, number, number]} The box.
 */
export function getEntriesFrame(geometry) {
  if (!isPlainObject(geometry) || !isPlainObject(geometry.entries)) {
    throw new TypeError('`geometry` must be a geometry file object with an `entries` object.');
  }
  const boxes = Object.values(geometry.entries).map((entry) => entry.bbox);
  if (boxes.length === 0) {
    throw new RangeError('`geometry.entries` must not be empty.');
  }
  return [
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])),
    Math.max(...boxes.map((box) => box[3]))
  ];
}

/**
 * A `map-meta`-shaped object for the world file, which has no meta of its own:
 * `smallInContinent` is true for an entry whose bbox, at the real scale of the
 * map on screen (`getPxPerUnit(frame, viewportPx)`), is under `SMALL_SIDE_PX`
 * on both sides (measured on its largest ring). Nothing is tappable (the results map is not interactive) and
 * there are no neighbours.
 *
 * @param {{ entries: object }} geometry The parsed `world.json`.
 * @param {[number, number, number, number]} frame The frame the map is drawn at.
 * @param {{ width: number, height: number }} viewportPx CSS px size of the map's `<svg>`.
 * @returns {{ frames: object, entries: Object<string, object> }} The meta.
 */
export function deriveWorldMeta(geometry, frame, viewportPx) {
  const pxPerUnit = getPxPerUnit(frame, viewportPx);
  const entries = {};
  for (const [code, entry] of Object.entries(geometry.entries)) {
    // The largest ring, not the union bbox: `world.json` is not stitched at the
    // antimeridian, so Fiji's and Kiribati's union bboxes span the whole map.
    const [bx0, by0, bx1, by1] = largestRingBbox(entry.rings);
    const small = (bx1 - bx0) * pxPerUnit < SMALL_SIDE_PX && (by1 - by0) * pxPerUnit < SMALL_SIDE_PX;
    entries[code] = { neighbours: [], small, tappable: false, smallInContinent: small };
  }
  return { frames: { [WORLD_KEY]: [...frame] }, entries };
}
