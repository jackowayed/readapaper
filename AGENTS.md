# AGENTS.md — Readapaper agent rules

## Keep DESIGN.md in sync (mandatory)

The point is to avoid stale content: nothing should still read as TODO once it's done, and meaningful new TODOs/extensions discovered along the way should get documented. Do NOT log every commit — routine fixes, refactors, and small cleanups with no scope change get no entry.

After feature/fix work that changes scope, before finishing your turn:

1. Run `git log --oneline -10` + `git show --stat HEAD` (and any uncommitted diff) to see what actually shipped.
2. Update `DESIGN.md`:
   - `§9 Out of scope`: if a listed item (or sub-part, e.g. bookmarklet, srcset images, size caps) is now done, mark it `[x] DONE YYYY-MM-DD (<short-sha>): <what> — <files>`. If only partially done, flip the parent to `[~]` and add a `[x] DONE` sub-bullet for the completed part, leaving the remainder unchecked.
   - `§10 Task list`: append a `- [x] YYYY-MM-DD (<short-sha>): <one-liner>` entry — but only for meaningful scope changes. Skip it for routine fixes, refactors, and cleanups.
   - `Deviations from plan` line: note any new infra/workaround (deps, config, gitignored paths).
3. Never mark something done from intent or plan — only from commits/code on disk. Cite the short SHA and the files touched.
4. Keep the §9 list stable: don't delete or renumber remaining items, just check off what's completed.

## Test your work (mandatory)

Cover new behavior with tests, then prove the gates are green:

1. Add/extend tests with the change (not after):
   - `lib/*` logic -> `tests/*.test.ts` (see `TESTING.md` for the store temp-dir isolation pattern; never touch the real `data/articles.json`).
   - New extraction HTML shapes -> fixture in `tests/fixtures/` + case in `tests/extract.test.ts`.
   - Route behavior/status codes -> `tests/routes.test.ts` (stateful modules: reset via exported hooks + `vi.resetModules`, see `tests/rate-limit.test.ts`).
   - User-visible flows (save/read/progress/delete, bookmarklet) -> `tests/e2e/*.spec.ts` with unique URLs per run + cleanup; keep the suite serial (`workers: 1` — the JSON store has no write mutex).
2. Run the gates before finishing: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`. Add `npm run build` when routes/config change, `npm run test:e2e` when flows/store/routes change. Keep `lib/` coverage >= 80% (`npm run coverage`).
3. Respect the budgets: e2e + route tests share the 30 req/min/IP limiter — many rapid POSTs will 429; use `setRateLimitOverride` or fewer calls instead.
4. Update `QUALITY_PLAN.md` checkboxes + log when a P1/P2 item lands; extend `TESTING.md` when adding a new test kind. The `DESIGN.md` sync rule above still applies.
