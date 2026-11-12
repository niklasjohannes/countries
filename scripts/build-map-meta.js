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
//     "entries": { "<code>": { "neighbours": [...], "small": false, "tappable": true,
//                         "smallInContinent": false } } }
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
//   `small` is true when the bbox of the entry's largest ring (not the union
//   bbox, which over-states an archipelago), at its sub-region frame drawn into
//   the phone-shaped viewport SMALL_VIEWPORT_PX (scale from `getPxPerUnit`, so
//   tall frames are height-limited), is under SMALL_LIMIT_PX in both width and
//   height. `tappable` is `!small`.
//   `smallInContinent` (owner decision, issue 6) is the same rule at the
//   entry's continent frame; the renderer shows a marker and inset when an entry
//   is small in whichever frame is on screen. `small` and `tappable` do not
//   change.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGeometryFull } from './build-geometry.js';
import { FRAME_OVERRIDES } from './frame-overrides.js';
import { FRAME_PADDING, SMALL_VIEWPORT_PX, SMALL_LIMIT_PX, computeFrame, computeFrames, isSmall, largestRingBbox, projectLonLatBox } from './frames.js';

export { FRAME_PADDING, SMALL_VIEWPORT_PX, SMALL_LIMIT_PX, computeFrame, computeFrames, isSmall, largestRingBbox, projectLonLatBox };

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const COUNTRIES_PATH = 'data/countries.json';
const GEOMETRY_DIR = 'data/geometry';
export const OUTPUT_PATH = 'data/map-meta.json';

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

  const frames = computeFrames(countries, files);

  const entries = {};
  for (const country of countries) {
    const bbox = largestRingBbox(files[country.continent].entries[country.code].rings);
    const small = isSmall(bbox, frames[country.subregion]);
    if (!Array.isArray(neighbours[country.code])) throw new RangeError(`\`${country.code}\` has no neighbours entry.`);
    entries[country.code] = {
      neighbours: neighbours[country.code],
      small,
      tappable: !small,
      smallInContinent: isSmall(bbox, frames[country.continent])
    };
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
