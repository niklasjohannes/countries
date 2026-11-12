# Countries — design plan

> Design decisions agreed with the repo owner in the planning session on 2026-11-12 (research + `/grill-me` interview). [`SPEC.md`](SPEC.md) turns this into build issues and an orchestration charter; where the two differ, `SPEC.md` wins.

## Goal

A minimal app for learning country **outlines and locations**, so that when the owner sees an unlabelled political map they can name every country. A sibling of the [`flags`](https://github.com/niklasjohannes/flags) PWA: same stack, same look, same learning loop, adapted to maps.

The owner already knows the large and famous countries. The weak spots are clusters: the Balkans, Central Asia, West and Central Africa, the Caribbean and the Pacific. The app has to make drilling one cluster cheap, without letting other regions go stale.

## Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Platform | Separate zero-dependency PWA in this repo. Same stack as flags: plain ES modules, no build step, `node --test`, GitHub Pages at `/countries/`. iPhone-first. Flags modules (`srs`, `storage`, `backup`, `quiz` suggestions, `sw` build, dev server) are **copied and adapted**, not shared, so neither app can break the other. Progress is separate from flags. |
| 2 | Deck | **206 quizzed entries**: 193 UN members + Vatican City, Palestine, Kosovo, Taiwan (197), plus 9 large territories: Greenland, Western Sahara, French Guiana, Puerto Rico, New Caledonia, Falkland Islands, French Polynesia, Svalbard, Hong Kong. Other territories (Guadeloupe, Bermuda, …) are drawn as unlabelled context land and never asked. |
| 3 | Device | iPhone-first. Desktop works but isn't optimised. |
| 4 | Look | Same visual family as flags: Courier Prime, black/white/grey, square corners, hard shadows, one muted accent. Map: light-grey land, thin dark borders, white sea, target filled in the accent. No per-country colours. |
| 5 | Card types | One SRS state per country, two card directions. **Map→name** (primary, about 75%): a country highlighted on an unlabelled map, which you name. **Name→tap** (secondary, about 25%): "Tap Moldova" on the map. No shape-only cards. |
| 6 | Answer mode (map→name) | **Multiple-choice / typing toggle, as in flags.** Typing is flags' type-to-autosuggest picker: you type, then tap a row, and spelling is never graded. MC distractors are neighbours first, then the same sub-region, then the same continent, and never a territory's parent or siblings. |
| 7 | New items | As in flags: every entry in the filtered scope is in play, new ones appear blind (with at most `NEW_CARD_LIMIT` = 3 per round, flags' constant). **No daily caps, no placement pass.** |
| 8 | Regions | Two-level filter: continent (flags' six), then an optional **sub-region** (UN M49 intermediate regions, a fixed list). |
| 9 | Filter memory | Resets to "All" on every open, as in flags. |
| 10 | Map framing | **Progressive.** Young cards are framed on their sub-region. Mature cards (`intervalDays ≥ 21`) are framed on their whole continent. Small countries always get a circle marker plus an inset zoom box. |
| 11 | Name→tap | Fixed sub-region frame, no pinch or pan. A tap counts as the nearest country within a tolerance of about 7 mm. An ambiguous tap between two countries asks you to confirm which you meant. Small countries are never name→tap cards. |
| 12 | Reveal | Hybrid timing, as in flags. A hit advances quickly with no labels. A miss waits for "Next": the target stays highlighted, the wrong pick is outlined, and the neighbours plus the target are labelled. |
| 13 | Test mode | As in flags (blind, untimed, no per-question feedback, **never writes SRS state**), scoped by the same two-level filter. It asks map→name only, always on the continent frame. The results screen shows score + missed list + **one map with the missed countries shaded**. |
| 14 | Scheduler | Copy flags' SM-2 engine (weighted due-pick, lapse re-queue within a session), generalised to the two-level filter. No FSRS. |
| 15 | Borders | **Internationally recognised.** Crimea → Ukraine, Northern Cyprus → Cyprus, Somaliland → Somalia, Abkhazia and South Ossetia → Georgia, Transnistria → Moldova. Kashmir is split along the line of control. Western Sahara is its own entry. Kosovo is its own entry (decision 2). Every case is in one policy table in `docs/DATA.md`. |
| 16 | Privacy | Commits use the GitHub noreply email (name "Niklas Johannes" is fine). Blocked from every commit, file, issue and PR body: the owner's work email, the employer's name, absolute home paths, credentials, local session state. Enforced mechanically by git hooks and CI (see SPEC.md → Privacy guard). |
| 17 | Build | An Opus orchestrator files one GitHub issue per step and gives each to a session whose model fits the issue (Haiku, Sonnet or Opus). Each PR is reviewed by a subagent one tier above the implementer, with targeted security reviews and one final full review. There are three owner checkpoints: the map contact sheet, the design screenshots and go-live. |

## Why: the learning science behind the decisions

Evidence grading: **[strong]** means meta-analyses or many replications, **[moderate]** means a few studies or an extrapolation, **[folklore]** means practitioner reports.

- **Retrieval with feedback is the engine** [strong]. Testing beats restudy (g ≈ 0.50), and testing with feedback does better still (g ≈ 0.73) (Rowland 2014, <https://pubmed.ncbi.nlm.nih.gov/25150680/>). Map-specific testing studies show the same benefit, and it is no smaller on transfer tests (Rohrer, Taylor & Sholar 2010, <https://digitalcommons.usf.edu/psy_facpub/1761>) [moderate]. → *Every interaction is a question. There is no study-only screen.*
- **Practise the target direction** [moderate]. Testing A→B helps B→A only partly (Carpenter, Pashler & Vul 2006). → *Map→name is the primary card because it is the target task. Name→tap is a lower-weight secondary card.*
- **Guess first, then see the answer** [moderate–strong]. A failed retrieval attempt followed by the answer beats simply studying it (Kornell, Hays & Bjork 2009, <https://pubmed.ncbi.nlm.nih.gov/19586265/>). → *New items appear blind, with an immediate spatial reveal.*
- **Interleave lookalikes** [strong for category learning, moderate here]. Interleaving helps more the more similar the items are (Brunmair & Richter 2019, <https://pubmed.ncbi.nlm.nih.gov/31556629/>). Learners wrongly prefer blocking (Bjork). → *Distractors are neighbours first. The "All" scope mixes regions. Sub-region filters exist for focused drilling, but the filter resets to "All".*
- **Spaced sessions build mastery** [strong]. Successive relearning, one correct recall in each of 3 or more spaced sessions, gave 68% retention at one week, against 26% for three correct recalls in one session (Rawson et al. 2018). → *SM-2 intervals spread reviews across days. Maturity (interval ≥ 21 days) widens the frame.*
- **Spatial memory is hierarchical and anchored** [strong]. People encode location by region and against neighbours (Stevens & Coupe 1978; Tversky 1992). → *Sub-region framing while learning. Neighbour labels on every miss. MC distractors drawn from neighbours.*
- **What practitioners report** [folklore]. Anki's *Ultimate Geography* deck uses "highlighted country → name" map cards and a zoom box for small islands (<https://github.com/anki-geo/ultimate-geography>). One learner said flashcards "hit a brick wall" until they checked a zoomed-out map with the neighbours after each miss (<https://emnudge.dev/notes/learning-geography>). Seterra's process of elimination lets you finish a quiz without recalling anything (<https://www.producthunt.com/products/seterra-geography/reviews>). → *No elimination quizzes. Neighbour context on reveal. Zoom box for small countries.*
- **Tap targets** [strong, HCI]. About 9 mm for one-handed thumb use (Parhi et al. 2006); Nielsen Norman Group recommends at least 1 cm (<https://www.nngroup.com/articles/touch-target-size/>). Microstates and much of the Caribbean are far smaller at sub-region zoom. → *Forgiving nearest-country taps; small countries are never tap cards.*
- **SM-2 vs FSRS** [moderate]. FSRS predicts recall better on large benchmarks (<https://expertium.github.io/Benchmark.html>), but for about 200 cards the absolute saving is small. → *Reuse flags' tested SM-2.*

## Screens & flows

- **Home**:
  - Continent chips (All + 6). Picking a continent reveals its sub-region chips; South America has none, since it is a single sub-region.
  - Mode toggle (MC / typing).
  - Total entry count for the current filter, as in flags #39.
  - **Start** (practice) and **Test**.
  - Backup footer, as in flags.
  - The filter resets to "All" on every open.
- **Practice**: rounds of 10 drawn by the SRS scheduler within the filter.
  - Each pick is map→name, or name→tap with probability `TAP_CARD_SHARE` = 0.25 when the entry is tappable (not small).
  - Map→name uses the active MC/typing mode.
  - The frame is the sub-region, or the continent once the card is mature.
  - Feedback and reveal follow decision 12. A miss re-queues the card within the round.
  - The round summary offers "Keep going" / "Done".
- **Test**: scope = the current filter. Every entry in scope is asked once, map→name on its continent frame, blind, with only a position counter.
  - Results: score, missed list, and a results map with the missed entries shaded. The map uses the continent frame for continent and sub-region scopes, and the world map for "All".
  - Test mode never calls the SRS write path.

## Architecture

```
countries/
├── index.html, manifest.webmanifest, sw.js (generated)
├── css/
├── js/
│   ├── app.js            # view routing
│   ├── srs.js            # copied from flags; filter generalised to {continent, subregion}
│   ├── quiz.js           # copied from flags; distractors = neighbours → sub-region → continent, parent/sibling exclusion
│   ├── cards.js          # pure: card direction pick, frame choice (sub-region vs continent by maturity)
│   ├── map.js            # pure: rings → path data, hit-testing with tolerance + ambiguity, inset box maths
│   ├── map-view.js       # DOM: SVG via createElementNS; highlight, outline, markers, inset, labels
│   ├── storage.js, backup.js   # copied from flags, keys renamed
│   └── views/            # home, practice, test, results
├── data/
│   ├── countries.json    # metadata (generated)
│   └── geometry/<continent>.json, world.json   # projected, simplified, quantised (generated)
├── scripts/              # dev-only, zero-dependency generators, privacy scanner, dev server
├── vendor/natural-earth/ # pinned upstream GeoJSON + terms, unmodified
└── test/
```

Map data comes from **Natural Earth** (public domain, 1:50m admin-0, with 1:10m as a fallback for any quizzed entry missing at 50m). It is vendored at a pinned release with a recorded SHA-256, exactly as flags vendors flag-icons, and treated as untrusted data (parsed with `JSON.parse` only, never executed).

A zero-dependency Node script does all of the following:

- Applies the border policy.
- Projects each continent with a Lambert azimuthal equal-area projection centred on the continent, handling the antimeridian for Oceania and Russia. The world results map uses Equal Earth.
- Simplifies topology-aware: it extracts the shared arcs and simplifies each arc once, so neighbours never gap or overlap.
- Quantises the coordinates.
- Derives the neighbour graph from the shared arcs, with nearest-neighbour fallbacks for islands.
