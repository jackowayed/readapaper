# Readapaper — Design Doc (v0)

## 1. Goal
Instapaper clone with 3 core features:
1. **Save:** paste a URL, extract just the article text/HTML.
2. **Read:** clean reader view with themes, progress resume.
3. **Listen+Sync:** TTS that highlights words + auto-scrolls, click any word to seek, switch freely between reading and listening.

v0 = single-user, local, web-only. No auth, no paid TTS, no extension. Validate the read/listen-sync UX.

## 2. Architecture (v0)

```
Browser (Next.js App Router)
  / (SaveForm + ArticleList)
  /a/[id] (ReaderPage -> ArticleView + SyncedReader)
    |
    v
Next.js API Routes (Node server)
  POST /api/extract {url} -> fetch HTML -> JSDOM -> Readability -> DOMPurify -> {title, html, text}
  CRUD /api/articles (JSON file store in `data/articles.json`)
    |
    v
Web Speech API (client-only TTS, speechSynthesis + onboundary)
```

No external DB, no S3, no auth in v0. Storage layer is abstracted (`lib/store.ts`) so it can swap to Postgres later without touching routes.

Why Next.js single app (not separate FE/BE):
- One deploy, API routes suffice for fetch+parse (avoids CORS).
- Later split is easy: routes already REST-shaped.

## 3. Data model

```ts
type Article = {
  id: string;            // nanoid
  url: string;           // canonical, absolutized
  title: string;
  byline: string | null;
  excerpt: string | null;
  html: string;          // sanitized reader HTML
  text: string;          // plain text for TTS/search
  wordCount: number;
  progress: number;      // 0..1 scroll fraction
  createdAt: string;     // ISO
};
```

v0 store: `data/articles.json` (array). Atomic write via tmp+rename. Prod path: same shape in Postgres + `audio_url`, `word_timings JSONB` (see §7).

## 4. API design (v0)

- `POST /api/extract` `{url}` -> `{title, byline, excerpt, html, text}` | 400 invalid URL | 422 extraction failed
- `GET /api/articles` -> `Article[]` (summary sorted desc)
- `POST /api/articles` `{url} | {url, titleOverride} | {html pre-extracted}` -> `Article` (server re-extracts if only URL given). Dedup by canonical URL (`normalizeUrl`: host-lowercased, fragment stripped, trailing slash dropped): existing URL returns the stored `Article` with `200` and creates nothing; new saves return `201`.
- `GET /api/articles/:id` -> `Article`
- `DELETE /api/articles/:id` -> 204
- `PUT /api/articles/:id/progress` `{progress: 0..1}` -> `{ok:true}`

All HTML responses sanitized server-side. Client never injects raw fetch HTML.

## 5. Extraction pipeline

1. Validate URL (http/https only, block localhost/169.254 / metadata IPs — SSRF guard).
2. `fetch(url, {headers: UA Mozilla, redirect: follow, timeout 15s, max 5MB})`.
3. `JSDOM(html, {url})` -> `new Readability(doc).parse()`.
4. If `null` -> 422 with hint (try extension paste — see out-of-scope).
5. Absolutize `src/href`, map `data-src/srcset -> src`, strip `srcset` (avoids layout shift).
6. `DOMPurify.sanitize` allowlist: `p,h1-h4,img,a,blockquote,ul,ol,li,em,strong,code,pre,figure,figcaption,hr,br` + `href,src,alt,title`.
7. Derive `text = textContent.trim()`, `wordCount`.

Edge cases: JS-rendered sites fail (documented limitation); images hotlinked (no caching in v0).

## 6. Reader UX

- `/a/[id]`: narrow column `max-width: 65ch`, serif, H1 + byline + meta, article HTML.
- Theme toggle: light / sepia / dark (CSS vars + localStorage). Font-size +/-.
- Progress: `onscroll` throttled 500ms -> PUT progress; on mount restore `scrollTo(progress * scrollHeight)`.
- `SyncedReader` toolbar: Play/Pause/Stop, rate (0.75–2x), voice select, sentence+word highlight toggle, auto-scroll toggle.

## 7. Synced TTS design

### v0: Web Speech API (`speechSynthesis`)
- `utterance.onboundary` gives `{charIndex, charLength, name:'word'}` in Chrome/Edge/Safari (Firefox: sentence-only — degrade to sentence highlight).
- Pre-tokenize `article.text` into sentences -> speak as a queue of utterances (enables click-to-seek per sentence + avoids 15k-char Chrome cutoff). Track `globalCharOffset` per utterance.
- Highlight: map `charIndex` -> word `<span>`. Render text layer as word spans (separate from HTML display? v0 highlights the plain-text view; HTML view dims to sentence). Simpler robust approach: **sync overlay** — display `text` tokenized view for listening mode, keep rich HTML for reading mode, toggle preserves scroll anchor.
- Auto-scroll: `activeSpan.scrollIntoView({block:'center'})`, paused 3s after manual scroll.
- Click word -> cancel queue, restart from that sentence/word offset.

Limitations accepted in v0: voice quality varies, no background iOS play, no exact seek within sentence, no offline audio file.

### Prod upgrade path (not in v0, see §9):
Pre-generate MP3 + word timestamps (Polly `SpeechMarks` / Google `timepoints`), serve playlist, drive highlight off `audio.currentTime` via binary search + rAF. Same `SyncedReader` interface, different driver (`SpeechDriver` abstraction).

## 8. File layout (v0)

```
app/
  layout.tsx, globals.css
  page.tsx                 # save form + list
  a/[id]/page.tsx          # reader
  api/extract/route.ts
  api/articles/route.ts
  api/articles/[id]/route.ts
  api/articles/[id]/progress/route.ts
lib/
  extract.ts               # fetch + readability + sanitize
  store.ts                 # JSON file CRUD
  text.ts                  # sentence/word tokenize, chunking
components/
  SaveForm.tsx, ArticleList.tsx, ArticleView.tsx
  SyncedReader.tsx         # speech driver + highlight + controls
  ThemeControl.tsx
data/articles.json         # created at runtime
```

## 9. Out of scope for v0 (documented extensions)

- [ ] **Server TTS + timestamps:** Polly/Google/ElevenLabs, S3/R2 audio cache, chunk playlist, `audio.currentTime` sync, offline download.
- [~] **Save surfaces:** browser extension (extract in-page with cookies to beat paywalls/CORS), iOS/Android share sheet, email-to-save, bulk import (Instapaper/Pocket CSV).
  - [x] DONE 2026-09-10 (`e3cdc80`): DOM-saving bookmarklet — `app/bookmarklet/page.tsx` + `lib/bookmarklet.ts`. Runs in live page DOM (cookies/sessions, rendered JS, unlocked text), POSTs `{url, html}` to `/api/articles` (CORS-enabled, 10MB cap) through the normal Readability + sanitize pipeline.
- [ ] **Multi-user + auth:** NextAuth/OAuth, per-user articles, Postgres + Drizzle/Prisma migration.
- [ ] **Offline PWA:** service worker, IndexedDB cache, background audio + Media Session API, lock-screen controls.
- [~] **Paywall/bot handling:** headless fetch (Playwright), readability fallback to Jina/trafilatura, image proxy + caching.
  - [x] DONE 2026-09-10 (`e3cdc80`): bookmarklet covers soft-paywall/login-gated/bot-blocked pages that render in the user's browser (hard paywalls that never render DOM text still unsavable — documented on `/bookmarklet`).
  - [x] DONE 2026-09-10 (`b28930c`): responsive/lazy image restoration in `lib/extract.ts` — `srcset`/`data-srcset` picking (~960px preferred), `data-src`/`data-original`/lazy attrs, `<picture><source>` fallback, placeholder (`data:`/`blob:`) drop, pre-Readability pass so src-less `<img>` survive.
- [ ] **Library features:** tags/folders, archive/favorites, full-text search (pg_trgm/meilisearch), highlights + notes + export.
- [ ] **Reading extras:** EPUB/PDF export, estimated time left, e-ink mode, dyslexia font, translations/summaries (LLM).
- [~] **Ops:** rate limiting, Sentry, E2E (Playwright) for extract+sync.
  - [x] DONE (v0 baseline): SSRF guard (`assertSafeHttpUrl` blocklist in `lib/extract.ts`) + size/time caps (5MB server fetch, 10MB posted HTML, 15s timeout).

## 10. Task list (live — updated as we go)

- [x] Scaffold Next.js TS app + deps (readability, jsdom, dompurify, nanoid)
- [x] `lib/text.ts` + `lib/store.ts` + `lib/extract.ts`
- [x] API routes: extract, articles CRUD, progress
- [x] UI: save form, list, article view, themes, progress resume
- [x] `SyncedReader`: voices/rate, sentence queue, word highlight, auto-scroll, click-to-seek
- [x] Seed fixture + verify `npm run build`, extraction unit check
- [x] Verified 2026-09-10: `tsc` clean, `next build` ok, smoke test (POST html->201, GET list/one, PUT progress, reader 200, DELETE 204), tokenizer check (3 sents/2 words)
- [x] 2026-09-10 (`b28930c`): srcset-only/lazy/`<picture>` image restoration in extractor
- [x] 2026-09-10 (`e3cdc80`): DOM-saving bookmarklet (`/bookmarklet`, `POST {url, html}` with CORS) for paywalled/bot-blocked pages
- [x] 2026-09-10 (`a271e7e`): URL dedup on save — duplicate URL returns existing article (200) instead of a new row — `lib/store.ts` (normalizeUrl/findArticleByUrl), `app/api/articles/route.ts`, `lib/bookmarklet.ts` (toast says "Already in Readapaper")
- [ ] Update this doc with deviations

Deviations from plan: added `serverExternalPackages` for jsdom + `eslint.ignoreDuringBuilds` (Next15/eslint9 patch issue); store file `data/articles.json` gitignored, resets to `[]`; `.open-next/` + `.wrangler/` gitignored build artifacts (`ddc2e87`).

## 11. Risks
- `speechSynthesis.onboundary` missing in Firefox -> fallback sentence highlight (handled).
- Chrome 15s pause bug for long utterances -> mitigated by sentence-chunk queue.
- SSRF via URL fetch -> protocol/host blocklist + size/time caps (v0 basic).
