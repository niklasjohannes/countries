// Small DOM helpers shared by every view.
//
// DOM safety (docs/CONVENTIONS.md): nodes are built with `createElement`,
// attributes and text nodes only. Nothing here parses HTML. `el` only builds
// allowlisted tags, refuses inline event handlers and `style` attributes (so
// the app stays CSP-ready) and only accepts relative URLs.

import { CONTINENTS, SUBREGIONS } from './srs.js';
import { isPlainObject } from './validate.js';

/** Label of the "no filter" choice. */
export const ALL_LABEL = 'All';

/** Human labels for `CONTINENTS`. */
export const CONTINENT_LABELS = Object.freeze({
  africa: 'Africa',
  asia: 'Asia',
  europe: 'Europe',
  'north-america': 'North America',
  'south-america': 'South America',
  oceania: 'Oceania'
});

/** Human labels for `SUBREGIONS`, as the UN M49 names them. */
export const SUBREGION_LABELS = Object.freeze({
  'northern-africa': 'Northern Africa',
  'western-africa': 'Western Africa',
  'middle-africa': 'Middle Africa',
  'eastern-africa': 'Eastern Africa',
  'southern-africa': 'Southern Africa',
  'northern-america': 'Northern America',
  'central-america': 'Central America',
  caribbean: 'Caribbean',
  'south-america': 'South America',
  'central-asia': 'Central Asia',
  'eastern-asia': 'Eastern Asia',
  'south-eastern-asia': 'South-eastern Asia',
  'southern-asia': 'Southern Asia',
  'western-asia': 'Western Asia',
  'northern-europe': 'Northern Europe',
  'western-europe': 'Western Europe',
  'eastern-europe': 'Eastern Europe',
  'southern-europe': 'Southern Europe',
  'australia-and-new-zealand': 'Australia and New Zealand',
  melanesia: 'Melanesia',
  micronesia: 'Micronesia',
  polynesia: 'Polynesia'
});

/** Human labels for the quiz modes (`QUIZ_MODES` in `js/storage.js`). */
export const MODE_LABELS = Object.freeze({
  mc: 'Multiple choice',
  typing: 'Typing'
});

// Tags the app builds. Never add script-capable ones (`script`, `style`,
// `iframe`, `object`, `embed`, `svg`, `a` with untrusted URLs).
const ALLOWED_TAGS = new Set([
  'button', 'dialog', 'div', 'em', 'fieldset', 'h1', 'h2', 'h3', 'img', 'input',
  'label', 'legend', 'li', 'ol', 'p', 'section', 'small', 'span', 'strong',
  'ul'
]);
const FORBIDDEN_ATTRIBUTES = new Set(['style', 'srcdoc', 'srcset']);
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction']);
const CHOICE_GROUP_VARIANTS = Object.freeze(['chips', 'segmented']);

// A URL is safe if it is a relative path or a fragment. Rejects any scheme,
// root-absolute and protocol-relative paths. Browsers ignore leading control
// characters and spaces and strip tabs/newlines anywhere, so those are
// removed before checking.
function isSafeUrl(value) {
  const cleaned = value.replace(/^[\u0000- ]+/, '').replace(/[\t\n\r]/g, '');
  if (cleaned.startsWith('#')) {
    return true;
  }
  return !/^[a-z][a-z0-9+.-]*:/i.test(cleaned) && !/^[/\\]/.test(cleaned);
}

/**
 * Build an element.
 *
 * Everything is validated before any node is created.
 *
 * @param {string} tag Tag name from the allowlist (`ALLOWED_TAGS`).
 * @param {Object<string, string | number | boolean | null | undefined>}
 *   [attrs={}] Attributes. `true` sets an empty (boolean) attribute;
 *   `false`, `null` and `undefined` skip it. `on*`, `style`, `srcdoc` and
 *   `srcset` are refused. `href`, `src`, `action` and `formaction` must be
 *   relative paths or `#fragment`s.
 * @param {Array<Node | string | number | null | undefined | false>}
 *   [children=[]] Child nodes. Strings and numbers become text nodes;
 *   `null`, `undefined` and `false` are skipped.
 * @returns {HTMLElement} The new element.
 */
export function el(tag, attrs = {}, children = []) {
  if (typeof tag !== 'string') {
    throw new TypeError('`tag` must be a string.');
  }
  if (!ALLOWED_TAGS.has(tag)) {
    throw new RangeError(`\`tag\` \`${tag}\` is not on the allowlist.`);
  }
  if (!isPlainObject(attrs)) {
    throw new TypeError('`attrs` must be an object.');
  }
  if (!Array.isArray(children)) {
    throw new TypeError('`children` must be an array.');
  }
  const attributes = [];
  for (const [name, value] of Object.entries(attrs)) {
    const lowerName = name.toLowerCase();
    if (lowerName.startsWith('on') || FORBIDDEN_ATTRIBUTES.has(lowerName)) {
      throw new RangeError(`\`attrs.${name}\` is not allowed: use \`addEventListener\` or a CSS class.`);
    }
    if (value === false || value === null || value === undefined) {
      continue;
    }
    const text = value === true ? '' : String(value);
    if (URL_ATTRIBUTES.has(lowerName) && !isSafeUrl(text)) {
      throw new RangeError(`\`attrs.${name}\` must be a relative path or a \`#fragment\`.`);
    }
    attributes.push([name, text]);
  }
  children.forEach((child, i) => {
    const isValid = child === null || child === undefined || child === false ||
      typeof child === 'string' || typeof child === 'number' ||
      (typeof Node !== 'undefined' && child instanceof Node);
    if (!isValid) {
      throw new TypeError(`\`children[${i}]\` must be a Node, string or number.`);
    }
  });

  const node = document.createElement(tag);
  for (const [name, text] of attributes) {
    node.setAttribute(name, text);
  }
  for (const child of children) {
    if (typeof child === 'string' || typeof child === 'number') {
      node.append(document.createTextNode(String(child)));
    } else if (child !== null && child !== undefined && child !== false) {
      node.append(child);
    }
  }
  return node;
}

/**
 * Human label of a sub-region slug.
 *
 * @param {string} subregion One of the keys of `SUBREGIONS`.
 * @returns {string} e.g. `'Australia and New Zealand'`.
 */
export function formatSubregion(subregion) {
  if (typeof subregion !== 'string' || !Object.hasOwn(SUBREGIONS, subregion)) {
    throw new RangeError('`subregion` must be a key of `SUBREGIONS`.');
  }
  return SUBREGION_LABELS[subregion];
}

/**
 * The sub-regions to offer as chips for a continent.
 *
 * A continent with a single sub-region (South America) offers none, since
 * the sub-region filter would equal the continent filter.
 *
 * @param {string} continent One of `CONTINENTS`.
 * @returns {string[]} Sub-region slugs, in `SUBREGIONS` order; empty if the
 *   continent has fewer than two.
 */
export function getSubregionChoices(continent) {
  if (!CONTINENTS.includes(continent)) {
    throw new RangeError(`\`continent\` must be one of ${CONTINENTS.join(', ')}.`);
  }
  const subregions = Object.keys(SUBREGIONS).filter((key) => SUBREGIONS[key] === continent);
  return subregions.length > 1 ? subregions : [];
}

/**
 * Build a single-choice group (native radio buttons styled as chips).
 *
 * @param {object} options
 * @param {string} options.name Radio group name; unique on the page.
 * @param {string} options.legend Visible group label.
 * @param {{ value: string, label: string }[]} options.choices Choices, in
 *   display order.
 * @param {string} options.selected Value of the initially checked choice.
 * @param {(value: string) => void} options.onChange Called with the newly
 *   checked value.
 * @param {AbortSignal} [options.signal] Removes the listener when aborted.
 * @param {string} [options.variant='chips'] `'chips'` (wrapping pills) or
 *   `'segmented'` (one row of equal-width segments).
 * @returns {HTMLFieldSetElement} The group.
 */
export function createChoiceGroup({ name, legend, choices, selected, onChange, signal, variant = 'chips' } = {}) {
  if (typeof name !== 'string' || name === '') {
    throw new TypeError('`name` must be a non-empty string.');
  }
  if (typeof legend !== 'string' || legend === '') {
    throw new TypeError('`legend` must be a non-empty string.');
  }
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new TypeError('`choices` must be a non-empty array.');
  }
  choices.forEach((choice, i) => {
    if (!isPlainObject(choice) || typeof choice.value !== 'string' || typeof choice.label !== 'string') {
      throw new TypeError(`\`choices[${i}]\` must be a \`{ value, label }\` object of strings.`);
    }
  });
  if (!choices.some((choice) => choice.value === selected)) {
    throw new RangeError('`selected` must be the value of one of `choices`.');
  }
  if (typeof onChange !== 'function') {
    throw new TypeError('`onChange` must be a function.');
  }
  if (!CHOICE_GROUP_VARIANTS.includes(variant)) {
    throw new RangeError(`\`variant\` must be one of ${CHOICE_GROUP_VARIANTS.join(', ')}.`);
  }
  const className = variant === 'segmented' ? 'choice-group choice-group-segmented' : 'choice-group';
  const group = el('fieldset', { class: className }, [
    el('legend', { class: 'choice-group-legend' }, [legend]),
    el('div', { class: 'choice-group-options' }, choices.map((choice) => el('label', { class: 'choice' }, [
      el('input', {
        class: 'choice-input',
        type: 'radio',
        name,
        value: choice.value,
        checked: choice.value === selected
      }),
      el('span', { class: 'choice-label' }, [choice.label])
    ])))
  ]);
  group.addEventListener('change', (event) => onChange(event.target.value), { signal });
  return group;
}
