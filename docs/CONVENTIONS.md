# Conventions

Shared rules for every issue in [`SPEC.md`](SPEC.md). If something here conflicts with the spec, the spec wins.

## Privacy guard

Nothing personal reaches GitHub: not in a commit, a file, a commit message, an issue, a PR body, a PR comment or a review comment. The full definition is in SPEC.md → Privacy guard. In short:

- Never commit the owner's work email address or its domain, the employer's name, or absolute home paths (`/Users/<name>/`, `/home/<name>/`, `C:\Users\<name>\`). Use relative paths.
- Never commit credentials: `gh` tokens, `ghp_…`, `github_pat_…`, `sk-ant-…`, `AKIA…`, or `.netrc` content.
- Never commit local Claude state: `.claude/settings.local.json`, `.claude/worktrees/`, transcripts, `.tmp/`, or local session links.
- Git identity is the noreply address `34960897+niklasjohannes@users.noreply.github.com` and must never be changed per commit. Linked worktrees share it.
- Commit trailers may name `noreply@anthropic.com` (`Co-Authored-By`). Do not add other email addresses.

The scanner, hooks and CI job that enforce this are built in issue 2. Until then, check diffs by hand before committing.

## Modules and dependencies

- Plain ES modules (`import`/`export`), loaded in the browser via `<script type="module">` and in Node via `package.json`'s `"type": "module"`.
- Import specifiers are always relative with an explicit `.js` extension (`import { pickDue } from './srs.js'`). Never extensionless, never bare (`'srs'`), since both browsers and Node ESM reject those.
- **Exception: `sw.js` is a classic script** (no `import`/`export`), registered as `navigator.serviceWorker.register('./sw.js')` from the app root so its scope is `/countries/`. Module service workers have patchier support.
- **Zero npm dependencies**, including dev dependencies. `package.json` exists only for `"type": "module"` and a `test` script alias.
- No build step. What's in the repo is what GitHub Pages serves. Generators in `scripts/` are dev-only and run by hand; their output is committed.
- All asset paths are **relative** (`./js/app.js`, `./data/countries.json`), never root-absolute (`/js/app.js`), because Pages serves the app from `/countries/`.

## Tests

- Node's built-in runner: `node --test` (CI runs the same on Node 24).
- Test files live in `test/` and are named `<module>.test.js` (e.g. `test/srs.test.js`).
- Node's default discovery runs **every** `.js` file under `test/` as a test. Fixtures go in as `.json`, and shared helpers live outside `test/` (e.g. `test-support/`).
- Use `node:test` (`describe`/`it` or `test`) and `node:assert/strict`.
- Pure modules (`js/srs.js`, `js/quiz.js`, `js/cards.js`, `js/map.js`) take state and data as arguments: no DOM, no `localStorage`, no `fetch`, and no hidden `Date.now()` or `Math.random()`. Inject `today` and an `rng` function (`() => number` in `[0, 1)`) so tests are deterministic.

## Dates

- SRS scheduling is day-granular. `dueDate` and every injected `today` is an ISO local calendar date string, `YYYY-MM-DD`, computed by the caller (the app) from the device's local time. Pure modules never read the clock or the timezone.

## JavaScript style

- 2-space indentation, semicolons, `const` by default, single quotes.
- `camelCase` for functions and variables (matching the spec's data fields: `easeFactor`, `parentCode`), `SCREAMING_SNAKE_CASE` for module-level constants, `PascalCase` for classes.
- Verb-noun function names (`pickDistractors`, `updateCardState`, `filterSuggestions`).
- JSDoc on every exported function (`@param` with types, `@returns`).
- Defensive validation in every exported function: throw `TypeError`/`RangeError` with a specific message that wraps parameter names in backticks, e.g. `` throw new TypeError('`easeFactor` must be a finite number.') ``.

## DOM safety

- Never use `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` with interpolated or concatenated strings. Build nodes with `document.createElement` and set `textContent` and attributes.
- **Map paths are built with `createElementNS` + `setAttribute('d', …)` from numeric data only.** The `d` value is assembled from numbers (`M`, `L`, `Z` commands and quantised coordinates), never from strings taken from data files, URLs or the DOM. Never use `innerHTML` for SVG, and never inline SVG markup from a file.
- Before the answer is revealed, prompt and label text must never contain the name of the country being asked about.
- CSP-ready from day one: no inline `<script>` blocks, no `style="..."` attributes, no inline event handlers (`onclick=`). Use external files, CSS classes and `addEventListener`.

## Git

- One implementation issue = one branch `issue-<n>-<slug>`, where `<n>` is the **spec** number (e.g. `issue-1-scaffold`) = one PR whose body says `Closes #<GitHub number>`. GitHub numbers equal spec numbers (SPEC.md, Lessons from the flags build, item 3). Read-only review issues (13) have no branch.
- Pass `--repo niklasjohannes/countries` to every `gh` call.
- Never force-push. Never set or change git identity; the local config already holds the noreply identity.
