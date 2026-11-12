# Third-party notices

Each upstream input is recorded here with its source, licence, pinned release and SHA-256.

## Natural Earth

- **What**: admin-0 country boundaries at 1:50m, and the 1:50m breakaway/disputed areas layer, as GeoJSON.
- **Source**: <https://github.com/nvkelso/natural-earth-vector>, tag `v5.1.2`, commit `f1890d9f152c896d250a77557a5751a93d494776`.
- **Licence**: public domain ("All versions of Natural Earth raster + vector map data … are in the public domain"). The upstream terms are kept as `vendor/natural-earth/LICENSE.md`. Made with Natural Earth.
- **Stored**: unmodified, in `vendor/natural-earth/`. The projected, simplified files under `data/geometry/` are derived from them by `scripts/build-geometry.js` (see `docs/DATA.md` → "Geometry").

| File | SHA-256 |
|---|---|
| `vendor/natural-earth/ne_50m_admin_0_countries.geojson` | `3e458fc036ad0a66411f2c1e6cac49c5d7bfb81cb1123bc513b22511a2b7fdeb` |
| `vendor/natural-earth/ne_50m_admin_0_breakaway_disputed_areas.geojson` | `e91f0f9518b24355ceec6668f4df874d6f39db7d0bc9ec22d9b14429bfb6be01` |
| `vendor/natural-earth/LICENSE.md` | `2631b5b39b6d1acc56de75235109b5af2dbb4b0ac5a127b6f06185977247fd4b` |

No 1:10m file is vendored: every quizzed entry is drawn at 1:50m once overseas parts are split out (`docs/DATA.md` explains why).
