# Countries PWA — build spec and orchestration charter

The design and its rationale are in [`PLAN.md`](PLAN.md); where the two differ, this file wins. This file breaks the plan into GitHub issues, each sized so a fresh session can pick it up with no other context, and says how one orchestrator session runs the whole build.

**Every session reads only what its issue points to**: the sections of this file marked *shared*, its own issue section, and `docs/CONVENTIONS.md` once issue 1 has created it. It does not read `PLAN.md` or the sibling flags repo unless its issue says so. That rule keeps each session's context, and its cost, small.

The sibling repo is at `../flags` relative to this checkout, and on GitHub at `niklasjohannes/flags`. Issues that copy from it name the exact files to copy. It is **read-only**: no session writes to it, runs git in it, or calls `gh` against it.

---

## Lessons from the flags build (shared)

1. **Personal email leaked into history.** The first 23 commits used the global git identity. Fixing it took a history rewrite, a force-push, and a GitHub Support request to purge PR refs. → Here the noreply identity is set **before the first commit**, and the privacy guard (issue 2) lands before any feature work.
2. **Leftover worktrees held the leaked history.** If any of them had been pushed, the leaked commits would have gone back to GitHub. → The orchestrator removes each issue's worktree and local branch right after its PR merges.
3. **Issue numbers drifted by one from spec numbers** and needed a mapping. → All issues are created up front, in order, before any PR exists, so GitHub numbers equal spec numbers. If they don't, the orchestrator records the offset in issue 1's body and uses GitHub numbers everywhere.
4. **The look was reworked after launch** (pixel font, then Courier Prime). → Start from flags' final look (Courier Prime, its tokens, its pixel ✓/✕ marks) in issue 11, rather than designing from scratch.
5. **The pre-deploy reviews produced a batch of fixes.** → This is planned for: issue 13 reviews the whole repo, and its findings land as a single fix-up PR.
6. **The orchestrator ran ~1,300 messages at high effort.** → It runs at medium effort and never reads full diffs itself. Reviews are delegated to subagents, and fix requests go to the session that already has the context.
7. **The preview launcher can't read checkouts under `~/Documents`** without the macOS folder permission. → Copy flags' `dev_server.py` (it resolves the repo root from its own path) and its README note. If the preview fails, sessions start the server from a shell instead.

---

## Privacy guard (shared, hard requirement)

**Nothing personal reaches GitHub**: not in a commit, a file, a commit message, an issue, a PR body, a PR comment or a review comment.

"Personal" means:

- the owner's work email address and its domain;
- the employer's name;
- absolute home paths (`/Users/<name>/`, `/home/<name>/`, `C:\Users\<name>\`);
- credentials (`gh` tokens, `ghp_…`, `github_pat_…`, `sk-ant-…`, `AKIA…`, `.netrc` content);
- local Claude state (`.claude/settings.local.json`, `.claude/worktrees/`, transcripts, `.tmp/`, local session links).

**Allowed**: the author name "Niklas Johannes", the GitHub handle `niklasjohannes`, and these emails:

- `34960897+niklasjohannes@users.noreply.github.com`
- `noreply@github.com`
- `noreply@anthropic.com` (in `Co-Authored-By` trailers)
- `git@github.com` (SSH remote URLs)
- `*@example.com` / `*@example.org` (only in the scanner's own test fixtures)

### Layers

1. **Identity before the first commit** (orchestrator bootstrap, below): repo-local `user.name` and `user.email` set to the allowed values. Linked worktrees share this config.
2. **Scanner** (`scripts/check-privacy.js`, issue 2): zero-dependency Node. It reads files, a diff, or stdin, and exits non-zero with `file:line` and the *category* of the match. It never echoes the matched text, so the scanner itself can't leak.
   - **Committed patterns** are generic: any email not on the allowlist, home paths, credential shapes.
   - **Private patterns** live in `.git/info/private-patterns`, which is inside `.git/` and therefore never committed. They hold the work email and the employer name. The orchestrator writes this file at bootstrap from `git config --global user.email` and the email's domain, **without ever printing them**. CI doesn't have this file, but the generic any-email rule already catches the work address there.
3. **Git hooks**, committed under `.githooks/` and activated with `git config core.hooksPath .githooks`:
   - `pre-commit` scans the staged content.
   - `commit-msg` scans the message.
   - `pre-push` checks every pushed commit: its author and committer emails must be on the allowlist, and its diff must scan clean.
4. **CI job** (`privacy`, issue 2):
   - On every PR, it checks author and committer emails across `base..head`, then scans that diff and the whole tree.
   - On every push to `main`, it runs the same checks over `before..after`. This catches a squash merge that GitHub authored with a non-noreply email.
5. **Text the orchestrator publishes**: before every `gh issue create`, `gh pr create`, `gh pr comment` and `gh pr review`, the body is written to `.tmp/` and piped through `node scripts/check-privacy.js --stdin`. Text from a subagent or session is scanned the same way before it is posted.
6. **The owner's GitHub account settings**. The owner confirms these once, at pre-flight; Claude can't read or change them. At <https://github.com/settings/emails>, both "Keep my email addresses private" and "Block command line pushes that expose my email" are on.

If any layer fails on `main`, that is an **escalation**. Don't rewrite history without the owner's go-ahead.

---

## Data contracts (shared)

These are defined up front so that issues 3, 4, 5 and 7 can run in parallel against fixtures.

### `data/countries.json` (issue 3)

```json
{
  "meta": { "source": {}, "continents": ["africa","asia","europe","north-america","south-america","oceania"],
            "subregions": { "western-africa": "africa", "…": "…" }, "policy": {}, "excluded": {} },
  "countries": [
    { "code": "pr", "name": "Puerto Rico", "aliases": [], "continent": "north-america",
      "subregion": "caribbean", "sovereign": false, "parentCode": "us", "quizzed": true }
  ]
}
```

- `code`: lowercase ISO 3166-1 alpha-2, plus `xk` for Kosovo.
- `quizzed: false` marks context-only land: it is drawn but never asked.
- `countries` is sorted by `code`.

**Sub-regions** are the UN M49 intermediate regions, a closed list of 22:

| Continent | Sub-regions |
|---|---|
| Africa | `northern-africa`, `western-africa`, `middle-africa`, `eastern-africa`, `southern-africa` |
| North America | `northern-america`, `central-america`, `caribbean` |
| South America | `south-america` |
| Asia | `central-asia`, `eastern-asia`, `south-eastern-asia`, `southern-asia`, `western-asia` |
| Europe | `northern-europe`, `western-europe`, `eastern-europe`, `southern-europe` |
| Oceania | `australia-and-new-zealand`, `melanesia`, `micronesia`, `polynesia` |

Taiwan and Kosovo aren't in M49, so they are placed by geography (`eastern-asia`, `southern-europe`), and that placement is documented.

### Geometry (issues 4 and 5)

- `data/geometry/<continent>.json` and `data/geometry/world.json`:

  ```json
  { "projection": {}, "scale": 1, "entries": { "<code>": { "rings": [[[x, y], …], …], "bbox": [x0, y0, x1, y1], "label": [x, y] } } }
  ```

  - Coordinates are integers in a fixed coordinate space for each file.
  - Rings are closed and come from shared-arc simplification.
  - `label` is Natural Earth's `LABEL_X`/`LABEL_Y`, projected.
- `data/map-meta.json`:

  ```json
  { "frames": { "<continent|subregion>": [x0, y0, x1, y1] },
    "entries": { "<code>": { "neighbours": ["…"], "small": false, "tappable": true } } }
  ```

  - `neighbours` is symmetric. It covers land neighbours, plus maritime neighbours for islands.
  - `small` is true when the entry's bbox at its sub-region frame, rendered 375 CSS px wide, is under 12 × 12 CSS px.
  - `tappable` is `!small`.

### SRS state (issue 4)

This is flags' `{ code, repetitions, easeFactor, intervalDays, dueDate, lapses }` unchanged. Storage keys are `countries.srs.v1` and `countries.mode.v1`. Backup `app` is `'countries'`.

### Constants

These live in the module that owns them:

- `ROUND_SIZE = 10` and `NEW_CARD_LIMIT = 3` (both in `srs.js`)
- `TAP_CARD_SHARE = 0.25` and `MATURE_INTERVAL_DAYS = 21` (both in `cards.js`)
- `TAP_TOLERANCE_PX = 24`, a radius in CSS px of about 7 mm, and `AMBIGUITY_RATIO = 1.5` (both in `map.js`)

They can be tuned with a one-line PR.

---

## Orchestration charter

**Role**: one long-lived orchestrator session (**Opus, medium effort**) owns the build end-to-end. It files the issues, starts one implementation session per issue as dependencies clear, gets each PR reviewed, merges it, cleans up, and moves on. It escalates to the owner only when the rules below say so.

**Anti-drift**: before every merge decision, re-read this charter and the Privacy guard section. It's cheap, and it's a better defence than memory.

### Pre-flight (before anything is pushed)

1. Ask the owner to confirm the two GitHub email settings (Privacy guard → layer 6). Wait for a yes.
2. Confirm `gh repo view niklasjohannes/countries --json visibility,hasIssuesEnabled` and report the visibility. The repo is expected to be public, since Pages on a free account requires it.
3. **Bootstrap**, done directly by the orchestrator in this checkout on `main`:
   - `git config --local user.name "Niklas Johannes"`
   - `git config --local user.email 34960897+niklasjohannes@users.noreply.github.com`
   - Write `.git/info/private-patterns` from the global email and its domain, plus the employer name derived from that domain, without printing any of them.
   - Write a minimal `.gitignore` (`.claude/settings.local.json`, `.claude/worktrees/`, `.tmp/`, `.vendor-tmp/`, `.DS_Store`).
   - Verify with `git config user.email` against the allowed value. Print only "OK" or "MISMATCH", never the value.
   - Make the first commit: `docs/PLAN.md`, `docs/SPEC.md`, `.gitignore`.
   - Before pushing, check `git log --format='%ae %ce'` against the allowlist and grep the commit for the private patterns. Push only if both are clean.
4. Create issues 1–15 in order, each with a body (privacy-scanned) that links to its section of this file instead of copying it. Each body states: depends-on, model, effort, reviewer tier, whether a security review is required, and the acceptance criteria. Then verify that the GitHub numbers equal the spec numbers (lesson 3).

### Running issues

- **Implementation**: one session per issue.
  - `context: "fresh"`.
  - Its own worktree on branch `issue-<n>-<slug>`.
  - The model and effort from the issue table.
  - Auto-accept permissions. The sandboxed Bash tool is never disabled.
  - The brief names the issue number, the sections of this file to read, and the files to copy from flags (if any). It also states the report format: at most 15 lines, with the PR URL, the test count, any deviations, and any open questions.
- **At most 2 implementation sessions run at once.** Prefer the critical path: 3 → 4 → 5 → 7 → 9.
- **Review**: one subagent per PR, `model` set one tier above the implementer (Haiku → Sonnet, Sonnet → Opus, Opus → Opus).
  - It runs `/code-review` at `medium` effort, or `high` for Opus issues, on the PR diff.
  - It checks the issue's acceptance criteria and the Privacy guard.
  - It returns findings only. It doesn't post them and doesn't push.
  - When the issue table says so, a second subagent (Sonnet) runs `/security-review` on the same PR.
- **Fix loop**: the orchestrator forwards the findings with `SendMessage` to the implementing session, which already has the context. Its fix commit then gets a **delta** review at `low` effort from the same reviewer tier.
  - If an issue fails review twice, the orchestrator re-runs it once on the next model tier up, as a fresh session on the same branch.
  - If it fails a third time, that is an escalation.
- **Merge**: once CI (tests + privacy) is green and the review is clean, run `gh pr merge --squash --repo niklasjohannes/countries`. Then:
  - Confirm the `privacy` CI job passes on the resulting `main` push.
  - `git worktree remove` that issue's worktree, delete the local branch, and archive the session.
- **The orchestrator never reads full diffs.** Its sources of truth are `gh pr checks`, `gh pr view --json`, reviewer findings and session reports. GitHub issue and PR state is the only progress ledger.
- Every `gh` call passes `--repo niklasjohannes/countries`. Before every push, confirm the remote is `git@github.com:niklasjohannes/countries.git`.
- The flags repo is read-only, and nothing outside this repo is touched.

### Owner checkpoints (stop and wait)

1. **After issue 6: map contact sheet.** Send the owner the rendered frames of every continent and sub-region, plus the small-country markers. The owner approves shapes, borders, framing and microstate handling before issue 8 starts.
2. **After issue 11: design screenshots.** At 375×812, send every screen: home, a map→name question in MC and in typing, a name→tap question, a miss with neighbour labels, a small-country inset, the round summary, a test question, and the test results map.
3. **Before issue 15: go-live.** Enabling GitHub Pages makes the app public.

### Escalate instead of deciding alone

- The privacy guard fails anywhere, or any doubt about personal data.
- An action outside this repo, or a destructive git operation (force-push, history rewrite, reset, deleting a branch that isn't the orchestrator's own throwaway).
- A border, naming or sovereignty case the `DATA.md` policy table doesn't cover.
- A spec gap that changes behaviour or UX.
- The same issue fails 3 times (see the fix loop).
- Merging issue 15 while issue 13 has unresolved findings.

Everything else proceeds without asking.

### Credential hygiene

Never print, log or commit token material. Never read `gh`'s token. The `gh` CLI keeps it in the keychain.

---

## Issues

| # | Title | Depends on | Model / effort | Reviewer | Security review |
|---|---|---|---|---|---|
| 1 | Scaffold, conventions, CI | — | Haiku | Sonnet | — |
| 2 | Privacy guard | 1 | Sonnet / medium | Opus | yes |
| 3 | Country metadata | 2 | Sonnet / medium | Opus | — |
| 4 | Port engine modules | 2 | Sonnet / medium | Opus | — |
| 5 | Geometry pipeline | 3 | Opus / high | Opus | yes |
| 6 | Frames, small entries, contact sheet | 5 | Sonnet / medium | Opus | — |
| 7 | Pure map logic (`map.js`, `cards.js`) | 4, 5 | Opus / high | Opus | — |
| 8 | Map renderer (`map-view.js`) | 6, 7, checkpoint 1 | Sonnet / medium | Opus | yes |
| 9 | App shell & home | 3, 4 | Sonnet / medium | Opus | — |
| 10 | Practice flow | 8, 9 | Sonnet / high | Opus | — |
| 11 | Test mode + visual design | 10 | Sonnet / medium | Opus | — |
| 12 | PWA & offline | 11, checkpoint 2 | Haiku | Sonnet | yes |
| 13 | Final review | 12 | read-only: Opus `/code-review high` + Sonnet `/security-review` + Sonnet design walk | — | yes |
| 14 | Review fix-ups | 13 | Sonnet / medium | Opus | if 13 found security issues |
| 15 | Deploy | 14, checkpoint 3 | Haiku | — | — |

Suggested order with 2 lanes: `1 → 2 → {3, 4} → {5, 9} → {6, 7} → 8 → 10 → 11 → 12 → 13 → 14 → 15`.

### 1 — Scaffold, conventions, CI

Copy and adapt these from `../flags`:

- `.gitattributes`, `LICENSE` (MIT), `package.json` (rename it, keep the zero-dependency note)
- `.github/workflows/ci.yml` (keep the SHA-pinned actions)
- `scripts/dev_server.py`, `.claude/launch.json` (rename to `countries-static`, port 8005)
- `docs/CONVENTIONS.md`: replace "flags" with "countries", `--repo niklasjohannes/flags` with `--repo niklasjohannes/countries`, and the `/flags/` prefix with `/countries/`. Add the Privacy guard summary, and add the rule that **map paths are built with `createElementNS` + `setAttribute('d', …)` from numeric data only**.

Then:

- Extend the bootstrap `.gitignore` with flags' entries.
- Write a README stub, including flags' macOS preview note.
- Create the empty directories from PLAN.md → Architecture.
- Add a `THIRD_PARTY_NOTICES.md` stub.

**Acceptance criteria**:

- CI is green on the PR.
- `python3 scripts/dev_server.py 8005` serves `index.html`.
- None of the copied files mentions flags-specific paths. Check with `grep -ri flags` and justify each remaining hit.

### 2 — Privacy guard

Implement layers 2–4 of the Privacy guard exactly as specified:

- `scripts/check-privacy.js`, with modes `--staged`, `--range <a>..<b>`, `--tree` and `--stdin`. Output is categories only; the matched text is never echoed.
- `.githooks/pre-commit`, `.githooks/commit-msg` and `.githooks/pre-push`, as POSIX `sh` that calls the Node script. The README documents `git config core.hooksPath .githooks`, and the orchestrator runs it right after the merge.
- A `privacy` job in `ci.yml` for PR and push events. It needs `fetch-depth: 0` to see the full range.
- `test/check-privacy.test.js`. Positive and negative fixtures for every category use only `example.com` and `example.org` emails and fake home paths. Also test that the scanner never prints the match, that allowlisted emails pass, and that a non-allowlisted author email on a commit fails `--range`. Build a throwaway repo under the OS temp directory inside the test for this.

**Acceptance criteria**:

- All tests pass.
- With the hooks active, a deliberately bad commit is blocked locally. Use a fake address at the `example.net` domain (not allowlisted), in a scratch branch that is deleted afterwards.
- The CI `privacy` job is green on this PR.
- The security review checks that the scanner itself can't leak, and that CI can't be bypassed with a `[skip ci]` message. If it can be, note this and require the job in branch protection.

### 3 — Country metadata

Build `data/countries.json` according to the contract, with a zero-dependency generator `scripts/build-countries.js` and a hand-edited `scripts/country-overrides.js`, following flags' pattern (read `../flags/docs/DATA.md`).

- Reuse flags' names, aliases, sovereignty, `parentCode` and naming policy by copying the relevant entries from `../flags/scripts/country-overrides.js`. Add Kosovo (`xk`, aliases "Kosova").
- Assign each entry's continent and sub-region from M49.
- Include all 206 quizzed entries and the context-only territories that Natural Earth draws. Issue 5 reconciles the final context list against the geometry.
- Write `docs/DATA.md`, including the **border policy table** from PLAN.md decision 15, with every case listed.

**Acceptance criteria**:

- Tests check that:
  - `quizzed` gives exactly 206 entries: 193 UN members, 4 named extras and 9 territories.
  - Every `subregion` is in the closed list and maps to its continent.
  - Every `parentCode` resolves.
  - A regeneration check passes byte for byte.
- Spot checks: Russia is `eastern-europe`, Türkiye and Cyprus are `western-asia`, Greenland is `northern-america` with parent `dk`, Hong Kong has parent `cn`, and Western Sahara has a null parent.

### 4 — Port engine modules

Copy these from `../flags` with their tests:

- `js/srs.js`, `js/storage.js`, `js/backup.js`
- `js/quiz.js` (the suggestions and distractor parts)

Adapt them as follows:

- Generalise the `region` filter to `{ continent, subregion }`, where either may be null.
- Rename the keys and constants, e.g. `NEW_FLAG_LIMIT` becomes `NEW_CARD_LIMIT`.
- Change distractor ranking to neighbours → same sub-region → same continent → any. Keep the parent/sibling exclusion and the small-pool fallback. Neighbours come in as an argument, so this issue uses a fixture shaped like `map-meta.json`.
- Run suggestions over `quizzed` entries only.

Don't change the SM-2 maths.

**Acceptance criteria**:

- All ported tests pass, adapted to the new filter.
- New tests cover: a sub-region filter; distractors prefer neighbours (e.g. Togo gets Benin or Ghana); Hong Kong never gets China as a distractor; and a Polynesia-sized pool still yields 3 valid distractors.

### 5 — Geometry pipeline

Vendor Natural Earth admin-0 at 1:50m, with 1:10m only for quizzed entries missing at 50m. Use the GeoJSON from `nvkelso/natural-earth-vector`, pinned to a tagged release at least 2 weeks old. Record the tag, the commit and each file's SHA-256 in `docs/DATA.md` and `THIRD_PARTY_NOTICES.md`. Downloads go to `.vendor-tmp/` and are treated as untrusted: `JSON.parse` only, nothing executed.

Write `scripts/build-geometry.js` (zero-dependency) to do the following:

- Map Natural Earth features to codes. Use `ISO_A2_EH`, not `ISO_A2`, which is `-99` for France, Norway and Kosovo.
- Split out overseas parts that are separate entries, such as French Guiana from France.
- Apply the border policy table, using Natural Earth's breakaway/disputed layer where needed.
- Project each continent with a Lambert azimuthal equal-area projection on a documented centre. Handle the antimeridian for Oceania, Russia and Fiji. Use Equal Earth for `world.json`.
- Extract shared arcs and simplify each arc once (Visvalingam, with a tolerance per file), then quantise to integers.
- Derive symmetric `neighbours`: land from shared arcs, plus the nearest 3 within a distance cap for islands.
- Write the geometry files from the contract.

If the policy table doesn't cover a case, **stop and escalate**.

**Acceptance criteria**:

- Tests check that:
  - Every quizzed code has geometry in its continent file and in `world.json`.
  - No two neighbouring entries overlap or leave a gap along a shared arc (sampled check).
  - `neighbours` is symmetric.
  - There is a size budget: the continent files total at most 1 MB uncompressed, and `world.json` is at most 250 KB.
  - Rings contain only finite integers.
  - Regeneration is byte for byte.
- Spot checks: Crimea is inside Ukraine's rings; Lesotho is a hole in South Africa; Kaliningrad is part of Russia; Alaska is in north-america; Fiji renders without an antimeridian seam.

### 6 — Frames, small entries, contact sheet

Generate `data/map-meta.json`:

- **Frames**: computed from the bboxes of each continent's and sub-region's quizzed entries, padded, with hand-tuned overrides in `scripts/frame-overrides.js`. For example, the Europe frame is cropped around the Urals and doesn't follow Russia to the Pacific.
- **`small` / `tappable`**, according to the contract.
- **`neighbours`**, carried over from issue 5.

Add `scripts/render-contact-sheet.js`, a dev-only script that string-builds standalone SVGs into `.tmp/contact-sheet/`:

- one per frame;
- one with every small entry's circle marker and inset;
- an `index.html` that tiles them all.

It is never served by the app and never precached.

**Acceptance criteria**:

- Tests check that every quizzed entry's label point lies inside its sub-region frame and its continent frame, and that every sub-region frame lies within its continent's projection extent.
- The orchestrator runs the script and sends the owner the contact sheet. This is **checkpoint 1**.

### 7 — Pure map logic

Write `js/map.js`:

- `ringsToPathData`, which outputs a numeric path string only.
- `hitTest(point, entries, frame, viewportPx)`. It returns `{ code }` if the point is inside a polygon, or the nearest tappable entry within `TAP_TOLERANCE_PX`. When the second-nearest is within `AMBIGUITY_RATIO` of the nearest, it returns `{ ambiguous: [a, b] }`, and otherwise `null`. Use point-in-polygon with holes, and point-to-segment distance.
- `computeInset(entry, frame)`.

Write `js/cards.js`:

- `pickDirection(entry, rng)`, using `TAP_CARD_SHARE` and only for tappable entries.
- `pickFrame(state, entry)`: the sub-region frame, or the continent frame when `intervalDays ≥ MATURE_INTERVAL_DAYS`.

Both modules are pure, with `rng` injected, as in CONVENTIONS.

**Acceptance criteria**:

- Tests cover:
  - a tap inside a hole (Lesotho, not South Africa);
  - a tap in the sea within tolerance of one country, which returns that country;
  - a tap between two close countries, which is ambiguous;
  - a tap far out at sea, which returns `null`;
  - a small entry, which is never a tap card;
  - the frame switching at exactly 21 days;
  - deterministic output for a given `rng`.

### 8 — Map renderer

Write `js/map-view.js`. It renders a frame into an `<svg>` with `createElementNS`:

- the land layer, with context entries in the same grey;
- the target fill in the accent;
- an outline for the wrong pick;
- small-entry circle markers and an inset `<svg>` that reuses the same paths;
- neighbour labels on the reveal, using `textContent`;
- a tap layer that converts pointer coordinates to frame coordinates and calls `hitTest`.

**No spoilers before the reveal**:

- The map has `aria-hidden="true"` and no `<title>`.
- No country names or codes appear in the DOM; keep codes in a JS `Map`.
- There is one generic `aria-label` on the question region.

Verify in the browser preview at 375×812 and at desktop size, using a throwaway harness page under `.tmp/` that is not committed.

**Acceptance criteria**:

- Every frame renders without console errors.
- Taps map correctly, including the ambiguous case.
- The security review confirms there is no `innerHTML`, that path data is numeric-only, and that the pre-reveal DOM leaks no names.

### 9 — App shell & home

Write `index.html`, `css/` base styles and `js/app.js` routing, following flags' structure (read `../flags/js/app.js` and `../flags/js/views/`). The home screen has:

- continent chips, and sub-region chips once a continent is chosen;
- the mode toggle;
- the total quizzed count for the filter;
- Start and Test;
- the backup footer, ported from flags' `backup-sheet.js`.

The filter resets to "All" on load.

**Acceptance criteria**: in the preview, reloading resets the filter, the count updates for both the continent and sub-region levels, and South America shows no sub-region chips.

### 10 — Practice flow

Write the practice view. It runs 10-question rounds from `pickRound`, chooses each card's direction with `pickDirection` and its frame with `pickFrame`.

- **Map→name** uses MC or typing, following the mode toggle. The answer UI comes from flags' `question.js` and `practice-round.js`, adapted.
- **Name→tap** shows the prompt "Tap <name>". An ambiguous tap opens a two-option confirm sheet.
- **Feedback** follows PLAN.md decision 12. A miss re-queues the card.
- **The round summary** offers "Keep going" / "Done".

**Acceptance criteria**:

- A full round plays in both modes and includes both card directions (use a seeded `rng` for the check).
- The SRS state in `localStorage` updates correctly.
- A miss waits for "Next" and shows the neighbour labels, while a hit doesn't wait.
- A mature card shows the continent frame.

### 11 — Test mode + visual design

**Test mode**:

- The scope is the current filter.
- Every entry is asked map→name on its continent frame, blind, with a counter.
- The results screen shows the score, the missed list, and a results map with the missed entries shaded: the continent frame, or `world.json` for "All".
- Test mode never calls the SRS write path. Verify that `localStorage` is byte-identical before and after.

**Design pass**: port flags' final look by copying these from `../flags`:

- `fonts/` with `OFL.txt` and its SHA-256 notes;
- the CSS tokens;
- `img/` (the pixel ✓/✕ marks).

Then:

- Style the map: land, borders, accent, outline, markers, labels.
- Apply mobile polish: safe areas, tap targets, and the map as the dominant element.
- Support `prefers-reduced-motion` and forced colours.

**Acceptance criteria**: a test pass works end to end with SRS untouched. The orchestrator sends the owner the screenshots listed under checkpoint 2.

### 12 — PWA & offline

Copy and adapt these from `../flags` with their tests:

- `manifest.webmanifest` (`start_url` and `scope` set to `/countries/`)
- `scripts/build-sw.js` (the content-hash cache name)
- `sw.js` runtime, `js/update-reload.js`
- `scripts/build-icons.js`

The icon is a new black-on-white pixel glyph, a globe or a country outline, with no text. Add the CSP `default-src 'self'` meta tag.

**Acceptance criteria**:

- Ported tests pass.
- Under `--base /countries/` in the preview, the service worker registers with no errors and works offline.
- A simulated redeploy replaces the cache.
- There are no requests to any non-`self` origin.

### 13 — Final review (read-only)

The orchestrator runs three subagents in parallel against `main`:

1. **Opus**, `/code-review` at `high`, over the whole repo. Focus: test coverage of `srs`/`quiz`/`map`/`cards`, the geometry pipeline's correctness, SW cache versioning, and DOM safety.
2. **Sonnet**, `/security-review`. Focus: CSP; secrets and personal data in the **full history** (run `check-privacy.js --range` from the root commit); the vendored-data pins; DOM injection; and that the SW never caches cross-origin responses.
3. **Sonnet** design walk. Every row of PLAN.md → Decisions is checked against the running app in the preview at 375×812, and each is reported as pass, fail or partial.

Findings are consolidated, scanned for privacy, and filed as a checklist in issue 14's body. Nothing is posted as PR comments.

### 14 — Review fix-ups

Fix every finding from issue 13 in one PR, with one commit per finding where practical.

**Acceptance criteria**: each checklist item is ticked with its commit or a justified "won't fix" that the owner accepts. CI is green.

### 15 — Deploy

**Checkpoint 3**: ask the owner before enabling Pages, which serves `main` from the root.

Then:

- Add the live URL to the README.
- Smoke-test the live URL with `curl` for the HTML, the manifest and the SW.
- Hand the owner the iPhone checklist: Add to Home Screen, offline after the first load, and update on resume.

**Acceptance criteria**: the live URL serves the app, and the owner confirms the iPhone checklist.
