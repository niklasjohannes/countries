// Pure map logic: SVG path data, tap hit-testing and small-entry insets.
//
// Pure module: no DOM, no `localStorage`, no clock, no `Math.random`. All
// coordinates are in the integer space of one geometry file
// (`data/geometry/<continent>.json`, y grows downwards). A `frame` is a
// `[x0, y0, x1, y1]` box in that space (from `data/map-meta.json` →
// `frames`).
//
// Viewport contract (for the renderer, issue 8): `viewportPx` is
// `{ width, height }`, the CSS px size of the SVG box the frame is drawn
// into with `viewBox = frame` and the default `preserveAspectRatio`
// (`xMidYMid meet`). The scale is then `min(width / frameWidth,
// height / frameHeight)` CSS px per unit (see `getPxPerUnit`), so tap
// tolerances and markers keep a fixed physical size on screen whether the
// frame is width- or height-limited. `point` must already be in frame units
// (e.g. via `getScreenCTM().inverse()`).

// ---- Tunables ----

/** Tap tolerance radius in CSS px (about 7 mm on a phone). */
export const TAP_TOLERANCE_PX = 24;

/**
 * A tap is ambiguous when the second-nearest tappable entry is no more than
 * this many times as far away as the nearest one.
 */
export const AMBIGUITY_RATIO = 1.5;

/** Side of an inset box, as a share of the frame's shorter side. */
export const INSET_SIZE_SHARE = 0.3;

/** Gap between an inset box and the frame edge, as a share of the frame's shorter side. */
export const INSET_MARGIN_SHARE = 0.02;

/** Padding around the entry's bbox inside the inset, as a share of the bbox's longer side (each side). */
export const INSET_PADDING_SHARE = 0.5;

/** Minimum circle-marker radius in CSS px. */
export const MARKER_MIN_RADIUS_PX = 6;

// ---- Validation helpers ----

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Rings already validated by `hitTest`, so repeated taps on the same,
// unchanged geometry skip the per-point checks. Holds no strong references.
const validatedRings = new WeakSet();

function assertIntegerRings(rings, name) {
  if (!Array.isArray(rings)) {
    throw new TypeError(`\`${name}\` must be an array of rings.`);
  }
  rings.forEach((ring, i) => {
    if (!Array.isArray(ring) || ring.length < 3) {
      throw new TypeError(`\`${name}[${i}]\` must be an array of at least 3 \`[x, y]\` points.`);
    }
    ring.forEach((point, j) => {
      const isValid = Array.isArray(point) &&
        point.length === 2 &&
        Number.isSafeInteger(point[0]) &&
        Number.isSafeInteger(point[1]);
      if (!isValid) {
        throw new TypeError(`\`${name}[${i}][${j}]\` must be an \`[x, y]\` pair of safe integers.`);
      }
    });
  });
}

function assertPoint(point, name) {
  const isValid = Array.isArray(point) &&
    point.length === 2 &&
    Number.isFinite(point[0]) &&
    Number.isFinite(point[1]);
  if (!isValid) {
    throw new TypeError(`\`${name}\` must be an \`[x, y]\` pair of finite numbers.`);
  }
}

function assertBox(box, name, { allowEmpty }) {
  const isShape = Array.isArray(box) && box.length === 4 && box.every(Number.isFinite);
  if (!isShape) {
    throw new TypeError(`\`${name}\` must be an \`[x0, y0, x1, y1]\` array of finite numbers.`);
  }
  const [x0, y0, x1, y1] = box;
  const isOrdered = allowEmpty ? x1 >= x0 && y1 >= y0 : x1 > x0 && y1 > y0;
  if (!isOrdered) {
    const relation = allowEmpty ? 'at least' : 'greater than';
    throw new RangeError(`\`${name}\` must have \`x1\` and \`y1\` ${relation} \`x0\` and \`y0\`.`);
  }
}

function assertViewport(viewportPx) {
  const isValid = isPlainObject(viewportPx) &&
    Number.isFinite(viewportPx.width) &&
    Number.isFinite(viewportPx.height) &&
    viewportPx.width > 0 &&
    viewportPx.height > 0;
  if (!isValid) {
    throw new TypeError('`viewportPx` must be a `{ width, height }` object of positive finite CSS px.');
  }
}

function assertEntries(entries) {
  if (!isPlainObject(entries)) {
    throw new TypeError('`entries` must be an object mapping country codes to `{ rings, tappable }` entries.');
  }
  for (const [code, entry] of Object.entries(entries)) {
    if (!isPlainObject(entry)) {
      throw new TypeError(`\`entries.${code}\` must be a \`{ rings, tappable }\` object.`);
    }
    if (!validatedRings.has(entry.rings)) {
      assertIntegerRings(entry.rings, `entries.${code}.rings`);
      validatedRings.add(entry.rings);
    }
    if (entry.bbox !== undefined) {
      assertBox(entry.bbox, `entries.${code}.bbox`, { allowEmpty: true });
    }
    if (typeof entry.tappable !== 'boolean') {
      throw new TypeError(`\`entries.${code}.tappable\` must be a boolean.`);
    }
  }
}

// ---- Geometry helpers ----

function isClosed(ring) {
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

// Even-odd rule across every ring of an entry, so a hole (a ring inside the
// outer ring, as Lesotho is in South Africa) and a multi-polygon (islands)
// need no extra structure. Works for closed and unclosed rings alike.
function containsPoint(rings, [px, py]) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      const crosses = (yi > py) !== (yj > py) &&
        px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
      if (crosses) {
        inside = !inside;
      }
    }
  }
  return inside;
}

function distanceToSegment([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function distanceToRings(rings, point) {
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      best = Math.min(best, distanceToSegment(point, ring[j], ring[i]));
    }
  }
  return best;
}

function boundsOf(rings) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  return [x0, y0, x1, y1];
}

// Distance from a point to a box (0 inside); a cheap lower bound on the
// distance to the rings inside it.
function distanceToBox([px, py], [x0, y0, x1, y1]) {
  const dx = Math.max(x0 - px, 0, px - x1);
  const dy = Math.max(y0 - py, 0, py - y1);
  return Math.hypot(dx, dy);
}

function compareCandidates(a, b) {
  return a.distance - b.distance || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
}

// ---- Public API ----

/**
 * Builds an SVG path `d` string from integer rings. The output contains only
 * `M`, `L` and `Z` commands, digits, `-` and spaces, so it is safe to pass to
 * `setAttribute('d', …)`. A ring's closing point (equal to its first point)
 * is dropped in favour of `Z`.
 *
 * @param {Array<Array<[number, number]>>} rings Rings of safe-integer `[x, y]` points, at least 3 points each.
 * @returns {string} Path data, e.g. `'M0 0L10 0L10 10Z'`; `''` for no rings.
 */
export function ringsToPathData(rings) {
  assertIntegerRings(rings, 'rings');
  return rings
    .map((ring) => {
      const points = isClosed(ring) ? ring.slice(0, -1) : ring;
      const commands = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`);
      return `${commands.join('')}Z`;
    })
    .join('');
}

/**
 * Bounding box of the entry's largest ring (by bbox area). An entry's union
 * bbox over-states a scattered archipelago: what the user has to hit is the
 * biggest piece.
 * @param {number[][][]} rings closed rings of `[x, y]` integer points
 * @returns {number[]} [x0, y0, x1, y1]
 */
export function largestRingBbox(rings) {
  if (!Array.isArray(rings) || rings.length === 0) throw new TypeError('`rings` must be a non-empty array of rings.');
  let best = null;
  let bestArea = -1;
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length === 0) throw new TypeError('`rings` must contain non-empty rings.');
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of ring) {
      box[0] = Math.min(box[0], x);
      box[1] = Math.min(box[1], y);
      box[2] = Math.max(box[2], x);
      box[3] = Math.max(box[3], y);
    }
    const area = (box[2] - box[0]) * (box[3] - box[1]);
    if (area > bestArea) {
      best = box;
      bestArea = area;
    }
  }
  return best;
}

/**
 * CSS px per frame unit for a frame drawn into a `viewportPx` box with
 * `preserveAspectRatio="xMidYMid meet"`: the smaller of the two axis scales.
 *
 * @param {[number, number, number, number]} frame The visible `[x0, y0, x1, y1]` box.
 * @param {{ width: number, height: number }} viewportPx CSS px size of the SVG box.
 * @returns {number} CSS px per frame unit.
 */
export function getPxPerUnit(frame, viewportPx) {
  assertBox(frame, 'frame', { allowEmpty: false });
  assertViewport(viewportPx);
  return Math.min(viewportPx.width / (frame[2] - frame[0]), viewportPx.height / (frame[3] - frame[1]));
}

/**
 * Resolves a tap on the map to a country.
 *
 * 1. If the point is inside an entry's rings (even-odd, so holes count as
 *    outside), that entry wins. Tappable or not, an inside tap is exact. If
 *    several contain it (simplification overlap), the one with the smallest
 *    bounding box wins.
 * 2. Otherwise the nearest *tappable* entry within `TAP_TOLERANCE_PX` CSS px
 *    (point-to-segment distance) wins, unless the second-nearest tappable
 *    entry within tolerance is at most `AMBIGUITY_RATIO` times as far, in
 *    which case the caller should ask the user to confirm.
 * 3. Otherwise `null`.
 *
 * Ties are broken by code, so the result is deterministic.
 *
 * @param {[number, number]} point The tap, in the geometry file's coordinate space.
 * Rings are validated once per array (cached by identity), so geometry must
 * not be mutated after the first call. A precomputed `bbox` is used when given.
 *
 * @param {Object<string, { rings: Array<Array<[number, number]>>, tappable: boolean, bbox?: [number, number, number, number] }>} entries Entries drawn in the frame, keyed by code.
 * @param {[number, number, number, number]} frame The visible `[x0, y0, x1, y1]` box.
 * @param {{ width: number, height: number }} viewportPx CSS px size of the SVG box (see the module header).
 * @returns {{ code: string } | { ambiguous: [string, string] } | null} The hit, an ambiguous pair (nearest first), or `null`.
 */
export function hitTest(point, entries, frame, viewportPx) {
  assertPoint(point, 'point');
  assertEntries(entries);
  const pxPerUnit = getPxPerUnit(frame, viewportPx);

  const codes = Object.keys(entries).sort();
  const bounds = new Map(codes.map((code) => [code, entries[code].bbox ?? boundsOf(entries[code].rings)]));

  const containing = codes
    .filter((code) => distanceToBox(point, bounds.get(code)) === 0 && containsPoint(entries[code].rings, point))
    .map((code) => {
      const [x0, y0, x1, y1] = bounds.get(code);
      return { code, distance: (x1 - x0) * (y1 - y0) };
    })
    .sort(compareCandidates);
  if (containing.length > 0) {
    return { code: containing[0].code };
  }

  const toleranceUnits = TAP_TOLERANCE_PX / pxPerUnit;
  const candidates = codes
    .filter((code) => entries[code].tappable && distanceToBox(point, bounds.get(code)) <= toleranceUnits)
    .map((code) => ({ code, distance: distanceToRings(entries[code].rings, point) }))
    .filter((candidate) => candidate.distance <= toleranceUnits)
    .sort(compareCandidates);

  if (candidates.length === 0) {
    return null;
  }
  const [nearest, second] = candidates;
  if (second !== undefined && second.distance <= nearest.distance * AMBIGUITY_RATIO) {
    return { ambiguous: [nearest.code, second.code] };
  }
  return { code: nearest.code };
}

/**
 * Lays out the circle marker and zoomed inset for a (small) entry.
 *
 * - `marker`: a circle around the entry, at least `MARKER_MIN_RADIUS_PX` CSS px
 *   in radius at the given viewport, so it stays visible.
 * - `source`: a square around the entry's bbox, padded by
 *   `INSET_PADDING_SHARE` of its longer side, i.e. the part of the map the
 *   inset magnifies (its `viewBox`).
 * - `target`: a square of `INSET_SIZE_SHARE` of the frame's shorter side, in
 *   the frame corner farthest from the entry, `INSET_MARGIN_SHARE` from the
 *   edges: where the inset is drawn.
 *
 * All boxes are `[x0, y0, x1, y1]` in the geometry file's coordinate space.
 *
 * @param {{ bbox: [number, number, number, number] }} entry A geometry entry.
 * @param {[number, number, number, number]} frame The visible `[x0, y0, x1, y1]` box.
 * @param {{ width: number, height: number }} viewportPx CSS px size of the SVG box (see the module header).
 * @returns {{ marker: { cx: number, cy: number, r: number }, source: [number, number, number, number], target: [number, number, number, number] }} The inset layout.
 */
export function computeInset(entry, frame, viewportPx) {
  if (!isPlainObject(entry)) {
    throw new TypeError('`entry` must be a geometry entry object with a `bbox`.');
  }
  assertBox(entry.bbox, 'entry.bbox', { allowEmpty: true });
  const pxPerUnit = getPxPerUnit(frame, viewportPx);

  const [bx0, by0, bx1, by1] = entry.bbox;
  const [fx0, fy0, fx1, fy1] = frame;
  const frameShortSide = Math.min(fx1 - fx0, fy1 - fy0);
  const cx = (bx0 + bx1) / 2;
  const cy = (by0 + by1) / 2;

  const r = Math.max(Math.hypot(bx1 - bx0, by1 - by0) / 2, MARKER_MIN_RADIUS_PX / pxPerUnit);

  const longSide = Math.max(bx1 - bx0, by1 - by0);
  const sourceHalf = longSide > 0 ? (longSide * (1 + 2 * INSET_PADDING_SHARE)) / 2 : r;
  const source = [cx - sourceHalf, cy - sourceHalf, cx + sourceHalf, cy + sourceHalf];

  const size = frameShortSide * INSET_SIZE_SHARE;
  const margin = frameShortSide * INSET_MARGIN_SHARE;
  const isLeft = cx < (fx0 + fx1) / 2;
  const isTop = cy < (fy0 + fy1) / 2;
  const tx0 = isLeft ? fx1 - margin - size : fx0 + margin;
  const ty0 = isTop ? fy1 - margin - size : fy0 + margin;
  const target = [tx0, ty0, tx0 + size, ty0 + size];

  return { marker: { cx, cy, r }, source, target };
}
