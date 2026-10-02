# Codex CLI hooks and session transcripts (codex-cli 0.160.0)

Researched 2026-10-02 against the locally installed `codex-cli 0.160.0`.
Source references point at the `openai/codex` repo at tag `rust-v0.160.0` (paths relative to `codex-rs/`).
Official docs: https://developers.openai.com/codex/hooks, which now 308-redirects to https://learn.chatgpt.com/docs/hooks.
Anything not confirmed in source, docs or a live probe is marked **unverified**.

## How this was verified

Source was read from a shallow clone of `openai/codex` at `rust-v0.160.0`.
The trust model was checked live by running `codex app-server` (JSON-RPC `initialize` then `hooks/list`) against a throwaway `CODEX_HOME=/tmp/...` containing a sample `hooks.json`, with no model session started and nothing under `~/.codex` touched.
The `currentHash` values returned by `hooks/list` were reproduced byte-for-byte with an independent Python implementation (see section 5).
A hand-written `trusted_hash` in the temp `config.toml` then flipped the hook to `trustStatus: "trusted"`, and a wrong hash showed `"modified"`.
Local `~/.codex` was inspected read-only.

## 1. Hook configuration

### File locations

Hooks are discovered per config layer, from the layer's config folder (`hooks.json`) and from the same layer's `config.toml` under a `[hooks]` table (`hooks/src/engine/discovery.rs:129-187`, `load_hooks_json` at `:339-380`, `load_toml_hooks_from_layer` at `:382-400`).
The docs list `~/.codex/hooks.json`, `~/.codex/config.toml`, `<repo>/.codex/hooks.json` and `<repo>/.codex/config.toml` (https://learn.chatgpt.com/docs/hooks).
All layers are additive, so a higher-precedence layer does not replace a lower one (docs; the loop in `discovery.rs:129` appends every layer).
If one layer has hooks in both `hooks.json` and `config.toml`, both load and Codex warns "prefer a single representation for this layer" (`discovery.rs:154-164`).
Plugins can also ship hooks, and managed hooks can come from `requirements.toml`/MDM/cloud (`discovery.rs:208-295`).
Disabled config layers are skipped (`config/src/state.rs:548-551`); that untrusted project folders are such disabled layers is **unverified** in source.

### JSON schema

Top level of `hooks.json`: `{ "description"?: string, "hooks": { <EventName>: [MatcherGroup] } }`, with `deny_unknown_fields` (`config/src/hook_config.rs:10-17`).
In `config.toml` the same event arrays live directly under `[hooks]` (for example `[[hooks.SessionStart]]`), next to the `[hooks.state]` table (`hook_config.rs:19-25`).
A `MatcherGroup` is `{ "matcher"?: string, "hooks": [Handler] }` (`hook_config.rs:153-159`).
A handler is tagged by `type` (`hook_config.rs:161-201`):

- `"command"`: `command` (string, required), `commandWindows`, `timeout` (seconds), `async` (bool, default false), `statusMessage`, `additionalContextLimit` (tokens).
- `"mcp_tool"`: `server`, `tool`, `input` (object), `timeout`, `statusMessage`.
- `"prompt"` and `"agent"` parse but are skipped with "not supported yet" (`discovery.rs:635-654`).

Matchers are regexes; `"*"`, `""` or an omitted matcher match everything (docs; `hooks/src/events/common.rs:130-135`).
Matchers are ignored for `UserPromptSubmit`, `Stop` and `Interrupt` (`common.rs:112-128`).
For `SessionStart` the matcher is tested against `source`, for `PreCompact`/`PostCompact` against `trigger`, for `SessionEnd` against `reason` (docs; `hooks/src/lib.rs:38-53`).

### Feature flag

The flag is `[features] hooks`, stage Stable, `default_enabled: true` (`features/src/lib.rs:1224-1229`).
`codex features list` locally shows `hooks  stable  true`.
So `hooks = true` in `~/.codex/config.toml` is redundant but harmless; `hooks = false` turns hooks off (docs).

### Local state

`~/.codex/hooks.json` currently contains `{"hooks": {}}`.
`~/.codex/config.toml` has `[features] hooks = true` and an empty `[hooks.state]` table, so no hook is trusted yet.

## 2. Events in 0.160

There are exactly 12 events (`hooks/src/lib.rs:23-36`, `config/src/hook_config.rs:36-61`):
`PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`.

**Session end:** `SessionEnd` fires during session shutdown, after tasks are aborted and MCP is shut down (`core/src/session/handlers.rs:323`, `core/src/hook_runtime.rs:471-500`).
It is root-session only, so subagents never fire it (`hook_runtime.rs:480-484`).
`reason` is always the constant `"other"` (`hooks/src/events/session_end.rs:24`).
Codex flushes the rollout file before running SessionEnd hooks (`hook_runtime.rs:493-495`).
`Stop` is per turn, not per session: it fires when a turn completes and carries `last_assistant_message`.
That SessionEnd also fires for `codex exec` and for the desktop/app-server clients is **unverified** (it hangs off the core shutdown handler, so it probably does).

**Compaction:** yes, `PreCompact` and `PostCompact` exist, with `trigger` `"manual" | "auto"` (`hook_runtime.rs:543-600`).
`PreCompact` can stop the compaction (`hook_runtime.rs:565-569`).
After a compaction, Codex also queues a `SessionStart` with `source: "compact"` (`core/src/session/mod.rs:4212`), which is how to re-inject memory after compaction.
Unlike SessionEnd, PreCompact does **not** call `flush_rollout()` first (only SessionEnd and Interrupt do, `hook_runtime.rs:493,535`), so the last few records may not be on disk yet; how much is buffered is **unverified**.

## 3. Hook stdin JSON per event

Input is one JSON object written to the hook's stdin (`hooks/src/engine/command_runner.rs:259-279`).
Field lists come from the generated schemas in `hooks/schema/generated/*.command.input.schema.json`:

- **SessionStart:** `session_id`, `transcript_path` (string or null), `cwd`, `hook_event_name: "SessionStart"`, `model`, `permission_mode` (`default|acceptEdits|plan|dontAsk|bypassPermissions`), `source` (`startup|resume|clear|compact|fork`).
- **SessionEnd:** `session_id`, `transcript_path`, `cwd`, `hook_event_name: "SessionEnd"`, `reason: "other"`, and no `model` or `permission_mode`, unlike what the docs' "common to all" list implies (`session_end.rs:63-69`).
- **Stop:** `session_id`, `turn_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `stop_hook_active`, `last_assistant_message` (string or null).
- **PreCompact / PostCompact:** `session_id`, `turn_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `trigger`, plus optional `agent_id`/`agent_type` when inside a subagent; no `permission_mode`.
- **UserPromptSubmit:** common fields plus `turn_id`, `prompt` (docs).
- **Pre/PostToolUse:** common fields plus `turn_id`, `tool_name`, `tool_use_id`, `tool_input`, and `tool_response` for Post (docs).
- **SubagentStop:** adds `agent_id`, `agent_type`, `agent_transcript_path`, `stop_hook_active`, `last_assistant_message` (docs).

`session_id` is the thread id, the same UUID used in the rollout filename and in `session_meta.payload.id` (observed locally, see section 6).
The docs list `source` without `fork`; the 0.160 schema includes `fork` (`core/src/session/session.rs:1907`).

## 4. SessionStart context injection

On exit code 0, stdout is trimmed and then (`hooks/src/events/session_start.rs:243-312`):

- If it parses as the SessionStart JSON output, `hookSpecificOutput.additionalContext` is injected; `systemMessage` shows as a UI warning; `continue: false` stops the session with `stopReason`.
- If it looks like JSON but fails to parse, the hook is marked Failed ("hook returned invalid session start JSON output") and nothing is injected.
- Otherwise the plain-text stdout itself is injected as context.

The output schema has `additionalProperties: false`, and `hookSpecificOutput` requires `hookEventName: "SessionStart"` (`hooks/schema/generated/session-start.command.output.schema.json`):

```json
{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "..."}}
```

The injected text is recorded as a **developer**-role message with no wrapper markers (`core/src/context/hook_additional_context.rs:15-34`, `core/src/hook_runtime.rs:849-873`).
SessionStart hooks run lazily at the start of the first turn, not when the process launches (`core/src/session/turn.rs:322`), so a session that never gets a prompt never runs the hook.

**Size limit:** the default is about 2,500 tokens per hook (`hooks/src/output_spill.rs:12`).
Over that, the full text spills to `<temp_dir>/hook_outputs/<thread_id>/<uuid>.txt` and the model gets a preview plus recovery metadata (`output_spill.rs:11,56`; docs).
Per handler, `additionalContextLimit: N` raises the limit and `0` disables spilling (`config/src/hook_config.rs:175-184`).
It is only honoured for PreToolUse, PostToolUse, SessionStart, UserPromptSubmit and SubagentStart (`discovery.rs:539-556`).
If several hooks inject context, all of it is added together (docs).

## 5. Trust model

**New hooks do not run until trusted.**
A non-managed hook (user, project, session-flags or plugin source) only runs if it is enabled and its trust status is `Trusted` or `Managed`, unless `--dangerously-bypass-hook-trust` is set (`discovery.rs:713-734`).
Status is `Trusted` when the stored hash equals the current hash, `Modified` when they differ, and `Untrusted` when nothing is stored (`discovery.rs:794-811`).
Managed hooks (system, MDM, cloud, `requirements.toml`) skip trust entirely (`discovery.rs:802-803,817-821`).

**Key** (`hooks/src/lib.rs:112-123`): `"<source path>:<event_snake>:<groupIndex>:<handlerIndex>"`.
Example: `/Users/owner/.codex/hooks.json:session_start:0:0`.
The key is position-based, so reordering groups or handlers changes keys and drops trust.
The path is the absolute, symlink-resolved path: the probe under `/tmp` reported `/private/tmp/...`.
Event labels are `pre_tool_use`, `permission_request`, `post_tool_use`, `pre_compact`, `post_compact`, `session_start`, `session_end`, `user_prompt_submit`, `subagent_start`, `subagent_stop`, `stop`, `interrupt` (`lib.rs:95-110`).
For plugin hooks the key source is built from the plugin id and its relative path instead (`hooks/src/declarations.rs`, `plugin_hook_key_source`).

**Storage:** `[hooks.state."<key>"]` with `trusted_hash = "sha256:<hex>"` and optional `enabled = false` (`config/src/hook_config.rs:27-33`).
Only the **user** `config.toml` layer and session flags (`-c`) are read for hook state; project, managed and plugin layers cannot trust their own hooks (`hooks/src/config_rules.rs:8-29`).

**Hash algorithm** (`discovery.rs:766-792`, `config/src/fingerprint.rs:54-84`):

1. Normalize the handler: for `command`, keep `type`, `command` (the Unix `command`; `commandWindows` is dropped), `timeout` (filled in: default 600, SessionEnd/Interrupt clamped to 1..3), `async` (always present, bool), and `statusMessage`/`additionalContextLimit` only if set (`additionalContextLimit` is dropped when it equals 2500).
2. Build `{"event_name": "<event_snake>", "matcher": <matcher, omitted if absent>, "hooks": [<that one handler>]}`.
3. Convert to TOML (which drops nulls), then to JSON, with keys recursively sorted.
4. Take compact `serde_json` bytes, SHA-256 them, and format as `"sha256:" + lowercase hex`.

Python version that reproduced all four `currentHash` values from the live `hooks/list` probe:

```python
def codex_hook_hash(event_snake, matcher, handler):  # handler already normalized
    ident = {"event_name": event_snake, "hooks": [handler]}
    if matcher is not None:
        ident["matcher"] = matcher
    s = json.dumps(ident, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(s.encode()).hexdigest()

codex_hook_hash("stop", None, {"type": "command", "command": "/usr/local/bin/jarvis-hook stop",
                               "timeout": 600, "async": False})
# == "sha256:be3104f1...abcf", identical to Codex's own hooks/list output
```

Because the hash covers config, not the script on disk, editing the script's contents keeps the hook trusted; changing the command string, timeout, matcher or async flag does not.

**Untrusted hooks:** they are listed with status `untrusted` or `modified` and silently not run.
In the TUI, startup shows a "Hooks need review" picker ("N hooks are new or changed. Hooks can run outside the sandbox after you trust them.") with options "Review hooks", "Trust all and continue" (needs explicit confirmation) and "Continue without trusting (hooks won't run)" (`tui/src/startup_hooks_review.rs:225-275`).
The `/hooks` slash command ("view and manage lifecycle hooks") opens the hooks browser to inspect, trust or disable each hook (`tui/src/slash_command.rs:115`, `tui/src/bottom_pane/hooks_browser_view.rs`).
Trusting writes `hooks.state.<key>.trusted_hash = currentHash` into the user config via app-server `config/batchWrite` (`tui/src/hooks_rpc.rs:59-93`).
How headless `codex exec` handles untrusted hooks (presumably skips them without a prompt) is **unverified**.

**Can a third-party installer mark its hook trusted?**
Mechanically yes, and verified: writing the correct `trusted_hash` under the right key in `~/.codex/config.toml` made `hooks/list` report `trusted`.
A cleaner programmatic route is the app-server API: call `hooks/list` (it returns `key` and `currentHash`), then `config/batchWrite` with `keyPath: "hooks.state"`, merge `upsert`, which is exactly what the TUI does.
That gets around Codex's intended consent gate, though.
The product intent is that the user reviews hooks in Codex (docs: "Non-managed hooks require explicit review before execution").
The legitimate options are:

- (a) Install `hooks.json` and have the user approve once in Codex (startup prompt or `/hooks`).
- (b) Have the Jarvis setup UI itself show the exact hook commands, get explicit user consent, and only then write the trust entries.

Option (b) is not a documented public contract, so it may break in future versions.

## 6. Transcript storage

Path: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<thread_id>.jsonl` (`rollout/src/lib.rs:86`, `rollout/src/rollout_file_name.rs:62-74`).
Reverted threads use `rollout-<ts>-<thread_id>_<rollout_id>.jsonl` (`rollout_file_name.rs:66-73`).
The filename timestamp parses as UTC (`rollout_file_name.rs:50-54`).
Archived sessions move to `$CODEX_HOME/archived_sessions/` (`rollout/src/lib.rs:87`).
Rollouts older than 7 days can be zstd-compressed to `.jsonl.zst`, but only behind the `local_thread_store_compression` flag, which is under development and off by default (`rollout/src/compression.rs:26,336`, `features/src/lib.rs:1170-1175`).
No `.zst` files exist locally.
Locally there are 85 rollout files, the newest dated 2026-09-30.

**session_id to path:** the hook input carries `transcript_path` directly; it is the session's current rollout path, and the file is materialized before the hook runs (`core/src/session/mod.rs:5078-5090`).
It is `null` for non-local thread stores (`core/src/session/tests.rs:11372`), so code must handle null.
Fallback: glob `~/.codex/sessions/*/*/*/rollout-*-<session_id>.jsonl` (also `*_*.jsonl` and `.jsonl.zst`).
`~/.codex/session_index.jsonl` maps `id` to `thread_name`/`updated_at` only, not to paths.

**Record shapes** (observed in a local 0.159.2 rollout, contents truncated): each line is `{"timestamp", "ordinal", "type", "payload"}`.

- `session_meta`: payload has `id` (the session id), `session_id`, `cwd`, `timestamp`, `originator`, `cli_version`, `source`, `model_provider`, `base_instructions`, and more.
- `turn_context`: per-turn `turn_id`, `cwd`, `workspace_roots`, `current_date`, `timezone`, approval policy.
- User text: `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"..."}],"id":"msg_...","internal_chat_message_metadata_passthrough":{"turn_id":...}}}`.
- Assistant text: `{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"..."}],"phase":"final_answer",...}}`.
- `role: "developer"` messages also appear as `response_item`/`message`; hook `additionalContext` lands here, so filter these out when capturing, or Jarvis will re-ingest its own injected memory.
- Other lines: `reasoning` (encrypted), `function_call`/`function_call_output`, `custom_tool_call`/`custom_tool_call_output`, `agent_message` (sub-agent traffic), and `event_msg` with subtypes `task_started`, `task_complete` (has `last_agent_message`), `turn_aborted`, `item_completed` (a UI-level duplicate of user/agent items), `token_count`, `thread_settings_applied`, plus `token_usage_record`, `world_state` and `compacted` (payload `replacement_history`).

The rollout JSONL schema is an internal format, not a documented contract.

## 7. Timeouts and blocking

Default timeout is 600 s for all events except `SessionEnd` and `Interrupt`, which default to 1 s and are clamped to at most 3 s; minimum is 1 s (`discovery.rs:740-764`, `session_end.rs:20-23`).
The 3 s cap keeps SessionEnd inside app-server's 5 s shutdown bound (`session_end.rs:21-22`).
**A transcript-capture SessionEnd hook therefore must return within 3 s.**
It should copy or enqueue the `transcript_path` and exit, deferring heavy work to a detached Jarvis process.
That a hook-spawned child outlives the hook is **unverified**: on Unix the hook runs in a new session, and on timeout Codex kills its process group (`command_runner.rs:339`, `:430`), so a daemonized grandchild would need `setsid` or a handoff to an already-running Jarvis service.
The deadline includes writing stdin, even if the hook never reads it (`command_runner.rs:276-279`).
On timeout the run fails with "hook timed out after Ns" (`command_runner.rs:317`).

Synchronous hooks block the operation: matching handlers for one event run concurrently, and Codex awaits all of them (`hooks/src/engine/dispatcher.rs:125-165`).
`"async": true` runs the hook in the background, with at most 8 concurrent per session (`command_runner.rs:54`), and output is delivered at the next safe point (docs).
`SessionEnd` ignores `async` and always runs synchronously (`discovery.rs:531-538`).
On Unix, commands run as `<shell> -lc "<command>"` in `cwd`, with the session's shell-snapshot environment replayed (`command_runner.rs:380-430`).
Exit codes: `0` means success, `2` is a blocking decision with the reason on stderr (for events that support blocking), and any other non-zero is a hook failure where the operation continues (docs).
