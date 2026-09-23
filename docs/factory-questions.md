# Factory questions — for the owner (updated as crews work)

Forward-progress rule: crews never block on these. Each crew makes a reasonable
choice, notes it in its report, and the merge commit cites it. You can overturn
any choice with `git revert <sha>` + a follow-up.

## Needs your input (no blocking — defaults in brackets)

1. [dedup] `normalizeUrl` currently strips only `#fragment` + trailing `/` and
   keeps query strings. How aggressive should dedup be?
   [Default: strip common tracking params (`utm_*`, `fbclid`, `gclid`, `ref`) +
   lowercase host + drop `www.` + treat `http`/`https` as same. Keep path/query
   otherwise. Crew: search-sort notes the choice; store-durability does NOT
   change dedup.]
2. [trash] Delete today is hard-delete + `confirm()`. Trash model?
   [Default: soft-delete (`deleted` + `deletedAt`), Trash filter in library,
   Restore + Delete-forever buttons, dedup ignores trashed. Crew: starred-trash.]
3. [folders vs tags] Instapaper has exclusive folders + many-to-many tags. Which
   first? [Default: tags first (superset — a folder ≈ a tag with exclusive UI),
   folders later. Neither crew builds them yet; starred-trash + search-sort lay
   the filter-plumbing groundwork.]
4. [search] Full-text search backend? [Default: case-insensitive substring over
   title/byline/excerpt/text in `lib/store.ts` now (JSON store); pg_trgm/Meili
   when Postgres lands. Crew: search-sort.]
5. [corrupt JSON] `data/articles.json` with 1 bad byte currently 500s every
   route. Recovery? [Default: rename corrupt file to
   `articles.json.corrupt-<ts>` + start empty + log. Crew: store-durability.]
6. [rate-limit] `x-forwarded-for` is spoofable; mutation routes (`PUT
progress/archive`, `DELETE`, `PUT like`) have no limiter. [Default: first
   entry of `x-forwarded-for` (proxy convention) + extend 30/min/IP to all
   mutation routes. Crew: reader-fixes.]
7. [target=_blank] Sanitizer strips `target`/`rel` the extractor sets (dead
   code, test-locked). [Default: allowlist `target` + `rel` so reader links open
   in new tabs safely. Crew: ssrf-hardening (touches `lib/extract.ts` anyway).]
8. [scroll restore] Finished articles (progress ≥95%) reopen at top today.
   [Default: restore any `progress > 0`, clamp ≤1, after layout settles.
   Crew: reader-fixes.]
9. [highlights scope] Highlights+notes+export is the biggest Instapaper gap (L).
   MVP shape? [Default: per-article highlight ranges (char offsets into `text`)
   - note text + Notes view + CSV export — separate workstream after this batch.
     No crew builds it yet.]
10. [email-to-save / extension / mobile] Which save surface after bookmarklet?
    [Default: none in this batch; CSV import/export first (validates bulk
    pipeline), then share-target, then extension. No crew builds them yet.]

## Decided during merge 2026-09-23 (supervisor — overturn explicitly)

- Q1 heading: `Library (N)` shows the filtered count while a search/sort is
  active, otherwise the scope count (Active/Archived/Liked/Trash).
- Q1 dedup (owner 2026-09-24): aggressive normalization it is — scheme unified
  to https, host lowercased + leading `www.` dropped, `TRACKING_PARAM_NAMES` +
  `utm_`/`hsa_` prefixes stripped, remaining params sorted, page-identifying
  params (`?page=`, `?id=`, …) always preserved.
- Q3/Q9 tags/folders/highlights (owner 2026-09-24): explicitly deprioritized —
  do not schedule; no crew should pick these up without a new owner decision.
- Q2 trash: shipped soft-delete as default; list `Delete` button removed (Trash
  covers it) leaving Trash/Restore/Delete-forever; dedup ignores trashed rows
  (re-save creates fresh); `getArticle` still returns trashed rows for the
  restore UI; Kindle batch excludes trashed rows.
- Q6 rate limits: extended to like/trash routes too (`articles-like:`,
  `articles-trash:` buckets); reads stay unlimited.
- Q7 target/rel: allowlisted — reader links keep `target=_blank`.
- Q8 scroll: restores any `progress > 0`, clamped to ≤1.
- Integration: `setLiked`/`setDeleted` wrapped in the store mutex (they were
  written pre-mutex and bypassed it); `onLike`/`onTrash`/`onDeleteForever`
  surface errors like the other list actions.

## Decided already (locked — overturn explicitly)

- One revertable unit per branch: `factory/<slug>` → squash to ONE commit on
  `main` via supervisor. `git revert <sha>` drops the whole feature.
- Worktrees: `/tmp/opencode/<slug>` per crew. Never commit in `/workspace/readapaper` directly from crews.
- Gates per crew: `npm test` (or targeted `npm test -- <name>`), `npm run typecheck`, `npx eslint --quiet <touched>`, `npx prettier --check <touched>`. Full `npm test` + build at merge by supervisor.
- `data/articles.json` (real) is never touched by tests (temp-dir isolation).
