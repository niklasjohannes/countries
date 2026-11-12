// Frame and small-entry rules shared by `scripts/build-geometry.js` (which
// needs the frames to choose each file's context land) and
// `scripts/build-map-meta.js`. See the header of build-map-meta.js for the rules.

import { getPxPerUnit, largestRingBbox } from '../js/map.js';
import { makeProjection } from './projection.js';
import { FRAME_OVERRIDES } from './frame-overrides.js';

/** Padding added to each side of a frame, as a share of the box's longer side. */
export const FRAME_PADDING = 0.04;
/**
 * Phone-shaped viewport, in CSS px, that frames are measured against for the
 * `small` rule: the real size of `.map-svg` in practice mode at 375 × 812
 * (the 375 px screen less the view gutters and the map's border; the height is
 * what the flex column leaves the map, rounded down). Tall frames are
 * height-limited there, so measuring as if every frame were 375 px wide made
 * them look bigger than they are.
 */
export const SMALL_VIEWPORT_PX = Object.freeze({ width: 331, height: 400 });
/** An entry is small when both sides of its bbox are under this many CSS px. */
export const SMALL_LIMIT_PX = 12;

export { largestRingBbox };

// ---- Geometry helpers ----

/**
 * Bounding box, in a file's coordinate space, of a lon/lat box (its edges
 * sampled every half degree).
 * @param {{projection: {name: string, centre: number[], origin: number[]}, scale: number}} file
 * @param {number[]} box [west, south, east, north] in degrees
 * @returns {number[]} [x0, y0, x1, y1]
 */
export function projectLonLatBox(file, box) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) {
    throw new TypeError('`box` must be [west, south, east, north] in degrees.');
  }
  const [west, south, east, north] = box;
  if (west >= east || south >= north) throw new RangeError('`box` must have west < east and south < north.');
  const project = makeProjection({ projection: file.projection.name, centre: file.projection.centre });
  const [originX, originY] = file.projection.origin;
  const out = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (lon, lat) => {
    const [X, Y] = project(lon, lat);
    const x = (X - originX) * file.scale;
    const y = (originY - Y) * file.scale;
    out[0] = Math.min(out[0], x);
    out[1] = Math.min(out[1], y);
    out[2] = Math.max(out[2], x);
    out[3] = Math.max(out[3], y);
  };
  for (let lon = west; lon <= east; lon += 0.5) {
    add(lon, south);
    add(lon, north);
  }
  for (let lat = south; lat <= north; lat += 0.5) {
    add(west, lat);
    add(east, lat);
  }
  add(east, south);
  add(east, north);
  return out;
}

const intersect = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];

// ---- Frames ----

/**
 * Padded frame of a set of entries in one file.
 * @param {{projection: object, scale: number, entries: object}} file
 * @param {string[]} codes quizzed entries of the continent or sub-region
 * @param {Record<string, number[]>} [clip] lon/lat boxes that crop single entries
 * @returns {number[]} [x0, y0, x1, y1] integers
 */
export function computeFrame(file, codes, clip = {}) {
  if (!Array.isArray(codes) || codes.length === 0) throw new TypeError('`codes` must be a non-empty array.');
  for (const code of Object.keys(clip)) {
    if (!codes.includes(code)) throw new RangeError(`Frame override clips \`${code}\`, which is not in this frame.`);
  }
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const code of codes) {
    const entry = file.entries[code];
    if (!entry) throw new RangeError(`\`${code}\` is missing from its geometry file.`);
    let bbox = entry.bbox;
    if (clip[code]) {
      bbox = intersect(bbox, projectLonLatBox(file, clip[code]));
      if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) throw new RangeError(`The clip box of \`${code}\` misses the entry.`);
    }
    box[0] = Math.min(box[0], bbox[0]);
    box[1] = Math.min(box[1], bbox[1]);
    box[2] = Math.max(box[2], bbox[2]);
    box[3] = Math.max(box[3], bbox[3]);
  }
  const pad = FRAME_PADDING * Math.max(box[2] - box[0], box[3] - box[1]);
  return [Math.round(box[0] - pad), Math.round(box[1] - pad), Math.round(box[2] + pad), Math.round(box[3] + pad)];
}

/**
 * True when the box, drawn in a frame on the phone-shaped viewport
 * (`SMALL_VIEWPORT_PX`, scale from `getPxPerUnit`), is under 12 × 12 CSS px.
 * @param {number[]} bbox [x0, y0, x1, y1] of the entry's largest ring
 * @param {number[]} frame [x0, y0, x1, y1]
 * @param {{width: number, height: number}} [viewport] CSS px size of the map
 * @returns {boolean}
 */
export function isSmall(bbox, frame, viewport = SMALL_VIEWPORT_PX) {
  if (!(frame[2] - frame[0] > 0) || !(frame[3] - frame[1] > 0)) throw new RangeError('`frame` must have a positive width and height.');
  const pxPerUnit = getPxPerUnit(frame, viewport);
  return (bbox[2] - bbox[0]) * pxPerUnit < SMALL_LIMIT_PX && (bbox[3] - bbox[1]) * pxPerUnit < SMALL_LIMIT_PX;
}

/**
 * Frames of every continent and sub-region, from geometry files.
 * @param {{code: string, continent: string, subregion: string, quizzed: boolean}[]} countries
 * @param {Record<string, {entries: object}>} files geometry file by continent
 * @returns {Record<string, number[]>} frame key -> [x0, y0, x1, y1]
 */
export function computeFrames(countries, files) {
  if (!Array.isArray(countries)) throw new TypeError('`countries` must be an array.');
  const members = new Map(); // frame key -> { continent, codes }
  const addMember = (key, continent, code) => {
    if (!members.has(key)) members.set(key, { continent, codes: [] });
    members.get(key).codes.push(code);
  };
  for (const country of countries) {
    if (!country.quizzed) continue;
    addMember(country.continent, country.continent, country.code);
    addMember(country.subregion, country.continent, country.code);
  }
  for (const key of Object.keys(FRAME_OVERRIDES)) {
    if (!members.has(key)) throw new RangeError(`Frame override \`${key}\` names no frame.`);
    if (typeof FRAME_OVERRIDES[key].reason !== 'string' || !FRAME_OVERRIDES[key].reason) {
      throw new RangeError(`Frame override \`${key}\` needs a \`reason\`.`);
    }
  }
  const frames = {};
  for (const [key, { continent, codes }] of members) {
    frames[key] = computeFrame(files[continent], codes, FRAME_OVERRIDES[key]?.clip);
  }
  return frames;
}
