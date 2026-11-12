// Work that must finish before the page may reload (an import reading and
// writing progress, an export building a file). js/app.js holds a service-
// worker reload back while any of it is running, and retries once it settles.

let activeCount = 0;
const idleListeners = new Set();

/**
 * Mark the start of a piece of work.
 *
 * @returns {() => void} Call it once the work has settled, on success or
 *   failure. Calling it again does nothing.
 */
export function beginBusy() {
  activeCount += 1;
  let ended = false;
  return () => {
    if (ended) {
      return;
    }
    ended = true;
    activeCount -= 1;
    if (activeCount === 0) {
      for (const listener of idleListeners) {
        listener();
      }
    }
  };
}

/**
 * Whether any work is running.
 *
 * @returns {boolean} `true` between a `beginBusy` and its end.
 */
export function isBusy() {
  return activeCount > 0;
}

/**
 * Run `listener` each time the last running work settles.
 *
 * @param {() => void} listener Called with no arguments.
 * @returns {void}
 */
export function onIdle(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('`listener` must be a function.');
  }
  idleListeners.add(listener);
}
