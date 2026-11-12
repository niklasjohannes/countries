// Every file the app loads at run time must be in the service worker's
// precache list (`PRECACHE_FILES` in sw.js), or it breaks offline without
// anyone noticing. This test reads the references out of the sources:
// index.html, the manifest, `url()` in CSS, module imports, and quoted paths
// in JS (`fetch` URLs and the like). A reference to a directory (a path
// ending in `/`) is covered when some listed file lies under it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Named here rather than derived from the scanner, so a regression in the
// scanner cannot quietly drop them.
const MUST_BE_PRECACHED = Object.freeze([
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'css/map.css',
  'css/practice.css',
  'css/test.css',
  'js/app.js',
  'js/data.js',
  'js/update-reload.js',
  'js/views/home.js',
  'js/views/practice.js',
  'js/views/test.js',
  'js/views/results.js',
  'data/countries.json',
  'data/map-meta.json',
  'data/geometry/world.json',
  'data/geometry/africa.json',
  'data/geometry/asia.json',
  'data/geometry/europe.json',
  'data/geometry/north-america.json',
  'data/geometry/oceania.json',
  'data/geometry/south-america.json',
  'fonts/CourierPrime-Regular.ttf',
  'fonts/CourierPrime-Bold.ttf',
  'img/mark-check.svg',
  'img/mark-cross.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
  'icons/favicon.svg'
]);

// ---- Helpers ----

function read(path) {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

function walk(relativeDir) {
  return readdirSync(join(REPO_ROOT, relativeDir), { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .flatMap((entry) => {
      const path = `${relativeDir}/${entry.name}`;
      return entry.isDirectory() ? walk(path) : [path];
    });
}

function listedPaths() {
  const source = read('sw.js');
  const list = source.match(/^const PRECACHE_FILES = \[\n([\s\S]*?)\n\];$/m)?.[1];
  assert.ok(list !== undefined, '`sw.js` has no `PRECACHE_FILES` list.');
  return [...list.matchAll(/\['\.\/([^']+)', '[0-9a-f]{64}'\]/g)].map(([, path]) => path);
}

// Resolve `reference`, written relative to `fromFile`, to a repo path. Only
// local references are returned; anything with a scheme or a leading `/` is
// reported by the other-origin checks, not here.
function resolveLocal(fromFile, reference) {
  if (/^([a-z]+:|\/|#|\?)/i.test(reference) || reference === '') {
    return null;
  }
  const withoutQuery = reference.split(/[?#]/)[0];
  return normalize(join(dirname(fromFile), withoutQuery)).split('\\').join('/');
}

// Every reference the app makes at run time, as `{ from, path }` with `path`
// relative to the repo root (and a trailing `/` for a directory).
function collectReferences() {
  const references = [];
  const add = (from, reference) => {
    // A template such as `data/geometry/${key}.json` names a file chosen at
    // run time: its folder is what has to be precached.
    const dynamic = reference.indexOf('${');
    const literal = dynamic === -1 ? reference : reference.slice(0, dynamic).replace(/[^/]*$/, '');
    const path = resolveLocal(from, literal);
    if (path !== null) {
      const isDirectory = literal.endsWith('/') || dynamic !== -1;
      references.push({ from, path: isDirectory && !path.endsWith('/') ? `${path}/` : path });
    }
  };

  const html = read('index.html');
  for (const [, reference] of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    add('index.html', reference);
  }

  const manifest = JSON.parse(read('manifest.webmanifest'));
  for (const icon of manifest.icons) {
    add('manifest.webmanifest', icon.src);
  }

  for (const file of walk('css').filter((path) => path.endsWith('.css'))) {
    for (const [, reference] of read(file).matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
      add(file, reference);
    }
  }

  for (const file of walk('js').filter((path) => path.endsWith('.js'))) {
    // Comments mention paths that are documentation, not loads.
    const source = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const [, specifier] of source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'([^']+)'/gm)) {
      add(file, specifier);
    }
    // Quoted paths to the app's own folders, e.g. `fetch('./data/countries.json')`.
    for (const [, , reference] of source.matchAll(/(['"`])((?:\.\/)?(?:css|data|fonts|img|icons|js)\/[^'"`\s]*)\1/g)) {
      // Fetch URLs resolve against the page (the repo root), not this file.
      add('index.html', reference);
    }
  }
  return references;
}

// ---- Tests ----

describe('runtime references', () => {
  const listed = new Set(listedPaths());
  const references = collectReferences();

  it('finds the references it is meant to scan', () => {
    const paths = new Set(references.map(({ path }) => path));
    assert.ok(paths.has('js/views/home.js'), 'The JS scan found no module imports.');
    assert.ok(paths.has('css/style.css') || paths.has('fonts/CourierPrime-Regular.ttf'), 'The CSS scan found no `url()`.');
    assert.ok(paths.has('data/countries.json'), 'The JS scan found no quoted data path.');
  });

  it('points only at files that exist', () => {
    for (const { from, path } of references) {
      const full = join(REPO_ROOT, path);
      assert.ok(existsSync(full), `${from} references \`${path}\`, which does not exist.`);
    }
  });

  it('is precached, file by file or by directory', () => {
    const missing = [];
    for (const { from, path } of references) {
      if (path.endsWith('/')) {
        const covered = [...listed].some((file) => file.startsWith(path));
        if (!covered) {
          missing.push(`${from} → \`${path}\` (no precached file under it)`);
        }
      } else if (statSync(join(REPO_ROOT, path)).isFile() && !listed.has(path)) {
        missing.push(`${from} → \`${path}\``);
      }
    }
    assert.deepEqual(missing, [], 'Referenced at run time but not in the precache list:\n' + missing.join('\n'));
  });

  it('precaches every file in the explicit must-have list', () => {
    const missing = MUST_BE_PRECACHED.filter((path) => !listed.has(path));
    assert.deepEqual(missing, [], 'Missing from the precache list.');
  });

  it('precaches every file in the app folders, so nothing is missed by a new reference', () => {
    const folders = ['css', 'data', 'fonts', 'icons', 'img', 'js'];
    const missing = folders.flatMap(walk).filter((path) => !listed.has(path));
    assert.deepEqual(missing, []);
  });
});
