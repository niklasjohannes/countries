// Loading of the map data files, shared by practice, test and results.
// Fetches only same-origin, relative URLs and parses them with
// `response.json()`; nothing is executed.

export const META_URL = './data/map-meta.json';

/**
 * URL of a geometry file.
 *
 * @param {string} key A continent slug or `'world'`.
 * @returns {string} A relative URL.
 */
export function getGeometryUrl(key) {
  if (typeof key !== 'string' || !/^[a-z-]+$/.test(key)) {
    throw new TypeError('`key` must be a lowercase slug such as `africa` or `world`.');
  }
  return `./data/geometry/${key}.json`;
}

const cache = new Map();

/**
 * Fetch and parse a JSON file once per page load: later calls for the same URL
 * (the test view, then the results view; Keep going in practice) reuse the
 * result. A failed fetch is not cached, so a retry fetches again.
 *
 * @param {string} url Relative URL.
 * @returns {Promise<object>} The parsed JSON. Callers must not mutate it.
 */
export function loadJson(url) {
  if (!cache.has(url)) {
    const promise = fetchJson(url).catch((error) => {
      cache.delete(url);
      throw error;
    });
    cache.set(url, promise);
  }
  return cache.get(url);
}

/**
 * Fetch and parse a JSON file, uncached.
 *
 * @param {string} url Relative URL.
 * @returns {Promise<object>} The parsed JSON.
 */
export async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Fetching ${url} failed with HTTP ${response.status}.`);
  }
  return response.json();
}
