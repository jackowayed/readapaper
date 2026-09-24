# Backlog — pending ideas (consolidated 2026-09-24)

Single list of everything unearthed but not yet built. Sources: bug-hunter
sweep + Instapaper gap analysis + test-health check (2026-09-23 factory
recon), minus shipped items and owner-deprioritized ones (tags/folders,
highlights+notes — see `docs/factory-questions.md`, do not schedule).
Big extensions also appear in `DESIGN.md` §9; ops leftovers in
`QUALITY_PLAN.md`. This file is the ranked "what's next" list.

## Bugs still open

- [x] ~~P1 — Offline replay loses offsets~~ — DONE 2026-09-24 (`574069c`):
      `OfflineSupport` flushes via `sendOffset` + `getTextLength`
      (`lib/offline-flush.ts`), legacy fraction fallback preserved.
- [ ] **P1 — DNS-rebinding / lookup-time guard.** SSRF blocklist validates
      URL strings, but a hostname resolving to a private IP at fetch time
      (rebinding, internal DNS) is unchecked. Needs resolve-then-validate or
      dial-guard. Medium.
- [ ] **P1 — Rate-limit trust.** `x-forwarded-for` first-entry convention is
      spoofable without a trusted-proxy config. Revisit when deployed behind
      known proxies. Small.
- [ ] **Suspect — legacy migration math** (`lib/store.ts` readAll backfill).
      Flagged by bug-hunter, never reproduced. Needs a repro test. Small.
- [ ] **Suspect — Kindle reuses legacy `html` unescaped.** Rows written
      before server-side sanitize could carry unsanitized HTML into
      `compileKindleHtml`. Verify + test. Small.
- [ ] **Suspect — offline warmer fan-out.** `lib/offline-cache.ts`
      `Promise.allSettled` over all articles is unbounded. Cap concurrency.
      Small.

## Features (ranked by user value, effort in parens)

- [ ] **Bulk edit / multiselect** (M). Checkbox UI + `POST /api/articles/bulk`
      for archive/like/trash/delete N at once. Highest-value remaining
      library feature.
- [ ] **CSV import/export + email-to-save** (M). Instapaper/Pocket CSV import
      validates the bulk pipeline; export pairs with it; personal
      save-by-email address after that.
- [ ] **EPUB/PDF/RSS export, PDF upload** (M). Per-list bundles
      (`lib/export.ts` + `GET /api/export?format=`); Kindle-send exists as
      the pattern to copy.
- [ ] **Reading stats / time-left / dictionary** (S). Est. time left in
      reader, lookup popup; `% read` + minutes already in the list.
- [ ] **Pagination / list virtualization** (S). `?limit=&cursor=`; library
      currently loads everything.
- [ ] **Kindle digests (scheduled)** (S-M). Daily/weekly auto-send cron on
      top of `lib/kindle.ts`; manual batch-send exists.
- [ ] **Speed reading (RSVP)** (S). 1-word-at-a-time mode in
      `SyncedReader.tsx`; rate control exists.
- [x] ~~TTS playlist + server voices~~ (M-L) — owner: no server voices.
      Shipped Web Speech article queue instead, DONE 2026-09-24 (`f02a8b7`):
      `lib/listen-queue.ts` (localStorage order), `/listen` continuous-play
      player, per-article "Add to queue" + queue count link. Follow-ups:
      "Play next" per-article entry point, real-device iOS speak-chaining
      check, spurious-`onEnded` generation counter (see crew notes).
- [x] ~~Voice customization~~ — DONE 2026-09-24 (`29f4206`): pitch control
      (0.5–2, persisted per-browser, applies mid-play), voice preview
      button, honest iOS note (downloaded voices like Ava are not exposed
      to web apps by Apple — platform restriction, no workaround).
- [ ] **Browser extension / share sheet / mobile** (L). Bookmarklet covers
      desktop; share-target in the PWA manifest is the cheap mobile step.
- [ ] **Videos, Kobo/ereader sync, public folders** (L). Needs multi-user +
      auth first (`DESIGN.md` §9).

## Ops / hygiene

- [ ] Branch protection requiring CI green (repo settings — owner action).
- [ ] Next 16 + readability 0.6 upgrades (unblocks the 1 `high` audit
      finding; then tighten `npm audit` gate from `critical` to `high`).
- [ ] `next`/`react` version-pin decision.
- [ ] Sentry (host-only logging exists; see `DESIGN.md` §9 Ops).
