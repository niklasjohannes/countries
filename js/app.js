// App entry point: loads the country data once, then shows one view at a
// time (home / practice / test / results). No URL routing: every page load starts on
// home, which is what resets the continent filter to "All".
//
// ---- View contract ----
//
// Each view is a module in `js/views/` exporting:
//
//   mount(container, context)  Render into `container` (the view's own
//                              `<section id="view-<name>">`, empty and
//                              visible). Called on every visit.
//   unmount()                  Undo anything outside the container: timers,
//                              listeners on `window`/`document`, pending work.
//                              The router then empties the container, so
//                              listeners on nodes inside it need no cleanup.
//
// Cleanup pattern: create an `AbortController` in `mount`, pass its `signal`
// to every `addEventListener`, and call `abort()` in `unmount`. Timers must
// be cleared the same way (`signal.addEventListener('abort', ...)`).
//
// `context` is frozen:
//
//   countries  The `countries` array of `data/countries.json` (deep-frozen),
//              including non-quizzed entries; count and filter through
//              `js/srs.js`, which only counts `quizzed` ones.
//   navigate   `(name, params?) => void`: unmount this view and mount view
//              `name` ('home' | 'practice' | 'test' | 'results') with `params`. Called
//              during another view's `mount` or `unmount`, it is deferred
//              (microtask) until that transition finishes.
//   params     What the caller passed to `navigate` (frozen; `{}` if none).
//              Home sends practice and test
//              `{ filter: { continent, subregion }, mode }`: each filter
//              field is a slug or `null` for All; `mode` is one of
//              `QUIZ_MODES` (js/storage.js).
//
// If `mount` throws, the view shows an error with a Reload button.
//
// ---- Ownership ----
//
//   js/views/home.js      css/style.css     issue 9 (home, base styles)
//   js/views/practice.js  css/practice.css  issue 10
//   js/views/test.js      css/test.css      issue 11 (also results.js)
//
// ---- Service worker ----
//
// `sw.js` precaches the whole app but does not skip waiting: a new deploy
// installs and waits, and the old worker keeps serving the old cache, so a
// round in progress never mixes new data with old JS. The page (js/sw-update.js)
// posts `SKIP_WAITING` only when it is on home with no sheet open and no
// import or export running, then reloads on `controllerchange`. A held-back
// reload is retried on every home mount, when the page becomes visible and
// when a sheet closes. A round or test is never interrupted.
//
// Browsers look for a new `sw.js` on navigation. An installed iOS app is
// usually resumed from the background instead, with no navigation, so the
// page also asks for an update check whenever it becomes visible again, at
// most once per `UPDATE_CHECK_INTERVAL_MS`. `updateViaCache: 'none'` keeps
// the HTTP cache out of that check.

import * as home from './views/home.js';
import * as practice from './views/practice.js';
import * as results from './views/results.js';
import * as test from './views/test.js';
import { watchResume } from './resume.js';
import { el } from './ui.js';
import { createUpdateFlow } from './sw-update.js';
import { isBusy, onIdle } from './busy.js';

const DATA_URL = './data/countries.json';

const VIEWS = Object.freeze({ home, practice, test, results });

/** Least time (ms) between two update checks on resume. */
export const UPDATE_CHECK_INTERVAL_MS = 15 * 60_000;

let countries = null;
let current = null;
let isTransitioning = false;
// See "Service worker" above; the rules are in js/update-reload.js. `null`
// until the service worker is being registered (and without support for it).
let updateFlow = null;

function deepFreeze(value) {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

async function loadCountries() {
  const response = await fetch(DATA_URL);
  if (!response.ok) {
    throw new Error(`Fetching ${DATA_URL} failed with HTTP ${response.status}.`);
  }
  const data = await response.json();
  if (typeof data !== 'object' || data === null || !Array.isArray(data.countries) || data.countries.length === 0) {
    throw new Error(`${DATA_URL} has no \`countries\` array.`);
  }
  return deepFreeze(data.countries);
}

function getContainer(name) {
  const container = document.getElementById(`view-${name}`);
  if (container === null) {
    throw new Error(`\`index.html\` has no \`#view-${name}\` section.`);
  }
  return container;
}

function showError(container, message, error) {
  console.error(error);
  const reloadButton = el('button', { type: 'button', class: 'button button-primary' }, ['Reload']);
  reloadButton.addEventListener('click', () => location.reload());
  container.replaceChildren(
    el('h1', {}, ['Something went wrong']),
    el('p', { class: 'status' }, [message]),
    el('div', { class: 'view-actions' }, [reloadButton])
  );
}

/**
 * Show view `name`, unmounting the current one.
 *
 * @param {string} name One of the keys of `VIEWS`.
 * @param {object} [params={}] Passed to the view as `context.params`.
 * @returns {void}
 */
function navigate(name, params = {}) {
  if (!Object.hasOwn(VIEWS, name)) {
    throw new RangeError(`\`name\` must be one of ${Object.keys(VIEWS).join(', ')}.`);
  }
  if (typeof params !== 'object' || params === null) {
    throw new TypeError('`params` must be an object.');
  }
  // A view navigating from inside its own mount/unmount would interleave two
  // transitions; run it once this one has finished instead.
  if (isTransitioning) {
    queueMicrotask(() => navigate(name, params));
    return;
  }
  // An update is waiting: reload instead of showing home.
  if (name === 'home' && updateFlow?.handle('navigatehome') === true) {
    return;
  }
  isTransitioning = true;
  try {
    transition(name, params);
  } finally {
    isTransitioning = false;
  }
}

function transition(name, params) {
  const previous = current;
  if (previous !== null) {
    try {
      previous.view.unmount();
    } catch (error) {
      console.error(error);
    }
    previous.container.replaceChildren();
    previous.container.hidden = true;
  }
  const container = getContainer(name);
  current = { name, view: VIEWS[name], container };
  container.hidden = false;
  window.scrollTo(0, 0);
  try {
    VIEWS[name].mount(container, Object.freeze({
      countries,
      navigate,
      params: deepFreeze(structuredClone(params))
    }));
  } catch (error) {
    showError(container, 'This screen failed to load. Reload to start again.', error);
  }
  // Home was reached (perhaps without a tap): a held-back update may go now.
  if (name === 'home') {
    updateFlow?.retry();
  }
  // Move focus into the new view (not on first load), so keyboard and screen
  // reader users are not left on a button that no longer exists.
  if (previous !== null && !container.contains(document.activeElement)) {
    container.focus({ preventScroll: true });
  }
}

// What js/sw-update.js asks about before it takes over or reloads: any open
// sheet on any screen, or an import or export still running, holds it back.
function getUpdateView() {
  return {
    isOnHome: current !== null && current.name === 'home',
    hasOpenDialog: isBusy() || document.querySelector('dialog[open]') !== null,
    isUserTap: isTapInProgress
  };
}

function unmountCurrent() {
  if (current === null) {
    return;
  }
  try {
    current.view.unmount();
  } catch (error) {
    console.error(error);
  }
  current.container.replaceChildren();
  current = null;
}

// True only while a click is being dispatched, so a `navigate('home')` from
// later async work (such as an import's write) does not count as a tap. The
// flag clears in a timer, after every listener for this click has run.
let isTapInProgress = false;
document.addEventListener('click', () => {
  isTapInProgress = true;
  setTimeout(() => {
    isTapInProgress = false;
  }, 0);
}, { capture: true });

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    return;
  }
  updateFlow = createUpdateFlow({
    serviceWorker: navigator.serviceWorker,
    getView: getUpdateView,
    reload: () => {
      // Tear the view down first, so its timers and listeners stop before the reload.
      unmountCurrent();
      location.reload();
    },
    onIdle
  });
  await updateFlow.start();
  // Registering checks for an update itself, so the clock starts now.
  let lastCheckAt = Date.now();
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((registration) => {
    updateFlow.watch(registration);
    document.addEventListener('visibilitychange', () => {
      const isDue = Date.now() - lastCheckAt >= UPDATE_CHECK_INTERVAL_MS;
      if (document.visibilityState !== 'visible' || !isDue || navigator.onLine === false) {
        return;
      }
      lastCheckAt = Date.now();
      // Fails when offline or the server is down; the next resume retries.
      registration.update().catch(() => {});
    });
  }, (error) => {
    // The app still works online without it.
    console.warn('Service worker registration failed; offline use is unavailable.', error);
  });
}

async function start() {
  // Before home first mounts, so its resume listeners run after these.
  watchResume();
  try {
    countries = await loadCountries();
  } catch (error) {
    showError(getContainer('home'), 'Could not load the country data. Check your connection and reload.', error);
    return;
  }
  navigate('home');
}

start();

// After the page has loaded, so precaching does not compete with first paint.
if (document.readyState === 'complete') {
  registerServiceWorker();
} else {
  window.addEventListener('load', registerServiceWorker, { once: true });
}
