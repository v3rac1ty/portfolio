const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const main = fs.readFileSync(path.join(__dirname, '../assets/js/main.js'), 'utf8');
const themeSource = main.slice(main.indexOf('  (function () {'), main.indexOf('  /* ===== Email ====='));
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture({ reduced = false, unsupported = false, throws = false, rejected = false,
  scrolled = false, fieldTop = 0 } = {}) {
  let theme = 'dark', click;
  const styles = new Map(), classes = new Set(), events = [], transitions = [];
  const root = {
    getAttribute: () => theme,
    setAttribute: (key, value) => { theme = value; },
    classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
    style: { setProperty: (key, value) => styles.set(key, value), removeProperty: key => styles.delete(key) }
  };
  const btn = { setAttribute() {}, addEventListener: (name, fn) => { click = fn; },
    getBoundingClientRect: () => ({ left: 1300, top: 12, width: 32, height: 32 }) };
  const field = { getBoundingClientRect: () => ({ top: fieldTop }) };
  const nav = { classList: { contains: name => name === 'scrolled' && scrolled },
    getBoundingClientRect: () => ({ bottom: 56 }) };
  const document = {
    documentElement: root,
    getElementById: id => ({ 'theme-toggle': btn, 'hero-canvas': field, 'site-nav': nav })[id] || null,
    querySelector: () => null,
    dispatchEvent: e => events.push(e.type),
    getAnimations: () => [{ animationName: theme === 'light' ? 'theme-wave' : 'theme-wave-retract' }]
  };
  if (!unsupported) document.startViewTransition = callback => {
    if (throws) throw new Error('unsupported capture');
    // These must exist before the new theme can be captured or displayed.
    assert.ok(classes.has('theme-switching'));
    assert.equal(styles.get('--theme-wave-x'), '1316px');
    assert.equal(styles.get('--theme-wave-y'), '28px');
    let finish;
    const transition = { ready: rejected ? Promise.reject(new Error('capture skipped')) : Promise.resolve(),
      finished: new Promise(resolve => { finish = resolve; }), skipTransition: () => finish(), finish: () => finish() };
    callback();
    transitions.push(transition);
    return transition;
  };
  vm.runInNewContext(themeSource, { document, Event, CustomEvent,
    localStorage: { setItem() {} }, window: { matchMedia: () => ({ matches: reduced }) },
    innerWidth: 1440, innerHeight: 900 });
  return { click: () => click(), theme: () => theme, styles, classes, events, transitions };
}

test('wave setup precedes the theme swap, ignores overlapping clicks, and cleans up after completion', async () => {
  const f = fixture();
  f.click(); f.click(); f.click();
  assert.equal(f.theme(), 'light');
  assert.equal(f.transitions.length, 1);
  assert.ok(f.classes.has('theme-wave-expand'));
  assert.equal(f.classes.has('theme-wave-retract'), false);
  assert.deepEqual(f.events, ['themetransitionstart', 'themechange']);
  f.transitions[0].finish();
  await flush();
  assert.equal(f.styles.size, 0);
  assert.equal(f.classes.size, 0);
  assert.equal(f.events.at(-1), 'themetransitionend');
  f.click();
  assert.equal(f.theme(), 'dark');
  assert.equal(f.transitions.length, 2);
  assert.ok(f.classes.has('theme-wave-retract'));
  assert.equal(f.classes.has('theme-wave-expand'), false);
  f.transitions[1].finish();
  await flush();
});

test('CSS expands the new light view and retracts the old light view over live dark content', () => {
  const css = fs.readFileSync(path.join(__dirname, '../assets/css/main.css'), 'utf8');
  assert.match(css, /\.theme-wave-expand::view-transition-new\(root\)\{[^}]*animation:theme-wave /);
  assert.match(css, /\.theme-wave-retract::view-transition-old\(root\)\{[^}]*animation:theme-wave-retract /);
  assert.match(css, /@keyframes theme-wave-retract\{\s*from\{clip-path:circle\(var\(--theme-wave-radius\)/);
  assert.match(css, /@keyframes theme-wave-retract\{[\s\S]*?to\{clip-path:circle\(0px/);
  const captureRule = css.match(/\.theme-switching \*::after\{([^}]+)\}/);
  assert.ok(captureRule);
  assert.doesNotMatch(captureRule[1], /animation-play-state/);
  assert.match(css, /\.theme-switching #hero-canvas\{view-transition-name:comet-field\}/);
  assert.match(css, /::view-transition-old\(comet-field\)\{display:none\}/);
  assert.match(css, /::view-transition-new\(comet-field\)\{animation:none/);
  assert.match(css, /clip-path:inset\(var\(--comet-nav-inset,0px\) 0 0 0\)/);
});

test('transparent top header leaves the live canvas unmasked in both theme directions', async () => {
  for (const options of [{}, { fieldTop: -15 }]) {
    const f = fixture(options);
    for (let i = 0; i < 2; i++) {
      f.click();
      assert.equal(f.styles.get('--comet-nav-inset'), '0px');
      f.transitions[i].finish();
      await flush();
      assert.equal(f.styles.size, 0);
    }
  }
});

test('scrolled header masks only the live canvas under its opaque surface', async () => {
  const f = fixture({ scrolled: true, fieldTop: -200 });
  for (let i = 0; i < 2; i++) {
    f.click();
    assert.equal(f.styles.get('--comet-nav-inset'), '256px');
    f.transitions[i].finish();
    await flush();
    assert.equal(f.styles.size, 0);
  }
});

test('skipped captures release the lock and mask settings', async () => {
  const f = fixture({ rejected: true });
  f.click();
  await flush();
  assert.equal(f.theme(), 'light');
  assert.equal(f.classes.size, 0);
  assert.equal(f.styles.size, 0);
  f.click();
  await flush();
  assert.equal(f.theme(), 'dark');
});

test('reduced motion, unsupported browsers and synchronous errors still switch themes', async () => {
  for (const options of [{ reduced: true }, { unsupported: true }, { throws: true }]) {
    const f = fixture(options);
    f.click();
    assert.equal(f.theme(), 'light');
    assert.equal(f.classes.size, 0);
    assert.equal(f.styles.size, 0);
    f.click();
    assert.equal(f.theme(), 'dark');
  }
});
