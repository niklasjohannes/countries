// When the page reloads after a new service worker took over (spec #8). Pure:
// js/app.js feeds it events and does the reload; test/update-reload.test.js
// covers the rules.
//
// `sw.js` does not skip waiting on install; js/sw-update.js posts `SKIP_WAITING`
// when it is safe, and the takeover is a `controllerchange`. The page's JS is
// then the old version, so it reloads, but only where nothing is lost (the
// rules below also hold if a takeover arrives at a bad moment, say from a
// second tab):
//   - the first `controllerchange` on a page that had no worker and no
//     registration (first visit) is not an update: no reload. A page that
//     loaded with a registration but no controller (a hard reload) is
//     running old JS already, so js/sw-update.js counts it as having a worker;
//   - after an update, reload at once only on home with no sheet
//     (`<dialog>`) open and no import or export running;
//   - otherwise wait; js/sw-update.js retries (as `dialogclose`) on every home
//     mount, whenever the page becomes visible, when a sheet closes and when
//     busy work settles, so a held-back reload is not forgotten;
//   - `navigatehome` (a navigation to home about to happen) reloads instead of
//     navigating only when the user tapped to get there, never for a
//     programmatic `navigate('home')` (for example after an import has
//     written its data);
//   - reload at most once.

/** Events `decideReload` understands. */
export const RELOAD_EVENTS = Object.freeze(['controllerchange', 'dialogclose', 'navigatehome']);

/**
 * Initial state.
 *
 * @param {boolean} hadController Whether the page already ran under a
 *   service worker when it loaded: a controller, or an existing registration.
 * @returns {{ hadController: boolean, isPending: boolean, isReloading: boolean }}
 *   Frozen.
 */
export function createReloadState(hadController) {
  if (typeof hadController !== 'boolean') {
    throw new TypeError('`hadController` must be a boolean.');
  }
  return Object.freeze({ hadController, isPending: false, isReloading: false });
}

/**
 * Apply one event.
 *
 * @param {{ hadController: boolean, isPending: boolean, isReloading: boolean }}
 *   state From `createReloadState` or a previous call.
 * @param {string} event One of `RELOAD_EVENTS`: a new worker took over, a
 *   `<dialog>` closed or some work settled, or the user is navigating home.
 * @param {{ isOnHome: boolean, hasOpenDialog: boolean, isUserTap: boolean }} view
 *   What is on screen now, and whether this navigation came from a tap.
 *   `isUserTap` is only read for `'navigatehome'`.
 * @returns {{ state: object, reload: boolean }} The next state (frozen), and
 *   whether to reload now. `reload` is `true` at most once per state chain.
 *   After `'navigatehome'`, skip the navigation if `state.isReloading`.
 */
export function decideReload(state, event, view) {
  if (typeof state !== 'object' || state === null ||
    !['hadController', 'isPending', 'isReloading'].every((key) => typeof state[key] === 'boolean')) {
    throw new TypeError('`state` must come from `createReloadState` or `decideReload`.');
  }
  if (!RELOAD_EVENTS.includes(event)) {
    throw new RangeError(`\`event\` must be one of ${RELOAD_EVENTS.join(', ')}.`);
  }
  if (typeof view !== 'object' || view === null ||
    typeof view.isOnHome !== 'boolean' || typeof view.hasOpenDialog !== 'boolean' ||
    typeof view.isUserTap !== 'boolean') {
    throw new TypeError('`view` must be `{ isOnHome: boolean, hasOpenDialog: boolean, isUserTap: boolean }`.');
  }

  let next = state;
  if (event === 'controllerchange') {
    next = state.hadController
      ? { ...state, isPending: true }
      : { ...state, hadController: true };
  }
  const isSafe = event === 'navigatehome'
    ? view.isUserTap && !view.hasOpenDialog
    : view.isOnHome && !view.hasOpenDialog;
  const reload = next.isPending && !next.isReloading && isSafe;
  if (reload) {
    next = { ...next, isReloading: true };
  }
  return { state: Object.freeze({ ...next }), reload };
}
