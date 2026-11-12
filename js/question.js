// The answer UI of one practice question. Adapted from the flags repo's
// `question.js`: the flag is gone (the map is drawn by `map-view.js`), and
// there is a second card type.
//
//   - `renderQuestion` (map → name), by mode:
//       'mc'     the options from `buildChoices` as buttons;
//       'typing' a text input with a live `filterSuggestions` list. The user
//                answers ONLY by tapping a suggestion row (PLAN decision 6):
//                there is no form, and Enter never submits.
//     The first answer calls `onAnswer(chosenCode)` exactly once and locks the
//     question. It shows no right/wrong feedback by itself: the caller calls
//     `reveal()`.
//   - `renderTapPrompt` (name → tap): the prompt "Tap <name>". The name is
//     the question itself, so it may be in the DOM; the answer is a tap on the
//     map, handled by the caller.
//
// No spoilers: option buttons carry names (they are the answers on offer) but
// no codes; the code -> button mapping lives in a JS `Map`. The correct name
// reaches the DOM only through `reveal()`.
//
// Typing mode and the iOS keyboard: rendering the next typing question into
// the same container keeps the same input element (cleared), and locking
// makes it `readonly`, never `disabled`. So an input that has focus keeps it
// from one question to the next, and the keyboard stays up even when the
// next question comes from a timer (where iOS ignores `focus()`). Tapping a
// suggestion does not move focus off the input either.

import { buildChoices, filterSuggestions } from './quiz.js';
import { QUIZ_MODES } from './storage.js';
import { el } from './ui.js';

/**
 * Time (ms) after a question appears during which clicks on it are ignored
 * (`guardQuestionArea`). The next question's options land where the last tap
 * was, so without it a double tap, or a double press of Enter on Next, would
 * answer a question the user never saw. The window is the same whatever the
 * previous answer was.
 */
export const ANSWER_GUARD_MS = 300;

/**
 * Protect the questions rendered into `area` from answers meant for what was
 * on screen before. Both listeners are in the capture phase, so they run
 * before the options' own:
 *   - a click (including an Enter / Space activation) within
 *     `ANSWER_GUARD_MS` of `arm()` is swallowed;
 *   - a key auto-repeat on a button is swallowed: a held Enter on Next
 *     repeats on the newly focused option, and only the first press may
 *     count. Typing into the input may still repeat.
 * `isGuarded()` says whether the window is open, for answers that do not go
 * through `area` (taps on the map).
 *
 * @param {HTMLElement} area The question's container.
 * @param {object} options
 * @param {AbortSignal} options.signal Removes the listeners when aborted.
 * @returns {{ arm: () => void, isGuarded: () => boolean }} Call `arm()` right
 *   after rendering each question.
 */
export function guardQuestionArea(area, { signal } = {}) {
  if (!(area instanceof HTMLElement)) {
    throw new TypeError('`area` must be an element.');
  }
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('`signal` must be an `AbortSignal`.');
  }
  let shownAt = -Infinity;
  const isGuarded = () => performance.now() - shownAt < ANSWER_GUARD_MS;
  const swallow = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  area.addEventListener('click', (event) => {
    if (isGuarded()) {
      swallow(event);
    }
  }, { capture: true, signal });
  area.addEventListener('keydown', (event) => {
    if (event.repeat && event.target instanceof HTMLButtonElement) {
      swallow(event);
    }
  }, { capture: true, signal });
  return Object.freeze({
    arm: () => {
      shownAt = performance.now();
    },
    isGuarded
  });
}

// What each container showed last: the question's controller and, in typing
// mode, the parts kept for the next question.
const previousByContainer = new WeakMap();

// End an IME composition still open in a typing question's input. Clearing
// `value` alone does not: the IME keeps its buffer and types it back on the
// next keystroke. A blur commits the composition; the input is focused again
// straight away. Only while composing, so the iOS keyboard is otherwise never
// touched.
function endComposition(typing) {
  if (!typing.isComposing) {
    return;
  }
  const { input } = typing;
  const hadFocus = document.activeElement === input;
  input.blur();
  typing.isComposing = false;
  if (hadFocus) {
    input.focus({ preventScroll: true });
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('`signal` must be an `AbortSignal`, or omitted.');
  }
}

// A controller that aborts with `signal`, and the one the container showed
// before (aborted here, so its handle goes inert).
function takeOver(container, signal) {
  previousByContainer.get(container)?.controller.abort();
  const controller = new AbortController();
  if (signal !== undefined) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', () => controller.abort(), { signal: controller.signal });
    }
  }
  return controller;
}

/**
 * Render a map → name question's answer UI into `container`.
 *
 * The caller must own `container` exclusively. A first render replaces its
 * contents. A typing question rendered after a typing question in the same
 * container reuses the previous question's elements in place (to keep the
 * input and its focus).
 *
 * @param {HTMLElement} container Where to render.
 * @param {object} options
 * @param {string} options.code The country asked about (the correct answer).
 * @param {string} options.mode One of `QUIZ_MODES` (`'mc'` or `'typing'`).
 * @param {object[]} options.countries The `countries` array of `data/countries.json`.
 * @param {string[]} [options.neighbours] The target's neighbour codes
 *   (`map-meta.json`), the first tier of MC distractors.
 * @param {() => number} options.rng Random source returning `[0, 1)`.
 * @param {(chosenCode: string) => void} options.onAnswer Called once, with
 *   the code the user picked.
 * @param {AbortSignal} [options.signal] Removes the question's listeners when
 *   aborted (pass the view's unmount signal).
 * @returns {{ reveal: () => void, focus: () => void, chosenCode: string | null }}
 *   Handle (frozen). `reveal()` marks the correct option (`.is-correct`), a
 *   wrong pick (`.is-wrong`) and the question itself (`.is-answered-correct`
 *   / `.is-answered-wrong`), shows the correct name in typing mode (dropping
 *   the unmarked suggestions) and locks the question. `focus()` focuses the
 *   first option or the text input. `chosenCode` is the answer so far (`null`
 *   before it). Once another question is rendered into `container`, the old
 *   handle does nothing.
 */
export function renderQuestion(container, options) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('`container` must be an element.');
  }
  if (!isPlainObject(options)) {
    throw new TypeError('`options` must be an object.');
  }
  const { code, mode, countries, neighbours = [], rng, onAnswer, signal } = options;
  if (!Array.isArray(countries)) {
    throw new TypeError('`countries` must be an array.');
  }
  const target = countries.find((country) => country.code === code);
  if (target === undefined) {
    throw new RangeError('`code` must be the code of one of `countries`.');
  }
  if (!QUIZ_MODES.includes(mode)) {
    throw new RangeError(`\`mode\` must be one of ${QUIZ_MODES.join(', ')}.`);
  }
  if (typeof rng !== 'function') {
    throw new TypeError('`rng` must be a function returning a number in [0, 1).');
  }
  if (typeof onAnswer !== 'function') {
    throw new TypeError('`onAnswer` must be a function.');
  }
  assertSignal(signal);

  const previousTyping = previousByContainer.get(container)?.typing ?? null;
  const controller = takeOver(container, signal);
  const ownSignal = controller.signal;

  const names = new Map(countries.map((country) => [country.code, country.name]));
  let chosenCode = null;
  let isLocked = false;

  // Option buttons currently on screen, keyed by code (JS-side only).
  const buttons = new Map();
  const createOption = (optionCode, className) => {
    const button = el('button', { type: 'button', class: className }, [names.get(optionCode)]);
    button.addEventListener('click', () => answer(optionCode), { signal: ownSignal });
    if (className === 'question-suggestion') {
      // Keep focus (and the iOS keyboard) in the input; `click` still fires.
      button.addEventListener('mousedown', (event) => event.preventDefault(), { signal: ownSignal });
    }
    buttons.set(optionCode, button);
    return button;
  };

  const reusable = mode === 'typing' && previousTyping !== null &&
    previousTyping.root.parentNode === container;

  let root;
  let typing = null;
  if (reusable) {
    typing = previousTyping;
    ({ root } = typing);
    root.classList.remove('is-answered-correct', 'is-answered-wrong');
    endComposition(typing);
    typing.input.value = '';
    typing.input.readOnly = false;
    typing.list.replaceChildren();
    typing.answerLine.textContent = '';
  } else {
    let body;
    if (mode === 'mc') {
      const choices = buildChoices({ code, countries, neighbours, rng });
      body = el('div', { class: 'question-options' }, choices.map(
        (choice) => createOption(choice, 'question-option')
      ));
    } else {
      const input = el('input', {
        class: 'question-input',
        type: 'text',
        'aria-label': 'Country name',
        placeholder: 'Type a country…',
        autocomplete: 'off',
        autocorrect: 'off',
        autocapitalize: 'none',
        spellcheck: 'false',
        enterkeyhint: 'done'
      });
      const list = el('ul', { class: 'question-suggestions', 'aria-label': 'Suggestions' });
      // Empty until `reveal()`; a live region, so the name is announced.
      const answerLine = el('p', { class: 'question-answer', 'aria-live': 'polite' });
      body = el('div', { class: 'question-typing' }, [input, list, answerLine]);
      typing = { input, list, answerLine, isComposing: false };
      // Tracked for the input's whole life (across questions).
      const state = typing;
      input.addEventListener('compositionstart', () => {
        state.isComposing = true;
      }, { signal });
      input.addEventListener('compositionend', () => {
        state.isComposing = false;
      }, { signal });
    }
    root = el('div', { class: 'question', 'data-mode': mode }, [body]);
    if (typing !== null) {
      typing = Object.assign(typing, { root });
    }
    container.replaceChildren(root);
  }
  previousByContainer.set(container, { controller, typing });

  const input = typing?.input ?? null;
  const answerLine = typing?.answerLine ?? null;
  if (typing !== null) {
    const { list } = typing;
    input.addEventListener('input', () => {
      if (isLocked) {
        return;
      }
      buttons.clear();
      list.replaceChildren(...filterSuggestions(input.value, countries).map(
        (suggestion) => el('li', {}, [createOption(suggestion.code, 'question-suggestion')])
      ));
    }, { signal: ownSignal });
    // No raw-text answers: Enter does nothing. Except while an IME is
    // composing, where Enter commits the composition; Safari reports that as
    // `keyCode` 229 rather than `isComposing`.
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
      }
    }, { signal: ownSignal });
  }

  function lock() {
    isLocked = true;
    for (const button of buttons.values()) {
      button.disabled = true;
    }
    // `readonly`, not `disabled`: a disabled input loses focus, and with it
    // the iOS keyboard.
    if (input !== null) {
      input.readOnly = true;
    }
  }

  function answer(optionCode) {
    if (isLocked || ownSignal.aborted) {
      return;
    }
    chosenCode = optionCode;
    // Locked first, so the `input` event of the committed text cannot rebuild
    // the suggestions. Inside the tap, so iOS allows the refocus.
    isLocked = true;
    if (typing !== null) {
      endComposition(typing);
    }
    lock();
    buttons.get(optionCode)?.classList.add('is-chosen');
    onAnswer(optionCode);
  }

  function markOption(optionCode, className, hiddenText) {
    const button = buttons.get(optionCode);
    if (button === undefined || button.classList.contains(className)) {
      return;
    }
    button.classList.add(className);
    button.append(el('span', { class: 'visually-hidden' }, [hiddenText]));
  }

  function reveal() {
    // A handle of a question that has been replaced does nothing.
    if (ownSignal.aborted) {
      return;
    }
    lock();
    root.classList.add(chosenCode === code ? 'is-answered-correct' : 'is-answered-wrong');
    // Classes for the look, hidden text for screen readers.
    markOption(code, 'is-correct', ' (correct answer)');
    if (chosenCode !== null && chosenCode !== code) {
      markOption(chosenCode, 'is-wrong', ' (your answer)');
    }
    if (typing !== null) {
      // Keep only the marked rows, so the correct name sits right under the
      // input instead of below a screenful of other suggestions.
      for (const [optionCode, button] of buttons) {
        if (optionCode !== code && optionCode !== chosenCode) {
          button.closest('li')?.remove();
        }
      }
      answerLine.textContent = target.name;
    }
  }

  function focus() {
    if (ownSignal.aborted) {
      return;
    }
    const first = input ?? buttons.values().next().value;
    first?.focus({ preventScroll: true });
  }

  return Object.freeze({
    reveal,
    focus,
    get chosenCode() {
      return chosenCode;
    }
  });
}

/**
 * Render a name → tap question's prompt, "Tap <name>", into `container`
 * (replacing its contents, and dropping any typing input kept for reuse).
 * The name is the question itself, so it is in the DOM from the start.
 *
 * @param {HTMLElement} container Where to render.
 * @param {object} options
 * @param {string} options.name The country's display name.
 * @param {AbortSignal} [options.signal] Makes the handle inert when aborted.
 * @returns {{ reveal: () => void, focus: () => void }} Handle (frozen).
 *   `reveal()` marks the prompt `.is-answered`; `focus()` focuses the prompt
 *   (`tabindex` -1), so focus does not fall to `<body>` when the previous
 *   question's controls are replaced (the answer itself is a tap on the map).
 */
export function renderTapPrompt(container, options) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('`container` must be an element.');
  }
  if (!isPlainObject(options)) {
    throw new TypeError('`options` must be an object.');
  }
  const { name, signal } = options;
  if (typeof name !== 'string' || name === '') {
    throw new TypeError('`name` must be a non-empty string.');
  }
  assertSignal(signal);

  const controller = takeOver(container, signal);
  previousByContainer.set(container, { controller, typing: null });
  const root = el('p', { class: 'question question-tap-prompt', 'data-mode': 'tap', tabindex: -1 }, [
    'Tap ',
    el('strong', { class: 'question-tap-name' }, [name])
  ]);
  container.replaceChildren(root);
  return Object.freeze({
    reveal: () => {
      if (!controller.signal.aborted) {
        root.classList.add('is-answered');
      }
    },
    focus: () => {
      if (!controller.signal.aborted) {
        root.focus({ preventScroll: true });
      }
    }
  });
}
