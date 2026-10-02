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

## First-run setup

Setup has five steps and each works without the ones after it.

1. **Data folder.**
   Choose where Jarvis stores knowledge (default `~/Documents/Jarvis`).
   Preview shows exactly what will be created and confirms that existing files are not modified.
   You can also point Jarvis at an existing Markdown folder or Obsidian vault; it is read in place and never changed.
2. **Features.**
   Conversation and search are always on.
   Capture, background work, attention and briefings, drafts and approvals, agent sessions and voice are optional.
   If a feature needs another one, Jarvis explains it and offers to turn the requirement on (or dependents off).
3. **Connections.**
   Connect only what you want: GitHub, Jira, Confluence, Slack, Gmail, Google Calendar.
   Every connection starts read-only.
   Steps that need an account or admin action on the other service (a Slack app, a Google Cloud OAuth client, an Atlassian API token, a GitHub token) are explained on the card before you connect.
   Under *Coding agents*, connect Claude Code, Codex or Antigravity if you use them (see Agent sessions below).
4. **Model, voice and schedules.**
   Pick a model: Claude Code on this Mac (uses your existing Claude sign-in), an Anthropic API key, or any OpenAI-compatible endpoint including a local Ollama or LM Studio.
   Without a model, Jarvis still searches and shows you the evidence it finds.
   If voice is on, set up speech here (see Voice below).
   Set how often sources refresh, when the daily briefing is prepared, and whether urgent items raise a macOS notification.
5. **Test and finish.**
   Jarvis tests each connection and reports every feature as ready, partial, needs setup or unavailable.
   You can finish with a notes-only workspace and connect things later.

Everything chosen during setup can be changed later in **Settings** and **Connections**.

## Everyday use

**Home** shows the attention inbox beside a persistent conversation.

- The briefing summarises what changed, what needs your judgment and what Jarvis has prepared.
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
Press `/` to jump to the message box, `Esc` to stop speech, and `g` followed by a letter (h, m, d, j, c, s) to switch views.

**Memory** lists people, projects, decisions and notes, plus imported notes, archived evidence and generated deliverables.
Each memory note has a *Current state* with one dated entry per subject.
Use **Correct** to change a fact: the new value replaces the current one, the old value moves to *History* with the date and your reason, and the next answer uses the correction.
**Capture** archives text as evidence and can record a decision in memory linked to that evidence.
Changes that Jarvis proposes wait in *Memory changes to review* until you apply or reject them.

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
- **Session log:** each session gets an entry in `evidence/sessions/<date>.md` with what was decided and learned, written by your model.
  Most sessions have nothing durable, and the entry says so; without a model the entry only links the transcript.
  Session logs are searchable; raw transcripts are kept but never quoted as evidence.
- **Memory in new sessions:** every new session starts with a short block about you, an index of what Jarvis remembers, the latest session logs, and a command the agent can run to search Jarvis for more (`jarvis search "…"`).
  Antigravity gets the same block from an always-on rule, `~/.gemini/config/rules/jarvis-memory.md`.
- **Codex asks first:** Codex runs new hooks only after you approve them.
  The next time Codex starts it shows *Hooks need review*; choose **Review hooks** and trust the three Jarvis hooks.
  Codex remembers trust by position, so after you disconnect it may ask you to review hooks listed after Jarvis's again; reconnecting updates Jarvis's hooks in place and leaves yours where they are.
- **If Jarvis is not running,** sessions are queued on your Mac and saved the next time it starts.

Turning *Agent sessions* off in Settings disconnects every agent and removes the hooks.
Uninstalling Jarvis removes them too.

## Voice

Voice is optional and push-to-talk only; the microphone is never on otherwise.
Hold **Hold to talk** (or hold Space while it is focused), speak, and release.
Jarvis transcribes, answers in text, and speaks the answer if *Speak replies* is on. Press `Esc` or **Stop speaking** to interrupt.

- **On this Mac:** speech recognition with whisper.cpp and the macOS voice.
  Install whisper.cpp once with `brew install whisper-cpp`; Jarvis downloads the 148 MB recognition model when you click Download in setup.
  Audio stays on your Mac.
- **OpenAI-compatible speech API:** enter the base URL and key.
- **Browser:** recognition and speech in Chrome (audio is sent to Google by the browser).

If the microphone is blocked, Jarvis tells you how to allow it; typing always works.

## Obsidian

Jarvis includes a desktop Obsidian plugin that talks to the same service.

1. Copy the three files from `~/Library/Application Support/Jarvis/current/obsidian-plugin` (or unzip `jarvis-obsidian-plugin-<version>.zip`) into `<your vault>/.obsidian/plugins/jarvis-companion/`.
2. In Obsidian: Settings → Community plugins → turn off Restricted mode if needed → enable **Jarvis**.
3. In Jarvis (browser): Settings → Paired clients → **Create pairing code**.
   In Obsidian: Settings → Jarvis → enter the code → **Pair**.
   The access token is stored in Obsidian's secret storage (Settings → Keychain), not in the vault.
4. Use the commands *Jarvis: Ask about the current note*, *Capture selection with provenance*, *Open attention items* and *Research the current note in the background*, or the robot icon in the ribbon.

If the vault should be searchable by Jarvis, also import it in Jarvis → Connections → *Import a Markdown folder*.
Closing Obsidian does not stop Jarvis.

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

## Where things live

| What | Where |
| --- | --- |
| Your knowledge (Markdown) | The data folder you chose |
| Service state (settings, jobs, drafts, receipts, logs, backups) | `~/Library/Application Support/Jarvis/state` |
| Credentials | macOS Keychain, service `dev.jarvis.default` |
| App | `~/Library/Application Support/Jarvis/current` |
| Command line | `~/.local/bin/jarvis` (`status`, `start`, `stop`, `pair`, `search`, `agent-hooks`, `backup`, `restore`), `~/.local/bin/jarvis-uninstall` |
| Coding-agent hooks | `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.gemini/config/hooks.json` (only the entries Jarvis added); `jarvis agent-hooks status` lists them |
| Service agent | `~/Library/LaunchAgents/dev.jarvis.service.plist` |

## Troubleshooting

- *Jarvis service is not reachable:* run `jarvis status`.
  Reinstalling repairs the service without touching data.
  Logs: `~/Library/Application Support/Jarvis/state/logs`.
- *Pairing code expired:* run `jarvis pair --open`.
- *A connection shows "needs auth":* its token was rejected or expired; open Connections and reconfigure it.
  Google testing-mode OAuth clients expire refresh tokens after 7 days.
