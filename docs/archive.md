# Archive — execution plan

Status: **planned, not implemented**. Decisions from 2026-09-12 Q&A: archived
articles hide from the main list, an Archived view offers unarchive, archived
articles are excluded from Kindle sends ("active" = non-archived).

## 1. Data model

```ts
type Article = {
  // ...existing fields...
  archived: boolean;
  archivedAt: string | null; // ISO set/unset timestamps
};
```

- `ArticleSummary` gains both fields (cheap, avoids loading full text for
  filter UI).
- Lazy migration in `readAll()`: missing → `archived: false, archivedAt: null`.
- Implement against the `Article` type as it exists at build time: if
  `docs/unified-progress.md` has already landed, its `progressOffset` /
  `progressUpdatedAt` fields must be preserved by the migration and covered in
  tests — do not regress them.

## 2. Store (`lib/store.ts`)

- `setArchived(id, archived: boolean)` → flips flag, stamps/clears
  `archivedAt`, returns updated article or `null`. Reuse the atomic tmp+rename
  write path.
- `listArticles(filter?: { archived?: boolean })` — no-filter callers keep
  today's behavior (return all, desc).
- Unit tests: flag flip + timestamp, idempotent re-archive, migration
  backfill, no-filter returns both states.

## 3. API

- `PUT /api/articles/:id/archive` `{ archived: boolean }` → `{ ok: true,
archived }`. 400 on missing/non-boolean, 404 on unknown id. (Matches the
  existing `PUT .../progress` shape.)
- `GET /api/articles` gains `?archived=1|0|all`, **default `0` (active only)**.
  This changes the existing default (today: all) — update `tests/routes.test.ts`
  and any e2e that assumes unfiltered lists return everything.
- Unchanged: rate limiting, host-only error logging.

## 4. UI

- `ArticleList.tsx`: per-card Archive button; archived cards (in Archived view)
  show Unarchive instead. Keep Delete where it is.
- Library page: `Active | Archived` toggle (query-string or local state;
  query-string is shareable — prefer it). Archived count shown on the toggle.
- Progress writes to archived articles keep working (last-writer-wins, no
  special casing).
- No auto-archive on finish in this milestone (explicitly deferred).

## 5. Execution phases

1. **Phase 0 — model+store.** Fields, migration, `setArchived`, list filter +
   unit tests. Gate: `npm test -- store`.
2. **Phase 1 — routes.** Archive PUT + list query param + route tests; fix
   existing tests for the new default. Gate: `npm test -- routes && npm run
build`.
3. **Phase 2 — UI + e2e.** Toggle, Archive/Unarchive buttons, archived-excluded
   default list; e2e archive→disappears→unarchive→returns. Gate: `npm run
test:e2e` + full `npm test`.
4. **Phase 3 — docs sync** per `AGENTS.md`: flip §9 Library item to `[~]` with
   a `[x] DONE <date> (<sha>)` sub-bullet for archive, §10 entry, no other
   scope touched.

## 6. Review flags (surface, don't guess)

- The `GET` default change (`all` → active-only) is the riskiest call here;
  if any consumer needs unfiltered lists, add `?archived=all` handling first
  (already in §3) and call out every updated test in the PR.
- If unified-progress landed first, the migration must round-trip its fields
  — add an explicit test for that.
