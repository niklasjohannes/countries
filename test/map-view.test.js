import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hitTest } from '../js/map.js';
import {
  REGION_LABEL,
  boxesIntersect,
  createMapView,
  planScene,
  toFramePoint,
  toViewBox,
} from '../js/map-view.js';

// ---- Fixtures ----
// Real southern-Africa geometry (see map.test.js). The fixture file has no
// `context` key, so a small context layer is added in the tests that need it.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => JSON.parse(readFileSync(join(ROOT, ...parts), 'utf8'));
const geometry = read('test', 'fixtures', 'geometry-southern-africa.json');
const meta = read('test', 'fixtures', 'map-meta-southern-africa.json');
const countries = read('data', 'countries.json').countries;
const FRAME = meta.frames['southern-africa'];
const VIEWPORT = { width: 375, height: 400 };

const square = (x0, y0, size) => [[[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size], [x0, y0]]];
const contextGeometry = {
  ...geometry,
  context: {
    // Overlaps the frame; the code is deliberately a real one.
    mg: { rings: square(FRAME[0], FRAME[1], 5_000), bbox: [FRAME[0], FRAME[1], FRAME[0] + 5_000, FRAME[1] + 5_000] },
    // Far away from the frame: must be dropped.
    tr: { rings: square(-900_000, -900_000, 100), bbox: [-900_000, -900_000, -899_900, -899_900] },
  },
};

// ---- Minimal fake DOM ----

class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.attrs = {};
    this.children = [];
    this.text = '';
    this.listeners = {};
    this.rect = { width: 0, height: 0 };
    this.ctm = null;
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; }
  set textContent(value) { this.text = String(value); }
  get textContent() { return this.text; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); }
  getBoundingClientRect() { return this.rect; }
  getScreenCTM() { return this.ctm; }
  dispatch(type, event) { (this.listeners[type] ?? []).forEach((fn) => fn(event)); }
}

const fakeDocument = {
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_ns, tag) => new FakeNode(tag),
};

function walk(node, visit) {
  visit(node);
  node.children.forEach((child) => walk(child, visit));
}
const all = (node, predicate) => {
  const found = [];
  walk(node, (n) => { if (predicate(n)) found.push(n); });
  return found;
};
const byClass = (node, cls) => all(node, (n) => (n.attrs.class ?? '').split(' ').includes(cls));

// Attribute values and text only (not tag or attribute names).
function serialiseValues(node) {
  const parts = [];
  walk(node, (n) => { parts.push(...Object.values(n.attrs), n.text); });
  return parts.join('\n');
}

// An svg 375 x 400 CSS px whose screen matrix maps CSS px to frame units with
// `meet` letterboxing, as a browser would.
function layOut(svg, viewport = VIEWPORT, frame = FRAME) {
  svg.rect = viewport;
  const scale = Math.min(viewport.width / (frame[2] - frame[0]), viewport.height / (frame[3] - frame[1]));
  const offsetX = (viewport.width - scale * (frame[2] - frame[0])) / 2;
  const offsetY = (viewport.height - scale * (frame[3] - frame[1])) / 2;
  svg.ctm = {
    inverse: () => ({ a: 1 / scale, b: 0, c: 0, d: 1 / scale, e: frame[0] - offsetX / scale, f: frame[1] - offsetY / scale }),
  };
  return { scale, offsetX, offsetY };
}

function makeView(callbacks = {}) {
  const view = createMapView({ document: fakeDocument, ...callbacks });
  layOut(view.svg);
  return view;
}

function toClient(point, { scale, offsetX, offsetY }) {
  return { clientX: (point[0] - FRAME[0]) * scale + offsetX, clientY: (point[1] - FRAME[1]) * scale + offsetY };
}

const baseInput = { geometry: contextGeometry, meta, frame: FRAME, frameLevel: 'subregion' };

// ---- Pure helpers ----

describe('boxesIntersect', () => {
  it('is true for overlapping and touching boxes, false for disjoint ones', () => {
    assert.equal(boxesIntersect([0, 0, 10, 10], [5, 5, 15, 15]), true);
    assert.equal(boxesIntersect([0, 0, 10, 10], [10, 10, 20, 20]), true);
    assert.equal(boxesIntersect([0, 0, 10, 10], [11, 0, 20, 10]), false);
  });
});

describe('toFramePoint', () => {
  it('applies the matrix', () => {
    assert.deepEqual(toFramePoint({ a: 2, b: 0, c: 0, d: 2, e: 10, f: -5 }, 3, 4), [16, 3]);
  });
  it('rejects bad input', () => {
    assert.throws(() => toFramePoint(null, 1, 1), /`inverse`/);
    assert.throws(() => toFramePoint({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, NaN, 1), /`clientX`/);
  });
});

describe('planScene', () => {
  const scene = planScene(baseInput);

  it('draws own land that meets the frame, biggest first, with numeric path data', () => {
    assert.ok(scene.land.length > 0);
    const areas = scene.land.map(({ bbox }) => (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]));
    assert.deepEqual(areas, [...areas].sort((a, b) => b - a));
    for (const { d } of scene.land) {
      assert.match(d, /^[MLZ0-9 -]+$/);
    }
  });

  it('keeps context separate: merged path data, only the entries that meet the frame', () => {
    assert.match(scene.contextD, /^[MLZ0-9 -]+$/);
    assert.equal(scene.contextD.split('M').length - 1, 1);
    assert.ok(!scene.land.some(({ code }) => code === 'mg' || code === 'tr'));
  });

  it('has an empty context when the file has none', () => {
    assert.equal(planScene({ ...baseInput, geometry }).contextD, '');
  });

  it('resolves `small` per frame level', () => {
    const geo = { entries: { aa: geometry.entries.za } };
    const info = { entries: { aa: { small: true, smallInContinent: false, tappable: false } } };
    const frame = geometry.entries.za.bbox;
    assert.equal(planScene({ geometry: geo, meta: info, frame, frameLevel: 'subregion' }).land[0].small, true);
    assert.equal(planScene({ geometry: geo, meta: info, frame, frameLevel: 'continent' }).land[0].small, false);
  });

  it('validates input', () => {
    assert.throws(() => planScene({ ...baseInput, frame: [0, 0, 0, 1] }), /`frame`/);
    assert.throws(() => planScene({ ...baseInput, frameLevel: 'world' }), /`frameLevel`/);
    assert.throws(() => planScene({ ...baseInput, geometry: {} }), /`geometry`/);
    assert.throws(() => planScene({ ...baseInput, meta: null }), /`meta`/);
  });
});

// ---- Rendering ----

describe('createMapView render', () => {
  it('builds an aria-hidden svg in a labelled region, with no title or desc', () => {
    const view = makeView();
    view.render(baseInput);
    assert.equal(view.element.getAttribute('aria-label'), REGION_LABEL);
    assert.equal(view.svg.getAttribute('aria-hidden'), 'true');
    assert.equal(view.svg.getAttribute('viewBox'), toViewBox(FRAME));
    assert.equal(view.svg.getAttribute('viewBox'), `${FRAME[0]} ${FRAME[1]} ${FRAME[2] - FRAME[0]} ${FRAME[3] - FRAME[1]}`);
    assert.deepEqual(all(view.element, (n) => n.tag === 'title' || n.tag === 'desc'), []);
    assert.equal(all(view.element, (n) => 'aria-label' in n.attrs).length, 1);
  });

  it('draws context behind the land, lighter and as one element', () => {
    const view = makeView();
    view.render(baseInput);
    const [first] = view.svg.children;
    assert.equal(first.attrs.class, 'map-context');
    assert.equal(byClass(view.svg, 'map-context').length, 1);
  });

  it('fills the target from the start when given, and draws a marker and inset for a small one', () => {
    const view = makeView();
    view.render({ ...baseInput, target: 'za' });
    assert.equal(byClass(view.svg, 'map-target').length, 1);
    assert.equal(byClass(view.svg, 'map-marker').length, 0);

    // Comoros is small and lies in the eastern-africa frame, not the southern one.
    const eastern = { ...baseInput, frame: meta.frames['eastern-africa'] };
    view.render({ ...eastern, target: 'km' });
    const [marker] = byClass(view.svg, 'map-marker');
    assert.ok(Number(marker.attrs.r) > 0);
    const [inset] = byClass(view.svg, 'map-inset');
    assert.equal(inset.tag, 'svg');
    assert.match(inset.attrs.viewBox, /^[\d. -]+$/);
    const [, , w, h] = inset.attrs.viewBox.split(' ').map(Number);
    assert.equal(w, h, 'inset source is square');
    assert.ok(w > 0);
    // The inset reuses the scene's path data.
    const sceneData = new Set(planScene(eastern).land.map(({ d }) => d));
    assert.ok(inset.children.every((p) => sceneData.has(p.attrs.d)));
  });

  it('uses smallInContinent on a continent frame', () => {
    const custom = {
      entries: { aa: geometry.entries.km },
      context: {},
    };
    const info = { entries: { aa: { small: false, smallInContinent: true, tappable: true, neighbours: [] } } };
    const frame = [...geometry.entries.km.bbox];
    frame[2] += 10_000;
    frame[3] += 10_000;
    const view = makeView();
    view.render({ geometry: custom, meta: info, frame, frameLevel: 'continent', target: 'aa' });
    assert.equal(byClass(view.svg, 'map-marker').length, 1);
    view.render({ geometry: custom, meta: info, frame, frameLevel: 'subregion', target: 'aa' });
    assert.equal(byClass(view.svg, 'map-marker').length, 0);
  });

  it('rejects an unknown target', () => {
    const view = makeView();
    assert.throws(() => view.render({ ...baseInput, target: 'zz' }), /`target`/);
  });
});

describe('no spoilers before the reveal', () => {
  const tokens = (text) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

  for (const target of [null, 'za', 'km']) {
    it(`leaks no names or codes before the reveal (target ${target})`, () => {
      const view = makeView();
      view.render({ ...baseInput, target, interactive: true });
      const values = serialiseValues(view.element);
      const found = tokens(values);
      for (const { code, name, aliases } of countries) {
        assert.ok(!found.has(code), `code ${code} in DOM`);
        for (const label of [name, ...aliases]) {
          assert.ok(!values.toLowerCase().includes(label.toLowerCase()), `name ${label} in DOM`);
        }
      }
      assert.equal(all(view.element, (n) => n.text !== '').length, 0);
      assert.equal(all(view.element, (n) => n.tag === 'text').length, 0);
      for (const forbidden of ['id', 'title']) {
        assert.equal(all(view.element, (n) => forbidden in n.attrs).length, 0);
      }
      assert.equal(all(view.element, (n) => Object.keys(n.attrs).some((a) => a.startsWith('data-'))).length, 0);
    });
  }

  it('is not vacuous: the reveal does put names in the DOM, via text only', () => {
    const view = makeView();
    view.render({ ...baseInput, target: null });
    view.reveal({ target: 'za', picked: 'na', correct: false, names: { za: 'South Africa', ls: 'Lesotho', na: 'Namibia' } });
    assert.ok(serialiseValues(view.element).includes('South Africa'));
    assert.ok(all(view.element, (n) => n.tag === 'text' && n.text === 'South Africa').length === 1);
    assert.ok(!Object.values(view.svg.attrs).join('').includes('South Africa'));
  });
});

describe('source safety', () => {
  const source = readFileSync(join(ROOT, 'js', 'map-view.js'), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/**'))
    .join('\n');

  it('never parses markup', () => {
    for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'DOMParser', 'createContextualFragment']) {
      assert.ok(!source.includes(banned), banned);
    }
  });

  it('only takes path data from ringsToPathData', () => {
    const setsD = source.match(/\bd:\s*[^,}\n]+/g) ?? [];
    assert.ok(setsD.length > 0);
    for (const use of setsD) {
      assert.match(use, /\bd:\s*(item\.d|other\.d|scene\.contextD|ringsToPathData\()/);
    }
    assert.ok(!/setAttribute\(\s*'d'/.test(source));
  });
});

// ---- Reveal ----

describe('reveal', () => {
  const names = { za: 'South Africa', ls: 'Lesotho', na: 'Namibia', bw: 'Botswana', zw: 'Zimbabwe', mz: 'Mozambique', sz: 'Eswatini' };

  it('fills the target and stops taps; correct answers get no labels', () => {
    const taps = [];
    const view = makeView({ onTap: (code) => taps.push(code) });
    view.render({ ...baseInput, interactive: true });
    view.reveal({ target: 'za', correct: true, names });
    assert.equal(byClass(view.svg, 'map-target').length, 1);
    assert.equal(byClass(view.svg, 'map-label').length, 0);
    view.svg.dispatch('click', toClient(geometry.entries.za.label, layOut(view.svg)));
    assert.deepEqual(taps, []);
  });

  it('outlines a wrong pick and labels the target plus its neighbours on a miss', () => {
    const view = makeView();
    view.render({ ...baseInput });
    view.reveal({ target: 'za', picked: 'na', correct: false, names });
    assert.equal(byClass(view.svg, 'map-picked').length, 1);
    const labels = all(view.svg, (n) => n.tag === 'text');
    const expected = ['za', ...meta.entries.za.neighbours].filter((c) => geometry.entries[c]);
    assert.deepEqual(labels.map((n) => n.text).sort(), expected.map((c) => names[c]).sort());
    const za = labels.find((n) => n.text === 'South Africa');
    assert.equal(za.attrs.x, String(geometry.entries.za.label[0]));
    assert.equal(za.attrs.y, String(geometry.entries.za.label[1]));
  });

  it('validates input and requires a render first', () => {
    const view = makeView();
    assert.throws(() => view.reveal({ target: 'za', correct: true, names }), /`render`/);
    view.render(baseInput);
    assert.throws(() => view.reveal({ target: 'zz', correct: true, names }), /`target`/);
    assert.throws(() => view.reveal({ target: 'za', correct: 'yes', names }), /`correct`/);
    assert.throws(() => view.reveal({ target: 'za', correct: true, names: null }), /`names`/);
  });
});

// ---- Taps ----

describe('taps', () => {
  function setup() {
    const events = [];
    const view = makeView({
      onTap: (code) => events.push({ code }),
      onAmbiguous: (ambiguous) => events.push({ ambiguous }),
      onMiss: () => events.push(null),
    });
    view.render({ ...baseInput, interactive: true });
    const layout = layOut(view.svg);
    return { view, events, layout };
  }

  it('reports the tapped country, converting client px to frame units', () => {
    const { view, events, layout } = setup();
    view.svg.dispatch('click', toClient(geometry.entries.za.label, layout));
    view.svg.dispatch('click', toClient(geometry.entries.bw.label, layout));
    assert.deepEqual(events, [{ code: 'za' }, { code: 'bw' }]);
  });

  it('matches hitTest at the same viewport for an ambiguous tap', () => {
    const { view, events, layout } = setup();
    const entries = Object.fromEntries(
      planScene(baseInput).land.map((item) => [item.code, { rings: item.rings, bbox: item.bbox, tappable: item.tappable }]),
    );
    // Scan the coast for a point that is ambiguous at this viewport.
    const ring = geometry.entries.mz.rings[0];
    let ambiguousPoint = null;
    for (let i = 0; i < ring.length && ambiguousPoint === null; i++) {
      for (const dx of [-600, -300, 300, 600]) {
        const point = [ring[i][0] + dx, ring[i][1]];
        const result = hitTest(point, entries, FRAME, VIEWPORT);
        if (result !== null && 'ambiguous' in result) {
          ambiguousPoint = { point, result };
          break;
        }
      }
    }
    assert.ok(ambiguousPoint, 'found an ambiguous point');
    view.svg.dispatch('click', toClient(ambiguousPoint.point, layout));
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].ambiguous, ambiguousPoint.result.ambiguous);
  });

  it('reports a miss far out at sea', () => {
    const { view, events, layout } = setup();
    view.svg.dispatch('click', toClient([FRAME[0], FRAME[1]], layout));
    assert.deepEqual(events, [null]);
  });

  it('does not hit-test context land', () => {
    const { view, events, layout } = setup();
    // Centre of the context square: inside context, outside own land.
    view.svg.dispatch('click', toClient([FRAME[0] + 2_500, FRAME[1] + 2_500], layout));
    assert.ok(events.every((e) => e === null || !('code' in e) || e.code !== 'mg'));
    assert.ok(!events.some((e) => e && e.code === 'mg'));
  });

  it('ignores taps when not interactive, before layout, and after destroy', () => {
    const { view, events, layout } = setup();
    view.render({ ...baseInput, interactive: false });
    view.svg.dispatch('click', toClient(geometry.entries.za.label, layout));
    view.render({ ...baseInput, interactive: true });
    view.svg.rect = { width: 0, height: 0 };
    view.svg.dispatch('click', toClient(geometry.entries.za.label, layout));
    layOut(view.svg);
    view.destroy();
    view.svg.dispatch('click', toClient(geometry.entries.za.label, layout));
    assert.deepEqual(events, []);
  });
});
