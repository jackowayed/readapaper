# Readapaper — Functionality Summary

Single-user, local, web-only Instapaper clone. No auth, no accounts, no paid/server TTS. Storage is a server-side JSON file (`data/articles.json`); all listening is client-side Web Speech API.

## 1. Save articles

- Paste-URL save form on the library page (`/`).
  - Rejects the save while offline with an explanatory error.
  - After a successful save, refreshes the library and triggers an offline-cache warm so the new article is immediately available offline.
- Server-side extraction pipeline for a bare URL:
  - Validates http(s) only; blocks private/internal hosts and metadata endpoints.
  - Follows up to 5 redirects, re-validating every hop.
  - 15s fetch timeout, strict HTML content-type allowlist, Content-Length pre-check plus ~5MB streaming body cap.
  - Parses with Readability, absolutizes links/images, restores responsive/lazy images (`srcset`/`data-src`/`<picture><source>` picking, placeholder `data:`/`blob:` drop), strips `srcset`, sanitizes to a small tag/attribute allowlist.
  - Failure returns 422 with a hint pointing at the bookmarklet path.
  - Produces title, byline, excerpt, sanitized reader HTML, plain text, word count.
- Duplicate handling: re-saving an existing canonical URL returns the stored article with `200` instead of creating a duplicate (`201` for new saves).
  - Canonicalization: scheme unified to https, host lowercased with `www.` dropped, fragment stripped, tracking params removed (`utm_*`, `hsa_*`, ad-click IDs, etc.), remaining params sorted, trailing slash dropped. Page-identifying params are preserved.
- Preview-only extraction endpoint exists (`POST /api/extract`) that returns extracted content without saving.

## 2. Library (`/`)

- Scopes with counts, shareable via query string:
  - Active (default), Archived, Liked, Trash (soft-deleted).
  - Trash defaults to showing all trashed items regardless of archived flag; explicit `?archived=1/0` narrows inside trash.
- Full-text substring search (`?q=`, max 200 chars) over title, byline, excerpt, text, and URL.
- Sort (`?sort=`): newest, oldest, longest, shortest, most progress.
- Search/sort form preserves the current scope; “Clear” resets to the scope default. Empty states distinguish “nothing saved” from “no matches”.
- Per-article cards show title, excerpt, word count, estimated reading minutes, and `% read` when started.
- Per-article actions (all client-side with inline error + library refresh):
  - Archive / Unarchive, Like / Unlike, Trash / Restore.
  - Trash view adds permanent “Delete forever” (confirm-guarded).
  - “Add to queue” (`+ Queue` / `✓ Queued`) for the listen queue.
- Article page header (`/a/[id]`) has Archive/Unarchive and Trash/Restore toggles; trashed articles show a banner and are hidden from normal library scopes.
- Kindle send button + status hint + result toast (see §7).
- Listen-queue count link, visible only when the queue is non-empty (see §6).
- Offline-cache button + status (see §8).

## 3. Reader (`/a/[id]`)

- Narrow serif column layout with title, byline, word count, reading minutes, excerpt, and “Original” source link.
- Read / Listen mode toggle.
- Themes: light / sepia / dark (persisted in localStorage). Font-size step control, persisted per browser (80–150%).
- Reading progress:
  - Restores scroll position on mount for partially read articles (finished ≥95% articles restore to top/next behavior handled by fraction logic).
  - Scroll listener, throttled, persists progress; suppressed briefly after listen→read handoffs and while the tab is hidden.
- Reader error boundary with retry so a dead server doesn’t look like a listen failure.

## 4. Unified read/listen position

- One canonical position per article: char offset into the article’s plain text, with the legacy `0..1` scroll fraction kept as a derived mirror for list UI and scroll restore.
- Last-writer-wins across read and listen modes; includes a last-update timestamp.
- Read→listen handoff captures live scroll offset synchronously (so a fast scroll-then-tap isn’t stale) and starts highlighting there without autoplay.
- Listen→read handoff scrolls the remounted article HTML to the last listen offset.
- Progress API accepts canonical `{ offset }` (wins when both present) or legacy `{ progress }`; responds with both `{ offset, progress }`, clamped server-side against text length.
- Old rows missing offset/archive/like/trash fields are lazily migrated on read; invalid stored rows are quarantined (logged, hidden) rather than crashing routes.

## 5. Listen in sync (Web Speech TTS)

- Single Play/Pause toggle per article (no Stop): Pause keeps position, Resume continues; click the first word to restart from the top.
- Speaks article text as a queue of per-sentence utterances (avoids long-utterance cutoffs); mid-sentence seeks slice the first utterance.
- Word-level highlight + sentence-level highlight, click any word to seek/play from there.
- Auto-scroll to the active word (centered, smooth), paused for ~3s after manual scroll; toggleable.
- Audible player status line: Idle / Playing / Paused / Error with speech-error messages; position is kept for retry. Cancel-driven errors from queue replacement are ignored, not surfaced.
- Controls:
  - Rate select (0.75x–2x), persisted per browser in localStorage, applies immediately mid-play by restarting from the playhead.
  - Voice select (browser voices + Default fallback when a stored voice is missing on this device), persisted per browser, applies immediately mid-play.
  - Sentence+word highlight behavior with Firefox sentence-only fallback (no word-boundary events there).
- Lock-screen/background controls via Media Session API (play/pause/stop; stop maps to pause, keeping position).
- Playhead persistence is throttled during playback and flushed on pause, hide, and unmount through the shared offline-safe sender (queued when offline, replayed on reconnect — see §8).

## 6. Listen queue (`/listen`)

- Client-side queue of article IDs in localStorage (per-browser, offline-safe, deduped, order-preserving).
- Library “Add to queue” + queue count link (`▶ Listen queue (N)`).
- Queue page:
  - Numbered list with per-item Play, move up/down, Remove; Clear queue.
  - Fetches each item’s title/text/saved offset on demand; failed (deleted/empty) items are marked unavailable with a remove affordance and skipped during continuous play.
  - Continuous playback: when the current article drains naturally, advances to the next item and auto-plays it without another tap.
  - Playback is keyed off the current article ID, so queue edits mid-play don’t disturb the spoken item.
  - Empty state points back to the library.

## 7. Bookmarklet (`/bookmarklet`)

- Install page generates a `javascript:` bookmarklet locked to the current instance origin, with drag-to-bookmarks install, copy-to-clipboard, and imperative `href` fix for React 19 sanitization.
- Bookmarklet runs inside the live article page (inherits cookies/sessions, rendered JS/SPA content, paywall unlocks; looks like a normal user to bot checks) and POSTs `{ url, page HTML }` through the normal server Readability + sanitize pipeline.
- Size guards (too-small DOM rejected, ~9MB client cap, 10MB server cap).
- Toast UI for Saving / Saved-or-already-present (with Open link) / server error.
- On CSP/mixed-content blocks, automatically copies the page HTML to the clipboard and directs the user to the Manual-save form (URL + pasted HTML) on the same page.
- Documents the hard-paywall limit: only text actually rendered in the DOM can be saved.
- Server CORS explicitly allows cross-origin bookmarklet POSTs.

## 8. Offline PWA

- Installable shell: web manifest + icons + theme color.
- Service worker (Serwist-based, build-time precache of app shell/CSS + `/offline` fallback, runtime network-first/SWR recipes for documents, API, and images; one-time cleanup of legacy caches).
- `/offline` fallback page explaining cached articles stay readable while new saves need a connection.
- Global connectivity banner: offline cached-count message; online pending-sync count.
- Proactive warming: library load auto-warms (library page + every active article document through the worker, including unopened ones), warm-on-save, manual Refresh button with cached-count label. Failed warms keep the last good count; same-tab event keeps button/banner counts live.
- Offline progress sync: progress writes made offline are queued in localStorage (latest-wins per article, capped), then replayed on reconnect as canonical offsets with legacy-fraction fallback; deleted-article (404) replays are dropped.
- Save form is offline-guarded; voice/queue settings are localStorage-based and work offline.

## 9. Send to Kindle

- One-click email delivery of the latest 50 active (non-archived, non-deleted) articles as a single compiled HTML document (title page + anchored table of contents + one chapter per article reusing sanitized reader HTML).
- ~40MB size guard refuses oversize batches with a clear error instead of splitting.
- SMTP/Kindle addressing via env (`SMTP_HOST/PORT/SECURE/USER/PASS`, `KINDLE_EMAIL`, `FROM_EMAIL`); example in `.env.example`.
- Status endpoint drives the UI: disabled + setup hint when unconfigured, article-count hint when ready, empty-state hint when there’s nothing to send; result toast on send.
- Never logs or returns secrets; missing config returns 503 with a setup hint, empty library returns 400, send/compile failures return 500 with message only.

## 10. API surface

- `POST /api/extract { url }` → extracted content | `400` invalid/unsafe URL | `422` extraction failed.
- `GET /api/articles[?archived=0|1|all][&liked=1][&deleted=1][&q=][&sort=]` → article summaries, newest-first default; rejects unknown `archived`/`sort` and overlong `q` with `400`.
- `POST /api/articles { url } | { url, html } | { html }` → article; `200` dedup hit, `201` created; `400` bad URL/JSON/body, `422` extraction/size failure.
- `GET /api/articles/:id` → full article | `404`.
- `DELETE /api/articles/:id` → soft-delete (trash) by default, `204`; `?permanent=1` hard-deletes; `404` when unknown.
- `PUT /api/articles/:id/progress { offset } | { progress }` → `{ ok, offset, progress }` | `400` | `404`.
- `PUT /api/articles/:id/archive { archived }`, `PUT .../like { liked }`, `PUT .../trash { deleted }` → updated article | `400` | `404`.
- `GET /api/kindle/status` → `{ configured, activeCount }` (no secrets).
- `POST /api/kindle/send` → `{ ok, sent, count, bytes }` | `400` empty | `503` unconfigured | `500` compile/send failure.
- Cross-cutting: zod request + stored-row validation (legacy error messages preserved), 30 req/min/IP rate limits on all mutating POST/PUT/DELETE routes (429 + `Retry-After`, test override hooks), host-only error logging (never HTML/body/secrets), CORS `*` on article POST for the bookmarklet, atomic tmp+rename store writes behind an in-process write mutex, corrupt-store backup-and-reset recovery.
