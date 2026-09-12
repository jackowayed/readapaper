# Listen reliability — execution plan

Status: **planned, not implemented**.

## 0. Incident report

User clicked Listen in sync in Chrome and nothing happened. Post-mortem answer:
the dev server had died — no real TTS defect was established. The actionable
finding stands: **every listen failure mode is currently silent**, so a dead
server, a swallowed utterance, and a speech error all look identical ("nothing
happens"). This plan makes listening never fail silently and proves the happy
path with mocked tests.

## 1. Suspects to verify (hypotheses, not bugs — confirm before fixing)

1. `synth.cancel()` immediately followed by `synth.speak()` in
   `speakSentenceRange` (`components/SyncedReader.tsx`) — known Chrome race
   that swallows the first utterance. Repro with a mocked `speechSynthesis`
   that records call order; if confirmed, defer `speak` (e.g. `setTimeout 0`)
   or skip `cancel()` when nothing is speaking.
2. `u.onerror` sets `playing=false` silently — surface it (see §2).
3. Pause/resume path (`onPlayPause` Chrome queue-drop restart) — cover with
   the same mock harness.
4. Dead/unreachable server renders as a generic Next error — add a reader error
   boundary with retry so "server died" never again looks like "listen broken".

## 2. UI changes (`components/SyncedReader.tsx`)

- Audible player state: `idle | playing | paused | error`, shown as a status
  line next to the controls (silent restore of position is unchanged).
- `onerror` / `onend`-unexpected → `error` state with the message
  (`SpeechSynthesisErrorEvent.error` when present) and position kept for retry.
- No autoplay, no other UI changes.

## 3. Test strategy (vitest is `environment: "node"` — plan for that)

- Extract pure queue logic (sentence selection, slice offsets, next-sentence
  advance) into `lib/speech-queue.ts` so it is unit-testable under node with
  zero new deps (`tests/speech-queue.test.ts`).
- Component-level test with a mocked `window.speechSynthesis` needs a DOM +
  `act()`; there is no `@testing-library/react` in devDeps. Either add it
  (devDep only, note in `DESIGN.md` Deviations when shipped) with per-file
  `// @vitest-environment jsdom`, or limit component coverage to the mock
  harness driving the extracted queue. Prefer adding testing-library only if
  the pure-logic tests leave the click→speak path uncovered.
- E2E (`tests/e2e/listen.spec.ts`): Playwright `addInitScript` mock of
  `speechSynthesis` (fire scripted `onboundary` events); assert Listen click
  → word highlight advances → position persists on reload (works with the
  unified-progress offset when that lands, else scroll fraction). Never assert
  real audio output — headless Chromium speech is unreliable/absent.

## 4. Execution phases

1. **Phase 0 — harness.** `lib/speech-queue.ts` extraction + unit tests prove
   click→queue→advance→persist ordering. Gate: `npm test -- speech-queue`.
2. **Phase 1 — harden.** Status/error UI, `cancel→speak` fix only if Phase 0
   repro confirms it, reader error boundary + retry. Gate: `npm run
typecheck && npm test`.
3. **Phase 2 — e2e.** Mocked-speech spec per §3 (serial suite, unique URLs,
   rate-limit override precedent). Gate: `npm run test:e2e` (listen spec) +
   full `npm test`.
4. **Phase 3 — docs sync** per `AGENTS.md` (no new §9 scope; this is a fix).

## 5. Review flags (surface, don't guess)

- If headless Chromium actually implements `speechSynthesis`, prefer the real
  API in e2e and delete the mock — but keep the no-audio-assertion rule.
- If the `cancel→speak` race does NOT repro, ship only the status/error
  surfacing; do not "fix" unconfirmed suspects.
- Adding `@testing-library/react` is a new devDep — call it out in the PR and
  `DESIGN.md` Deviations.
