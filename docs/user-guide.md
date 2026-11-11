# Jarvis user guide

Jarvis is a local second brain that runs on your Mac.
It keeps your knowledge as Markdown in a folder you choose, answers questions with cited evidence, watches the sources you connect, and prepares drafts that are only sent after you approve them.

## Install

Requirements: macOS on Apple silicon.
You do not need Node, Homebrew or any developer tools; the installer carries its own runtime.

1. Download `Jarvis-Installer-<version>-macos-arm64.command` from the release.
2. Double-click it.
   macOS may say it is from an unidentified developer because the release is not signed.
   In that case open it with right-click → Open, or run `sh ~/Downloads/Jarvis-Installer-<version>-macos-arm64.command` in Terminal.
3. The installer copies Jarvis to `~/Library/Application Support/Jarvis`, starts the service at login as a LaunchAgent, and opens `http://127.0.0.1:7427` in your browser with a one-time pairing code.

Running the installer again repairs the installation without touching your data.
Running a newer installer upgrades in place: it backs up first, switches versions and keeps your settings and knowledge.
Jarvis no longer has voice; upgrading from a version that had it removes the downloaded speech model, the speech connection and its key.

## First-run setup

Setup has five steps and each works without the ones after it.

1. **Data folder.**
   Choose where Jarvis stores knowledge (default `~/Documents/Jarvis`).
   Preview shows exactly what will be created and confirms that existing files are not modified.
   You can also point Jarvis at an existing Markdown folder or Obsidian vault; it is read in place and never changed.
2. **Features.**
   Conversation and search are always on.
   Capture, background work, attention and briefings, drafts and approvals, and agent sessions are optional.
   If a feature needs another one, Jarvis explains it and offers to turn the requirement on (or dependents off).
3. **Connections.**
   Connect only what you want: GitHub, Jira, Confluence, Slack, Gmail, Google Calendar.
   Every connection starts read-only.
   Slack, Gmail, Google Calendar, Jira and Confluence use your existing claude.ai connectors (Slack, Gmail, Google Calendar and Atlassian Rovo): Claude Code must be installed and signed in on this Mac with your claude.ai work account, and each connector must be connected in claude.ai → Settings → Connectors.
   For Jira and Confluence you also enter your site URL, for example `https://acme.atlassian.net`.
   If your organization allows it, Jira and Confluence can instead connect directly with **Sign in with Atlassian** or an Atlassian API token made for the MCP server.
   Steps that need an admin on the other side (allowing the Atlassian Rovo MCP server, enabling a claude.ai connector for the workspace, a GitHub token) are explained on the card before you connect.
   Under *Coding agents*, connect Claude Code, Codex or Antigravity if you use them (see Agent sessions below).
4. **Model and schedules.**
   Pick a model: Claude Code on this Mac (uses your existing Claude sign-in), an Anthropic API key, or any OpenAI-compatible endpoint including a local Ollama or LM Studio.
   Without a model, Jarvis still searches and shows you the evidence it finds.
   Set how often sources refresh, when the daily briefing is prepared, and whether urgent items raise a macOS notification.
5. **Test and finish.**
   Jarvis tests each connection and reports every feature as ready, partial, needs setup or unavailable.
   You can finish with a notes-only workspace and connect things later.

Everything chosen during setup can be changed later in **Settings** and **Connections**.

## Everyday use

**Home** shows the attention inbox beside a persistent conversation.
Drag the line between them to resize the conversation, or focus it and use the arrow keys; double-click it to reset.
Jarvis remembers the width in that browser.

- The briefing summarises what changed, what needs your judgment and what Jarvis has prepared, one point per line.
  The counts under it jump to each group; drafts and memory changes open their own screens.
  **Away summary** covers the last three days.
- **Sources** shows each source's last successful refresh and whether the last sync was complete, partial or failed.
  An item list is never shown as "nothing to do" when a source failed.
- Items are grouped into deadlines, review queue, meetings and pending replies.
  **Dismiss** hides an item until its evidence changes; **Snooze** hides it until a time; **Done** closes it.
  A dismissed item comes back only if something about it changed, and it is marked "changed since your decision".
- **Prepare draft** asks Jarvis to write a reply or review comment with the item's context.

**Conversation.**
Every question first searches your notes.
Answers cite their sources as `S1`, `S2`…; click a citation to open the file with the cited lines highlighted.
If nothing relevant is found, the answer says so and is marked unverified.
Press `/` to jump to the message box and `g` followed by a letter (h, m, d, j, c, s) to switch views.

**Memory** lists people, projects, decisions and notes, plus imported notes, archived evidence and generated deliverables.
Each memory note has a *Current state* with one dated entry per subject.
Use **Correct** to change a fact: the new value replaces the current one, the old value moves to *History* with the date and your reason, and the next answer uses the correction.
**Capture** archives text as evidence and can record a decision in memory linked to that evidence.
Changes that Jarvis proposes wait in *Memory changes to review* until you apply or reject them.
Each Proposal shows the whole change before you decide: the new note or the note it updates, every fact with its reason, every event, notes and tags, why it was suggested and the evidence it cites.
**Apply** writes every part at once, and each replaced value moves to *History*; **Reject** writes nothing.
If the Brain changed since the Proposal was made, for example the note was deleted or a note with the same title now exists, Apply refuses and writes nothing; the Proposal stays so you can reject it.
A Proposal can never change your identity record.

**Recent saves** on the Memory screen lists the newest changes to your Brain, newest first.
Each row shows the note, the fact with its old and new value, where the change came from (the Harness and session, a Proposal you approved, or you) and when.
**Revert** undoes one change with one click:

- A corrected fact gets its previous value back as a new correction, so the note's *History* shows both the change and its revert.
- A fact a save added is taken out of *Current state* and kept in *History*.
- A note a save created is removed from your Brain and from search, together with the events and facts that same save wrote into it.
- A removed note can be brought back by reverting the removal.

Every revert is listed as a change of its own, so you can revert a revert.
A change can be reverted only while it is still the last word on what it changed.
When a later change overwrote the same fact, or the note was edited outside Jarvis since, the row says why and offers no **Revert**; revert the later change first.
Events stay in *History*, which only grows, so they cannot be reverted.

**Drafts** shows each draft with its context and evidence.
Editing creates a new version and cancels any earlier approval.
**Approve** binds your approval to that exact version for 15 minutes.
**Send** is available only when the connection is authorised to write that kind of action; Jarvis rechecks everything on the service immediately before sending and marks the draft sent only after the other service confirms it.
Drafts expire after 48 business hours.

**Jobs** lists background work: research, briefings, draft preparation and source refreshes.
Jobs keep running when you close the browser; reopen the page and progress resumes from the service.
Cancelling tells you whether the work stopped or had already finished.

## Agent sessions

Jarvis can remember your work with coding agents: Claude Code, Codex and Antigravity.
Connect each agent you use under Connections → *Coding agents*; the card says exactly which file changes before you connect.

- **What changes in the agent:** Jarvis adds its own hooks to the agent's settings (`~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.gemini/config/hooks.json`).
  Your other settings and hooks are kept, the file is backed up to Jarvis's `backups/` folder first, and **Disconnect** removes exactly what Jarvis added.
- **Saving a session:** when a session ends or its context is compacted, the conversation is saved to `evidence/sessions/transcripts/` in your data folder, without tool output or injected context, and with secrets redacted.
  Antigravity has no end-of-session event, so its conversations are saved after every turn and summarised once they have been quiet for 15 minutes.
- **Session log:** each session gets an entry in `evidence/sessions/<date>-<machine>.md` with what was decided and learned, written by your model.
  Each Machine writes its own log file, named after the Machine (see *This Machine* below); logs from before Jarvis named Machines keep their `<date>.md` name and are still searched and shown.
  Most sessions have nothing durable, and the entry says so; without a model the entry only links the transcript.
  Session logs are searchable; raw transcripts are kept but never quoted as evidence.
- **Memory in new sessions:** every new session starts with a short block about you, an index of what Jarvis remembers, the latest session logs, and a command the agent can run to search Jarvis for more (`jarvis search "…"`).
  A session started inside one of a project's repositories also gets that project's current state first.
  A project lists its repositories in a `Repositories` fact, for example `- **Repositories** (2026-11-11): emilchristensen/jarvis, git@gitlab.com:team/api.git`; write `owner/name` for GitHub, `host/owner/name`, or a remote address, separated by commas, and ask your agent to save it like any other fact.
  The SSH and HTTPS addresses of a repository both match, in any folder or worktree of it; a session anywhere else gets the general block.
  Jarvis rewrites these blocks whenever your memory changes, and the agent's hook picks one by reading the folder's git remotes from disk, so session start stays instant and works offline.
  Antigravity gets the same block from an always-on rule, `~/.gemini/config/rules/jarvis-memory.md`.
- **Codex asks first:** Codex runs new hooks only after you approve them.
  The next time Codex starts it shows *Hooks need review*; choose **Review hooks** and trust the three Jarvis hooks.
  Codex remembers trust by position, so after you disconnect it may ask you to review hooks listed after Jarvis's again; reconnecting updates Jarvis's hooks in place and leaves yours where they are.
- **If Jarvis is not running,** sessions are queued on your Mac and saved the next time it starts.
- **Save and audit skills:** connecting an agent also adds two skills that only you can run; the agent never starts them on its own.
  In Claude Code and Antigravity type `/jarvis-save` or `/jarvis-audit`; in Codex type `$jarvis-save` or `$jarvis-audit`.
  - `/jarvis-save` distills the important parts of the last turn (decisions, lessons, current facts about people and projects) into your curated memory.
    It updates the note that already covers a topic instead of creating a second one, keeps every replaced value in the note's History, and records which session it came from.
    Add a few words after the command to say what to focus on.
  - `/jarvis-audit` checks your memory for facts that have quietly stopped being true, starting with the ones every new session reads.
    It reports contradicted and unsupported facts with the evidence, and corrects only what you approve.
  - Both use the Jarvis command line, so Jarvis must be running; `jarvis save --help` shows the format, and `jarvis audit` prints the same report from a terminal.
  - The skills live in `~/.claude/skills`, `~/.agents/skills` (Codex) and `~/.gemini/config/skills`; Jarvis never changes a skill folder it did not create, and **Disconnect** removes them.

Turning *Agent sessions* off in Settings disconnects every agent and removes the hooks and skills.
Uninstalling Jarvis removes them too.

## The Brain in any Harness (MCP)

Any Harness that speaks MCP, including ones without a shell such as Claude Desktop, can reach your Brain through Jarvis's MCP server.
The Harness starts it as a local process with the command `jarvis mcp`; there is no URL and no token to copy.
The server pairs with the running service the way the command line does and keeps its token in Jarvis's state folder, never in the Harness's configuration.

For now, add it to your Harness by hand, for example in Claude Code:

```sh
claude mcp add --scope user jarvis -- ~/.local/bin/jarvis mcp
```

Other Harnesses take the same command and argument in their MCP server settings.

- **search** finds passages in your Brain and returns each one with its path, line range, the kind of section it is in (current state, history or body) and the note's title.
  Like recall, it leaves out raw chat and session transcripts and includes their summaries.
- **read** returns a whole note, or only a line range, for a path that search returned.
- When the Harness connects, the server tells it who you are and lists the titles of your notes, so a Harness without Jarvis's hooks knows when to search.
- If Jarvis is not running, the server still starts, and each tool answers that Jarvis is not running and how to start it (`jarvis start`).
  The tools work as soon as Jarvis runs, without restarting the Harness.

## Editing notes in Obsidian

Your data folder is plain Markdown, so you can open it as an Obsidian vault or in any editor.
Jarvis picks up your edits within a few seconds.
There is no Obsidian plugin; use Jarvis in the browser to ask, capture and review attention items.

## Measuring search

`jarvis evaluate-recall` scores search against a set of questions you keep in your Brain at `evaluation/recall-questions.json`.
Each question names the note and the current fact that should answer it:

```json
{ "questions": [{ "question": "When is the Orion cutover?", "note": "memory/projects/orion-migration.md", "fact": "Status" }] }
```

`note` is the note's path inside the Brain and `fact` is the subject written in bold in its Current State.
The report says how often the expected fact is the first result and how often it is in the first three, and lists every question that missed with the first three results search returned instead.
A question whose note or fact is no longer in the Brain is not scored; the report lists it with the reason so you can correct the set.
Use `--set <file>` to score another set and `--json` for the full report.
Jarvis must be running, because the command scores the search the service runs.
The set is JSON, not Markdown, so search never finds the questions themselves.

## Sleep, offline and notifications

The service runs only while your Mac is awake.
When it wakes, each overdue schedule runs once to catch up; missed intervals are not replayed.
If a service is unreachable, its coverage shows *offline* and it is retried at the next refresh.

## Backup, restore and uninstall

- **Backup:** Settings → Backup and export → *Create backup now*, or `jarvis backup` in Terminal.
  A backup contains your data folder and Jarvis's database (settings, jobs, drafts, receipts).
  Credentials stay in your Keychain and are not included; after restoring elsewhere, reconnect your accounts.
- **Restore:** run `jarvis stop`, then `jarvis restore <backup.tar.gz> --data-folder <empty folder> --force`, then `jarvis start`.
  `--force` keeps the replaced database as a `.pre-restore` copy; without it, restore only writes into a fresh profile.
- **Uninstall:** `~/.local/bin/jarvis-uninstall` removes the app and service, removes Jarvis's hooks from your coding agents, and keeps your data.
  `jarvis-uninstall --delete-data` also removes service state, stored credentials and the data folder, after asking you to type DELETE.

## This Machine

Jarvis gives the computer it runs on an id and a name.
The name starts as the computer's hostname; change it in **Settings → This Machine**.
The id never changes.
Session logs and connector snapshots carry the name in their file name, for example `evidence/sessions/2026-11-11-work-mac-3f9a2c1d.md`, so you can tell which computer wrote them.
Renaming the Machine affects files written from then on; earlier files keep their name.

Only one Jarvis service can use a data folder at a time.
The lock that enforces this lives outside the data folder, in `~/Library/Application Support/Jarvis/locks`.

## Replication

Replication keeps the Brain the same on every Machine you run Jarvis on, through a private git repository.
It is off until you switch it on; a Brain on one Machine works exactly as before.
Each Machine needs git installed.

- **Switch it on** on the Machine that has your Brain: `jarvis replication setup owner/jarvis-brain`.
  Name an empty repository: `owner/name` on GitHub, an `https://` or `ssh://` address, or a folder path.
  Jarvis makes the data folder a git repository, commits everything in it and pushes it.
  A repository that already holds a Brain is refused, so two Brains are never mixed.
- **Join** from another Machine: `jarvis replication join owner/jarvis-brain --data-folder ~/Documents/Jarvis`.
  The folder must be empty or not exist yet.
  Jarvis clones the Brain into it, makes it this Machine's data folder and builds its search index, so search works straight away.
- **Status:** `jarvis replication status` says off, up to date, offline, unauthorized or blocked, with the cause when there is one.
  `jarvis replication check` replicates now instead of waiting for the next check.

What happens on its own:

- A save is committed and pushed 30 seconds after the last write, so a burst of saves becomes one commit.
- Edits you make by hand in an editor are committed and pushed too.
- Every minute, at start and when the Machine wakes, Jarvis fetches the other Machines' changes and merges them; search includes them as soon as they arrive.
- Each commit message names the files that changed, what changed in them (for example `corrected Status, added an event`) and the Machine.
- Offline, saves and search carry on as usual; the status reads offline, and the Machine catches up by itself when the repository can be reached again.
- A failing Replication never fails a save.
- Jarvis merges and never rebases or force-pushes, so nothing another Machine pushed is ever rewritten.
- A note is never left with conflict markers.
  Until the merge rules for notes arrive, a file both Machines changed in the same place blocks Replication, and the cause names it; edit the file on one Machine to match the other and Replication carries on.

The repository holds the whole Brain in plain text, so keep it private.
Files that belong to one computer stay out of it: Jarvis's own `.jarvis/` folder, temporary files, `.DS_Store` and Obsidian's workspace layout.

## Where things live

| What | Where |
| --- | --- |
| Your knowledge (Markdown) | The data folder you chose |
| Service state (settings, jobs, drafts, receipts, logs, backups, this Machine's id and name) | `~/Library/Application Support/Jarvis/state` |
| Writer locks (one per data folder in use) | `~/Library/Application Support/Jarvis/locks` |
| Credentials | macOS Keychain, service `dev.jarvis.default` |
| App | `~/Library/Application Support/Jarvis/current` |
| Command line | `~/.local/bin/jarvis` (`status`, `start`, `stop`, `pair`, `search`, `save`, `audit`, `evaluate-recall`, `replication`, `mcp`, `agent-hooks`, `backup`, `restore`), `~/.local/bin/jarvis-uninstall` |
| Coding-agent hooks | `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.gemini/config/hooks.json` (only the entries Jarvis added); `jarvis agent-hooks status` lists them |
| Coding-agent skills | `jarvis-save` and `jarvis-audit` in `~/.claude/skills`, `~/.agents/skills`, `~/.gemini/config/skills`; `jarvis agent-hooks status` lists them |
| Service agent | `~/Library/LaunchAgents/dev.jarvis.service.plist` |

## Troubleshooting

- *Jarvis service is not reachable:* run `jarvis status`.
  Reinstalling repairs the service without touching data.
  Logs: `~/Library/Application Support/Jarvis/state/logs`.
- *Pairing code expired:* run `jarvis pair --open`.
- *A connection shows "needs auth":* its sign-in was rejected or expired, and the card shows a **Sign-in needed** box saying what to fix.
  For a claude.ai connector, reconnect it in claude.ai → Settings → Connectors, or run `claude` once and sign in if Claude Code itself is signed out, then press **Reconnect** on the card.
  Reconnect tests the connection again and says what is still wrong if it fails.
  Once it succeeds, Jarvis refreshes that source straight away so the card stops showing the failed sync.
  Right after connecting a connector in claude.ai, Claude Code can keep reporting it as unauthenticated for a few minutes; press **Reconnect** again shortly.
  For an API token, **Reconnect** opens the form so you can enter a new token.
  If you chose **Sign in with Atlassian** directly, sign in again on the card.
- *Slack, Gmail or Calendar says Claude Code settings auto-approve its tools:* remove the listed `permissions.allow` rule from `~/.claude/settings.json`.
  Jarvis approves every connector call itself and will not run while a rule would skip that check.
