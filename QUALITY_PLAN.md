# Readapaper — Quality Plan (v0)

Goal: lock current behavior with tests + gates before adding features. Single-user local app, JSON file store, Web Speech TTS.

Baseline (2026-09-11):

- No unit/e2e tests, `scripts/` empty.
- `lint: next lint` is dead on Next 15; `next.config.mjs` has `eslint.ignoreDuringBuilds: true`, so nothing blocks bad code.
- No `typecheck` / `format` / `test` scripts, no CI workflow.
- Known risks: SSRF redirect bypass (only initial URL checked), concurrent `data/articles.json` writes can lose data, CORS `*` on `POST /api/articles` is intentional for bookmarklet but untested.

How to use this file: check off boxes as work lands. Keep in sync with `DESIGN.md §9 Ops` + `§10 Task list` per `AGENTS.md`.

## P0 — Lock behavior (do first, ~half day)

### Unit suite (`vitest`)

- [x] Add `vitest` + `test`, `test:watch`, `coverage` scripts to `package.json`
- [x] `lib/text.ts` — `splitSentences` offsets/empty/fallback, `splitWords`/`countWords`, `readingMinutes` clamp to >=1
- [x] `lib/extract.ts` — `assertSafeHttpUrl` blocks `localhost`, `127./10./192.168./169.254.`, `metadata.google.internal`, non-http; allows normal URLs
- [x] `lib/extract.ts` — `extractFromHtml` fixtures in `tests/fixtures/`: simple article, srcset-only `<img>`, `data-src` lazy, `<picture><source>`, `data:/blob:` drop, `<script>` strip, `href/src` absolutize + `target=_blank`, `Untitled` fallback, empty HTML throws
- [x] `lib/store.ts` — `normalizeUrl` (hash strip, trailing slash), dedup `createArticle` returns `created:false`, sort desc, `updateProgress` clamps `0..1`, `delete` missing -> `false`, corrupt JSON -> `[]`/throw
- [x] `lib/bookmarklet.ts` — `buildBookmarklet` injects base, strips trailing slash, `javascript:` prefix
- [x] Routes — `POST /api/articles` url vs `{url,html}` paths, `400/422/201/200`, CORS headers; `GET [id]` `404`; `DELETE` `204/404`; `PUT progress` validation + clamp
- [x] Acceptance: `npm test` green, coverage >=80% on `lib/`

### Lint / type / format gates

- [x] Replace `next lint` with `eslint .` (`eslint-config-next` + `typescript-eslint` + hooks); fix all findings
- [x] Add `typecheck: tsc --noEmit`; enable `noUnusedLocals`, `noUncheckedIndexedAccess` in `tsconfig.json`
- [x] Add `prettier --check` + `format:fix`; format repo once
- [x] Flip `next.config.mjs: eslint.ignoreDuringBuilds` back to `false`
- [x] Add `husky + lint-staged` pre-commit running typecheck/lint/format on staged files
- [x] Acceptance: `npm run typecheck && npm run lint && npm run format:check && npm run build` all green

### CI

- [x] Add `.github/workflows/ci.yml`: `npm ci` (Node 20/22) -> typecheck -> lint -> `vitest run` -> `next build`
- [ ] Enable branch protection (require CI green)
- [x] Acceptance: red PR cannot merge; green on main

## P1 — Correctness fixes (needs tests from P0)

- [x] SSRF: validate every `res.url`/hop after redirects in `extractFromUrl` (manual loop, max 5, per-hop `assertSafeHttpUrl`); block `0.0.0.0`, `::`, decimal/octal IP forms; strict content-type allowlist + Content-Length/streaming 5MB caps — DONE 2026-09-23 (`18e0748`, `lib/extract.ts` + `tests/extract.test.ts`, 74 extract tests). Still open: DNS-rebinding lookup-time guard.
- [x] Store durability: in-process write mutex/queue in `lib/store.ts` to stop concurrent `POST` loss — DONE 2026-09-23 (`0176cf6`, `withLock` over create/delete/progress/archive; like/trash wrapped at merge `ae5444f`; concurrent-save repro tests). Corrupt-JSON backup-and-reset recovery included. Row validation via `zod` `ArticleSchema` in `readAll` (non-object rows ignored, invalid rows quarantined + logged) and `ArticleSchema.parse` assert on constructed rows — DONE 2026-09-24 (`lib/schemas.ts`, `tests/schemas.test.ts` + quarantine tests in `tests/store.test.ts`).
- [x] Request validation: `zod` for `POST /api/articles` (`SaveBodySchema`), `POST /api/extract` (`ExtractBodySchema`), `PUT progress` (`ProgressBodySchema`, offset-canonical + legacy fraction) and archive/like/trash toggles — DONE 2026-09-24. Legacy 400 messages preserved ("Provide url or html", "Missing url/progress/archived/liked/deleted"); size caps (10MB html → 422) and `assertSafeHttpUrl` stay downstream of parsing. (Non-object bodies that used to 500 now 400.)
- [x] Acceptance: concurrent-save repro test passes; SSRF bypass tests pass; schema suite 16/16 + route/store validation cases green.

## P2 — E2E + ops hygiene

- [x] `playwright`: save URL -> list -> read `/a/[id]` -> progress resume -> delete; bookmarklet `POST {url,html}` -> `200/201` flow
- [x] Document CORS `*` on `POST /api/articles` (bookmarklet requirement) in `DESIGN.md §4`; add rate-limit (30/min/IP on both POSTs) + test
- [x] Add `Dependabot` + `npm audit` in CI (`critical` gate — 1 high from postcss-via-Next needs a breaking Next major; tighten to `high` after upgrade); `next`/`react` pin decision still open (see follow-ups)
- [x] Add minimal observability: `console.error` with route + url host on `422/500`, Sentry TODO per `DESIGN.md §9 Ops`
- [x] Add `TESTING.md`: `npm test`, `npx playwright test`, fixtures, gates
- [x] Acceptance: `npm run test:e2e` green locally (4/4, CI runs it as a separate job); `DESIGN.md §9 Ops` E2E item checked off

## Commands (target state)

```bash
npm test              # vitest run
npm run typecheck     # tsc --noEmit
npm run lint          # eslint .
npm run format:check  # prettier --check .
npm run build         # next build
npx playwright test   # e2e
```

## Log

- [x] 2026-09-11: plan created — no code changed, `DESIGN.md` sync N/A (docs-only).
- [x] 2026-09-11: P0 done — 79/79 vitest pass (~95% stmts on `lib/`), typecheck/lint/format/build green, CI added. Verified: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, `npm run build`. Remaining: branch protection (repo settings), P1 SSRF-redirect + store mutex/zod, P2 Playwright/rate-limit/Dependabot. Note: `target=_blank` set in `absolutizeUrls` is stripped by DOMPurify allowlist — decide to allowlist or remove (see P1).
- [x] 2026-09-11: P2 done — Playwright e2e 4/4 green locally + separate CI job, 30 req/min/IP limits on both POSTs (13 unit tests), `console.error` host-only logging, Dependabot weekly + `npm audit --audit-level=critical` in CI, `TESTING.md`. Verified: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test` (92/92), `npm run build`, `npm run test:e2e` (4/4). Remaining: branch protection (repo settings), P1 SSRF-redirect + store mutex/zod, Next 16 + readability 0.6.0 upgrades (1 high audit finding), `next`/`react` pin decision.
- [x] 2026-09-23: factory batch — P1 SSRF-redirect + store mutex land, plus library search/sort + starred/trash. Verified on merged main: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test` (286/286), `npm run build`, `npm run test:e2e` (20/20), coverage 90.6% stmts on `lib/`. Remaining P1: DNS-rebinding guard, `zod` request/store validation; plus branch protection, Next 16 + readability upgrades.
- [x] 2026-09-24: P1 validation done — `zod@4` (`lib/schemas.ts`): request bodies (extract/save/progress/archive/like/trash) + stored-row schema (quarantine + `createArticle` assert). Verified: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test` (309/309), `npm run build`, coverage 91.0% stmts on `lib/`. Remaining: branch protection (repo settings), DNS-rebinding guard, Next 16 + readability upgrades.
