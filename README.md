# Countries

A zero-dependency progressive web app for learning the outlines of the world's countries with spaced repetition. Plain HTML, CSS and JavaScript — no build step, no npm packages.

Intended to be served at **<https://niklasjohannes.github.io/countries/>** once deployed. See [`docs/SPEC.md`](docs/SPEC.md) for the build plan and [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) for the shared rules.

## Layout

| Path | Contents |
| --- | --- |
| `index.html` | App entry point (placeholder until the app shell lands) |
| `css/` | Stylesheets |
| `js/` | App modules (SRS engine, quiz engine, map logic, views) |
| `js/views/` | One module per screen |
| `data/` | Country metadata (`countries.json`) and projected geometry (`geometry/`), both generated |
| `vendor/` | Unmodified upstream inputs (Natural Earth GeoJSON and its terms) |
| `scripts/` | Dev-only generators, the privacy scanner and the dev server |
| `test/` | `node --test` suites |
| `docs/` | Build spec, plan and conventions |

## Running locally

Serve the repo root with the bundled dev server (Python standard library only, binds `127.0.0.1`, sends `Cache-Control: no-store`):

```bash
/usr/bin/python3 scripts/dev_server.py 8005
```

then open <http://127.0.0.1:8005/>. Any static server works too. Opening `index.html` as a file does not, because `fetch` of `data/countries.json` needs HTTP.

To check install and offline behaviour exactly as GitHub Pages will serve them, serve under the project-site prefix:

```bash
/usr/bin/python3 scripts/dev_server.py 8005 --base /countries/
```

then open <http://127.0.0.1:8005/countries/>. The manifest's `start_url` and `scope` and the service worker's scope then all resolve to `/countries/`, `/countries` redirects to `/countries/`, and anything outside the prefix is a 404.

### Local preview (Claude Code desktop)

`.claude/launch.json` defines `countries-static`, which runs the same command for the in-app browser preview (at `/`; add `--base /countries/` to its `runtimeArgs` to preview under the Pages prefix). The server finds the repo root from its own path and never reads the working directory. That matters because the preview launcher may be unable to read it.

If the launcher reports `can't open file 'scripts/dev_server.py': [Errno 1] Operation not permitted`, it has no permission to read the checkout. This happens for checkouts under `~/Documents` when macOS has not granted the app access to that folder. A committed config can't fix that. Either grant the Claude app access to the folder (System Settings → Privacy & Security → Files and Folders, or Full Disk Access), or keep the checkout outside the protected folders. In the meantime, run the command above from a terminal or shell session and preview <http://127.0.0.1:8005/> in a browser. Keep any scratch files in the gitignored `.tmp/` inside the checkout.

## Running the tests

Tests use Node's built-in test runner — nothing to install:

```bash
node --test
```

CI runs the same command on every push and pull request.

## License

[MIT](LICENSE)
