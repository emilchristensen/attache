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
   Search is always on.
   Saving to memory, background work, attention and briefings, drafts and approvals, and agent sessions are optional.
   If a feature needs another one, Jarvis explains it and offers to turn the requirement on (or dependents off).
3. **Connections.**
   Connect only what you want: GitHub, Jira, Confluence, Slack, Gmail, Google Calendar.
   Every connection starts read-only.
   Slack, Gmail, Google Calendar, Jira and Confluence use your existing claude.ai connectors (Slack, Gmail, Google Calendar and Atlassian Rovo): Claude Code must be installed and signed in on this Mac with your claude.ai work account, and each connector must be connected in claude.ai → Settings → Connectors.
   For Jira and Confluence you also enter your site URL, for example `https://acme.atlassian.net`.
   If your organization allows it, Jira and Confluence can instead connect directly with **Sign in with Atlassian** or an Atlassian API token made for the MCP server.
   Steps that need an admin on the other side (allowing the Atlassian Rovo MCP server, enabling a claude.ai connector for the workspace, a GitHub token) are explained on the card before you connect.
   Under *Harnesses*, connect Claude Code, Codex, Antigravity or Claude Desktop if you use them.
   Each gets Jarvis's MCP server, so it can search your Brain and save to it with your confirmation; Claude Code, Codex and Antigravity also get the hooks that save their sessions (see Agent sessions and The Brain in any Harness below).
4. **Model and schedules.**
   Pick a model: Claude Code on this Mac (uses your existing Claude sign-in), an Anthropic API key, or any OpenAI-compatible endpoint including a local Ollama or LM Studio.
   Without a model, Jarvis still searches and shows you the evidence it finds.
   Set how often sources refresh, when the daily briefing is prepared, and whether urgent items raise a macOS notification.
5. **Test and finish.**
   Jarvis tests each connection and reports every feature as ready, partial, needs setup or unavailable.
   You can finish with a notes-only workspace and connect things later.

Everything chosen during setup can be changed later in **Settings** and **Connections**.

## Everyday use

**Home** shows the attention inbox.
Jarvis has no chat box: you ask the Brain from your Harness (see Using the Brain from a Harness below).

- The briefing summarises what changed, what needs your judgment and what Jarvis has prepared, one point per line.
  The counts under it jump to each group; drafts and memory changes open their own screens.
  **Away summary** covers the last three days.
- **Sources** shows each source's last successful refresh and whether its last Source refresh was complete, partial or failed.
  An item list is never shown as "nothing to do" when a source failed.
- Items are grouped into deadlines, review queue, meetings, pending replies and facts to check.
  **Dismiss** hides an item until its evidence changes; **Snooze** hides it until a time; **Done** closes it.
  A dismissed item comes back only if something about it changed, and it is marked "changed since your decision".
- **Prepare draft** asks Jarvis to write a reply or review comment with the item's context.

Press `g` followed by a letter (h, m, d, j, c, s) to switch views.

**Memory** lists people, projects, decisions and notes, plus imported notes, archived evidence and generated deliverables.
Each memory note has a *Current state* with one dated entry per subject.
The Dashboard shows notes, evidence and deliverables read-only: it has no capture box and no way to correct or edit a note.
Every change to the Brain goes through a Harness (see Using the Brain from a Harness below) or through your own edits to the Markdown files.
A changed fact replaces the current one, the old value moves to *History* with the date and the reason, and the next search returns the new value.
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

Jarvis remembers your work in the Harnesses that run hooks: Claude Code, Codex and Antigravity.
Connect each one you use under Connections → *Harnesses*; the card says exactly which files change before you connect.

- **What changes in the Harness:** connecting adds Jarvis's MCP server (see the next section) and Jarvis's own hooks, in one step.
  The hooks go into `~/.claude/settings.json`, `~/.codex/hooks.json` or `~/.gemini/config/hooks.json`; the MCP server into `~/.claude.json`, `~/.codex/config.toml` or `~/.gemini/config/mcp_config.json`.
  Your other settings, hooks and MCP servers are kept, each file is backed up to Jarvis's `backups/` folder first, and **Disconnect** removes exactly what Jarvis added.
  A file Jarvis cannot read (for example JSON with comments, or TOML that does not parse) is refused with a message that names it, and nothing is changed.
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

Turning *Agent sessions* off in Settings disconnects Claude Code, Codex and Antigravity and removes their hooks and Jarvis's MCP server; Claude Desktop stays connected.
Uninstalling Jarvis removes them all.

## The Brain in any Harness (MCP)

Every Harness you connect reaches your Brain through Jarvis's MCP server, including Claude Desktop, which has no shell and no hooks.
Connect Claude Desktop under Connections → *Harnesses* like the others; it gets the MCP server only, in its `claude_desktop_config.json`, and needs a restart to load it.
Its Code tab runs Claude Code, so connect Claude Code too to save those sessions.

The Harness starts the server as a local process (`jarvis mcp`, pinned to this install); there is no URL and no token to copy.
The server pairs with the running service the way the command line does and keeps its token in Jarvis's state folder, never in the Harness's configuration.
It is listed under the name `jarvis`.
If the Harness already lists a server named `jarvis` that Jarvis did not add (for example one you added by hand with `claude mcp add`), connecting stops and says so; remove that entry, then connect again.

Earlier versions installed two skills, `jarvis-save` and `jarvis-audit`, and a `jarvis save` command.
The MCP tools and prompts replace both, because a save is now confirmed by you in the Harness, which a shell command cannot do.
When Jarvis starts after the upgrade, it removes the skill folders it installed (the ones with its `.jarvis-skill.json` marker) and adds the MCP server to every Harness that was already connected; skill folders without the marker are left alone.

- **search** finds passages in your Brain and returns each one with its path, line range, area (`memory` for curated notes, `evidence` for logs, snapshots and wrap-ups), the kind of section it is in (current state, history or body) and the note's title.
  Like recall, it leaves out chat archives from earlier versions and raw session transcripts, and includes session summaries.
  A fact past its Review date is marked unverified.
  While meaning-based search is not ready on this Machine, the answer starts with a line saying the passages match keywords only, and why.
- **read** returns a whole note, or only a line range, for a path that search returned, and names the facts in it that are past their Review date.
- **save** writes facts and events: create a note with its facts, or update a note by its path with new values (each with a reason) and events.
  A fact can carry a Review date (see below).
  Every item is checked first, so one invalid item rejects the whole save with a message that says what to fix, and nothing is written.
  Before anything is written, the Harness asks you to confirm, listing every item with its facts and events.
  Accept, and the items are written as you, each fact citing the Harness and session it came from.
  Decline or close the request, and nothing is written; the agent is told so.
  A Harness that cannot show the request gets each item stored as a Proposal instead, for you to apply or reject in the Dashboard; the agent is told it awaits your review.
  Your identity record (`memory/self.md`) cannot be changed through this tool; change it in Settings.
- **Auto-accept** skips the confirmation for a Harness you trust.
  In Settings, under **Auto-accept saves**, each connected Harness has a switch, off by default.
  With it on, a save from that Harness is written without asking; every other Harness still asks.
  The setting belongs to this Machine only: it is kept in Jarvis's local state, not in your Brain, so another Machine asks until you switch it on there too.
  Disconnecting a Harness switches its auto-accept off.
  An auto-accepted save still records the Harness and session, and Recent saves on the Memory screen marks it **auto-accepted**, so you can review and revert it.
  Your identity record is never changed this way.
- **audit** lists every current fact with its date, Review date, age, source and flags, plus newer passages that name the note, where a contradiction would show up.
  A fact is flagged stale only when it is past its Review date; a fact without one is never stale, however old it is.
  It writes nothing.
- Three prompts carry Jarvis's procedures, so the Harness needs no installed skills.
  In Claude Code they appear as `/mcp__jarvis__save`, `/mcp__jarvis__audit` and `/mcp__jarvis__wrap-up`.
  - **save** distills what matters from the last turn: it searches before creating a note, sorts each item into a fact or an event, and saves through Jarvis rather than editing files.
    Text after the prompt says what to focus on.
  - **audit** runs the audit, judges each fact against the newer evidence, and shows you every correction before making it through Jarvis.
    Text after the prompt limits the audit to a topic.
  - **wrap-up** records the durable points of the current conversation: decisions, facts about people and projects, commitments and stated preferences.
    Use it where Jarvis cannot capture the conversation itself, such as the Chat tab in Claude Desktop.
    The agent stores the points with the `wrap_up` tool as one evidence document in `evidence/wrap-ups/`, with the Harness and the date, and with secrets redacted.
    The points are evidence, not curated memory: search finds them, labelled `evidence`, but none becomes a current fact unless it is saved to a note.
    When the conversation held nothing durable, nothing is stored and the agent tells you so.
- When the Harness connects, the server tells it who you are and lists the titles of your notes, so a Harness without Jarvis's hooks knows when to search.
- If Jarvis is not running, the server still starts, and each tool answers that Jarvis is not running and how to start it (`jarvis start`).
  The tools work as soon as Jarvis runs, without restarting the Harness.

## Review dates

A fact you expect to change, such as a status, a plan or a deadline, can carry a Review date: the day after which it should be checked again.
In the note it sits beside the fact's own date, for example `- **Status** (2026-11-10, review 2026-11-13): Beta opens to customers`.
An agent sets it when it saves a fact, and a Proposal can carry one per fact; it must come after the fact's own date.
You can also add or change one by hand in your editor, and Jarvis reads it.
Facts that stay true, such as a repository's name, need none, and Jarvis never adds Review dates in bulk.

Past its Review date a fact stays in your Brain, marked unverified: in the Dashboard, in search results, in what a Harness reads, and in the context a new agent session starts with.
Each such fact also raises one item under **Facts to check** in the inbox, naming the note and the fact, when your data folder is next refreshed.
Dismissing the item keeps it dismissed until the fact or its Review date changes.
The audit flags these facts, and only these, as stale.

To clear the mark and the item, save the fact again: a correction without a Review date clears the old one, and one with a new date sets it.
To confirm a fact is still true, save the same value with a later Review date.
The old value keeps its Review date in History, and reverting a correction brings back the previous value with its Review date.

## Editing notes in Obsidian

Your data folder is plain Markdown, so you can open it as an Obsidian vault or in any editor.
Jarvis picks up your edits within a few seconds.
There is no Obsidian plugin; use the Dashboard in the browser to search, review attention items and decide on Proposals.

## Meaning-based search

Search can also find notes by meaning, so a question in other words, or in Danish, finds an English note.
It uses a small multilingual model (multilingual-e5-small, about 135 MB) that runs on each Machine, without a network and without sending your notes anywhere.
Jarvis does not ship the model: download it once per Machine in **Settings → Meaning-based search**.
The card shows the model's state: not downloaded, downloading, building, ready or failed.
After the download Jarvis builds a vector for every passage it has indexed, in the background, and keeps them current as files change.
Search keeps working on keywords the whole time; until vectors are ready, results in the Dashboard and in a Harness say they match keywords only.
If the download fails, the card says why and offers to download again.
The model lives in the service state folder and its vectors in this Machine's index, never in your Brain, so they are not replicated; each Machine builds its own.

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
| Service state (settings, jobs, drafts, receipts, logs, backups, this Machine's id and name, the search index and its vectors) | `~/Library/Application Support/Jarvis/state` |
| Meaning model, once downloaded | `~/Library/Application Support/Jarvis/state/models` |
| Writer locks (one per data folder in use) | `~/Library/Application Support/Jarvis/locks` |
| Credentials | macOS Keychain, service `dev.jarvis.default` |
| App | `~/Library/Application Support/Jarvis/current` |
| Command line | `~/.local/bin/jarvis` (`status`, `start`, `stop`, `pair`, `search`, `audit`, `evaluate-recall`, `replication`, `mcp`, `agent-hooks`, `backup`, `restore`), `~/.local/bin/jarvis-uninstall` |
| Harness hooks | `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.gemini/config/hooks.json` (only the entries Jarvis added); `jarvis agent-hooks status` lists them |
| Harness MCP server | `~/.claude.json`, `~/.codex/config.toml`, `~/.gemini/config/mcp_config.json`, `~/Library/Application Support/Claude/claude_desktop_config.json` (only the `jarvis` entry); `jarvis agent-hooks status` lists them |
| Service agent | `~/Library/LaunchAgents/dev.jarvis.service.plist` |

`jarvis paths` prints every one of these locations for the computer it runs on, and `jarvis service status` says whether the background service is loaded.

## Troubleshooting

- *Jarvis service is not reachable:* run `jarvis status`.
  `jarvis service status` says whether the background service is loaded.
  Reinstalling repairs the service without touching data.
  Logs: `~/Library/Application Support/Jarvis/state/logs`.
- *Pairing code expired:* run `jarvis pair --open`.
- *A connection shows "needs auth":* its sign-in was rejected or expired, and the card shows a **Sign-in needed** box saying what to fix.
  For a claude.ai connector, reconnect it in claude.ai → Settings → Connectors, or run `claude` once and sign in if Claude Code itself is signed out, then press **Reconnect** on the card.
  Reconnect tests the connection again and says what is still wrong if it fails.
  Once it succeeds, Jarvis refreshes that source straight away so the card stops showing the failed Source refresh.
  Right after connecting a connector in claude.ai, Claude Code can keep reporting it as unauthenticated for a few minutes; press **Reconnect** again shortly.
  For an API token, **Reconnect** opens the form so you can enter a new token.
  If you chose **Sign in with Atlassian** directly, sign in again on the card.
- *Slack, Gmail or Calendar says Claude Code settings auto-approve its tools:* remove the listed `permissions.allow` rule from `~/.claude/settings.json`.
  Jarvis approves every connector call itself and will not run while a rule would skip that check.
