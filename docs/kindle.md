# Send to Kindle — execution plan

Status: **planned, not implemented**. Decision from 2026-09-12 Q&A: one-click
email delivery via user-configured SMTP. Latest 50 **active** (non-archived,
`createdAt` desc) articles, compiled into **one** document (sidesteps per-day
per-document Send-to-Kindle limits).

## 1. Configuration (env, never logged)

```sh
SMTP_HOST=... SMTP_PORT=587 SMTP_SECURE=false
SMTP_USER=... SMTP_PASS=...
KINDLE_EMAIL=xxx@kindle.com FROM_EMAIL=readapaper@yourdomain
```

- `.gitignore` currently does NOT cover `.env*` — add `.env*` (keep an
  `.env.example` with dummy values) in the same commit as the feature.
- Missing config → `503 { error, setup: "hint" }`, never a stack trace; secrets
  never appear in logs (host-only logging precedent).
- User setup (document in §6): find the Kindle address in Amazon
  Manage-Devices, and approve `FROM_EMAIL` under Personal Document Settings —
  otherwise Amazon silently drops the mail.

## 2. New dependency

- `nodemailer` + `@types/nodemailer` (dev). No EPUB library: v0 sends a
  **single compiled HTML attachment** (supported by Send to Kindle, zero new
  format deps). EPUB upgrade stays a follow-up.
- Note the dep in `DESIGN.md` Deviations when shipped.

## 3. Library (`lib/kindle.ts`, pure + unit-tested)

- `getKindleBatch(limit = 50)`: active-only (`!archived`), `createdAt` desc,
  take 50. Returns `{ articles, totalActive }` so the UI can say "50 of 132".
- `compileKindleHtml(articles)`: one HTML doc — title page, TOC with anchors,
  one chapter per article (title, byline, source URL, sanitized `html`
  reused as-is). Escape titles/URLs at chapter boundaries.
- Size guard: measure bytes; over ~40MB (under Amazon's 50MB mail limit with
  headroom) → refuse with a clear error suggesting fewer/recent articles.
  No multi-mail splitting in v0.
- `sendToKindle(send, compiled, config)` takes an injected sender so tests
  never touch SMTP. `send` defaults to a nodemailer transport in the route.
- Unit tests (`tests/kindle.test.ts`): ordering, archived exclusion, 50-cap,
  `totalActive` count, TOC anchors, oversize refusal, sender-injection (assert
  To/Subject/attachment, no network).

## 4. API

- `POST /api/kindle/send` → `{ ok: true, sent: 1, count, bytes }` | `400` no
  active articles | `503` SMTP/Kindle unconfigured | `500` send failure
  (message only, no secrets). Rate-limit like the other POSTs
  (`lib/rate-limit.ts`, 429 + `Retry-After`).
- `GET /api/kindle/status` → `{ configured: boolean, activeCount: number }`
  so the UI disables gracefully with a setup hint. No secrets in the response.
- Test hook mirroring the `setRateLimitOverride` precedent:
  `setMailSenderOverride` for route/e2e tests (reset via `vi.resetModules`).
- Route tests: validation, 503 path, fake-sender success asserting batch
  selection (latest 50 active, archived excluded).

## 5. UI

- Library header button: `📚 Send 50 latest to Kindle`, driven by
  `/api/kindle/status` (disabled + "configure SMTP" hint when unconfigured).
- While sending: disabled + spinner text; result toast: "Sent 50 of 132
  articles" or the server's error message. No other UI changes.
- E2E: status-disabled state + validation paths only — never send real mail
  (fake sender override; assert the route was hit with the right batch).

## 6. Execution phases

1. **Phase 0 — lib.** Batch selection, compile, size guard, injected sender +
   unit tests. Gate: `npm test -- kindle`.
2. **Phase 1 — routes.** Status + send routes, rate limit, mail-sender
   override + route tests. Gate: `npm test -- routes && npm run build`.
3. **Phase 2 — config+UI+e2e.** `.gitignore` `.env*`, `.env.example`, button +
   toast, setup docs (§7), e2e without real mail. Gate: `npm run test:e2e` +
   full gates (`typecheck`, `lint`, `format:check`, `test`).
4. **Phase 3 — docs sync** per `AGENTS.md`: §9 Reading-extras item gains a
   `[x] DONE` sub-bullet for Kindle-send, §10 entry, Deviations (nodemailer).

## 7. Setup doc (ship inside this file or `TESTING.md` as appropriate)

Kindle address location, sender-approval step, Gmail App-Password style SMTP
notes, `.env.local` example, how to verify (status endpoint → test send →
check Kindle library), and the 40MB/50-article v0 limits.

## 8. Review flags (surface, don't guess)

- Secrets ergonomics: `.env.local` is the v0 answer; a settings UI with
  encrypted storage is explicitly out of scope — say so in the PR.
- Gmail/Outlook SMTP friction (app passwords, less-secure-app removal) may
  dominate support; the setup doc must be tested against a real provider
  before claiming it works.
- Oversize batches refuse rather than split in v0 — confirm the owner prefers
  refusal over multi-mail.
- If `docs/archive.md` has not landed, define "active" as "all articles" with
  a TODO pointing at the archive spec — do not implement archiving here.
