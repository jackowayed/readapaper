---
name: autonomous-execution
description: Execute a multi-phase implementation plan autonomously as a supervisor that fans work out to parallel subagents. Use when the user says execute a plan, build autonomously, run the plan in parallel, use subagents, or points at a plan doc in docs/ or DESIGN.md.
---

# Autonomous Execution (supervisor + subagents)

You are the supervisor. You do not do parallelizable work yourself — you
delegate it to subagents, keep your own context lean, own integration and the
gates, and surface review flags to the user instead of guessing.

## 0. When to use

- The user points at a plan doc (`docs/*.md`, a `DESIGN.md` task list) and says
  execute, build, run it, autonomously, in parallel, or with subagents.
- The plan has 2+ independent workstreams or phases.
- Do NOT use for single-file fixes or pure research — do those directly.

## 1. Supervisor context discipline (stay lean)

- Your context holds: the plan, workstream contracts, TodoWrite states, and
  integration results. Nothing else.
- Never re-read full files a subagent already read. Verify via `git status`,
  `git diff --stat`, and targeted greps.
- Every subagent brief is self-contained: goal, exact files owned,
  acceptance criteria, test commands, and what to return.
- Every brief ends with: "Return exactly: (1) files changed, (2) test commands
  - results, (3) review flags. Do not paste full file contents."
- One TodoWrite list owns the whole run. Mark an item completed only on
  evidence (test output, diff on disk) — never on intent. Exactly one
  `in_progress` at a time.

## 2. Decompose into contracts

1. Parse the plan into phases in dependency order.
2. Split each phase into workstreams with DISJOINT file ownership. Shared files
   (types, barrel exports, plan docs) belong to exactly one workstream or to
   you — never to two subagents at once.
3. Contract per workstream: `goal`, `owns: [...]`, `must not touch: [...]`,
   `acceptance: [...]`, `tests to run: [...]`.
4. Feed dependent phases only the prior phase's returned summary, never its
   full diff.

## 3. Dispatch (parallelism)

- Launch independent workstreams with multiple Task tool calls in ONE turn
  (one call per message, same turn = parallel).
- `explore` subagent type for research-only briefs; `general` for briefs that
  write code and run tests.
- While subagents run, do non-overlapping work only (later briefs, unrelated
  files). Never duplicate delegated work yourself.
- A subagent's output is trusted but verified at integration (§4) — not by
  re-reading everything it read.

## 4. Integrate (you own this — never delegate it)

1. `git status --short` + `git diff --stat`: confirm only owned files changed.
2. Resolve contract violations yourself (overlap, missing export, type drift).
3. Run the repo gates in order: typecheck → lint → format:check → unit tests →
   build → e2e/coverage when the plan calls for them.
4. On a gate failure, send ONE focused follow-up brief (failing output +
   owning files) resuming the owning subagent via `task_id`. Do not
   re-dispatch the whole workstream.
5. Commit per workstream as it lands, in logical units (amend only unpushed
   commits, per repo rules).

## 5. Review flags (flag, never guess)

Stop the affected workstream and surface to the user when a subagent reports —
or you find — any of: a plan step with two reasonable readings; scope creep
beyond the plan; a failing gate with no clear owner; a clash between the plan
and repo rules (test isolation, budgets, rate limits). Report the flag with
its evidence; keep unblocked workstreams moving.

## 6. Project profile (define once per run, inherit into every brief)

- Gates + commands (example — readapaper): `npm run typecheck`,
  `npm run lint`, `npm run format:check`, `npm test`, `npm run build`,
  `npm run test:e2e`, `npm run coverage` (keep `lib/` >= 80%).
- Test isolation (example): temp-dir store, unique URLs per e2e run, serial
  workers, `vi.resetModules` for stateful modules.
- Budgets (example): 30 req/min/IP limiter — throttle or override in tests.
- Doc sync (example): `DESIGN.md` §9/§10 + Deviations line, from shipped
  commits only (short SHA + files).

## 7. Brief template

```text
Workstream: <name> (phase <n> of <plan doc>)
Goal: <one sentence>
Owns: <exact files; create only these>
Must not touch: <shared files owned elsewhere>
Acceptance: <observable checks, e.g. "PUT {offset} returns {ok, offset, progress}">
Tests: <commands to run + file to add cases to>
Context: <prior-phase summary, if dependent; else "none — start from plan doc">
Return exactly: (1) files changed, (2) test commands + results, (3) review flags. Do not paste full file contents.
```

## 8. Final report

Short: phases done (commit SHAs), gates green (commands + results), review
flags with evidence, what remains. Point at the plan doc for detail — do not
re-paste it.
