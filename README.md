# Jarvis

A local-first second brain for your Mac.
It runs in the browser, keeps your knowledge as Markdown in a folder you choose, answers with cited evidence, watches the sources you connect, and prepares drafts that are sent only after you approve the exact version.
You can also read and edit the notes in Obsidian or any other Markdown editor.

- **Install:** download `Jarvis-Installer-<version>-macos-arm64.command` from a release and double-click it (or `sh` it). No developer tools needed. See the [user guide](docs/user-guide.md).
- **Build from source:** see the [developer guide](docs/developer-guide.md).
- **How it works:** [architecture](docs/architecture.md), [what was reused and why](docs/inspection.md).
- **Status and evidence:** [build status](docs/build-status.md), [acceptance report](docs/acceptance-report.md).

## What it does

- Search with exact citations: every hit names its file and lines, and search works without a model.
  Jarvis has no chat box of its own; you ask the Brain from your Harness.
- The Brain in any Harness: a local MCP server (`jarvis mcp`) lets Claude Code, Claude Desktop and other Harnesses search and read your notes with file and line citations, and save facts and events you confirm inside the Harness, with no token in their configuration.
  A wrap-up prompt records the durable points of a conversation Jarvis cannot capture, such as Claude Desktop's Chat tab, as evidence.
- Capture and memory: import a Markdown folder or Obsidian vault read-only, capture notes and source-linked decisions, and correct facts while keeping dated history.
- Attention and briefings: deadlines, review queues, meeting prep and pending replies from your sources, with dismiss/snooze that sticks until the evidence changes, and visible source coverage.
- Drafts and approvals: PR review comments, Jira and Confluence comments, Slack replies and Gmail drafts, with server-enforced approval binding and verified receipts.
- Replication (opt-in): every Machine you run Jarvis on keeps the same Brain through a private git repository, with history, offline saves that catch up later, and hand edits included.
- Background work: durable research, briefing and draft jobs that survive closing the tab and restarting the service.

Connections: local Markdown/Obsidian folders, GitHub, Jira, Confluence, Slack, Gmail, Google Calendar, and a model provider (Claude Code, Anthropic, OpenAI-compatible).
Each is optional and starts read-only.

## Research and brief

[JARVIS_BUILD_SPEC.md](JARVIS_BUILD_SPEC.md) is the implementation brief.
Research inputs are in [research/](research/README.md).
