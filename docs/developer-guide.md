# Jarvis developer guide

Developer setup is separate from end-user installation: users run the installer artifact and never need these tools.

## Layout

| Path | What |
| --- | --- |
| `packages/contracts` | Versioned API contract (`/api/v1`): zod request schemas and response types shared by every client |
| `apps/service` | The local service: memory writer, index, conversation, attention, jobs, scheduler, approvals, connectors, speech, HTTP API |
| `apps/web` | Browser client (React + Vite), served by the service |
| `apps/obsidian` | Obsidian desktop plugin (thin client over the same API) |
| `installer` | `install.sh`, `uninstall.sh` shipped inside the release |
| `scripts` | Release build, verification, install tests, live read-only checks, exclusion check |
| `tests/e2e` | Playwright journeys (Chrome, real Obsidian, voice, visual captures) |
| `docs` | Architecture, inspection, guides, build status, acceptance report |

Service modules: `core/` (db, config, logging with redaction, credential store, notifications), `memory/` (Markdown model, policy, indexer, search, store), `conversation/`, `attention/`, `jobs/` (queue, scheduler, runners), `actions/` (drafts, approvals, expiry), `connectors/` (one adapter per service plus manager), `capabilities/registry.ts`, `speech/`, `http/`.

## Requirements

- macOS on Apple silicon for the full suite (launchd, Keychain, `say`, Obsidian).
- Node 24.18 (`.node-version`); Node 22 lacks FTS5 in `node:sqlite`.
- pnpm 11.
- Google Chrome (Playwright uses the installed Chrome channel).
- Optional: `/Applications/Obsidian.app` for plugin tests, `brew install whisper-cpp` for voice tests, the Claude Code CLI for live model use.

```sh
pnpm install
pnpm build              # service bundle, web client, plugin
pnpm test               # Vitest: unit, adapter contract and HTTP integration tests
pnpm e2e                # Playwright journeys (builds as needed)
pnpm lint
pnpm typecheck
```

Run the service against a scratch profile while developing:

```sh
node apps/service/build.mjs --watch &            # rebuild on change
JARVIS_CREDENTIAL_STORE=file node apps/service/dist/jarvis-service.mjs serve --state-dir /tmp/jarvis-dev --port 7500
node apps/service/dist/jarvis-service.mjs pair --state-dir /tmp/jarvis-dev --open
JARVIS_DEV_SERVICE=http://127.0.0.1:7500 JARVIS_DEV_ORIGINS=http://localhost:5173 pnpm --filter @jarvis/web dev   # optional hot-reload client
```

Environment variables: `JARVIS_STATE_DIR`, `JARVIS_PORT`, `JARVIS_INSTANCE` (names the Keychain service and LaunchAgent), `JARVIS_CREDENTIAL_STORE=file|keychain`, `JARVIS_WEB_DIR`, `JARVIS_DEV_ORIGINS`, `JARVIS_NO_NOTIFY=1`, `JARVIS_CLAUDE_BIN`, `JARVIS_WHISPER_BIN`.

## Fixtures versus live

Contract and journey tests use a local fixture server (`apps/service/test/fixtures`) that emulates GitHub, Jira, Confluence, Slack, Google OAuth, Gmail, Calendar and an OpenAI-compatible model.
The service talks to it only when `JARVIS_TEST_ENDPOINTS=1` and `JARVIS_FIXTURE_URL` are set; normal operation never reads those variables.
Fixture results are never reported as live results.
`scripts/live-readonly.mjs` performs real, read-only checks with credentials already on the machine (currently the GitHub CLI login) in a throwaway profile and reports them separately.

## Release

```sh
node scripts/build-release.mjs --version 0.1.0
```

Produces in `release/0.1.0/`:

- `Jarvis-Installer-0.1.0-macos-arm64.command` — self-extracting one-step installer (double-click or `sh`).
- `jarvis-0.1.0-macos-arm64.tar.gz` — the same release as a folder with `install.sh`.
- `jarvis-obsidian-plugin-0.1.0.zip` — `main.js`, `manifest.json`, `styles.css`.
- `SHA256SUMS`.

The build downloads the official Node runtime for the pinned version from nodejs.org, verifies it against `SHASUMS256.txt`, and bundles it.
Artifacts are unsigned; notarisation and Obsidian community-directory submission are external steps (see the acceptance report).

## Verification

```sh
node scripts/verify-release.mjs           # everything: checks, builds, e2e, voice, Obsidian, install/upgrade/restore/uninstall, live read-only
node scripts/verify-release.mjs --quick   # lint, typecheck, builds, Vitest only
```

Results: `test-results/verification-summary.md` (acceptance table) and `test-results/verification-report.json`.
Individual suites: `node scripts/test-install.mjs`, `npx playwright test tests/e2e/obsidian.spec.ts`, `npx playwright test tests/e2e/voice.spec.ts`.

## Rules for changes

- Only the service writes memory, and only through `MemoryStore`, which applies `memory/policy.ts`.
  Model output becomes a proposal, never a direct write.
- Every remote call goes through `connectors/http.ts` and records coverage per scope; a failure must never look like an empty result.
- External side effects run inside `ctx.effect(key, run, find)` so restarts cannot repeat them.
- Features are defined once in `capabilities/registry.ts`; endpoints check them with `requireFeature`.
- Database migrations are append-only in `core/db.ts`.
- Code runs under Node type stripping: no enums, no parameter properties (`erasableSyntaxOnly`).
