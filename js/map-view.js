// Map renderer: draws one frame of a geometry file into an `<svg>`, handles
// taps and shows the reveal.
//
// DOM only (no `innerHTML`, `outerHTML` or `insertAdjacentHTML`): every node
// comes from `createElementNS` / `createElement`, attributes are set one by
// one and text only through `textContent`. Path data comes from
// `ringsToPathData` alone, so it is numeric by construction.
//
// No spoilers before the reveal. The SVG is `aria-hidden`, has no title or
// description, and carries no ids, classes, data-attributes or text that name a
// country or its code. The code -> element mapping lives in a JS `Map`. Names
// reach the DOM only through `reveal()`, as label `textContent`. The region
// around the map has one generic `aria-label`.
//
// Layers, back to front: `context` land of other continents (lighter grey,
// never highlighted, labelled or tappable, never passed to `hitTest`), the
// frame's own land, the target fill and wrong-pick outline, the circle marker
// and inset for a small target, and the labels.
//
// Layout contract with `js/map.js`: the `<svg>` has `viewBox` set to the frame (`x0 y0 width height`) and the
// default `preserveAspectRatio` (meet), and its CSS px size (from
// `getBoundingClientRect`) is the `viewportPx` given to `hitTest` and
// `computeInset`. The caller picks the frame (`pickFrame` in `js/cards.js`);
// this module does not.

import { computeInset, getPxPerUnit, hitTest, ringsToPathData } from './map.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Frame levels: which of the two `small` flags in `map-meta.json` applies. */
export const FRAME_LEVEL_SUBREGION = 'subregion';
export const FRAME_LEVEL_CONTINENT = 'continent';

/** Label size and halo width, in CSS px. */
export const LABEL_FONT_PX = 12;
export const LABEL_HALO_PX = 3;

/** Generic label of the question region; never names the country. */
export const REGION_LABEL = 'Map question';

// ---- Validation helpers ----

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertFrame(frame) {
  const isShape = Array.isArray(frame) && frame.length === 4 && frame.every(Number.isFinite);
  if (!isShape || !(frame[2] > frame[0]) || !(frame[3] > frame[1])) {
    throw new TypeError('`frame` must be an `[x0, y0, x1, y1]` array of finite numbers with `x1 > x0` and `y1 > y0`.');
  }
}

function assertFrameLevel(frameLevel) {
  if (frameLevel !== FRAME_LEVEL_SUBREGION && frameLevel !== FRAME_LEVEL_CONTINENT) {
    throw new RangeError(`\`frameLevel\` must be '${FRAME_LEVEL_SUBREGION}' or '${FRAME_LEVEL_CONTINENT}'.`);
  }
}

function assertGeometry(geometry) {
  if (!isPlainObject(geometry) || !isPlainObject(geometry.entries)) {
    throw new TypeError('`geometry` must be a geometry file object with an `entries` object.');
  }
  if (geometry.context !== undefined && !isPlainObject(geometry.context)) {
    throw new TypeError('`geometry.context` must be an object when given.');
  }
}

function assertMeta(meta) {
  if (!isPlainObject(meta) || !isPlainObject(meta.entries)) {
    throw new TypeError('`meta` must be a map-meta object with an `entries` object.');
  }
}

// ---- Pure helpers (exported for tests) ----

/**
 * Whether two `[x0, y0, x1, y1]` boxes overlap or touch.
 *
 * @param {[number, number, number, number]} a First box.
 * @param {[number, number, number, number]} b Second box.
 * @returns {boolean} `true` if they intersect.
 */
export function boxesIntersect(a, b) {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/**
 * An `[x0, y0, x1, y1]` box as an SVG `viewBox` value, `x y width height`.
 *
 * @param {[number, number, number, number]} box The box.
 * @returns {string} The `viewBox` attribute value.
 */
export function toViewBox([x0, y0, x1, y1]) {
  return `${x0} ${y0} ${x1 - x0} ${y1 - y0}`;
}

/**
 * Converts a pointer position to frame units with the inverse of the SVG's
 * screen matrix (`svg.getScreenCTM().inverse()`), which already accounts for
 * `viewBox` and the `meet` letterboxing.
 *
 * @param {{ a: number, b: number, c: number, d: number, e: number, f: number }} inverse Inverse screen matrix.
 * @param {number} clientX Pointer x in CSS px.
 * @param {number} clientY Pointer y in CSS px.
 * @returns {[number, number]} The point in frame units.
 */
export function toFramePoint(inverse, clientX, clientY) {
  if (typeof inverse !== 'object' || inverse === null) {
    throw new TypeError('`inverse` must be a matrix with `a`..`f` fields.');
  }
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
    throw new TypeError('`clientX` and `clientY` must be finite numbers.');
  }
  return [
    inverse.a * clientX + inverse.c * clientY + inverse.e,
    inverse.b * clientX + inverse.d * clientY + inverse.f
  ];
}

/**
 * Selects what to draw for one frame, without touching the DOM.
 *
 * - `land`: the geometry file's own entries whose bbox meets the frame, with
 *   their path data, biggest first so small entries are drawn on top.
 * - `contextD`: the path data of every `context` entry that meets the frame,
 *   merged into one string (context land has no identity in the DOM).
 *
 * Each `land` item has `small` resolved for the shown frame: `small` on a
 * sub-region frame, `smallInContinent` on a continent frame.
 *
 * @param {{ geometry: object, meta: object, frame: number[], frameLevel: string }} input Scene input.
 * @returns {{ land: Array<{ code: string, d: string, rings: number[][][], bbox: number[], label: number[] | undefined, tappable: boolean, small: boolean }>, contextD: string }} The scene.
 */
export function planScene({ geometry, meta, frame, frameLevel }) {
  assertGeometry(geometry);
  assertMeta(meta);
  assertFrame(frame);
  assertFrameLevel(frameLevel);
  const smallKey = frameLevel === FRAME_LEVEL_CONTINENT ? 'smallInContinent' : 'small';

  const area = ([x0, y0, x1, y1]) => (x1 - x0) * (y1 - y0);
  const land = Object.keys(geometry.entries)
    .filter((code) => boxesIntersect(geometry.entries[code].bbox, frame))
    .sort((a, b) => area(geometry.entries[b].bbox) - area(geometry.entries[a].bbox) || (a < b ? -1 : 1))
    .map((code) => {
      const entry = geometry.entries[code];
      const info = meta.entries[code] ?? {};
      return {
        code,
        d: ringsToPathData(entry.rings),
        rings: entry.rings,
        bbox: entry.bbox,
        label: entry.label,
        tappable: info.tappable === true,
        small: info[smallKey] === true
      };
    });

  const context = geometry.context ?? {};
  const contextD = Object.keys(context)
    .sort()
    .filter((code) => boxesIntersect(context[code].bbox, frame))
    .map((code) => ringsToPathData(context[code].rings))
    .join('');

  return { land, contextD };
}

// ---- DOM ----

/**
 * Creates a map view: a region `<div>` holding an `aria-hidden` `<svg>`.
 *
 * @param {{ onTap?: (code: string) => void, onAmbiguous?: (codes: [string, string]) => void, onMiss?: () => void, document?: Document }} [options] Callbacks: `onTap` gets the tapped code, `onAmbiguous` the nearest-first pair (the caller shows a confirm), `onMiss` a tap on nothing.
 * @returns {{ element: Element, svg: Element, render: Function, reveal: Function, relayout: Function, destroy: Function }} The view.
 */
export function createMapView({ onTap, onAmbiguous, onMiss, document: doc = globalThis.document } = {}) {
  for (const [name, fn] of Object.entries({ onTap, onAmbiguous, onMiss })) {
    if (fn !== undefined && typeof fn !== 'function') {
      throw new TypeError(`\`${name}\` must be a function when given.`);
    }
  }
  if (doc === undefined || typeof doc.createElementNS !== 'function') {
    throw new TypeError('`document` must be a Document.');
  }

  const element = doc.createElement('div');
  element.setAttribute('class', 'map-view');
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', REGION_LABEL);

  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'map-svg');
  svg.setAttribute('aria-hidden', 'true');
  element.append(svg);

  const make = (tag, attrs = {}) => {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) {
      node.setAttribute(name, String(value));
    }
    return node;
  };

  // Per-render state. `paths` is the JS-side code -> element mapping.
  let state = null;

  function viewportPx() {
    const { width, height } = svg.getBoundingClientRect();
    return width > 0 && height > 0 ? { width, height } : null;
  }

  function setBox(node, [x0, y0, x1, y1]) {
    node.setAttribute('x', x0);
    node.setAttribute('y', y0);
    node.setAttribute('width', x1 - x0);
    node.setAttribute('height', y1 - y0);
  }

  // Everything that depends on the CSS px size: marker radius, inset box,
  // label size. Safe to call repeatedly (resize, rotate).
  function relayout() {
    if (state === null) {
      return;
    }
    const viewport = viewportPx();
    if (viewport === null) {
      return;
    }
    const pxPerUnit = getPxPerUnit(state.frame, viewport);

    if (state.inset !== null) {
      const { entry, marker, box, insetSvg } = state.inset;
      const layout = computeInset(entry, state.frame, viewport);
      marker.setAttribute('cx', layout.marker.cx);
      marker.setAttribute('cy', layout.marker.cy);
      marker.setAttribute('r', layout.marker.r);
      setBox(box, layout.target);
      setBox(insetSvg, layout.target);
      insetSvg.setAttribute('viewBox', toViewBox(layout.source));
    }
    for (const label of state.labels) {
      label.setAttribute('font-size', LABEL_FONT_PX / pxPerUnit);
      label.setAttribute('stroke-width', LABEL_HALO_PX / pxPerUnit);
    }
  }

  // Marker and inset for the highlighted target when it is small at this
  // frame. The inset reuses the path data already computed for the scene.
  function addInset(code) {
    const item = state.byCode.get(code);
    if (item === undefined || !item.small || state.inset !== null) {
      return;
    }
    const layer = make('g', { class: 'map-inset-layer' });
    const marker = make('circle', { class: 'map-marker' });
    const box = make('rect', { class: 'map-inset-box' });
    const insetSvg = make('svg', { class: 'map-inset', preserveAspectRatio: 'xMidYMid meet' });
    for (const other of state.scene.land) {
      insetSvg.append(make('path', {
        class: other.code === code ? 'map-target' : 'map-land',
        d: other.d
      }));
    }
    layer.append(marker, box, insetSvg);
    svg.append(layer);
    state.inset = { entry: item, marker, box, insetSvg };
  }

  function highlight(code) {
    const path = state.paths.get(code);
    if (path !== undefined) {
      path.setAttribute('class', 'map-land map-target');
      addInset(code);
    }
  }

  function handleClick(event) {
    if (state === null || !state.interactive) {
      return;
    }
    const viewport = viewportPx();
    const matrix = svg.getScreenCTM();
    if (viewport === null || matrix === null) {
      return;
    }
    const point = toFramePoint(matrix.inverse(), event.clientX, event.clientY);
    // Own land only: `context` is never part of the hit-test entries.
    const result = hitTest(point, state.hitEntries, state.frame, viewport);
    if (result === null) {
      onMiss?.();
    } else if ('code' in result) {
      onTap?.(result.code);
    } else {
      onAmbiguous?.(result.ambiguous);
    }
  }
  svg.addEventListener('click', handleClick);

  let observer = null;
  if (typeof globalThis.ResizeObserver === 'function') {
    observer = new globalThis.ResizeObserver(() => relayout());
    observer.observe(svg);
  }

  return {
    element,
    svg,

    /**
     * Draws a frame, replacing whatever was shown.
     *
     * @param {{ geometry: object, meta: object, frame: number[], frameLevel: 'subregion' | 'continent', target?: string | null, interactive?: boolean }} input `geometry` is the parsed geometry file, `meta` the parsed `map-meta.json`, `frame` the box chosen by `pickFrame`, `frameLevel` which kind of frame it is, `target` a code to fill in the accent from the start (map → name cards; leave `null` for name → tap), `interactive` whether taps are reported.
     * @returns {void}
     */
    render({ geometry, meta, frame, frameLevel, target = null, interactive = false }) {
      const scene = planScene({ geometry, meta, frame, frameLevel });
      if (target !== null && !Object.hasOwn(geometry.entries, target)) {
        throw new RangeError('`target` must be an entry of `geometry`.');
      }

      svg.replaceChildren();
      svg.setAttribute('viewBox', toViewBox(frame));
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

      if (scene.contextD !== '') {
        svg.append(make('path', { class: 'map-context', d: scene.contextD }));
      }
      const landLayer = make('g', { class: 'map-land-layer' });
      const paths = new Map();
      const byCode = new Map();
      const hitEntries = {};
      for (const item of scene.land) {
        const path = make('path', { class: 'map-land', d: item.d });
        landLayer.append(path);
        paths.set(item.code, path);
        byCode.set(item.code, item);
        hitEntries[item.code] = { rings: item.rings, bbox: item.bbox, tappable: item.tappable };
      }
      svg.append(landLayer);

      state = {
        scene, frame, meta, geometry, paths, byCode, hitEntries,
        interactive, labels: [], inset: null, layer: make('g', { class: 'map-label-layer' })
      };
      svg.append(state.layer);
      if (target !== null) {
        highlight(target);
      }
      relayout();
    },

    /**
     * Shows the answer: fills the target in the accent, outlines a wrong pick,
     * and on a miss labels the target and its neighbours at their `label`
     * points. Taps stop being reported.
     *
     * @param {{ target: string, picked?: string | null, correct: boolean, names: Object<string, string> }} input `picked` is the code the user chose (if any), `correct` whether the answer was right, `names` maps code → display name for the labels.
     * @returns {void}
     */
    reveal({ target, picked = null, correct, names }) {
      if (state === null) {
        throw new Error('`render` must be called before `reveal`.');
      }
      if (typeof target !== 'string' || !state.paths.has(target)) {
        throw new RangeError('`target` must be an entry drawn in the current frame.');
      }
      if (typeof correct !== 'boolean') {
        throw new TypeError('`correct` must be a boolean.');
      }
      if (!isPlainObject(names)) {
        throw new TypeError('`names` must be an object mapping codes to names.');
      }
      state.interactive = false;
      highlight(target);

      if (picked !== null && picked !== target && state.paths.has(picked)) {
        state.paths.get(picked).setAttribute('class', 'map-land map-picked');
      }
      if (correct) {
        relayout();
        return;
      }

      const neighbours = state.meta.entries[target]?.neighbours ?? [];
      for (const code of [target, ...neighbours]) {
        const item = state.byCode.get(code);
        const name = names[code];
        if (item === undefined || item.label === undefined || typeof name !== 'string') {
          continue;
        }
        // Keep labels near a frame edge inside the frame.
        const share = (item.label[0] - state.frame[0]) / (state.frame[2] - state.frame[0]);
        const anchor = share > 0.85 ? 'end' : share < 0.15 ? 'start' : 'middle';
        const text = make('text', {
          class: code === target ? 'map-label map-label-target' : 'map-label',
          x: item.label[0],
          y: item.label[1],
          'text-anchor': anchor,
          'dominant-baseline': 'middle'
        });
        text.textContent = name;
        state.layer.append(text);
        state.labels.push(text);
      }
      relayout();
    },

    relayout,

    /** Removes listeners and observers. */
    destroy() {
      svg.removeEventListener('click', handleClick);
      observer?.disconnect();
      state = null;
    }
  };
}
