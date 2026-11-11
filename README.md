# Jarvis

A local-first second brain for macOS and Linux.
It runs in the browser, keeps your knowledge as Markdown in a folder you choose, answers with cited evidence, watches the sources you connect, and prepares drafts that are sent only after you approve the exact version.
You can also read and edit the notes in Obsidian or any other Markdown editor.

- **Install:** on macOS (Apple silicon), download `Jarvis-Installer-<version>-macos-arm64.command` from a release and double-click it.
  On Linux (x86_64 with systemd), download `Jarvis-Installer-<version>-linux-x64.sh` and run it with `sh`.
  No developer tools needed. See the [user guide](docs/user-guide.md).
- **Build from source:** see the [developer guide](docs/developer-guide.md).
- **How it works:** [architecture](docs/architecture.md), [what was reused and why](docs/inspection.md).
- **Status and evidence:** [build status](docs/build-status.md), [acceptance report](docs/acceptance-report.md).

## What it does

- Search with exact citations: every hit names its file and lines, and search works without a model.
  Jarvis has no chat box of its own; you ask the Brain from your Harness.
- Meaning-based search on each Machine: a small multilingual model, downloaded once from Settings, runs locally and builds vectors for every passage; search falls back to keywords until they are ready.
- The Brain in any Harness: a local MCP server (`jarvis mcp`) lets Claude Code, Codex, Antigravity and Claude Desktop search and read your notes with file and line citations, and save facts and events you confirm inside the Harness (or, for a Harness you switch auto-accept on for, without asking), with no token in their configuration.
  Connecting a Harness in the Dashboard adds the server, and for Claude Code, Codex and Antigravity the session hooks, in one step.
  A wrap-up prompt records the durable points of a conversation Jarvis cannot capture, such as Claude Desktop's Chat tab, as evidence.
- Memory: import a Markdown folder or Obsidian vault read-only, and keep notes and source-linked decisions with dated history.
  The Dashboard shows the Brain read-only and takes one-click decisions; notes are added and corrected from a Harness.
- Attention and briefings: deadlines, review queues, meeting prep and pending replies from your sources, with dismiss/snooze that sticks until the evidence changes, and visible source coverage.
- Drafts and approvals: PR review comments, Jira and Confluence comments, Slack replies and Gmail drafts, with server-enforced approval binding and verified receipts.
- Replication (opt-in): every Machine you run Jarvis on keeps the same Brain through a private git repository, with history, offline saves that catch up later, hand edits included, and the same inbox with the same dismiss and snooze decisions on every Machine.
- Background work: durable research, briefing and draft jobs that survive closing the tab and restarting the service.

Connections: local Markdown/Obsidian folders, GitHub, Jira, Confluence, Slack, Gmail, Google Calendar, and a model provider (Claude Code, Anthropic, OpenAI-compatible).
Each is optional and starts read-only.

## Research and brief

[JARVIS_BUILD_SPEC.md](JARVIS_BUILD_SPEC.md) is the implementation brief.
Research inputs are in [research/](research/README.md).
