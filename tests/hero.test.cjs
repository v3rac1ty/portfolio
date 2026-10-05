/* Dependency-free regression checks against the actual engine source. The VM exposes
   private state only in this test; the shipped page needs no debug globals or hooks. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../assets/js/hero.js'), 'utf8');

function fixture({ reduced = true, width = 1440 } = {}) {
  const stats = { resets: 0, draws: 0, cancelled: 0 };
  const events = new Map();
  let now = 0;
  let theme = 'dark';
  const context2d = new Proxy({
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    drawImage: () => stats.draws++
  }, { get(target, key) { return key in target ? target[key] : () => {}; } });
  const hero = { offsetWidth: width, offsetHeight: 900,
    getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 900 }) };
  function canvas(id = '') {
    return { id, getContext: () => context2d,
      set width(value) { this.w = value; if (id) stats.resets++; }, get width() { return this.w; },
      set height(value) { this.h = value; if (id) stats.resets++; }, get height() { return this.h; } };
  }
  const heroCanvas = canvas('hero-canvas');
  const document = {
    hidden: false,
    documentElement: { getAttribute: () => theme },
    getElementById: id => id === 'hero-canvas' ? heroCanvas : hero,
    createElement: () => canvas(),
    querySelectorAll: () => [],
    addEventListener(name, fn) {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(fn);
    }
  };
  class Observer { observe() {} }
  const sandbox = {
    document,
    window: { innerWidth: width, innerHeight: 900,
      matchMedia: () => ({ matches: reduced }), addEventListener() {}, ResizeObserver: Observer },
    IntersectionObserver: Observer, ResizeObserver: Observer,
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => stats.cancelled++,
    performance: { now: () => now }, setTimeout() {},
    getComputedStyle: () => ({ color: 'rgb(255, 255, 255)' })
  };
  const end = source.lastIndexOf('})();');
  assert.ok(end > 0);
  vm.runInNewContext(source.slice(0, end) + `
    globalThis.engine = { particles, ghosts, trailPool, headSprites, inkCache, mergers,
      acquireTrail, releaseTrail, resizeCanvas, TrailGhost, cacheInk, sweepHeadSprites,
      spawnBlackHole, registerCursorKill, animate, themeAt, waveEase, updateThemeWave,
      syncParticlePalettes, Particle, getGrid: () => gridBX };
  ` + source.slice(end), sandbox);
  return { engine: sandbox.engine, stats, hero, document,
    setTime(value) { now = value; },
    theme(value) { theme = value; this.emit('themechange'); },
    emit(name, detail) { for (const fn of events.get(name) || []) fn({ detail }); } };
}

test('unchanged resize preserves the bitmap and typed-array grid', () => {
  const { engine: e, stats } = fixture();
  const grid = e.getGrid(), resets = stats.resets;
  for (let i = 0; i < 20; i++) e.resizeCanvas();
  assert.equal(e.getGrid(), grid);
  assert.equal(stats.resets, resets);
});

test('a real resize rescales particles, live trails and ghost copies; equal grid sizes reuse buffers', () => {
  const { engine: e, hero } = fixture({ width: 1441 });
  const p = e.particles[0], x = p.x, tx = p.trail[0], grid = e.getGrid();
  const ghost = new e.TrailGhost(p), gx = ghost.trail[0];
  e.ghosts.push(ghost);
  hero.offsetWidth = 1442;
  e.resizeCanvas();
  assert.equal(e.getGrid(), grid);
  assert.ok(Math.abs(p.x - x * 1442 / 1441) < 1e-8);
  assert.ok(Math.abs(p.trail[0] - tx * 1442 / 1441) < 0.001);
  assert.ok(Math.abs(ghost.trail[0] - gx * 1442 / 1441) < 0.001);
});

test('trail pool reuses buffers, caps idle storage, and ghosts never alias live trails', () => {
  const { engine: e } = fixture();
  const buffer = e.acquireTrail();
  e.releaseTrail(buffer);
  assert.equal(e.acquireTrail(), buffer);
  const p = e.particles[0], ghost = new e.TrailGhost(p), original = ghost.trail[0];
  p.trail[0] += 100;
  assert.notEqual(ghost.trail, p.trail);
  assert.equal(ghost.trail[0], original);
  for (let i = 0; i < 100; i++) e.releaseTrail(new Float32Array(64));
  assert.equal(e.trailPool.length, 32);
});

test('fully transparent comets skip drawing but retain their simulation state', () => {
  const { engine: e, stats } = fixture();
  const p = e.particles[0];
  p.age = 0;
  const before = stats.draws;
  p.draw();
  assert.equal(stats.draws, before);
  assert.equal(p.alive, true);
});

test('the live loop recycles dead trails and releases expired ghost storage', () => {
  const { engine: e } = fixture({ reduced: false });
  const p = e.particles[0], buffer = p.trail;
  const ghost = new e.TrailGhost(p), ghostBuffer = ghost.trail;
  ghost.age = ghost.maxLife;
  e.ghosts.push(ghost);
  p.alive = false;
  e.animate(16);
  assert.ok(e.particles.some(p => p.trail === buffer));
  assert.equal(e.ghosts.includes(ghost), false);
  assert.ok(e.trailPool.includes(ghostBuffer));
  assert.ok(e.particles.every(p => p.trail !== ghostBuffer));
});

test('sprite sweeping retains invisible live owners and releases obsolete theme canvases', () => {
  const f = fixture(), e = f.engine, old = e.particles[0].sprite;
  e.particles[0].age = 0;
  e.sweepHeadSprites();
  assert.ok([...e.headSprites.values()].includes(old));
  f.theme('light');
  assert.ok([...e.headSprites.keys()].every(key => key.startsWith('l')));
  assert.ok(![...e.headSprites.values()].includes(old));
  for (const p of e.particles) assert.ok([...e.headSprites.values()].includes(p.sprite));
});

test('glyph measurement cache stays bounded through fluid font-size changes', () => {
  const { engine: e } = fixture();
  for (let i = 0; i < 2000; i++) e.cacheInk('font-' + i, { w: 10 });
  assert.equal(e.inkCache.size, 512);
  assert.equal(e.inkCache.has('font-0'), false);
  assert.equal(e.inkCache.has('font-1999'), true);
});

test('color waves never cancel the running comet animation', () => {
  const f = fixture({ reduced: false });
  f.emit('themetransitionstart');
  f.theme('light');
  f.emit('themetransitionend');
  assert.equal(f.stats.cancelled, 0);
  f.document.hidden = true;
  f.emit('visibilitychange');
  assert.equal(f.stats.cancelled, 1);
});

test('expanding wave changes nearby comets first, leaves distant comets amber, and follows moving positions', () => {
  const f = fixture({ reduced: false }), e = f.engine;
  const near = e.particles[0], far = e.particles[1];
  near.x = 150; near.y = 150;
  far.x = 1300; far.y = 800;
  f.emit('themetransitionstart', { from: 'dark', to: 'light', x: 100, y: 100, radius: 1800 });
  f.theme('light');
  assert.equal(near.light, false);
  assert.equal(far.light, false);
  let progress = 0.1;
  f.emit('themewaveready', { animation: { effect: { getComputedTiming: () => ({ progress }) } } });
  e.animate(16);   // production frame loop must advance the wave, not just a test helper
  assert.equal(near.light, true);
  assert.equal(far.light, false);
  assert.equal(new e.Particle(150,150).light, true);
  assert.equal(new e.Particle(1300,800).light, false);
  near.x = 1300; near.y = 800;
  e.syncParticlePalettes();
  assert.equal(near.light, false);
  progress = 1;
  e.updateThemeWave(); e.syncParticlePalettes();
  assert.equal(far.light, true);
  f.emit('themetransitionend');
  assert.ok(e.particles.every(p => p.light));
  assert.ok([...e.headSprites.keys()].every(key => key.startsWith('l')));
});

test('retracting wave preserves blue comets inside the light circle and recolours the outside amber', () => {
  const f = fixture({ reduced: false }), e = f.engine;
  f.theme('light');
  const near = e.particles[0], far = e.particles[1];
  near.x = 150; near.y = 150;
  far.x = 1300; far.y = 800;
  f.emit('themetransitionstart', { from: 'light', to: 'dark', x: 100, y: 100, radius: 1800 });
  f.theme('dark');
  assert.equal(near.light, true);
  assert.equal(far.light, true);
  f.emit('themewaveready', { animation: { effect: { getComputedTiming: () => ({ progress: 0.15 }) } } });
  e.updateThemeWave(); e.syncParticlePalettes();
  assert.equal(near.light, true);
  assert.equal(far.light, false);
  f.emit('themetransitionend');
  assert.ok(e.particles.every(p => !p.light));
});

test('wave palette coordinates account for a scrolled hero and skipped transitions settle immediately', () => {
  const f = fixture({ reduced: false }), e = f.engine;
  f.hero.getBoundingClientRect = () => ({ left: 0, top: -300, bottom: 600 });
  e.resizeCanvas();
  f.emit('themetransitionstart', { from: 'dark', to: 'light', x: 100, y: 100, radius: 1800 });
  f.theme('light');
  f.emit('themewaveready', { animation: { effect: { getComputedTiming: () => ({ progress: 0.1 }) } } });
  e.updateThemeWave();
  assert.equal(e.themeAt(150,450).light, true);
  assert.equal(e.themeAt(1300,800).light, false);
  f.emit('themetransitionend');
  assert.ok(e.particles.every(p => p.light));
  assert.equal(e.waveEase(0), 0);
  assert.equal(e.waveEase(1), 1);
});

test('only nearby, contemporaneous black holes combine; nearby late arrivals join', () => {
  const { engine: e } = fixture();
  const kill = (x, y) => e.registerCursorKill(e.spawnBlackHole(x, y, '255, 184, 0', 1));
  kill(100, 100); kill(110, 100); kill(120, 100);
  assert.equal(e.mergers.length, 1);
  assert.equal(e.mergers[0].n, 3);
  kill(115, 105);
  assert.equal(e.mergers[0].n, 4);
  kill(1000, 700);
  assert.equal(e.mergers[0].n, 4);
});

test('distant or expired black-hole kills do not create a merger', () => {
  const f = fixture(), e = f.engine;
  const kill = (x, y) => e.registerCursorKill(e.spawnBlackHole(x, y, '255, 184, 0', 1));
  kill(50, 50); kill(500, 500); kill(1000, 700);
  assert.equal(e.mergers.length, 0);
  f.setTime(1000); kill(100, 100);
  f.setTime(2000); kill(105, 100);
  f.setTime(3000); kill(110, 100);
  assert.equal(e.mergers.length, 0);
});
