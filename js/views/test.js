// Test view (PLAN decision 13): every quizzed entry in the filter, once, in
// random order, map → name, blind. Each question is the entry highlighted on
// its own continent frame (`FRAME_LEVEL_CONTINENT`), answered by MC or typing
// as the mode says. There is no feedback of any kind: no reveal, no labels,
// no score on screen, only a position counter. The last answer goes to the
// results view.
//
// Test mode never reads or writes SRS state: nothing here calls a storage
// function, and a pass in progress lives in memory only, so a reload discards
// it (test/test-isolation.test.js guards both).
//
// `params`: `{ filter: { continent, subregion }, mode }` from home (see the
// view contract in js/app.js). Results' Retake sends the same.
//
// No spoilers: the map carries no names and the DOM has no country name until
// the results view. Exit asks first, in an in-app sheet (a modal `<dialog>`),
// never `window.confirm`.

import { createMapView, FRAME_LEVEL_CONTINENT } from '../map-view.js';
import { META_URL, fetchJson, getGeometryUrl } from '../data.js';
import { guardQuestionArea, renderQuestion } from '../question.js';
import { createTestPass, isPassComplete, recordTestAnswer } from '../test-pass.js';
import { el } from '../ui.js';

const EXIT_TITLE = 'Leave this test?';
const EXIT_MESSAGE = 'Your answers so far will not be kept.';

let controller = null;

/**
 * Render the test view and start a pass.
 *
 * @param {HTMLElement} container The view's section.
 * @param {{ countries: object[], navigate: Function, params: object }} context
 *   See `js/app.js`.
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
  const { filter, mode } = params;
  // Throws on a bad filter; the router then shows its error.
  const pass = createTestPass({ countries, filter, rng: Math.random });
  controller = new AbortController();
  startPass(container, { countries, navigate, filter: pass.filter, mode, pass, signal: controller.signal });
}

// The "leave this test?" sheet. `open()` shows it modally; Leave closes it
// and calls `onLeave`; Cancel, Escape or a tap on the backdrop just close it
// and focus again whatever had focus when it opened, if still on screen.
function createExitSheet({ onLeave, signal }) {
  const leaveButton = el('button', { type: 'button', class: 'button button-primary', 'data-action': 'leave' }, ['Leave test']);
  const cancelButton = el('button', { type: 'button', class: 'button button-secondary', 'data-action': 'cancel', autofocus: true }, ['Cancel']);
  const dialog = el('dialog', {
    class: 'sheet test-exit-sheet',
    'aria-labelledby': 'test-exit-title',
    'aria-describedby': 'test-exit-text'
  }, [
    el('div', { class: 'sheet-body' }, [
      el('h2', { id: 'test-exit-title', class: 'sheet-title' }, [EXIT_TITLE]),
      el('p', { id: 'test-exit-text', class: 'sheet-text' }, [EXIT_MESSAGE]),
      el('div', { class: 'sheet-actions' }, [leaveButton, cancelButton])
    ])
  ]);

  let returnFocusTo = null;
  // Run from the Cancel / backdrop tap itself: if the input had focus, it is
  // refocused inside the tap, the only place iOS lets `focus()` bring the
  // keyboard back. Escape closes without a tap, so this also runs on `close`.
  const restoreFocus = () => {
    const target = returnFocusTo;
    returnFocusTo = null;
    if (target !== null && target.isConnected) {
      target.focus({ preventScroll: true });
    }
  };
  const close = () => {
    if (dialog.open) {
      dialog.close();
    }
    restoreFocus();
  };
  dialog.addEventListener('close', restoreFocus, { signal });
  cancelButton.addEventListener('click', close, { signal });
  leaveButton.addEventListener('click', () => {
    returnFocusTo = null;
    dialog.close();
    onLeave();
  }, { signal });
  // `.sheet-body` fills the dialog, so a click on the dialog itself is a
  // click on the backdrop.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      close();
    }
  }, { signal });

  const open = () => {
    if (dialog.open) {
      return;
    }
    returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
  };
  return { dialog, open };
}

function showMessage(container, navigate, signal, text) {
  const back = el('button', { type: 'button', class: 'button button-secondary' }, ['Back']);
  back.addEventListener('click', () => navigate('home'), { signal });
  container.replaceChildren(
    el('p', { class: 'status' }, [text]),
    el('div', { class: 'view-actions' }, [back])
  );
}

async function startPass(container, { countries, navigate, filter, mode, pass: firstPass, signal }) {
  let pass = firstPass;
  const byCode = new Map(countries.map((country) => [country.code, country]));
  try {
    container.replaceChildren(el('p', { class: 'status' }, ['Loading…']));
    const continents = [...new Set(pass.codes.map((code) => byCode.get(code).continent))];
    const [meta, ...files] = await Promise.all([
      fetchJson(META_URL),
      ...continents.map((continent) => fetchJson(getGeometryUrl(continent)))
    ]);
    if (signal.aborted) {
      return;
    }
    const geometries = new Map(continents.map((continent, i) => [continent, files[i]]));

    const counter = el('p', { class: 'view-counter test-counter' });
    const exitSheet = createExitSheet({ onLeave: () => navigate('home'), signal });
    const exitButton = el('button', {
      type: 'button',
      class: 'button-quiet test-exit',
      'aria-haspopup': 'dialog'
    }, ['Exit']);
    exitButton.addEventListener('click', exitSheet.open, { signal });
    const mapBox = el('div', { class: 'test-map' });
    const stage = el('div', { class: 'test-question' });
    const mapView = createMapView();
    mapBox.append(mapView.element);
    signal.addEventListener('abort', () => mapView.destroy());

    // A double tap, or a held Enter, must not answer the next question unseen.
    const guard = guardQuestionArea(stage, { signal });

    container.replaceChildren(
      el('div', { class: 'view-bar test-bar' }, [exitButton, counter]),
      mapBox,
      stage,
      exitSheet.dialog
    );

    const showQuestion = () => {
      const position = pass.answers.length;
      const code = pass.codes[position];
      const { continent } = byCode.get(code);
      counter.textContent = `${position + 1} / ${pass.codes.length}`;
      mapView.render({
        geometry: geometries.get(continent),
        meta,
        frame: meta.frames[continent],
        frameLevel: FRAME_LEVEL_CONTINENT,
        target: code
      });
      // Advance straight away: never `reveal()`, so nothing shows whether the
      // answer was right.
      const question = renderQuestion(stage, {
        code,
        mode,
        countries,
        neighbours: meta.entries[code]?.neighbours ?? [],
        rng: Math.random,
        signal,
        onAnswer: (chosenCode) => {
          pass = recordTestAnswer(pass, chosenCode);
          if (isPassComplete(pass)) {
            navigate('results', { mode, pass });
          } else {
            showQuestion();
          }
        }
      });
      guard.arm();
      mapView.relayout();
      // Keeps focus (and the iOS keyboard, in typing mode) in the question.
      question.focus();
    };
    showQuestion();
  } catch (error) {
    console.error(error);
    if (!signal.aborted) {
      showMessage(container, navigate, signal, 'Something went wrong with this test. Go back and try again.');
    }
  }
}

/**
 * Clean up the test view. A pass in progress is dropped.
 *
 * @returns {void}
 */
export function unmount() {
  controller?.abort();
  controller = null;
}
