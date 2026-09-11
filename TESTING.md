# Testing

How to run the suites and add fixtures. Roadmap context lives in
[QUALITY_PLAN.md](./QUALITY_PLAN.md).

## Unit

```bash
npm test              # vitest run, once
npm run test:watch    # vitest watch mode for local iteration
```

Unit tests live in `tests/*.test.ts` and cover `lib/` plus API routes.

## Coverage

```bash
npm run coverage      # vitest run --coverage (v8, text + lcov)
```

Gate: **>=80% on `lib/`**. Coverage config (`include: ["lib/**/*.ts"]`) is in
`vitest.config.ts`.

## E2E

```bash
npm run test:e2e      # playwright test (chromium)
```

No manual server boot needed: the Playwright config's `webServer` starts the
app automatically. The suite runs on **chromium** and covers save URL -> list ->
read `/a/[id]` -> progress resume -> delete, plus the bookmarklet
`POST {url,html}` flow.

The offline spec (`tests/e2e/offline.spec.ts`) covers the PWA shell:
`/manifest.webmanifest` + `/sw.js` served, `rel="manifest"` on `/`, `/offline`
fallback page, a cached article that still renders with the browser offline
(`context.setOffline(true)`), and library warming: an article never opened
still renders offline after the "available offline" control warms the cache.
Unit tests for the warming logic live in `tests/offline-cache.test.ts` (stubbed
fetch + storage, no browser needed). Chromium needs its system libs to launch
— if the browser won't start locally, CI's `e2e` job is the backstop.

Zero residue: the suite backs up `data/articles.json` before running and
restores it afterwards, and every run uses per-run unique URLs so parallel or
repeated runs never collide with real data.

In CI, e2e runs as a **separate `e2e` job** (Ubuntu, Node 22.x): `npm ci` ->
`npx playwright install --with-deps chromium` -> `npm run build` ->
`npm run test:e2e`. See [.github/workflows/ci.yml](./.github/workflows/ci.yml).

## Fixtures

Extract fixtures are plain HTML files in `tests/fixtures/` (e.g. `simple.html`,
`srcset-only.html`, `picture.html`).

To add one:

1. Drop `<name>.html` into `tests/fixtures/`. For Readability to parse it, wrap
   the fragment the way the existing fixtures do (or use the `articlePage(body)`
   helper in `tests/extract.test.ts` for synthetic pages).
2. Wire it into `tests/extract.test.ts` via the existing helper:
   `loadFixture("<name>")` reads `tests/fixtures/<name>.html`, then assert on
   `extractFromHtml(html, BASE)` (absolutized `href`/`src`, `target=_blank`,
   stripped `<script>`, dropped `data:`/`blob:` images, `Untitled` fallback).
3. Run `npm test` to confirm green.

## Gates

Run before pushing:

```bash
npm run typecheck      # tsc --noEmit
npm run lint           # eslint .
npm run format:check   # prettier --check .
npm run build          # next build
```

CI (`build-test` job, Node 20.x/22.x) runs typecheck -> lint -> test -> build,
plus `npm audit --audit-level=critical`. Keep all of these green; a red gate
blocks merge once branch protection is enabled.
