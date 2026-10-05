/* Page behaviour: theme switch, email, nav state, scroll reveals, text intros, work
   filters, experience durations, project modal. Loaded before hero.js, which uses the
   glyph spans the text intros create. */
(function () {
  'use strict';

  /* ===== Theme switch =====
     Dark is the default. The choice is saved, applied before first paint by the inline
     script in <head>, and announced with a 'themechange' event (hero.js recolours). */
  (function () {
    var root = document.documentElement;
    var btn  = document.getElementById('theme-toggle');
    var meta = document.querySelector('meta[name="theme-color"]');
    var icon = document.querySelector('link[rel="icon"]');
    // Tab icon follows the theme: amber bar on black, cobalt bar on white
    function favicon(bg, bar) {
      return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E" +
        "%3Crect width='32' height='32' fill='%23" + bg + "'/%3E" +
        "%3Crect x='6' y='24' width='20' height='2' fill='%23" + bar + "'/%3E%3C/svg%3E";
    }
    function sync() {
      var light = root.getAttribute('data-theme') === 'light';
      if (btn)  btn.setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
      if (meta) meta.setAttribute('content', light ? '#f5f7fa' : '#050505');
      if (icon) icon.setAttribute('href', light ? favicon('ffffff', '1d4ed8') : favicon('050505', 'FFB800'));
    }
    sync();
    if (!btn) return;
    btn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('theme', next); } catch (e) { /* private mode: still switches */ }
      sync();
      document.dispatchEvent(new Event('themechange'));
    });
  })();

  /* ===== Email =====
     The address is assembled only when someone asks for it (copy or open), to keep it
     out of scraped HTML. */
  (function () {
    var addrEl  = document.getElementById('email-addr');
    var copyBtn = document.getElementById('email-copy');
    var openBtn = document.getElementById('email-open');
    var status  = document.getElementById('email-status');
    if (!copyBtn && !openBtn) return;

    var cipher = 'AAAAAAAAAAAHBRIYCBoJBDIOHgkAGksOHQQ=';
    var resolved = '';

    function decodeMail() {
      var seed = (document.querySelector('.hero__name') || { textContent: '' }).textContent
        .toLowerCase()
        .replace(/[^a-z]/g, '');
      if (!seed) return '';
      var key = seed.slice(0, 8);
      var bytes = atob(cipher);
      var out = '';
      for (var i = 0; i < bytes.length; i++) {
        out += String.fromCharCode(bytes.charCodeAt(i) ^ key.charCodeAt(i % key.length));
      }
      return out;
    }
    function reveal() {
      if (!resolved) {
        var addr = decodeMail();
        if (!addr || addr.indexOf('@') === -1) return '';
        resolved = addr;
        if (addrEl) addrEl.textContent = resolved;
      }
      return resolved;
    }

    if (copyBtn) {
      var label = copyBtn.querySelector('span');
      var icon  = copyBtn.querySelector('use');
      var timer = 0;
      copyBtn.addEventListener('click', function () {
        var addr = reveal();
        if (!addr) return;
        var done = function (ok) {
          status.textContent = ok ? 'Email address copied.' : 'Copy failed. The address is shown above.';
          if (!ok) return;
          label.textContent = 'Copied';
          icon.setAttribute('href', '#i-check');
          clearTimeout(timer);
          timer = setTimeout(function () {
            label.textContent = 'Copy address';
            icon.setAttribute('href', '#i-copy');
          }, 2000);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(addr).then(function () { done(true); }, function () { done(false); });
        } else {
          done(false);
        }
      });
    }
    if (openBtn) {
      openBtn.addEventListener('click', function () {
        var addr = reveal();
        if (addr) window.location.href = 'mailto:' + addr;
      });
    }
  })();

  /* Nav: a solid bar once the page leaves the very top, and aria-current on the link for
     whichever section crosses a line 45% of the way down the viewport. Both come from
     IntersectionObservers, so nothing runs per scroll event. */
  (function () {
    var nav = document.getElementById('site-nav');
    if (!nav || !window.IntersectionObserver) return;

    var sentinel = document.createElement('div');
    sentinel.setAttribute('aria-hidden', 'true');
    sentinel.style.cssText = 'position:absolute;top:30px;left:0;width:1px;height:1px;pointer-events:none';
    document.body.prepend(sentinel);
    new IntersectionObserver(function (entries) {
      nav.classList.toggle('scrolled', !entries[0].isIntersecting);
    }).observe(sentinel);

    var links = {};
    nav.querySelectorAll('.nav__links a[href^="#"]').forEach(function (a) {
      links[a.getAttribute('href').slice(1)] = a;
    });
    var current = null;
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        if (current && links[current]) links[current].removeAttribute('aria-current');
        current = entry.target.id;
        if (links[current]) links[current].setAttribute('aria-current', 'true');
      });
    }, { rootMargin: '-45% 0px -55% 0px' });
    ['hero', 'about', 'projects', 'experience', 'contact'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) spy.observe(el);
    });
  })();

  /* Reveal on scroll.
     Re-triggers: the section is hidden again once it is fully out of view, so scrolling
     back up replays it. Two thresholds give hysteresis - reveal at 10% visible, but only
     reset at 0% - otherwise a tall section would fade out while still partly on screen. */
  var revealObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.intersectionRatio >= 0.1) entry.target.classList.add('visible');
      else if (entry.intersectionRatio === 0) entry.target.classList.remove('visible');
    });
  }, { threshold: [0, 0.1], rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('.reveal').forEach(function (el) { revealObserver.observe(el); });

  /* Text intro animations.
     Splits marked elements into per-character spans once, then plays/resets them as they
     enter and leave the viewport. Same hysteresis as above so partly-visible text does
     not thrash. Falls back to plain visible text when reduced motion is requested. */
  (function () {
    var reduced = window.matchMedia &&
                  window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var els = document.querySelectorAll('[data-anim]');
    if (!els.length || reduced) return;   // CSS media query already forces these visible

    var GLYPHS = '01<>[]{}()/\\|=+*#$%&_~^!?:;.';
    var active = [];       // decode jobs currently running
    var ticking = false;

    // Accessible name, built without touching layout. <br> counts as a word break.
    function labelOf(el) {
      var out = '';
      (function walk(n) {
        for (var i = 0; i < n.childNodes.length; i++) {
          var k = n.childNodes[i];
          if (k.nodeType === 3) out += k.nodeValue;
          else if (k.nodeType === 1) { if (k.tagName === 'BR') out += ' '; else walk(k); }
        }
      })(el);
      return out.replace(/\s+/g, ' ').trim();
    }

    // Wrap every character in its own span, preserving inline markup (<em>, <strong>)
    // and <br>. All char spans for one text node share a wrapper, so that flex parents
    // (.hero__eyebrow uses gap) see one child, not one per letter.
    function split(el) {
      var idx = 0;
      (function walk(node) {
        var kids = Array.prototype.slice.call(node.childNodes);
        for (var i = 0; i < kids.length; i++) {
          var n = kids[i];
          if (n.nodeType === 3) {
            var text = n.nodeValue;
            if (!/\S/.test(text)) continue;
            var wrap = document.createElement('span');
            wrap.className = 'anim-wrap';
            wrap.setAttribute('aria-hidden', 'true');
            for (var c = 0; c < text.length; c++) {
              var sp = document.createElement('span');
              sp.className = 'anim-char';
              sp.textContent = text[c];
              sp.setAttribute('data-c', text[c]);
              sp.style.setProperty('--i', idx++);
              wrap.appendChild(sp);
            }
            node.replaceChild(wrap, n);
          } else if (n.nodeType === 1 && n.tagName !== 'BR') {
            walk(n);
          }
        }
      })(el);
      return idx;
    }

    function tick(ts) {
      for (var j = active.length - 1; j >= 0; j--) {
        var job = active[j];
        if (job.t0 === null) job.t0 = ts;
        var e = ts - job.t0;
        var done = true;
        for (var c = 0; c < job.chars.length; c++) {
          var ch  = job.chars[c];
          var fin = ch.getAttribute('data-c');
          if (!/\S/.test(fin)) { ch.classList.add('anim-set'); continue; }
          var settle = 90 + c * 38;
          if (e >= settle) {
            if (!ch._set) {
              ch._set = true;
              ch.textContent = fin;
              ch.classList.add('anim-set', 'anim-hot');
            }
            if (e < settle + 260) done = false;
            else if (ch._hot) { ch._hot = false; ch.classList.remove('anim-hot'); }
          } else {
            done = false;
            var slot = (e / 45) | 0;
            if (ch._g !== slot) {
              ch._g = slot;
              ch.textContent = GLYPHS.charAt((Math.random() * GLYPHS.length) | 0);
            }
          }
        }
        if (done) active.splice(j, 1);
      }
      if (active.length) requestAnimationFrame(tick);
      else ticking = false;
    }

    function play(el) {
      if (el._anim) return;
      el._anim = true;
      el.classList.add('anim-play');
      if (el.getAttribute('data-anim') !== 'decode') return;
      var chars = el.querySelectorAll('.anim-char');
      for (var i = 0; i < chars.length; i++) {
        chars[i]._set = false; chars[i]._hot = true; chars[i]._g = -1;
        chars[i].classList.remove('anim-set', 'anim-hot');
      }
      active.push({ el: el, chars: chars, t0: null });
      if (!ticking) { ticking = true; requestAnimationFrame(tick); }
    }

    function reset(el) {
      if (!el._anim) return;
      el._anim = false;
      el.classList.remove('anim-play');
      for (var j = active.length - 1; j >= 0; j--) if (active[j].el === el) active.splice(j, 1);
      var chars = el.querySelectorAll('.anim-char');
      for (var i = 0; i < chars.length; i++) {
        chars[i].classList.remove('anim-set', 'anim-hot');
        chars[i].textContent = chars[i].getAttribute('data-c');
      }
    }

    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.getAttribute('data-anim') !== 'fade') {          // fade is whole-block
        var label = labelOf(el);
        split(el);
        if (label) {
          // Screen readers read this instead of the per-character spans, which are hidden
          var sr = document.createElement('span');
          sr.className = 'sr-only';
          sr.textContent = label;
          el.insertBefore(sr, el.firstChild);
        }
      }
      el.classList.add('anim-ready');   // only now may CSS hide it
    }

    // No IntersectionObserver: show everything rather than animate it.
    if (!window.IntersectionObserver) {
      for (var n = 0; n < els.length; n++) play(els[n]);
      return;
    }

    var animObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.intersectionRatio >= 0.15) play(entry.target);
        else if (entry.intersectionRatio === 0) reset(entry.target);
      });
    }, { threshold: [0, 0.15] });
    for (var k = 0; k < els.length; k++) animObserver.observe(els[k]);

    // Safety net: if the observer has not reported on an element that is plainly in
    // view, play it anyway. Hidden text is a far worse outcome than a missed animation.
    setTimeout(function () {
      for (var m = 0; m < els.length; m++) {
        if (els[m]._anim) continue;
        var r = els[m].getBoundingClientRect();
        if (r.bottom > 0 && r.top < window.innerHeight) play(els[m]);
      }
    }, 1200);
  })();

  /* ===== Experience: role lengths =====
     Computed from each role's start month, so "Present" roles never show a stale count.
     Counted inclusively, the way LinkedIn does (Jun 2022 to Jun 2023 is 1 yr 1 mo). */
  (function () {
    var now = new Date();
    document.querySelectorAll('.tl-dur[data-from]').forEach(function (el) {
      var from = el.getAttribute('data-from').split('-');
      var to   = el.getAttribute('data-to');
      var end  = to ? to.split('-') : [now.getFullYear(), now.getMonth() + 1];
      var months = (end[0] - from[0]) * 12 + (end[1] - from[1]) + 1;
      if (!(months > 0)) return;
      var y = Math.floor(months / 12), m = months % 12, parts = [];
      if (y) parts.push(y + (y === 1 ? ' yr' : ' yrs'));
      if (m) parts.push(m + (m === 1 ? ' mo' : ' mos'));
      el.textContent = parts.join(' ');
    });
  })();

  /* ===== Work filters =====
     Counts come from the cards' data-domains, so they can never drift from the grid. A
     filtered view drops the bento layout for a uniform grid (.is-filtered in the CSS). */
  var grid = document.getElementById('projects-grid');
  (function () {
    var buttons  = document.querySelectorAll('.filter');
    var statusEl = document.getElementById('filter-status');
    if (!grid || !buttons.length) return;
    var cards = Array.prototype.slice.call(grid.querySelectorAll('.project-card'));
    function matches(card, f) {
      return f === 'all' || (' ' + (card.dataset.domains || '') + ' ').indexOf(' ' + f + ' ') !== -1;
    }
    buttons.forEach(function (btn) {
      var f = btn.dataset.filter;
      var n = cards.filter(function (c) { return matches(c, f); }).length;
      var countEl = btn.querySelector('.filter__count');
      if (countEl) countEl.textContent = n;
      btn.addEventListener('click', function () {
        buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b === btn)); });
        var shown = 0;
        cards.forEach(function (c) {
          var on = matches(c, f);
          c.hidden = !on;
          if (on) shown++;
        });
        grid.classList.toggle('is-filtered', f !== 'all');
        if (statusEl) statusEl.textContent = shown + (shown === 1 ? ' project' : ' projects') + ' shown';
      });
    });
  })();

  /* ===== Project modal =====
     Each card's write-up lives in projects/<slug>.md and is rendered into the panel.
     Nothing is fetched until someone shows interest: hovering or focusing a card warms its
     write-up and the markdown renderer, so opening it is still instant. The panel is
     `inert` while closed, so it can never take focus or be read out while invisible.
     Opening one sets #work/<slug> in the URL, so a write-up can be linked. */
  var backdrop  = document.getElementById('modal-backdrop');
  var panel     = document.getElementById('modal-panel');
  var titleEl   = document.getElementById('modal-title');
  var ghLink    = document.getElementById('modal-gh');
  var tagsEl    = document.getElementById('modal-tags');
  var bodyEl    = document.getElementById('modal-body');
  var loadingEl = document.getElementById('modal-loading');
  var mdEl      = document.getElementById('modal-md');
  if (!grid || !panel) return;

  var mdCache   = {};
  var opener    = null;   // element to hand focus back to on close
  var openSlug  = '';
  var HASH_PREFIX = '#work/';

  // Third-party renderers, pinned with SRI and loaded on first use
  var MARKED_SRC  = 'https://cdn.jsdelivr.net/npm/marked@13.0.3/marked.min.js';
  var MARKED_SRI  = 'sha384-YTBHtsL8yVTHcLakYNyrOfK3K+QQcXiECuaALJ+3j7Mo681Rtzadt8NR6WrZH+eQ';
  var MERMAID_SRC = 'https://cdn.jsdelivr.net/npm/mermaid@12.1.0/dist/mermaid.min.js';
  var MERMAID_SRI = 'sha384-EbBpjO7rlR6eqZEcG7GaPpyk9H9WrMyPWX4d3KvPYltgt8Z8l0z6R56B1qP40pR4';
  var scriptLoads = {};
  function loadScript(src, sri) {
    if (scriptLoads[src]) return scriptLoads[src];
    scriptLoads[src] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.integrity = sri;
      s.crossOrigin = 'anonymous';
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { delete scriptLoads[src]; reject(new Error('failed to load ' + src)); };
      document.head.appendChild(s);
    });
    return scriptLoads[src];
  }

  /* Relative image paths in the markdown (e.g. "images/slug/foo.png") are relative to
     projects/, not to this page. */
  var markedConfigured = false;
  function configureMarked() {
    if (markedConfigured) return;
    marked.use({
      gfm: true,
      breaks: false,
      walkTokens: function (token) {
        if (token.type === 'image' && typeof token.href === 'string' &&
            !/^([a-z][a-z0-9+.-]*:)?\/\//i.test(token.href) &&
            token.href.charAt(0) !== '/') {
          token.href = 'projects/' + token.href;
        }
      }
    });
    markedConfigured = true;
  }

  function fetchMd(slug) {
    if (mdCache[slug]) return Promise.resolve(mdCache[slug]);
    return fetch('projects/' + slug + '.md')
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.text();
      })
      .then(function (text) { mdCache[slug] = text; return text; });
  }

  // Write-up text plus the renderer. A renderer that fails to load is not fatal:
  // renderMd falls back to showing the raw markdown.
  function prepare(slug) {
    return fetchMd(slug).then(function (text) {
      return loadScript(MARKED_SRC, MARKED_SRI).then(function () { return text; }, function () { return text; });
    });
  }

  function warm(e) {
    var card = e.target.closest && e.target.closest('.project-card');
    if (!card || card._warm) return;
    card._warm = true;
    fetchMd(card.dataset.slug).catch(function () { card._warm = false; });
    loadScript(MARKED_SRC, MARKED_SRI).catch(function () { /* retried on open */ });
  }

  /* ```mermaid blocks render as diagrams, the same way GitHub shows them. Colours come
     from the page's own tokens, so diagrams follow the light/dark theme. If Mermaid fails
     to load, the diagram source stays visible as plain text. */
  var mermaidTheme = '';
  function mermaidConfig() {
    var cs = getComputedStyle(document.documentElement);
    var v = function (name) { return cs.getPropertyValue(name).trim(); };
    var mono = '"JetBrains Mono", monospace';
    return {
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      fontFamily: mono,
      // SVG text labels: measured and drawn by the same engine, so the page's own
      // typography (line-height, text-wrap) can never clip a label
      htmlLabels: false,
      flowchart: { curve: 'basis', padding: 12, htmlLabels: false, wrappingWidth: 240 },
      themeVariables: {
        darkMode: document.documentElement.getAttribute('data-theme') !== 'light',
        fontFamily: mono,
        fontSize: '13px',
        background: v('--bg'),
        primaryColor: v('--surface-2'),
        primaryTextColor: v('--text'),
        primaryBorderColor: v('--line-strong'),
        secondaryColor: v('--surface'),
        tertiaryColor: v('--surface'),
        nodeTextColor: v('--text'),
        textColor: v('--text-dim'),
        lineColor: v('--text-mute'),
        clusterBkg: v('--surface'),
        clusterBorder: v('--line-strong'),
        titleColor: v('--accent-ink'),
        edgeLabelBackground: v('--bg'),
        xyChart: {
          backgroundColor: v('--bg'),
          titleColor: v('--text'),
          xAxisLabelColor: v('--text-dim'), yAxisLabelColor: v('--text-dim'),
          xAxisTitleColor: v('--text-dim'), yAxisTitleColor: v('--text-dim'),
          xAxisLineColor: v('--line-strong'), yAxisLineColor: v('--line-strong'),
          xAxisTickColor: v('--line-strong'), yAxisTickColor: v('--line-strong'),
          plotColorPalette: v('--accent')
        }
      }
    };
  }

  function renderDiagrams(slug) {
    var nodes = [];
    mdEl.querySelectorAll('pre > code.language-mermaid').forEach(function (code) {
      var div = document.createElement('div');
      div.className = 'mermaid-diagram';
      div.textContent = code.textContent;
      code.parentNode.replaceWith(div);
      nodes.push(div);
    });
    if (!nodes.length) return;
    loadScript(MERMAID_SRC, MERMAID_SRI)
      .then(function () {
        if (openSlug !== slug) return;
        var t = document.documentElement.getAttribute('data-theme');
        if (t !== mermaidTheme) { window.mermaid.initialize(mermaidConfig()); mermaidTheme = t; }
        return window.mermaid.run({ nodes: nodes });
      })
      .catch(function () {
        nodes.forEach(function (n) { n.classList.add('mermaid-diagram--source'); });
      });
  }

  function renderMd(text) {
    loadingEl.hidden = true;
    mdEl.textContent = '';
    if (typeof marked !== 'undefined') {
      // marked only ever parses this repo's own static files - no user input reaches it.
      configureMarked();
      mdEl.innerHTML = marked.parse(text);
      mdEl.querySelectorAll('img').forEach(function (img) {
        img.loading = 'lazy';
        img.decoding = 'async';
      });
    } else {
      var pre = document.createElement('pre');
      pre.style.whiteSpace = 'pre-wrap';
      pre.textContent = text;
      mdEl.appendChild(pre);
    }
    bodyEl.scrollTop = 0;
  }

  function openModal(card) {
    var slug = card.dataset.slug || '';
    if (!slug) return;
    openSlug = slug;
    var active = document.activeElement;
    opener = active && active !== document.body ? active : card.querySelector('.project-card__open');

    titleEl.textContent = card.querySelector('.project-card__title').textContent.trim();
    var repo = card.dataset.github;
    ghLink.hidden = !repo;
    if (repo) ghLink.href = repo;

    tagsEl.textContent = '';
    card.querySelectorAll('.tag').forEach(function (t) {
      var li = document.createElement('li');
      li.className = 'tag';
      li.textContent = t.textContent;
      tagsEl.appendChild(li);
    });

    loadingEl.hidden = false;
    mdEl.textContent = '';
    backdrop.classList.add('is-open');
    panel.classList.add('is-open');
    panel.inert = false;
    document.body.style.overflow = 'hidden';
    history.replaceState(null, '', HASH_PREFIX + slug);
    document.getElementById('modal-close').focus({ preventScroll: true });

    prepare(slug).then(function (text) {
      if (openSlug !== slug) return;
      renderMd(text);
      renderDiagrams(slug);
    }, function () {
      if (openSlug === slug) {
        renderMd('# ' + titleEl.textContent + '\n\nThe write-up could not be loaded. Check your connection and try again.');
      }
    });
  }

  function closeModal() {
    if (!openSlug) return;
    openSlug = '';
    backdrop.classList.remove('is-open');
    panel.classList.remove('is-open');
    panel.inert = true;
    document.body.style.overflow = '';
    history.replaceState(null, '', '#projects');
    if (opener && opener.focus) opener.focus({ preventScroll: true });
    opener = null;
  }

  // Keep Tab inside the open dialog
  function trapFocus(e) {
    var f = panel.querySelectorAll('a[href]:not([hidden]), button:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // The title button's ::after covers the card, so its click is the card's click
  grid.addEventListener('click', function (e) {
    var btn = e.target.closest('.project-card__open');
    if (btn) openModal(btn.closest('.project-card'));
  });
  // Hover must dwell briefly, so a cursor merely crossing the grid fetches nothing
  var warmTimer = 0;
  grid.addEventListener('pointerover', function (e) {
    clearTimeout(warmTimer);
    warmTimer = setTimeout(function () { warm(e); }, 120);
  }, { passive: true });
  grid.addEventListener('pointerleave', function () { clearTimeout(warmTimer); });
  grid.addEventListener('focusin', warm);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  backdrop.addEventListener('click', closeModal);
  document.addEventListener('keydown', function (e) {
    if (!openSlug) return;
    if (e.key === 'Escape') closeModal();
    else if (e.key === 'Tab') trapFocus(e);
  });
  // An open write-up re-renders on a theme switch so its diagrams pick up the new colours
  document.addEventListener('themechange', function () {
    var slug = openSlug;
    if (!slug || !mdCache[slug]) return;
    renderMd(mdCache[slug]);
    renderDiagrams(slug);
  });

  // Deep link: #work/<slug> opens that write-up, on load or when the hash changes
  function openFromHash() {
    if (location.hash.indexOf(HASH_PREFIX) !== 0) return;
    var slug = decodeURIComponent(location.hash.slice(HASH_PREFIX.length));
    var linked = grid.querySelector('[data-slug="' + CSS.escape(slug) + '"]');
    if (!linked || slug === openSlug) return;
    linked.scrollIntoView({ block: 'center' });
    openModal(linked);
  }
  window.addEventListener('hashchange', openFromHash);
  openFromHash();
}());
