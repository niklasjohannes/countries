// Home screen: continent chips (All + 6), sub-region chips once a continent
// is chosen, the MC/typing mode toggle, the total quizzed count for the
// filter, Start and Test, and the quiet "Backup" link in the footer, which
// opens js/backup-sheet.js.

import { createBackupSheet } from '../backup-sheet.js';
import { CONTINENTS, countCards } from '../srs.js';
import { loadMode, saveMode } from '../storage.js';
import {
  ALL_LABEL,
  CONTINENT_LABELS,
  MODE_LABELS,
  createChoiceGroup,
  el,
  formatSubregion,
  getSubregionChoices
} from '../ui.js';

// Radio value of "All"; maps to `null` in the filter.
const ALL_VALUE = 'all';

const CONTINENT_CHOICES = Object.freeze([
  { value: ALL_VALUE, label: ALL_LABEL },
  ...CONTINENTS.map((continent) => ({ value: continent, label: CONTINENT_LABELS[continent] }))
]);

const MODE_CHOICES = Object.freeze(
  Object.entries(MODE_LABELS).map(([value, label]) => ({ value, label }))
);

// Module state lives for one page load: the filter survives a trip to
// practice and back, but every reload starts at "All" because it is never
// stored. The mode is persisted (`countries.mode.v1`) and loaded on first
// mount.
let selectedContinent = null;
let selectedSubregion = null;
let selectedMode = null;
let controller = null;

/**
 * Render the home screen.
 *
 * @param {HTMLElement} container The view's section.
 * @param {{ countries: object[], navigate: Function }} context See `js/app.js`.
 * @returns {void}
 */
export function mount(container, context) {
  controller = new AbortController();
  const { signal } = controller;
  const { countries, navigate } = context;

  selectedMode ??= loadMode();

  const countNumber = el('span', { class: 'country-count-number' });
  const countLabel = el('span', { class: 'country-count-label' });
  const updateCount = () => {
    const total = countCards({
      countries,
      filter: { continent: selectedContinent, subregion: selectedSubregion }
    });
    countNumber.textContent = String(total);
    countLabel.textContent = total === 1 ? 'country' : 'countries';
  };

  // The sub-region chips sit in their own slot and are rebuilt whenever the
  // continent changes; the slot is empty (and so takes no space) when there
  // is nothing to choose.
  const subregionSlot = el('div', { class: 'home-subregions' });
  const renderSubregions = () => {
    const subregions = selectedContinent === null ? [] : getSubregionChoices(selectedContinent);
    if (subregions.length === 0) {
      subregionSlot.replaceChildren();
      return;
    }
    subregionSlot.replaceChildren(createChoiceGroup({
      name: 'home-subregion',
      legend: 'Sub-region',
      choices: [
        { value: ALL_VALUE, label: `${ALL_LABEL} ${CONTINENT_LABELS[selectedContinent]}` },
        ...subregions.map((subregion) => ({ value: subregion, label: formatSubregion(subregion) }))
      ],
      selected: selectedSubregion ?? ALL_VALUE,
      signal,
      onChange: (value) => {
        selectedSubregion = value === ALL_VALUE ? null : value;
        updateCount();
      }
    }));
  };

  const continentGroup = createChoiceGroup({
    name: 'home-continent',
    legend: 'Continent',
    choices: CONTINENT_CHOICES,
    selected: selectedContinent ?? ALL_VALUE,
    signal,
    onChange: (value) => {
      selectedContinent = value === ALL_VALUE ? null : value;
      // A sub-region belongs to one continent, so a new continent clears it.
      selectedSubregion = null;
      renderSubregions();
      updateCount();
    }
  });

  const modeGroup = createChoiceGroup({
    name: 'home-mode',
    legend: 'Mode',
    choices: MODE_CHOICES,
    selected: selectedMode,
    variant: 'segmented',
    signal,
    onChange: (value) => {
      selectedMode = value;
      saveMode(selectedMode);
    }
  });

  const params = () => ({
    filter: { continent: selectedContinent, subregion: selectedSubregion },
    mode: selectedMode
  });
  const startButton = el('button', { type: 'button', class: 'button button-primary', 'data-action': 'start' }, ['Start']);
  const testButton = el('button', { type: 'button', class: 'button', 'data-action': 'test' }, ['Test']);
  startButton.addEventListener('click', () => navigate('practice', params()), { signal });
  testButton.addEventListener('click', () => navigate('test', params()), { signal });

  // A restore re-renders home. Progress does not change the count (it is the
  // total in scope), but the sheet's contract says to refresh.
  const backupSheet = createBackupSheet({
    knownCodes: countries.map((country) => country.code),
    onRestored: () => navigate('home'),
    signal
  });
  const backupButton = el('button', {
    type: 'button',
    class: 'button-quiet home-backup',
    'aria-haspopup': 'dialog',
    'data-action': 'backup'
  }, ['Backup']);
  backupButton.addEventListener('click', backupSheet.open, { signal });

  renderSubregions();
  updateCount();
  container.replaceChildren(
    el('h1', { class: 'home-title' }, ['Countries']),
    continentGroup,
    subregionSlot,
    modeGroup,
    el('p', { class: 'country-count', 'aria-live': 'polite' }, [countNumber, ' ', countLabel]),
    el('div', { class: 'view-actions home-actions' }, [startButton, testButton]),
    el('div', { class: 'home-footer' }, [backupButton]),
    backupSheet.dialog
  );
}

/**
 * Remove the home screen's listeners.
 *
 * @returns {void}
 */
export function unmount() {
  controller?.abort();
  controller = null;
}
