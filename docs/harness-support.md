# Harness support matrix

What Attache's Connection to each Harness is tested to do, and the evidence each claim rests on (ADR 0006).
"Officially supported" means Attache's integration passed its fixture tests and its smoke test against the real executable; it is not an endorsement by the Harness's maker.
A failing smoke test withdraws the claims for that Harness only.
The user guide explains setup and recovery per Harness; this page is the record maintainers update when a Harness changes.

## Capabilities

| Harness | MCP access | Memory | Session capture | Restart after connecting |
|---|---|---|---|---|
| Claude Code | yes | at session start (hook) | before compaction and at session end | no |
| Codex | yes | at session start (hook, after you trust it) | before compaction and at session end | no |
| Antigravity | yes | always-on rule file | after each turn, no session end: the newest in-flight turn can be missed | no |
| Claude Desktop | yes | none | none; use the wrap-up prompt | yes |
| Pi | yes | before every model call | after each prompt, before compaction and when the session closes | yes: `/reload` or a new session |
| OpenCode | yes | before every model call | after each turn and before compaction, no session end: a turn still running when OpenCode quits can be missed | yes, and `opencode service restart` for OpenCode 2 |
| Copilot CLI | yes | at session start, `/clear` and resume; none after `/compact` | after each turn, before compaction and at session end | yes: a new `copilot` process |

Known in-flight-turn limits:

- **Pi:** Pi reports closing on Ctrl+C, Ctrl+D and when it is stopped, so only a Pi that is killed or crashes can lose its newest turn.
- **OpenCode:** it has no session-end event, so the newest turn is saved only once it ends.
- **Copilot CLI:** a Copilot CLI that is killed or crashes mid-turn can lose that turn; each `agentStop` waits up to 3 seconds for Copilot CLI to write the finished turn.
- **Antigravity:** no session-end event; a turn still running when it quits can be missed.

## What the real-executable smoke tests verify

Each smoke test (`apps/service/test/integration/<harness>-smoke.test.ts`) installs into an isolated home, runs the real executable against a local stand-in model (no model account, no sign-in, never the owner's real configuration), and checks:

| Step | Pi | OpenCode | Copilot CLI |
|---|---|---|---|
| Detect | real executable in the owner's tool folder | real executable in the owner's tool folder | real executable in the owner's tool folder |
| Preview | capabilities, restart, every file | capabilities, restart, every file | capabilities, restart, every file |
| Apply and current status | extension written, Connection current | plugin written, Connection current | MCP entry and hooks file written, Connection current |
| MCP access | Pi registers and connects the server, its tools listed | OpenCode lists the server as connected | Copilot CLI lists the server, enabled, beside the owner's; the server it starts answers from the Brain |
| Memory | every model call, fresh after a Brain change, a compaction and a resume; never saved in the session | every model call, fresh after a Brain change, a compaction and a resume; none in compaction requests; never saved | new, resumed and `/clear` sessions, one block as its own message; not stored as a conversation message |
| Capture | each prompt, compaction, quit and resume, without tool output, memory or summaries | each turn, compaction and resume, without tool output, memory or the summary | each turn, resume, `/compact` and terminal close, without tool output |
| Refresh | a stale extension is repaired with a backup and Pi loads it | a stale plugin is repaired with a backup and OpenCode loads it | a stale hooks file is repaired with a backup and Copilot CLI runs it |
| Uninstall | no Attache server, memory or saving | no Attache plugin, server or memory | no Attache server, memory or saving; the owner's server and hooks kept |

Run one with the executable named, for example `ATTACHE_PI_EXECUTABLE=<path>/pi pnpm vitest run apps/service/test/integration/pi-smoke.test.ts`; `ATTACHE_OPENCODE_EXECUTABLE` and `ATTACHE_COPILOT_EXECUTABLE` work the same way.
Without the executable on `PATH` or named, a smoke test is skipped, and a skipped smoke test is no evidence.

## Last verified

All runs on macOS 26.6 (Darwin 25.6.0, Apple silicon), 2026-11-22, branch `spec-98-110-support-contracts`.

| Harness | Version | Smoke test result |
|---|---|---|
| Pi | `@earendil-works/pi-coding-agent` 1.6.0 | 5 of 5 passed |
| OpenCode 1 | `opencode-ai` 1.19.6 | 5 of 5 passed |
| OpenCode 2 | `@opencode/cli` 2.3.2 | 5 of 5 passed |
| Copilot CLI | `@github/copilot` 1.0.114 | 9 of 9 passed (on `spec-98` after the #110 merge) |

Linux and Windows are not verified for any of the three: their paths and hook commands are fixture-tested only.

## Observed contracts

### Pi

- Upstream: `earendil-works/pi` at `a00a504`, `packages/coding-agent/docs/extensions.md`, `docs/settings.md` and `src/core/extensions/`.
- Extensions in `<agent dir>/extensions/` load on their own; `pi.registerMcpServer` registers a server for that session only, and Pi names its tools `mcp__<server>` with `-` turned into `_`.
- Pi's MCP client calls itself `pi`.
- A `context` handler runs before every model call; its custom message reaches the model and is not written to the session file.
- `agent_settled`, `session_before_compact` and `session_shutdown` (awaited, also on SIGTERM and end of input) carry the session manager, whose branch already holds the finished turn.
- `--no-session` sessions, such as Pi's subagent example, have no session file and are never saved.
- Not verified by a run: `fork` keeping entry ids, `/tree` snapshots, Ctrl+C in the terminal interface, `-builtin:mcp`.

### OpenCode

- Upstream: `anomalyco/opencode` at `v1.19.6` (`f4e363c829`) and `v2.3.2` (`c0ad18b402`), plugin docs and source.
- Both majors load `<config dir>/plugins/*.js`; OpenCode 1 through `server()` hooks, OpenCode 2 through `setup(ctx)` inside a server (`opencode serve` or its background service).
- Both MCP clients call themselves `opencode`.
- Memory added to the system prompt is never written to `opencode.db` or the data folder.
- OpenCode 1 runs the system transform for compaction and title requests too; Attache skips the compaction request.
- OpenCode 2's `context` hook does not run for compaction or title requests.
- OpenCode 1's `dispose` did not run on SIGTERM; OpenCode 2's cleanup did.
- Not verified by a run: OpenCode 1 overflow auto-compaction replay, a second OpenCode 2 compaction, hot reload of a changed plugin, `--pure`, project-level overrides.

### Copilot CLI

- Upstream: docs.github.com "Adding MCP servers", "Using hooks", hooks configuration reference, CLI configuration folder reference and `github/copilot-cli` changelog (read 2026-11-20).
- Personal `mcp-config.json` accepts comments and trailing commas; `copilot mcp add` rewrites it as plain JSON.
- Personal `hooks/*.json` command hooks run; `sessionStart` `additionalContext` reaches the model as its own user message and is stored only inside the `hook.end` event of `events.jsonl`.
- `/compact` drops the memory message and `sessionStart` does not run again.
- `events.jsonl` is written in batches of about 100 ms, after `agentStop` starts.
- Real sessions ran offline with a bring-your-own-key stand-in model; no GitHub sign-in was used, so Copilot CLI's MCP client name is not verified and Copilot CLI shows as an unknown Harness in saves.
- Not verified by a run: SIGTERM or SIGKILL mid-turn, `session.truncation` and rewind, a repository's `disableAllHooks`, sandbox mode.

## Gaps that do not change these claims

- Saves through MCP from Pi, OpenCode and Copilot CLI have no auto-accept switch: they ask you first where the Harness can show the request, and otherwise wait as Proposals.
