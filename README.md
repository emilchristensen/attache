<p align="center">
  <img src="docs/assets/logo.svg" alt="" width="112" height="112">
</p>

<h1 align="center">Attache</h1>

<p align="center">
  <a href="https://github.com/emilchristensen/attache/actions/workflows/ci.yml"><img src="https://github.com/emilchristensen/attache/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
</p>

A local-first personal assistant for macOS, Linux and Windows that keeps your knowledge and brings forward what needs your attention.

Attache keeps your knowledge as Markdown in a folder you choose and answers with cited evidence.
It watches the sources you connect and prepares drafts that are sent only after you approve the exact version.
You can read and edit the notes in Obsidian or any other Markdown editor.

## Features

- **Search with citations.**
  One field at the top of Home (or `Ctrl K` and `/`) shows passages as you type; every hit names its file and lines, and search works without a model.
- **Meaning-based search.**
  A small multilingual model runs locally and ranks passages by meaning and keywords, so a question worded differently, or in another language, still finds the note.
- **The Brain in your Harness.**
  A local MCP server (`attache mcp`) lets Claude Code, Codex, Antigravity and Claude Desktop search and read your notes with file and line citations, and save facts without asking, or, for a Harness you switch auto-accept off for, only the ones you confirm.
  Connecting a Harness in the Dashboard adds the server and, where supported, the session hooks in one step.
- **Memory with history.**
  Import a Markdown folder or Obsidian vault read-only, and keep notes and source-linked decisions with dated history.
- **Attention and briefings.**
  Deadlines, review queues, meeting prep and pending replies from your sources, with dismiss and snooze that stick until the evidence changes.
  Home's Inbox is one list in priority order where every row names its type with a word, a glyph and a colour, keeps still while new items wait behind "Show new items", and offers Newest first, Group by type and Hidden one choice away.
  Home's For you now brings the daily briefing forward in the morning, and the briefings you ask for, each saying why it is there and when it leaves.
  Home says in one line when every source was read, and otherwise names each Connection that needs you, what may be missing and the one thing to do.
- **Approvals.**
  Drafts of PR review comments, Jira and Confluence comments, Slack replies and Gmail drafts, with server-enforced approval and verified receipts, and Proposals to apply to the Brain, together on one page.
- **Replication (opt-in).**
  Every Machine you run Attache on keeps the same Brain through a private git repository, including offline saves and hand edits.
- **Background work.**
  Research, briefing and draft jobs survive closing the browser tab and restarting the service.

Attache has no chat box of its own; you ask the Brain from your Harness.
Its Dashboard runs on your computer, in light or dark to match your system, and loads nothing from the internet, not even its typeface.
Home, Approvals, Brain, Connections, Jobs and Settings sit in one masthead, or in a bottom bar on a narrow window, and `g` then a letter jumps to each (`?` lists the shortcuts).
The logo's dot, the tab's icon and its title, such as "(14) Attache", show how many decisions wait for you, counted once each across the Inbox, Approvals and sign-ins.

Connections: local Markdown and Obsidian folders, GitHub, Jira, Confluence, Slack, Gmail, Google Calendar, and a model provider (Claude Code, Anthropic or OpenAI-compatible).
Each one is optional and starts read-only.

## Install

Download the installer for your platform from [Releases](https://github.com/emilchristensen/attache/releases).
No developer tools are needed.

| Platform | File | How to run it |
| --- | --- | --- |
| macOS (Apple silicon) | `Attache-Installer-<version>-macos-arm64.command` | Double-click it. |
| Linux (x86_64 with systemd) | `Attache-Installer-<version>-linux-x64.sh` | `sh Attache-Installer-<version>-linux-x64.sh` |
| Windows 10 or 11 (x86_64) | `Attache-Installer-<version>-windows-x64.cmd` | Double-click it. |

The installer starts Attache as a background service, pairs your browser with a one-time code and opens first-run setup.
Setup asks only for a data folder; everything else is optional and can wait.
The releases are not code-signed, so macOS may ask you to right-click the file and choose **Open** the first time.

The [user guide](docs/user-guide.md) covers setup, everyday use, Harness connections, Replication, backups and uninstalling.

## Build from source

You need Node 24.22.0 or newer, pnpm 11 and Google Chrome.

```sh
pnpm install
pnpm build      # contracts, service bundle and Dashboard
pnpm test       # unit, adapter contract and HTTP integration tests
pnpm dev        # run the service and Dashboard locally
pnpm release    # build the installers into release/<version>/
```

The [developer guide](docs/developer-guide.md) lists every check, the CI setup and the install test.

## Documentation

- [User guide](docs/user-guide.md)
- [Developer guide](docs/developer-guide.md)
- [Architecture](docs/architecture.md)
- [Glossary](GLOSSARY.md)
- [Architecture decision records](docs/adr/)

## The name

An attaché is the aide who keeps your papers, briefs you before a meeting and drafts letters for your signature, which is what this project does.
The name is written without the accent so it works as a command: `attache`.

Until November 2026 the project was called Jarvis, after the AI assistant in the Iron Man films.
It was renamed before going public, because that name belongs to Marvel and many other AI assistants already use it.
Older commits still say Jarvis.

## Contributing

Attache is open source but not open to contributions.
Pull requests will be closed without review.
You are welcome to fork it and change it for your own use under the terms of the license.

Bug reports are welcome as [GitHub issues](https://github.com/emilchristensen/attache/issues), with no promise of a fix or a reply.
Please report security problems privately through [GitHub security advisories](https://github.com/emilchristensen/attache/security/advisories/new) instead of a public issue.

## License

[MIT](LICENSE) © Emil Rømer Christensen
