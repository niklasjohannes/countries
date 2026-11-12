# Country metadata

`data/countries.json` is generated, not hand-edited. This file explains where it comes from, the rules that decide what is in it, and how to rebuild it. The same rules are embedded in machine-readable form in `countries.json` → `meta.policy`, because JSON can't carry comments. The pattern is adapted from the sibling flags app's `docs/DATA.md`.

## Files

| Path | What it is | Edited by hand? |
|---|---|---|
| `scripts/country-overrides.js` | Names, aliases, sovereignty, parents, the M49 sub-region table, policy text, source pin | **Yes**, this is the only file to edit |
| `scripts/build-countries.js` | Zero-dependency generator (`--check` verifies the committed file) | Rarely |
| `data/countries.json` | Generated output, served to the app | No |

## Shape

```json
{
  "meta": { "source": {}, "continents": [], "subregions": {}, "policy": {}, "excluded": {} },
  "countries": [
    { "code": "pr", "name": "Puerto Rico", "aliases": [], "continent": "north-america",
      "subregion": "caribbean", "sovereign": false, "parentCode": "us", "quizzed": true }
  ]
}
```

`countries` is sorted by `code`. `code` and `parentCode` are lowercase ISO 3166-1 alpha-2, plus `xk` for Kosovo. The file has 246 entries: 206 quizzed and 40 context-only.

## Source: UN M49

- **Source**: United Nations Statistics Division, "Standard country or area codes for statistical use (M49)", overview table, English rows.
- **URL**: <https://unstats.un.org/unsd/methodology/m49/overview/>
- **Date accessed**: 2026-11-12
- **How it is used**: the 247 coded rows with a region were transcribed into `M49_SUBREGIONS` in `scripts/country-overrides.js`, grouped by sub-region so each group can be checked against the UN table by eye. The generator never touches the network; to refresh the table, re-read the source and edit that object by hand.
- **Sub-regions** are M49's intermediate regions where M49 has them (Western, Middle, Eastern and Southern Africa; Caribbean, Central America, South America), otherwise M49's sub-region. That gives 22: the closed list in `SPEC.md`.
- **Continents** are M49's regions, with Americas split into `north-america` (Northern America, Central America, Caribbean) and `south-america`.
- **Not in M49**: Taiwan (`tw`) and Kosovo (`xk`), placed by geography in `HAND_PLACED`: `eastern-asia` and `southern-europe`. Antarctica (`aq`) is in the M49 table with no region, so it has no continent and is excluded (see below).

Placements that surprise people (all from M49): Russia `eastern-europe`; Türkiye, Cyprus, Armenia, Azerbaijan and Georgia `western-asia`; Kazakhstan `central-asia`; Egypt `northern-africa`; Indonesia and Timor-Leste `south-eastern-asia`; Papua New Guinea `melanesia`; Panama `central-america`; Greenland `northern-america`.

## Scope: which entries are quizzed

PLAN decision 2. `quizzed` is true for **206** entries:

- the **193 UN member states**;
- **4 named extras**: Vatican City (`va`) and Palestine (`ps`), both UN observers, plus Kosovo (`xk`) and Taiwan (`tw`);
- **9 large territories**: Greenland (`gl`), Western Sahara (`eh`), French Guiana (`gf`), Puerto Rico (`pr`), New Caledonia (`nc`), Falkland Islands (`fk`), French Polynesia (`pf`), Svalbard (`sj`), Hong Kong (`hk`).

Every other entry has `quizzed: false`: it is drawn as unlabelled context land and never asked.

### Context-only territories: reconciled against Natural Earth

The context-only entries are **the remaining ISO 3166-1 territories that have an M49 region and that Natural Earth 1:50m draws**. Issue 5 reconciled the first cut (43 entries) against the vendored data:

- **Not drawn, so dropped** (`NOT_DRAWN` in `scripts/country-overrides.js`, listed in `meta.excluded`): Bouvet Island (`bv`), drawn at no scale; Gibraltar (`gi`) and the US Minor Outlying Islands (`um`), drawn only at 1:10m, which is reserved for quizzed entries. Their rows stay in `ENTRIES` and the M49 table, so the transcription stays complete.
- **Drawn inside another feature, so split out** (see "Geometry" below): French Guiana, Guadeloupe, Martinique, Réunion and Mayotte out of France; Svalbard and Jan Mayen out of Norway; Caribbean Netherlands out of the Netherlands; Christmas Island and the Cocos (Keeling) Islands out of Australia's "Indian Ocean Territories"; Tokelau out of New Zealand.
- **Kept**: the other uninhabited territories (`gs`, `hm`, `io`, `tf`) all have their own Natural Earth feature, so they are drawn as context.
- Antarctica (`aq`) is drawn by Natural Earth but stays excluded: it has no continent, so it has no geometry file.
- Natural Earth units with no ISO code are not entries. At 1:50m these are Northern Cyprus, Somaliland and Siachen Glacier, all merged by the border policy below. Akrotiri and Dhekelia are not separate at 1:50m; they are already part of Cyprus.

## Sovereignty and parents

- **`sovereign: true` if and only if** the entry is a UN member state (193) or a UN non-member observer state (`ps`, `va`): 195 entries. Everything else is `false`, including Kosovo and Taiwan. This is the flags app's rule, applied mechanically. It is a field about UN status, not a recognition judgement.
- **`parentCode`** is the single UN-member state that de facto administers a dependency or territory. Cook Islands and Niue are in free association with New Zealand, so their parent is `nz`. It is `null` for sovereign entries and for entries whose status is disputed with no single administering state (`tw`, `eh`, `xk`). A sovereignty claim by a third state doesn't change `parentCode`. The field records administration, not legitimacy.
- In the app, `parentCode` stops multiple-choice questions pairing a territory with its parent or siblings (PLAN decision 6).

## Naming

- `name` is the common English short name, no political qualifiers, diacritics kept (`Côte d'Ivoire`, `Türkiye`, `Curaçao`, `Åland Islands`).
- `aliases` are former, long-form or colloquial English names for typing-mode search only, with an ASCII spelling wherever `name` has diacritics. An alias is a search aid, not an endorsement. A bare name shared by two entries ("Korea", "Congo") is given to neither.
- Entries are copied from the flags app's table. New here: Kosovo (alias "Kosova"), French Guiana, Svalbard (aliases "Svalbard and Jan Mayen", "Jan Mayen"), and the context-only territories flags had dropped.

## Border policy table (PLAN decision 15)

**Rule: internationally recognised borders.** Where there is a clear UN position against the administering state (Crimea, occupied Ukraine, the Golan Heights, Western Sahara), the recognised state gets the land. Otherwise the administered line is used (Aksai Chin, Arunachal Pradesh, the Kashmir line of control, and the last eight rows). The first nine rows are the cases decision 15 names; the next eight were ruled on by the owner for PR 18; the last eight are the areas of Natural Earth's breakaway layer the table did not name, ruled on by the owner for PR 21. One case per row. "Entry" says which `countries.json` entry owns the land. **Issue 5 applies these rows when it builds the geometry.**

| Case | Treatment | Entry | Notes |
|---|---|---|---|
| Crimea | Part of Ukraine | `ua` | No separate entry. Sevastopol goes with it. |
| Northern Cyprus | Part of Cyprus | `cy` | No separate entry. The UN buffer zone is not a separate entry either. |
| Somaliland | Part of Somalia | `so` | No separate entry. |
| Abkhazia | Part of Georgia | `ge` | No separate entry. |
| South Ossetia | Part of Georgia | `ge` | No separate entry. |
| Transnistria | Part of Moldova | `md` | No separate entry. |
| Kashmir | Split along the line of control | `in` and `pk` | Indian-administered side drawn as part of India, Pakistani-administered side (including Gilgit-Baltistan) as part of Pakistan. Geometry is issue 5. Aksai Chin is a separate row below. |
| Western Sahara | Its own entry | `eh` | Quizzed. `sovereign: false`, `parentCode: null`: administration is divided between Morocco and the Sahrawi Republic, and no single UN member administers it. |
| Kosovo | Its own entry | `xk` | Quizzed (PLAN decision 2). `sovereign: false`, `parentCode: null`, `southern-europe`. Not in M49 or ISO 3166-1. |
| Aksai Chin and the Trans-Karakoram Tract | Part of China | `cn` | De facto line, the same principle as the Kashmir split. Claimed by India and Pakistan respectively. |
| Arunachal Pradesh | Part of India | `in` | India administers it; China claims it. |
| Occupied Ukraine beyond Crimea (Donetsk, Luhansk, Zaporizhzhia, Kherson) | Part of Ukraine | `ua` | Same treatment as Crimea. |
| Golan Heights | Part of Syria | `sy` | The UN position. Israel administers it. |
| Hala'ib Triangle | Part of Egypt | `eg` | North of the straight 22°N line used on most maps. |
| Bir Tawil | Part of Sudan | `sd` | South of the 22°N line. |
| Akrotiri and Dhekelia | Merged into Cyprus | `cy` | UK sovereign base areas, too small to draw separately. No ISO code, no separate entry. |
| Nagorno-Karabakh | Part of Azerbaijan | `az` | Internationally recognised as Azerbaijan. |
| Siachen Glacier | Part of India | `in` | Administered line. Natural Earth draws it as a separate feature with no ISO code. |
| Southern Kuril Islands | Part of Russia | `ru` | Administered line. Claimed by Japan. |
| Abyei | Part of Sudan | `sd` | Administered line, as Natural Earth draws it. Claimed by South Sudan. |
| Ilemi Triangle | Part of Kenya | `ke` | Administered line. Claimed by South Sudan. |
| Lawa and Courantyne headwaters | Administering side | `gf` and `gy` | Lawa Headwaters with French Guiana, Courantyne Headwaters with Guyana. Both claimed by Suriname. |
| Junagadh and Manavadar | Part of India | `in` | Administered line. Claimed by Pakistan. |
| Demchok, Tirpani, Bara Hotii and Samdu valleys | Part of India | `in` | Administered line. Claimed by China. |
| Sabah (North Borneo) | Part of Malaysia | `my` | Administered line. Claimed by the Philippines. |

### Other cases met while building the metadata

These are carried over from the flags app's policy, because the entries already exist there. They are flagged so a reviewer can see each one.

| Case | Treatment | Flag |
|---|---|---|
| Taiwan (`tw`) | Own quizzed entry (PLAN decision 2). `sovereign: false`, `parentCode: null`, `eastern-asia` (not in M49). Name "Taiwan", no aliases. | carried from flags |
| Palestine (`ps`) | UN observer: `sovereign: true`. Alias "State of Palestine". | carried from flags |
| Vatican City (`va`) | UN observer: `sovereign: true`. Aliases "Holy See", "Vatican". | carried from flags |
| Falkland Islands (`fk`) | `parentCode: gb` (administering state), claimed by Argentina. Aliases "Falklands", "Malvinas". | carried from flags |
| Gibraltar (`gi`) | `parentCode: gb`, claimed by Spain. Context-only. | carried from flags |
| Hong Kong (`hk`), Macau (`mo`) | `parentCode: cn`. | carried from flags |
| Cook Islands (`ck`), Niue (`nu`) | Free association: `parentCode: nz`. | carried from flags |
| British Indian Ocean Territory (`io`) | `parentCode: gb`, claimed by Mauritius. Context-only. See "Chagos" below. | new, owner-ruled |
| Svalbard (`sj`) | ISO "Svalbard and Jan Mayen"; named "Svalbard", `parentCode: no`. | new |
| Antarctica (`aq`) | Excluded: no M49 region, so no continent. Natural Earth draws it; the geometry pipeline skips it. | new |

### Chagos Archipelago (`io`)

The British Indian Ocean Territory stays context-only with `parentCode: gb`, the administering state. A 2025 UK–Mauritius treaty on the archipelago exists, but whether it is in force is unconfirmed, so nothing changes yet. Revisit if it takes effect.

## Rebuilding

To change names, aliases, parents, sub-regions or policy, edit `scripts/country-overrides.js`, then:

```bash
node scripts/build-countries.js
node --test
```

The regeneration test fails if `data/countries.json` isn't byte for byte what the generator produces, so a forgotten regeneration can't be committed. `node scripts/build-countries.js --check` does the same check from the command line. The generator refuses to write if a code has no sub-region, a `parentCode` doesn't resolve to a sovereign entry, a code is placed in two sub-regions, a quizzed territory is sovereign, or the quizzed total isn't 206.

# Geometry

`data/geometry/<continent>.json`, `data/geometry/world.json` and `data/geometry/neighbours.json` are generated by `scripts/build-geometry.js` from the vendored Natural Earth files. Like `countries.json`, they are never hand-edited: the rules live in `scripts/country-overrides.js` under "Geometry (issue 5)".

## Source: Natural Earth

- **Repository**: <https://github.com/nvkelso/natural-earth-vector>, tag **`v5.1.2`** (released 2022-05-13), commit `f1890d9f152c896d250a77557a5751a93d494776`.
- **Terms**: public domain. The upstream terms are vendored unmodified as `vendor/natural-earth/LICENSE.md`.
- **Files**, all vendored unmodified under `vendor/natural-earth/`:

| File | Upstream path | Bytes | SHA-256 |
|---|---|---|---|
| `ne_50m_admin_0_countries.geojson` | `geojson/ne_50m_admin_0_countries.geojson` | 3,083,490 | `3e458fc036ad0a66411f2c1e6cac49c5d7bfb81cb1123bc513b22511a2b7fdeb` |
| `ne_50m_admin_0_breakaway_disputed_areas.geojson` | `geojson/ne_50m_admin_0_breakaway_disputed_areas.geojson` | 147,141 | `e91f0f9518b24355ceec6668f4df874d6f39db7d0bc9ec22d9b14429bfb6be01` |
| `LICENSE.md` | `LICENSE.md` | 4,636 | `2631b5b39b6d1acc56de75235109b5af2dbb4b0ac5a127b6f06185977247fd4b` |

- **No 1:10m file is needed.** 1:10m is only for quizzed entries missing at 1:50m. The only quizzed entries without their own 1:50m feature are French Guiana and Svalbard, and they are not separate features at 1:10m either: both are polygon parts of France and Norway at both scales, so they are split out of the 1:50m features.
- **How it was fetched**: raw files at the pinned commit were downloaded into the gitignored `.vendor-tmp/`, hashed, and copied unchanged. They are read with `JSON.parse` only; nothing from them is executed. The generator checks each SHA-256 before it reads a file and refuses to run on a mismatch.
- **Privacy scanner**: the vendored files contain no email addresses or home paths, so `scripts/privacy-exceptions.json` needs no entry for them.

## Pipeline

1. **Features to entries.** Each 1:50m feature maps to the entry `ISO_A2_EH` names (not `ISO_A2`, which is `-99` for France, Norway and Kosovo). The three features with no ISO code map through `NE_FEATURE_CODES`: Northern Cyprus → `cy`, Somaliland → `so`, Siachen Glacier → `in`. Antarctica is skipped. Any other unmapped feature stops the build.
2. **Overseas parts.** `OVERSEAS_SPLITS` moves polygon parts whose bounding box lies inside a lon/lat box to a separate entry: `gf`, `gp`, `mq`, `re`, `yt` from France; `sj` (Svalbard with Bjørnøya, and Jan Mayen, since ISO `SJ` covers both) from Norway; `bq` (Bonaire, Saba, Sint Eustatius) from the Netherlands; `cx` and `cc` from Australia's "Indian Ocean Territories"; `tk` from New Zealand. A rule that matches no part stops the build.
3. **Border policy.** Every area in the breakaway/disputed layer has a row in `BREAKAWAY_RULINGS` naming the entry that owns it; an area with no row stops the build so it can be escalated. If the area is drawn inside a different entry, the generator moves it: the whole polygon part when the part *is* the area (Crimea, which 1:50m draws as part of Russia), otherwise a cut along the area's boundary, snapped to existing vertices so borders with third countries stay exact (the Golan Heights out of Israel; the Moroccan-administered part of Western Sahara out of Morocco). Everywhere else Natural Earth's default already matches the policy table, and the generator only checks that.
4. **Per file.** Longitudes are wrapped into the 360° around the file's projection centre, polygons Natural Earth cut at the antimeridian are stitched back together (Russia's Chukotka and Wrangel Island, Fiji's islands on the antimeridian), and edges shared by two parts of the same entry are dissolved (Ukraine with Crimea, Cyprus with Northern Cyprus, and so on).
5. **Projection.** Continents use a spherical Lambert azimuthal equal-area projection (R = 6371 km) on these centres; `world.json` uses Equal Earth centred on 0°. `world.json` keeps the antimeridian as its edge, so nothing is stitched there.

| File | Projection | Centre (lon, lat) | Grid | Visvalingam tolerance | Islands dropped below |
|---|---|---|---|---|---|
| `africa.json` | LAEA | 20, 2 | 100 m | 40 km² | 20 km² |
| `asia.json` | LAEA | 85, 30 | 100 m | 60 km² | 40 km² |
| `europe.json` | LAEA | 15, 54 | 100 m | 40 km² | 20 km² |
| `north-america.json` | LAEA | −95, 40 | 100 m | 60 km² | 40 km² |
| `south-america.json` | LAEA | −60, −20 | 100 m | 40 km² | 20 km² |
| `oceania.json` | LAEA | 170, −15 | 100 m | 20 km² | 5 km² |
| `world.json` | Equal Earth | 0, 0 | 1 km | 1,500 km² | 800 km² |

6. **Shared arcs.** Rings are cut into arcs at every point where the set of rings using an edge changes, so a border shared by two entries is one arc. Each arc is simplified once with Visvalingam–Whyatt; its tolerance is the file's, capped at 1% of the smallest ring using it, so microstates and small islands keep their shape. Arcs that cross after simplifying are re-simplified more gently, for up to 8 rounds (only a few atoll rings in `world.json` still touch themselves at the 1 km grid). Then they are quantised to the integer grid and the rings are rebuilt from them, so neighbours meet exactly: no gaps, no overlaps.
7. **Dropping islets.** An unshared ring is dropped when it is below the file's size threshold, unless it is the entry's largest ring or at least 1% of it. So island nations keep every island, while Canada's or Russia's islets go.

## Output

```json
{ "projection": { "name": "laea", "centre": [20, 2], "radiusKm": 6371, "origin": [x0, y1], "note": "…" },
  "scale": 10,
  "entries": { "<code>": { "rings": [[[x, y], …], …], "bbox": [x0, y0, x1, y1], "label": [x, y] } } }
```

- `scale` is integer units per km. With (X, Y) the projection in km, `x = round((X − origin[0]) · scale)` and `y = round((origin[1] − Y) · scale)`, so y grows downwards, as in SVG.
- Rings are closed (the first point is repeated as the last). An entry's outer rings and holes wind in opposite directions, so both `fill-rule` values draw holes (Lesotho in South Africa, Vatican City in Italy, San Marino in Italy).
- `label` is Natural Earth's `LABEL_X`/`LABEL_Y` of the entry's own feature, projected. Entries split out of another feature have no label of their own; they get a point inside their largest ring, and so does any entry whose label would fall outside it.
- Each continent file holds that continent's entries, context-only ones included. `world.json` holds all 246.

## Neighbours

`data/geometry/neighbours.json` lists, for every entry, its neighbours (sorted, symmetric), for issue 6 to carry into `data/map-meta.json`:

- **Land**: entries sharing an arc in the unsimplified world topology. Touching at a single point doesn't count.
- **Maritime**: an *island* is an entry with no land neighbour. It gets the nearest 3 entries whose land is within 1,500 km (great-circle distance between vertices). Then the relation is made symmetric, so a mainland entry can gain island neighbours.

## Rebuilding geometry

After changing a geometry rule in `scripts/country-overrides.js`, or `countries.json` itself:

```bash
node scripts/build-countries.js
node scripts/build-geometry.js
node --test
```

`node scripts/build-geometry.js --check` reports any stale file. `test/geometry.test.js` regenerates everything and compares byte for byte. It also checks coverage, the file contract, the size budget (continents ≤ 1 MB in total, `world.json` ≤ 250 KB), symmetric neighbours, shared borders without gaps or overlaps (sampled), and the spot checks: Crimea in Ukraine, Lesotho as a hole in South Africa, Kaliningrad in Russia, Alaska in north-america, and Fiji and Chukotka without an antimeridian seam.

To re-vendor Natural Earth, download the new tag's files into `.vendor-tmp/`, hash them, copy them unchanged into `vendor/natural-earth/`, and update `NATURAL_EARTH`, the table above and `THIRD_PARTY_NOTICES.md`.
