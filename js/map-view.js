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
// Ambiguous taps: `markCandidates([a, b])` outlines both candidates and puts
// neutral numbered markers "1" and "2" at their label points (digits only, via
// `textContent`: no name or code), so the caller can ask "which did you mean?"
// without naming anything. A small candidate (at the frame level on screen) is
// also shown in the inset, with its marker; only the first small one gets the
// inset. `clearCandidates()` (or `reveal`) takes it all away.
//
// Shading (`shade(codes)`, used by test results): fills the given entries in
// the shade colour and rings the small ones with a circle marker so they stay
// visible. No labels, names or codes are involved.
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
// this module does not. Call `relayout()` after attaching `view.element` to
// the document, as a fallback for when `ResizeObserver` has not fired yet.

import { MARKER_MIN_RADIUS_PX, computeInset, getPxPerUnit, hitTest, largestRingBbox, ringsToPathData } from './map.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Frame levels: which of the two `small` flags in `map-meta.json` applies. */
export const FRAME_LEVEL_SUBREGION = 'subregion';
export const FRAME_LEVEL_CONTINENT = 'continent';

/** Label size and halo width, in CSS px. */
export const LABEL_FONT_PX = 12;
export const LABEL_HALO_PX = 3;

/** Size of the candidate number markers, in CSS px. */
export const CANDIDATE_FONT_PX = 18;

/**
 * A target whose largest ring renders under this many CSS px on both sides gets
 * a ring marker and an inset even when `map-meta.json` does not flag it small
 * (the meta is computed for a typical phone viewport; this is the safety net
 * for the real one).
 */
export const TINY_TARGET_PX = 10;

/** Shade rings closer than this many ring radii (centre to centre) share one ring. */
export const SHADE_MARKER_CLUSTER_RADII = 1.5;

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

function isValidLabel(label) {
  return Array.isArray(label) && label.length === 2 && label.every(Number.isFinite);
}

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
        label: isValidLabel(entry.label) ? entry.label : undefined,
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

// ---- Label placement ----

/** Estimated glyph width of the label font, as a share of its size (monospace). */
const LABEL_CHAR_WIDTH_SHARE = 0.62;
/** Estimated box height of a label, as a share of its font size. */
const LABEL_LINE_HEIGHT_SHARE = 1.3;
/** Vertical nudges tried, in label heights, when a label collides. */
const LABEL_NUDGES = [0, -1, 1, -2, 2, -3, 3];

/**
 * Places labels so they stay inside the frame and do not overlap: each label
 * is kept inside the frame (horizontally through its text anchor, vertically
 * by clamping), and one that collides with an earlier label is nudged up or
 * down by whole label heights. A non-target label that fits nowhere is
 * dropped; the target's label is never dropped (it takes its own spot even if
 * it overlaps). Earlier items win, so pass the target first.
 *
 * @param {Array<{ x: number, y: number, text: string, isTarget?: boolean }>} items Label points in frame units and their texts.
 * @param {{ frame: number[], pxPerUnit: number, fontPx?: number }} options The frame, CSS px per unit and font size.
 * @returns {Array<{ x: number, y: number, anchor: string, hidden: boolean }>} One placement per item, in frame units.
 */
export function placeLabels(items, { frame, pxPerUnit, fontPx = LABEL_FONT_PX }) {
  if (!Array.isArray(items)) {
    throw new TypeError('`items` must be an array.');
  }
  assertFrame(frame);
  if (!(pxPerUnit > 0)) {
    throw new RangeError('`pxPerUnit` must be a positive number.');
  }
  const width = (frame[2] - frame[0]) * pxPerUnit;
  const height = (frame[3] - frame[1]) * pxPerUnit;
  const boxHeight = fontPx * LABEL_LINE_HEIGHT_SHARE + LABEL_HALO_PX;
  const placed = [];
  return items.map((item) => {
    const boxWidth = item.text.length * fontPx * LABEL_CHAR_WIDTH_SHARE + LABEL_HALO_PX;
    const px = (item.x - frame[0]) * pxPerUnit;
    const py = (item.y - frame[1]) * pxPerUnit;
    let anchor = 'middle';
    let left = px - boxWidth / 2;
    if (left < 0) {
      anchor = 'start';
      left = Math.max(0, px);
    } else if (left + boxWidth > width) {
      anchor = 'end';
      left = Math.min(width, px) - boxWidth;
    }
    const clampY = (y) => Math.min(Math.max(y, boxHeight / 2), Math.max(boxHeight / 2, height - boxHeight / 2));
    let chosen = null;
    for (const nudge of LABEL_NUDGES) {
      const y = clampY(py + nudge * boxHeight);
      const box = [left, y - boxHeight / 2, left + boxWidth, y + boxHeight / 2];
      if (!placed.some((other) => other[0] < box[2] && box[0] < other[2] && other[1] < box[3] && box[1] < other[3])) {
        chosen = { box, y };
        break;
      }
    }
    if (chosen === null && item.isTarget) {
      const y = clampY(py);
      chosen = { box: [left, y - boxHeight / 2, left + boxWidth, y + boxHeight / 2], y };
    }
    if (chosen === null) {
      return { x: item.x, y: item.y, anchor, hidden: true };
    }
    placed.push(chosen.box);
    return { x: item.x, y: frame[1] + chosen.y / pxPerUnit, anchor, hidden: false };
  });
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

    // The target may only be known to be tiny now that the size is known.
    if (state.inset === null && state.focus !== null) {
      addInset(state.focus);
    }
    if (state.inset !== null) {
      const { entry, marker, box, insetSvg } = state.inset;
      const layout = computeInset(entry, state.frame, viewport);
      marker.setAttribute('cx', layout.marker.cx);
      marker.setAttribute('cy', layout.marker.cy);
      marker.setAttribute('r', layout.marker.r);
      setBox(box, layout.target);
      setBox(insetSvg, layout.target);
      insetSvg.setAttribute('viewBox', toViewBox(layout.source));
      const sourceKey = layout.source.join(' ');
      if (state.inset.sourceKey !== sourceKey) {
        state.inset.sourceKey = sourceKey;
        fillInset(layout.source);
      }
    }
    for (const { node } of state.labels) {
      node.setAttribute('font-size', LABEL_FONT_PX / pxPerUnit);
      node.setAttribute('stroke-width', LABEL_HALO_PX / pxPerUnit);
    }
    const placements = placeLabels(
      state.labels.map(({ x, y, text, isTarget }) => ({ x, y, text, isTarget })),
      { frame: state.frame, pxPerUnit }
    );
    state.labels.forEach(({ node }, i) => {
      node.setAttribute('x', placements[i].x);
      node.setAttribute('y', placements[i].y);
      node.setAttribute('text-anchor', placements[i].anchor);
      node.setAttribute('display', placements[i].hidden ? 'none' : 'inline');
    });
    const sizeMarker = (text, unitsPerPx) => {
      text.setAttribute('font-size', CANDIDATE_FONT_PX * unitsPerPx);
      text.setAttribute('stroke-width', LABEL_HALO_PX * unitsPerPx);
    };
    state.markers.forEach((text) => sizeMarker(text, 1 / pxPerUnit));
    // One ring per cluster: a ring whose centre lies within a ring-radius and
    // a half of an earlier one is hidden, so microstates do not merge into blobs.
    const shown = [];
    for (const { circle, x, y } of state.shadeMarkers) {
      circle.setAttribute('r', MARKER_MIN_RADIUS_PX / pxPerUnit);
      const overlaps = shown.some(([sx, sy]) => Math.hypot(x - sx, y - sy) * pxPerUnit < MARKER_MIN_RADIUS_PX * SHADE_MARKER_CLUSTER_RADII);
      circle.setAttribute('display', overlaps ? 'none' : 'inline');
      if (!overlaps) {
        shown.push([x, y]);
      }
    }
    if (state.inset !== null) {
      // The inset maps its square source into its square target.
      const { source, target } = computeInset(state.inset.entry, state.frame, viewport);
      const insetPxPerUnit = pxPerUnit * ((target[2] - target[0]) / (source[2] - source[0]));
      state.inset.markers.forEach((text) => sizeMarker(text, 1 / insetPxPerUnit));
    }
  }

  // True when the entry's largest ring is under TINY_TARGET_PX on both sides
  // at the current size (false while the size is unknown).
  function isTiny(item) {
    const viewport = viewportPx();
    if (viewport === null) {
      return false;
    }
    const pxPerUnit = getPxPerUnit(state.frame, viewport);
    const [x0, y0, x1, y1] = largestRingBbox(item.rings);
    return (x1 - x0) * pxPerUnit < TINY_TARGET_PX && (y1 - y0) * pxPerUnit < TINY_TARGET_PX;
  }

  // Marker and inset for the highlighted target when it is small at this
  // frame. The inset reuses the path data already computed for the scene.
  function addInset(code, kind = 'target') {
    const item = state.byCode.get(code);
    if (item === undefined || state.inset !== null || !(item.small || isTiny(item))) {
      return;
    }
    const layer = make('g', { class: 'map-inset-layer' });
    const marker = make('circle', { class: 'map-marker' });
    const box = make('rect', { class: 'map-inset-box' });
    const insetSvg = make('svg', { class: 'map-inset', preserveAspectRatio: 'xMidYMid meet' });
    layer.append(marker, box, insetSvg);
    // Below the labels, which stay frontmost.
    svg.insertBefore(layer, state.layer);
    state.inset = { code, kind, layer, entry: item, marker, box, insetSvg, sourceKey: null, paths: new Map(), markers: [] };
  }

  // The inset's content depends on its source box, so it is (re)built in
  // `relayout`: own land meeting the source box, plus the context path.
  // It reuses the scene's path data.
  function fillInset(source) {
    const inset = state.inset;
    inset.insetSvg.replaceChildren();
    inset.paths = new Map();
    inset.markers = [];
    if (state.scene.contextD !== '') {
      inset.insetSvg.append(make('path', { class: 'map-context', d: state.scene.contextD }));
    }
    for (const other of state.scene.land) {
      if (!boxesIntersect(other.bbox, source)) {
        continue;
      }
      const isInsetEntry = other.code === inset.code;
      const path = make('path', {
        class: isInsetEntry ? `map-land ${inset.kind === 'candidate' ? 'map-candidate' : 'map-target'}` : 'map-land',
        d: other.d
      });
      inset.insetSvg.append(path);
      inset.paths.set(other.code, path);
    }
    if (state.picked !== null && inset.paths.has(state.picked)) {
      inset.paths.get(state.picked).setAttribute('class', 'map-land map-picked');
    }
    if (state.candidates !== null) {
      state.candidates.forEach((code, index) => {
        inset.paths.get(code)?.setAttribute('class', 'map-land map-candidate');
        const point = markerPoint(code);
        if (point !== null && inset.paths.has(code)) {
          const text = make('text', {
            class: 'map-candidate-marker',
            x: point[0],
            y: point[1],
            'text-anchor': 'middle',
            'dominant-baseline': 'middle'
          });
          text.textContent = String(index + 1);
          inset.insetSvg.append(text);
          inset.markers.push(text);
        }
      });
    }
  }

  // Where a candidate's number goes: its label point, else its largest ring's centre.
  function markerPoint(code) {
    const item = state.byCode.get(code);
    if (item === undefined) {
      return null;
    }
    if (item.label !== undefined) {
      return item.label;
    }
    // The largest ring's centre: the union bbox of an entry cut at the
    // antimeridian (world.json) is centred near 0°.
    const [x0, y0, x1, y1] = largestRingBbox(item.rings);
    return [(x0 + x1) / 2, (y0 + y1) / 2];
  }

  function clearCandidates() {
    if (state === null || state.candidates === null) {
      return;
    }
    for (const code of state.candidates) {
      const restore = code === state.target ? 'map-land map-target' : 'map-land';
      state.paths.get(code)?.setAttribute('class', restore);
    }
    for (const text of state.markers) {
      state.layer.removeChild(text);
    }
    state.markers = [];
    state.candidates = null;
    if (state.inset !== null && state.inset.kind === 'candidate') {
      svg.removeChild(state.inset.layer);
      state.inset = null;
    } else if (state.inset !== null) {
      state.inset.sourceKey = null;
    }
    relayout();
  }

  function highlight(code) {
    const path = state.paths.get(code);
    if (path !== undefined) {
      path.setAttribute('class', 'map-land map-target');
      state.focus = code;
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
      if (target !== null && !scene.land.some((item) => item.code === target)) {
        throw new RangeError('`target` must be an entry of `geometry` drawn in this frame.');
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
        interactive, target, focus: null, picked: null, revealed: false, revealedTarget: null, labels: [], inset: null, candidates: null, markers: [], shadeMarkers: [], layer: make('g', { class: 'map-label-layer' })
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
      if (state.target !== null && target !== state.target) {
        throw new RangeError('`target` must be the target given to `render`.');
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
      if (state.revealed) {
        // Revealing the same target again is harmless; another one is a bug in the caller.
        if (target !== state.revealedTarget) {
          throw new RangeError('`target` must be the target already revealed on this render.');
        }
        return;
      }
      state.revealed = true;
      state.revealedTarget = target;
      state.interactive = false;
      clearCandidates();
      highlight(target);

      if (picked !== null && picked !== target && state.paths.has(picked)) {
        state.picked = picked;
        state.paths.get(picked).setAttribute('class', 'map-land map-picked');
        state.inset?.paths.get(picked)?.setAttribute('class', 'map-land map-picked');
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
        // Skip labels whose point lies outside the frame.
        const [lx, ly] = item.label;
        if (lx < state.frame[0] || lx > state.frame[2] || ly < state.frame[1] || ly > state.frame[3]) {
          continue;
        }
        const text = make('text', {
          class: code === target ? 'map-label map-label-target' : 'map-label',
          x: item.label[0],
          y: item.label[1],
          'text-anchor': 'middle',
          'dominant-baseline': 'middle'
        });
        text.textContent = name;
        state.layer.append(text);
        // Position, anchor and visibility are set by `relayout` (placeLabels).
        state.labels.push({ node: text, x: item.label[0], y: item.label[1], text: name, isTarget: code === target });
      }
      relayout();
    },

    /**
     * Outlines two candidates of an ambiguous tap and puts the digits "1" and
     * "2" (in the order given) at their label points. A small candidate also
     * appears in the inset (the first small one only). No names or codes
     * reach the DOM. Replaces earlier candidates.
     *
     * @param {[string, string]} codes Two distinct entries drawn in the current frame (the `ambiguous` pair of `onAmbiguous`).
     * @returns {void}
     */
    markCandidates(codes) {
      if (state === null) {
        throw new Error('`render` must be called before `markCandidates`.');
      }
      const isPair = Array.isArray(codes) && codes.length === 2 && codes.every((code) => typeof code === 'string');
      if (!isPair || codes[0] === codes[1]) {
        throw new TypeError('`codes` must be an array of two distinct country codes.');
      }
      if (!codes.every((code) => state.paths.has(code))) {
        throw new RangeError('`codes` must be entries drawn in the current frame.');
      }
      if (state.revealed) {
        return;
      }
      clearCandidates();
      state.candidates = [...codes];
      codes.forEach((code, index) => {
        state.paths.get(code).setAttribute('class', 'map-land map-candidate');
        const point = markerPoint(code);
        if (point !== null) {
          const text = make('text', {
            class: 'map-candidate-marker',
            x: point[0],
            y: point[1],
            'text-anchor': 'middle',
            'dominant-baseline': 'middle'
          });
          text.textContent = String(index + 1);
          state.layer.append(text);
          state.markers.push(text);
        }
      });
      const small = codes.find((code) => state.byCode.get(code)?.small === true);
      if (small !== undefined && state.inset === null) {
        addInset(small, 'candidate');
      } else if (state.inset !== null) {
        state.inset.sourceKey = null;
      }
      relayout();
    },

    /**
     * Shades entries (the missed ones on the results map): fills them with the
     * shade style and puts a circle marker on each one that is small at this
     * frame. Replaces earlier shading. No labels, names or codes reach the DOM.
     *
     * @param {string[]} codes Entries drawn in the current frame; may be empty. Throws if `render` was given a `target`.
     * @returns {void}
     */
    shade(codes) {
      if (state === null) {
        throw new Error('`render` must be called before `shade`.');
      }
      if (!Array.isArray(codes) || !codes.every((code) => typeof code === 'string')) {
        throw new TypeError('`codes` must be an array of country codes.');
      }
      if (!codes.every((code) => state.paths.has(code))) {
        throw new RangeError('`codes` must be entries drawn in the current frame.');
      }
      if (state.target !== null) {
        throw new RangeError('`shade` cannot be used on a card rendered with a `target`.');
      }
      const shaded = new Set(codes);
      for (const [code, path] of state.paths) {
        path.setAttribute('class', shaded.has(code) ? 'map-land map-shaded' : 'map-land');
      }
      for (const { circle } of state.shadeMarkers) {
        svg.removeChild(circle);
      }
      state.shadeMarkers = [];
      for (const code of shaded) {
        const item = state.byCode.get(code);
        const point = markerPoint(code);
        if (item.small && point !== null) {
          const circle = make('circle', { class: 'map-marker map-marker-shade', cx: point[0], cy: point[1], r: 1 });
          svg.insertBefore(circle, state.layer);
          state.shadeMarkers.push({ circle, x: point[0], y: point[1] });
        }
      }
      relayout();
    },

    /**
     * Removes the candidate outlines, number markers and candidate inset,
     * leaving the card as it was.
     *
     * @returns {void}
     */
    clearCandidates,

    relayout,

    /** Removes listeners and observers. */
    destroy() {
      svg.removeEventListener('click', handleClick);
      observer?.disconnect();
      state = null;
    }
  };
}
