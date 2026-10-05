# portfolio

Personal portfolio for Rishi Vemulapalli. A static site with no build step, deployed to
GitHub Pages on every push to `main` (`.github/workflows/static.yml`).

```
index.html            page markup
assets/css/main.css   all styles; design tokens (dark default, light) at the top
assets/js/main.js     theme switch, nav, reveals, text intros, filters, project modal
assets/js/hero.js     hero particle engine
assets/fonts/         self-hosted latin woff2 subsets (Bebas Neue, DM Sans, JetBrains Mono)
projects/<slug>.md    one write-up per project card, rendered in the modal
projects/images/      images referenced by the write-ups
```

## Adding a project

1. Write `projects/<slug>.md`. A leading `<!-- date: ... -->` comment is optional, kept as a
   note for yourself; nothing reads it.
2. Add an `<article class="project-card">` to the projects grid in `index.html`, in
   order: featured first, then active projects A-Z, then newest first by date (A-Z on
   ties), then undated. Set:
   - `data-slug`: the write-up's file name
   - `data-domains`: any of `ml`, `hardware`, `systems`, `graphics`, for the filters
   - `data-github`: only if the code is public; the modal hides its code link otherwise
3. Check the grid still fills every row in that order. The grid does not back-fill, so pick
   wide cards (`project-card--wide`, two columns) so that each row of 3 columns is one wide
   plus one single card. At 2 columns only the featured card and `project-card--wide-md`
   stay wide, and the cells must total an even number.

## Performance notes

- No third-party request at page load: fonts are self-hosted, and the markdown renderer
  (marked) and diagram renderer (Mermaid) load from jsDelivr only when a write-up is opened,
  pinned with SRI hashes.
- A write-up is fetched when its card is hovered or focused, so opening it is instant.
- Sections below the fold use `content-visibility: auto`.
- The hero canvas stops when it is off screen or the tab is hidden, and renders one still
  frame under `prefers-reduced-motion`.
- The inline theme script in `<head>` is allow-listed in the CSP by its SHA-256 hash. If you
  change that line, update the hash in the CSP meta tag.

## Running locally

The modal fetches the markdown files, so serve the folder rather than opening the file:

```bash
npx serve .
```
