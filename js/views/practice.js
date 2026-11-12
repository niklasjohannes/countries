// Placeholder Practice view. The real one lands in issue 10; home already
// navigates here with `params` = `{ filter: { continent, subregion }, mode }`.

import { el } from '../ui.js';

let controller = null;

/**
 * Render the placeholder.
 *
 * @param {HTMLElement} container The view's section.
 * @param {{ navigate: Function }} context See `js/app.js`.
 * @returns {void}
 */
export function mount(container, context) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('`container` must be an `HTMLElement`.');
  }
  if (typeof context !== 'object' || context === null || typeof context.navigate !== 'function') {
    throw new TypeError('`context` must have a `navigate` function.');
  }
  controller = new AbortController();
  const back = el('button', { type: 'button', class: 'button', 'data-action': 'back' }, ['Back']);
  back.addEventListener('click', () => context.navigate('home'), { signal: controller.signal });
  container.replaceChildren(
    el('h1', {}, ['Practice']),
    el('p', { class: 'status' }, ['Coming in a later issue.']),
    el('div', { class: 'view-actions' }, [back])
  );
}

/**
 * Remove the view's listeners.
 *
 * @returns {void}
 */
export function unmount() {
  controller?.abort();
  controller = null;
}
