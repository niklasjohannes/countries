// Dev-only contact sheet: standalone SVGs for eyeballing `data/map-meta.json`.
//
//   node scripts/render-contact-sheet.js
//
// Writes `.tmp/contact-sheet/` (git-ignored): one SVG per frame (every
// continent and sub-region), `small-entries.svg` (every small entry's circle
// marker and inset), and an `index.html` that tiles them with their names.
//
// The app never serves or precaches any of this: it is not imported from
// `js/`, not linked from `index.html`, and not in any service-worker list.
// Zero dependencies; SVG is built as strings. Path data is assembled from
// numbers only (every coordinate passes `num()`); the only text from data
// files is the entry name and frame name, and it is XML-escaped.
//
// Frames are drawn from their continent's geometry file only, so land of a
// neighbouring continent (Turkey in the Europe frame, say) is not drawn.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FRAME_OVERRIDES } from './frame-overrides.js';
import { getPxPerUnit } from '../js/map.js';
import { SMALL_VIEWPORT_PX, buildMapMeta, isEntryPoint } from './build-map-meta.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = resolve(ROOT, '.tmp/contact-sheet');
const QUIZZED_FILL = '#d4d4d4';
const CONTEXT_FILL = '#bcbcbc';
const BACKDROP_FILL = '#ececec';
const SMALL_FILL = '#8a8a8a';
const BORDER = '#2a2a2a';
const FRAME_SHEET_WIDTH_PX = 600;
const MARKER_RADIUS_PX = 9;
const CELL = { width: 230, height: 150, marker: 130, inset: 90, gap: 10 };
const COLUMNS = 5;

/**
 * Check a value is a finite number and return it, so path data can never carry text.
 * @param {number} value
 * @returns {number}
 */
function num(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Path data must be finite numbers.');
  return Math.round(value * 100) / 100;
}

/**
 * Escape text for XML and HTML.
 * @param {string} text
 * @returns {string}
 */
export function escapeXml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

/**
 * Path data for rings, as `M x y L x y … Z`.
 * @param {number[][][]} rings
 * @returns {string}
 */
export function pathOf(rings) {
  return rings
    .map((ring) => ring.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${num(x)} ${num(y)}`).join('') + 'Z')
    .join('');
}

/** Shorten a caption so it stays inside its cell. */
const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const overlaps = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/**
 * SVG path elements for the entries of a file that overlap a window.
 * @param {{entries: Record<string, {rings: number[][][], bbox: number[]}>}} file
 * @param {Map<string, {quizzed: boolean}>} meta countries by code
 * @param {number[]} window [x0, y0, x1, y1]
 * @param {string|null} highlight code drawn darker
 * @returns {string}
 */
function drawEntries(file, meta, window, highlight = null) {
  const parts = [];
  // Other continents' land first (lightest), then own context-only land, then quizzed land.
  const layers = [
    Object.entries(file.context ?? {}).map(([code, entry]) => [code, entry, BACKDROP_FILL]),
    Object.entries(file.entries).filter(([code]) => !meta.get(code).quizzed).map(([code, entry]) => [code, entry, CONTEXT_FILL]),
    Object.entries(file.entries).filter(([code]) => meta.get(code).quizzed).map(([code, entry]) => [code, entry, QUIZZED_FILL])
  ];
  for (const layer of layers) {
    for (const [code, entry, fill] of layer.filter(([, entry]) => overlaps(entry.bbox, window)).sort(([a], [b]) => a.localeCompare(b))) {
      const colour = code === highlight && fill !== BACKDROP_FILL ? SMALL_FILL : fill;
      parts.push(`<path fill="${colour}" fill-rule="evenodd" stroke="${BORDER}" stroke-width="0.6" vector-effect="non-scaling-stroke" d="${pathOf(entry.rings)}"/>`);
    }
  }
  return parts.join('\n');
}

/**
 * One SVG for a frame: quizzed land, context land, thin borders and a dot on
 * every quizzed label point inside it.
 * @param {string} key frame name
 * @param {number[]} frame [x0, y0, x1, y1]
 * @param {object} file continent geometry file
 * @param {Map<string, {quizzed: boolean}>} meta countries by code
 * @returns {string}
 */
export function renderFrame(key, frame, file, meta) {
  const [x0, y0, x1, y1] = frame;
  const width = x1 - x0;
  const height = y1 - y0;
  const pxHeight = Math.round((FRAME_SHEET_WIDTH_PX * height) / width);
  const dot = (width / FRAME_SHEET_WIDTH_PX) * 1.5;
  const dots = Object.entries(file.entries)
    .filter(([code, entry]) => meta.get(code).quizzed && entry.label[0] >= x0 && entry.label[0] <= x1 && entry.label[1] >= y0 && entry.label[1] <= y1)
    .map(([, entry]) => `<circle cx="${num(entry.label[0])}" cy="${num(entry.label[1])}" r="${num(dot)}" fill="#000"/>`)
    .join('\n');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FRAME_SHEET_WIDTH_PX}" height="${pxHeight}" viewBox="${num(x0)} ${num(y0)} ${num(width)} ${num(height)}">`,
    `<title>${escapeXml(key)}</title>`,
    `<rect x="${num(x0)}" y="${num(y0)}" width="${num(width)}" height="${num(height)}" fill="#fff"/>`,
    drawEntries(file, meta, frame),
    dots,
    '</svg>',
    ''
  ].join('\n');
}

/**
 * A small-entries sheet: for each entry, its circle marker on a frame at the
 * 375 px render width, and an inset zoom.
 * @param {{code: string, name: string, continent: string, subregion: string}[]} small
 * @param {Record<string, object>} files continent geometry files
 * @param {(country: object) => number[]} frameOf the frame the markers are sized for
 * @param {string} title
 * @param {Map<string, {quizzed: boolean}>} meta countries by code
 * @returns {string}
 */
export function renderSmallEntries(small, files, frameOf, title, meta) {
  const rows = Math.ceil(small.length / COLUMNS);
  const width = COLUMNS * (CELL.width + CELL.gap) + CELL.gap;
  const height = rows * (CELL.height + CELL.gap) + CELL.gap;
  const cells = small.map((country, i) => {
    const file = files[country.continent];
    const entry = file.entries[country.code];
    const frame = frameOf(country);
    const left = CELL.gap + (i % COLUMNS) * (CELL.width + CELL.gap);
    const top = CELL.gap + Math.floor(i / COLUMNS) * (CELL.height + CELL.gap);

    // Marker panel: the real render scale, cropped around the label point.
    const unitsPerPx = 1 / getPxPerUnit(frame, SMALL_VIEWPORT_PX);
    const half = (CELL.marker / 2) * unitsPerPx;
    const [lx, ly] = entry.label;
    const markerWindow = [lx - half, ly - half, lx + half, ly + half];
    const marker = [
      `<svg x="${left}" y="${top}" width="${CELL.marker}" height="${CELL.marker}" viewBox="${num(markerWindow[0])} ${num(markerWindow[1])} ${num(2 * half)} ${num(2 * half)}">`,
      `<rect x="${num(markerWindow[0])}" y="${num(markerWindow[1])}" width="${num(2 * half)}" height="${num(2 * half)}" fill="#fff"/>`,
      drawEntries(file, meta, markerWindow, country.code),
      `<circle cx="${num(lx)}" cy="${num(ly)}" r="${num(MARKER_RADIUS_PX * unitsPerPx)}" fill="none" stroke="#000" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`,
      '</svg>'
    ].join('\n');

    // Inset panel: zoomed so the entry is a quarter of the panel, at least 20 km across.
    const side = Math.max(4 * Math.max(entry.bbox[2] - entry.bbox[0], entry.bbox[3] - entry.bbox[1]), 2 * file.scale * 10);
    const cx = (entry.bbox[0] + entry.bbox[2]) / 2;
    const cy = (entry.bbox[1] + entry.bbox[3]) / 2;
    const insetWindow = [cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2];
    const insetLeft = left + CELL.marker + CELL.gap;
    const inset = [
      `<svg x="${insetLeft}" y="${top}" width="${CELL.inset}" height="${CELL.inset}" viewBox="${num(insetWindow[0])} ${num(insetWindow[1])} ${num(side)} ${num(side)}">`,
      `<rect x="${num(insetWindow[0])}" y="${num(insetWindow[1])}" width="${num(side)}" height="${num(side)}" fill="#fff"/>`,
      drawEntries(file, meta, insetWindow, country.code),
      '</svg>'
    ].join('\n');

    const frame1 = `<rect x="${left}" y="${top}" width="${CELL.marker}" height="${CELL.marker}" fill="none" stroke="#999" stroke-width="0.5"/>`;
    const frame2 = `<rect x="${insetLeft}" y="${top}" width="${CELL.inset}" height="${CELL.inset}" fill="none" stroke="#999" stroke-width="0.5"/>`;
    const caption = `<text x="${left}" y="${top + CELL.marker + 14}" font-family="monospace" font-size="11" fill="#000">${escapeXml(country.code)} · ${escapeXml(truncate(country.name, 24))}</text>`;
    return [marker, inset, frame1, frame2, caption].join('\n');
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<title>${escapeXml(title)}: circle marker (left) and inset (right)</title>`,
    `<rect width="${width}" height="${height}" fill="#fff"/>`,
    ...cells,
    '</svg>',
    ''
  ].join('\n');
}

/**
 * The index page tiling every SVG with its caption.
 * @param {{file: string, caption: string}[]} tiles
 * @returns {string}
 */
export function renderIndex(tiles) {
  const figures = tiles
    .map((tile) => `<figure${tile.wide ? ' class="wide"' : ''}><img src="${escapeXml(tile.file)}" alt="${escapeXml(tile.caption)}"><figcaption>${escapeXml(tile.caption)}</figcaption></figure>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Contact sheet</title>
<style>
body { font: 14px monospace; margin: 16px; background: #fafafa; }
main { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
figure { margin: 0; border: 1px solid #ccc; background: #fff; padding: 6px; max-width: 620px; }
figure.wide { max-width: none; }
figure.wide img { max-width: none; }
img { display: block; max-width: 100%; height: auto; }
figcaption { padding-top: 6px; }
</style>
</head>
<body>
<h1>Contact sheet (dev only)</h1>
<main>
${figures}
</main>
</body>
</html>
`;
}

/** Render every file into `.tmp/contact-sheet/`. */
function main() {
  const { meta: countriesMeta, countries } = JSON.parse(readFileSync(resolve(ROOT, 'data/countries.json'), 'utf8'));
  // Built in memory, so the sheet shows what the generators produce now, not a stale committed file.
  const { meta: mapMeta, files } = buildMapMeta(ROOT);
  const { frames, entries } = mapMeta;
  const meta = new Map(countries.map((country) => [country.code, country]));
  const continentOf = (key) => (countriesMeta.continents.includes(key) ? key : countriesMeta.subregions[key]);

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const tiles = [];
  for (const key of Object.keys(frames).sort()) {
    const file = `frame-${key}.svg`;
    writeFileSync(resolve(OUT_DIR, file), renderFrame(key, frames[key], files[continentOf(key)], meta));
    const isContinent = countriesMeta.continents.includes(key);
    const override = FRAME_OVERRIDES[key] ? ' (override)' : '';
    tiles.push({ file, caption: `${isContinent ? 'continent' : 'sub-region'}: ${key}${override}` });
  }

  const sheets = [
    ['small-entries.svg', 'small', (country) => frames[country.subregion], 'sub-region frame'],
    ['small-entries-continent.svg', 'smallInContinent', (country) => frames[country.continent], 'continent frame']
  ];
  for (const [file, flag, frameOf, label] of sheets) {
    const small = countries.filter((country) => entries[country.code][flag]);
    writeFileSync(resolve(OUT_DIR, file), renderSmallEntries(small, files, frameOf, `${flag} entries`, meta));
    tiles.push({ wide: true, file, caption: `${flag} entries (${small.length}) at the ${label}: circle marker, inset` });
  }

  writeFileSync(resolve(OUT_DIR, 'index.html'), renderIndex(tiles));
  console.log(`Wrote ${tiles.length} SVGs and index.html to .tmp/contact-sheet/.`);
}

if (isEntryPoint(import.meta.url)) main();
