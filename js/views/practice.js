// Practice view (PLAN decisions 5, 6, 10, 11, 12): rounds of `ROUND_SIZE`
// cards from the SRS scheduler, scoped to the filter picked on home, then a
// round-end summary with Keep going / Done.
//
// Receives `params: { filter: { continent, subregion }, mode }` from home. See
// the view contract in js/app.js. Round logic (what is asked next, which
// answer counts, the frame and feedback plan, saving) is in
// js/practice-round.js; this file renders it.
//
// Each card is a map (js/map-view.js) plus an answer area:
//   - map → name: the target is filled on the unlabelled map; the answer area
//     is MC or typing (js/question.js), following the mode toggle;
//   - name → tap: the answer area is the prompt "Tap <name>"; a tap on the map
//     answers, and an ambiguous tap numbers both candidates "1" and "2" on the
//     map and opens a sheet with buttons "1", "2" and Cancel (no names).
//
// Feedback is hybrid (decision 12): a hit is revealed without labels and
// advances after `HIT_ADVANCE_MS`; a miss keeps the target filled, outlines
// the wrong pick, labels the target and its neighbours, and waits for Next.
// A miss is re-queued (`requeueLapse`, inside `answerCurrent`).
//
// No spoilers: nothing in the DOM names the country before the reveal, except
// the "Tap <name>" prompt, which is the question. Names for the map labels
// are only handed to `reveal`. Geometry for a round is loaded before its
// first question.
//
// The first answer to each country is saved immediately, so leaving mid-round
// keeps progress; that is also why Exit needs no confirmation. What gets saved
// follows the rules in js/practice-round.js; a visit lasts from mount to
// unmount, so it spans Keep going.

import { DIRECTION_NAME_TO_TAP } from '../cards.js';
import { META_URL, getGeometryUrl, loadJson } from '../data.js';
import { createMapView } from '../map-view.js';
import {
  answerCurrent,
  createRound,
  getCurrentCode,
  getFeedbackPlan,
  getProgress,
  getMissed,
  getScore,
  isReask,
  isRoundComplete,
  persistAnswer,
  planCard
} from '../practice-round.js';
import { guardQuestionArea, renderQuestion, renderTapPrompt } from '../question.js';
import { ROUND_SIZE, pickRound } from '../srs.js';
import { QUIZ_MODES, loadStates, localToday } from '../storage.js';
import { el } from '../ui.js';

const SUMMARY_MISSED_MAX = 10;

let controller = null;

/**
 * Render the practice view and start a round.
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
  const isScopeField = (value) => value === null || value === undefined || typeof value === 'string';
  if (typeof filter !== 'object' || filter === null || !isScopeField(filter.continent) || !isScopeField(filter.subregion)) {
    throw new TypeError('`params.filter` must be an object with `continent` and `subregion` as a string or `null`.');
  }
  if (!QUIZ_MODES.includes(mode)) {
    throw new RangeError(`\`params.mode\` must be one of ${QUIZ_MODES.join(', ')}.`);
  }
  controller = new AbortController();
  const { signal } = controller;
  // Built once: the card lookups below run for every question.
  const byCode = new Map(countries.map((country) => [country.code, country]));
  const names = Object.fromEntries(countries.map((country) => [country.code, country.name]));

  // At most one auto-advance is pending at a time.
  let advanceTimer = null;
  const clearAdvance = () => {
    clearTimeout(advanceTimer);
    advanceTimer = null;
  };
  signal.addEventListener('abort', clearAdvance);

  const exitButton = el('button', { type: 'button', class: 'button-quiet practice-exit' }, ['Exit']);
  exitButton.addEventListener('click', () => navigate('home'), { signal });
  const progress = el('p', { class: 'practice-progress' });
  const header = el('div', { class: 'practice-header' }, [exitButton, progress]);

  const feedback = el('p', { class: 'practice-feedback', 'aria-live': 'polite' });
  const mapBox = el('div', { class: 'practice-map' });
  const questionArea = el('div', { class: 'practice-question' });
  const nextButton = el('button', { type: 'button', class: 'button button-primary practice-next', hidden: true }, ['Next']);
  const actions = el('div', { class: 'view-actions practice-next-area' }, [nextButton]);

  let meta = null;
  const geometries = new Map();
  let round = null;
  let plan = null;
  let question = null;
  let isAnswered = false;
  let persistedCodes = new Set();
  // The stored card states: loaded when a round starts, then kept from each
  // save (`persistAnswer` loads fresh before it writes), so a question does
  // not parse storage again.
  let states = {};

  // Swallow clicks on the question just after it appears (and taps on the
  // map, via `isGuarded`), and a held Enter on Next repeating onto its first
  // option.
  const guard = guardQuestionArea(questionArea, { signal });

  const mapView = createMapView({
    onTap: (code) => handleTap(code),
    onAmbiguous: (pair) => openConfirm(pair)
  });
  mapBox.append(mapView.element);
  signal.addEventListener('abort', () => mapView.destroy());

  // ---- Confirm sheet for an ambiguous tap ----

  let sheet = null;
  function closeSheet({ keepMarkers = false } = {}) {
    if (sheet !== null) {
      const { dialog } = sheet;
      sheet = null;
      if (!keepMarkers) {
        mapView.clearCandidates();
      }
      if (dialog.open) {
        dialog.close();
      }
      dialog.remove();
    }
  }
  signal.addEventListener('abort', closeSheet);

  // An ambiguous tap: both candidates are outlined on the map and numbered
  // "1" and "2" (no names), and the sheet asks which was meant. The sheet
  // opens whether or not the target is one of the pair. A number counts as
  // tapping that country; Cancel clears the markers and leaves the card
  // unanswered.
  function openConfirm(pair) {
    if (isAnswered || sheet !== null || guard.isGuarded()) {
      return;
    }
    try {
      mapView.markCandidates(pair);
    } catch (error) {
      handleRoundError(error);
      return;
    }
    const choose = (code) => {
      closeSheet({ keepMarkers: true });
      handleAnswer(code === plan.code, code);
    };
    const optionButtons = pair.map((code, index) => {
      const button = el('button', { type: 'button', class: 'button', 'aria-label': `Country ${index + 1}` }, [String(index + 1)]);
      button.addEventListener('click', () => choose(code), { signal });
      return button;
    });
    const cancelButton = el('button', { type: 'button', class: 'button-quiet' }, ['Cancel']);
    cancelButton.addEventListener('click', () => closeSheet(), { signal });
    const dialog = el('dialog', { class: 'sheet practice-confirm', 'aria-label': 'Which did you mean?' }, [
      el('div', { class: 'sheet-body' }, [
        el('h2', { class: 'sheet-title' }, ['Which did you mean?']),
        el('div', { class: 'sheet-actions' }, [...optionButtons, cancelButton])
      ])
    ]);
    // Escape and the like close the dialog without a button: same as Cancel.
    dialog.addEventListener('close', () => {
      if (sheet !== null && sheet.dialog === dialog) {
        closeSheet();
      }
    }, { signal });
    sheet = { dialog };
    container.append(dialog);
    dialog.showModal();
  }

  // ---- Round ----

  function showSummary() {
    const score = getScore(round);
    const keepGoingButton = el('button', { type: 'button', class: 'button button-primary', 'data-action': 'keep-going' }, ['Keep going']);
    const doneButton = el('button', { type: 'button', class: 'button', 'data-action': 'done' }, ['Done']);
    keepGoingButton.addEventListener('click', () => startRound(), { signal });
    doneButton.addEventListener('click', () => navigate('home'), { signal });
    const missed = getMissed(round).map((code) => byCode.get(code)?.name).filter((name) => typeof name === 'string');
    // The round is over, so names are fine here. A short list: a long one would push the buttons away.
    const shown = missed.slice(0, SUMMARY_MISSED_MAX);
    const missedBlock = missed.length === 0
      ? []
      : [el('section', { class: 'practice-missed', 'aria-label': 'Missed this round' }, [
        el('h2', { class: 'practice-missed-title' }, [`Missed (${missed.length})`]),
        el('p', { class: 'practice-missed-list' }, [
          missed.length > shown.length ? `${shown.join(', ')} and ${missed.length - shown.length} more` : shown.join(', ')
        ])
      ])];
    container.replaceChildren(
      el('h1', { class: 'practice-summary-title' }, ['Round complete']),
      el('p', { class: 'practice-score-caption' }, ['Correct']),
      el('p', { class: 'practice-score' }, [`${score.correct} / ${score.total}`]),
      ...missedBlock,
      el('div', { class: 'view-actions practice-actions' }, [keepGoingButton, doneButton])
    );
    keepGoingButton.focus({ preventScroll: true });
  }

  function showQuestion() {
    if (isRoundComplete(round)) {
      showSummary();
      return;
    }
    closeSheet();
    const code = getCurrentCode(round);
    const state = states[code] ?? null;
    plan = planCard({ code, state, countries, meta, mode, rng: Math.random });
    const { position, total } = getProgress(round);
    progress.textContent = isReask(round) ? `${position} / ${total} · again` : `${position} / ${total}`;
    feedback.textContent = '';
    feedback.classList.remove('is-hit', 'is-miss');
    nextButton.hidden = true;
    isAnswered = false;

    const country = byCode.get(code);
    const isTap = plan.direction === DIRECTION_NAME_TO_TAP;
    mapView.render({
      geometry: geometries.get(country.continent),
      meta,
      frame: plan.frame,
      frameLevel: plan.frameLevel,
      target: isTap ? null : code,
      interactive: isTap
    });
    if (isTap) {
      question = renderTapPrompt(questionArea, { name: country.name, signal });
    } else {
      question = renderQuestion(questionArea, {
        code,
        mode: plan.answerMode,
        countries,
        neighbours: plan.neighbours,
        rng: Math.random,
        signal,
        onAnswer: (chosenCode) => handleAnswer(chosenCode === code, chosenCode)
      });
    }
    guard.arm();
    mapView.relayout();
    question.focus();
  }

  function handleTap(code) {
    if (isAnswered || sheet !== null || guard.isGuarded()) {
      return;
    }
    handleAnswer(code === plan.code, code);
  }

  function handleAnswer(correct, picked) {
    if (isAnswered) {
      return;
    }
    isAnswered = true;
    try {
      const result = answerCurrent(round, correct);
      round = result.round;
      if (result.isFirstAnswer) {
        const saved = persistAnswer({
          code: result.code,
          correct,
          today: localToday(),
          persistedCodes
        });
        persistedCodes = saved.persistedCodes;
        states = saved.states;
      }
      const outcome = getFeedbackPlan(correct);
      question.reveal();
      // Labels only on a miss: the map view decides from `correct`, and gets
      // the names only now.
      mapView.reveal({ target: plan.code, picked, correct, names });
      feedback.textContent = correct ? 'Correct' : 'Not quite';
      feedback.classList.add(correct ? 'is-hit' : 'is-miss');
      if (outcome.advance === 'auto') {
        advanceTimer = setTimeout(() => {
          advanceTimer = null;
          advance();
        }, outcome.advanceMs);
      } else {
        nextButton.hidden = false;
        // Focus Next. Moving focus off the typing input also closes the iOS
        // keyboard, so the revealed name and Next are in view.
        nextButton.focus({ preventScroll: true });
      }
    } catch (error) {
      handleRoundError(error);
    }
  }

  // Next question or the summary; anything it throws (a bad plan, a render
  // error) goes to the error screen instead of freezing the view.
  function advance() {
    try {
      showQuestion();
    } catch (error) {
      handleRoundError(error);
    }
  }

  nextButton.addEventListener('click', advance, { signal });

  // Replaces the view with a message and a way out. Used for every failure
  // in a round: loading, planning, rendering and answering.
  function handleRoundError(error) {
    // After the view is gone (aborted) an error is only noise, so check first.
    if (signal.aborted) {
      return;
    }
    console.error(error);
    clearAdvance();
    closeSheet();
    const back = el('button', { type: 'button', class: 'button' }, ['Back']);
    back.addEventListener('click', () => navigate('home'), { signal });
    container.replaceChildren(
      el('p', { class: 'status' }, ['Something went wrong with this round. Go back and try again.']),
      el('div', { class: 'view-actions' }, [back])
    );
  }

  // Starts (or restarts, for Keep going) a round. Never rejects: errors go
  // to `handleRoundError`.
  async function startRound() {
    try {
      clearAdvance();
      const today = localToday();
      states = loadStates(today);
      const codes = pickRound({
        states,
        countries,
        today,
        filter,
        rng: Math.random,
        n: ROUND_SIZE
      });
      round = createRound(codes);
      if (isRoundComplete(round)) {
        // Only possible if the filter has no entries at all.
        const doneButton = el('button', { type: 'button', class: 'button' }, ['Done']);
        doneButton.addEventListener('click', () => navigate('home'), { signal });
        container.replaceChildren(
          el('p', { class: 'status' }, ['No countries to practise here.']),
          el('div', { class: 'view-actions' }, [doneButton])
        );
        return;
      }
      container.replaceChildren(el('p', { class: 'status' }, ['Loading…']));
      meta ??= await loadJson(META_URL);
      const continents = new Set(codes.map((code) => byCode.get(code).continent));
      await Promise.all([...continents].filter((continent) => !geometries.has(continent)).map(async (continent) => {
        geometries.set(continent, await loadJson(getGeometryUrl(continent)));
      }));
      if (signal.aborted) {
        return;
      }
      container.replaceChildren(header, feedback, mapBox, questionArea, actions);
      showQuestion();
    } catch (error) {
      handleRoundError(error);
    }
  }

  startRound();
}

/**
 * Clean up the practice view: cancels a pending auto-advance, closes a
 * confirm sheet and removes the map's listeners.
 *
 * @returns {void}
 */
export function unmount() {
  controller?.abort();
  controller = null;
}
