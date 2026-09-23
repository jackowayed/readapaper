# Backlog — pending ideas (consolidated 2026-09-24)

Single list of everything unearthed but not yet built. Sources: bug-hunter
sweep + Instapaper gap analysis + test-health check (2026-09-23 factory
recon), minus shipped items and owner-deprioritized ones (tags/folders,
highlights+notes — see `docs/factory-questions.md`, do not schedule).
Big extensions also appear in `DESIGN.md` §9; ops leftovers in
`QUALITY_PLAN.md`. This file is the ranked "what's next" list.

## Bugs still open

- [ ] **P1 — Offline replay loses offsets.** `components/OfflineSupport.tsx`
      flushes the progress queue with a fraction-only sender, downgrading
      canonical char-offsets (`lib/offline-queue.ts` supports an offset
      sender). Fix: pass the offset sender. Small.
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
- [ ] **TTS playlist + server voices** (M-L). Queue N articles, continuous
      play; blocked on server TTS audio (see `DESIGN.md` §9 Server TTS).
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
