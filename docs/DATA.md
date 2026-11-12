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

`countries` is sorted by `code`. `code` and `parentCode` are lowercase ISO 3166-1 alpha-2, plus `xk` for Kosovo. The file has 249 entries: 206 quizzed and 43 context-only.

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

### Context-only territories are provisional

The 43 context-only entries are **all remaining ISO 3166-1 territories that have an M49 region**, as a first cut. **Issue 5 reconciles this list against what Natural Earth actually draws**, and the list, `meta.excluded` and this section change with it. Open points for that reconciliation:

- Natural Earth draws Antarctica; we have no continent for it (`meta.excluded.aq`).
- The uninhabited territories (`bv`, `gs`, `hm`, `io`, `tf`, `um`) are kept here only because they have an M49 region. Flags dropped them; whether they are drawn is for issue 5.
- Some Natural Earth units have no ISO code (Akrotiri and Dhekelia, for example) and are not entries.

## Sovereignty and parents

- **`sovereign: true` if and only if** the entry is a UN member state (193) or a UN non-member observer state (`ps`, `va`): 195 entries. Everything else is `false`, including Kosovo and Taiwan. This is the flags app's rule, applied mechanically. It is a field about UN status, not a recognition judgement.
- **`parentCode`** is the single UN-member state that de facto administers a dependency or territory. Cook Islands and Niue are in free association with New Zealand, so their parent is `nz`. It is `null` for sovereign entries and for entries whose status is disputed with no single administering state (`tw`, `eh`, `xk`). A sovereignty claim by a third state doesn't change `parentCode`. The field records administration, not legitimacy.
- In the app, `parentCode` stops multiple-choice questions pairing a territory with its parent or siblings (PLAN decision 6).

## Naming

- `name` is the common English short name, no political qualifiers, diacritics kept (`Côte d'Ivoire`, `Türkiye`, `Curaçao`, `Åland Islands`).
- `aliases` are former, long-form or colloquial English names for typing-mode search only, with an ASCII spelling wherever `name` has diacritics. An alias is a search aid, not an endorsement. A bare name shared by two entries ("Korea", "Congo") is given to neither.
- Entries are copied from the flags app's table. New here: Kosovo (alias "Kosova"), French Guiana, Svalbard (aliases "Svalbard and Jan Mayen", "Jan Mayen"), and the context-only territories flags had dropped.

## Border policy table (PLAN decision 15)

**Rule: internationally recognised borders.** The first nine rows are the cases decision 15 names; the next eight were ruled on by the owner for PR 18. One case per row. "Entry" says which `countries.json` entry owns the land. **Issue 5 applies these rows when it builds the geometry.**

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
| Antarctica (`aq`) | Excluded: no M49 region, so no continent. | new, provisional |

### Chagos Archipelago (`io`)

The British Indian Ocean Territory stays context-only with `parentCode: gb`, the administering state. A 2025 UK–Mauritius treaty on the archipelago exists, but whether it is in force is unconfirmed, so nothing changes yet. Revisit if it takes effect.

## Rebuilding

To change names, aliases, parents, sub-regions or policy, edit `scripts/country-overrides.js`, then:

```bash
node scripts/build-countries.js
node --test
```

The regeneration test fails if `data/countries.json` isn't byte for byte what the generator produces, so a forgotten regeneration can't be committed. `node scripts/build-countries.js --check` does the same check from the command line. The generator refuses to write if a code has no sub-region, a `parentCode` doesn't resolve to a sovereign entry, a code is placed in two sub-regions, a quizzed territory is sovereign, or the quizzed total isn't 206.
