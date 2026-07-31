<!-- date: 07-31-2026 -->

# Portfolio Particle Engine

The hero canvas on this site, with the drifting comets, the cursor's gravity, the collisions
and cracks and shattering, is a small real-time physics and particle engine written in
vanilla JavaScript over Canvas 2D. This page documents how it actually works.

---

## Why build this instead of a stock particle library

A portfolio hero is usually a fixed animation or a canvas library dropped in as a black
box. I wanted to build something unique. I thought it would be interesting to build a system 
that responded to genuine physics with real momentum conservation, real inverse-square gravity, 
rather than hand-tuned easing curves that look plausible and fall apart under scrutiny. 
Since the site is a Computer Engineering portfolio, the canvas doubles as a demonstration 
for a kind of small simulation-plus-rendering system that shows up constantly in embedded and 
systems work, just running in a browser instead of on a microcontroller.

## Physics

Each comet is a `Particle` with position, velocity, radius, and a mass derived from its
radius (`r / MASS_REF_R`). Two forces act on it:

**Cursor gravity** is a softened inverse-square field:

```js
const f = Math.min((GRAV * this.mass / md2) * longRangeBoost, 3.0);
this.vx -= (mdx / mdst) * f * 0.042 * k;
```

`longRangeBoost` widens the effective pull radius so comets far from the cursor still
feel it, and the whole term is clamped so a comet that strays very close to the cursor
can't get an unbounded, frame-breaking velocity spike. Nothing else touches velocity
between frames - no drag, no restoring force - so a comet swung into an orbit stays in
that orbit once the cursor moves away, and one flung past escape velocity keeps that
speed all the way off-screen.

**Comet-comet collisions** resolve as a real impulse along the contact normal:

```js
const imp = -(1 + RESTITUTION) * rvn / (ima + imb);
a.vx -= imp * ima * nx;  b.vx += imp * imb * nx;
a.vy -= imp * ima * ny;  b.vy += imp * imb * ny;
```

This conserves momentum exactly regardless of the two masses - verified in testing to
machine precision (~1e-14 drift, pure float noise) across hundreds of resolved
collisions. `RESTITUTION = 0.9` is the only tuning knob; at `1` it's perfectly elastic,
at `0` perfectly inelastic. Overlap correction (pushing two touching comets apart) is
kept strictly separate from the impulse - it moves position only, never velocity, so it
can't quietly leak energy into the system.

Collision detection is a naive O(n²) pair sweep. At the field's population (see below)
that's a few thousand distance checks a frame, measured at a fraction of a millisecond -
cheaper than the trail rendering by a wide margin, so a spatial hash would be solving a
problem that doesn't exist yet.

## Health, cracks, and critical hits

Every comet has health scaled to its mass, so bigger comets survive more punishment.
Damage from a collision scales with the *other* comet's mass and the shared impact
speed - a heavy comet barely feels hitting a light one, but a light comet takes a real
beating from a heavy one, the same asymmetry a real mass mismatch produces.

A hard enough hit (above a minimum impact speed) leaves a crack: a unit direction vector
stored on the comet, re-projected onto its current position and radius every frame so it
travels and scales with the comet rather than being baked into fixed pixel coordinates.
A second hit landing within the crack's threshold - a single dot product against a
cosine cutoff, no trigonometry - is a **critical hit**: it deepens the existing crack
instead of adding a new one, and deals a damage multiplier.

The whole event graph escalates in distinct tiers, each mapped to its own visual effect
(next section), and death always pre-empts a lesser effect - a comet that just ended
doesn't also flash a "we touched" bounce puff on the way out.

## The effect tiering

Four death effects and one non-lethal one, each with a dedicated array and cap so a busy
cluster of one type can never starve another's budget:

| Event | Effect |
|---|---|
| Ordinary bounce (no crit, no death) | A handful of small sparks at the true contact point - scaled down from a cursor kill's own spark spray rather than an invented separate effect |
| Non-lethal crit | A small shockwave ring: expanding arc, radial shards, a brief white-hot core |
| Comet-vs-comet death | The ordinary pop plus the small shockwave - being destroyed by an impact should look like an impact |
| **Critical death** | The comet **shatters**: jagged, tumbling triangular fragments (not round sparks) flung outward, each with its own rotation and spin, plus the shockwave in its amplified form - a second trailing ring, more shards, a wider flash |
| **Cursor kill** | A **black hole**: the void punches through everything already drawn that frame via `globalCompositeOperation = 'destination-out'`, revealing the real page background rather than an approximated fill colour, so it's correct in both light and dark theme without knowing which is active. An accretion rim spins around the collapsing edge as it closes to a point |

Every death also leaves behind a **trail ghost** - a frozen, one-time copy of the dying
comet's trail buffer that fades out in place over a quarter second instead of vanishing
the instant the comet is removed from the simulation. It's a snapshot, not a reference:
it never reads the cursor position again, so it can't end up looking like it's still
being pulled toward a cursor that has since moved away.

The bounce spark spawner clamps to whatever capacity is actually free instead of
rejecting the whole spawn when the request doesn't fully fit - an early version did the
latter, which meant bounces silently stopped appearing entirely during any stretch where
their shared array ran close to full.

## Rendering performance

**The star grid** behind the comets is rendered with a counting sort instead of a naive
per-bucket scan. Each frame, every star's alpha is quantised into one of 64 buckets,
then a single prefix-sum pass turns bucket counts into contiguous run offsets, and one
more pass scatters each star's index into its bucket's run - two O(n) passes replacing
what would otherwise be either 64 buckets pre-allocated at worst-case size or a sort
call every frame. The buffers are sized to the actual star count, not
`buckets × stars`: an earlier version reserved a worst-case slot for every star in every
bucket, which held roughly 600 KB permanently to store about 1,200 star positions. The
counting-sort version holds about 15 KB for the same data - a 97.5% reduction, verified
by direct comparison against a pixel-identical reference implementation of the old
layout.

**Colour strings are cached, not rebuilt.** Each comet computes its `rgba(...)` prefix
once at spawn - colour never changes after that - instead of re-concatenating the same
string on every one of the ~60 frames a comet is drawn each second.

**The whole simulation is visibility-gated.** An `IntersectionObserver` on the hero
section, combined with the page's `visibilitychange` event, stops the animation frame
loop outright - not just fades it to invisible - the moment the canvas scrolls out of
view or the tab is backgrounded. Confirmed by instrumentation: 247 draw calls per frame
while visible, exactly zero while stopped, with zero wasted `requestAnimationFrame`
reschedules in between.

**Population scales with the hero's on-screen area**, not a fixed constant, resolved
once at first layout: a phone doesn't inherit a desktop-density field, and a large
display doesn't look sparse. Resizing the browser window afterward doesn't touch that
count - instead, every stored coordinate (comet positions, trail history, and every
in-flight effect's position) is rescaled by the same ratio the canvas itself just
resized by. Before this existed, shrinking the window from a large size down to a small
one destroyed roughly 70% of the field in a single frame - comets pushed past the
boundary by the coordinate mismatch, killed, and instantly respawned elsewhere, which
read as the whole scene reshuffling every time the window was dragged.

## Text animations

Section headings and the hero name use two on-theme intro effects, both re-triggering
whenever their element re-enters the viewport - so they replay on scroll-back, not just
on first load:

- **`power`** - each character flickers on like a segment display energising (blur, dim,
  a weak second flicker, then settle), staggered a few dozen milliseconds per glyph.
- **`decode`** - characters resolve out of scrambled terminal noise, left to right,
  restricted to monospace text only. Swapping glyphs in a proportional font changes each
  character's width and would jitter the layout every frame; monospace sidesteps that
  entirely.

Both are driven by one `IntersectionObserver` with two thresholds for hysteresis (play
at 10-15% visible, reset only at fully out of view), so a tall element can't flicker
in and out while partially on screen.

The failure mode that matters here isn't visual polish, it's *never hiding real content*.
An early version hid every character with a bare CSS rule keyed off the animation
attribute; if the observer never fired - a JS error, a browser without
`IntersectionObserver` support - the hero name and section titles stayed permanently
invisible. The fix: every hiding rule is gated behind a `.anim-ready` class that JS adds
only once it has actually taken ownership of the element, plus a `prefers-reduced-motion`
branch that skips the animation and shows plain text outright, plus a timed safety net
that force-plays anything still unplayed but visibly on screen. A script failure now
degrades to plain text, never to nothing.

## Stack

HTML5 Canvas 2D API - vanilla JavaScript (ES6+), no framework, no build step -
`IntersectionObserver` - `requestAnimationFrame` - `Float32Array` / `Int32Array` /
`Uint8Array` typed-array buffers for the hot paths - CSS custom properties and
`@keyframes` for the text-intro layer.
