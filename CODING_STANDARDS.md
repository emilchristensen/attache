# Coding standards

Judgement rules a reviewer applies to a diff.
Mechanical rules live in `pnpm lint` instead: ESLint (`eslint.config.js`) and the docs check (`scripts/check-docs.mjs`).
Vocabulary follows `GLOSSARY.md`, and decisions follow `docs/adr/`.

## Tests

- **Fix the slowness, not the timeout.**
  The global Vitest `testTimeout` stays at 30 s.
  A test file that starts many child processes may raise its own timeout, with a comment saying why.
  A test that only fails under load points at real slowness (process start-up, a budget that starts too early): find it before touching a limit.
- **Drive Attache the way a user or a Harness does** and assert on what comes back: an API response, a file in the Brain, a line a Harness receives, what the Dashboard shows.
  Internal functions, table rows and call order are not assertions.
  What must show is checked with `toBeVisible`, not by its text being in the page.
- **Pin the order a journey depends on.**
  When the outcome depends on whether a refresh lands before or after a step (a decision, a hold, a resize), the journey waits for that refresh (`dashboardAnswer`, `expect.poll`) and covers both orders where both can happen.
  An order left to timing passes on one runner and fails on another.
- **Layout checks keep spare room.**
  A fold, a fit or a clearance is checked with a margin (16 px or more), so a runner whose fonts draw a few pixels wider does not fail it.
- **Text built from counts gets a table test** over every zero and non-zero combination of its inputs, so no combination reads as "." or "0 items".
- **Every defect gets a regression test** that fails without the fix.

## Structure

- **One copy of a shared shape.**
  Logic that appears in two hunks or files (a wait loop, an escape function, a text normaliser, a subject-wording map) moves into one helper both call.
- **Operating-system differences live behind `apps/service/src/platform/`.**
  Code outside it asks the platform module and never branches on `process.platform` itself.
- **One file, one reason to change.**
  A new concern gets its own small module; a file past about 400 lines earns a look for a clean split.

## Behaviour

- **A new state or operation on a shared record passes every guard on that record.**
  A new status gets a decision at each place that lists statuses, and a new action that relinks, restores or resends goes through the same checks as the actions already there.
  Look hardest where two changes meet: one adds the guard, the other the operation.
- **Every caught error is handled, logged or surfaced to the owner.**
  An empty or comment-only `catch` needs the reason it is safe, in the code.
- **User-facing text tells the owner what to do next**, in the glossary's words, and never shows a secret.
- **Model output is untrusted data.**
  It passes the same validation as a save before anything comes of it.
  Only Consolidation writes what a model found straight to the Brain, as its own actor and marked as written without review, so the owner can revert it (ADR 0004); any other model output becomes a Proposal, never a direct write.
