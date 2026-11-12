// The page's side of a service-worker update (js/app.js wires it up).
//
// `sw.js` does not call `skipWaiting()` on install: a new worker waits, and the
// old one keeps serving the old cache, so a round in progress never loads new
// geometry against old JS and meta. This module asks the waiting worker to take
// over (a `SKIP_WAITING` message) only when it is safe, which is home with no
// sheet open and no import or export running, and reloads on `controllerchange`
// (rules in js/update-reload.js). The reload is retried on every home mount,
// whenever the page becomes visible and whenever a sheet closes or work settles,
// so a reload that was held back is never forgotten.

import { createReloadState, decideReload } from './update-reload.js';

/** Message the page posts to a waiting worker, and `sw.js` accepts. */
export const SKIP_WAITING_MESSAGE = Object.freeze({ type: 'SKIP_WAITING' });

/**
 * Whether the page already ran under a service worker when it loaded, so that
 * a later takeover is an update and not a first install: it has a controller,
 * or an *active* registration (a hard reload has none; a first install in
 * progress has a registration whose worker is only installing).
 *
 * @param {{ controller: object | null, getRegistration: Function }} serviceWorker `navigator.serviceWorker`.
 * @returns {Promise<boolean>} `true` for an update.
 */
export async function getHadController(serviceWorker) {
  if (serviceWorker.controller !== null) {
    return true;
  }
  try {
    const existing = await serviceWorker.getRegistration();
    return existing?.active != null;
  } catch {
    // No registration to read: treat the page as a first visit (no reload).
    return false;
  }
}

/**
 * Wires the update flow.
 *
 * @param {object} options
 * @param {{ controller: object | null, addEventListener: Function, getRegistration: Function }} options.serviceWorker `navigator.serviceWorker`.
 * @param {() => { isOnHome: boolean, hasOpenDialog: boolean, isUserTap: boolean }} options.getView What is on screen now.
 * @param {() => void} options.reload Tears the view down and reloads the page.
 * @param {Document} [options.document] Where `close` and `visibilitychange` are heard.
 * @param {(listener: () => void) => void} [options.onIdle] Registers a listener for when busy work settles.
 * @returns {{ start: () => Promise<void>, watch: (registration: object) => void, handle: (event: string) => boolean, retry: () => void }}
 *   `start` attaches the listeners and reads whether this is an update;
 *   `watch` follows a registration's waiting worker; `handle` feeds
 *   js/update-reload.js and returns whether a reload has started; `retry` asks
 *   again for both the takeover and a held-back reload.
 */
export function createUpdateFlow({ serviceWorker, getView, reload, document: doc = globalThis.document, onIdle }) {
  if (typeof getView !== 'function' || typeof reload !== 'function') {
    throw new TypeError('`getView` and `reload` must be functions.');
  }
  let state = createReloadState(false);
  let waiting = null;
  let hasAsked = false;
  // A `controllerchange` before `start` has read the registration is held and replayed.
  let isReady = false;
  let isChangePending = false;

  function handle(event) {
    const decision = decideReload(state, event, getView());
    state = decision.state;
    if (decision.reload) {
      reload();
    }
    return state.isReloading;
  }

  // Only from home with nothing open: the takeover is what reloads the page.
  function askToTakeOver() {
    if (waiting === null || hasAsked) {
      return;
    }
    const view = getView();
    if (!view.isOnHome || view.hasOpenDialog) {
      return;
    }
    hasAsked = true;
    waiting.postMessage(SKIP_WAITING_MESSAGE);
  }

  function retry() {
    askToTakeOver();
    handle('dialogclose');
  }

  function consider(worker) {
    waiting = worker;
    hasAsked = false;
    askToTakeOver();
  }

  return {
    async start() {
      // First, so a takeover that happens while `getRegistration` is pending is seen.
      serviceWorker.addEventListener('controllerchange', () => {
        if (isReady) {
          handle('controllerchange');
        } else {
          isChangePending = true;
        }
      });
      const hadController = await getHadController(serviceWorker);
      state = Object.freeze({ ...state, hadController });
      isReady = true;
      if (isChangePending) {
        isChangePending = false;
        handle('controllerchange');
      }
      // `close` does not bubble, so listen in the capture phase.
      doc.addEventListener('close', retry, { capture: true });
      doc.addEventListener('visibilitychange', () => {
        if (doc.visibilityState === 'visible') {
          // The worker may have declined (a second window was open): ask again.
          hasAsked = false;
          retry();
        }
      });
      onIdle?.(retry);
    },

    watch(registration) {
      // A worker already waiting, or one that finishes installing while this
      // page is controlled (without a controller this is the first install).
      if (registration.waiting != null && serviceWorker.controller !== null) {
        consider(registration.waiting);
      }
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        installing?.addEventListener('statechange', () => {
          if (installing.state === 'installed' && serviceWorker.controller !== null) {
            consider(installing);
          }
        });
      });
    },

    handle,
    retry
  };
}
