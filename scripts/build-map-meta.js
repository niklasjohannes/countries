// Zero-dependency generator for `data/map-meta.json`.
//
//   node scripts/build-map-meta.js          write data/map-meta.json
//   node scripts/build-map-meta.js --check  exit 1 if it is out of date
//
// Inputs: `data/countries.json`, the geometry files (regenerated in memory by
// `scripts/build-geometry.js`, so the two can never disagree), the neighbour
// maps that build derives, and `scripts/frame-overrides.js`. The output is
// deterministic, so `test/map-meta.test.js` regenerates it and compares byte
// for byte.
//
// Contract (docs/SPEC.md -> "Data contracts"):
//   { "frames":  { "<continent|subregion>": [x0, y0, x1, y1] },
//     "entries": { "<code>": { "neighbours": [...], "small": false, "tappable": true } } }
//
// Frames
//   A frame is in the coordinate space of its continent's geometry file. It is
//   the bounding box of the quizzed entries of the continent (or sub-region),
//   padded on every side by FRAME_PADDING of the box's longer side, rounded to
//   integers. It is not clamped: the file's origin is its entries' extent, so
//   a frame may reach past 0 or the extent's far edge into open sea, which is
//   what keeps the padding on every side. `south-america` is both a
//   continent and a sub-region and has one frame.
//   `scripts/frame-overrides.js` can crop individual entries out of a frame's
//   box before padding.
//
// Small entries
//   `small` is true when the entry's bbox, at its sub-region frame rendered
//   SMALL_FRAME_WIDTH_PX CSS px wide, is under SMALL_LIMIT_PX in both width and
//   height. `tappable` is `!small`.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGeometryFull, makeProjection } from './build-geometry.js';
import { FRAME_OVERRIDES } from './frame-overrides.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const COUNTRIES_PATH = 'data/countries.json';
const GEOMETRY_DIR = 'data/geometry';
export const OUTPUT_PATH = 'data/map-meta.json';

/** Padding added to each side of a frame, as a share of the box's longer side. */
export const FRAME_PADDING = 0.04;
/** Width in CSS px at which a sub-region frame is rendered, for the `small` rule. */
export const SMALL_FRAME_WIDTH_PX = 375;
/** An entry is small when both sides of its bbox are under this many CSS px. */
export const SMALL_LIMIT_PX = 12;

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
 * True when the bbox, at a frame rendered 375 CSS px wide, is under 12 × 12 CSS px.
 * @param {number[]} bbox [x0, y0, x1, y1] in the frame's coordinate space
 * @param {number[]} frame [x0, y0, x1, y1]
 * @returns {boolean}
 */
export function isSmall(bbox, frame) {
  const frameWidth = frame[2] - frame[0];
  if (!(frameWidth > 0)) throw new RangeError('`frame` must have a positive width.');
  const pxPerUnit = SMALL_FRAME_WIDTH_PX / frameWidth;
  return (bbox[2] - bbox[0]) * pxPerUnit < SMALL_LIMIT_PX && (bbox[3] - bbox[1]) * pxPerUnit < SMALL_LIMIT_PX;
}

// ---- Whole build ----

/**
 * Serialise map meta with one frame and one entry per line.
 * @param {{frames: Record<string, number[]>, entries: Record<string, object>}} meta
 * @returns {string}
 */
export function serialiseMapMeta(meta) {
  if (!meta || typeof meta.frames !== 'object' || typeof meta.entries !== 'object') {
    throw new TypeError('`meta` must have `frames` and `entries`.');
  }
  const rows = (map) => Object.keys(map).sort().map((key) => `${JSON.stringify(key)}:${JSON.stringify(map[key])}`).join(',\n');
  return `{"frames":{\n${rows(meta.frames)}\n},\n"entries":{\n${rows(meta.entries)}\n}}\n`;
}

/**
 * Build `data/map-meta.json` from the inputs.
 * @param {string} [root] repository root
 * @returns {{text: string, meta: object, files: Record<string, object>, overrides: string[]}} file text, parsed contents, continent geometry files, overridden frame keys
 */
export function buildMapMeta(root = ROOT) {
  if (typeof root !== 'string') throw new TypeError('`root` must be a path string.');
  const { countries, meta: countriesMeta } = JSON.parse(readFileSync(resolve(root, COUNTRIES_PATH), 'utf8'));
  const { outputs, neighbours } = buildGeometryFull(root);
  const files = Object.fromEntries(
    countriesMeta.continents.map((continent) => [continent, JSON.parse(outputs.get(`${GEOMETRY_DIR}/${continent}.json`))])
  );

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

  const entries = {};
  for (const country of countries) {
    const bbox = files[country.continent].entries[country.code].bbox;
    const small = isSmall(bbox, frames[country.subregion]);
    if (!Array.isArray(neighbours[country.code])) throw new RangeError(`\`${country.code}\` has no neighbours entry.`);
    entries[country.code] = { neighbours: neighbours[country.code], small, tappable: !small };
  }
  const meta = { frames, entries };
  return { text: serialiseMapMeta(meta), meta, files, overrides: Object.keys(FRAME_OVERRIDES) };
}

/**
 * True when the module at `moduleUrl` is the entry point, also through a symlink.
 * @param {string} moduleUrl the caller's `import.meta.url`
 * @returns {boolean}
 */
export function isEntryPoint(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntryPoint(import.meta.url)) {
  const { text, meta } = buildMapMeta();
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(resolve(ROOT, OUTPUT_PATH), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current !== text) {
      console.error(`${OUTPUT_PATH} is out of date: run \`node scripts/build-map-meta.js\`.`);
      process.exit(1);
    }
    console.log(`${OUTPUT_PATH} is up to date.`);
  } else {
    writeFileSync(resolve(ROOT, OUTPUT_PATH), text);
    const small = Object.values(meta.entries).filter((entry) => entry.small).length;
    console.log(`Wrote ${OUTPUT_PATH} (${(Buffer.byteLength(text) / 1024).toFixed(1)} KB): ${Object.keys(meta.frames).length} frames, ${small} small entries.`);
  }
}
