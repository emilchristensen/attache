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
- **Sources** names the Reader, the Machine that runs Source refresh and briefings, and when it last refreshed every source.
  Without Replication this Machine is its own Reader.
  Below it, each source shows its last successful refresh and whether its last Source refresh was complete, partial or failed.
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
Each Proposal shows the whole change before you decide: the new note or the note it updates, every fact with its reason, every event, notes and tags, why it was suggested and the evidence it cites, with the words it quotes from that evidence.
**Apply** writes every part at once, and each replaced value moves to *History*; **Reject** writes nothing.
If the Brain changed since the Proposal was made, for example the note was deleted or a note with the same title now exists, Apply refuses and writes nothing; the Proposal stays so you can reject it.
A Proposal can never change your identity record.
With Replication on, a Proposal made on one Machine shows on every Machine, and the Machine it was made on is named.
Decide it on any of them: approving applies it once, where you clicked, and it leaves the list everywhere.
If two Machines decided the same Proposal while apart, the later decision stands on both; an approval that a later rejection overrules is undone, except for events, which stay in *History*.

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
  Most sessions have nothing durable, and the entry says so; without a model the entry only links the transcript, and says that no Proposals were made.
  Session logs are searchable; raw transcripts are kept but never quoted as evidence.
- **Consolidation:** when the session log entry holds something durable, Jarvis reads the session again, with the notes that search finds related to it, and makes up to five Proposals from it in *Memory changes to review*.
  Each names the note it changes (or the new note it creates), the facts and events, an optional Review date, the reason, and the words in the session it rests on, linked to the line of the transcript.
  A session never yields more than five, however often it is summarised, and nothing is proposed twice: a change that is already waiting for review, or a fact the note already holds, is left out.
  Consolidation's Proposals always wait for your click, even when auto-accept is on for the Harness.
  It runs on the Machine where the session ended, with that Machine's model; a session that reaches another Machine through Replication is not consolidated there again.
- **Memory in new sessions:** every new session starts with a short block about you, the titles of the notes Jarvis keeps, and a command the agent can run to search Jarvis for more (`jarvis search "…"`).
  A session started inside one of a project's repositories also gets, first, that project's current state, the decisions and people linked to it, and the latest session-log entries from sessions in its repositories.
  A decision or a person is linked to a project when either note names the other, by its title or with a link to its file.
  The whole block stays within about 8 KB; when there is more, Jarvis drops note titles first, then the oldest session entries, then the least recently updated decisions and people, and says what it left out.
  The project's own facts are always there, and a fact past its Review date is marked unverified.
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

Replication is in the Dashboard under **Settings → Replication**, and in the terminal as `jarvis replication`.

- **Connect GitHub first** in the Dashboard's Connections.
  Replication reaches the repository with the GitHub connection's token, so its token needs Contents: read and write on the Brain's repository, besides what the GitHub source uses.
- **Switch it on** on the Machine that has your Brain: choose **Start with this Brain**, name the repository and select **Set up Replication** (or `jarvis replication setup owner/jarvis-brain`).
  Name an empty, private repository: `owner/name` on GitHub, a GitHub `ssh://` or `git@github.com:` address (which uses this Machine's ssh keys), or a folder path.
  A public repository is refused with a message that says so, and so is a repository on another host, because Jarvis can confirm that a repository is private only on GitHub.
  Jarvis makes the data folder a git repository, commits everything in it and pushes it.
  A repository that already holds a Brain is refused, so two Brains are never mixed.
- **Join** from another Machine.
  On a new Machine, open **Already use Jarvis on another Machine?** on the first setup screen, name the repository and select **Join into this folder**.
  On a Machine that is already set up, choose **Join another Machine** in Settings and name an empty folder for the Brain (or `jarvis replication join owner/jarvis-brain --data-folder ~/Documents/Jarvis`).
  The folder must be empty or not exist yet.
  A folder that is not empty may hold a Brain of its own, and Jarvis never merges two Brains, so the join is refused.
  Jarvis backs that folder up first, together with its database, to the `backups/` folder, and the refusal names the archive; it changes nothing in the folder.
  Move the folder aside or name an empty one, then join again; `jarvis restore` brings the backup back if you need it.
  Jarvis clones the Brain into it, makes it this Machine's data folder and builds its search index, so search works straight away.
- **Status:** the card says off, up to date, offline, unauthorized or blocked, when this Machine was last up to date, and when it last checked and last sent changes.
  When it is not up to date, the card shows the cause and what to do.
  **Check now** replicates straight away instead of waiting for the next check (`jarvis replication status` and `jarvis replication check` in the terminal).
- **Machines:** the card lists every Machine that shares the Brain, with when each last changed it.
  Rename this Machine under **This Machine**; the others show the new name after their next check.
  Tick **Standby** to let this Machine take over as Reader when the Reader goes silent, and choose the **Preferred Reader**, the Machine that should run Source refresh and briefings whenever it is online.
  Both are recorded in the Brain, in `machines/`, so every Machine reads the same; when two Machines choose differently at the same time, the later choice wins.
- **The Reader:** the list marks the Reader, the one Machine that runs scheduled Source refresh, briefings and the inbox items for facts past their Review date, so no source is read twice.
  The Machine that switched Replication on starts as the Reader; the Preferred Reader takes the role at its next check once you choose it, and whenever it comes back online.
  The other Machines read nothing on a schedule, and show the Reader's latest Source refresh on Home.
  A Source refresh you start yourself with **Refresh now** still runs on the Machine you are on.
  The Reader says it is still there every 10 minutes through the repository, without adding to the Brain's history.
  A Reader that could not reach the repository for 30 minutes, because it was asleep or offline, shows as silent and reads nothing on a schedule until it is back; then it catches up once.
- **Switch off** stops replicating from this Machine (`jarvis replication off`).
  The Brain stays in the data folder with its history, saves carry on locally, and the other Machines keep their copies.
  Set Replication up again with the same repository to pick up where it left off: this Machine's changes from while it was off are sent, and the others' are merged in.

What happens on its own:

- A save is committed and pushed 30 seconds after the last write, so a burst of saves becomes one commit.
- Edits you make by hand in an editor are committed and pushed too.
- Every minute, at start and when the Machine wakes, Jarvis fetches the other Machines' changes and merges them; search includes them as soon as they arrive.
- Each commit message names the files that changed, what changed in them (for example `corrected Status, added an event`) and the Machine.
- Offline, saves and search carry on as usual; the status reads offline, and the Machine catches up by itself when the repository can be reached again.
- A failing Replication never fails a save.
- Jarvis merges and never rebases or force-pushes, so nothing another Machine pushed is ever rewritten.
- A note is never left with conflict markers, and no merge waits for you.
- If the service stops in the middle of a merge, for example in a crash or a power cut, it abandons the half-done merge when it starts again, leaves the folder as it was before, and merges again.
- A note you delete, in Jarvis or in an editor, disappears from every Machine and from their search.
- When two Machines changed the same note while apart, its facts merge by subject.
  A fact only one Machine changed keeps that change.
  When both changed the same fact, the value with the newer date wins on every Machine, with its Review date; the other value goes to the note's History, naming the Machine it came from.
  On the same date, every Machine picks the same winner (the one whose Machine id sorts last).
  History keeps every line from both Machines, once each.
  The frontmatter merges field by field: the earliest `created`, the latest `updated`, lists such as `tags` and `sources` keep every item.
- Two notes with the same type and title, created on two Machines, become one note with the facts and History of both.
- A note deleted on one Machine and changed on another before they saw each other's change is kept, with the change, on every Machine.
  One inbox item, on the Machine that brought the two changes together, names the note and both Machines; delete the note again if it should go.
  Unlike other inbox items, it stays on that Machine.
- Until the prose merge arrives, a note whose free text both Machines changed differently, or any other file both changed in the same place, blocks Replication, and the cause names it; edit the file on one Machine to match the other and Replication carries on.
- While Replication is blocked, the inbox shows one item, "Replication is blocked", with the cause.
  While it is unauthorized, the item asks you to reconnect GitHub instead.
  It resolves by itself once Replication is up to date again.

The inbox replicates with the Brain:

- An item raised on one Machine shows on all of them.
- Dismissing or snoozing an item on one Machine applies on every Machine.
- A dismissed item whose source changed reopens everywhere, marked "changed since your decision".
- When two Machines decided differently on the same item before hearing of each other, the later decision wins.
- Inbox items live in the Brain's `review/inbox/` folder, one small file per item, and never show up in search.

Proposals replicate the same way, from the Brain's `review/proposals/` folder, which search never reads either.

Files that belong to one computer stay out of the repository: Jarvis's own `.jarvis/` folder, temporary files, `.DS_Store` and Obsidian's workspace layout.

### Credential scan

Before every commit, setup and merges included, Jarvis scans the files about to be committed for credentials.
It looks for exactly what it redacts from logs and evidence: GitHub, Slack, Atlassian, AWS, Google and Anthropic tokens, API keys, JSON web tokens, private keys, authorization headers, and the secrets of your connections.
A finding stops the commit and the push: the status reads blocked, and the cause and the inbox item name the file and line, never the credential itself.
Saves and search keep working on this Machine meanwhile, and the other Machines keep replicating with each other.
Everything already committed stays in the repository and on the other Machines.
Remove the credential from the file, by hand or with a save, and Replication continues by itself at the next check.
If you corrected the fact with a save, the old value is still in the note's History, so remove it there too.
A credential that is in the repository's history already does not hold back later edits to its file, but it is still there: rotate it, and purge it from the history by hand if you need to (see [Deleted notes stay in git history](#deleted-notes-stay-in-git-history)).

### Private repository and token

The repository holds the whole Brain in plain text, so Jarvis keeps checking that it is private:

- Jarvis asks GitHub whether the repository is private at setup, at join, and again before pushing once the last answer is five minutes old.
  A repository that has turned public blocks pushing and reads as blocked; make it private again and Replication carries on by itself.
- The token stays in the secret store.
  Git gets it from Jarvis's credential helper (`jarvis git-credential`) each time it reaches GitHub, so it is never part of the repository's address, its `.git/config`, a command line or the logs.
  Your own git credential helpers are not used for the Brain's repository.
- When GitHub rejects the token, the status reads unauthorized and the inbox asks you to reconnect GitHub; once you have, Replication carries on.

### Deleted notes stay in git history

Deleting a note removes it from the Brain, not from the repository's history: every earlier version stays in git, on GitHub and on every Machine's copy.
Jarvis never rewrites history, so it cannot erase it for you.
To purge a note that must not be kept, for example one holding a secret:

1. Check that `jarvis replication status` says up to date on every Machine, so nothing is waiting to be pushed, then run `jarvis stop` on every Machine.
2. On one Machine, clone the repository into a new folder outside the data folder and rewrite its history without the file, for example with [git filter-repo](https://github.com/newren/git-filter-repo): `git filter-repo --invert-paths --path memory/notes/the-note.md`.
   filter-repo removes the clone's remote, so add it back (`git remote add origin <repository>`) and run `git push --force origin main`.
   On GitHub, branch protection must allow the force-push, and GitHub support can remove cached views of old commits.
3. On every Machine, in the data folder, replace the old history with the rewritten one: `git fetch origin`, `git reset --hard origin/main`, `git reflog expire --expire=now --all` and `git gc --prune=now`.
   Otherwise the next merge would bring the old history back.
4. Run `jarvis start` on every Machine, and delete the clone from step 2.

A secret that was ever pushed should be treated as exposed: rotate it as well.

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
