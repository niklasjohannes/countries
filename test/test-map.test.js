import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SMALL_SIDE_PX,
  WORLD_KEY,
  WORLD_MAP_WIDTH_PX,
  deriveWorldMeta,
  getEntriesFrame,
  getResultsGeometryKey,
  getScopeContinent
} from '../js/test-map.js';
import { FRAME_LEVEL_CONTINENT, planScene } from '../js/map-view.js';
import { getScopeCodes } from '../js/test-pass.js';

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const countries = read('data/countries.json').countries;
const meta = read('data/map-meta.json');
const world = read('data/geometry/world.json');

describe('getScopeContinent / getResultsGeometryKey', () => {
  it('uses the continent for a continent or sub-region scope and the world for All', () => {
    assert.equal(getResultsGeometryKey({ continent: null, subregion: null }), WORLD_KEY);
    assert.equal(getResultsGeometryKey({ continent: 'africa', subregion: null }), 'africa');
    assert.equal(getResultsGeometryKey({ continent: null, subregion: 'caribbean' }), 'north-america');
    assert.equal(getResultsGeometryKey({ continent: 'oceania', subregion: 'polynesia' }), 'oceania');
  });

  it('validates the filter', () => {
    assert.throws(() => getScopeContinent(null), /`filter`/);
    assert.throws(() => getScopeContinent({ continent: 'mars' }), /`filter.continent`/);
    assert.throws(() => getScopeContinent({ subregion: 'mars' }), /`filter.subregion`/);
    assert.throws(() => getScopeContinent({ continent: 'asia', subregion: 'caribbean' }), /belong/);
  });
});

describe('getEntriesFrame', () => {
  it('is the box around every entry of the world file', () => {
    const [x0, y0, x1, y1] = getEntriesFrame(world);
    assert.ok(x1 > x0 && y1 > y0);
    for (const { bbox } of Object.values(world.entries)) {
      assert.ok(bbox[0] >= x0 && bbox[1] >= y0 && bbox[2] <= x1 && bbox[3] <= y1);
    }
  });

  it('rejects bad input', () => {
    assert.throws(() => getEntriesFrame({}), /`geometry`/);
    assert.throws(() => getEntriesFrame({ entries: {} }), /not be empty/);
  });
});

describe('deriveWorldMeta', () => {
  const frame = getEntriesFrame(world);
  const worldMeta = deriveWorldMeta(world, frame);

  it('has an entry for every drawn entry, none tappable, no neighbours', () => {
    assert.deepEqual(Object.keys(worldMeta.entries).sort(), Object.keys(world.entries).sort());
    assert.ok(Object.values(worldMeta.entries).every((e) => e.tappable === false && e.neighbours.length === 0));
  });

  it('marks microstates small and big countries not', () => {
    assert.equal(worldMeta.entries.va.smallInContinent, true);
    assert.equal(worldMeta.entries.ru.smallInContinent, false);
    const pxPerUnit = WORLD_MAP_WIDTH_PX / (frame[2] - frame[0]);
    const [x0, y0, x1, y1] = world.entries.va.bbox;
    assert.ok((x1 - x0) * pxPerUnit < SMALL_SIDE_PX && (y1 - y0) * pxPerUnit < SMALL_SIDE_PX);
  });

  it('plans a scene that draws every entry at the continent level', () => {
    const scene = planScene({ geometry: world, meta: worldMeta, frame, frameLevel: FRAME_LEVEL_CONTINENT });
    assert.equal(scene.land.length, Object.keys(world.entries).length);
  });
});

describe('every quizzed entry is drawn on its own continent frame', () => {
  const geometries = new Map();
  it('has the frame and a drawable entry for each quizzed country', () => {
    for (const code of getScopeCodes({ countries, filter: { continent: null, subregion: null } })) {
      const { continent } = countries.find((country) => country.code === code);
      if (!geometries.has(continent)) {
        geometries.set(continent, read(`data/geometry/${continent}.json`));
      }
      const frame = meta.frames[continent];
      assert.ok(Array.isArray(frame), `no frame for ${continent}`);
      const scene = planScene({ geometry: geometries.get(continent), meta, frame, frameLevel: FRAME_LEVEL_CONTINENT });
      assert.ok(scene.land.some((item) => item.code === code), `${code} not drawn on the ${continent} frame`);
    }
  });
});
