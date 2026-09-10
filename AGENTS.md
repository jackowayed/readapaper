# AGENTS.md — Readapaper agent rules

## Keep DESIGN.md in sync (mandatory)

After every feature/fix commit(s), before finishing your turn:

1. Run `git log --oneline -10` + `git show --stat HEAD` (and any uncommitted diff) to see what actually shipped.
2. Update `DESIGN.md`:
   - `§9 Out of scope`: if a listed item (or sub-part, e.g. bookmarklet, srcset images, size caps) is now done, mark it `[x] DONE YYYY-MM-DD (<short-sha>): <what> — <files>`. If only partially done, flip the parent to `[~]` and add a `[x] DONE` sub-bullet for the completed part, leaving the remainder unchecked.
   - `§10 Task list`: append a `- [x] YYYY-MM-DD (<short-sha>): <one-liner>` entry.
   - `Deviations from plan` line: note any new infra/workaround (deps, config, gitignored paths).
3. Never mark something done from intent or plan — only from commits/code on disk. Cite the short SHA and the files touched.
4. Keep the §9 list stable: don't delete or renumber remaining items, just check off what's completed.
