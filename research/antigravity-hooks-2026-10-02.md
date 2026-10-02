# Google Antigravity hooks, context injection and transcripts

Researched 2026-10-02.
Primary sources are the official docs at https://antigravity.google/docs, the official changelog (https://antigravity.google/docs/changelog) and the official `google-antigravity/antigravity-cli` issue tracker.
Gemini CLI facts come from https://geminicli.com/docs/hooks/ and https://geminicli.com/docs/hooks/reference/.
Anything not confirmed in official docs or a local check is marked **unverified** or **community**.

## Correction to the brief: Antigravity is installed

The brief said Antigravity is not installed on this Mac.
It is, as of 2026-10-02 11:50 local time:

- `/Applications/Antigravity.app`, `CFBundleShortVersionString` 2.19.1 (this is the "Antigravity 2.0" desktop product).
- `~/.local/bin/agy`, Antigravity CLI 1.2.14 (`agy --version`).
- `~/.gemini/antigravity/` (2.0 app data), `~/.gemini/config/` (shared customization root: `config.json`, an empty `mcp_config.json`, empty `plugins/` and `projects/`).
- No conversations exist yet (`brain/` and `conversations/` are empty) and the CLI is not signed in.

My probe runs created `~/.gemini/antigravity-cli/` (CLI app data, logs only, no conversations) and left a probe workspace at `/tmp/agy-hook-probe/`.

## Products and their app-data directories

Antigravity now ships three products that share one customization root, `~/.gemini/config/`, but keep separate app data (https://antigravity.google/docs/hooks/):

| Product | App data |
| --- | --- |
| Antigravity 2.0 (desktop app) | `~/.gemini/antigravity` |
| Antigravity CLI (`agy`) | `~/.gemini/antigravity-cli` |
| Antigravity IDE | `~/.gemini/antigravity-ide` |

Older community tools also mention `~/.gemini/antigravity2/brain` and `~/.antigravity/brain` (**community**, https://agentgrep.org/backends/antigravity-cli/).

## 1. Lifecycle hooks: yes, but a different event model from Claude Code

Antigravity has an official, documented hook system (https://antigravity.google/docs/hooks/).
It is its own system, not Gemini CLI's.

### Config paths

- Workspace: `<workspace>/.agents/hooks.json` (all three products).
- Global: `~/.gemini/config/hooks.json` (all three products).
- CLI only: also `~/.gemini/antigravity-cli/settings.json`, and plugin-packaged `hooks.json`.
- Plugins: `~/.gemini/config/plugins/<name>/hooks.json` or `.agents/plugins/<name>/hooks.json` (**community**, Mete Atamel, Google DevRel: https://atamel.dev/posts/2026/07-16_where_agy_hooks/).
- CLI plugin staging: `~/.gemini/antigravity-cli/plugins/<plugin_name>/` with `plugin.json`, `mcp_config.json`, `hooks.json`, skills, agents, rules (https://antigravity.google/docs/cli/features/).
- Custom Markdown agents can list hook files under a `hooks:` front-matter key since 2.0 v2.17.0, 2026-09-22 (https://antigravity.google/docs/changelog).
- UI: Settings > Customizations > Hooks, or `/hooks` in the CLI (https://antigravity.google/docs/hooks/).

Locally, `agy` logs `hooks_manager.go:53] loaded 1 named hooks from 1 hooks.json file(s)` when `.agents/hooks.json` is present, before authentication (`~/.gemini/antigravity-cli/cli.log`).

### Documented events

The docs list exactly five events (https://antigravity.google/docs/hooks/):

| Event | Fires | Matcher | Output |
| --- | --- | --- | --- |
| `PreToolUse` | before a tool runs | tool name, `*`, `a\|b`, regex | `decision`: `allow\|deny\|ask\|force_ask\|deny_unless_prior_grant`, `reason`, `permissionOverrides` |
| `PostToolUse` | after a tool completes | tool name | `{}` |
| `PreInvocation` | before each model call | ignored | `injectSteps` |
| `PostInvocation` | after each model call | ignored | `injectSteps`, `terminationBehavior`: `force_continue\|terminate\|""` |
| `Stop` | when execution terminates | ignored | `decision: "continue"` plus `reason` to keep going |

There is **no documented** `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreCompact` or `PreCompress` event.

### Schema

Top level is a map of named hook groups, each with optional `enabled` (default `true`) and per-event arrays (https://antigravity.google/docs/hooks/):

```json
{
  "jarvis": {
    "enabled": true,
    "PreInvocation": [{ "type": "command", "command": "jarvis hook antigravity pre-invocation", "timeout": 30 }],
    "Stop": [{ "type": "command", "command": "jarvis hook antigravity stop", "timeout": 30 }],
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "...", "timeout": 10 }] }]
  }
}
```

Tool events wrap handlers in `{ "matcher", "hooks": [...] }`.
Invocation and Stop events take handlers directly, matching the shape claude-mem installs (https://docs.claude-mem.ai/antigravity-cli/setup).
Handler `type` is only `"command"`, `timeout` is in seconds, default 30 (https://antigravity.google/docs/hooks/).
The named top-level key lets an installer own one entry (for example `"jarvis"`) without touching other tools' hooks.

### stdin input (camelCase)

Common fields on every event (https://antigravity.google/docs/hooks/):

- `conversationId`: UUID of the conversation.
- `workspacePaths`: array of workspace directories.
- `transcriptPath`: "The absolute path to the persistent `transcript.jsonl` conversation logs".
- `artifactDirectoryPath`: the conversation's artifact directory.
- `modelName`: for example `gemini-3.6-flash-medium`.

Event-specific fields:

- `PreToolUse`: `toolCall { name, args }`, `stepIdx`.
- `PostToolUse`: `toolCall`, `stepIdx`, optional `error`.
- `PreInvocation` / `PostInvocation`: `invocationNum`, `initialNumSteps`.
- `Stop`: `executionNum`, `terminationReason` (`model_stop|max_steps_exceeded|error`), optional `error`, `fullyIdle`.

The `agy` 1.2.14 binary contains the strings `conversationId`, `transcriptPath`, `artifactDirectoryPath`, `fullyIdle`, `injectSteps`, `ephemeralMessage`, `terminationBehavior`, which matches the docs (local `strings` check).

### Context injection

`PreInvocation` returns `injectSteps`, an array of `{ "userMessage": "..." }`, `{ "ephemeralMessage": "..." }` or `{ "toolCall": {...} }` (https://antigravity.google/docs/hooks/).
claude-mem uses exactly this: "Injects memory context (via `injectSteps`) before the agent runs" (**community**, https://docs.claude-mem.ai/antigravity-cli/setup).
`PreInvocation` fires before every model call, not once per session, so a session-start equivalent has to gate itself.
Inferred, **unverified**: inject only when `invocationNum == 0` and `initialNumSteps == 0` (first invocation of a fresh conversation), or keep a per-`conversationId` marker file.
Whether an `ephemeralMessage` persists across later invocations or is dropped after one is not documented (**unverified**).

### Undocumented SessionStart in the binary

`agy` 1.2.14 compiles in `hooks_pb.SessionStartHookArgs` (`json=sessionStartHookArgs`), `SessionStartHookResult` with `GetInjectSteps`, `hookcaller.CallSessionStartHook` and `hooks.NewSessionStartHook` (local `strings` check).
So a session-start hook exists internally and returns `injectSteps`.
Whether a user `hooks.json` can register `"SessionStart"` is **unverified**: an unknown key (`BogusEvent`) loads without error just like `SessionStart`, so loading proves nothing, and the CLI was not signed in so no turn ran.
No `SessionEnd` or compaction hook types exist in the binary; the only `hooks_pb` arg types are PreTool, PostTool, PreInvocation, PostInvocation, Stop and SessionStart.
A Google Cloud Medium guide by Kanshi Tanaike claims `SessionStart` and `SessionEnd` events plus snake_case fields (`session_id`, `transcript_path`, `hook_event_name`) and a global path `~/.gemini/antigravity-cli/hooks.json` (**community**, https://gist.github.com/tanaikech/004f4bcdb530f1a07706c85c13dc8205).
That contradicts the official docs on field names and paths and looks like Gemini CLI's schema; do not build on it.

### Trust and approval

The official hooks page documents no trust prompt, fingerprinting or approval step for workspace or global hooks (https://antigravity.google/docs/hooks/).
This differs from Gemini CLI and Codex, which fingerprint project hooks.
Since 2.0 v2.6.0 (2026-08-07), "Hook configurations that could never run are now rejected at load time with a clear error"; since v2.12.0 (2026-09-02) a failing hook is reported as an error instead of ending the session (https://antigravity.google/docs/changelog).
Since v2.14.0 a blocking Stop hook no longer hangs the agent forever (same source).

### Compaction

No compaction event is documented, and the CLI has no `/compact` command; feature request #999 is open as of 2026-09-11 (https://github.com/google-antigravity/antigravity-cli/issues/999).
The binary contains an internal `hooks.NewContextSummaryHook`, which suggests built-in summarization, but nothing a third party can hook (local `strings` check, **unverified** behaviour).

## 2. Extension points for Jarvis

### (a) Memory context at session start

Ranked by fit:

1. `PreInvocation` hook in `~/.gemini/config/hooks.json` returning `injectSteps`, gated to the first invocation (above).
   Covers all three products from one file.
2. Global rules file, always loaded: `~/.gemini/GEMINI.md`, `~/.gemini/AGENTS.md`, `~/.gemini/config/GEMINI.md`, `~/.gemini/config/AGENTS.md`, or a modular rule `~/.gemini/config/rules/<name>.md` (https://antigravity.google/docs/rules/).
   `AGENTS.md`/`GEMINI.md` need no front matter and are always active.
   Files in `rules/` must have YAML front matter with `trigger: always_on|model_decision|glob|manual`, and a missing or invalid one silently excludes the rule (same source).
   Limits: 24,000 bytes per file and a 20,000-token aggregate budget for global and always-on rules; oversized rules demote to on-demand references (same source; budget added in 2.0 v2.17.0).
   `@path/to/file` inlining works in `AGENTS.md` and rule files since 2.0 v2.11.0 (https://antigravity.google/docs/changelog).
   A Jarvis-owned `~/.gemini/config/rules/jarvis-memory.md` with `trigger: always_on`, rewritten by Jarvis on a schedule, is static but needs no hook.
   Note `~/.gemini/GEMINI.md` is also Gemini CLI's global context file and already exists here (2.3 KB), so prefer the `config/rules/` file to avoid editing a shared file.
3. MCP server so the agent can call Jarvis recall tools: `~/.gemini/config/mcp_config.json` (global) or `.agents/mcp_config.json` (workspace), same for all three products (https://antigravity.google/docs/mcp/).
   Shape: `{ "mcpServers": { "jarvis": { "command": "...", "args": [], "env": {}, "cwd": "..." } } }`; remote servers use `serverUrl` (https://antigravity.google/docs/cli/gcli-migration/).
   The local `~/.gemini/config/mcp_config.json` is currently 0 bytes, so an installer must handle an empty file.

### (b) Transcript capture

- `Stop` hook with `fullyIdle: true` gives `conversationId` and `transcriptPath`; Jarvis reads the transcript from there (https://antigravity.google/docs/hooks/).
  `Stop` fires per execution (turn), not once per session, so capture must be idempotent and incremental per `conversationId`.
  There is no session-end or pre-compaction event, so there is no exact equivalent of Claude Code's SessionEnd/PreCompact capture.
- `PostInvocation` can capture each model response as it lands (claude-mem reads the `PLANNER_RESPONSE` node this way, **community**, https://docs.claude-mem.ai/antigravity-cli/setup).
- Fallback without hooks: watch the `brain/` directories (section 3).

## 3. Transcript storage on macOS

Documented (official): hook input `transcriptPath` points at "the persistent `transcript.jsonl`" (https://antigravity.google/docs/hooks/).
The official status-line docs show `~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/transcript.jsonl` (https://antigravity.google/docs/cli/statusline/).
For the CLI that example is wrong; the real path is under `~/.gemini/antigravity-cli/brain/...`, per official-tracker bug #744 on CLI 1.1.10 (https://github.com/google-antigravity/antigravity-cli/issues/744).
So always use the `transcriptPath` the hook hands you instead of building the path.

Layout, inferred from docs plus **community** sources:

```
~/.gemini/<app-data>/                         # antigravity | antigravity-cli | antigravity-ide
  conversation_summaries.db                    # SQLite index (schema verified locally)
  conversations/<uuid>.db                      # newer builds; older builds wrote AES-encrypted <uuid>.pb
  implicit/<uuid>.pb                           # encrypted
  brain/<uuid>/
    task.md, implementation_plan.md, walkthrough.md (+ .metadata.json, .resolved)   # artifacts
    .system_generated/logs/transcript.jsonl       # one JSON object per step, may truncate
    .system_generated/logs/transcript_full.jsonl  # untruncated
```

Sources: https://jazzyalex.github.io/agent-sessions/guides/antigravity-cli-local-history.html, https://github.com/kenn-io/agentsview/issues/1995 (both **community**).
`transcript.jsonl` lines carry `step_index`, `source` (`USER_EXPLICIT|MODEL|SYSTEM`), `type`, `status`, `created_at`, `content`, `thinking`, `tool_calls`, and `truncated_fields` on clipped records (**community**, same sources).
Prefer `transcript_full.jsonl` for capture.
The `.pb` conversation streams are encrypted and not usable (**community**, agentsview #1995).
One tracker reports all `transcript.jsonl` files empty on some CLI builds, with the data only in `conversations/*.db` (**community**, https://github.com/aa22396584/resume-skills/issues/120), so a reader should fall back to the `.db`.

Verified locally: `~/.gemini/antigravity/conversation_summaries.db` is SQLite with table `conversation_summaries` (`conversation_id`, `title`, `preview`, `step_count`, `last_modified_time`, `workspace_uris`, `status`, `source`, `project_id`, `agent_name`, `parent_conversation_id`, `nesting_depth`, `not_fully_idle`, `killed`, `last_user_input_time`, `app_data_dir`, `raw_summary` blob, ...).
It is a usable index for a watcher (find conversations changed since last sweep, then read their `brain/<id>` transcript).
The transcript line format itself could not be checked locally because no conversation exists yet.

## 4. Does Antigravity read Gemini CLI's config?

- `~/.gemini/settings.json` hooks: no.
  The official hooks page lists only `hooks.json` locations and `~/.gemini/antigravity-cli/settings.json` (https://antigravity.google/docs/hooks/); the migration guide does not say `~/.gemini/settings.json` is read and does not map Gemini CLI hook events (https://antigravity.google/docs/cli/gcli-migration/).
  The event names differ completely (Gemini `SessionStart/BeforeAgent/PreCompress` vs Antigravity `PreInvocation/Stop`), so Gemini CLI hooks would not carry over even if read.
- `GEMINI.md`: yes.
  Antigravity reads `~/.gemini/GEMINI.md` and workspace `GEMINI.md`/`AGENTS.md` (https://antigravity.google/docs/rules/, https://antigravity.google/docs/cli/gcli-migration/).
  So one `~/.gemini/GEMINI.md` edit reaches both Gemini CLI and Antigravity.
- MCP: inline `mcpServers` in Gemini settings are migrated to `~/.gemini/config/mcp_config.json`; workspace skills must move from `.gemini/skills/` to `.agents/skills/` (gcli-migration).
- Extensions: `agy plugin import gemini` imports Gemini CLI extensions as plugins (gcli-migration).
- Per-project config moved to `<repo>/.gemini/config.json` in 2.0 v2.17.0 (changelog).

## 5. Gemini CLI hooks (realistic third integration)

Gemini CLI is not installed here (`gemini` not on PATH; `~/.gemini/settings.json` holds only `{"experimental":{"plan":true}}`, no hooks).

- Config: `hooks` object in `settings.json`, merged across project `.gemini/settings.json`, user `~/.gemini/settings.json`, system `/etc/gemini-cli/settings.json`, and extensions (https://geminicli.com/docs/hooks/).
- Events: `BeforeTool`, `AfterTool`, `BeforeAgent`, `AfterAgent`, `BeforeModel`, `BeforeToolSelection`, `AfterModel`, `SessionStart`, `SessionEnd`, `Notification`, `PreCompress` (https://geminicli.com/docs/hooks/reference/).
- Shape: `{ "hooks": { "<Event>": [ { "matcher": "...", "hooks": [ { "name", "type": "command", "command", "timeout" } ] } ] } }`, `timeout` in milliseconds, default 60000 (same sources).
- Common stdin: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `timestamp` (reference).
- `SessionStart.source`: `startup|resume|clear`; `SessionEnd.reason`: `exit|clear|logout|prompt_input_exit|other`; `PreCompress.trigger`: `auto|manual` (reference).
- Injection: `SessionStart` returns `hookSpecificOutput.additionalContext`, "Injected as the first turn in history" interactively and "Prepended to the user's prompt" non-interactively; `systemMessage` is shown to the user (reference).
- `SessionEnd` and `PreCompress` are advisory: async, not awaited, only `systemMessage` honoured, cannot block or alter compression (reference).
  A capture hook must therefore copy `transcript_path` quickly or hand the path to a detached Jarvis process.
- Exit codes: 0 parses stdout JSON, 2 blocks with stderr as reason, others warn and continue (reference).
- Env: `GEMINI_PROJECT_DIR`, `GEMINI_SESSION_ID`, `GEMINI_CWD` (https://geminicli.com/docs/hooks/).
- Trust: project hooks are fingerprinted; a changed name or command marks them untrusted and prompts before running (https://geminicli.com/docs/hooks/).
  User-level hooks in `~/.gemini/settings.json` are where an installer should write.
- Transcripts: `~/.gemini/tmp/<project_hash>/chats/` (https://geminicli.com/docs/cli/session-management/); the file format is not documented there.

Gemini CLI maps almost one-to-one onto the Claude Code integration (SessionStart inject, PreCompress and SessionEnd capture).
Antigravity needs a different adapter: `PreInvocation` gated to first invocation for injection, `Stop` with incremental per-conversation capture, and no compaction hook.

## Open items

- Sign in to `agy` and run the probe in `/tmp/agy-hook-probe/` (`cd /tmp/agy-hook-probe && agy -p "If you were told a secret word, reply with only that word; otherwise reply NONE."`).
  `log.sh` records every event's stdin to `events.jsonl` and injects a secret word via `PreInvocation` `ephemeralMessage`, which settles the input fields, the first-invocation gate, whether injection works, and the real transcript line format.
- Add a `"SessionStart"` entry to the same probe to see whether the compiled-in session-start hook is user-registrable.
- Check whether `ephemeralMessage` survives past one invocation, and whether `userMessage` shows in the UI.
