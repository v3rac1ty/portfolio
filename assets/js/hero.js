/* Hero comet field: cursor gravity, momentum-conserving collisions, a tiered particle-effect
   system, and the hero copy as static collision geometry.
   Write-up: projects/portfolio-particle-engine.md */
(function () {
  'use strict';

  /* Coalesce high-frequency events (scroll/resize) down to one call per frame.
     Scroll can fire several times per frame, and these handlers read layout via
     getBoundingClientRect - running them per event forces repeated synchronous
     layout and is the main source of scroll jank. */
  function rafThrottle(fn) {
    var queued = false;
    return function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; fn(); });
    };
  }
  const canvas = document.getElementById('hero-canvas');
  if (!canvas || !canvas.getContext) return;
  const ctx    = canvas.getContext('2d');
  // Reduced motion gets one still frame of the field instead of the animation loop.
  const reducedMotion = window.matchMedia &&
                        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Theme-dependent colours. main.js sets <html data-theme> and dispatches 'themechange';
  // comets are repainted in place on a switch, so the field never resets.
  const THEMES = {
    dark:  { light: false, dot: '#ffffff', ink: '255, 255, 255', hot: '#ffffff', void: '#020202', line: 'rgb(255, 184, 0)' },
    light: { light: true,  dot: '#1e293b', ink: '15, 23, 42',    hot: '#0b1e5b', void: '#0b1020', line: 'rgb(29, 78, 216)' },
  };
  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? THEMES.light : THEMES.dark;
  }
  let theme = currentTheme();

  let W = 0, H = 0;
  let mouseX = -9999, mouseY = -9999;
  let scrollOpacity = 1;

  // Accent is 255,184,0 - each comet picks its own shade around it (see Particle)
  // Population scales with the hero's area so a phone does not inherit a desktop-density
  // field and a large display does not look empty. Resolved once, at first layout:
  // recomputing it mid-resize would mean mass spawns and deaths on every drag of the
  // window edge, which is exactly the churn the rescaling below exists to avoid.
  const AREA_PER_COMET = 16000;          // px^2 of hero per comet
  const MIN_COMETS     = 26;             // floor, so a small phone still has a field
  const MAX_COMETS     = 130;            // ceiling; 160 benchmarked at 90% frame headroom
  let   MAX            = 0;              // set by resizeCanvas on its first run
  // Area sizes the field, but area says nothing about how fast the machine drawing it
  // is - the same hero costs very different amounts on a discrete GPU and on integrated
  // graphics. So the population is also governed by measured frame pacing: if frames
  // consistently run long, comets stop being replaced as they leave until the field is
  // light enough to keep pace, and it refills once there is headroom again.
  // The yardstick is the shortest interval ever seen rather than a fixed 16.7ms, so a
  // 30Hz or 120Hz display calibrates itself instead of being judged against 60Hz.
  const PERF_WINDOW  = 60;               // frames per decision
  const PERF_SHED_AT = 1.55;             // over baseline -> struggling
  const PERF_RECOVER = 1.18;             // under baseline -> room to spare
  const PERF_STEP    = 8;                // comets added or removed per decision
  let   perfBase     = Infinity;
  let   perfSum      = 0;
  let   perfCount    = 0;
  let   liveMax      = 0;                // population target now, never above MAX
  const TRAIL_LEN   = 32;
  // Trails are stroked as a polyline through TRAIL_LEN recorded points, but a comet
  // drifting at START_SPEED lays those 32 points down inside about 8px - so the stroke
  // spends 31 segments redrawing what is visually one short dash. Points closer together
  // than this are folded into the previous one, which at these line widths is not a
  // visible difference and cuts most of the trail geometry in the common (slow) case.
  // The newest point is always kept, so the trail still reaches the comet exactly.
  const TRAIL_MIN2  = 2.25;              // 1.5px, squared
  const MOUSE_R     = 560;
  const MOUSE_R2    = MOUSE_R * MOUSE_R;
  const LINE_R      = 420;
  const LINE_R2     = LINE_R * LINE_R;
  // Inverse-square attraction: slow comets fall into orbit, and anything the cursor
  // whips past escape velocity keeps its speed and leaves the field for good.
  const GRAV        = 2200;
  const MAX_SPEED   = 4.5;               // ceiling so repeated slingshots can't launch comets
  const MAX_SPEED2  = MAX_SPEED * MAX_SPEED;
  const MASS_REF_R  = 3.5;
  const START_SPEED = 0.26;              // comets drift in slowly - only the cursor speeds them up
  const EDGE_MARGIN = 60;                // comets live until they cross this far past an edge
  const GRID_STEP   = 36;
  const GRID_BEND   = 48000;
  const GRID_SOFT2  = 55 * 55;           // pre-squared softening constant
  const GRID_DEFR2  = 320 * 320;         // skip deformation beyond this dist²
  const GRID_BUCKETS = 64;               // higher bucket count = smoother twinkle transitions
  const MAX_SPARKS  = 100;  // denser field means more comets reaching the cursor
  const EXPLOSION_COOLDOWN_MS = 45;
  const particles   = [];
  const explosions  = [];
  const crits       = [];   // critical-hit shockwaves, capped at MAX_CRITS
  const bounces     = [];   // ordinary-collision sparks, capped at MAX_BOUNCES
  const shards      = [];   // critical-death fragments, capped at MAX_SHARDS
  const blackHoles  = [];   // cursor-kill voids, capped at MAX_BLACKHOLES
  const mergers     = [];   // multi-kill merger events, capped at MAX_MERGERS
  const ghosts      = [];   // fading trail remnants left behind by any death, capped at MAX_GHOSTS
  let lastExplosionAt = -1e9;
  // Star grid as flat typed arrays (struct of arrays): no per-dot objects, and the
  // per-frame loop reads contiguous memory
  let   gridN       = 0;
  let   gridBX      = new Float32Array(0);
  let   gridBY      = new Float32Array(0);
  let   gridPhase   = new Float32Array(0);
  let   gridFreq    = new Float32Array(0);
  let   gridPosA    = new Float32Array(0);   // static bottom-fade factor per dot
  // Pre-allocated grid render buffers (no per-frame GC).
  // Dots are grouped by alpha bucket via a counting sort so each bucket needs only
  // one fill(). The buffers are sized to the dot count, not buckets x dots - the old
  // layout reserved a worst-case slot for every dot in every bucket, which at desktop
  // size meant ~600 KB held permanently to store ~1200 positions.
  let   gridPos     = new Float32Array(0);   // x,y per dot, in dot order
  let   gridBucket  = new Uint8Array(0);     // alpha bucket per dot (GRID_BUCKETS <= 256)
  let   gridOrder   = new Int32Array(0);     // dot indices sorted by bucket
  const bucketCount = new Int32Array(GRID_BUCKETS);
  const bucketStart = new Int32Array(GRID_BUCKETS);

  // Spark (explosion fragment) - tinted to match the comet that popped, rather than
  // a generic white flash, so the burst reads as that comet breaking apart.
  // `boost` scales speed/size/life up for the bigger critical-death variant below;
  // omitted (1) it is the ordinary pop.
  function Spark(x, y, rgb, boost) {
    boost = boost || 1;
    const a = Math.random() * Math.PI * 2;
    const s = (1.2 + Math.random() * 2.8) * boost;
    this.x = x; this.y = y;
    this.vx = Math.cos(a) * s;
    this.vy = Math.sin(a) * s;
    this.r       = (0.8 + Math.random() * 1.4) * Math.sqrt(boost);
    this.maxLife = (220 + Math.random() * 180) * (1 + (boost - 1) * 0.25);
    this.age     = 0;
    this.alive   = true;
    this.fillCol = `rgba(${rgb || '255, 255, 255'},`;   // cached prefix, see Particle
    this.solid   = this.fillCol + '1)';
  }
  Spark.prototype.update = function (dt) {
    this.age += dt;
    if (this.age >= this.maxLife) { this.alive = false; return; }
    this.vx *= 0.91; this.vy *= 0.91;
    this.x += this.vx; this.y += this.vy;
  };
  Spark.prototype.draw = function () {
    const c = ctx;
    const t = 1 - this.age / this.maxLife;
    c.globalAlpha = t * t * 0.92 * scrollOpacity;
    c.fillStyle   = this.solid;
    c.beginPath();
    c.arc(this.x, this.y, this.r * t, 0, Math.PI * 2);
    c.fill();
  };

  // `big` is the amplified burst used when a critical hit is also the killing blow -
  // more fragments, thrown harder, so a critical-death pop is visibly bigger than an
  // ordinary one instead of looking identical to it.
  // `sizeF` is the dying comet's mass (r / MASS_REF_R, so ~0.57-1.43): a big comet
  // breaks into more and larger fragments than a small one, so the pop reads as the
  // size of the thing that just died.
  function spawnExplosion(x, y, rgb, big, sizeF) {
    const now = performance.now();
    if (now - lastExplosionAt < EXPLOSION_COOLDOWN_MS) return;
    lastExplosionAt = now;

    const slots = MAX_SPARKS - explosions.length;
    if (slots <= 0) return;

    const size  = sizeF || 1;
    const base  = big ? 9 : 4;
    const range = big ? 5 : 3;
    const raw   = (base + Math.floor(Math.random() * range)) * size;
    const n     = Math.min(slots, Math.max(2, Math.round(raw)));
    const boost = (big ? 1.6 : 1) * size;
    for (let i = 0; i < n; i++) explosions.push(new Spark(x, y, rgb, boost));
  }

  // Critical-hit burst: a hit landing on an already-cracked spot. Reads as a sharp
  // shockwave rather than the soft spray of a normal pop - an expanding ring, radial
  // shards thrown off the fracture, and a white-hot core flash at the moment of impact.
  // `big` is the critical-DEATH variant (the crit that finished the comet off): a
  // second, delayed ring, more shards, and a wider flash - visibly heavier than the
  // small non-lethal version so a killing crit reads as a distinct event.
  // `sizeF` is the comet's mass, so the shockwave from a large comet is wider than
  // one from a small comet even at the same tier.
  function CritBurst(x, y, rgb, big, sizeF) {
    this.x = x; this.y = y;
    this.age     = 0;
    this.big     = !!big;
    this.maxLife = this.big ? 700 : 400;
    this.alive   = true;
    this.col     = `rgba(${rgb || '255, 255, 255'},`;
    this.solid   = this.col + '1)';
    this.spin    = Math.random() * Math.PI * 2;   // shards point somewhere new each time
    this.scale   = (this.big ? 1.7 : 1) * (sizeF || 1);
  }
  CritBurst.prototype.update = function (dt) {
    this.age += dt;
    if (this.age >= this.maxLife) this.alive = false;
  };
  CritBurst.prototype.draw = function () {
    const c = ctx;
    const t     = this.age / this.maxLife;    // 0 -> 1
    const fade  = (1 - t) * (1 - t);
    const scale = this.scale;                 // tier x comet size, baked at spawn
    const R     = (3 + t * 21) * scale;
    const col   = this.solid;

    // Shockwave ring
    c.globalAlpha = fade * scrollOpacity;
    c.strokeStyle = col;
    c.lineWidth   = Math.max(0.4, (this.big ? 3.2 : 2.4) * (1 - t));
    c.beginPath();
    c.arc(this.x, this.y, R, 0, Math.PI * 2);
    c.stroke();

    // Second, trailing ring - only on a critical death, gives it visible weight
    // beyond just being a scaled-up copy of the small burst
    if (this.big) {
      const t2 = Math.max(0, t - 0.18);
      const R2 = (3 + t2 * 21) * scale * 0.72;
      c.globalAlpha = fade * 0.7 * scrollOpacity;
      c.lineWidth   = Math.max(0.4, 2.2 * (1 - t));
      c.beginPath();
      c.arc(this.x, this.y, R2, 0, Math.PI * 2);
      c.stroke();
    }

    // Radial shards flung off the fracture
    const shardCount = this.big ? 8 : 5;
    const inner = R * 0.55, outer = R * 1.35;
    c.globalAlpha = fade * 0.85 * scrollOpacity;
    c.lineWidth   = Math.max(0.4, (this.big ? 2.1 : 1.6) * (1 - t));
    c.beginPath();
    for (let i = 0; i < shardCount; i++) {
      const ang = this.spin + (i / shardCount) * Math.PI * 2;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      c.moveTo(this.x + ca * inner, this.y + sa * inner);
      c.lineTo(this.x + ca * outer, this.y + sa * outer);
    }
    c.stroke();

    // White-hot core, only at the instant of impact
    const coreCut = this.big ? 0.45 : 0.35;
    if (t < coreCut) {
      const ct = 1 - t / coreCut;
      c.globalAlpha = ct * ct * 0.95 * scrollOpacity;
      c.fillStyle   = theme.hot;
      c.beginPath();
      c.arc(this.x, this.y, (this.big ? 2.4 : 1.5) + ct * (this.big ? 5.5 : 3.5), 0, Math.PI * 2);
      c.fill();
    }
  };

  function spawnCrit(x, y, rgb, big, sizeF) {
    if (crits.length >= MAX_CRITS) return;
    crits.push(new CritBurst(x, y, rgb, big, sizeF));
  }

  // Death by collision with another comet: the ordinary pop plus the small shockwave.
  // Being destroyed by an impact should look like an impact, not like the quiet pop a
  // comet gets from touching the cursor.
  function spawnCometDeath(x, y, rgb, sizeF) {
    spawnExplosion(x, y, rgb, false, sizeF);
    spawnCrit(x, y, rgb, false, sizeF);
  }

  // Shard: a jagged fragment of the comet itself, flung outward and tumbling as it
  // goes - triangular rather than a round dot, so a burst of these reads as broken
  // pieces instead of just more sparks. Reserved for a critical death, so shattering
  // stays a distinct, rarer sight rather than the default way any comet pops.
  function Shard(x, y, rgb) {
    const a = Math.random() * Math.PI * 2;
    const s = 1.6 + Math.random() * 3.6;
    this.x = x; this.y = y;
    this.vx = Math.cos(a) * s;
    this.vy = Math.sin(a) * s;
    this.rot     = Math.random() * Math.PI * 2;
    this.spin    = (Math.random() - 0.5) * 0.5;   // radians/frame - tumble, not spin-in-place
    this.size    = 1.7 + Math.random() * 2.6;
    this.stretch = 0.5 + Math.random() * 0.9;     // elongation - keeps triangles irregular
    this.maxLife = 380 + Math.random() * 280;
    this.age     = 0;
    this.alive   = true;
    this.fillCol = `rgba(${rgb || '255, 255, 255'},`;
    this.solid   = this.fillCol + '1)';
  }
  Shard.prototype.update = function (dt) {
    this.age += dt;
    if (this.age >= this.maxLife) { this.alive = false; return; }
    this.vx *= 0.94; this.vy *= 0.94;
    this.x  += this.vx; this.y += this.vy;
    this.rot += this.spin;
  };
  Shard.prototype.draw = function () {
    const t = 1 - this.age / this.maxLife;
    const s = this.size * t;
    ctx.globalAlpha = t * t * 0.95 * scrollOpacity;
    ctx.fillStyle   = this.solid;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rot);
    ctx.beginPath();
    ctx.moveTo(0, -s * (1 + this.stretch));
    ctx.lineTo(s * 0.7, s * 0.6);
    ctx.lineTo(-s * 0.6, s * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };

  // Own array and cap so a shatter can never be thinned out by an unrelated pop's
  // MAX_SPARKS budget or explosion cooldown - a critical death is rare enough that it
  // should always render at full force.
  function spawnShatter(x, y, rgb, sizeF) {
    const size = sizeF || 1;
    const want = Math.round((9 + Math.random() * 5) * size);
    const n    = Math.min(want, MAX_SHARDS - shards.length);
    for (let i = 0; i < n; i++) shards.push(new Shard(x, y, rgb));
  }

  // Critical-hit death: the comet shatters rather than pops - jagged fragments instead
  // of the round spark spray, plus the big shockwave ring for the impact itself. The
  // heaviest, most visually distinct event in the field.
  function spawnCritDeath(x, y, rgb, sizeF) {
    spawnShatter(x, y, rgb, sizeF);
    spawnCrit(x, y, rgb, true, sizeF);
  }

  // Midpoint colour of the two comets involved - a bounce belongs to the contact,
  // not to either comet individually, so it should not read as favouring one side.
  function blendRgb(rgbA, rgbB) {
    const a = rgbA.split(',');
    const b = rgbB.split(',');
    return `${(+a[0] + +b[0]) >> 1}, ${(+a[1] + +b[1]) >> 1}, ${(+a[2] + +b[2]) >> 1}`;
  }

  // Bounce: the smallest of the collision effects and by far the most common, so it
  // has to stay quiet. Same spark spray as a cursor kill, just a handful of fragments
  // at roughly half the throw - a scaled-down version of an effect already in the
  // field rather than a shockwave ring, which read as far too loud for a routine
  // knock. Sparks live in their own array so a busy cluster of bounces can never
  // crowd death pops out of the shared MAX_SPARKS budget.
  // `sizeF` is the pair's mean mass, `force` the impact speed over MAX_SPEED.
  // Capacity is clamped, not all-or-nothing: the array can run near-full for stretches
  // when the cursor is holding a crowd together, and rejecting the whole spawn just
  // because the full request did not fit meant bounces silently stopped appearing for
  // as long as that held. A partial spray still reads as a bounce; zero sparks does not.
  const BOUNCE_BOOST = 0.45;   // fraction of a cursor-kill pop's throw
  function spawnBounce(x, y, rgbA, rgbB, sizeF, force) {
    const size = sizeF || 1;
    const f    = Math.min(1, force || 0);
    const want = Math.max(2, Math.min(5, Math.round((2 + f * 2) * size)));
    const n    = Math.min(want, MAX_BOUNCES - bounces.length);
    if (n <= 0) return;

    const rgb   = blendRgb(rgbA, rgbB);
    const boost = BOUNCE_BOOST * (0.8 + 0.5 * f) * size;
    for (let i = 0; i < n; i++) bounces.push(new Spark(x, y, rgb, boost));
  }

  // Black hole: the cursor's pull has been an inverse-square gravity field from the
  // start, so a comet reaching the kill radius should look consumed, not popped. The
  // shadow is filled with the theme's void colour (a black hole is dark in either theme),
  // and it does not persist: the canvas clears next frame, so the void redraws at its new
  // (shrinking) radius each frame rather than leaving a permanent hole. If enough comets
  // are eaten at once, a Merger adopts these same holes instead of letting them collapse.
  function BlackHole(x, y, rgb, sizeF) {
    this.x = x; this.y = y;
    this.age     = 0;
    this.maxLife = 380;
    this.alive   = true;
    this.rgb     = rgb || '255, 255, 255';
    this.col     = `rgba(${this.rgb},`;
    this.solid   = this.col + '1)';
    this.scale   = sizeF || 1;   // the swallowed comet's mass
    this.spin0   = Math.random() * Math.PI * 2;
  }
  BlackHole.prototype.update = function (dt) {
    this.age += dt;
    if (this.age >= this.maxLife) this.alive = false;
  };
  // Current size as a fraction of the full horizon: opens fast, holds briefly, then
  // collapses to a point - not a symmetric balloon.
  BlackHole.prototype.size = function () {
    const t        = this.age / this.maxLife;
    const open     = Math.min(1, t / 0.22);
    const openEase = open * open * (3 - 2 * open);
    const collapse = t < 0.55 ? 1 : Math.max(0, 1 - (t - 0.55) / 0.45);
    return openEase * collapse * collapse;
  };
  BlackHole.prototype.draw = function () {
    const t = this.age / this.maxLife;   // 0 -> 1
    const R = horizonR(this.scale) * this.size();

    if (R > 0.2) {
      ctx.globalAlpha = scrollOpacity;
      ctx.fillStyle   = theme.void;
      ctx.beginPath();
      ctx.arc(this.x, this.y, R, 0, Math.PI * 2);
      ctx.fill();
    }

    // Accretion rim hugging the void's edge
    const fade = 1 - t;
    ctx.globalAlpha = fade * scrollOpacity;
    ctx.strokeStyle = this.solid;
    ctx.lineWidth   = Math.max(0.5, 2 * (1 - t * 0.6));
    ctx.beginPath();
    ctx.arc(this.x, this.y, R + 1, 0, Math.PI * 2);
    ctx.stroke();

    // Two short arcs orbiting the rim - reads as disk motion, not a static ring
    const spin = this.spin0 + t * 9;
    ctx.lineWidth = Math.max(0.4, 1.3 * (1 - t));
    for (let i = 0; i < 2; i++) {
      const a0 = spin + i * Math.PI;
      ctx.beginPath();
      ctx.arc(this.x, this.y, (R + 1) * 1.4, a0, a0 + 1.1);
      ctx.stroke();
    }
  };
  // Always returns the hole, even past the draw cap, so a merger can still adopt it.
  function spawnBlackHole(x, y, rgb, sizeF) {
    const bh = new BlackHole(x, y, rgb, sizeF);
    if (blackHoles.length < MAX_BLACKHOLES) blackHoles.push(bh);
    return bh;
  }

  /* Black-hole merger: several comets swallowed by the cursor at once.
     The black holes those comets left behind are the bodies that merge - adopted where
     they were eaten, at the size they already had - rather than new ones appearing. A
     real binary black hole gives off almost no light, so nothing here explodes. It plays
     the sequence an observer would actually see:
       inspiral - the holes orbit their common centre of mass, every orbit shrinking as
                  (1 - t/T)^(1/4) while the shared angular speed rises as radius^(-3/2):
                  the chirp
       waves    - quadrupole radiation, a two-armed spiral leaving at a finite speed; the
                  pattern at radius r carries the orbital phase from the retarded time
                  t - r/c, which is what winds it into a spiral
       merger   - the horizons join into one remnant with ~5% less mass than they had
                  together (that mass left as gravitational waves); horizon size follows
                  mass, so the remnant is the same size law applied to the combined mass
       ringdown - the remnant's shape wobbles and settles exponentially, and it drifts off
                  on a small recoil kick before collapsing like any other cursor kill
     drawGrid adds gravitational lensing (background stars bent outward into an Einstein
     ring around each horizon) and the strain of the passing waves, which also stretch and
     squeeze nearby comets. */
  let mergerSeq = 0;
  // Horizon radius for a given swallowed mass. The same law sizes a single cursor kill,
  // so an adopted hole keeps its size, and radius grows linearly with mass like a real
  // (Schwarzschild) horizon.
  function horizonR(m) { return 2.5 + 9 * m; }
  // Quadrupole pattern: crests at φ and φ + π, troughs halfway between
  const WAVE_ARM_OFFSETS = [0, Math.PI, Math.PI * 0.5, Math.PI * 1.5];
  const MERGER_SETTLE_MS = 160;   // an adopted hole eases into its orbit over this long

  function Merger(holes) {
    this.id       = ++mergerSeq;
    this.age      = 0;
    this.alive    = true;
    this.phase    = Math.random() * Math.PI * 2;
    this.dir      = Math.random() < 0.5 ? 1 : -1;   // orbit sense
    this.omega    = MERGER_W0;
    this.amp      = 0;
    this.shrink   = 1;      // common orbital scale, (1 - t/T)^(1/4)
    this.merged   = false;
    this.vx = 0; this.vy = 0;                        // recoil drift after merger, px/ms
    // Sized here, not at load: the MERGER_* constants are declared further down the file
    this.histLen   = Math.ceil((MERGER_INSPIRAL + MERGER_RINGDOWN * 1.3) / MERGER_HIST_DT) + 4;
    this.histPhase = new Float32Array(this.histLen);
    this.histAmp   = new Float32Array(this.histLen);
    this.histN     = 0;
    this.wc = 1; this.ws = 0; this.wph = 0;          // last waveAt() phase, see there

    // Centre of mass of the holes being adopted
    let sx = 0, sy = 0, sm = 0;
    for (let i = 0; i < holes.length; i++) {
      sx += holes[i].x * holes[i].scale;
      sy += holes[i].y * holes[i].scale;
      sm += holes[i].scale;
    }
    this.x = sx / sm; this.y = sy / sm;
    this.col = `rgba(${blendRgb(holes[0].rgb, holes[holes.length - 1].rgb)},`;
    this.solid = this.col + '1)';

    this.bodies = [];
    this.mass   = 0;
    this.n      = 0;
    this.remnant = { x: this.x, y: this.y, R: 0, vis: 0 };
    for (let i = 0; i < holes.length; i++) this.adopt(holes[i]);
  }

  // Take over an existing cursor-kill hole as an orbiting body. It stays where it was
  // eaten and keeps its size. Holes eaten almost on top of one another are eased apart to
  // a touching orbit over MERGER_SETTLE_MS, as their mutual pull swings them round.
  Merger.prototype.adopt = function (bh) {
    const i = blackHoles.indexOf(bh);
    if (i >= 0) { blackHoles[i] = blackHoles[blackHoles.length - 1]; blackHoles.pop(); }
    const dx = bh.x - this.x, dy = bh.y - this.y;
    const d0 = Math.sqrt(dx * dx + dy * dy);
    const R  = horizonR(bh.scale);
    this.bodies.push({
      m: bh.scale, R: R, col: bh.solid,
      ang: Math.atan2(dy, dx) - this.phase * this.dir,   // angle in the rotating frame
      d0: d0, dOrbit: Math.max(d0, R * 0.9 + 4),
      born: this.age, vis0: bh.size(),
      x: bh.x, y: bh.y, vis: bh.size(),
    });
    this.mass += bh.scale;
    this.n++;
    // Strength and lifetime scale with how many comets went in
    const s      = Math.min(1, (this.n - MERGER_MIN_KILLS) / 5);   // 0 at the threshold, 1 at +5
    this.scale   = s;
    this.ampMax  = 0.75 + 0.5 * s;
    this.maxLife = MERGER_INSPIRAL + MERGER_RINGDOWN * (1 + 0.3 * s);
  };

  Merger.prototype.update = function (dt) {
    this.age += dt;
    if (this.age >= this.maxLife) { this.alive = false; return; }

    if (!this.merged) {
      const u     = Math.min(this.age / MERGER_INSPIRAL, 0.995);
      this.shrink = Math.pow(1 - u, 0.25);
      this.omega  = Math.min(MERGER_W_MAX, MERGER_W0 * Math.pow(1 / this.shrink, 1.5));
      this.amp    = this.ampMax * Math.pow(this.omega / MERGER_W_MAX, 2 / 3);   // h ∝ ω^(2/3)
      if (this.age >= MERGER_INSPIRAL) {
        this.merged = true;
        // Remnant: ~5% of the mass left as gravitational waves
        this.remnant.R = horizonR(0.95 * this.mass);
        // Recoil: radiation is emitted asymmetrically, so the remnant is kicked
        const k = Math.random() * Math.PI * 2, sp = 0.012 + 0.01 * this.scale;
        this.vx = Math.cos(k) * sp;
        this.vy = Math.sin(k) * sp;
      }
    } else {
      this.omega = MERGER_W_RING;
      this.amp   = this.ampMax * Math.exp(-(this.age - MERGER_INSPIRAL) / MERGER_RING_TAU);
      this.x += this.vx * dt;
      this.y += this.vy * dt;
    }
    const prevPhase = this.phase, prevAmp = this.prevAmp === undefined ? this.amp : this.prevAmp;
    this.phase  += this.omega * dt * this.dir;
    this.prevAmp = this.amp;

    // Frames (~16ms) are coarser than samples (MERGER_HIST_DT), so each sample is
    // interpolated between the previous frame and this one. Copying the frame's value
    // into every sample it covers turned the phase into a staircase, and the wave arms
    // into polygons with sharp corners.
    const age0 = this.age - dt;
    while (this.histN < this.histLen && this.histN * MERGER_HIST_DT <= this.age) {
      const u = dt > 0 ? Math.max(0, (this.histN * MERGER_HIST_DT - age0) / dt) : 1;
      this.histPhase[this.histN] = prevPhase + (this.phase - prevPhase) * u;
      this.histAmp[this.histN]   = prevAmp + (this.amp - prevAmp) * u;
      this.histN++;
    }

    // Body positions: each orbits the centre of mass at its own radius, all sharing the
    // binary's rotation and shrinking together.
    this.orbitR = 0;
    if (!this.merged) {
      for (let i = 0; i < this.bodies.length; i++) {
        const B = this.bodies[i];
        const e = Math.min(1, (this.age - B.born) / MERGER_SETTLE_MS);
        const ease = e * e * (3 - 2 * e);
        const d = (B.d0 + (B.dOrbit - B.d0) * ease) * this.shrink;
        const a = B.ang + this.phase * this.dir;
        B.x = this.x + Math.cos(a) * d;
        B.y = this.y + Math.sin(a) * d;
        B.vis = B.vis0 + (1 - B.vis0) * ease;
        if (d > this.orbitR) this.orbitR = d;
      }
    } else {
      const fadeOut = Math.min(1, (this.maxLife - this.age) / 400);
      this.remnant.x   = this.x;
      this.remnant.y   = this.y;
      this.remnant.vis = fadeOut * fadeOut;   // collapses at the end like any cursor kill
    }

    // Tides: a passing gravitational wave stretches space along one axis and squeezes it
    // along the other, so comets get radial nudges signed by cos 2(θ - φ). The pattern
    // averages to zero - the field rides the waves rather than being blown away.
    const front = this.age * MERGER_C, front2 = front * front;
    const k = dt / 16.667;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p.alive) continue;
      const dx = p.x - this.x, dy = p.y - this.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > front2 || d2 < 100) continue;
      const d = Math.sqrt(d2);
      const a = this.waveAt(d);
      if (a < 0.02) continue;
      const q = ((dx * dx - dy * dy) * this.wc + 2 * dx * dy * this.ws) / d2;   // cos 2(θ - φ)
      const nudge = MERGER_TIDE * a * q * k / Math.sqrt(Math.max(1, d / 60));
      p.vx += (dx / d) * nudge;
      p.vy += (dy / d) * nudge;
    }
  };

  // Strength of the wave arriving at radius r now. Its orbital phase φ is left in
  // this.wph, with cos 2φ and sin 2φ in this.wc / this.ws, so callers can evaluate
  // cos 2(θ - φ) as ((x² - y²)·wc + 2xy·ws) / r² without any trig per point.
  // Samples are interpolated linearly (the stored phase is accumulated, never wrapped),
  // so the arms stay smooth however finely they are traced.
  Merger.prototype.waveAt = function (r) {
    const tr = this.age - r / MERGER_C;
    if (tr < 0 || this.histN === 0) return 0;
    const f = tr / MERGER_HIST_DT;
    let i = f | 0, frac = f - i;
    if (i >= this.histN - 1) { i = this.histN - 1; frac = 0; }
    const ph = this.histPhase[i] + (frac ? (this.histPhase[i + 1] - this.histPhase[i]) * frac : 0);
    this.wph = ph;
    this.wc  = Math.cos(2 * ph);
    this.ws  = Math.sin(2 * ph);
    return frac ? this.histAmp[i] + (this.histAmp[i + 1] - this.histAmp[i]) * frac : this.histAmp[i];
  };

  // A horizon's dark shadow, deformed into an ellipse by `e` during the ringdown
  function fillShadow(x, y, R, e, rot, alpha) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle   = theme.void;
    ctx.beginPath();
    ctx.ellipse(x, y, R * (1 + e), R * (1 - e), rot, 0, Math.PI * 2);
    ctx.fill();
  }
  // The thin photon ring just outside a shadow
  function strokePhotonRing(x, y, R, e, rot, alpha, solid) {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = solid;
    ctx.lineWidth   = 1.2;
    ctx.beginPath();
    ctx.ellipse(x, y, R * 1.35 * (1 + e), R * 1.35 * (1 - e), rot, 0, Math.PI * 2);
    ctx.stroke();
  }

  Merger.prototype.draw = function () {
    const so      = scrollOpacity;
    const fadeOut = Math.min(1, (this.maxLife - this.age) / 400);

    // Gravitational waves: the crests of the quadrupole pattern (two arms, half a turn
    // apart) and, fainter, the troughs between them, traced from the binary out to the
    // wavefront. Strokes are chunked so each run carries its own alpha.
    const front = this.age * MERGER_C;
    const r0    = this.merged ? this.remnant.R * 1.6 : Math.max(8, this.orbitR * 0.8);
    if (front > r0) {
      ctx.strokeStyle = this.solid;
      ctx.lineCap     = 'round';
      const STEP = 3, CHUNK = 8;
      for (let arm = 0; arm < 4; arm++) {
        const crest = arm < 2;
        const off   = WAVE_ARM_OFFSETS[arm];
        const gain  = crest ? 0.85 : 0.28;
        ctx.lineWidth = crest ? 1.5 : 1;
        let acc = 0, cnt = 0, started = false;
        ctx.beginPath();
        for (let r = r0; r <= front; r += STEP) {
          const a  = this.waveAt(r);
          const th = this.wph + off;
          const x  = this.x + Math.cos(th) * r, y = this.y + Math.sin(th) * r;
          if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
          acc += a / Math.sqrt(Math.max(1, r / 50));
          if (++cnt === CHUNK) {
            ctx.globalAlpha = Math.min(1, gain * acc / cnt) * so * fadeOut;
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(x, y);
            acc = 0; cnt = 0;
          }
        }
        if (cnt) {
          ctx.globalAlpha = Math.min(1, gain * acc / cnt) * so * fadeOut;
          ctx.stroke();
        }
      }
    }

    if (!this.merged) {
      // All shadows first, then all photon rings, so a ring passing in front of another
      // hole's shadow stays visible as the two swing round each other
      for (let i = 0; i < this.bodies.length; i++) {
        const B = this.bodies[i];
        fillShadow(B.x, B.y, B.R * B.vis, 0, 0, so);
      }
      for (let i = 0; i < this.bodies.length; i++) {
        const B = this.bodies[i];
        strokePhotonRing(B.x, B.y, B.R * B.vis, 0, 0, so * 0.9, B.col);
      }
    } else {
      const tr = this.age - MERGER_INSPIRAL;
      const e  = 0.32 * Math.exp(-tr / MERGER_RING_TAU);   // ringdown deformation
      const R  = this.remnant.R * this.remnant.vis;
      if (R > 0.2) {
        fillShadow(this.x, this.y, R, e, this.phase, so);
        strokePhotonRing(this.x, this.y, R, e, this.phase, so * 0.9 * fadeOut, this.solid);
      }
      // The photon ring flares briefly as the horizons join, then settles
      if (tr < 260) {
        const f = 1 - tr / 260;
        ctx.globalAlpha = f * f * so;
        ctx.strokeStyle = this.solid;
        ctx.lineWidth   = 1 + 2 * f;
        ctx.beginPath();
        ctx.arc(this.x, this.y, R * (1.5 + 0.8 * (1 - f)), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  };

  // Every cursor kill reports its black hole here. Holes only merge if they are close
  // enough to touch: within MERGER_TOUCH x the sum of their horizon radii. A kill near a
  // young merger's bodies joins it; otherwise, once MERGER_MIN_KILLS holes inside
  // MERGER_WINDOW_MS form one connected cluster of touching holes, that cluster merges.
  // Holes eaten far apart (a cursor sweeping across the field) never merge.
  const MERGER_TOUCH = 1.25;
  function touching(ax, ay, aR, bx, by, bR) {
    const dx = ax - bx, dy = ay - by, lim = (aR + bR) * MERGER_TOUCH;
    return dx * dx + dy * dy <= lim * lim;
  }
  const recentKills = [];
  function registerCursorKill(bh) {
    const R = horizonR(bh.scale);
    for (let i = 0; i < mergers.length; i++) {
      const m = mergers[i];
      if (m.merged || m.age >= MERGER_INSPIRAL * 0.6) continue;
      for (let j = 0; j < m.bodies.length; j++) {
        const B = m.bodies[j];
        if (touching(bh.x, bh.y, R, B.x, B.y, B.R)) { m.adopt(bh); return; }
      }
    }
    const now = performance.now();
    recentKills.push({ t: now, hole: bh });
    while (recentKills.length && now - recentKills[0].t > MERGER_WINDOW_MS) recentKills.shift();
    if (recentKills.length < MERGER_MIN_KILLS || mergers.length >= MAX_MERGERS) return;

    // Grow the cluster of touching holes outward from the newest one
    const cluster = [bh];
    for (let grew = true; grew;) {
      grew = false;
      for (let i = 0; i < recentKills.length; i++) {
        const h = recentKills[i].hole;
        if (cluster.indexOf(h) !== -1) continue;
        for (let j = 0; j < cluster.length; j++) {
          const c = cluster[j];
          if (touching(h.x, h.y, horizonR(h.scale), c.x, c.y, horizonR(c.scale))) {
            cluster.push(h);
            grew = true;
            break;
          }
        }
      }
    }
    if (cluster.length < MERGER_MIN_KILLS) return;
    for (let i = recentKills.length - 1; i >= 0; i--) {
      if (cluster.indexOf(recentKills[i].hole) !== -1) recentKills.splice(i, 1);
    }
    mergers.push(new Merger(cluster));
  }

  // Trail ghost: the trail a comet leaves behind should not vanish the instant the
  // comet dies - it fades in place instead, matching exactly what was on screen the
  // frame before. It is a frozen snapshot: copied once at the moment of death, it
  // never moves and never reads mouseX/mouseY again, so it cannot end up looking like
  // it is still chasing the cursor if the mouse moves away right after the kill.
  function TrailGhost(p) {
    this.trail     = new Float32Array(p.trail);   // copy - p may be swap-removed after this
    this.trailHead = p.trailHead;
    this.r         = p.r;
    this.tint      = p.tint;
    this.baseAlpha = p.alpha();   // fade-in/position alpha at the instant of death
    this.age       = 0;
    this.maxLife   = 260;
    this.alive     = true;
  }
  TrailGhost.prototype.update = function (dt) {
    this.age += dt;
    if (this.age >= this.maxLife) this.alive = false;
  };
  TrailGhost.prototype.draw = function () {
    const fade = Math.max(0, 1 - this.age / this.maxLife);
    const a = this.baseAlpha * fade * fade;
    if (a <= 0.002) return;

    const buf     = this.trail;
    const tailIdx = this.trailHead;
    const headIdx = (tailIdx + TRAIL_LEN - 1) % TRAIL_LEN;
    const s0 = tailIdx * 2, s1 = headIdx * 2;
    const tint = this.tint;
    const grad = ctx.createLinearGradient(buf[s0], buf[s0 + 1], buf[s1], buf[s1 + 1]);
    grad.addColorStop(0,   `${tint}0)`);
    grad.addColorStop(0.5, `${tint}${(a * 0.25).toFixed(2)})`);
    grad.addColorStop(1,   `${tint}${(a * 0.85).toFixed(2)})`);

    ctx.globalAlpha = scrollOpacity;
    ctx.strokeStyle = grad;
    ctx.lineWidth   = this.r * 0.75 * fade;   // thins as it dissipates
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.beginPath();
    let lx = buf[s0], ly = buf[s0 + 1];
    ctx.moveTo(lx, ly);
    for (let i = 1; i < TRAIL_LEN; i++) {
      const idx = ((tailIdx + i) % TRAIL_LEN) * 2;
      const px = buf[idx], py = buf[idx + 1];
      const ddx = px - lx, ddy = py - ly;
      if (i < TRAIL_LEN - 1 && ddx * ddx + ddy * ddy < TRAIL_MIN2) continue;
      ctx.lineTo(px, py);
      lx = px; ly = py;
    }
    ctx.stroke();
  };
  function spawnTrailGhost(p) {
    if (ghosts.length >= MAX_GHOSTS) return;
    ghosts.push(new TrailGhost(p));
  }

  // Everything positional is stored in canvas pixels, so a resize would otherwise
  // strand the field: shrinking pushes comets past EDGE_MARGIN (mass death, then mass
  // respawn a frame later), and growing leaves the new area empty until they drift in.
  // Scaling every stored coordinate by the same factor as the canvas keeps the field's
  // relative layout intact, so a resize looks like the field stretching with the page.
  // Trails are stored as absolute points too and must be scaled with their comet, or
  // each one would snap to a stale path. Velocities are deliberately left alone - a
  // comet's speed is its own, not a property of the canvas.
  function rescaleField(sx, sy) {
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.x *= sx;
      p.y *= sy;
      const t = p.trail;
      for (let k = 0; k < TRAIL_LEN; k++) {
        t[k * 2]     *= sx;
        t[k * 2 + 1] *= sy;
      }
    }
    for (let i = 0; i < explosions.length; i++) { explosions[i].x *= sx; explosions[i].y *= sy; }
    for (let i = 0; i < crits.length;      i++) { crits[i].x      *= sx; crits[i].y      *= sy; }
    for (let i = 0; i < bounces.length;    i++) { bounces[i].x    *= sx; bounces[i].y    *= sy; }
    for (let i = 0; i < shards.length;     i++) { shards[i].x     *= sx; shards[i].y     *= sy; }
    for (let i = 0; i < blackHoles.length; i++) { blackHoles[i].x *= sx; blackHoles[i].y *= sy; }
    for (let i = 0; i < mergers.length;    i++) { mergers[i].x    *= sx; mergers[i].y    *= sy; }
    // Glyph boxes are not scaled here: measureLetters() re-reads them from layout on the
    // same resize, which is exact rather than approximated.
    // Ghosts carry a whole frozen trail, not a single point - every stored point in it
    // needs the same scaling a live comet's trail gets above.
    for (let i = 0; i < ghosts.length; i++) {
      const t = ghosts[i].trail;
      for (let k = 0; k < TRAIL_LEN; k++) {
        t[k * 2]     *= sx;
        t[k * 2 + 1] *= sy;
      }
    }
  }

  function resizeCanvas() {
    const prevW = W, prevH = H;
    W = canvas.width  = heroEl.offsetWidth  || window.innerWidth;
    H = canvas.height = heroEl.offsetHeight || window.innerHeight;

    // Population is a function of area, fixed at the first real layout
    if (!MAX && W > 0 && H > 0) {
      MAX = Math.max(MIN_COMETS,
                     Math.min(MAX_COMETS, Math.round((W * H) / AREA_PER_COMET)));
      liveMax = MAX;
    }

    if (prevW > 0 && prevH > 0 && (prevW !== W || prevH !== H)) {
      rescaleField(W / prevW, H / prevH);
    }

    initGrid();
    syncHeroRect();
    measureLetters();   // glyph boxes are layout-derived and move with the hero
    if (reducedMotion) drawStill();
  }

  function initGrid() {
    const cols = Math.ceil(W / GRID_STEP) + 1;
    const rows = Math.ceil(H / GRID_STEP) + 1;
    gridN     = cols * rows;
    gridBX    = new Float32Array(gridN);
    gridBY    = new Float32Array(gridN);
    gridPhase = new Float32Array(gridN);
    gridFreq  = new Float32Array(gridN);
    gridPosA  = new Float32Array(gridN);
    const fadeZone = H * 0.28, fadeTop = H * 0.72;
    for (let r = 0, i = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++, i++) {
        const by = r * GRID_STEP;
        gridBX[i]    = c * GRID_STEP;
        gridBY[i]    = by;
        gridPhase[i] = Math.random() * Math.PI * 2;
        gridFreq[i]  = 0.9 + Math.random() * 1.3;   // 0.9-2.2 Hz twinkle
        // Static bottom-fade factor, baked once since it depends only on by
        gridPosA[i]  = by < fadeTop ? 1 : Math.max(0, 1 - (by - fadeTop) / fadeZone);
      }
    }
    // Pre-allocate render buffers: sized to the dot count, not buckets x dots
    gridPos    = new Float32Array(gridN * 2);
    gridBucket = new Uint8Array(gridN);
    gridOrder  = new Int32Array(gridN);
  }

  function drawGrid(ts) {
    const t           = ts / 1000;
    const BASE_ALPHA  = 0.28;
    const hasMouse    = mouseX !== -9999;

    // Zero bucket counters (Int32Array.fill is fast)
    bucketCount.fill(0);

    for (let i = 0; i < gridN; i++) {
      const pa = gridPosA[i];
      if (pa <= 0) continue;
      const bx = gridBX[i], by = gridBY[i];

      // Hermite smoothstep for organic twinkling (smoother transitions)
      const raw    = (Math.sin(gridPhase[i] + t * gridFreq[i]) + 1) * 0.5;  // [0, 1]
      const smooth = raw * raw * (3 - 2 * raw);                   // eased [0, 1]
      const twinkle = 0.4 + .9 * smooth;                         // [0.1, 1.0]
      let   alpha   = BASE_ALPHA * twinkle * pa * scrollOpacity;

      // Spacetime deformation - skip sqrt for distant dots (dist² pre-check)
      let rx = bx, ry = by;
      if (hasMouse) {
        const dx = mouseX - bx, dy = mouseY - by;
        const d2 = dx * dx + dy * dy;
        if (d2 < GRID_DEFR2 && d2 > 0.25) {
          const dist = Math.sqrt(d2);
          const s    = GRID_BEND / (d2 + GRID_SOFT2);
          rx += (dx / dist) * s;
          ry += (dy / dist) * s;
        }
      }

      // Mergers. Gravitational lensing first: light from a star behind a horizon is bent
      // outward, so the grid opens into an Einstein ring around each hole instead of being
      // swallowed (outer-image radius (β + sqrt(β² + 4θE²)) / 2, faded out by LENS_R).
      // Then the strain of the passing waves, signed by cos 2(θ - φ) so it traces the
      // same spiral as the drawn wave arms. Squared-distance tests reject far dots first.
      for (let m = 0; m < mergers.length; m++) {
        const M = mergers[m];
        const nb = M.merged ? 1 : M.bodies.length;
        for (let h = 0; h < nb; h++) {
          const B  = M.merged ? M.remnant : M.bodies[h];
          const R  = B.R * B.vis;
          if (R < 0.5) continue;
          const LR = Math.max(MERGER_LENS_R, R * 4);
          const lx = rx - B.x, ly = ry - B.y, l2 = lx * lx + ly * ly;
          if (l2 >= LR * LR || l2 < 0.01) continue;
          const l  = Math.sqrt(l2);
          const E  = R * 1.3;   // Einstein radius, a little outside the shadow
          const sh = ((Math.sqrt(l2 + 4 * E * E) - l) / 2) * (1 - l / LR);
          rx += (lx / l) * sh;
          ry += (ly / l) * sh;
        }
        const ex = bx - M.x, ey = by - M.y, e2 = ex * ex + ey * ey;
        const fr = M.age * MERGER_C;
        if (e2 >= fr * fr || e2 < 1) continue;
        const a = M.waveAt(Math.sqrt(e2));
        if (a < 0.01) continue;
        const ed   = Math.sqrt(e2);
        const q    = ((ex * ex - ey * ey) * M.wc + 2 * ex * ey * M.ws) / e2;   // cos 2(θ - φ)
        const disp = MERGER_RIPPLE_AMP * a * q / Math.sqrt(Math.max(1, ed / 60));
        rx += (ex / ed) * disp;
        ry += (ey / ed) * disp;
        if (q > 0) alpha += 0.3 * a * q * pa * scrollOpacity;
      }
      // Quantise alpha to a bucket; position stays in dot order for now
      const b = Math.min(GRID_BUCKETS - 1, (alpha * GRID_BUCKETS) | 0);
      gridPos[i * 2]     = rx;
      gridPos[i * 2 + 1] = ry;
      gridBucket[i]      = b;
      bucketCount[b]++;
    }

    // Counting sort: prefix-sum the counts into run offsets, then scatter each dot
    // index into its bucket's run. bucketStart doubles as the write cursor (it is
    // rebuilt from bucketCount every frame, so consuming it here is safe).
    let running = 0;
    for (let b = 0; b < GRID_BUCKETS; b++) {
      bucketStart[b] = running;
      running += bucketCount[b];
    }
    for (let i = 0; i < gridN; i++) {
      if (gridPosA[i] <= 0) continue;
      gridOrder[bucketStart[gridBucket[i]]++] = i;
    }

    // One fill() per non-empty bucket - O(GRID_BUCKETS) draw calls total.
    // Runs are contiguous and in bucket order, so a running offset locates each.
    ctx.fillStyle = theme.dot;
    let runStart = 0;
    for (let b = 0; b < GRID_BUCKETS; b++) {
      const count = bucketCount[b];
      if (count === 0) continue;
      ctx.globalAlpha = (b + 0.5) / GRID_BUCKETS;
      ctx.beginPath();
      for (let k = 0; k < count; k++) {
        const idx = gridOrder[runStart + k] * 2;
        const x = gridPos[idx], y = gridPos[idx + 1];
        ctx.rect(x - 1.1, y - 1.1, 2.2, 2.2);   // a 2px square is indistinguishable from a dot
      }
      ctx.fill();
      runStart += count;
    }
  }

  // Head sprites. A comet's head is a filled circle with a canvas shadow for its glow,
  // and that shadow is a Gaussian blur: running it for every comet every frame was the
  // most expensive call in the frame. So each head is rendered once - with exactly the
  // same fill, shadowBlur and shadow colour the live drawing used - into a small offscreen
  // canvas, and stamped with drawImage. A second render at full cursor boost (larger,
  // brighter glow) is layered on top as a comet nears the cursor, matching how the live
  // glow grew. Sprites are shared by comets of near-identical colour and size, and swept
  // once no living comet has drawn them for a while, so the cache tracks the population.
  const GLOW_BOOST_MAX = 0.4;      // cursor boost at point blank, see Particle.draw
  const headSprites = new Map();
  let   frameNo     = 0;           // advanced by animate(); used to age out sprites
  function renderHead(headRgb, rgb, r, boost) {
    const blur = 10 + boost * 8;
    const rad  = r * (1 + boost * 0.35);
    const half = Math.ceil(rad + blur * 1.5 + 2);   // a canvas shadow reaches ~1.5x its blur
    const c = document.createElement('canvas');
    c.width = c.height = half * 2;
    const g = c.getContext('2d');
    g.shadowBlur  = blur;
    g.shadowColor = `rgba(${rgb},${0.5 + boost})`;
    g.fillStyle   = `rgba(${headRgb},${0.88 + boost * 0.12})`;
    g.beginPath();
    g.arc(half, half, rad, 0, Math.PI * 2);
    g.fill();
    return c;
  }
  function headSprite(shade, r, headRgb, rgb) {
    const key = (theme.light ? 'l' : 'd') + Math.round(shade * 31) + ':' + Math.round(r * 4);
    let e = headSprites.get(key);
    if (!e) {
      e = { base: renderHead(headRgb, rgb, r, 0), boosted: null, headRgb: headRgb, rgb: rgb, r: r, used: frameNo };
      headSprites.set(key, e);
    }
    return e;
  }
  function sweepHeadSprites() {
    headSprites.forEach(function (e, key) {
      if (frameNo - e.used > 600) headSprites.delete(key);
    });
  }

  // Particle
  function Particle(sx, sy) {
    this.x = sx + (Math.random() - 0.5) * 14;
    this.y = sy + (Math.random() - 0.5) * 14;

    // Free drift in any direction - no preferred heading, no restoring force.
    // Always slow: speed is something the cursor gives them, never something they start with.
    const spd   = 0.04 + Math.random() * (START_SPEED - 0.04);
    const angle = Math.random() * Math.PI * 2;
    this.vx = Math.cos(angle) * spd;
    this.vy = Math.sin(angle) * spd;

    this.r     = 2 + Math.random() * 3;
    this.mass  = this.r / MASS_REF_R;   // shared by the gravity pull and collision impulses
    this.age   = 0;      // fade-in only - lifetime is decided by the boundary, not the clock
    this.alive = true;

    // Health scales with mass (size), so bigger comets survive more collisions.
    // cracks are scar marks left at each impact point, drawn until the comet dies.
    this.maxHealth = HEALTH_PER_MASS * this.mass;
    this.health    = this.maxHealth;
    this.cracks    = [];   // {ax, ay: unit dir from centre, hits: times struck there}

    // Shade variation: wide spread across the orange family - deep red-ember through
    // amber to pale gold. The random draws are kept so paint() can recompute the colour
    // for either theme without the comet changing identity.
    this.shade = Math.random();   // 0 = deep ember, 1 = pale gold
    this.jr = Math.random(); this.jg = Math.random(); this.jb = Math.random();
    this.paint();

    // Ring buffer: Float32Array avoids object allocation & shift() O(n)
    this.trail = new Float32Array(TRAIL_LEN * 2);
    this.trailHead = 0;   // index of oldest slot
    this.resetTrail();
  }

  // Collapse the whole trail onto the comet's current position. Used at birth, and
  // after anything that moves a comet discontinuously - a trail is a record of where it
  // travelled, so leaving the old points behind after a jump draws a streak across
  // ground the comet never crossed.
  // Dark theme: the orange family, deep red-ember through amber to pale gold. R is not
  // pinned to 255, so the deep end reads as a genuinely different hue, not a dimmer
  // version of the same one; heads are brighter than tails, like hot cores.
  // Light theme: the cobalt family, deep indigo through cobalt to sky blue, matching that
  // theme's accent. Heads are drawn darker than tails instead, so they read on a pale field.
  // The same random draws drive both, so a comet keeps its place in the range across a
  // switch. Colour only changes on a theme switch, so every rgba() prefix is cached here
  // instead of being re-concatenated 60x a second.
  Particle.prototype.paint = function () {
    const tint = this.shade;
    let r, g, b, head;
    if (theme.light) {
      r = Math.max(10,  Math.min(90,  Math.round(20  + tint * 55  + (this.jr - 0.5) * 16)));
      g = Math.max(40,  Math.min(175, Math.round(55  + tint * 105 + (this.jg - 0.5) * 20)));
      b = Math.max(170, Math.min(245, Math.round(185 + tint * 50  + (this.jb - 0.5) * 20)));
      head = `${Math.max(0, r - 15)}, ${Math.max(0, g - 30)}, ${Math.max(0, b - 45)}`;
    } else {
      r = Math.max(215, Math.min(255, Math.round(228 + tint * 27 + (this.jr - 0.5) * 14)));
      g = Math.max(70,  Math.min(235, Math.round(80  + tint * 150 + (this.jg - 0.5) * 24)));
      b = Math.max(0,   Math.min(150, Math.round(tint * tint * 130 + this.jb * 30)));
      head = `${Math.min(255, r + 20)}, ${Math.min(255, g + 34)}, ${Math.min(255, b + 48)}`;
    }
    this.rgb      = `${r}, ${g}, ${b}`;
    this.headRgb  = head;
    this.tint     = `rgba(${this.rgb},`;
    this.headTint = `rgba(${this.headRgb},`;
    this.lineCol  = `rgba(${this.rgb},1)`;
    this.stopTail = this.tint + '0)';
    this.aq       = -1;            // forces the alpha-dependent stops to rebuild
    this.sprite   = headSprite(this.shade, this.r, this.headRgb, this.rgb);
  };

  Particle.prototype.resetTrail = function () {
    for (let i = 0; i < TRAIL_LEN; i++) {
      this.trail[i * 2]     = this.x;
      this.trail[i * 2 + 1] = this.y;
    }
  };

  // Index of an existing crack facing within CRIT_COS of (nx, ny), or -1.
  // Cracks store a unit direction from the comet's centre, so a dot product is the
  // whole test - no trig, and at most MAX_CRACKS iterations.
  Particle.prototype.crackNear = function (nx, ny) {
    for (let i = 0; i < this.cracks.length; i++) {
      const c = this.cracks[i];
      if (c.ax * nx + c.ay * ny > CRIT_COS) return i;
    }
    return -1;
  };

  Particle.prototype.alpha = function () {
    const fi = 600;
    const a  = this.age < fi ? this.age / fi : 1;   // fade in only - no timed fade-out
    // Fade out as comet drifts into the next section. Kept to a narrow band at the very
    // bottom so comets stay visible for nearly the whole hero rather than loitering unseen.
    const fadeStart = H * 0.86;
    const posFade   = this.y < fadeStart ? 1 : Math.max(0, 1 - (this.y - fadeStart) / (H * 0.14));
    return a * posFade;
  };

  Particle.prototype.update = function (dt) {
    this.age += dt;

    const k = dt / 16.667;   // frame-rate normalisation

    // Gravitational attraction - squared-distance guard avoids sqrt when far away
    const mdx = this.x - mouseX;
    const mdy = this.y - mouseY;
    const md2 = mdx * mdx + mdy * mdy;
    if (md2 < MOUSE_R2 && md2 > 0.25) {
      const mdst = Math.sqrt(md2);
      const distRatio = md2 / MOUSE_R2;
      const longRangeBoost = 1 + 0.7 * distRatio;
      const f    = Math.min((GRAV * this.mass / md2) * longRangeBoost, 3.0);   // include comet mass (size)
      this.vx -= (mdx / mdst) * f * 0.042 * k;
      this.vy -= (mdy / mdst) * f * 0.042 * k;
      if (mdst < 11) {
        registerCursorKill(spawnBlackHole(this.x, this.y, this.headRgb, this.mass));
        spawnTrailGhost(this);
        this.alive = false;
        return;
      }
    }

    // Vacuum: nothing else touches the velocity, so a comet that was swung into an
    // orbit keeps that trajectory once the cursor moves away, and one flung past escape
    // velocity keeps that speed all the way out. Only the ceiling ever intervenes.
    const sp2 = this.vx * this.vx + this.vy * this.vy;
    if (sp2 > MAX_SPEED2) {
      const s = MAX_SPEED / Math.sqrt(sp2);
      this.vx *= s;
      this.vy *= s;
    }

    this.x += this.vx * k;
    this.y += this.vy * k;

    // Crossing the boundary is the only way a comet ends other than hitting the cursor
    if (this.x < -EDGE_MARGIN || this.x > W + EDGE_MARGIN ||
        this.y < -EDGE_MARGIN || this.y > H + EDGE_MARGIN) {
      this.alive = false;
      return;
    }

    // O(1) ring-buffer trail update
    this.trail[this.trailHead * 2]     = this.x;
    this.trail[this.trailHead * 2 + 1] = this.y;
    this.trailHead = (this.trailHead + 1) % TRAIL_LEN;
  };

  Particle.prototype.draw = function () {
    const a    = this.alpha();
    const buf  = this.trail;
    const head = this.trailHead;    // oldest slot index

    // Tail and head positions from ring buffer
    const tailIdx = head;
    const headIdx = (head + TRAIL_LEN - 1) % TRAIL_LEN;
    const tx = buf[tailIdx * 2], ty = buf[tailIdx * 2 + 1];
    const hx = buf[headIdx * 2], hy = buf[headIdx * 2 + 1];

    // Trail. A slow comet's whole trail fits under its own head, so it is skipped rather
    // than stroked invisibly - most of the idle field. The gradient's colour stops are
    // rebuilt only when the comet's alpha changes visibly (fade-in, or the bottom fade
    // band), so steady comets allocate no strings per frame.
    const tdx = hx - tx, tdy = hy - ty, rr = this.r * 1.6;
    if (tdx * tdx + tdy * tdy > rr * rr) {
      const aq = (a * 40 + 0.5) | 0;
      if (aq !== this.aq) {
        this.aq = aq;
        this.stopMid  = `${this.tint}${(aq / 40 * 0.25).toFixed(3)})`;
        this.stopHead = `${this.tint}${(aq / 40 * 0.85).toFixed(3)})`;
      }
      const grad = ctx.createLinearGradient(tx, ty, hx, hy);
      grad.addColorStop(0,   this.stopTail);
      grad.addColorStop(0.5, this.stopMid);
      grad.addColorStop(1,   this.stopHead);

      ctx.globalAlpha = scrollOpacity;
      ctx.strokeStyle = grad;
      ctx.lineWidth   = this.r * 0.75;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      ctx.beginPath();
      // Walk ring buffer oldest → newest, folding away sub-pixel steps (see TRAIL_MIN2)
      const s0 = tailIdx * 2;
      let lx = buf[s0], ly = buf[s0 + 1];
      ctx.moveTo(lx, ly);
      for (let i = 1; i < TRAIL_LEN; i++) {
        const idx = ((tailIdx + i) % TRAIL_LEN) * 2;
        const px = buf[idx], py = buf[idx + 1];
        const ddx = px - lx, ddy = py - ly;
        if (i < TRAIL_LEN - 1 && ddx * ddx + ddy * ddy < TRAIL_MIN2) continue;
        ctx.lineTo(px, py);
        lx = px; ly = py;
      }
      ctx.stroke();
    }

    // Head and glow: the pre-rendered sprite, with the boosted render layered on top as
    // the comet nears the cursor (see headSprite).
    const mdx = hx - mouseX;
    const mdy = hy - mouseY;
    const md2 = mdx * mdx + mdy * mdy;
    const glowBoost = md2 < MOUSE_R2 ? (1 - md2 / MOUSE_R2) * GLOW_BOOST_MAX : 0;
    const e = this.sprite;
    e.used = frameNo;
    const base = e.base;
    ctx.globalAlpha = a * scrollOpacity;
    ctx.drawImage(base, hx - base.width / 2, hy - base.height / 2);
    if (glowBoost > 0.01) {
      if (!e.boosted) e.boosted = renderHead(e.headRgb, e.rgb, e.r, GLOW_BOOST_MAX);
      const b = e.boosted;
      ctx.globalAlpha = a * (glowBoost / GLOW_BOOST_MAX) * scrollOpacity;
      ctx.drawImage(b, hx - b.width / 2, hy - b.height / 2);
    }

    // Cracks: scar marks left at each collision's contact point, fixed to the
    // comet's own surface (comet-local unit direction, re-projected onto its
    // current position/radius every frame so they travel and scale with it).
    if (this.cracks.length) {
      // One colour for all of this comet's cracks (one string per comet, not per
      // crack); repeat hits on the same spot show as a wider, longer fracture.
      ctx.strokeStyle = `rgba(255, 60, 40, ${(a * 0.85).toFixed(2)})`;
      ctx.lineCap     = 'round';
      for (let i = 0; i < this.cracks.length; i++) {
        const c     = this.cracks[i];
        const grow  = 1 + (c.hits - 1) * 0.35;
        const len   = this.r * 0.6 * grow;
        const cx    = hx + c.ax * this.r * 0.8;
        const cy    = hy + c.ay * this.r * 0.8;
        ctx.lineWidth = Math.max(1, this.r * 0.22 * (1 + (c.hits - 1) * 0.3));
        // perpendicular to the impact direction - a jagged little tick, not a dot
        const px = -c.ay, py = c.ax;
        ctx.beginPath();
        ctx.moveTo(cx - px * len * 0.5 - c.ax * len * 0.3, cy - py * len * 0.5 - c.ay * len * 0.3);
        ctx.lineTo(cx + c.ax * len * 0.35, cy + c.ay * len * 0.35);
        ctx.lineTo(cx + px * len * 0.5 - c.ax * len * 0.3, cy + py * len * 0.5 - c.ay * len * 0.3);
        ctx.stroke();
      }
    }

    // Health bar: deliberately understated. It only appears past HP_BAR_AT and then
    // fades UP as damage accumulates, so a grazed comet shows almost nothing and only
    // a badly-hurt one reads clearly. Colours stay in the accent's warm range (amber
    // deepening to red) rather than a saturated green-to-red game HUD.
    if (this.health < this.maxHealth * HP_BAR_AT) {
      const frac  = Math.max(0, this.health / this.maxHealth);
      const vis   = Math.min(1, (HP_BAR_AT - frac) / HP_BAR_AT);   // 0 at threshold, 1 at death
      const alpha = a * vis * 0.5;
      const bw    = this.r * 3.2;
      const bh    = 1.3;
      const bx    = hx - bw / 2;
      const by    = hy - this.r - 5.5;
      ctx.fillStyle = `rgba(${theme.ink}, ${(alpha * 0.16).toFixed(3)})`;
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = `rgba(238, ${Math.round(40 + 150 * frac)}, 45, ${alpha.toFixed(3)})`;
      ctx.fillRect(bx, by, bw * frac, bh);
    }
  };

  // Cursor lines (drawn under particles). Batched by alpha: each comet's line goes into
  // one of LINE_BUCKETS paths, so the whole web is a handful of strokes instead of one
  // stroke (and one state change) per comet.
  const LINE_BUCKETS = 8;
  let lineBucket = new Int8Array(0);
  function drawCursorLines() {
    if (mouseX === -9999) return;
    if (lineBucket.length < particles.length) lineBucket = new Int8Array(particles.length * 2);
    let any = false;
    for (let i = 0; i < particles.length; i++) {
      const p     = particles[i];
      const hIdx  = ((p.trailHead + TRAIL_LEN - 1) % TRAIL_LEN) * 2;
      const dx    = p.trail[hIdx] - mouseX;
      const dy    = p.trail[hIdx + 1] - mouseY;
      const dist2 = dx * dx + dy * dy;
      if (dist2 >= LINE_R2) { lineBucket[i] = -1; continue; }
      const a = (1 - dist2 / LINE_R2) * 0.55 * p.alpha();
      lineBucket[i] = Math.min(LINE_BUCKETS - 1, (a / 0.55 * LINE_BUCKETS) | 0);
      any = true;
    }
    if (!any) return;
    ctx.lineWidth   = 0.65;
    ctx.strokeStyle = theme.line;
    ctx.setLineDash([3, 5]);
    for (let b = 0; b < LINE_BUCKETS; b++) {
      let started = false;
      for (let i = 0; i < particles.length; i++) {
        if (lineBucket[i] !== b) continue;
        if (!started) { ctx.beginPath(); started = true; }
        const p    = particles[i];
        const hIdx = ((p.trailHead + TRAIL_LEN - 1) % TRAIL_LEN) * 2;
        ctx.moveTo(mouseX, mouseY);
        ctx.lineTo(p.trail[hIdx], p.trail[hIdx + 1]);
      }
      if (!started) continue;
      ctx.globalAlpha = ((b + 0.5) / LINE_BUCKETS) * 0.55 * scrollOpacity;
      ctx.stroke();
    }
    ctx.setLineDash([]);   // reset dash once after the batch
  }

  // Comet-comet collisions.
  // Impulse resolution along the contact normal: the two comets receive equal and
  // opposite impulses, so total momentum is conserved exactly regardless of their
  // masses. RESTITUTION is the elasticity dial - 1 is perfectly elastic (kinetic
  // energy conserved too), 0 is perfectly inelastic (they leave the contact with the
  // same normal velocity). 0.9 keeps bounces lively while letting dense clusters
  // near the cursor settle instead of jittering forever.
  const RESTITUTION = 0.9;
  // Contact distance is (rA + rB) * this. The heads are drawn with a 10-18px glow
  // around them, so a strict rA + rB (4-10px) reads as the two comets sinking through
  // each other before reacting. 1.5 puts the bounce where they visually touch, and
  // widens the cross-section enough that contacts actually happen. Set to 1 for
  // strict circle geometry.
  const COLLIDE_SCALE = 1.5;
  // Damage per collision = DAMAGE_SCALE * (other comet's mass) * (closing speed).
  // Using the OTHER comet's mass means a heavy comet barely feels hitting a light
  // one, but a light comet takes a beating from a heavy one - the same asymmetry a
  // real mass mismatch would produce. HEALTH_PER_MASS ties max HP to size, so bigger
  // comets are tankier. MAX_CRACKS bounds the per-comet scar count (cheap to draw,
  // but unbounded growth over a comet's lifetime is still unbounded growth).
  const DAMAGE_SCALE    = 9;
  const HEALTH_PER_MASS = 50;
  const MAX_CRACKS      = 6;
  const HP_BAR_AT       = 0.75;   // no bar until a comet is below this much health
  // A scar is only left by a hit with real force behind it - idle drifting comets
  // bump into each other constantly and those glances should scuff, not crack.
  const CRACK_MIN_IMPACT = 0.6;   // closing speed along the normal, px/frame
  // Critical hit: a new impact landing within ~28 degrees of an existing crack is
  // striking ground that is already broken, so it bites far deeper.
  const CRIT_COS         = 0.88;  // cos of the angular window
  const CRIT_MULT        = 2.6;   // damage multiplier on a crit
  const MAX_CRITS        = 20;    // cap on concurrent crit bursts
  // Bounce puff: quick feedback for an ordinary hard collision that neither comet
  // dies from. Same "hard enough to matter" bar as a crack (below it, comets are just
  // jostling and nothing should flash), but a death always pre-empts it - that comet
  // already has its own, bigger animation.
  const BOUNCE_MIN_IMPACT = CRACK_MIN_IMPACT;
  const MAX_BOUNCES       = 70;   // cap on concurrent bounce sparks (2-5 per bounce)
  const MAX_SHARDS        = 60;   // cap on concurrent shatter fragments
  const MAX_BLACKHOLES    = 8;    // simultaneous cursor kills are rare; small cap is plenty
  // Merger: MERGER_MIN_KILLS cursor kills inside MERGER_WINDOW_MS - in practice a cluster
  // the cursor gathered falling in together - form a binary black hole that inspirals,
  // merges, and rings down, radiating a spiral of gravitational waves. See Merger.
  const MERGER_MIN_KILLS  = 3;
  const MERGER_WINDOW_MS  = 320;
  const MERGER_INSPIRAL   = 1100;   // ms from binary formation to merger (~2 orbits)
  const MERGER_RINGDOWN   = 1300;   // ms the remnant and its outgoing waves stay on screen
  const MERGER_RING_TAU   = 170;    // ms e-folding time of the ringdown
  const MERGER_W0         = 0.008;  // initial orbital angular speed, rad/ms (wavelength ~165px)
  const MERGER_W_MAX      = 0.02;   // orbital angular speed at merger, rad/ms (wavelength ~65px)
  const MERGER_W_RING     = 0.024;  // ringdown (quasinormal-mode) angular speed, rad/ms
  const MERGER_C          = 0.42;   // gravitational-wave speed, px/ms
  const MERGER_HIST_DT    = 8;      // ms per stored waveform sample
  const MERGER_RIPPLE_AMP = 7;      // peak star-grid strain displacement, px
  const MERGER_TIDE       = 0.05;   // peak tidal velocity nudge on comets, px/frame
  const MERGER_LENS_R     = 70;     // radius within which a horizon lenses the star grid, px
  const MAX_MERGERS       = 3;
  const MAX_GHOSTS        = 24;   // fading trail remnants, one per recent death

  /* ===== Hero text as collision geometry =====
     main.js splits the hero copy into one <span class="anim-char"> per glyph, which makes
     every letter an independently measurable box. Each becomes a static, immovable body
     in the comet field: the glyph absorbs no impulse, so the comet takes the entire
     separation and bounce (and the impact damage, exactly as from another comet). The
     text itself is never damaged.

     Under prefers-reduced-motion the copy is never split, so there are no glyph bodies. */
  const LETTER_MASS        = 1.5;    // effective mass for damage dealt TO a comet
  const LETTER_RESTITUTION = 0.82;   // slightly deader than comet-comet - glyphs absorb

  const letters = [];
  // Union bounds of every glyph box - one cheap reject for comets nowhere near the copy
  let lbMinX = 0, lbMinY = 0, lbMaxX = -1, lbMaxY = -1;

  function rgbOf(css) {
    const m = /(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(css || '');
    return m ? `${m[1]}, ${m[2]}, ${m[3]}` : '255, 255, 255';
  }

  // Off-screen buffer for measuring glyph ink. Grown to fit the largest glyph ever needed
  // and reused; assigning width/height resets the canvas, so it is only ever grown.
  // willReadFrequently: measureInk reads it back, which otherwise forces a GPU readback.
  const scratch = document.createElement('canvas');
  const sctx    = scratch.getContext('2d', { willReadFrequently: true });

  // Exact ink bounds of one glyph, relative to its text origin: dx/dy from the origin
  // and the alphabetic baseline to the ink's top-left, plus its true size.
  //
  // measureText's actualBoundingBox* is NOT good enough on its own. Chrome quantises it
  // to whole pixels and rounds outward, and it rounds the right edge out more often than
  // the left - which put every letter's collision boundary up to a pixel to the right of
  // the glyph while the other three sides sat flush. So the reported box is used only as
  // a search window, and the real extent comes from scanning what actually gets painted.
  //
  // One render + readback per distinct glyph, cached by font and character, so the whole
  // hero costs about twenty of them once at layout rather than any per-frame work.
  const inkCache = Object.create(null);
  function measureInk(ch, font) {
    const key = font + '\u0000' + ch;
    const hit = inkCache[key];
    if (hit !== undefined) return hit;

    sctx.font = font;
    const m = sctx.measureText(ch);
    const PAD = 4;   // room for a hinted glyph to exceed its own reported bounds
    const ox = Math.ceil(m.actualBoundingBoxLeft)   + PAD;
    const oy = Math.ceil(m.actualBoundingBoxAscent) + PAD;
    const w  = ox + Math.ceil(m.actualBoundingBoxRight)   + PAD;
    const h  = oy + Math.ceil(m.actualBoundingBoxDescent) + PAD;
    if (!(w > 0 && h > 0 && w < 4096 && h < 4096)) return (inkCache[key] = null);

    if (scratch.width  < w) scratch.width  = w;
    if (scratch.height < h) scratch.height = h;
    sctx.globalAlpha = 1;
    sctx.globalCompositeOperation = 'source-over';
    sctx.clearRect(0, 0, w, h);
    sctx.font = font;               // a resize above would have reset this
    sctx.fillStyle    = '#ffffff';
    sctx.textAlign    = 'left';
    sctx.textBaseline = 'alphabetic';
    sctx.fillText(ch, ox, oy);

    const d = sctx.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (d[(row + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    // Nothing painted: a blank or missing glyph, which cannot be a collision body
    const res = x1 < 0 ? null : {
      dx: x0 - ox, dy: y0 - oy, w: x1 - x0 + 1, h: y1 - y0 + 1,
      fa: m.fontBoundingBoxAscent, fd: m.fontBoundingBoxDescent,
    };
    inkCache[key] = res;
    return res;
  }

  function Letter(el, ch) {
    this.el   = el;
    this.ch   = ch;
    this.root = el.closest ? el.closest('[data-anim]') : null;
    this.x = 0; this.y = 0; this.w = 0; this.h = 0;
    this.rgb  = '255, 255, 255';
    this.live = false;   // is a collision body this frame - see syncLetters
  }

  // Only the split hero copy collides. Everything else on the page is outside the canvas.
  function collectLetters() {
    const nodes = document.querySelectorAll('.hero__eyebrow .anim-char, .hero__name .anim-char');
    if (!nodes.length) return;
    // Same spans as last time: just re-measure.
    if (letters.length && letters[0].el === nodes[0]) { measureLetters(); return; }

    letters.length = 0;
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const ch = el.getAttribute('data-c') || el.textContent;
      if (!/\S/.test(ch)) continue;          // a space has no glyph
      letters.push(new Letter(el, ch));
    }
    measureLetters();
  }

  // Glyph boxes come from layout, so they are read in a single batch here (on resize
  // and at startup) rather than per frame.
  function measureLetters() {
    if (!letters.length) return;
    const base = heroEl.getBoundingClientRect();

    lbMinX = Infinity; lbMinY = Infinity; lbMaxX = -Infinity; lbMaxY = -Infinity;
    for (let i = 0; i < letters.length; i++) {
      const L = letters[i];
      const r = L.el.getBoundingClientRect();
      L.x = r.left - base.left;
      L.y = r.top  - base.top;
      L.w = r.width;
      L.h = r.height;
      if (L.w <= 0 || L.h <= 0) continue;

      const cs = getComputedStyle(L.el);
      const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      L.rgb = rgbOf(cs.color);

      // The span's box is NOT the letter. It is the advance width (which includes side
      // bearings, and here also .02-.22em of letter-spacing tacked on the right) by the
      // full line box (which at line-height .9 on an 80px face is 72px tall around ~57px
      // of actual cap height). Colliding against that rectangle meant comets bouncing
      // off empty space beside and above the glyph.
      // measureInk gives the real painted extent, so the collision body is tightened to
      // the letter itself.
      const ink = measureInk(L.ch, font);
      if (ink) {
        // Locate the alphabetic baseline inside the line box: the font's content area is
        // fontBoundingBox tall and sits centred in it (CSS half-leading).
        const baseY = (ink.fa === undefined || ink.fd === undefined)
          ? L.h * 0.8                              // no font metrics: rough baseline
          : (L.h - (ink.fa + ink.fd)) / 2 + ink.fa;
        L.x += ink.dx;              // span origin  -> ink left edge
        L.y += baseY + ink.dy;      // line-box top -> ink top edge
        L.w  = ink.w;
        L.h  = ink.h;
      }   // nothing measurable: keep the span box

      if (L.x < lbMinX) lbMinX = L.x;
      if (L.y < lbMinY) lbMinY = L.y;
      if (L.x + L.w > lbMaxX) lbMaxX = L.x + L.w;
      if (L.y + L.h > lbMaxY) lbMaxY = L.y + L.h;
    }
    if (!isFinite(lbMinX)) { lbMinX = 0; lbMinY = 0; lbMaxX = -1; lbMaxY = -1; }
  }

  // Whether each glyph is a collision body this frame, resolved once here rather than
  // inside the comet x letter sweep (that ran up to MAX x letters times a frame). A glyph
  // only collides once its intro has played, so nothing bounces off invisible text.
  function syncLetters() {
    for (let i = 0; i < letters.length; i++) {
      const L = letters[i];
      L.live = L.w > 0 && (!L.root || L.root.classList.contains('anim-play'));
    }
  }

  // Comet vs. glyph. The glyph is a static AABB with infinite mass: the comet takes all of
  // the separation, all of the bounce, and the impact damage.
  function resolveLetterCollisions() {
    if (!letters.length || lbMaxX < lbMinX) return;

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p.alive) continue;

      const reach = p.r * COLLIDE_SCALE;
      if (p.x + reach < lbMinX || p.x - reach > lbMaxX ||
          p.y + reach < lbMinY || p.y - reach > lbMaxY) continue;

      for (let j = 0; j < letters.length; j++) {
        const L = letters[j];
        if (!L.live) continue;   // unmeasured, or not yet faded in

        const x2 = L.x + L.w, y2 = L.y + L.h;
        if (p.x + reach < L.x || p.x - reach > x2 ||
            p.y + reach < L.y || p.y - reach > y2) continue;

        // Closest point on the box, and the outward normal at that point
        let cx = p.x < L.x ? L.x : (p.x > x2 ? x2 : p.x);
        let cy = p.y < L.y ? L.y : (p.y > y2 ? y2 : p.y);
        let dx = p.x - cx, dy = p.y - cy;
        const d2 = dx * dx + dy * dy;
        let nx, ny, ejected = false;

        if (d2 > 1e-8) {
          const dist = Math.sqrt(d2);
          if (dist >= reach) continue;
          nx = dx / dist; ny = dy / dist;
        } else {
          // Degenerate: the centre is inside the box, which normal approach can never
          // produce (a comet is caught while still outside - at MAX_SPEED it moves 4.5px
          // a frame against boxes 14px deep at the very smallest). It happens when a
          // comet is *placed* inside one: seeded before the glyphs were measured, or
          // left there by a resize.
          //
          // Escape is vertical, never sideways, even when a side face is nearer. Glyphs
          // in a word are adjacent with no gap, so ejecting through a side face pushes
          // the comet into its neighbour, which ejects it straight back - a stable
          // ping-pong that traps the comet on the seam for as long as the letters live.
          //
          // Which way is decided by the copy as a whole, not by this glyph: away from the
          // middle of the text block. Picking the nearer face of the box alone has the
          // same failure one level up - the two lines of the hero name are vertically
          // adjacent, so "down out of line one" is "into line two", which sends it back
          // up. Because every glyph agrees on the direction, a comet handed from box to
          // box within one pass only ever moves further from the middle, so the chain
          // always terminates clear of the copy instead of oscillating inside it.
          if (p.y < (lbMinY + lbMaxY) * 0.5) { nx = 0; ny = -1; cx = p.x; cy = L.y; }
          else                               { nx = 0; ny =  1; cx = p.x; cy = y2;  }
          ejected = true;
        }

        // Immovable body: the comet absorbs the entire positional correction
        p.x = cx + nx * reach;
        p.y = cy + ny * reach;
        // An ordinary contact nudges a comet by a fraction of a pixel, but the escape
        // above can move it the height of a glyph at once. Without dragging the trail
        // along, that jump renders as a long streak from wherever the comet used to be -
        // the exact artefact seen when one is seeded behind the name and shoved clear.
        if (ejected) p.resetTrail();

        const vn = p.vx * nx + p.vy * ny;
        if (vn >= 0) continue;   // already leaving; resolving again would pump in energy
        p.vx -= (1 + LETTER_RESTITUTION) * vn * nx;
        p.vy -= (1 + LETTER_RESTITUTION) * vn * ny;

        const impact = -vn;

        // Same damage model as a comet-comet contact, with the glyph as the other body.
        // Gated on the "hard enough to matter" bar: a glyph is immovable, so the cursor can
        // pin a comet against one indefinitely, and every frame of that is a fresh
        // sub-threshold contact that must not count as a critical hit.
        const hard  = impact >= CRACK_MIN_IMPACT;
        const critP = hard ? p.crackNear(-nx, -ny) : -1;
        let dmgP = DAMAGE_SCALE * LETTER_MASS * impact;
        if (critP >= 0) dmgP *= CRIT_MULT;
        p.health -= dmgP;

        if (critP >= 0) p.cracks[critP].hits++;
        else if (hard && p.cracks.length < MAX_CRACKS) {
          p.cracks.push({ ax: -nx, ay: -ny, hits: 1 });
        }

        if (p.health <= 0) {
          if (critP >= 0) spawnCritDeath(p.x, p.y, p.headRgb, p.mass);
          else spawnCometDeath(p.x, p.y, p.headRgb, p.mass);
          spawnTrailGhost(p);
          p.alive = false;
          break;   // nothing left to test against the remaining glyphs
        }
        if (critP >= 0) spawnCrit(cx, cy, p.headRgb, false, p.mass);
        else if (impact >= BOUNCE_MIN_IMPACT) {
          spawnBounce(cx, cy, p.headRgb, L.rgb, p.mass, impact / MAX_SPEED);
        }
      }
    }
  }

  function resolveCollisions() {
    // Naive O(n^2) pair sweep. At MAX = 90 that is ~4k squared-distance tests per
    // frame, which is far cheaper than the trail strokes - a spatial hash would only
    // be worth it if the population grew several times over.
    for (let i = 0; i < particles.length; i++) {
      const a = particles[i];
      if (!a.alive) continue;

      for (let j = i + 1; j < particles.length; j++) {
        const b = particles[j];
        if (!b.alive) continue;

        const dx   = b.x - a.x;
        const dy   = b.y - a.y;
        const rsum = (a.r + b.r) * COLLIDE_SCALE;
        const d2   = dx * dx + dy * dy;
        if (d2 >= rsum * rsum || d2 < 1e-8) continue;   // no contact, or exactly coincident

        const dist = Math.sqrt(d2);
        const nx   = dx / dist;
        const ny   = dy / dist;

        // Push the overlap apart, split by mass so the heavier comet yields less.
        // Positions only - this carries no impulse and so leaves momentum untouched.
        // Done unconditionally, so a pair that is overlapped but already drifting apart
        // still gets separated rather than being left sunk into each other.
        const share = (rsum - dist) / (a.mass + b.mass);
        a.x -= nx * share * b.mass;
        a.y -= ny * share * b.mass;
        b.x += nx * share * a.mass;
        b.y += ny * share * a.mass;

        // Closing speed along the normal. Pairs already moving apart take no impulse,
        // so a contact that spans frames cannot be resolved twice and pump in energy.
        const rvn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rvn > 0) continue;

        const ima = 1 / a.mass;
        const imb = 1 / b.mass;
        const imp = -(1 + RESTITUTION) * rvn / (ima + imb);

        a.vx -= imp * ima * nx;
        a.vy -= imp * ima * ny;
        b.vx += imp * imb * nx;
        b.vy += imp * imb * ny;

        // Damage: scales with the OTHER comet's mass and the shared impact speed,
        // so a heavy comet shrugs off hitting a light one but a light comet takes a
        // real beating from a heavy one. Cracks mark the exact contact point on each
        // comet's own surface - direction toward the other comet on A, and the
        // mirror direction on B.
        const impactSpeed = -rvn;

        // Critical hit: does this impact land on ground an earlier hit already broke?
        // Checked BEFORE the new crack is recorded, or every hit would crit against
        // the scar it just created.
        const critA = a.crackNear(nx, ny);
        const critB = b.crackNear(-nx, -ny);

        let dmgA = DAMAGE_SCALE * b.mass * impactSpeed;
        let dmgB = DAMAGE_SCALE * a.mass * impactSpeed;
        if (critA >= 0) dmgA *= CRIT_MULT;
        if (critB >= 0) dmgB *= CRIT_MULT;
        a.health -= dmgA;
        b.health -= dmgB;

        // A crit deepens the crack it reopened; a fresh hard hit leaves a new one.
        // Soft glances leave nothing - drifting comets bump constantly and those
        // contacts should not scar.
        if (critA >= 0) a.cracks[critA].hits++;
        else if (impactSpeed >= CRACK_MIN_IMPACT && a.cracks.length < MAX_CRACKS) {
          a.cracks.push({ ax: nx, ay: ny, hits: 1 });
        }
        if (critB >= 0) b.cracks[critB].hits++;
        else if (impactSpeed >= CRACK_MIN_IMPACT && b.cracks.length < MAX_CRACKS) {
          b.cracks.push({ ax: -nx, ay: -ny, hits: 1 });
        }

        // Reflected damage: if a hit overkills one comet, the excess (the energy
        // that had nowhere left to go once its target was already destroyed) is
        // kicked back onto whichever comet dealt it.
        if (a.health < 0) { b.health += a.health; a.health = 0; }
        if (b.health < 0) { a.health += b.health; b.health = 0; }

        const aDies = a.alive && a.health <= 0;
        const bDies = b.alive && b.health <= 0;

        // Four distinct outcomes, escalating in weight:
        //  - ordinary bounce -> a quick puff at the contact point (death and crit
        //                       both take priority over this - see below)
        //  - crit, survives  -> small shockwave alone, on the fracture (0.8r, matching
        //                       where the crack itself is drawn)
        //  - dies, no crit   -> spawnCometDeath: pop + small shockwave
        //  - dies on a crit  -> spawnCritDeath: both, amplified
        // A death always fires at the comet's own centre, not the contact point -
        // the whole comet is gone, not just the struck spot.
        if (critA >= 0 && !aDies) {
          spawnCrit(a.x + nx * a.r * 0.8, a.y + ny * a.r * 0.8, a.headRgb, false, a.mass);
        }
        if (critB >= 0 && !bDies) {
          spawnCrit(b.x - nx * b.r * 0.8, b.y - ny * b.r * 0.8, b.headRgb, false, b.mass);
        }

        // Plain bounce: neither comet died, and neither side crit (those already got
        // their own shockwave above). Death pre-empting this is the whole point - a
        // comet that just ended does not also flash a little "we touched" puff.
        // The puff sits at the true contact point. The overlap separation above leaves
        // the pair exactly touching, so that point is simply A's effective surface
        // along the normal - which is also B's, from the other side. It used to be a
        // flat 0.5r from A, ignoring B entirely, so a small comet hitting a large one
        // flashed inside the small one rather than where the two actually met.
        // Uses post-separation positions throughout; mixing in the pre-separation
        // `dist` would put it a fraction of a pixel off.
        if (!aDies && !bDies && critA < 0 && critB < 0 && impactSpeed >= BOUNCE_MIN_IMPACT) {
          const reach = a.r * COLLIDE_SCALE;
          spawnBounce(a.x + nx * reach, a.y + ny * reach,
                      a.headRgb, b.headRgb,
                      (a.mass + b.mass) * 0.5, impactSpeed / MAX_SPEED);
        }

        if (aDies) {
          if (critA >= 0) spawnCritDeath(a.x, a.y, a.headRgb, a.mass);
          else spawnCometDeath(a.x, a.y, a.headRgb, a.mass);
          spawnTrailGhost(a);
          a.alive = false;
        }
        if (bDies) {
          if (critB >= 0) spawnCritDeath(b.x, b.y, b.headRgb, b.mass);
          else spawnCometDeath(b.x, b.y, b.headRgb, b.mass);
          spawnTrailGhost(b);
          b.alive = false;
        }
      }
    }
  }

  // Spawning: anywhere in the field - comets drift rather than stream from a corner.
  // The population is a constant MAX; a new comet appears only when an old one ends.
  // True if (x, y) falls within `pad` of a live glyph. Spawning inside one is the only
  // way a comet reaches the degenerate interior case in the letter solver, so it is
  // cheaper to avoid than to recover from.
  function inLetterBox(x, y, pad) {
    pad = pad || 0;
    for (let i = 0; i < letters.length; i++) {
      const L = letters[i];
      if (L.w <= 0) continue;
      if (x > L.x - pad && x < L.x + L.w + pad &&
          y > L.y - pad && y < L.y + L.h + pad) return true;
    }
    return false;
  }

  // Particle jitters its start by up to 7px on each axis, so the clearance a candidate
  // point is tested with has to cover that or a comet can still land on a letter.
  const SPAWN_CLEARANCE = 10;

  function spawnOne() {
    // Keep clear of the cursor so nothing materialises inside the gravity well, and off
    // the hero copy so nothing materialises on a letter
    let fx0 = 0, fy0 = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      const sx = W * 0.04 + Math.random() * W * 0.92;
      const sy = H * 0.04 + Math.random() * H * 0.71;   // above the bottom fade band
      const dx = sx - mouseX, dy = sy - mouseY;
      const offText = !inLetterBox(sx, sy, SPAWN_CLEARANCE);
      if (offText && dx * dx + dy * dy > 160 * 160) {
        particles.push(new Particle(sx, sy));
        return;
      }
      // Remember the best near-miss: staying off the text matters more than staying off
      // the cursor, since a comet born on a glyph is shoved out of it on the same frame.
      if (offText) { fx0 = sx; fy0 = sy; }
    }
    // Out of attempts. Fall back to a point known to be clear of the text if one turned
    // up, and only otherwise to the bottom band, which the copy never reaches.
    if (fx0) particles.push(new Particle(fx0, fy0));
    else particles.push(new Particle(W * 0.04 + Math.random() * W * 0.92,
                                     H * 0.6 + Math.random() * H * 0.15));
  }

  // Seed the full field on load so the hero is never sparse
  function seedField() {
    while (particles.length < MAX) {
      spawnOne();
      // Stagger the fade-in so the field arrives gradually instead of blooming at once
      const p = particles[particles.length - 1];
      if (p) p.age = Math.random() * 500;
    }
  }

  // Render loop.
  // Gated on visibility: the hero canvas only exists at the top of the page, so once
  // it scrolls away (or the tab is backgrounded) every frame is invisible work. The
  // loop is stopped outright rather than drawn at zero alpha - previously the full
  // simulation, collision sweep and 90 trail strokes still ran for output nobody sees.
  let prev = 0;
  let running = false;
  let rafId = 0;

  // Reduced motion: one still frame of the star field and comet heads, no loop.
  function drawStill() {
    ctx.clearRect(0, 0, W, H);
    drawGrid(0);
    for (let i = 0; i < particles.length; i++) { particles[i].age = 1e4; particles[i].draw(); }
  }

  function startLoop() {
    if (running || reducedMotion) return;
    running = true;
    prev = 0;   // drop the paused interval so dt does not spike on the first frame back
    rafId = requestAnimationFrame(animate);
  }
  function stopLoop() {
    if (!running) return;
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function animate(ts) {
    if ((++frameNo & 255) === 0) sweepHeadSprites();
    if (!running) return;
    const dt = prev ? Math.min(ts - prev, 50) : 16;
    prev = ts;

    // Frame pacing -> population target. Intervals at the 50ms clamp are stalls (a
    // background tab, a GC pause, the loop resuming) and say nothing about steady-state
    // cost, so they are left out of the average entirely.
    if (dt >= 6 && dt < 50) {
      if (dt < perfBase) perfBase = dt;
      perfSum += dt;
      if (++perfCount >= PERF_WINDOW) {
        const avg = perfSum / perfCount;
        perfSum = 0; perfCount = 0;
        if (avg > perfBase * PERF_SHED_AT) {
          liveMax = Math.max(MIN_COMETS, liveMax - PERF_STEP);
        } else if (avg < perfBase * PERF_RECOVER && liveMax < MAX) {
          liveMax = Math.min(MAX, liveMax + PERF_STEP);
        }
      }
    }

    ctx.clearRect(0, 0, W, H);

    drawGrid(ts);   // star field - bottom layer; manages its own globalAlpha

    for (let i = particles.length - 1; i >= 0; i--) {
      if (!particles[i].alive) {
        particles[i] = particles[particles.length - 1];
        particles.pop();
      }
    }
    // One in, one out - every comet lost to the boundary or the cursor is replaced,
    // up to the current target. When that target drops, the field is thinned by simply
    // not replacing the next departures rather than deleting live comets, so shedding
    // load is invisible instead of a handful of comets blinking out at once.
    while (particles.length < liveMax) spawnOne();

    for (let i = 0; i < particles.length; i++) particles[i].update(dt);

    resolveCollisions();   // after integration, while positions are current

    syncLetters();
    resolveLetterCollisions();    // the static text bodies, with positions current

    drawCursorLines();   // lines behind particles

    // Fading trail remnants, drawn under the live comets they belong to
    for (let i = ghosts.length - 1; i >= 0; i--) {
      const g = ghosts[i];
      g.update(dt);
      if (!g.alive) {
        ghosts[i] = ghosts[ghosts.length - 1];
        ghosts.pop();
        continue;
      }
      g.draw();
    }

    for (let i = 0; i < particles.length; i++) particles[i].draw();

    // Bounce sparks first - the subtlest effect, so bigger ones drawn after it are
    // never hidden underneath
    for (let i = bounces.length - 1; i >= 0; i--) {
      const p = bounces[i];
      p.update(dt);
      if (!p.alive) {
        bounces[i] = bounces[bounces.length - 1];
        bounces.pop();
        continue;
      }
      p.draw();
    }

    // Explosions on top
    for (let i = explosions.length - 1; i >= 0; i--) {
      const spark = explosions[i];
      spark.update(dt);
      if (!spark.alive) {
        explosions[i] = explosions[explosions.length - 1];
        explosions.pop();
        continue;
      }
      spark.draw();
    }

    // Shatter fragments from a critical death
    for (let i = shards.length - 1; i >= 0; i--) {
      const s = shards[i];
      s.update(dt);
      if (!s.alive) {
        shards[i] = shards[shards.length - 1];
        shards.pop();
        continue;
      }
      s.draw();
    }

    // Crit shockwaves above the sparks - they mark the moment of a critical hit
    for (let i = crits.length - 1; i >= 0; i--) {
      const c = crits[i];
      c.update(dt);
      if (!c.alive) {
        crits[i] = crits[crits.length - 1];
        crits.pop();
        continue;
      }
      c.draw();
    }

    // Black holes over everything else, so their shadows cover what is behind them
    for (let i = blackHoles.length - 1; i >= 0; i--) {
      const bh = blackHoles[i];
      bh.update(dt);
      if (!bh.alive) {
        blackHoles[i] = blackHoles[blackHoles.length - 1];
        blackHoles.pop();
        continue;
      }
      bh.draw();
    }

    // Mergers last: their horizons and waves sit above the single-kill holes
    for (let i = mergers.length - 1; i >= 0; i--) {
      const m = mergers[i];
      m.update(dt);
      if (!m.alive) {
        mergers[i] = mergers[mergers.length - 1];
        mergers.pop();
        continue;
      }
      m.draw();
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';   // guard against a leaked state

    rafId = requestAnimationFrame(animate);
  }

  const heroEl = document.getElementById('hero');   // cached - was re-queried per scroll
  let heroLeft = 0, heroTop = 0;
  // The cursor is tracked in viewport coordinates and mapped into canvas space whenever
  // either side moves. Mapping only on mousemove left the field pointing at the old spot
  // after a scroll with a still mouse - every cursor line visibly offset from the pointer.
  let clientX = null, clientY = null;
  function mapMouse() {
    if (clientX === null) return;
    mouseX = clientX - heroLeft;
    mouseY = clientY - heroTop;
  }

  function syncHeroRect() {
    const rect = heroEl.getBoundingClientRect();
    heroLeft = rect.left;
    heroTop  = rect.top;
    mapMouse();
  }

  document.addEventListener('mousemove', (e) => {
    clientX = e.clientX;
    clientY = e.clientY;
    mapMouse();
  });

  function syncScrollOpacity() {
    const rect = heroEl.getBoundingClientRect();   // one layout read, was two
    scrollOpacity = rect.bottom > 0 ? Math.min(1, rect.bottom / 200) : 0;
    heroLeft = rect.left;
    heroTop  = rect.top;
    mapMouse();
  }
  // rAF-throttled: scroll fires far more often than the screen refreshes, and each
  // call forces a synchronous layout via getBoundingClientRect.
  window.addEventListener('scroll', rafThrottle(syncScrollOpacity), { passive: true });
  window.addEventListener('resize', rafThrottle(resizeCanvas),      { passive: true });
  // The hero can change size without the window resizing (webfonts landing, content
  // taller than the viewport, mobile toolbars changing 100dvh). The canvas's pixel size
  // must follow, or CSS stretches the drawing and every coordinate in it drifts.
  if (window.ResizeObserver) {
    new ResizeObserver(rafThrottle(function () {
      if (heroEl.offsetWidth !== W || heroEl.offsetHeight !== H) resizeCanvas();
    })).observe(heroEl);
  }

  // Only animate while the hero is actually on screen and the tab is foregrounded.
  let heroVisible = true;
  function syncRunState() {
    if (!document.hidden && heroVisible) startLoop();
    else stopLoop();
  }
  new IntersectionObserver(function (entries) {
    heroVisible = entries[entries.length - 1].isIntersecting;
    syncRunState();
  }, { threshold: 0 }).observe(heroEl);
  document.addEventListener('visibilitychange', syncRunState);

  resizeCanvas();
  seedField();
  document.addEventListener('themechange', function () {
    theme = currentTheme();
    for (let i = 0; i < particles.length; i++) particles[i].paint();
    for (let i = 0; i < letters.length; i++) letters[i].rgb = rgbOf(getComputedStyle(letters[i].el).color);
    if (reducedMotion) drawStill();
  });

  if (reducedMotion) drawStill();
  else startLoop();

  // main.js has already split the hero copy into per-character spans by the time this
  // script runs, but webfonts can still move the glyphs. Collect now, again once fonts
  // settle, and once more after the intro's 1200 ms safety net - each pass is idempotent.
  collectLetters();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(collectLetters);
  setTimeout(collectLetters, 1500);
})();
