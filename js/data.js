// Loading of the map data files for test mode (the practice view loads its
// own). Fetches only same-origin, relative URLs and parses them with
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

/**
 * Fetch and parse a JSON file.
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
