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

## Decided already (locked — overturn explicitly)

- One revertable unit per branch: `factory/<slug>` → squash to ONE commit on
  `main` via supervisor. `git revert <sha>` drops the whole feature.
- Worktrees: `/tmp/opencode/<slug>` per crew. Never commit in `/workspace/readapaper` directly from crews.
- Gates per crew: `npm test` (or targeted `npm test -- <name>`), `npm run typecheck`, `npx eslint --quiet <touched>`, `npx prettier --check <touched>`. Full `npm test` + build at merge by supervisor.
- `data/articles.json` (real) is never touched by tests (temp-dir isolation).
