# Attache developer guide

Developer setup is separate from end-user installation: users run the installer artifact and never need these tools.

## Layout

| Path | What |
| --- | --- |
| `packages/contracts` | Versioned API contract (`/api/v1`): zod request schemas and response types shared by every client, and wording both the service and the Dashboard show (`wording.ts`) |
| `apps/service` | The local service: memory writer, index, attention, jobs, scheduler, approvals, connectors, HTTP API, MCP server |
| `apps/web` | Browser client (React + Vite), served by the service |
| `installer` | `install.sh`, `uninstall.sh` shipped inside the release |
| `scripts` | Release build, verification, install tests, live read-only checks, docs check |
| `tests/e2e` | Playwright journeys (Chrome, visual captures): one `*.spec.ts` per area, each opening with a comment that says what it covers and whether it runs on its own (the docs check requires it); the other files are their shared kit |
| `docs` | Architecture, guides, architecture decision records |

Service modules: `core/` (db, config, logging with redaction, service paths), `platform/` (everything that differs per operating system: service manager, secret store, notifications, locations, Harness locations, executable wrappers; see `docs/architecture.md`), `memory/` (Markdown model, policy, indexer, search, store), `attention/`, `jobs/` (queue, scheduler, runners), `actions/` (drafts, approvals, expiry), `connectors/` (one adapter per service plus manager), `capabilities/registry.ts`, `http/`, `mcp/` (the MCP server a Harness starts with `attache mcp`).

## Requirements

- macOS, Linux or Windows for lint, typecheck, Vitest and the browser journeys.
  The install test needs macOS on Apple silicon, or Linux on x86_64 with a systemd user manager.
- On Windows, Git for Windows: the tests run Claude Code's hook commands through Git Bash, as Claude Code does, and Codex's through cmd.exe.
  `ATTACHE_TEST_GIT_BASH` points the tests at a Git Bash outside `C:\Program Files\Git`.
- `apps/service/test/linux-desktop.test.ts` runs the Linux secret store and notifications anywhere, against stand-ins for `secret-tool` and `notify-send`.
  `apps/service/test/linux-desktop-real.test.ts` checks the same against GNOME Keyring and dunst; it runs only on Linux with `ATTACHE_TEST_REAL_DESKTOP=1` inside `scripts/linux-desktop-session.sh`, as CI's Linux job does (needs `dbus`, `gnome-keyring`, `libsecret-tools`, `libnotify-bin`, `dunst`, `xvfb`, `xauth`).
- `apps/service/test/windows-desktop.test.ts` runs the Windows secret store and notifications anywhere, against a stand-in for Windows PowerShell (`fake-powershell.mjs`) and for `icacls` and `whoami`.
  `apps/service/test/windows-desktop-real.test.ts` checks the same against Credential Manager and Windows notifications; it runs only on Windows with `ATTACHE_TEST_REAL_DESKTOP=1`, as CI's Windows job does, because it shows notifications and writes to your Credential Manager (it removes what it wrote).
- Node 24.22.0 or newer, whichever compatible version you have installed: `engines.node` in `package.json` names the minimum, and `pnpm install` refuses an older Node (`engineStrict` in `pnpm-workspace.yaml`).
  Node 22 lacks FTS5 in `node:sqlite`.
  Before 24.22.0, Node on Linux stops reporting changes to a file after it is replaced by a rename, so hand edits to the Brain go unnoticed (`apps/service/test/memory-watcher.test.ts` fails on 24.21).
  The release bundles one exact Node of its own, `BUNDLED_NODE_VERSION` in `scripts/release-targets.mjs`, which must be at least the minimum.
- pnpm 11.
- Google Chrome (Playwright uses the installed Chrome channel).
- Optional: the Claude Code CLI signed in with claude.ai for live model use and the live Slack, Gmail and Calendar checks.

```sh
pnpm install
pnpm build              # contracts, service bundle, Dashboard
pnpm test               # Vitest: unit, adapter contract and HTTP integration tests
pnpm e2e                # Playwright journeys (builds as needed)
pnpm lint               # docs check, then ESLint
pnpm typecheck          # every workspace package, then tests/e2e and playwright.config.ts
```

Run the service against a scratch profile while developing:

```sh
pnpm dev                 # [--port 7500] [--state-dir <folder>]
```

`pnpm dev` (`scripts/dev.mjs`) builds everything once, runs the service from its bundle against a scratch state folder (`<temp>/attache-dev` unless you name one), rebuilds and restarts it when the source changes, and serves the Dashboard with hot reload on `http://localhost:5173`.
It prints a pairing link for that client.
The scratch profile keeps its secrets in a file, and its writer locks and Harness home (`ATTACHE_AGENT_HOME`) inside the state folder, so connecting a Harness there never touches your own.
The same steps by hand:

```sh
node apps/service/build.mjs --watch &            # rebuild on change
ATTACHE_CREDENTIAL_STORE=file node apps/service/dist/attache-service.mjs serve --state-dir /tmp/attache-dev --port 7500
node apps/service/dist/attache-service.mjs pair --state-dir /tmp/attache-dev --open
ATTACHE_DEV_SERVICE=http://127.0.0.1:7500 ATTACHE_DEV_ORIGINS=http://localhost:5173 pnpm --filter @attache/web dev   # optional hot-reload client
```

Environment variables: `ATTACHE_STATE_DIR`, `ATTACHE_PORT`, `ATTACHE_INSTANCE` (names the Keychain service and the background service), `ATTACHE_CREDENTIAL_STORE=file` (use the owner-only file instead of the system secret store), `ATTACHE_WEB_DIR`, `ATTACHE_DEV_ORIGINS`, `ATTACHE_NO_NOTIFY=1`, `ATTACHE_CLAUDE_BIN`, `ATTACHE_AGENT_HOME` (home folder whose Harness hooks and MCP configuration are edited), `ATTACHE_HARNESS_TOOL_DIRS` (the only folders, separated as in `PATH`, where Harness executables are looked for; the e2e stack sets it to the test home's `.local/bin`), `ATTACHE_OPENCODE_BIN` and `ATTACHE_COPILOT_BIN` (the OpenCode and Copilot CLI executables asked for their version), `ATTACHE_AGENT_HOOK_SCRIPT`, `ATTACHE_CLI_SCRIPT` (the CLI script a Harness runs as Attache's MCP server; tests point it at `apps/service/src/main.ts`), `ATTACHE_LOCK_DIR` (where writer locks live; every service that should refuse to share a data folder must see the same value), `ATTACHE_MEANING_MODEL` (a JSON model description to download instead of multilingual-e5-small; the e2e stack points it at the fixture model), `ATTACHE_SECRET_TOOL_BIN` and `ATTACHE_NOTIFY_SEND_BIN` (the `secret-tool` and `notify-send` Attache runs on Linux), `ATTACHE_POWERSHELL_BIN`, `ATTACHE_ICACLS_BIN` and `ATTACHE_WHOAMI_BIN` (the Windows PowerShell, `icacls` and `whoami` Attache runs on Windows); tests point them at the recording stand-ins in `apps/service/test/fixtures/`.

Connecting a Harness edits real files in your home folder (`~/.claude`, `~/.claude.json`, `~/.codex`, `~/.gemini`, Claude Desktop's settings folder).
Every Vitest and browser-journey run gets one temporary folder, `attache-run-<process id>-*`, and points `TMPDIR`, `TMP` and `TEMP` at it (`scripts/test-run-folder.mjs`), so the folders tests make with `os.tmpdir()` are removed when the run ends; a killed run's folder is removed by the next run.
Vitest (`apps/service/test/setup-env.ts`) and the e2e stack set `ATTACHE_LOCK_DIR` to a temporary folder, so test services never leave locks in your home folder.
The test harness and the e2e stack always set `ATTACHE_AGENT_HOME` to a temporary folder; do the same for a scratch service, or connecting a Harness will add hooks and an MCP server for the scratch instance to your own Harnesses.
`attache agent-hooks status` lists this install's hooks and MCP server entries, and `attache agent-hooks uninstall [--agent <kind>]` removes them.

## Continuous integration

`.github/workflows/ci.yml` runs on GitHub's macOS, Linux and Windows machines (`macos-latest`, `ubuntu-latest`, `windows-latest`).
Which jobs run depends on what started the run, so a branch with a pull request runs each job once:

| Started by | Jobs |
| --- | --- |
| A push to any branch, `main` included | `checks` and `journeys` on `ubuntu-latest` and on `ubuntu-latest, current Node`, `install (ubuntu-latest)` |
| A pull request that is not a draft: opened, pushed to, reopened or marked ready for review | `checks` and `journeys` on `macos-latest` and `windows-latest`, `install (macos-latest)` and `install (windows-latest)` |
| A run started by hand (`gh workflow run CI --ref <branch>`) | All of them |
| The nightly schedule, 23:15 UTC on `main` | `checks` and `journeys` on `ubuntu-latest` and on `ubuntu-latest, current Node`, so a test that breaks in the last hour before midnight UTC fails there first |

A pull request's macOS and Windows jobs check the commit GitHub would merge; a draft pull request, or a branch without one, runs only the Linux jobs.
The jobs named only by their machine, such as `checks (windows-latest)`, run on the minimum supported Node (`scripts/node-minimum.mjs` reads it from `engines.node`); those marked `current Node` run the same steps on the newest Node release.
Every job sets up pnpm, Node and the dependencies the same way, through `.github/actions/setup`.
The browser journeys have their own `journeys` job beside `checks`, so on Windows, the slowest machine, neither job runs near its 30-minute limit.
The steps:

| Step | Run it locally |
| --- | --- |
| Install (every job) | `pnpm install --frozen-lockfile` |
| Lint | `pnpm lint --max-warnings 0` |
| Typecheck | `pnpm typecheck` |
| Unit and integration tests | `pnpm test` |
| Linux desktop session tests (Linux only) | `ATTACHE_TEST_REAL_DESKTOP=1 sh scripts/linux-desktop-session.sh pnpm vitest run apps/service/test/linux-desktop-real.test.ts` |
| Windows desktop tests (Windows only) | `ATTACHE_TEST_REAL_DESKTOP=1 pnpm vitest run apps/service/test/windows-desktop-real.test.ts` |
| Browser journeys (the `journeys` job) | `npx playwright install chrome` once, then `pnpm e2e` |

Separate jobs, `install (ubuntu-latest)`, `install (macos-latest)` and `install (windows-latest)`, run the install test (see "Install test" below) on the minimum supported Node and upload `test-results/install-results.json`.
When a check fails, the install test copies the installed service's logs (`service.log`, `service.err.log`, `service.out.log`) to `test-results/install-logs/` before it removes the state folder, and the job uploads them with the results.

Every check runs even when an earlier one fails, so a run lists all failures at once.
Each Vitest and browser-journey run copies its test services' logs to `test-results/service-logs/` on CI before it removes its temporary folder.
On failure a job also runs `node scripts/collect-service-logs.mjs`, which copies the `logs` folders that test services left in Attache's temporary folders (a killed run, a crashed install test) to the same place, and uploads `test-results/` (Playwright traces and screenshots, service logs) as an artifact.
pnpm comes from `packageManager` in `package.json`, so CI and a local checkout use the same pnpm.
`.gitattributes` checks every file out with LF line endings, Windows included, so fixtures are the same bytes on every platform.
Tests run git with an empty global configuration (`apps/service/test/setup-env.ts`), as on a fresh computer, so a step that needs the developer's own git identity fails locally as it would on CI.
The e2e stack (`tests/e2e/stack.ts`) starts its services and fixture server on ports the OS picks, so several checkouts on one computer can run `pnpm e2e` at the same time.
Linux has no Georgia, the headings' font, so on Linux the browser journeys start Chrome with `FONTCONFIG_FILE` set to `tests/e2e/fonts/fonts.conf`, which draws Georgia with the bundled, metric-compatible Gelasio (`tests/e2e/fonts.ts`).
Headings then wrap and overflow as on macOS and Windows, so a layout bug at a narrow width fails on Linux too; the `type:` journey in `shell.spec.ts` checks the mapping.
Test services keep their state, Brain and Harness home in folders whose names have a space and non-ASCII letters (`testFolder` in `apps/service/test/integration/harness.ts`), so every suite covers such paths.

To reproduce a Linux failure on a Mac, run the same commands in a container with the Node of the failing job, for example `docker run --rm -it -v "$PWD":/src:ro node:24.22.0-bookworm bash` for the minimum, then copy `/src` to a writable folder without `node_modules`, run `corepack enable` and the commands above as a non-root user.

A pull request with a failing check shows the failure on GitHub.
`node scripts/ci-failures.mjs <run-id|run-url>` prints, for each failed job of a run, the failed step, the failing tests and their first error lines, or the step's last lines when it names no test.
For a job GitHub stopped it says why: its time limit (after how long, and in which step) or a newer run of the same branch that replaced it; for a job that never started it says why too (a billing or spending limit, a cancelled run).
A failed journey leaves a Playwright trace in its job's uploaded results (`gh run download <run-id> -n journeys-results-<os>-node-<node>`); `node scripts/trace-requests.mjs <trace.zip> [path filter]` lists the API calls the page made, with their request and response bodies.
It needs the GitHub CLI (`gh`) signed in to an account that can read the repository.
Branch protection on `main` requires `checks` and `journeys` on `ubuntu-latest`, `macos-latest` and `windows-latest` to pass before a pull request can merge.
The `current Node` and `install` jobs are not required, so a new Node release or a slow or flaky installer run does not hold up a merge; check them before a release.
Before a release, also start a run by hand on `main`: a push to `main` runs only the Linux jobs.

## Fixtures versus live

Contract and journey tests use a local fixture server (`apps/service/test/fixtures`) that emulates GitHub REST, the Atlassian Rovo MCP server with its OAuth 2.1 authorization server (`atlassian-mcp.ts`), the claude.ai connectors (`claude-connectors.ts`) and a model (`fixture-model.ts`), served as an OpenAI-compatible endpoint, as the Anthropic API, and to `fake-claude.mjs` for Claude Code's plain model calls.
The service talks to it only when `ATTACHE_TEST_ENDPOINTS=1` and `ATTACHE_FIXTURE_URL` are set; normal operation never reads those variables.
The claude.ai connectors are reached through the Claude Code CLI, which tests replace with `fake-claude.mjs` (on Windows `fake-claude.cmd`, an npm-style shim around it, as `npm install -g` installs Claude Code there) through `ATTACHE_CLAUDE_BIN` (plus `ATTACHE_FAKE_CLAUDE_URL` and an empty `CLAUDE_CONFIG_DIR`).
It speaks the same stream-json and permission-control protocol as the real CLI and can misbehave on request (unplanned calls, altered arguments, skipped calls, signed out, pending connectors), so the approval gate is tested for real.
Fixture results are never reported as live results.

Tests never download the real meaning model.
`apps/service/test/fixtures/fixture-meaning-model.ts` builds a tiny ONNX model (one `Gather` node, written by `onnx-writer.ts`) and a word-level tokenizer with the same files as the real one, and serves them from the fixture server; the integration tests and browser journeys download it through the normal path and run the real ONNX runtime on it.
To check the real model on a platform, download its files from the pinned revision in `apps/service/src/meaning/model.ts` and run `ATTACHE_TEST_REAL_MODEL_DIR=<folder> pnpm test apps/service/test/integration/meaning-real-model.test.ts`; without the variable that test is skipped.
`scripts/live-readonly.mjs` performs real, read-only checks in a throwaway profile and reports them separately: GitHub with the GitHub CLI login, Slack, Gmail and Calendar through the signed-in Claude Code CLI, and Jira and Confluence only when `ATTACHE_LIVE_ATLASSIAN_SITE`, `_EMAIL` and `_TOKEN` supply an MCP-scoped token.

## Several Machines in one test

`apps/service/test/integration/machines.ts` starts several Machines in one Vitest process, each a whole service with its own state folder, Brain copy and `ManualClock` (`apps/service/test/fixtures/manual-clock.ts`).
`startMachines(["Mac", "PC"])` creates a local bare repository as the remote, sets Replication up on the first Machine and joins the others into empty folders; `world.addMachine(name, { join: false })` adds one that stays apart.
Nothing replicates until a test moves a Machine's clock: `await mac.clock.advance(30_000)` runs the commit due after a save, `advance(60_000)` the one-minute check, and `advance` waits for the check it started.
`world.remote.goOffline()` and `goOnline()` make the remote unreachable and back; `world.remote.git(...)` inspects what was pushed.
The bare repository refuses any push that is not a fast-forward, so a test fails if Replication ever rewrote history.
`ATTACHE_GIT_BIN` points Replication at another git executable.
For GitHub itself, `apps/service/test/fixtures/github-git-server.ts` serves git's smart HTTP protocol (through the Machine's `git http-backend`) behind token authentication, plus `GET /repos/{owner}/{name}` with a visibility the test sets.
`replication-private-repo.test.ts` sends `https://github.com/` there with git's `url.<base>.insteadOf`, set through `GIT_CONFIG_COUNT` in the environment, and points the GitHub connection's API URL at it, so no test-only code is needed in the service.

## Recall evaluation

A change to search ships only when it improves recall evaluation.
`apps/service/test/fixtures/recall-brain/` is a synthetic Brain with its own question set in `evaluation/recall-questions.json`, mixing exact lookups (ticket numbers, repository names), paraphrases and Danish questions.
`apps/service/test/integration/recall-evaluation.test.ts` scores it on every `pnpm test` twice and fails if either drops below its recorded baseline: keyword search only (`BASELINE`: first result 16 of 22, first three 18 of 22), and with meaning-based search on the fixture meaning model (`MEANING_BASELINE`: first result 19 of 22, first three 20 of 22).
The fixture model knows only the concept words listed in `fixture-meaning-model.ts`; add one there when a synthetic question needs it.
When a change improves the score, raise the baseline in the same commit.
The owner's real set lives in their Brain; run `attache evaluate-recall` against the running service before and after a search change and compare, with meaning-based search ready both times (the report's first lines say how search ranked).

## Release

```sh
node scripts/release-signing.mjs keygen key.pem public.pem             # a test key pair, once
node scripts/build-release.mjs --version 0.1.0 --signing-key key.pem --public-key public.pem                        # for this computer
node scripts/build-release.mjs --version 0.1.0 --signing-key key.pem --public-key public.pem --target windows-x64   # macos-arm64, linux-x64 or windows-x64
```

Every release is signed (ADR 0007), so the build needs a key pair.
The public key is a build input: `--public-key` is built into the service bundle as a constant (`apps/service/build.mjs` defines `process.env.ATTACHE_RELEASE_PUBLIC_KEY`), and the installed release checks every later release with it.
`--signing-key` must belong to that public key; the build refuses a pair that does not match before it starts.
Test builds use a test key made by the signing tool; the release workflow uses the real one.
A bundle built without a public key, as `pnpm build` makes for development and the browser journeys, holds no key and accepts no release.
`--notes <file.md>` puts the release notes into the manifest, and `--next-public-key <file>` names the key that signs the following releases.

macOS and Linux build every target; Windows builds only its own, because a Windows file system cannot mark the macOS and Linux programs executable.
Produces in `release/0.1.0/`:

- `Attache-Installer-0.1.0-macos-arm64.command` — self-extracting one-step installer for macOS (double-click or `sh`).
- `Attache-Installer-0.1.0-linux-x64.sh` — self-extracting one-step installer for Linux (`sh`).
- `Attache-Installer-0.1.0-windows-x64.cmd` — self-extracting one-step installer for Windows (double-click).
  Its plain-ASCII batch header hands a PowerShell script (as `-EncodedCommand`) the zip's byte offset; the script copies the zip out, unpacks it with .NET and runs `install.ps1`.
- `attache-0.1.0-<target>.tar.gz` (macOS, Linux) or `attache-0.1.0-windows-x64.zip` — the same release as a folder with `install.sh`, or `install.cmd` and `install.ps1`.
  `scripts/zip.mjs` writes the zip, so no host needs a zip tool.
- `attache-0.1.0-manifest.json` — the release manifest: the version, its Update channel (Beta for a `-beta.N` version, otherwise Stable), the publish time, the release notes in Markdown, and per target the archive's name, size and SHA-256, and optionally the next public key (`apps/service/src/release/manifest.ts`).
- `attache-0.1.0-manifest.json.sig` — an Ed25519 signature over the manifest's exact bytes, in base64.
- `SHA256SUMS`, covering every file above.

Building another target into the same folder writes the manifest, its signature and every one-step installer again (`scripts/release-seal.mjs`), so they always cover every archive in the folder.
Each one-step installer carries the manifest, its signature and the archive after its header, and unpacks all three into the temporary folder it installs from.
Run over an existing install, `install.sh` and `install.ps1` first have the installed version run `attache verify-release <folder> --version <v> --target <t>` on that folder, and stop with nothing changed when the signature or the archive's checksum does not match.
A version from before signed releases cannot run that command, so the installer says so and installs without the check; a first install has nothing to check against.
`ATTACHE_RELEASE_DIR` names another folder holding the manifest, signature and archive, for an installer run from a release unpacked elsewhere.

### Publishing a release

Releases are published by CI, never from a laptop: pushing a tag `v<version>` runs `.github/workflows/release.yml`.
Its header says what each job does; in short, it refuses before building, builds every target on Linux, signs in the protected `release` environment and creates the GitHub release.

1. Write the release notes as a new section `## <version>` at the top of `CHANGELOG.md`, for owners and in the glossary's words.
   The workflow copies that section, unchanged, into the GitHub release and into the signed manifest, which the Dashboard shows under What changed.
2. Bump the version in a commit: `version` in `package.json` (the one the release build reads and the workflow checks the tag against), and the same number in `apps/service/package.json`, `apps/web/package.json`, `packages/contracts/package.json` and the fallback in `apps/service/src/core/version.ts`.
3. Merge it to `main`, then start the full CI run on that commit: `gh workflow run ci.yml --ref main`.
   Only a run started by hand runs every job on the commit itself, the install test on Linux, macOS and Windows included; a push runs the Linux jobs only, and a pull request runs macOS and Windows on the commit it would merge.
4. When that run has passed, tag the same commit and push the tag: `git tag v0.7.0-beta.1 <commit> && git push origin v0.7.0-beta.1`.
5. With a required reviewer on the `release` environment, approve the `seal` job in the run; the `publish` job then creates the release.

`scripts/release-gate.mjs` refuses, each with a message saying what to do: a tag that is not `v` followed by the version in `package.json`, a version that is neither `x.y.z` nor `x.y.z-beta.N`, a version without a section in `CHANGELOG.md` or with an empty one, a missing `.github/release-public-key.pem`, and a commit with no CI run started by hand on it whose jobs all passed, none skipped.
After fixing the cause, re-run the workflow run (Re-run all jobs); the tag stays where it is unless the fix needed a new commit, which needs a new version and tag.
A tag `vx.y.z-beta.N` makes a GitHub release marked as a pre-release, a Beta release; a tag `vx.y.z` makes a Stable release marked Latest.
Each release holds the three one-step installers, the three archives, the manifest, its signature and `SHA256SUMS`.

The signing key is the `RELEASE_SIGNING_KEY` secret of the `release` environment, which only tags `v*` may use, so a branch's workflow can never read it.
The build job builds the archives unsealed (`build-release.mjs --unsealed`), with the committed public key built in and without the signing key; the seal job writes and signs the manifest (`release-signing.mjs seal`), verifies the result with the signing tool, and deletes the key file before anything else runs, and the publish job verifies again against the committed public key.

A dry run proves the workflow without publishing.
A push to any branch that changes the release machinery (the `paths` in the workflow: the workflow itself, `CHANGELOG.md`, the release scripts, `apps/service/src/release/`) starts one, and `gh workflow run release.yml --ref <branch> [-f version=0.7.0-beta.1]` starts one by hand; GitHub only offers that for a workflow that is on `main`.
It builds the version given (by default the one in `package.json`) with a throwaway key pair made for the run, seals and verifies it outside the `release` environment, and keeps the sealed release as the run's `release` artifact for a day.
What would refuse a real release shows as warnings in the run's summary instead of failing it.
The throwaway signing key is deleted from the run once used.

The key is made once, by hand: `bash scripts/release-key-wizard.sh` makes the key pair, creates the protected `release` environment (tags `v*` only, optionally your approval before each release is signed), stores the signing key as its secret, waits until you have an offline backup, deletes this computer's copy and commits the public key at `.github/release-public-key.pem` (added with `--force`, since `*.pem` is ignored).
Never replace that key: installed Machines would refuse every later release.
To change it, rotate it with a release whose manifest names the next key (`--next-public-key`, see below).

### Signing tool

`scripts/release-signing.mjs` makes a key pair, signs a manifest and verifies a release, with the same code the release build and the installed service run (`apps/service/src/release/`) and Node's built-in Ed25519.

```sh
node scripts/release-signing.mjs keygen key.pem public.pem                          # never overwrites an existing key
node scripts/release-signing.mjs sign release/0.1.0/attache-0.1.0-manifest.json --key key.pem
node scripts/release-signing.mjs seal release/0.1.0 --version 0.1.0 --key key.pem --public-key public.pem [--notes notes.md]   # archives built with --unsealed
node scripts/release-signing.mjs verify release/0.1.0 --public-key public.pem [--targets macos-arm64,linux-x64,windows-x64]   # the signature, then every archive the manifest names
```

Keys are PEM files: PKCS #8 for the signing key, SPKI for the public key, so `openssl` reads them too.
`*.pem` files are ignored by git, so a signing key never lands in a commit by accident.
A manifest signed with a key the Machine trusts may name the next public key; the Machine then keeps it in `release-keys.json` in its state folder and accepts releases signed with it, which is how the key rotates without a manual install.

Targets are listed in `scripts/release-targets.mjs`, the one-step installers' headers in `scripts/release-installers.mjs`.
The build downloads the official Node runtime of `BUNDLED_NODE_VERSION` (`scripts/release-targets.mjs`) for the target from nodejs.org (the tarball for macOS and Linux, `win-x64/node.exe` for Windows), verifies it against `SHASUMS256.txt`, and bundles it.
The release carries a `TARGET` file, and `install.sh` and `install.ps1` refuse to run on any other kind of computer.
The Windows installer and uninstaller (`installer/install.ps1`, `installer/uninstall.ps1`) are plain ASCII, because Windows PowerShell reads a script without a byte order mark in the legacy code page.
They switch versions with a directory junction (`current`), which needs no administrator rights, unlike a symbolic link.
Artifacts are unsigned; notarisation is an external step (see the acceptance report).

## Install test

`node scripts/test-install.mjs --from 0.1.0 --to 0.1.1` builds both releases for this computer from the current source, signed with a test key it makes with the signing tool.
It checks that the installed release verifies a release signed with that key and refuses one signed with another, and that installers carrying a manifest or an archive changed after signing are refused with nothing on the Machine changed (`scripts/install-test/signed-releases.mjs`).
It then installs, reinstalls, installs a newer release over the old one, crashes the service, backs up, restores and uninstalls in a clean temporary home folder whose name has a space and the letters æøå, with its own service name and port.
It checks that the service starts at login and comes back after a crash, that hooks keep working across the newer release's install, and that uninstall leaves every file the owner had before Attache as it was.
It also builds a third release (`--next`, by default `--to` with its last number raised by one) and runs `attache update` against a local stand-in for GitHub Releases (`scripts/install-test/release-server.mjs`; the installer passes `ATTACHE_RELEASE_FEED_URL` on to the service definition).
That scenario (`scripts/install-test/update.mjs`, checks with id `update`) refuses an archive changed after signing with nothing changed, then installs the newer release unattended and checks the outcome record, the Updates status, the kept configuration and data, and that only the current and previous versions remain; on Windows a folder a running program holds stays whole.
What differs per operating system (where the release installs, how to run its scripts and a Harness's hooks, how to ask launchd, systemd or Task Scheduler about the service) is in `scripts/install-test/platform.mjs`.
The CI jobs `install (ubuntu-latest)`, `install (macos-latest)` and `install (windows-latest)` run it on Linux, macOS and Windows.
On Windows it runs the installer and the wrappers through cmd.exe and the Claude Code hooks through Git Bash, as a terminal and Claude Code do.
The GitHub runner's account is an administrator, so the test cannot show that registering the logon task needs no administrator rights; that is checked by hand on a Windows machine.
A CI job has no login session, so the job turns on lingering for the runner user to get a systemd user manager.

To run it on Linux from a Mac, use an x86_64 container with systemd as its init, an ordinary user with lingering on (`touch /var/lib/systemd/linger/<user>`), and Google Chrome.
Start it with `--privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock`; Ubuntu 22.04 works under emulation, while 24.04's systemd fails to start services there.
Mask `systemd-binfmt.service` in that image.
A privileged container shares Docker Desktop's binfmt table, and systemd would otherwise unregister x86_64 emulation for every container until `docker run --privileged --rm tonistiigi/binfmt --install amd64` restores it.

## Verification

```sh
node scripts/verify-release.mjs           # everything: checks, builds, e2e, install/upgrade/restore/uninstall, live read-only
node scripts/verify-release.mjs --quick   # lint, typecheck, builds, Vitest only
```

Results: `test-results/verification-summary.md` (one row per step) and `test-results/verification-report.json`.
Individual suites: `node scripts/test-install.mjs`, `npx playwright test tests/e2e/journeys.spec.ts`.

## Rules for changes

- Only the service writes memory, and only through `MemoryStore`, which applies `memory/policy.ts`.
  Model output becomes a proposal, never a direct write.
- Every remote call goes through `connectors/http.ts` and records coverage per scope; a failure must never look like an empty result.
- External side effects run inside `ctx.effect(key, run, find)` so restarts cannot repeat them.
- Features are defined once in `capabilities/registry.ts`; endpoints check them with `requireFeature`.
- Service code starts tools with `run`, `spawnTool` or `launchTool` and replaces files with `replaceWith` from `platform/`, and `pnpm lint` rejects a `node:child_process` import or an fs `rename` outside `platform/`, so Windows shims, console windows and locked files are handled in one place.
- The Dashboard's colours, radii and type come from the tokens in `apps/web/src/styles/tokens.css`, never from a literal in a component or screen file.
  A new or changed colour token must pass `apps/web/test/contrast.test.ts` (4.5:1 for text, 3:1 for icons, bars and borders, in light and dark), and a colour always comes with an icon or a word.
  The bundled font files must stay within 150 KB, or `pnpm build` fails (`apps/web/tooling/font-budget.ts`).
- Database migrations are append-only in `core/db.ts`.
- Code runs under Node type stripping: no enums, no parameter properties (`erasableSyntaxOnly`).
- In Markdown, each sentence sits on its own line, and text the owner reads uses the glossary's terms.
- A count in text the owner reads gives its noun in the right number ("1 file", "2 files"), never `file(s)`; code builds it with `plural` from `@attache/contracts`.
  `pnpm lint` checks all three with `scripts/check-docs.mjs`, which reads the words to avoid from `GLOSSARY.md`, so a word added there is checked from then on.
  Its header says which files and which strings it reads; an avoided word that is also the ordinary name of something else goes in its `ORDINARY_WORDS` list, with the reason.
