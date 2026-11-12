// Hand-tuned frame overrides for `scripts/build-map-meta.js`.
//
// A frame is the padded bounding box of a continent's or sub-region's quizzed
// entries (docs/DATA.md -> "Map meta"). Where that box is the wrong crop, a
// row here changes it. Every row needs a one-line `reason`.
//
// `clip` maps an entry code to a lon/lat box `[west, south, east, north]` in
// degrees. For that frame only, the entry contributes the part of its bounding
// box that lies inside the projected box, instead of its whole bounding box.
// The entry itself is untouched: the renderer clips it at the frame edge.

/** Russia west of the Urals: the box stops at 60°E and covers every latitude. */
const RUSSIA_WEST_OF_URALS = [10, 40, 60, 85];
/** Mainland Spain and Portugal: no Canary Islands, Madeira or Azores. */
const SPAIN_MAINLAND = [-10, 35, 5, 45];
const PORTUGAL_MAINLAND = [-10, 36, -6, 43];

/** @type {Record<string, {reason: string, clip: Record<string, number[]>}>} */
export const FRAME_OVERRIDES = {
  europe: {
    reason: 'Russia is cropped at the Urals so the frame does not follow it to the Pacific; Spain and Portugal are cropped to the mainland so the Canary Islands, Madeira and the Azores do not stretch it south and west.',
    clip: { ru: RUSSIA_WEST_OF_URALS, es: SPAIN_MAINLAND, pt: PORTUGAL_MAINLAND }
  },
  'eastern-europe': {
    reason: 'Russia is cropped at the Urals so the frame does not follow it to the Pacific.',
    clip: { ru: RUSSIA_WEST_OF_URALS }
  },
  'southern-europe': {
    reason: 'Spain and Portugal are cropped to the mainland so the Canary Islands, Madeira and the Azores do not stretch the frame across the Atlantic.',
    clip: { es: SPAIN_MAINLAND, pt: PORTUGAL_MAINLAND }
  }
};
