// Small input checks shared by the pure modules, so each one does not carry its own copy.

/**
 * Whether `value` is a plain object (not `null`, not an array).
 *
 * @param {unknown} value Anything.
 * @returns {boolean} `true` for `{}`-like values.
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Throws unless `frame` is `[x0, y0, x1, y1]` of finite numbers with
 * `x1 > x0` and `y1 > y0`.
 *
 * @param {unknown} frame The frame to check.
 * @returns {void}
 */
export function assertFrame(frame) {
  const isShape = Array.isArray(frame) && frame.length === 4 && frame.every(Number.isFinite);
  if (!isShape || !(frame[2] > frame[0]) || !(frame[3] > frame[1])) {
    throw new TypeError('`frame` must be an `[x0, y0, x1, y1]` array of finite numbers with `x1 > x0` and `y1 > y0`.');
  }
}
