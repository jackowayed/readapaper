# Unified reading/listening progress — execution plan

Status: **planned, not implemented**. Decisions below come from the 2026-09-12
Q&A (unified position, char-offset canonical, silent restore, seamless handoff).
This doc is the build spec: an agent should be able to execute phases 0–5 in
order, running the gates listed in each phase, and flag the review items in §8
instead of guessing.

## 0. Decisions (locked)

- **Unified position.** Reading and listening share one canonical position per
  article. Last-writer-wins; no per-mode branches in v1.
- **Canonical unit: char offset into `article.text`.** The legacy `progress`
  fraction (0..1) stays as a derived mirror for the library list and for
  scroll restore, computed as `offset / max(1, text.length)`.
- **Silent restore only.** Mount restores scroll/highlight position. No resume
  banner, no finished/done state, no library progress-bar changes in this
  milestone.
- **Seamless handoff.** Toggling Read ↔ Listen preserves the anchor: TTS starts
  at the last read offset, and switching back to Read scrolls to the last
  listen offset.

## 1. Data model

```ts
type Article = {
  // ...existing fields...
  progress: number; // DERIVED mirror: offset / max(1, text.length), kept for list UI + back-compat
  progressOffset: number; // CANONICAL char offset into `text`
  progressUpdatedAt: string | null; // ISO, last-writer-wins marker
};
```

- `ArticleSummary` gains `progressOffset` (small int; lets future list UI avoid
  loading full text).
- Migration for existing rows: `progressOffset = Math.round(progress *
text.length)`, `progressUpdatedAt = null`. Do it lazily in `readAll()` (fill
  missing fields on load, no separate script) so old `data/articles.json`
  files keep working.
- Clamp rule everywhere: `offset = clamp(round(offset), 0, text.length)`;
  empty text → offset 0, fraction 0.

## 2. Store (`lib/store.ts`)

- New `updateProgressOffset(id, offset)` → sets canonical offset, recomputes
  `progress` fraction, stamps `progressUpdatedAt = now`. Returns the updated
  `{ offset, progress }` or `null` when missing.
- Keep legacy `updateProgress(id, fraction)` working: convert via
  `fractionToOffset(fraction, text.length)` and delegate, so old clients and
  queued entries don't break.
- `toSummary()` includes `progressOffset`.
- Unit tests (`tests/store-progress.test.ts` or extend existing store tests):
  offset write recomputes fraction, clamping at both ends, legacy fraction
  path round-trips, migration backfill for rows missing the new fields.

## 3. API (`app/api/articles/[id]/progress/route.ts`)

- `PUT` accepts `{ offset: number }` (canonical, wins when both present) or
  legacy `{ progress: number }`. Both optional; 400 when neither is a number.
- Validation: finite numbers only, clamp server-side against `text.length`.
- Response: `{ ok: true, offset, progress }` (both canonical + mirror so the
  client never has to recompute).
- Unchanged: 404 for unknown id, existing 30 req/min/IP limiter, host-only
  error logging.
- Route tests (`tests/routes.test.ts` or new `tests/progress-route.test.ts`):
  offset write + response shape, legacy fraction still accepted, 400 on
  missing/non-numeric, 404 on unknown id, clamping above `text.length`.

## 4. Mapping helpers (`lib/progress-sync.ts`, new, pure + unit-tested)

```ts
clampOffset(offset: number, textLength: number): number;
offsetToFraction(offset: number, textLength: number): number;
fractionToOffset(fraction: number, textLength: number): number;
```

- v1 mapping is **pure arithmetic** — no DOM anchors. Rationale: read mode
  renders sanitized HTML while TTS consumes plain `text`; exact HTML↔text
  alignment needs markers we don't have yet. `fraction * text.length` is
  coarse but predictable, and exactness matters most on the listen side
  (which already speaks in offsets).
- Upgrade path (explicitly out of scope): inject stable `data-pos` paragraph
  anchors at sanitize time and resolve scroll via IntersectionObserver.
- Unit tests (`tests/progress-sync.test.ts`): empty text, clamping, round-trip
  `offset → fraction → offset` within ±1 char, NaN handling.

## 5. Client wiring

### 5.1 Ownership: `components/ReaderClient.tsx`

- Owns `const [offset, setOffset] = useState(article.progressOffset ?? 0)`.
- Read mode gets `offset` for initial scroll + an `onPosition(offset)` callback
  fired (throttled) from scroll.
- Listen mode gets `startOffset={offset}` + the same `onPosition` callback.
- Mode toggle preserves the anchor:
  - read → listen: `<SyncedReader>` starts highlighting at `offset` (no
    autoplay — browser policy; user presses Listen).
  - listen → read: after the article HTML mounts, `scrollTo(
offsetToFraction(offset, text.length) * scrollHeight)`.
- This also makes today's misleading tip ("Reading and listening share the
  same position") true; keep the copy, delete nothing else.

### 5.2 `useReadingProgress` (in `components/ThemeControl.tsx`)

- Extend (don't fork) to offset mode: accept `textLength` + `enabled`
  (only persist while in read mode) + `onPosition` passthrough.
- Behavior unchanged otherwise: restore once on mount when
  `0 < fraction < 0.95`, scroll listener throttled at 600ms, persist via the
  offline-safe sender.
- Guard against fights: ignore scroll events within ~1s after a
  listen-driven `onPosition` sets state (mode toggle scroll), and don't
  persist while `document.hidden`.

### 5.3 `components/SyncedReader.tsx`

- New props: `{ text, title, startOffset?: number; onPosition?: (offset:
number) => void }`.
- Initialize `activeOffset` to `clampOffset(startOffset ?? 0)` so a
  listen-first visit highlights the saved word immediately.
- Persist throttled: local `onboundary` state updates stay immediate, but
  `onPosition` fires at most every ~2s during playback, plus always on
  pause/stop/unmount/`visibilitychange` (flush latest). Reuse the same
  offline-safe sender as read mode so both paths share the queue.
- No autoplay on mount. No UI additions (silent restore per §0).

### 5.4 Offline queue (`lib/offline-queue.ts`)

- Extend `PendingProgress` to `{ id, offset, progress, updatedAt }`; readers
  must tolerate old `{ id, progress }` entries (treat missing `offset` as
  `fractionToOffset` at flush time — flush needs text length, so resolve
  against the cached article or fall back to sending the legacy fraction).
- `persistProgressOffset(id, offset, textLength, send)` mirrors
  `persistProgress`; keep the old function as a thin wrapper for back-compat.
- Unit tests: enqueue coalesces to latest per article, flush drops OK/404 and
  keeps the rest, mixed old/new entry shapes replay correctly.

## 6. What explicitly does NOT change in this milestone

- No resume banner, no "mark finished", no auto-archive at ~95%.
- No library progress bars or "Continue" buttons (`ArticleList.tsx` untouched
  except types if `ArticleSummary` gains a field).
- No word-level highlighting in read (HTML) mode.
- No multi-device merge beyond last-writer-wins; no conflict UI.
- No autoplay; no background-audio changes (still blocked on server TTS).

## 7. Execution phases (autonomous order)

1. **Phase 0 — helpers.** Add `lib/progress-sync.ts` + `tests/progress-sync.test.ts`.
   Gate: `npm run typecheck && npm test -- progress-sync`.
2. **Phase 1 — store.** Add `progressOffset`/`progressUpdatedAt`, lazy migration,
   `updateProgressOffset`, legacy delegation, summary field + store tests.
   Gate: `npm test -- store`.
3. **Phase 2 — route.** Accept `{ offset }`, keep `{ progress }`, return both,
   clamp + route tests. Gate: `npm test -- routes` (or progress-route) `&&
npm run build`.
4. **Phase 3 — offline queue.** Offset-aware entry/send/flush + queue tests.
   Gate: `npm test -- offline-queue`.
5. **Phase 4 — client.** ReaderClient ownership, hook extension, SyncedReader
   props + throttled persist, handoff scroll. Add/extend e2e
   (`tests/e2e/progress-sync.spec.ts`): reload restores read scroll silently,
   reload highlights listen offset silently, mode toggle preserves anchor,
   offline write replays on reconnect. Keep suite serial + unique URLs per
   run; respect the 30 req/min limiter (`setRateLimitOverride` in tests).
   Gate: `npm run test:e2e` (progress spec) + full `npm test`.
6. **Phase 5 — docs sync.** Per `AGENTS.md`: update `DESIGN.md` §9/§10 from
   actual commits (short SHAs + files), `TESTING.md` if a new test kind
   appears, `QUALITY_PLAN.md` if a P1/P2 lands. Final gates before finishing:
   `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`;
   plus `npm run build`, and `npm run coverage` (keep `lib/` ≥ 80%).

## 8. Review flags (do not guess — surface to the owner)

- Arithmetic read↔offset mapping is approximate (images/headings shift HTML
  vs `text`). Exact anchors need sanitize-time markers — deferred, but call
  it out in the PR.
- Old queued `{ id, progress }` entries need `text.length` at flush time;
  if the implementer can't resolve it cleanly, send legacy fraction instead
  and note it.
- `article.text` length can change on re-extract; clamping is the v1 answer,
  percentage fallback is not.
- If e2e autoplay or `speechSynthesis` proves flaky in CI, test highlight +
  persistence without asserting audio output.
