# visual-test

Puppeteer-driven screenshot harness for visually inspecting the site at a
range of viewport sizes. Used while iterating on the lyfe.js cap-cell layout
breakpoints; useful any time you want to eyeball responsive behavior without
hand-resizing the browser.

## Setup

Requires Chromium at `/usr/bin/chromium` (override with `CHROMIUM=...`).

```sh
npm install
```

## Run

In one shell, start the Hugo dev server from the repo root:

```sh
hugo server
```

In another, from this directory:

```sh
npm run shots
```

Screenshots land in `./out/<width>x<height>.png`. The script also prints
viewport + `.container` geometry (right edge and right-gutter width) per size,
which is what the cap-cell layout switches on.

Override defaults via env vars:

- `URL` — page to load (default `http://localhost:1313/`)
- `CHROMIUM` — chromium binary path (default `/usr/bin/chromium`)
- `OUT` — output directory (default `./out`)

Edit `SIZES` in `screenshots.mjs` to test different viewports.
