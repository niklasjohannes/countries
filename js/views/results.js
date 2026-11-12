// Results view (PLAN decision 13): the score of a finished test pass, one map
// with the missed entries shaded, and the missed list. Retake starts the same
// scope again with a fresh shuffle; Done goes home. Like the test view, it
// never touches SRS state (nothing here calls a storage function).
//
// The map is the continent frame for a continent or sub-region scope, and
// `world.json` for "All" (js/test-map.js). Names appear only here, after the
// test, in the list; the map itself has no labels.
//
// `params`: `{ mode, pass }` from the test view, `pass` complete (see
// js/test-pass.js). See the view contract in js/app.js.

import { FRAME_LEVEL_CONTINENT, createMapView } from '../map-view.js';
import { META_URL, getGeometryUrl, loadJson } from '../data.js';
import { FALLBACK_RESULTS_VIEWPORT_PX, WORLD_KEY, deriveWorldMeta, getEntriesFrame, getResultsGeometryKey } from '../test-map.js';
import { formatScore, scorePass } from '../test-pass.js';
import { ALL_LABEL, CONTINENT_LABELS, MODE_LABELS, el, formatSubregion } from '../ui.js';

let controller = null;

/**
 * Human label of a scope.
 *
 * @param {{ continent?: string | null, subregion?: string | null }} filter The scope.
 * @returns {string} e.g. `'All'`, `'Africa'` or `'Western Africa'`.
 */
export function formatScope(filter) {
  if (filter.subregion ?? null) {
    return formatSubregion(filter.subregion);
  }
  if (filter.continent ?? null) {
    return CONTINENT_LABELS[filter.continent];
  }
  return ALL_LABEL;
}

function renderMiss(miss) {
  // Post-test, so the names are fine here.
  return el('li', { class: 'results-miss' }, [
    el('strong', { class: 'results-miss-name' }, [miss.name]),
    el('span', { class: 'results-miss-answer' }, [`You answered ${miss.chosenName}`])
  ]);
}

/**
 * Render the results view.
 *
 * @param {HTMLElement} container The view's section.
 * @param {{ countries: object[], navigate: Function, params: object }} context
 *   See `js/app.js`. `params.pass` is a complete pass from the test view and
 *   `params.mode` its quiz mode.
 * @returns {void}
 */
export function mount(container, context) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('`container` must be an `HTMLElement`.');
  }
  if (typeof context !== 'object' || context === null || typeof context.navigate !== 'function') {
    throw new TypeError('`context` must have a `navigate` function.');
  }
  const { countries, navigate, params } = context;
  if (!Array.isArray(countries)) {
    throw new TypeError('`context.countries` must be an array.');
  }
  if (typeof params !== 'object' || params === null) {
    throw new TypeError('`context.params` must be an object.');
  }
  const { mode, pass } = params;
  if (!Object.hasOwn(MODE_LABELS, mode)) {
    throw new RangeError(`\`params.mode\` must be one of ${Object.keys(MODE_LABELS).join(', ')}.`);
  }
  // Throws on a missing or incomplete pass; the router then shows its error.
  const score = scorePass(pass, countries);
  controller = new AbortController();
  const { signal } = controller;

  const retakeButton = el('button', { type: 'button', class: 'button button-primary', 'data-action': 'retake' }, ['Retake']);
  const doneButton = el('button', { type: 'button', class: 'button button-secondary', 'data-action': 'done' }, ['Done']);
  retakeButton.addEventListener('click', () => navigate('test', { filter: pass.filter, mode }), { signal });
  doneButton.addEventListener('click', () => navigate('home'), { signal });

  const mapBox = el('div', { class: 'results-map', hidden: score.missed.length === 0 });
  const missedSection = score.missed.length === 0
    ? el('p', { class: 'results-none' }, ['No misses. Every country right.'])
    : el('section', { class: 'results-missed', 'aria-labelledby': 'results-missed-title' }, [
      el('h2', { id: 'results-missed-title', class: 'results-missed-title' }, [`Missed (${score.missed.length})`]),
      el('ul', { class: 'results-list' }, score.missed.map(renderMiss))
    ]);

  container.replaceChildren(
    el('h1', {}, ['Results']),
    el('p', { class: 'results-scope' }, [`${formatScope(pass.filter)} · ${MODE_LABELS[mode]}`]),
    el('p', { class: 'score-caption' }, ['Correct']),
    el('p', { class: 'score results-score' }, [formatScore(score)]),
    mapBox,
    missedSection,
    el('div', { class: 'view-actions results-actions' }, [retakeButton, doneButton])
  );

  if (score.missed.length > 0) {
    showMissedMap(mapBox, { filter: pass.filter, codes: score.missed.map((miss) => miss.code), signal });
  }
}

// Loads the geometry and draws the shaded map. A failure only drops the map:
// the score and the list are already on screen.
async function showMissedMap(mapBox, { filter, codes, signal }) {
  try {
    const key = getResultsGeometryKey(filter);
    const [geometry, mapMeta] = await Promise.all([
      loadJson(getGeometryUrl(key)),
      key === WORLD_KEY ? Promise.resolve(null) : loadJson(META_URL)
    ]);
    if (signal.aborted) {
      return;
    }
    const mapView = createMapView();
    signal.addEventListener('abort', () => mapView.destroy());
    mapBox.append(mapView.element);
    let frame;
    let meta;
    if (key === WORLD_KEY) {
      // "Small" depends on the size on screen, so it is judged once the map is
      // in the page (a fixed fallback if it has no layout yet).
      frame = getEntriesFrame(geometry);
      const { width, height } = mapView.svg.getBoundingClientRect();
      meta = deriveWorldMeta(geometry, frame, width > 0 && height > 0 ? { width, height } : FALLBACK_RESULTS_VIEWPORT_PX);
    } else {
      meta = mapMeta;
      frame = meta.frames[key];
    }
    mapView.render({ geometry, meta, frame, frameLevel: FRAME_LEVEL_CONTINENT });
    mapView.shade(codes);
    mapView.relayout();
  } catch (error) {
    console.error(error);
    mapBox.hidden = true;
  }
}

/**
 * Clean up the results view.
 *
 * @returns {void}
 */
export function unmount() {
  controller?.abort();
  controller = null;
}
