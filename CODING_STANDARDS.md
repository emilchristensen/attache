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
- **Every defect gets a regression test** that fails without the fix.

## Structure

- **One copy of a shared shape.**
  Logic that appears in two hunks or files (a wait loop, an escape function, a text normaliser, a subject-wording map) moves into one helper both call.
- **Operating-system differences live behind `apps/service/src/platform/`.**
  Code outside it asks the platform module and never branches on `process.platform` itself.
- **One file, one reason to change.**
  A new concern gets its own small module; a file past about 400 lines earns a look for a clean split.

## Behaviour

- **Every caught error is handled, logged or surfaced to the owner.**
  An empty or comment-only `catch` needs the reason it is safe, in the code.
- **User-facing text tells the owner what to do next**, in the glossary's words, and never shows a secret.
- **Model output is untrusted data.**
  It passes the same validation as a save, and becomes a Proposal, never a direct write.
