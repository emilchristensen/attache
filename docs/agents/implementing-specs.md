# Implementing a spec

Rules for running `/implement-spec` (or any multi-agent build) in this repo.
They add to the skill; the skill itself stays as installed.

## Integration branch

- The integration branch is shared by every worker at all times, so its history only grows.
  Fixes after a merge go in new commits; `--amend`, reset, rebase and force-push stay off it.
- Write every merge message with `-m` (`Merge #<n>: <ticket title>` plus the co-author line), so it carries no `# Conflicts:` lines.
- Merge finished tickets in batches, ordered by how many tickets each one unblocks.
  Run lint, typecheck and Vitest after each merge, and the e2e suite once per batch.

## Briefing workers

- Keep a cross-ticket decision log outside the repo (new modules, interfaces, tables, file layouts, contract fields), and point every worker at it.
  Each worker reads it first and adds its own entry.
- When a worker fixes something outside its ticket, it records the fix in the log, so a parallel worker merges the same fix instead of writing a second one.
  A merger that finds two copies of one fix keeps one, with one regression test.
- When one ticket supersedes another's helper or interface, the merger writes a superseding entry in the log naming what no longer exists.

## Checks

- A ticket that needs a platform this machine lacks (Windows, Linux) tests on GitHub Actions: the worker pushes only its own branch and reports the passing run URL.
- Read a failed run with `node scripts/ci-failures.mjs <run-id>`.
- Close a ticket only when every acceptance criterion holds; one that still waits on CI or the owner stays open, with a comment naming what is left.
