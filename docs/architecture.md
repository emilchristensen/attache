# Attache architecture

Attache is one local service with a thin browser client and a command line.
The service owns memory writes, credentials, tool authority, durable jobs, scheduling and action execution.
The browser client and the CLI render state and submit requests; neither writes memory or schedules work.

```mermaid
flowchart LR
  Browser[Browser client] -- HTTPS-less loopback + pairing token --> API
  CLI[attache CLI] -- same versioned API --> API
  Electron[Future Electron client] -.-> API
  subgraph Service[attache service - Node 24, one process]
    API[/api/v1 router + SSE/]
    Registry[Capability registry]
    Memory[Memory writer + policy]
    Index[(SQLite FTS5 index)]
    Jobs[Durable job queue + worker]
    Sched[Scheduler]
    Actions[Drafts, approvals, execution]
    Conn[Connector adapters]
    Models[Model adapters]
    Creds[(System secret store)]
  end
  API --> Registry --> Sched --> Jobs
  Jobs --> Conn & Models & Memory
  Memory --> Vault[(Data folder: Markdown)]
  Memory --> Index
  Actions --> Conn
  Conn --> Creds
```

## Stack and why

| Concern | Choice | Reason |
| --- | --- | --- |
| Runtime | Node.js 24 LTS, bundled in the release artifact | Its built-in `node:sqlite` ships SQLite 3.53 with FTS5, so there is no native addon to rebuild per platform. Node 22.14 lacks FTS5 (verified). One language across service, web and plugin. |
| Service HTTP | `node:http` with a small router and server-sent events | Few moving parts; SSE gives ordered, resumable events with `Last-Event-ID`. |
| Contracts | `zod` schemas in `packages/contracts` | Shared by service, web and plugin; validated at the server boundary. |
| State | One SQLite database in the service state directory | Jobs, events, approvals, attention decisions, connection state. WAL mode. |
| Knowledge | Markdown files in the user's chosen data folder | Human-readable, Obsidian-compatible; the FTS index is rebuildable from the files. |
| Dashboard | React + Vite, `markdown-it` with raw HTML disabled | Small, well-known; imported Markdown cannot inject HTML or `javascript:` links. |
| Secrets | The operating system's secret store behind one interface: the macOS Keychain via `/usr/bin/security -i`, the Linux Secret Service via libsecret's `secret-tool`, Windows Credential Manager via Windows PowerShell (values on stdin and stdout, never argv); a private file (0600, or an owner-only access-control list on Windows) where none works | Outside the vault and outside frontend storage. |
| Remote sources | GitHub REST; Jira and Confluence through the Atlassian Rovo MCP server; Slack, Gmail and Calendar through the user's claude.ai connectors | Atlassian's MCP server and the organization's claude.ai connectors are the supported, admin-governed access paths, so no per-user Slack app or Google Cloud OAuth client is needed. The MCP client is about 200 lines because Attache needs only initialize, tools/call and its own OAuth flow on the existing loopback callback; the Claude Code control protocol is driven directly so the argument-level approval gate stays in Attache's code. |
| Install | Self-extracting installer bundling Node, the service bundle and web assets; the bundled `attache` sets up the background service and command-line wrappers | One command/double-click; no developer tools required. |

## Data layout

Data folder (user-chosen, Markdown):

```
<data folder>/
  README.md                 what each area is for
  memory/                   curated memory (recalled as knowledge)
    people/ projects/ decisions/ notes/
    self.md                 identity record (protected)
  evidence/                 archived evidence, never presented as curated fact
    captures/                captures, such as meeting notes and transcripts (a new one tagged as a meeting is consolidated)
    conversations/           chat archives from versions that had a chat (kept, never quoted by recall)
    connectors/<kind>/       connector snapshots, one file per day per Machine
    sessions/                Harness session logs, one file per day per Machine (searchable)
      transcripts/<agent>/   redacted session transcripts (archived, never quoted by recall)
    wrap-ups/                durable points of Harness conversations, from the wrap-up prompt (searchable)
  deliverables/             generated work products (briefings, research, drafts), one file each, named with the day and the Machine
  review/                   review state, one JSON file per item, never indexed for recall
    inbox/                   inbox items with the owner's latest decision
    proposals/               Proposals with every decision made on them
```

Imported folders stay where they are.
The import preview lists what will be read, what is skipped and that zero files in the source folder change.
Imported files are indexed read-only as area `import` and cited by their real path and line range.

Service state (`~/Library/Application Support/Attache/state` on macOS, `~/.local/state/attache` on Linux): `attache.sqlite`, logs, runtime metadata, backups.
`attache.sqlite` carries its schema number in `user_version`, one per migration in `core/db.ts`, and the `schema_writer` table names the Attache version that applied the newest one.
A version refuses a database past its own migrations before changing anything (`core/schema-guard.ts`), in the service, every command that opens it and `attache restore`, and names the version from `schema_writer` to install again.
`schema_writer` is a contract between versions: its name and columns never change.
A service that refuses exits with code 78 and leaves `refused-to-start` in the state folder, so it is not started again every few seconds: systemd stops on the code (`RestartPreventExitStatus`), the Windows supervisor ends on it, and the launchd agent is kept alive only while that file is absent (`KeepAlive` `PathState`).
The next service that starts removes the file.
`attache data-folder` still reads such a database read-only, so an uninstall works whatever version wrote it.
Writer locks (`~/Library/Application Support/Attache/locks`, `~/.local/state/attache/locks` on Linux, `%LOCALAPPDATA%\Attache\locks` on Windows, `ATTACHE_LOCK_DIR` in tests): one file per data folder in use, named by a hash of the folder's real path.
Credentials: Keychain service `dev.attache.<instance>` on macOS; Secret Service items with attributes `service=dev.attache.<instance>` and `account=<key>` on Linux; generic credentials with the target `dev.attache.<instance>/<key>` (persisted for this computer, not roamed; values over 2,560 bytes continue in `<target>#2`, `#3` and so on) on Windows.
The system stores keep an index of key names (never values) in the state folder, because they cannot be listed safely.

## Platform modules

Everything that differs between macOS, Linux and Windows lives in `apps/service/src/platform/`, so the rest of the service never calls an operating-system tool or hard-codes an operating-system path.

| Module | Interface | macOS | Linux | Windows |
| --- | --- | --- | --- | --- |
| `service-manager/` | `ServiceManager`: install, start, stop, uninstall, loaded | launchd agent `dev.attache.<instance>` | systemd user service `attache-<instance>.service` (`attache.service` by default) | Task Scheduler logon task `Attache-<instance>` (`Attache` by default) |
| `secret-store/` | `SecretStore`: get, set, delete, keys, and a note saying why the file is in use | Keychain | Secret Service via `secret-tool` when one answers at start, else the owner-only file; secrets left in the file move into the Secret Service on a later start | Credential Manager via Windows PowerShell when a throwaway credential can be written, read back and removed at start, else the owner-only file; secrets left in the file move in on a later start |
| `notifier/` | `Notifier`: check, notify; `DesktopNotifications` applies `ATTACHE_NO_NOTIFY` and quiet hours and logs when notifications turn off and on | Notification Center via `osascript` | `org.freedesktop.Notifications` via `notify-send` | Windows notifications via Windows PowerShell, from the sender `dev.attache.<instance>` registered under `HKCU\Software\Classes\AppUserModelId`; `forget` removes it |
| `locations.ts` | install prefix, state folder, command folder, service definition folder, Documents folder, `tar`, managed Claude Code settings, tool folders | `~/Library/Application Support/Attache` | XDG base directories | `%LOCALAPPDATA%\Attache` |
| `folder-suggestions.ts` | the data folder setup suggests and the example folders the Dashboard shows in empty folder fields (`GET /setup/defaults`, the imported folder's path field), in the Documents folder with the platform's separators | `~/Documents/Notes` | `~/Documents/Notes` | `%USERPROFILE%\Documents\Notes` |
| `harness-locations.ts` | each Harness's hooks file, rules folder, MCP configuration file, earlier skills folder, executables and install markers | | | |
| `wrapper.ts` | the release launcher and the `attache` and `attache-uninstall` wrappers | POSIX shell | POSIX shell | plain-ASCII `.cmd` in the install's `bin` folder, finding the install from its own folder (`%~dp0`), because cmd.exe reads batch files in the console's code page |
| `shell-command.ts` | `shellPath`: a path quoted for the command lines a Harness runs (hooks, the search command in the session context) | single quotes | single quotes | double quotes and forward slashes, which Git Bash (Claude Code) and cmd.exe (Codex) read alike |
| `launch.ts` | `launchTool`: how to start a tool found on disk without a shell; a Node script runs with Attache's Node | as is | as is | an npm `.cmd` shim runs the script it wraps with Attache's Node, because cmd.exe cannot pass arguments with line breaks |
| `powershell.ts` | `runPowerShell`: a script with one JSON request on stdin and one JSON answer on stdout, the script passed as `-EncodedCommand`, so no script file or execution policy is involved | | | Windows PowerShell 5.1 (also drives the logon task) |
| `private-file.ts` | `writePrivateFile`: write a file only its owner can read, made private while still empty | mode 0600 | mode 0600 | an access-control list of its own, inheritance removed, with only the current user (`icacls`, the user from `whoami /user`) |
| `folder-watch.ts` | `watchFolderTree`: report changes anywhere below a folder; a failure after the start goes to `onError`, never out of an event handler | native recursive `fs.watch` (FSEvents) | one non-recursive inotify watch per folder (`linux-folder-watch.ts`), because Node's recursive watch on Linux throws from its event handler when a watched folder is replaced by a file ([nodejs/node#66791](https://github.com/nodejs/node/issues/66791)) | native recursive `fs.watch` |
| `replace-file.ts` | `replaceWith`: move a written temporary file over its target in one step; `writeFileWhole`: write a file another process may be reading (`runtime.json`) that way | rename | rename | rename, retried for up to five seconds while another program holds the target open |

`os.ts` maps Node's platform to one of the three; any other operating system gets one clear message from every command instead of a failure halfway through.
The installer and uninstaller are thin scripts (POSIX shell on macOS and Linux, Windows PowerShell on Windows) that call the bundled `attache` (`attache service`, `attache wrappers`, `attache credentials clear`, `attache notifications forget`, `attache locks clear-stale`, `attache paths`, `attache data-folder`), so their platform-specific work is the same code the service uses.
`attache paths` prints every resolved location for the computer it runs on.
`attache data-folder` names the data folder and the entries Attache created in it, which is all a data-deleting uninstall removes; when the service database cannot be read it fails, and the uninstaller keeps the data folder and says so.
`attache locks clear-stale` removes the writer locks of services that are gone, as a service killed outright leaves them, so a data-deleting uninstall can remove the shared locks folder; a lock a live process holds, or one it cannot read, stays.

The Linux service is a systemd user unit in `~/.config/systemd/user`.
`Restart=always` brings it back after a crash, and `WantedBy=default.target` starts it with the owner's user manager, that is, at login.
Installing enables the unit by its full path, so systemd links it in even when the user manager does not read the folder Attache wrote it to (an `XDG_CONFIG_HOME` the login does not share).
`systemctl --user` reaches the user manager through `XDG_RUNTIME_DIR`; when that is unset (`su`, some SSH setups), Attache tries `/run/user/<uid>`, and otherwise tells the owner to log in as themselves or turn on lingering.
The service's output goes to `service.out.log` and `service.err.log` in the state folder's `logs`, as launchd's does on macOS.

The Windows service is a Task Scheduler task with a logon trigger for the owner's own account, running as the owner with limited rights (`InteractiveToken`, so it can reach the owner's Credential Manager and desktop), and needs no administrator rights to register.
A task cannot set environment variables, and Task Scheduler does not restart a program that exits, so the task runs `attache service run` (`platform/service-manager/supervisor.ts`).
It starts `attache serve` with the environment launchd and systemd units set (home folder, application data folders, state folder, instance, web folder), appends its output to `service.out.log` and `service.err.log`, and starts it again after a crash, 2 seconds later at first and backing off to a minute while it keeps failing.
The service is started detached, with an IPC channel to its supervisor, and shuts down cleanly when the channel closes, so it never outlives the task and is never killed mid-write with it.
The task starts the bundled runtime through `conhost.exe --headless`, because a console program started by a task would otherwise open a window on the owner's desktop.
Ending the task ends that console host but not the supervisor it started, so the supervisor stops itself once its parent is gone, and `attache stop` waits for it (ending it outright after 15 seconds).
The service manager drives the task through Windows PowerShell's ScheduledTasks cmdlets, whose task states are the same in every display language.

### Machine identity and per-Machine evidence

Each Machine has an id (a UUID made once) and a name (the hostname without its domain until the owner renames it), kept in the `machine` table of the service database, never in the Brain.
`GET /machine` returns both; `PATCH /machine` renames (1 to 64 characters, no control characters); Settings shows them.
Evidence that every Machine appends to is written per Machine, so that Replication never merges two Machines' writes into one file (ADR 0001): session logs go to `evidence/sessions/<date>-<machine>.md` and connector snapshots to `evidence/connectors/<kind>/<date>-<machine>.md`.
`<machine>` is the name's slug plus the first eight hex digits of the id, so two Machines with the same name still write apart; the frontmatter records `machine` and `machine_id`.
Wrap-ups are new files rather than appends, and carry the tag too (`evidence/wrap-ups/<date>-<machine>-<title>.md`), so two Machines never create the same file.
Files written before this change keep their `<date>.md` name; search and the audit index them like any evidence, and the session context reads every file of a day, old or per-Machine, as that day's log.

## Replication

Replication keeps every Machine's copy of the Brain the same through a git repository (ADR 0001); the whole Brain replicates (ADR 0002).
The code is in `apps/service/src/replication/`; `App.replication` owns it, and `POST /replication/setup`, `POST /replication/join`, `GET /replication`, `POST /replication/check` and `POST /replication/off` expose it (`attache replication` calls them).
The Dashboard's Replication card in Settings (`apps/web/src/views/Replication.tsx`) and the join option on the first setup screen use the same endpoints and refresh on the `replication.changed` event.

- **Local state.** The `replication` table holds the data folder, the remote, the last change-log `seq` already described in a commit, the last status, and when a check last left the Machine up to date (`upToDateAt`).
  No row means off.
  Switching off deletes the row and nothing else: the data folder, its `.git` and the remote stay as they are.
  Setup on an Attache-managed repository whose history the remote shares (fetched into a scratch ref, `refs/attache/candidate`) resumes instead of refusing, and the next check merges both sides.
  A data folder other than the one Replication was set up for reads as blocked.
- **The repository.** Setup runs `git init -b main` in the data folder, marks it with `attache.managed=true` (a repository Attache did not make is refused), writes `.gitignore` (`.attache/`, `.*.tmp`, `.DS_Store`, `Thumbs.db`, `.obsidian/workspace*.json`) and `.gitattributes` (`* text=auto eol=lf`, put first in a file the owner already had, so their own lines still apply), commits and pushes.
  Setup and join first check that git runs (`gitVersion`), else refuse with `git_missing` and the way to install git on this operating system (`platform/git-install.ts`); on Windows git is also looked for where Git for Windows installs it, for a service whose PATH predates the install.
- **Line endings.** The Brain is LF on every Machine.
  Git stores and checks out LF through `.gitattributes`, and Attache runs git with `core.autocrlf=false` and `core.safecrlf=false`, so neither Git for Windows' default `autocrlf` nor an owner's `safecrlf` can change a note or refuse the commit of one an editor saved with CRLF.
  Attache reads CRLF notes like LF ones (`toLf` in `memory/markdown.ts`, used by the parser and `MemoryStore.read`), and `MemoryStore` writes LF only, whatever line breaks a save's text came with.
  It refuses a remote whose `main` already has commits.
  Join clones `main` into an empty folder, then opens it like `/setup/data-folder`, which indexes it.
  A folder that is not empty is refused with `not_empty`, after `createBackup` archives it with the database to `backups/attache-backup-<time>-before-join.tar.gz`; the error's `details.backup` names the archive.
- **The loop** (`replication.ts`): triggered 30 seconds after the last write (`MemoryStore` `onWrite`), on an outside edit the file watcher sees, at start, on wake (`Scheduler.onResume`) and by a one-minute check.
  One check at a time: commit everything (`git add -A`, so hand edits are included), fetch, commit what was saved meanwhile, merge, push; when the push is rejected because another Machine pushed first, fetch, merge and push again, up to five times, then retry with backoff.
  Failures set the status (offline, unauthorized, blocked) and never reach a save; a newer Brain format sets paused (below).
- **Writes pause while git changes the folder.** Commit and merge run synchronously (`BrainRepo`, `Git.runSync`), so no save can land halfway through them; only fetch, push and clone wait on the network asynchronously.
  At the start of every check, what a crash left behind is undone: git lock files older than the service's start (`index.lock`, `HEAD.lock`, `ORIG_HEAD.lock`, the branch and upstream ref locks) are removed, then a merge in progress (`MERGE_HEAD`) is aborted, the files it had touched are re-indexed, and the check merges again.
- **Never rewrites history.** Bringing in other Machines' changes is a fast-forward or a merge commit; `Git` refuses `rebase`, `pull`, `reset --hard` and any forced or deleting push before running git; the one deletion it lets through is a retired Reader lease generation.
- **Merging.** A file both sides changed goes to the merge rules (`MergeRule` in `seams.ts`); a file no rule settles aborts the merge and reads as blocked with its path, so no conflict marker is ever left in a file.
  Files the merge changed are re-indexed straight away (`Replication.onPulled`), before the file watcher would notice them; deleted files leave the index the same way.
  Merge rules are tried in the order `defaultSeams()` lists them (`mergeByRules`); the first that returns an outcome settles the file.
  The first rule, `deleted-and-changed` (`replication/deleted-and-changed.ts`), settles a Markdown note one side deleted and the other changed by keeping the changed version, with a notice; the review-state rules (`review/inbox/`, `review/proposals/`) and the note merge rule for notes both sides changed come after it.
  `MergeNotice`s become inbox items through `Inbox.apply` on the Machine that made the merge (`replication/merge-notice-inbox.ts`, source `replication_merge`; a source of its own, because the blocked item's refresh resolves every other `replication` item).
  They replicate through `review/inbox/` like any item, so every Machine shows them.
  Their key never holds the merge's time: a per-path notice is keyed by kind and path, any other by kind, path and its `version` (for a deleted-and-changed note, a hash of the note it kept), so two Machines that merge the same thing raise one item.
  A notice is one item per merge, unless it is `perPath`: then it is one item per file while it stays open, and a later merge raises it again only after it resolved.
  Items are resolved only by the owner, except the kinds listed in `SETTLED_BY_EDIT`: whenever the index changes (a save, an editor, a pull), `settleMergeNotices` reads their file and resolves the ones the owner has settled.
- **The note merge rule** (`replication/note-merge/`, `noteMergeRule()`) settles notes under `memory/` that both sides changed.
  It takes each version apart (`parts.ts`): frontmatter, Current State entries (with their indented lines), History items, and the prose, which keeps one placeholder line where the facts and the History items were.
  Facts merge by subject (`facts.ts`): a subject one side changed takes that change, a change wins over a removal, and when both changed it the newer date wins, a tie going to the Machine whose id sorts last; the losing value becomes a `superseded` History line naming both Machines, dated with the winner's date.
  History is unioned (`history.ts`): the shared start stays, what each side added is interleaved by date, every item once.
  Frontmatter merges field by field (`frontmatter.ts`): a field one side changed takes that change; when both did, `created` keeps the earliest, `updated` the latest, lists keep every item, anything else comes from the note updated last.
  Prose goes to a `ProseMerge` (`prose.ts`); Replication registers `keepBothVersions` (`prose-versions.ts`), a three-way line merge (`line-diff.ts`, `line-merge.ts`).
  Changes from the two sides that touch different base lines all merge, neighbouring lines included; an insertion right before or after a line the other side changed is not a clash, two different insertions at the same place are.
  Where both sides changed the same lines differently, the lines both versions start and end with stay shared, and what differs is kept twice: under `### Version from <Machine>` headings (one level below the section they sit in; a Machine's id is added when both carry the same name), in the agreed Machine order, with a `perPath` notice of kind `prose_versions`.
  The facts and History placeholders never go inside a version.
  With no common version (two notes created apart), the lines both have in common stand in for it.
  The `prose_versions` item resolves once the note no longer holds two version headings of the same level in a row (`holdsTwoVersions`), or is gone.
  Both sides are put in an order that does not depend on which Machine merges (`sides.ts`) and nothing depends on the time of the merge, so two Machines merging the same versions write the same note.
  Two notes with the same type and title share a path, so they arrive with no common version and merge as one note.
- **Commits** are authored by the Machine (name, and `<machine id>@machine.attache.invalid`), with the clock's time.
  The message names each changed file and what the change log says happened to it (`created "Orion migration"`, `corrected Status`, `added an event`), or `added`/`edited`/`deleted` for files the change log does not know (hand edits, evidence), and ends with a `Attache-Machine: <name> (<id>)` trailer.
- **Seams** (`replication/seams.ts`, listed in `defaultSeams()`): `mergeRules`, `commitGuards` (run on the staged files before every commit, merge commits included; a refusal stops the commit and the push), `remoteGuards` (run at setup, join and before every push), and `credentials` (`-c` settings and environment for commands that reach the remote, so a token never sits in the remote's address).
  `Replication.onPulled` and `onMergeNotice` let other parts of the service react to merged files and to what the rules want the owner to see.
- **Private repository** (`replication/private-remote.ts`, a `RemoteGuard`): a folder remote passes; a GitHub remote (`replication/github.ts` `githubRepoOf`) passes only when `GET /repos/{owner}/{name}` says private or internal, asked with the GitHub connection's token and API address; any other host is refused, because its privacy cannot be checked.
  A private answer is trusted for five minutes (`VISIBILITY_CHECK_EVERY_MS`, on the Replication clock); a refusal is never cached.
  Public reads as blocked, a rejected token (401, or 404 with a token) as unauthorized, and no answer as offline (`RemoteVerdict`); at setup and join these are 409 `remote_refused`, 502 `remote_unauthorized` and 502 `remote_unreachable`.
- **Repository token** (`replication/github-credentials.ts`, the `GitCredentials`): for a GitHub https remote, git runs with `credential.helper=` (dropping the Machine's own helpers) and then `credential.helper=!<attache> git-credential --state-dir <state> --connection <id>`.
  The helper (`cli/git-credential-command.ts`) reads `conn:<id>:token` from this install's secret store (the state folder reaches it as `--state-dir`, the instance as `ATTACHE_INSTANCE` in the environment) and answers `get` with `x-access-token` and the token; it ignores `store` and `erase`.
  Other remotes use the Machine's own git setup (ssh keys, or nothing for a folder).
- **Machine records** (`replication/machine-records.ts`, `machines.ts`): each Machine writes `machines/<machine id>.json` (`id`, `name`, `standby`, `updatedAt`, `version`, `readsBrainFormat`) at setup, join, the first check after start (so after each Update too) and rename, and any Machine may write `machines/preferred-reader.json` (`machine`, `updatedAt`, `by`).
  `version` is the Attache version the Machine runs and `readsBrainFormat` the newest Brain format it can read (`replication/brain-format.ts`, format 1); records an earlier version wrote have neither, parse all the same, and list the version as unknown (`null`).
  Each Replication check also rewrites this Machine's record once it is a week old (`RECORD_REFRESH_MS`), committed with that check, so `updatedAt` says when the Machine was last heard from (ADR 0008); a record that is current and under a week old is never rewritten, so nothing is committed.
  They are JSON, so search never indexes them, and they replicate like any file.
  `machineRecordRule` settles a record both sides changed: the later `updatedAt` wins, then the larger text, and a record one side deleted is kept from the other.
  `GET /replication/machines` lists them with this Machine first, each Machine's version (this Machine's as it runs now) and its last commit time (`git log --author=<id>@machine.attache.invalid`); `PUT /replication/standby` and `PUT /replication/preferred-reader` change them and refuse with 409 `replication_off` while Replication is off, when the Machine is its own Reader.
  The Reader lease reads this Machine's standby flag and the Preferred Reader straight from these records (`MachineRecords`).
- **The Brain format** (`replication/brain-format.ts`, ADR 0008): `machines/brain-format.json` (`format`, `updatedAt`, `by`) says which format the Brain's replicated files are in; a Brain without it is in format 1.
  A release reads up to one format and writes one (`BrainFormatSupport`, `RELEASE_BRAIN_FORMAT`: reads 1, writes 1; `AppOptions.brainFormat` lets tests play a later release).
  Setup writes the record, and any check writes it when it is missing (a Brain set up before it existed).
  The format rises only when every Machine heard from in the last 30 days (a Machine record whose `updatedAt` is under `ACTIVE_WITHIN_MS` old) records a `readsBrainFormat` at or above the format this Machine writes; a record without `readsBrainFormat` reads format 1.
  Each check decides before its first commit and again after a merge brought other Machines' records, and commits the raised record with that check (`nextBrainFormat`); the format is never lowered.
  `brainFormatRule`, listed before `machineRecordRule`, settles the record when two Machines wrote it: the higher format wins, then the later `updatedAt`.
  A Machine that finds a format above the one it reads, in its data folder or in what it fetched, pauses: the check stops before committing, merging or pushing, still fetches so it hears what the others write, and reports status `paused` with the cause and `ReplicationView.pause` (`reason: "newer_brain_format"`, `brainFormat`, `readsBrainFormat`), stored in the `replication` table's `paused_format`.
  While paused, this Machine's record is not refreshed and `PUT /replication/standby` and `PUT /replication/preferred-reader` refuse with 409 `replication_paused`; saves carry on locally.
  Only the check that discovers the newer format may already have committed local saves before its fetch; nothing of it is pushed.
  A record that cannot be read reads as blocked rather than paused, since an Update would not fix it.
  Once the Machine runs a release that reads the format, its next check goes on as usual.
  `replication.changed` fires when the status or cause changes, so a pause and its end reach the Dashboard and anything that follows the event stream.
- **Fields a later release adds survive.** A Machine that rewrites or merges a replicated file keeps fields and frontmatter keys it does not know (ADR 0008): Machine records (`MachineRecords.unknownFields`), the Brain format record, Inbox records and Proposals parse `loose` at every level they rewrite, and the Inbox table keeps a record's and item's unknown fields in `attention_items.unknown_fields`.
  Notes keep frontmatter through `bumpFrontmatter` and the note merge; files written again whole from fixed frontmatter (the identity record, today's connector snapshot, an archived Harness session) take over the keys of the file they replace (`MemoryStore.keepingUnknownKeys`).
- **The Reader** (`reader/`, `replication/reader-lease.ts`, `replication/lease-ref.ts`): exactly one Machine runs scheduled Source refresh, briefings and with them the Review-date inbox items.
  With Replication off, the Machine is its own Reader and nothing changes.
  With Replication on, the Reader is the holder of the Reader lease, a record (`holder`, `name`, `since`, `renewedAt`, `lastRefreshAt`) kept on the refs `refs/attache/reader-lease/<generation>` in the Brain's repository, never on a branch; the newest generation holds the lease.
  Each write is a commit with an empty tree whose message holds the record, made on top of the previous one, so a generation's ref only moves forward: the push is a compare-and-swap, and a rejected push means another Machine wrote first, so the Machine fetches and decides again.
  A ref that only moves forward keeps every commit, so after 144 commits (about a day of heartbeats) the next write moves the lease to a new generation in one `--atomic` push: a last commit on the current generation saying so (a forward move, so a concurrent write still loses the race), the first commit of the next generation (a commit with no parent), and the deletion of the generation before the current one.
  At most two generations exist, so the lease's history stays bounded; no push is ever forced, and the only deletion Replication pushes is a retired lease generation (`assertNoRewrite`).
  The heartbeat adds no commit to the Brain's history, never touches the data folder and is not cloned with the Brain; every fetch brings the remote's `refs/attache/*` to `refs/remotes/origin/attache/*` and drops the generations the remote no longer has (`--prune`).
  After each check that leaves the Machine up to date, and at setup, `leaseToWrite` (`reader/lease.ts`) decides: the holder renews every 10 minutes and at once when its name or last Source refresh changed; the Preferred Reader takes the lease whenever it does not hold it, so it takes the role back when it returns; a standby Machine takes a lease that lapsed, or that nobody holds yet, if it has a source connected besides the data folder (the standby flag from its record in the Brain, the sources from `App`, `ReplicationDeps.sourcesConnected`); a lease nobody holds is also taken by the Machine that set up Replication (the author of the Brain's first commit, `BrainRepo.foundedBy`) unless the owner chose another Preferred Reader, which is how the first Machine takes it at setup; otherwise the lease is left alone, so a Machine that is not marked standby, or has no source connected, never takes it.
  A lease not renewed for 30 minutes has lapsed: its holder stops reading on a schedule (`Scheduler.enqueue` returns `LATER`, which keeps the schedule due) until it renews, then catches up once.
  A Machine that lost the lease hears so at its next check, so around a handover two Machines may both refresh for up to a minute: inbox items are files keyed by item (`review/inbox/`), so both Machines' writes meet as one file and the inbox merge rule keeps one, and deliverables such as briefings carry the Machine in their file name (`deliverableName`), so two briefings never collide.
  The scheduler enqueues scheduled `source-refresh` and `briefing` jobs only on the Reader (`app.reader.role()`), and the first Source refresh after setup only when the Machine is the Reader, so a Machine that joins reads nothing on its own.
  A Source refresh the owner starts by hand runs on the Machine they are on.
  A briefing's deliverable carries the briefing itself in its frontmatter (`briefing`, `attention/replicated-briefing.ts`), so every Machine's Dashboard shows the newest briefing it has, its own or the Reader's (`latestBriefing`), checked before it is shown.
  `GET /reader` (and `/status`) returns the Reader as this Machine last heard it, whether it is silent, and `lastRefreshAt`, the last finished Source refresh of every source (an all-sources `sync` job or a briefing), which the holder carries in the lease to the other Machines; `reader.changed` tells the Dashboard.
- **Credential scan** (`replication/credential-scan.ts`, the first commit guard): scans each staged file and its name with `findSecrets` from `core/redaction.ts`, the module that also holds `redact`, so the scan and redaction share one pattern list and the runtime secrets registered with `registerSecret`.
  Only new credentials count: a match that also appears in the file's version at `HEAD` (and at `MERGE_HEAD` during a merge, `StagedFile.committed()`) is in the shared history already and does not block.
  A finding refuses with status blocked and a cause naming each file and line and what the credential looks like, never its text.
- **Blocked and unauthorized in the inbox** (`replication/blocked-inbox.ts` `syncReplicationItems`): whenever the status changes, `App` keeps one Inbox item, source `replication`, fingerprinted by the cause, open while the status is blocked (key `replication:blocked`) or unauthorized (key `replication:unauthorized`, asking the owner to reconnect GitHub when the remote is GitHub over https) and resolved when it is neither.
  It is this Machine's own item.
- **Review state** is what waits for the owner's decision: Proposals (`review/proposals/`) and the inbox (`review/inbox/`).
  It lives in the Brain's top-level `review/` folder so it replicates, and recall never reads it: the files are JSON, and the indexer skips that folder of the data folder (`memory/indexer.ts`); the layout is in `review-state/files.ts`.
  Each item is one file of one-line JSON, so a change both Machines made to it is always a conflict that reaches a merge rule rather than a textual merge of JSON.
  Decisions are only ever added, each with its time (from the `Clock`) and Machine; the latest one stands, a tie broken by Machine id (`review-state/decisions.ts`).
  The Proposal merge rule (`memory/proposal-merge.ts`) keeps every decision from both sides.
  Approving writes the change on the Machine where the owner clicked, and the note reaches the others like any change, so a Proposal is applied once.
  When an approval made on one Machine and a later rejection made on another meet, the rejection stands and the approving Machine undoes what it wrote, as one-click revert would (`memory/proposal-undo.ts`); events stay, because History only grows.
  The inbox's own rule is `attention/inbox-merge.ts` (see the attention engine below).
- **Time** comes from a `Clock` (`replication/clock.ts`): the system clock in the service, a hand-moved clock in tests.
  `MemoryStore` dates facts, History lines and files by the same clock (`MemoryStoreOptions.now`, `MemoryStore.today()`).
- **Git** is the Machine's own: `ATTACHE_GIT_BIN`, else the first `git` in the platform's usual tool folders (`platform/locations.ts` `toolCandidates`), else the PATH.
  It runs with hooks, signing and the `ext` transport switched off, `LC_ALL=C` and no terminal prompts, whatever the owner's own git config says.

## Memory model

Every memory note has frontmatter (`id`, `type`, `title`, `provenance`, `sources`, `created`, `updated`), a `## Current State` section with one dated entry per subject, optional `## Notes`, and an append-only `## History`.
A correction replaces the Current State entry and appends the superseded value, its date, source and the reason to History.

An entry may carry a Review date after its own date: `- **Status** (2026-11-10, review 2026-11-13): value — source: …`.
The parser (`memory/markdown.ts`) also reads hand edits that vary the spacing, write `Review` or add a colon after it; the writer always writes the form above.
A save or Proposal sets it per fact (`review`, `YYYY-MM-DD`, checked in `memory/save-items.ts` to be after today, the new entry's date).
A correction writes only the Review date it is given, so a date set for the old value never follows the new one; the superseded History line keeps the old Review date.
Days are UTC calendar days, the same days facts are dated with (`memory/review-date.ts`).
Past its Review date a fact stays in the Brain and is shown as unverified: search hits (`review`, `unverified`), the document view's `state` entries, MCP `search` and `read`, the terminal search, the session context files and the Dashboard all mark it, computed when they are read.
This is the state-versus-event rule from the old vault's 2026-08-13 repair, enforced by the writer rather than by instructions.

Write policy (deterministic, in `memory/policy.ts`):
- Only the service writes.
  A Harness submits saves through the MCP server or `attache save`; the Dashboard only decides on Proposals and reverts recent saves (ADR 0003), so the service has no capture, note creation, correction or note-body endpoint.
- `memory/self.md` (identity) and authorization records (connection write permissions, stored in the database) change only through explicit user-authenticated settings endpoints; model output, imports and connector data can never write them.
- Model output writes memory only through Consolidation (ADR 0004).
  With its switch on, the default, Consolidation writes what it finds as actor `consolidation` after the same screening a save passes; that actor may write `memory/` only, never the identity record, and every change it makes is marked in the change log as written without review.
  Other suggested memory changes, and Consolidation's with its switch off, are stored as Proposals that the user applies or rejects.
  A Proposal holds one whole save item (see below), so one click applies a new note with several facts, or several facts and events on one note.
- Writes are atomic (temp file + rename) under a per-path in-process lock; one service process owns the folder.
  A writer lock with the owner's pid and instance, kept in the per-user locks folder outside the data folder, refuses a second service of another instance while the owner is alive; a lock left by a process that is gone is taken over.
  A `.attache/writer.lock` left inside the data folder by an earlier version is honoured the same way and then removed.
- Paths are resolved and confined to the data folder; symlinks out of it are refused.

## Retrieval

Chunks are pieces of Markdown sections with exact line ranges (`memory/chunker.ts`).
Every entry under `## Current State` is its own chunk, cited at its own line, so a question retrieves the one fact that answers it however long the note is.
A fact's source and Review date stay in the cited text but are left out of the search index, so a query never matches a fact because of the file it was imported from or the day it is due for review; the fact's subject is indexed with the heading.
Other sections are cut into pieces of about 1,200 characters after a blank line or before a top-level list item, and never grow past 2,400 characters, so long lists and transcripts without blank lines still give narrow citations.
A single line longer than that stays whole, because a citation is a range of whole lines.
Each chunk is labelled `state`, `history` or `body`; History chunks are down-weighted and presented to the model as superseded.
Queries are tokenised and every term is quoted before FTS5 `MATCH`, blocking operator injection.
Ranking uses BM25 with column weights (title 6, heading 3, text 1), fused by reciprocal rank with a prefix-match list (`k = 60`), then adjusted: curated memory above imports, imports above evidence, current state above history.
No document takes more than half of the results while other documents still have hits, so a long note that matches by title does not crowd out its evidence.
A change to how files are chunked ships with a migration that clears every file's stored fingerprint, so the next scan re-chunks the data folder and imported folders while the old chunks stay searchable.
The index is updated synchronously on every service write, fixing an earlier release's unscheduled indexer (four weeks stale when inspected).
Edits made to the data folder outside the service (Obsidian, an editor, a Harness) are picked up by a file watcher over the whole folder (`memory/watcher.ts`, through `platform/folder-watch.ts`): events are debounced (300 ms, at most 2 s for a continuous burst), then each changed Markdown path is re-indexed or removed on its own.
Folder creates, moves and deletes, a file taking a folder's place, watcher failures and a catch-up just after the watcher starts trigger an incremental rescan, and a rescan also runs every five minutes for events the OS dropped.
The watcher applies the same rules as the full scan: hidden and tool folders, non-Markdown files, files over 2 MB and symbolic links (the file or any parent folder) are never indexed.
If the data folder itself goes missing, the rescan is skipped so an unmounted drive does not empty the index.
Imported vaults are not watched; they are rescanned on each Source refresh of their connection.

Meaning-based search (`meaning/`) runs a small multilingual sentence-embedding model on the Machine: multilingual-e5-small with 8-bit weights, 384 dimensions, pinned to one Hugging Face revision (`meaning/model.ts`).
It runs on ONNX Runtime's WebAssembly build (`onnxruntime-web`) with the pure-JavaScript Hugging Face tokenizer (`@huggingface/tokenizers`), so one set of files works on macOS, Linux and Windows with no native module to build or ship per platform; the release carries `ort-wasm-simd-threaded.wasm` and `.mjs` next to the service bundle.
The model is not in the release: the owner starts its download from the Dashboard (`POST /memory/meaning/download`), each file is checked against its size and SHA-256, and the folder `<state>/models/<model id>/` appears only once every file has passed.
After that it runs offline.
`ATTACHE_MEANING_MODEL` names a JSON model description to use instead (a mirror, or the fixture model in tests).
Each chunk stores the text its vector is made from (title, heading and the same text keyword search matches) and that text's SHA-256.
Vectors live in `chunk_vectors`, keyed by model id and text hash, in the Machine's own SQLite index: they never enter the Brain and do not replicate, and re-chunking a file keeps the vectors of text that did not change.
A background builder (`meaning/builder.ts`) embeds chunks without a vector in batches of eight whenever the indexer reports a change, then drops vectors no chunk uses.
`GET /memory/meaning` and every search response carry the state (`missing`, `downloading`, `failed`, `building`, `ready`), the download progress, how many chunks have vectors and `ranking`, how search ranks results now.
`ranking` is `meaning` in `ready` and `keywords` in every other state.
Search fuses ranked lists with reciprocal rank fusion (`memory/search.ts`): two keyword lists from SQLite FTS5 (every term present, and any term as a prefix) and, once `ranking` is `meaning`, a third list of the chunks nearest the question by meaning.
`MeaningSearch.nearest` embeds the question with the model's query prefix and compares it with every chunk's vector (`meaning/nearest.ts`; vectors are unit length, so the dot product is the cosine), keeping chunks that point toward the question.
In any other state it returns no list, so search answers on keywords alone; a model that fails while embedding a question is reported as `failed` and that search answers on keywords.
The fused score is weighted as before (area, section, status and the share of query terms present), so exact keyword matches keep their place.
A hit's snippet is the plain words of its chunk (`memory/plain-text.ts`, which parses the chunk with markdown-it set up as the Dashboard renders notes, plus the wiki links and footnotes an imported vault writes, `memory/vault-syntax.ts`): no backticks or code fences, quote, list, emphasis or link syntax, with code and escaped characters kept as written, cut between words around the first matched term and marked `…` where it was cut.
The hit's `text` keeps the Markdown as written.
`searchByMeaning` is what the HTTP search route (and through it the MCP `search` tool and the Dashboard), `attache search` and recall evaluation call; `attache search` loads the model itself when the vectors are ready, and never downloads it or builds vectors.
Other internal searches (briefings, audits, Consolidation, research jobs) stay on keywords.
The MCP `search` tool, `attache search` (first line, or stderr with `--json`) and the Dashboard's search say results match keywords only, and why, for as long as `ranking` is `keywords` (`meaning/note.ts`).

Search quality is measured by recall evaluation (`memory/recall-evaluation.ts`, `POST /memory/recall-evaluation`, `attache evaluate-recall`).
A question set names, per question, the note and the subject of the current fact expected to answer it.
Each question runs through the same search a Harness gets (8 results, raw archives excluded), and a result counts only when it is that fact's own chunk.
The report gives how often the expected fact is first and how often it is in the first three, how search ranked (`ranking`), every question not answered first with the first three results, and, unscored, every question whose note or fact is not in the Brain.
The owner's set lives in the Brain at `evaluation/recall-questions.json`, as JSON so the indexer never reads it; a synthetic Brain with its own set lives in `apps/service/test/fixtures/recall-brain/` and runs with the test suite.

Attache holds no conversation of its own (ADR 0003): a Harness asks the Brain through search and read.
Research findings and drafts still use the model: the service retrieves first, numbers the evidence `[S1]..[Sn]`, sends it to the model as quoted data with an instruction that documents are untrusted, and maps cited markers back to exact file and line ranges.
Without a model, research lists the retrieved evidence instead of written findings: each hit's title and snippet, with the snippet escaped so it renders as the same plain text, URLs still links where that is safe.
Installs from before ADR 0003 drop their stored conversations and messages when a newer release first starts; the chat archives already written to `evidence/conversations/` stay in the Brain, out of recall.

## Connections and transports

Every connection is an adapter with setup, test, Source refresh, Disable and coverage accounting (`apps/service/src/connectors/`).
Remote sources use one of three transports.

- **GitHub** uses its REST API with a token or the GitHub CLI login.
- **Jira and Confluence** use the Atlassian Rovo MCP server in one of two ways behind one interface (`atlassian-backend.ts`), so Source refresh, attention, coverage and recovery rules are shared.
  By default they go through the user's claude.ai Atlassian Rovo connector (Rovo MCP v1 tools) on the same gated Claude Code path as Slack, Gmail and Calendar, described below.
  It is the default because some Atlassian organizations refuse other OAuth clients and API tokens while allowing claude.ai.
  The v1 views differ: Jira pages with `pageInfo.endCursor` passed back as `nextPageToken`; Confluence search returns no total and no next page, so a full page is reported `partial`; Confluence dates come back relative ("about 2 hours ago") and are kept out of timestamps and fingerprints.
  Alternatively, where the organization allows other clients, Attache connects directly to `https://mcp.atlassian.com/v2/mcp` through a small Streamable HTTP MCP client (`mcp-http.ts`, `atlassian.ts`).
  Attache calls the MCP tools directly, with no model in the loop: `searchJiraIssuesUsingJql`, `addOrEditJiraIssueComment`, `searchConfluence`, and `listJiraIssueComments`, `listConfluenceComments` and `createConfluenceComment` through `executeRead`/`executeWrite`.
  Sign-in is OAuth 2.1: protected-resource metadata (RFC 9728), then authorization-server metadata (RFC 8414), dynamic client registration for the loopback redirect (RFC 7591), PKCE S256 and a resource indicator (RFC 8707), with refresh tokens stored in the Keychain.
  An Atlassian API token created for the MCP server (app `mcp-v2`) is the alternative when the organization allows API tokens; a classic unscoped token is rejected with an explanation.
  The configured site is resolved to its cloud id on test, so a credential for the wrong site reports `denied` instead of reading nothing.
- **Slack, Gmail and Google Calendar** use the claude.ai connectors the user already has in their claude.ai workspace (for an organization account, the organization's connectors).
  Those connectors are only reachable through a claude.ai-authenticated Claude Code session, so `claude/session.ts` runs the user's own `claude` CLI headless with no built-in tools, hooks off, CLAUDE.md files off and a small model (`claude-haiku-4-5`).
  The model only relays calls.
  Every permission check is routed to Attache over the stream-json control protocol (`--permission-prompt-tool stdio`); Attache allows a call only when the tool and its arguments equal a planned call, once, and only for a server whose source is `claudeai`.
  Anything else is denied before it runs; in a write session any deviation fails the action.
  Results are read from the raw `tool_result` blocks in the event stream, never from the model's summary, and parsed by strict readers (`slack-format.ts`, `parseThreadPage`, `parseEventPage`) that count unreadable rows as partial coverage.
  A session refuses to start if the user's or the organization's managed Claude Code settings auto-approve that connector's tools, because such a rule would bypass the argument check.
  If a tool result still arrives for a call Attache was never asked about (a managed hook, for example), the session is stopped, its results are discarded and the connection reports `denied`.
  A long result that Claude Code spills to a file (a 50-issue Jira page is about 80 KB) is read back only from Claude Code's exact `<persisted-output>` wrapper, only from a file inside the project directory of Attache's own connector session, and the file is deleted once read, so a path planted in a message is never followed and connector data does not accumulate under `~/.claude`.
  A read session that stalls is started once more; a write session never is.
  The session waits for MCP connections (`MCP_CONNECTION_NONBLOCKING=false`); one that still meets a `pending` connector stops at init, before any call, and is started again.
  Independent pages (for example the first page of DMs and of mentions) share one session, so a Slack Source refresh is a few sessions rather than one per call.

Authorization for the claude.ai connectors lives in claude.ai, so Attache stores no credential for them; Disabling stops Attache's requests and deletes its retained data on request, while the connector itself stays connected in claude.ai.
Write actions keep the approval rules below.
The claude.ai connector tools and the Jira MCP comment tool cannot attach hidden metadata, so recovery after an interrupted write recognises an earlier attempt by content: it must be the user's own (the account id is required, never guessed), created after the pending attempt started (the outbox records that time and passes it as `since`, with two minutes of clock-skew allowance), with the same text once formatting is ignored (Markdown, ADF, Slack mrkdwn and storage HTML render links and emphasis differently).
Gmail drafts must also be in the same thread; Confluence comments still carry a hidden effect marker in storage format.
If that lookup itself fails, the outbox raises `EffectCheckError`: the action becomes `unknown` and the effect stays pending, so a failed check is never mistaken for "not sent".
Atlassian token refreshes are single-flight per connection because Atlassian rotates refresh tokens; a refresh rejected by Atlassian means "sign in again", while a network failure stays `offline`.
A sign-in that is started but not finished never replaces the stored OAuth client: a newly registered client is saved only when the callback succeeds.
Connections created before these transports lose their old credentials once at startup and show `needs auth` with an explanation, keeping their scopes, channels, site and write authority.
A `needs auth` connection without browser sign-in shows a Reconnect action on its card: for methods with secret fields it reopens the credential form, otherwise it re-runs the connection test; each auth method can carry `reconnectHelp`, the text telling the user what to fix outside Attache first.
A test that succeeds on a connection that was `needs auth` or `error` queues a Source refresh of that connection, so its coverage no longer shows the failed run.
Source refreshes of one connection may overlap (the first refresh after setup and one started by hand); `ConnectionManager.refresh` numbers them as they start and drops a read that started before the newest one already stored (its run is recorded with outcome `superseded`), so a slow earlier refresh never reopens what a later read resolved.
Before its first connector session the runner lists Claude Code's MCP servers with a session that disallows every MCP tool and stops at init, then hides every other server, because with tool search off their tool definitions would otherwise be inlined and can overflow the model's context; a session that still overflows lists again and is retried once.

## Attention and briefings

The attention engine follows these rules:
- Item identity (`key`) is separate from change detection (`fingerprint`).
  Fingerprints are SHA-256 over length-prefixed parts, truncated to 16 hex characters, so a separator cannot forge a collision.
- Keys use the work item identity (for example `jira:ISSUE-1`), and the category (due, overdue) goes in the fingerprint, fixing the due→overdue key churn.
- Transport-dependent fields (`updated_at`) are not fingerprint parts.
- An item is resolved only if its source was fully covered in this and the previous run.
- A dismissal records the fingerprint it applied to.
  Unchanged items stay dismissed; a changed fingerprint reopens the item with the reason.
- Snooze stores an absolute time and reopens only after it passes.
  At least every 30 seconds on the service's clock, housekeeping works the state of each snoozed item whose time has passed out again from its record (`Inbox.wake`, `passTime` in `attention/engine.ts`), so a snooze that ended reopens the item without a new write.
- Meeting prep (`connectors/gcal.ts`) is raised from 24 hours before a meeting with other people until its scheduled end, and the item carries the meeting (`AttentionItemView.meeting`: start and end as instants, the Meet or other conference link, the other attendees), kept in the item's record so it replicates.
  Its state is resolved once the end has passed, worked out from the record like a snooze (`meetingOver` in `attention/inbox-record.ts`), so every Machine agrees without a write; housekeeping also runs at the next meeting's end (`Inbox.nextMeetingEnd`), and at once for an end that passed before a run resolved its item (a timer can run a moment before the wall clock reaches its time), so the item leaves the Inbox at that moment, and a later Source refresh resolves it in the record when the event drops out of the listing.
  Connectors read "now" from the service's clock (`ManagerDeps.now`), the same clock the Inbox uses.
  The item keeps its report time (`updatedAt`): a snooze ending is not news from the source, and a bumped time would let this Machine's stale copy beat another Machine's newer report in the merge.
- `start` is a decision like the others: it keeps the item open and records when it was started (`startedAt`), `reopen` clears it, and Done, Dismiss, a resolved source or changed evidence end it.
- A briefing (`attention/briefing.ts`) takes its lead and up to five top picks from the open Inbox in the Inbox's order, by fixed rules, and flags the new and changed items for update texts.
  An away summary leaves unchanged items out of its sections, except the lead and the top picks, whose entries are the snapshot the briefing page lists and the words the model writes the lead from.
  A model writes only words (`attention/briefing-words.ts`): `askForBriefingWords` asks for the summary, the lead's headline and explanation and update texts for at most `BRIEFING_MODEL_UPDATES` flagged items, one JSON object per line, with a token limit sized from what it asks, so an answer cut short loses only its last lines.
  `applyModelWords` strips a code fence, checks each line and each part on its own with the contract's schemas (`BriefingModelWords`, `BriefingUpdate`), keeps the lead on the item the rules chose, drops an update for an item that was not flagged, and keeps the item's own title and summary for every part that fails or is missing, logging what failed on the job.
  `GET /briefings` answers the newest Daily Briefing and the newest away summary or briefing asked for, own or replicated.
- `GET /agenda?from=&to=` (`attention/agenda.ts`, contract `AgendaQuery` and `AgendaResponse`) returns the calendar events that overlap a range from what the calendar Connection last read, without those the owner declined, with that read's time and coverage, for Your day.
  The calendar Connection reads from the start of today in every zone (`core/day.ts` `startOfTodayEverywhere`: now less `LONGEST_DAY_MS`, 25 hours, since every zone's current day began less than one local day ago; the agenda route widens all-day events by the module's `WIDEST_ZONE_OFFSET_MS`) to 48 hours ahead, so a complete read keeps today's ended meetings and Your day can say "Nothing more today"; an event that is over raises nothing.
- The inbox replicates (`attention/inbox.ts`, `App.inbox`).
  Every item is also a file in the Brain, `review/inbox/<key slug>-<key hash>.json`, holding what its source said (with `resolvedAt` once the source stopped reporting it and the Machine that ran Source refresh) and the owner's latest decision (with its time and Machine).
  The state is never stored in the file: each Machine works it out the same way (`deriveState` in `attention/inbox-record.ts`): resolved by its source or once its meeting has ended, else snoozed while the snooze runs, else dismissed or done while the evidence is what the owner decided on, else open.
  The database row is this Machine's copy, plus links that stay local (drafts, briefings).
  Items about one Machine alone (`localSources`, today its own "Replication is blocked" item) never enter the Brain.
  Files are one line of JSON, so a file both Machines changed always reaches the merge rule (`attention/inbox-merge.ts`): the newer report of the item and the later decision win, a tie is broken by Machine id, and a deletion wins.
  Files another Machine changed are taken in from `Replication.onPulled`; opening a data folder brings the database and the files together, files first, and writes out items that only the database had (the carry-over from before the inbox replicated).
  When the service starts, whether or not a data folder opens, it works every item's state out again from its record (`Inbox.load`, `rederiveStates` in `attention/engine.ts`), so the state column is only a copy and a state an earlier release left in the database never outlives the move to a newer release.
  The indexer skips `review/` at the top of the data folder (`review-state/files.ts` holds the layout shared with Proposals).
- Coverage per source per run is one of `complete`, `partial` (pagination stopped, rate limit, page cap), `denied` (scope/403), `unauthorized` (401/expired), `offline` (network), `error`, `not_configured`.
  A zero from a partial source is never shown as "nothing to do".
- Facts past their Review date (`attention/fact-reviews.ts`) are read from the Brain's `memory/` notes by the data folder's Source refresh (`ConnectionManager.syncVault`, builtin connection only), one item per fact, kind `fact-review`, key `fact-review:<note path>:<subject>`, fingerprint over the value, the fact's date and its Review date.
  A correction or a later Review date drops the fact from the next refresh, which resolves its item.
  They are raised only on the Reader (`ManagerDeps.isReader`): a data-folder refresh the owner starts by hand on another Machine still observes every such fact, so it leaves the Reader's items as they are, but raises none of its own.
- Gmail read state is derived from `labelIds`, never inferred.
  A thread whose last message is from the user is never awaiting reply.
  All-day events are detected from their midnight-to-midnight shape.
  Calendar notification mails are excluded from pending replies.

## Jobs, scheduler and recovery

- A job row is committed before the API acknowledges it.
  Every progress step writes an ordered `job_events` row; clients reconnect with `Last-Event-ID` and receive every missed event plus retained results.
- The worker leases a job with an expiry.
  On service start, jobs with an expired lease are recovered from their last checkpoint.
- External side effects go through an outbox keyed by an idempotency key.
  The key is recorded as `pending` before the call and `done` with the verified result after it.
  A recovered job that finds `done` reuses the result; one that finds `pending` verifies with the remote before retrying, so a restart cannot double-post.
- Cancellation sets `cancel_requested_at`.
  The response and the job record state whether the work stopped (`stopped`) or the request arrived after completion (`too_late`).
- The scheduler lives in the service.
  Schedules are rows with `next_run_at`.
  A tick every 15 s runs due schedules; if the gap between ticks exceeds twice the interval (the Machine slept), missed runs are coalesced into one catch-up run instead of replaying every missed interval.
  Offline sources simply record `offline` coverage and are retried next tick.
- Browser tabs and service workers never schedule work.

## Drafts, approvals and execution

- A draft is an action record: kind, connection, target, payload, `payload_hash` (SHA-256 of canonical JSON), `version`, context/evidence, `expires_at`.
- Editing a draft increments `version` and changes the hash, invalidating any approval.
  The new text replaces the old one: `action_events` keeps each version's number and hash, not its words.
- A rejected draft is locked: editing it is refused (`not_editable`), and only `POST /actions/:id/restore` with the version it starts from brings it back, as `draft` at the next version with the same text and a `restored` event, until the draft's own expiry.
  Restore is refused (`superseded`) while another draft for the same Inbox item is open or after the item's last draft was sent, and (`delivery_unconfirmed`) while the item's last draft has a send of unknown outcome, so its reply never goes out twice.
  Otherwise it moves the item's link back to the restored draft.
- Approval creates `{actionId, version, payloadHash, nonce, expiresAt, approvedBy}`.
  It lasts 15 minutes (`APPROVAL_TTL_MS`), never past the draft's own expiry.
- When an approval ends unused, the draft goes back to `draft` with the approval cleared, an `approval_expired` event is recorded and `actions.changed` is emitted, so the owner can approve it again.
  Housekeeping wakes when the next approval ends (and at least every 30 seconds), and every route that reads, approves or executes drafts settles ended approvals and expired drafts first (`App.settleActions`), so no answer shows an approval past its end.
  Executing with the ended approval's nonce is refused as `approval_expired`.
- Execution requires the approval; the server rechecks, immediately before calling the adapter: action status, version, hash, nonce unused (atomically consumed), approval and action expiry, feature enabled, connection connected and the write action authorized for that connection.
- Status becomes `succeeded` only when the adapter returns a verified remote id (followed by a read-back where the API allows).
  Otherwise `failed` with the error, or `unknown` if the call timed out after sending.
- Receipts and every attempt are stored in `action_events`.
- Revoking an approval, disabling write authority or Disabling a Connection prevents later execution.
- Expiry uses 48 business hours (weekends skipped); refreshing a draft keeps its original `created`.
- A draft prepared for an Inbox item records the item's key (`attention_item_key`), and the item's row links to the newest one (`attention_items.action_id`).
  The link is never cleared: reading items joins it to `actions` (`SELECT_VIEW` in `attention/engine.ts`), so `AttentionItemView` carries `actionId` and the draft's current `actionStatus`, and `GET /attention` first marks drafts past their deadline expired, as `GET /actions` does.
  A draft in `draft`, `approved`, `revoked` or `executing` (`OPEN_ACTION_STATUSES` in the contracts) still stands for the item, and the Dashboard offers View draft; a finished one does not, so it offers Prepare draft, and `createDraft` makes a new draft and moves the link to it.
  Drafts and the link stay on the Machine (see Attention and briefings), so another Machine does not see them.

## Security

- The service binds `127.0.0.1` only.
  The `Host` header must be the loopback address with the service port (prevents DNS rebinding).
- Clients pair: the installer or Settings issues a short-lived single-use pairing code; exchanging it yields a random token (stored hashed).
  The browser gets an `HttpOnly; SameSite=Strict` cookie; the CLI keeps its token in a private file (0600, or an owner-only access-control list on Windows) in the service state directory.
- `Origin`, when present, must be the service origin.
  State-changing requests also require `X-Attache-Client: 1`, which cross-site forms cannot send.
- Logs, evidence and API responses pass through redaction of known secret values and token patterns.
- Imported and connector content is data: it is rendered with raw HTML disabled, and it is quoted inside the model prompt with an instruction not to follow embedded instructions.
  The model Attache calls has no tools, so injected text cannot trigger actions.
- The connector sessions that reach claude.ai connectors do see external content in tool results, which is why each call is approved by argument equality before it runs and a write session fails on any deviation (see Connections and transports).

### Signed releases

Every release carries a manifest of its archives and an Ed25519 signature over the manifest's exact bytes (ADR 0007); the release build writes both (`scripts/release-seal.mjs`), and `docs/developer-guide.md` describes the files.
`apps/service/src/release/` holds the one copy of the format and the checks that the signing tool, the release build and the installed service share: `manifest.ts` (fields, the channel a version belongs to, file names), `signature.ts` (key pairs, signing, verifying with Node's built-in crypto), `verify-release.ts` (a release folder against its manifest: the signature first, then each artifact's size and SHA-256) and `trusted-keys.ts`.
The keys a Machine trusts are the public key built into the bundle, a constant the release build defines so nothing at run time replaces it, plus each next key that a manifest signed by a trusted key named, kept in `release-keys.json` in the state folder.
`attache verify-release` is the internal command an installer runs with the installed version before it changes anything; it never opens the database, so an older version can check a newer release.
`platform/release-target.ts` names this computer's release target, the same mapping the release build uses.
Releases are published only by `.github/workflows/release.yml` from a version tag: its gate (`scripts/release-gate.mjs`) checks the tag, `CHANGELOG.md` and a full CI run of the commit first, the build job builds every target without the signing key, and only the seal job, in the protected `release` environment, reads the key; `docs/developer-guide.md` ("Publishing a release") gives the steps.

### Updates

The Updater (`apps/service/src/updates/updater.ts`, `App.updater`) owns the whole lifecycle of an Update behind four calls: `view()` (the `UpdatesView` in `packages/contracts/src/updates.ts`), `check()` (Check now), `setSettings()` and, to come, `install()`.
The HTTP API is `GET /updates`, `PUT /updates/settings` and `POST /updates/check` (`http/routes-updates.ts`), and every change fires `updates.changed` on the event stream.
A check lists the repository's GitHub releases without signing in (`updates/release-feed.ts`; `ATTACHE_RELEASE_FEED_URL` points it elsewhere, for tests), and `updates/channel.ts` keeps the versions in the Machine's Update channel that are newer than the one it runs and not marked bad here, newest first.
`updates/find-update.ts` downloads the newest one's manifest and signature and checks them (`verifySignedManifest`) before believing anything in them; a refused release is skipped, and when every newer release is refused the check fails with the reason instead of reporting the Machine up to date.
The Update channel is the Machine's configuration (`config.updates`, Stable by default), and the versions that failed on this Machine are kept in `<state>/updates/bad-versions.json`.
Only a release install updates itself (`updates/release-install.ts`: the service script runs from `<prefix>/app/<version>/` with `<prefix>/current` beside it); a source checkout, or a build without a release key, shows Updates as unavailable and makes no request.
`attache update --check` (`cli/update-commands.ts`) asks the running service to check without acting on what it finds.

## Harness sessions

Claude Code, Codex, Antigravity and Claude Desktop are connections (`connectors/agent.ts`, `agents/integrations.ts`).
Connecting one with hooks adds them to that Harness's settings file, through an editor that only adds, replaces or removes entries whose command names `attache-agent-hook` and this install's `--state-dir`, so other tools' hooks and other Attache instances are never touched (`agents/hooks-config.ts`, `agents/install.ts`).
The file is backed up before every write, and a file Attache cannot parse is refused rather than overwritten.
Hook commands go through the installer's `current` symlink, so installing a newer release does not break them.

The hook (`agents/attache-agent-hook.ts`, bundled as `attache-agent-hook.mjs`) does no network calls and never waits for the service: SessionEnd budgets are 1.5 s (Claude Code) and 3 s (Codex).
On session end, compaction, or (Antigravity) a fully idle turn, it clones the transcript into `state/agents/spool/` and writes a small record last.
The service ingests the spool on change, every minute and at start, so a session ends up in the data folder even if Attache was stopped when it ended.
A Harness writes its transcript once a conversation starts, so a session end or compaction whose named transcript does not exist had no conversation, like the session `claude mcp list` ends, and is dropped with a debug line (`AgentSessions.hadNoConversation`).
A missing transcript is still logged as a warning after a finished turn, or when Attache saved part of that session earlier, because then the transcript was lost.
Ingest parses each agent's transcript format down to user and assistant text, dropping tool calls, tool output, thinking, injected reminders and developer-role context (where Attache's own memory block lands in Codex), archives it, and queues a `session-distill` job.
That job asks the model for durable decisions and lessons, appends one entry per session (or per continuation) to the day's session log, and records how many turns are summarised so a compaction followed by the end adds only new turns.
An entry for a session that ran in a git repository carries a `Repository: <host/owner/name>` line, read from the folder's git config when the job runs, which ties it to the project that lists that repository.
Antigravity reports every turn, so its summary waits until the conversation has been quiet for 15 minutes.

### Consolidation

When a summary finds something durable, `session-distill` queues a `session-consolidate` job for the same turns (`consolidation/consolidate.ts`, input `{ agent, sessionId, from, to, topics }`, where `topics` are the summary's bullets).
It runs on the Machine whose hook spooled the session; a Machine that receives the transcript and session log through Replication never ingests them, so it never consolidates them.
Without a model the summary does not run, so nothing is queued and the session log entry says the session was not consolidated; a job that finds the model gone returns `{ skipped: "no model" }` with that message.
The job reads the redacted turns from the summariser's cache (`AgentSessions.sessionPart`) and hands them to the shared pipeline (`consolidation/pipeline.ts` `consolidate`), which a meeting capture also goes through: it finds related notes by searching the Brain's `memory/` notes for each topic and the session title (`consolidation/related.ts`), and asks the model, once per 100 000-character part, for every change worth keeping as JSON in the save item shape, each with a reason and a passage quoted from the session (`consolidation/prompt.ts`).
There is no limit on how many changes one session or capture yields; the reply may take up to 8 000 tokens, so a long list fits.
A reply that still reaches the model's token limit (`complete()` in `models/providers.ts` reports it from each provider's stop reason: `max_tokens` or `model_context_window_exceeded` from the Anthropic API and Claude Code's stream, `length` from an OpenAI-compatible endpoint) keeps every entry written out in full before the cut (`consolidation/cut-off.ts`), and the unfinished one is dropped with a problem that names the token limit; any other reply that is not the JSON object asked for is dropped whole.
The reply is untrusted data (`consolidation/reply.ts`, `consolidation/screen.ts`): an entry that is not a valid save item, whose evidence is not quoted from the session, or that fails `checkItems` (the save's validation) is dropped and logged, never repaired.
Screening runs in three steps.
First `checkCandidates` checks each change by itself: a path in the Brain, evidence quoted from what was read, and `checkItemAlone` (`memory/save-items.ts`, every check `checkItems` makes except whether a new note already exists).
For an update, `checkItemAlone` reads whether its note exists and the note's type, so a note the run makes could change a verdict; the run keeps the candidates that failed, with their problems, in the job's checkpoint before anything is written, and a retry reuses them.
Then, in a writing run, one value is chosen per fact among the changes that passed (below), so a change that fails those checks never pushes out one that passes.
Last, `screenCandidates` makes the checks that do: `checkItems` in full, then the repeat checks.
Facts the note already holds with the same value, events already in the note, and parts of pending Proposals are removed; an item with nothing left is dropped.
Values are compared as the owner reads them: case, spacing, emphasis, quotes around the value and a closing full stop do not count as a change, so a fact the session only mentions or repeats is never proposed.
A fact the note holds with a different value is a correction: `app.proposals.proposeItems` records every such fact on the Proposal as `corrections[] { subject, was: { value, date, review }, value }` (`memory/proposal-corrections.ts`), for any Proposal, not only Consolidation's.
The related notes are shown to the model with each fact's date, and the system prompt tells it that a mention is not a correction and that a correction's reason ends up in History beside the old value.
Applying such a Proposal re-reads the note: when a corrected fact no longer holds the recorded old value, Apply is refused with 409 `fact_changed` and the Proposal stays pending.
What is left is written or proposed, as the Consolidation switch says: `Config.consolidation.autoAccept`, this Machine's configuration and never the Brain, on by default (`GET /consolidation`, `PUT /consolidation/auto-accept` in `http/routes-consolidation.ts`, audited as `auto_accept_changed` with id `consolidation`; the Dashboard shows it beside the Harness switches, `views/ConsolidationSwitch.tsx`).
The system prompt tells the model which of the two happens.
On, between `checkCandidates` and `screenCandidates`, `oneValuePerFact` (`consolidation/screen.ts`) keeps one value per fact of a note and one change per new note (type and title): the change from the latest part of the source wins, the first within a part, and each other is dropped with its problem.
On, `consolidation/write.ts` writes each item as its own batch through `checkItems` and `writeItem`, as actor `consolidation` with provenance `consolidated`, so each change shows and reverts on its own in Recent saves.
Its change-log rows have `auto_accepted = 1` (written without review), the source citation, and `harness` and `session_id` for a session or `capture` (the capture's path) for a meeting.
An item that no longer passes `checkItems` when its turn comes, because an earlier one changed the Brain, is dropped.
A correction is written as a save's is: the old value moves to History with the reason.
The model reads a source once per run: its parsed answer, each candidate with the part it came from, and the entries it dropped are kept in the job's checkpoint before anything is written, and a retry works from them without asking the model again, so a model that answers differently the second time cannot write a second value over the first.
The first screening step's verdicts are kept beside them, so a retry refuses what the first attempt refused.
The checkpoint names each batch, with the candidate it writes, before it is written, and each Proposal, with the candidate it records, before it is made (`ProposalMeta.ids`).
After a failed write or a crash mid-run, a retry leaves out the candidates its earlier batches wrote or its earlier Proposals record, neither making them twice nor reporting them as dropped, and counts only its own, not those another job made from the same session meanwhile.
They still take part in choosing one value per fact, so a retry picks the same winners; one that loses that choice, as a Proposal made with the switch off can once it is on, is not reported as dropped either.
Writing and proposing keep their results under separate effect keys (`<key>:write`, `<key>:propose`), so a retry after the switch changed reads its own mode's result.
Off, each item is recorded as a Proposal file with `app.proposals.proposeItems`, `proposedBy: "Consolidation"`, the session as origin, the archived transcript as source (with the line holding the quote, when it fits on one), and the quote as the Proposal's `evidence`.
The job result is `{ written, proposals, dropped }`: `written` counts every batch the run wrote and `proposals` every Proposal it made, in any attempt, whichever way the switch stood in each.
A Harness's auto-accept switch has no say over Consolidation: with Consolidation's switch off, only the owner's Apply applies its Proposals.

#### Meeting captures

A meeting capture is a Markdown file under `evidence/captures/` whose frontmatter `tags` include `meeting` or `meeting-transcript` (`consolidation/capture-text.ts`).
Connector snapshots live under `evidence/connectors/`, so no snapshot is ever a meeting capture, whatever its tags.
`consolidation/arrivals.ts` (`App.captures`) notices captures that arrive on this Machine and records every capture it has seen in two local tables, `capture_watch` (since when a data folder is watched) and `capture_arrivals` (`present`, `pulled` or `arrived`, per data folder and path); neither is part of the Brain.
A data folder the owner adopts (`App.useDataFolder`: setup, a change of folder, or a join) has its captures recorded as `present`, so existing captures are never consolidated; a folder opened at start that was watched before is checked for captures written while the service was stopped.
After that a check runs whenever the file watcher indexes an outside edit and whenever the store writes a file under `evidence/captures/`; each meeting capture not seen before is recorded as `arrived` and queues one `capture-consolidate` job (`consolidation/capture.ts`, input `{ path }`, idempotency key per data folder and path).
Files Replication brings are recorded as `pulled` by the first `onPulled` listener, before any check can see them, so a capture is consolidated only on the Machine where it arrived.
The job belongs to the `capture` feature.
It reads the capture with its frontmatter dropped, the quote markers stripped and secrets redacted, one entry per line of the file, and searches related notes for its title, headings and first points.
It goes through the same pipeline as a session (`consolidate` with subject `"meeting"`): the prompts name a meeting instead (`consolidationSystemPrompt(..., "meeting")`), and the parsing, screening, corrections and `fact_changed` refusal are the same.
A retry after a crash finds the run's writes and Proposals by the batches and Proposals its checkpoint names, as for a session.
Each change's source is `{ kind: "capture", ref: <path>, lines }`, where `lines` is the shortest run of the file's lines that holds the quoted evidence.

At session start the hook prints a session context the service rewrites whenever the Brain changes (`agents/context-files.ts`).
The global context, `state/agents/session-context.md`, is the global index only: identity, the titles of the curated notes per type, and the `attache search` command for deeper recall from the agent's shell.
The command (`agents/search-command.ts`) runs as written in a POSIX shell, Git Bash and cmd.exe; on Windows the context also gives it after PowerShell's call operator `&`, because PowerShell reads a quoted program path as a string.
A project note lists its repositories in its `Repositories` fact (`memory/repositories.ts`); every form of a repository, `owner/name` (GitHub), `host/owner/name`, an SSH or an HTTPS remote, reduces to one key, `host/owner/name` in lower case.
For each project that lists one, the service writes `state/agents/projects/<slug>.md`, the project's context, and then `state/agents/projects/repositories.json`, which maps each key to its file; a repository two projects list goes to the more recently updated one.
A project's context (`agents/context.ts`, read from the Brain by `agents/context-sources.ts`) holds the project's full current state, the decisions and people linked to it, its session-log entries from the latest 14 days of logs, and then the global index.
A decision or person note is linked to a project when either note names the other in its current facts or its prose, by title or by file name, so a wiki link or a Markdown link counts (`memory/note-links.ts`).
A session-log entry belongs to a project when its `Repository:` line names one of the project's repositories; entries from before that line existed belong to no project.
Every context stays within 8 KB (`CONTEXT_BUDGET_BYTES`).
What does not fit is cut in this order: index titles, longest list first, down to a count per type; then the oldest session-log entries; then the facts of the least recently updated linked notes; then those notes.
The project's own facts are never cut, and the context ends with a line that says what was cut.
Every fact shown that is past its Review date carries `(unverified: Review date <day> passed)`.
The hook reads the remotes of the session's folder from the repository's own git config, following a worktree's `gitdir` and `commondir` (`agents/git-remotes.ts`), runs no `git` process, and prints the first matching project's file, or the global one.
A save or a Proposal that sets a project's `Repositories` fact to anything that is not a list of repositories is refused (`memory/save-items.ts`, the validation both share).
Antigravity has no session-start hook, so the same text is written to an always-on rule file in `~/.gemini/config/rules/`.
Hooks skip sessions started with `CLAUDE_INVOKED_BY` set, and Attache's own model calls run with `--setting-sources ""`, so neither recurses.
Turning the feature off disables every connected Harness whose memory or capture is not `none` (`App.harnesses()`): Claude Code, Codex, Antigravity, Pi, OpenCode and Copilot CLI.
On start, `AgentSessions.upgradeHarnesses` re-registers the MCP server of the hook Harnesses and calls `refresh()` on every other connected Harness adapter, so a plugin, extension or hooks file that carries an earlier install's paths is rewritten (with a backup).
`attache-uninstall` runs `attache agent-hooks uninstall` first, which also removes the MCP server.

### Harness adapters

The tested capabilities of each Harness, the executable versions they were verified with and the upstream contracts they rest on are in `docs/harness-support.md`; the real-executable smoke tests share `test/integration/harness-smoke-contract.ts` (detect, preview, apply, current, refresh of a stale file, uninstall).
The Agent sessions feature's required Harness is any of `SESSION_HARNESS_KINDS` (`capabilities/registry.ts`): the hook Harnesses plus Pi, OpenCode and Copilot CLI.

Every Harness Connection goes through one boundary, `HarnessAdapter` (`agents/harness-adapters.ts`, data types in `packages/contracts/src/harness.ts`, ADR 0006): detect, preview, apply, status, refresh and uninstall.
Each adapter reports MCP access, memory (`none`, `runtime-fresh`, `managed-file`) and session capture (`none`, `with-final-event`, `without-final-event`) separately, and whether a running Harness must restart before a change takes effect.
Status is `current`, `stale`, `missing` or `failed`; uninstall reports each part it could not remove with its file.
Pi, OpenCode and Copilot CLI record their installed locations and names in this instance's local state.
Disable revokes their memory and capture before removing their configuration, so a plugin or hook already loaded in a running Harness cannot keep saving.
Attache keeps completed snapshots already in the spool and records each break in capture so a later resume cannot import turns written while the Connection was off.
After a pause, an unrecognised format still appears on the Connection, and Attache discards the raw copy because it could include conversation from the pause.
The command-line uninstaller uses those recorded locations even when its environment differs from the service's.
Claude Code, Codex, Antigravity and Claude Desktop sit behind `legacyHarnessAdapter`, which delegates to `AgentHooks` (`agents/install.ts`), so their installation is unchanged.
The Connection flow is adapter-driven: `connectors/agent.ts` builds each Harness Connection from its adapter (`ConnectorAdapter.harness`).
`GET /connections/:kind/harness-preview` returns every file connecting would create or change, with backups and restart, and refuses (409) a file Attache cannot parse; connecting applies, connecting again is the refresh, `ConnectionStatus.harness` carries the adapter's status, and disabling (`POST /connections/:id/disconnect`) returns the adapter's uninstall result as `harness`, keeping what remains as the Connection's last error.
`ConnectionDefinition.harness` gives the Dashboard each capability and the restart requirement.
An adapter with `manualSetup` (Pi) can be connected even when `detect` finds nothing, since Attache cannot see every folder the Harness installs to.

### Pi

Pi connects through its own extension API (`agents/pi-adapter.ts`), with MCP access, runtime-fresh memory and session capture with a final event.
Attache writes one extension per instance, `<agent dir>/extensions/attache.ts` (`attache-<hash>.ts` for another instance), where the agent dir is `~/.pi/agent` or `PI_CODING_AGENT_DIR`.
Pi loads it on its own and it calls `pi.registerMcpServer` with the same `attache mcp --state-dir <state>` command as every other Harness, `exposure: "direct"`, so the tools are declared to the model; Pi keeps that registration for the session only, so Pi's `mcp.json` and `settings.json` are never written.
They are read only to refuse a setup the registration could not work in: a file that does not parse, `-builtin:mcp` in `settings.json`, or a same-name server in `mcp.json`, which Pi would use instead.
The same extension handles Pi's `context` event, which runs before every model call: it imports this install's hook script, reads the session context the service keeps for the session's folder (`sessionContext`, the same choice of project or global file as the session-start hook), and puts it ahead of the conversation as a custom message of type `attache-memory`, its text wrapped in `<attache-memory>` tags.
Pi does not save what a `context` handler adds, so a resumed or compacted session never carries old memory, and Pi's compaction summaries are written without it; the handler also drops any earlier `attache-memory` message before adding the current one.
Each extension's custom message type includes its server name, so it can replace its own memory without removing another connected Brain's memory.
Transcript parsers strip `<attache-memory>` blocks with the other injected tags, and the Pi parser drops custom messages.
The same extension saves sessions: on `agent_settled` (Pi is done with a prompt; spooled as `turn-end`), `session_before_compact` (`pre-compact`) and `session_shutdown` (`session-end`, or `turn-end` for a `/reload`, which goes on with the same session) it hands the hook script's `spoolSession` a snapshot `{attache: "pi-session", v: 1, header, forkedAt, entries}` of `ctx.sessionManager.getBranch()`.
Pi keeps compacted messages on the branch, so each snapshot holds the branch's whole conversation; Pi runs `session_shutdown` on quitting, Ctrl+C, Ctrl+D, SIGHUP and SIGTERM and awaits the handler, so only a killed or crashed Pi can lose its newest turn.
Sessions without a file (`--no-session`, which Pi's subagent example uses for its subagents) are never spooled.
A clone or fork copies its parent's entries with their ids, so the extension reads the parent file named in `header.parentSession` and sets `forkedAt` to the last copied entry; only what follows is saved under the new session.
`agents/pi-transcript.ts:parsePi` keeps `message` entries with role `user` or `assistant`, text blocks only, drops system, tool results, `!` commands, custom messages and summaries, strips `/skill:name` instructions and injected tags, and gives each turn its entry id; the service joins snapshots by id (`partial` session source), so turns saved from a branch the owner later leaves with `/tree` stay and the new branch's turns follow.
An unknown session version, entry type or message role yields no turns and a `problem` naming the Pi format, which the service logs and puts on the Connection.
The hook script is loaded only when a model call needs memory, so a missing script costs the memory and never the MCP registration.
Memory follows the Agent sessions feature: while it is off the service removes the context files and the extension adds nothing.
The file's first line starts with `// Managed by Attache: ` and its ownership line names its state folder; a file in its place without them is left alone, and a file an earlier version wrote is still recognised and upgraded.
A running Pi needs `/reload` (or a new session) to load a change, so the adapter reports a restart.
`test/integration/pi-smoke.test.ts` runs the real `pi` (skipped where it is not on PATH or in `ATTACHE_PI_EXECUTABLE`) to check that the MCP server is registered and connected, that every model call carries the Brain's current memory after a Brain change, a compaction and a resume while the session file never contains it, that a session with a tool call, a compaction, a quit and a resume is archived as the owner's and Pi's words only, and that MCP, memory and saving are all gone after disabling.
It answers model calls from a local stand-in model the test starts, so it needs no model account.

### OpenCode

OpenCode connects through its own plugin API (`agents/opencode-adapter.ts`), with MCP access, runtime-fresh memory and session capture without a final event.
OpenCode 1 (`opencode-ai`) and OpenCode 2 (`@opencode/cli`) both install an `opencode` command, read the same config folders and have incompatible plugin APIs, so Attache writes one plugin file that carries both entry points: OpenCode 1 (1.18.29 and later) calls its `server()` and runs the `config` hook, which adds this instance's server to the configuration it is about to use; OpenCode 2 reads its `id` and runs `setup(ctx)`, which adds the server with `ctx.mcp.transform` (`codemode: false`, so the tools stay on the native tool list).
Both registrations live in memory only, so the owner's `opencode.json(c)` is never written.
The same file gives every model call the Brain's current memory: OpenCode 1's `experimental.chat.system.transform` and OpenCode 2's `context` session hook run before each agent-loop call, import this install's hook script, read the session context the service keeps for the session's folder (`sessionContext`; OpenCode 1's plugin `directory`, OpenCode 2's `ctx.location.directory`, one plugin instance per folder) and add it to that call's system prompt wrapped in `<attache-memory>` tags.
Neither OpenCode saves the system prompt, so a resumed or compacted session never carries old memory and session capture never sees it; a transcript parser that meets an `<attache-memory>` block anyway strips it like the other injected tags.
OpenCode 1 also runs the transform for its compaction summary, so the plugin's `experimental.session.compacting` hook marks the session and the next transform for it (the summary) adds nothing; OpenCode 2 summarises through its separate `compaction` hook, which adds no memory.
OpenCode 1 also runs the transform for its title request, which therefore gets memory too; OpenCode 2's title request does not.
The hook script is loaded only when a model call needs memory, so a missing script costs the memory and never the MCP registration; memory follows the Agent sessions feature as for Pi.
The file is `<config dir>/plugins/attache.js` (`attache-<hash>.js` for another instance, which is also its OpenCode 2 plugin id, since OpenCode 2 refuses two plugins with one id), where the config dir is `OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`.
Before writing, the adapter asks the installed `opencode --version` (`agents/opencode-version.ts`; `ATTACHE_OPENCODE_BIN` replaces the lookup in tests) and refuses an OpenCode 1 older than 1.18.29, a major version other than 1 or 2, or output it cannot read; no OpenCode found is a manual connection.
It reads OpenCode's global `config.json`, `opencode.json`, `opencode.jsonc` and the file `OPENCODE_CONFIG` names (JSON with comments, `agents/jsonc.ts`) only to refuse a file that does not parse, a same-name MCP server (either OpenCode's shape) the plugin would replace, or an OpenCode 2 `plugins` list that turns the plugin off.
Project-level configuration is not checked.
The same plugin saves sessions.
OpenCode keeps them in a database that is not a public interface, so the plugin asks OpenCode for a session's messages through its plugin API and hands a snapshot to the hook script's `spoolSession`, which spools it like a hook's transcript copy (`spoolText`, nothing while the session context is absent, so capture follows the Agent sessions feature).
OpenCode 1 reports turn end through the `session.status` idle event and compaction through `experimental.session.compacting`, and Attache reads the whole session with `client.session.messages`.
OpenCode 2 reports those boundaries through `experimental.idle` and `compaction`, and Attache reads the typed `ctx.session.context`, which holds only the messages since the last compaction.
The plugin saves the sessions it saw once more when OpenCode unloads it.
OpenCode 1 did not run its `dispose` hook on SIGTERM in a probe, while OpenCode 2 ran the cleanup returned by `setup`.
A session with a parent (a subagent's) is never saved.
OpenCode has no session-end event, so the capability is `without-final-event` and the setup note says a turn still running when OpenCode quits can be missed; summaries wait for a quiet spell, as for Antigravity.
`agents/opencode-transcript.ts` reads the snapshot envelope (`{ attache: "opencode-session", v: 1, opencode, shape, sessionID, parentID, title, directory, messages }`, shapes `v1-messages` and `v2-context`).
Only the owner's and assistant's text becomes a turn.
OpenCode 2 capture reads typed session context at compaction so injected user-role text from the model request is never treated as the owner's words.
The parser drops tool calls and results, reasoning, synthetic or ignored parts, system, skill or shell messages, compactions and summaries, OpenCode 1's replay after automatic overflow compaction, and answers still being written.
It strips `<attache-memory>` and the other injected tags.
An unknown envelope, shape, message type or role yields no turns and a `problem` naming the OpenCode format; the service keeps a sample, logs it and puts it on the Connection's last error.
Each turn carries its OpenCode message id, and the service joins a partial source's snapshots by id (`joinTurns` in `agents/sessions.ts`, sources in `agents/session-sources.ts`).
A saved turn keeps its place and a new one follows, so turns compacted out of OpenCode 2's context stay saved and the summary watermark stays positional.
Attache keeps the redacted turns and message IDs for Pi, OpenCode and Copilot CLI in its state folder indefinitely.
When a Copilot CLI session spans a pause, Attache joins the filtered snapshot by message ID so previously saved turns stay in place.
If that state is lost, Attache preserves the archive and reports that it could not join the new turns.
Fully summarised sessions from other sources lose their local cache after seven quiet days.
A cache that no longer parses is removed and logged once.
The marker and ownership rules are Pi's (owner recognised by the `// Managed by Attache: ` prefix plus the instance line, so the MCP-only file an earlier version wrote is refreshed or removed); a running OpenCode (or OpenCode 2's background service) must restart to load a change.
`test/integration/opencode-smoke.test.ts` runs the real `opencode` in an isolated home (skipped where it is not on PATH or in `ATTACHE_OPENCODE_EXECUTABLE`): OpenCode 1 through `opencode mcp list`, OpenCode 2 through a private `opencode serve`, checking that the plugin is active, the MCP server connected, and both gone after disabling.
It also drives a private `opencode serve` against a local stand-in model (no credentials) to check that every agent-loop call carries the Brain's current memory after a Brain change, a compaction and a resume (a new server continuing the session), that compaction requests carry none, that OpenCode's database and data folder never contain it, and that none is sent after disabling.
It also checks session capture against the stand-in (which calls OpenCode's read tool on a file holding a secret and returns a compaction summary): every owner turn is archived once and in order across a compaction and a resume, and neither the archive nor the summariser's input holds tool output, the secret, memory or the summary; OpenCode exits when stopped.
It passed against `opencode-ai` 1.19.6 and `@opencode/cli` 2.3.2 on macOS.

### Copilot CLI

Copilot CLI connects through its personal MCP configuration and personal hooks (`agents/copilot-cli-adapter.ts`), with MCP access, runtime-fresh memory and session capture with a final event.
Attache adds one entry per instance to `<Copilot home>/mcp-config.json`, the file `copilot mcp add` writes, where the Copilot home is `COPILOT_HOME` when it is absolute, else `~/.copilot`; no repository file is touched.
The entry is `{ type: "local", command, args, tools: ["*"] }` under the instance's owner key (`attache`, or `attache-<hash>`), and it is recognised as this instance's by its `--state-dir` argument, as in the other MCP configurations, so a stale entry under another name is replaced and other instances' entries are kept.
Copilot CLI reads the file as JSON with comments (`agents/jsonc.ts`); Attache writes it back as plain JSON, as `copilot mcp add` does (seen with 1.0.114), backs it up first, and says in the preview when the file had comments that only the backup keeps.
A file that does not parse, a non-object `mcpServers` or a same-name server Attache did not add is refused before anything is written.
`settings.json` is read only to refuse a setup whose `disabledMcpServers` (where `copilot mcp disable` records it) lists this instance's server.
`~/.copilot` alone is not a sign that Copilot CLI is installed (the GitHub Copilot app and SDK-hosted runtimes share it): detection looks for a `copilot` executable in the tool folders and for `gh copilot`'s download folder, and connecting stays possible without either.
A running session must start again, or run `/mcp reload`; a repository's own `.mcp.json` can replace a same-name server for sessions in that repository.
`test/integration/copilot-cli-smoke.test.ts` runs the real `copilot` in an isolated home with no GitHub sign-in.
It runs when `copilot` is on PATH or `ATTACHE_COPILOT_EXECUTABLE` names it.
`copilot mcp list --json` and `copilot mcp get --json` show a user server next to the owner's, and a live session starts it and saves to the Brain as Copilot CLI.
After disabling, only the owner's server is listed.
It passed against `@github/copilot` 1.0.114 on macOS.
Memory comes from one personal hooks file per instance, `<Copilot home>/hooks/<owner key>.json` (`{ version: 1, hooks: { sessionStart: [{ type: "command", bash, powershell, timeoutSec: 10 }] } }`), which runs `attache-agent-hook copilot-cli session-start`.
The hook prints `{"additionalContext": "<attache-memory>…</attache-memory>"}` from the session's folder's context file (`hook-profiles.ts` `copilot-cli`), or nothing when there is no memory.
Copilot CLI combines every file in its hooks folder, so the owner's own hooks files and other instances' are never opened; a file at Attache's path that is not this instance's (no hook command running `attache-agent-hook` with this state folder) is refused and left when the Connection is disabled.
Connecting also refuses a personal `settings.json` with `disableAllHooks: true`, and a Copilot CLI older than 1.0.22 (`agents/copilot-cli-version.ts`; before 1.0.11 `additionalContext` was ignored, before 1.0.22 session-start hooks ran on every prompt); a version Attache cannot read does not stop it, since Copilot CLI updates itself.
No instruction file is written: the hook path passed the smoke test.
Seen with 1.0.114 against a stand-in model: the memory reaches the model as a user message of its own in a new (`source: "new"`), resumed (`"resume"`, fresh memory and no old copy) and `/clear`ed session; `events.jsonl` keeps it only in the `hook.end` event's `data.output.additionalContext`, never as a `user.message`; `/compact` drops it and session-start does not run again, so a compacted session has no memory until it is cleared, resumed or started anew.
A repository whose `.github/copilot/settings.json` sets `disableAllHooks` turns the hook off for its sessions; Attache cannot see that.
The smoke test also runs real sessions with no GitHub sign-in through Copilot CLI's offline mode with a custom provider (`COPILOT_OFFLINE`, `COPILOT_PROVIDER_BASE_URL`) and a local stand-in model, checking the memory in new, resumed and (with python3 driving the interactive terminal) `/clear`ed sessions, that `events.jsonl` holds it only on `hook.end`, and that none reaches a session after disabling.
A separate offline probe with 1.0.114 observed `clientInfo.name` as `copilot-cli`, which Attache maps to Copilot CLI in `mcp/harness.ts`.

Session capture adds `agentStop` (`turn-end`), `preCompact` (`pre-compact`) and `sessionEnd` (`session-end`) command hooks to the same hooks file (`hook-profiles.ts` `COPILOT_HOOK_EVENTS`); each copies the session's `events.jsonl` into the spool like the other hook Harnesses' transcripts.
`agentStop` and `preCompact` name it in `transcriptPath`; `sessionEnd` does not, so the hook derives `<Copilot home>/session-state/<sessionId>/events.jsonl` (`COPILOT_HOME` from Copilot CLI's environment, else `~/.copilot`).
Seen with 1.0.114: Copilot CLI writes events to the file in batches about 100 ms apart, after it starts a hook, so when a hook starts the turn that just ended is not in the file yet (in `-p` mode the file may not exist yet).
The hook therefore waits, at most 3 s, until the file holds its own `hook.start` event (same `hookType`, `sessionId` and `timestamp` as its input), which comes after the turn's events; the `sessionEnd` of a session `/clear` replaces never gets one, and its copy then holds everything up to the last turn, which that turn's `agentStop` already saved.
A subagent's `agentStop` carries `agentId` and the parent's `transcriptPath` and is never captured.
The file only grows: compaction (`session.compaction_start`/`_complete`, the summary in `summaryContent`) and `--resume` (`session.resume`) append to it, so every copy holds every earlier copy.
The service takes the newest copy in full until a capture pause, then joins eligible turns by message ID.
`agents/copilot-cli-transcript.ts` reads it: the first event must be `session.start` with `data.version` 1 and `producer` `copilot-agent`; `user.message` `data.content` (not `transformedContent`) and `assistant.message` `data.content` are the turns; events with `agentId`, user messages with a `source` or `isAutopilotContinuation`, assistant messages with `parentToolCallId` or `phase: "thinking"` are dropped, as are whole kinds (`session`, `hook` where the memory is, `tool`, `subagent`, `system`, `skill`, `instruction`, `permission`) and turn markers; any other event type, version, producer or content shape yields no turns and a `problem` naming the Copilot CLI events format.
Attache uses the first root assistant turn's timestamp in each interaction and the response timestamp to exclude answers that overlap a capture pause.
Tool follow-ups share that first timestamp because they can carry text from an earlier model call.
A partly written last line is left for the next copy; a file with nothing said is no failure (`SessionSource.strict`).
Only a Copilot CLI killed or crashing mid-turn can lose that turn; `sessionEnd` fires on exit, on `-p` completion and when the terminal closes (seen).
The smoke test runs a session that reads a secret-bearing file with the `view` tool, resumes it and (with python3) `/compact`s it, and checks the archive holds only the owner's and Copilot CLI's words, each once.

### MCP server in each Harness

Connecting a Harness also registers Attache's MCP server in that Harness's MCP configuration (`agents/mcp-registration.ts`), in one step with the hooks: `~/.claude.json` (Claude Code's user-level servers), `~/.codex/config.toml`, `~/.gemini/config/mcp_config.json`, and Claude Desktop's `claude_desktop_config.json`, whose folder differs per operating system (`platform/harness-locations.ts`).
Claude Desktop is a Harness with the MCP server only; its Code tab runs Claude Code, whose hooks already save those sessions.
The entry is named `attache` for the default install (`attache-<hash>` for another instance) and runs `attache mcp --state-dir <state>` through the bundled runtime and the `current` path; an entry is Attache's when its arguments run `mcp` for this state folder, whatever its name.
JSON files are edited as JSON (`agents/mcp-config-json.ts`); Codex's TOML is edited as text, taking out Attache's `[mcp_servers.<name>]` tables and appending a fresh one, and a TOML parser checks before and after that nothing but Attache's entry changed, so comments and layout survive and any other outcome is refused (`agents/mcp-config-toml.ts`).
An entry under Attache's name that Attache did not add is refused, as is a file that does not parse.
Every change across the hooks file, the MCP file and the rule file is worked out before the first write, so a refused file leaves the Harness untouched.
Disabling removes the hooks, the rule and the server, trying each even when another fails, and reports the failures together.

When the service starts, it re-registers the server for connected Harnesses whose entry no longer matches this version, and removes the save and audit skill folders earlier versions installed: only folders whose `.attache-skill.json` marker names this install's state folder, in `~/.claude/skills`, `~/.agents/skills` and `~/.gemini/config/skills` (`agents/legacy-skills.ts`).
The MCP prompts replace those skills, and there is no `attache save` command any more, because a Harness with auto-accept off has the owner confirm a save inside the Harness, which a shell cannot do.

An Update does not restart a Harness's MCP server: one started before the Update keeps running the earlier version's code and keeps working through `/api/v1`, so the API stays compatible with MCP servers from earlier versions.
Each tool call also asks `GET /api/v1/health` for the service's `version`, and when that is newer than the server's own (`updates/version.ts`), the first tool result after it carries one more text block saying that Attache was updated and that a new session has the latest tools (`mcp/update-notice.ts`).
A session is told once, even when several calls run at once, and stops asking after that; a failed check adds nothing and the next call asks again.

`attache audit` and the MCP server are clients of the running service (`cli/`, `mcp/`), because the service holds the data folder's writer lock.
Each pairs itself on first use as client kind `cli` (the same trust as `attache pair`), keeps the token in `state/cli-token` (private to the owner, see `platform/private-file.ts`), and pairs again if the token is revoked.
`POST /api/v1/memory/save` (`memory/save.ts`) validates every item before the first write: updates must name an existing note under `memory/` other than the identity record, a new note must not repeat an existing type and title, and no item may set one subject twice.
Only a save marked `confirmed: true` (the owner accepted it when the MCP server asked) or `autoAccept: true` (checked against the setting, on by default for a connected Harness) writes as the owner; any other save is stored as Proposals, one per item, and the response lists them under `proposals`.
Only a client paired as `cli`, which the MCP server uses, may call it: the Dashboard's browser session gets 403 `dashboard_cannot_save` (ADR 0003).
Facts go through the store's correction path, so the old value moves to History; events are appended to History.
Each item is written to its note in a single file write (`memory/save-items.ts`), so an item lands whole or not at all.

A Proposal (`memory/proposals.ts`) holds exactly one such item, with the reason it was suggested, the evidence it cites, and optionally the words it quotes from that evidence (`evidence`).
`POST /api/v1/memory/proposals` runs the save's validation before recording it, `GET /api/v1/memory/proposals?status=proposed` lists pending ones with the whole item (`status` takes several, comma-separated, such as `applied,rejected`; the latest made or decided first; each names its note by title in `noteTitle`), and `POST /api/v1/memory/proposals/:id/apply|reject` decides one.
Applying validates the item again, because the Brain may have changed since, then writes it as the service with the approved-Proposal permission and provenance `user-approved`; a refusal leaves the Proposal pending and the Brain untouched.
Rejecting writes nothing.
Proposals live in the Brain, one file each under `review/proposals/`, so they replicate and can be decided on any Machine (see "Review state" under Replication above).
The file records the item, the reason, the evidence, the Harness session, the Machine it was made on and every decision made on it; the `proposals` table is only this Machine's index of those files (`memory/proposal-index.ts`), refreshed from `Replication.onPulled` and rebuilt when the data folder is opened.
Proposals that earlier versions kept as `memory_changes` rows with `change = 'proposal'` are written as files the first time the data folder is opened (`memory/proposal-legacy.ts`), then dropped from the change log; one-fact rows (`{ value, newDoc }`) become the equivalent one-fact item, so they still apply and reject.
The write runs as the user, because saving is the user's explicit request; the note's provenance is `agent-saved`, and its source is the agent session (the archived transcript when Attache has one), detected from `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID` or `ANTIGRAVITY_CONVERSATION_ID` in the environment the Harness gives the MCP server (`mcp/agent-env.ts`).
`GET /api/v1/memory/audit` (`memory/audit.ts`) is read-only: every Current State entry with its age, Review date and source, the flags `stale` (past its Review date, `isPastReview`; there is no age threshold), `unsourced`, `missing-source` and `duplicate-subject`, newer passages about the fact, whether a project's session context carries the note's facts (`inSessionIndex`), and notes whose titles reduce to the same name.
Newer passages are searched per fact (the note's title and the fact's subject), must name the note, and are dated by what they say rather than by file time: a current fact in another note by its own date, an evidence document by `observed_at`, `captured_at` or `date`, and only then by modification time.
The document a fact cites as its source, archives under `evidence/archive/`, generated deliverables, and history or undated prose in other notes are never offered, because none of them can overturn the fact.
It counts; the audit prompt has the agent judge contradictions and propose corrections through the MCP `save` tool, which writes them like any save (the owner confirms only for a Harness with auto-accept off).

### Recent saves and revert

Every write to the Brain is recorded in the change log (`memory_changes`) with the Harness and session it came from, a batch id shared by all changes one save or one applied Proposal made, and a SHA-256 of the note right after the write.
`GET /api/v1/memory/recent-changes` (`memory/recent-changes.ts`) lists applied changes newest first, leaving out Proposal rows (an applied Proposal shows as the change it made), each with whether it can be reverted and, if not, why.
`POST /api/v1/memory/changes/:id/revert` (`memory/revert.ts`) undoes one change as the user and records the undo as a change of its own whose `reverts` names the original.
A corrected fact is corrected back to its previous value and the Review date that value had (the change log keeps both, `before_review` and `after_review`), a fact that had no previous value is moved from Current State into History, a created note is deleted from the data folder and the index, and a deleted note is restored from the copy its delete change keeps.
A change is revertible only while it is the last word: no later change touched the same fact (a later change and its own revert cancel out, so undo works like a stack), no later save touched a created note, and the file still matches what the change wrote (the fact's value and Review date, or the note's hash for a created note), so a hand edit or a change from elsewhere is never thrown away.
Events are append-only History and are never reverted.

`GET /api/v1/memory/recent-changes?unreviewed=1` feeds Home's Recently added (`views/RecentlyAdded.tsx`, ADR 0004): applied changes with `auto_accepted = 1` (an auto-accepted save or a Consolidation write) recorded in the last `UNREVIEWED_DAYS` (7) days, newest first, every one of them (the window bounds the list, so a busy week drops nothing); `limit` applies only without `unreviewed`.
The window ends at this Machine's clock (`app.clock`), so tests age changes by moving it.
A revert is the owner's own change (`auto_accepted = 0`), so only the change it undid shows, with `revertedBy` set; confirmed saves and applied Proposals never show.
Each view carries the correction's `reason`, and `source.consolidation` (`from` session or meeting, and the meeting capture with its indexed title) for rows written by the `consolidation` actor, labelled "Consolidation of <Harness> session <id>" or "Consolidation of meeting “<title>”".
Both lists render rows with `components/RecentChange.tsx`, so revert behaves the same in each.

## MCP server

`attache mcp` (`mcp/`) is an MCP server a Harness starts as a local process over stdio, built on `@modelcontextprotocol/sdk`.
It is a client of the running service like `attache audit`: it pairs as client kind `cli` and keeps the token in `state/cli-token`, so a Harness's configuration holds only the command.
Every tool call builds a fresh client from `state/runtime.json`, so a server started before the service works once the service runs, and a stopped service is reported on the call that meets it with how to start it.
The server starts even when the service is down, because a Harness launches its MCP servers when it starts and would otherwise mark Attache as failed.

- `search` calls `GET /api/v1/memory/search?recall=1`, which applies the recall exclusions (`RECALL_EXCLUDE`: old chat archives and raw session transcripts); without `recall=1` the Dashboard still searches everything.
  Each passage carries its path (relative to the Brain, or absolute for another indexed folder), line range, area, section kind and note title.
  The area tells curated memory, the only place a current fact can come from, apart from evidence, deliverables and imported notes.
- `read` calls `GET /api/v1/memory/document`, which also accepts an absolute path inside the Brain or another indexed folder when no `root` is given, and slices the requested 1-based, inclusive line range from the raw file, so lines match search citations.
- `audit` calls `GET /api/v1/memory/audit` and returns the report with every file named by one path, the same kind `search` returns (`memory/audit-view.ts`, shared with `attache audit`, which shows absolute paths instead).
  It is read-only and marked so (`readOnlyHint`).
- The `save` and `audit` prompts (`mcp/prompt-text.ts`) carry the procedures of the save and audit skills earlier versions installed, with the MCP tools in place of shell commands.
  Each takes one optional argument (`focus`, `topic`) appended to the text, and returns one user message.
- `save` takes `items` with the `MemorySaveItem` schema of `POST /memory/save`.
  It checks them with `POST /memory/save/check` (the save's own validation, no write), so an invalid item or the identity record is refused before the owner is asked.
  The check also answers `autoAccept`: whether auto-accept is on for the origin's Harness on this Machine.
  If so, the tool writes through `POST /memory/save` with `autoAccept: true` and no confirmation request; the service checks the setting again and refuses the save (409 `auto_accept_off`) when it is off.
  Auto-accept is on by default (ADR 0004): a connected Harness Attache knows is on unless the `harness_settings` table of the service database (`agents/auto-accept.ts`) stores it off; a Harness that is not connected, and an unknown MCP client (one that is not a Harness Attache knows), are always off, because the Dashboard has no switch for them.
  The table is local to the Machine and never in the Brain, so Replication never carries it; the first release with ADR 0004 switched every stored setting on, once.
  `GET /harnesses` lists each connected Harness with its switch and `PUT /harnesses/:id/auto-accept` changes it; a Harness that is not connected is refused, and Disabling one deletes its row, so connecting it again starts on.
  Every change an auto-accepted save makes is marked in the change log (`memory_changes.auto_accepted`) beside its Harness and session, and Recent saves shows the mark.
  It never applies to the identity record, which no save can change.
  Otherwise it sends an MCP confirmation request (`elicitation/create`, form mode, no fields) listing every item (`mcp/confirmation.ts`), with a 2-minute limit (`CONFIRMATION_TIMEOUT_MS`).
  Accept writes through `POST /memory/save` with `confirmed: true`, as the owner (actor `user`, provenance `agent-saved`); decline or cancel after one second or more writes nothing.
  When the owner cannot be asked, the tool calls `POST /memory/save/proposals`: the items are checked as one save and stored as one Proposal each in one transaction, with the save's origin in the payload.
  That covers three causes, which the reply names in `cannotAsk` and each Proposal's reason states: `unsupported` (the client does not declare the `elicitation` capability, or answers "method not found"), `instant` (a decline or cancel within one second, `FASTEST_PERSON_MS`, as Claude Code in print mode answers without showing anyone) and `unanswered` (no answer within the limit; Attache withdraws the request with `notifications/cancelled`).
  After one `unanswered`, later saves on the same MCP connection store Proposals without asking (`ownerConfirmation` keeps that per server, and `createMcpServer` builds one server per connection).
  Every reply (`saved`, `declined`, `proposed`) also carries its summary in `message`, because Claude Code shows the agent only the structured reply.
  Time comes from a `Clock` passed to `createMcpServer` (the system clock in `attache mcp`), so tests move it by hand over the SDK's in-memory transport.
  The origin names the Harness and session (`mcp/harness.ts`): from the environment the Harness gives the server (`CLAUDECODE` with `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, `ANTIGRAVITY_CONVERSATION_ID`), otherwise from the client name it reported (`claude-ai` is Claude Desktop), without a session; the folder is the server's working directory.
- The `wrap-up` prompt (text in `mcp/prompt-text.ts` too) asks the agent to pick out the conversation's durable points and call the `wrap_up` tool with them.
  It exists for conversations Attache cannot capture, such as Claude Desktop's Chat tab.
  `wrap_up` calls `POST /api/v1/memory/wrap-up` (`memory/wrap-up.ts`), which writes one evidence document per call with the points under `## Points` in the body, never under Current State, so search returns them as evidence and never as a current fact.
  The Harness comes from the same mapping as the save origin (`mcp/harness.ts`); the date and the Machine come from the service.
  The store redacts the title before it names the file and the whole document as it writes it, like all evidence.
  A call with no points stores nothing and answers that the conversation held nothing durable.
- The server's instructions, sent once when the Harness connects, carry the owner's identity from the configuration and the titles of the curated notes per type (at most 40 per type), fetched from `/config` and `/memory/documents` with a 5-second limit.

## Capability registry

`capabilities/registry.ts` is the single definition of features (recall, capture, attention, drafts, jobs, sessions) and connections, with their dependencies, required scopes, schedules and job kinds.
The setup checklist, dependency validation, API access checks (`requireFeature`) and scheduler all read it.
Disabling a feature disables its schedules, rejects its endpoints with `feature_disabled`, and cancels its queued jobs.
Disabling a Connection deletes its credentials, stops new requests, cancels queued jobs that depend on it, revokes pending approvals targeting it, and offers to keep or delete its retained observations.

## Clients

- Browser: React.
  Home is five areas: Search the Brain, The Daily Briefing, For you now, Your day and the Inbox, which closes with Recently added (what reached the Brain without review in the last 7 days); the Connections status is a shell banner instead of an area of Home; Approvals (`/approvals`: Drafts and Proposals), Brain (`/brain`: Library, the notes, evidence and deliverables beside a note reader; `/brain/recent`: Recent saves), Connections, Jobs and Settings are the other screens.
  `views/Home.tsx` puts the areas in the document in the order the window draws them (`home-arrangement.ts`: For you now before Your day below 600 px), so a keyboard and a screen reader follow what is drawn.
  `styles/home.css` arranges them by the window, the one place that follows the window: from 960 px search, briefing and day across the full width, then For you now beside the Inbox at one third and two thirds; from 600 px the same rows at half and half; below that every area stacked.
  Each area answers the width it is given with its own container queries (`for-you-now.css`, `your-day.css`, `briefing.css`, `inbox.css`), so the view it shows in a narrow space is the one it shows on a phone.
  `routes.ts` lists the screens (address, name, `g` letter, icon) and maps a path to one; there is no router library and the old `/memory` and `/drafts` routes are gone with no redirects.
  `components/Shell.tsx` frames every screen: `Masthead` (the mark with the total raised beside it, the screens on one line, the search launcher off Home and `MachineDisclosure` at the far right), `components/ConnectionBanner.tsx` under it on every screen but Connections, `SearchPalette` (Search the Brain in a dialog off Home), the page in a centred 1072 px reading column, and on narrow windows `BottomBar` (Home, Approvals, Search, Brain, More) with `MoreSheet`.
  The shell asks for the Connections status once (`connections-view.ts`: `/capabilities`, `/reader` and `/schedules`, decided by `connection-status.ts`) and shares it through `useConnections()`; `connectionBanner()` picks the issue the banner shows, counts the rest, and gives it its fixing button and, when the issue is one Connection's, Disable (`apps/web/test/connection-status.test.ts`); a silent Reader is its Not reading.
  A failed `/capabilities` or `/reader` answer counts only once it has lasted `CHECK_GRACE_MS`; until then the last answer stands, and a failed check is asked again on its own (`CHECK_RETRY_MS`, then every `CHECK_RECHECK_MS`).
  The shell keeps one polite live region for the banner (`ConnectionAnnouncement`) mounted from the start, whose words change only when the issue does.
  Every small list of choices under a button (Snooze's times, the banner's Actions, the Inbox heading's menus, Briefing options, the Brain menu) is `components/menu.ts` `usePopover`: a plain disclosure that Escape or a pointer outside closes, with focus back on its button.
  The Daily Briefing area (`views/DailyBriefing.tsx`) and the briefing page Read briefing opens (`views/BriefingPage.tsx`, at `/briefing/<id>` under Home, `routes.ts` `briefingHref`) read `GET /briefings` (`views/briefings.ts`); `briefing-area.ts` (pure, `apps/web/test/briefing-area.test.ts`) decides which briefing shows, its state, whether a failed later read leaves what was read as stale (`staleReadAt`, which For you now shares for its picks) and where each entry of the page leads (its Inbox item on Home through `inbox-place.ts` `openOnHome`, a Draft or a Proposal); `paintings.ts` lists the shipped paintings with their credit and source, chosen by the briefing's date.
  For you now is one pure module, `for-you-now.ts`, fed the open Inbox items, the latest Daily Briefing and the browser clock.
  Its reasons are a registry (`REASONS`), most urgent first, each saying when it applies and what it says, with every time and limit a named constant (`heads-up-rules.ts` holds those Home shares, such as `MEETING_LEAD_MS` for meeting prep and Join): meeting prep, a reply or any item nearly late, due today and the briefing's top picks; it de-duplicates by item and caps the result at five while retaining the service's Inbox order within a reason.
  `views/ForYouNow.tsx` renders those entries with the same `InboxRow` used by the complete Inbox and the same row actions (`views/row-actions.ts`), so actions, Undo and in-place detail share one implementation; the Inbox retains every open item and marks curated ids Suggested now.
  Start working, from the button or the `w` key, is `RowActions.start` (`views/row-actions.ts`): it takes the first step from `inbox-first-step.ts` (the kind's step, and Prepare draft for any other draftable item, one whose kind would only open the row); a meeting prep row opened in place shows Open prep (`meeting-prep.ts`, `views/MeetingPrepDetail.tsx`), and opening unread prep by any route records `start` once as the row opens (`useReadPrep`); a start that could not be recorded is tried again with the item's next data or the next open.
  Your day (`views/YourDay.tsx`) asks `GET /agenda` for today and tomorrow in the browser's zone and `your-day.ts` (pure, `apps/web/test/your-day.test.ts`) decides what it shows; only timed meetings decide whether more comes today.
  The Home clock recomputes on its minute tick and on wake, and while pointer or keyboard focus remains in For you now (`hold.ts`) its entries and their order hold, each with its item's current data (`for-you-now.ts` `holdEntries`), and an entry whose reason has ended shows its row's own source line instead of the reason.
  The Inbox is three pure modules and a view: `inbox-types.ts` maps an item's kind (and, for Slack, its source) to its type (family, word, hue and glyph; an unknown kind is Other), and `apps/web/test/inbox-types.test.ts` fails when that map and the service's `INBOX_KINDS` (contracts, the only kinds a connector can raise) disagree; `inbox-rows.ts` words a row (subject, source line, time, Draft tag); `inbox-view.ts` holds the list rules (priority order, Newest first, the frozen snapshot and its arrivals, pages of 20, the type choices behind "All types", Group by type).
  A row answers its list's width, never the window's (`styles/inbox.css`): one line with the actions at its end when the list is wider than 800 px, Snooze and Done as icons with the time under them from 601 to 800 px (the Inbox's two thirds on a desktop window), and the narrow form with one Actions button at 600 px and below; the heading's "All types" and "View options" are `components/ChoiceMenu.tsx`.
  `views/Inbox.tsx` keeps the shown order still until the owner presses Show new items (`views/inbox-list.ts`), keeps decided rows in place with Undo, and keeps the view in sessionStorage (`inbox-place.ts`); `j`/`k` and the opt-in decision keys reach it through `useRowKeys` in `shortcuts.ts`, switched in the shortcut sheet (`decision-keys.ts`); Approvals, Jobs, Connections and the Brain's note list take `j`/`k` through `useMoveKeys`, and every list moves with `moveAmongRows`.
  View draft stores the open row's place on screen with the view, and `views/inbox-return.ts` brings that row back to it when Home comes back, until Home settles or the owner scrolls.
  An item whose linked Draft's send has an unknown outcome is Delivery unconfirmed (`delivery.ts`, `apps/web/test/delivery.test.ts`): the row is labelled, and the open row (`views/InboxDelivery.tsx`) reads that Draft to say the Draft page's own warning (`draft-state.ts` `unknownOutcomeNotice`) and to point Check destination at the receipt's address, then offers the Draft, and a replacement only through a separate confirmation; `POST /attention/:id/draft` refuses a Draft for such an item (`delivery_unconfirmed`) unless `replaceUnconfirmed` names that Draft (contract `AttentionDraftInput`), and a Draft job checks again when it starts and just before it saves (also blocking while the item's Draft is being sent), so a job asked for another way, or one that outlived the choice, is blocked too.
  What an empty Inbox says is one pure rule, `inbox-empty.ts` (`apps/web/test/inbox-empty.test.ts`): from what the Connections status says was read (`inboxReach`) and the decision count, "Nothing needs you." only from an exact zero with every source read, otherwise what was found where, what was not read and what still waits; while a part of the count has not answered it says nothing yet, and a part a failed request left inexact (`NavSignals.countFailures`) is named, with the shell's `countRetry`.
  A failed Inbox request is a failure row with Retry (`components/GroupFailure.tsx`, shared with Approvals' groups), alone on first load and above the rows it keeps after a good load, never an empty list, and the heading then shows neither Home's number nor the count line; `count.ts` `homeLine` is the count line, counted from the rows while the list holds every open item and from the count when it is full.
  `count.ts` is the Decision count as one pure module: from the count route's totals, or, when that route fails, from the open Inbox items, Proposals, waiting Drafts and Connections lists, it works out the Home, Approvals and Connections parts, each known, at its list limit, unknown or off, the total (exact only when every part is known or off, otherwise a lower bound "N+"), the logo's dot (an unknown part never turns it on or off), the tab title and Home's line relating rows to decisions; `apps/web/test/count.test.ts` is its case table.
  `nav-signals.ts` asks the count route and those lists once, in the shell (`/connections` only while the route fails, since no screen lists it from there), and is the one source of what the navigation shows beside a screen (decision counts, Settings' Replication warning); screens read it with `useSignals()`, and `tab-signal.ts` sets the tab title and swaps the favicon (`public/favicon.svg` with the dot, `favicon-quiet.svg` without).
  The count route, `GET /api/v1/decision-count` (`http/routes-count.ts`, contract `DecisionTotals`), answers `{ inbox, drafts, proposals, signIns }` as totals counted in SQL, each a number, or `"off"` for the Inbox and Drafts parts while Attention or Drafts is switched off: `inbox` already leaves out the open items whose Draft waits, so `inbox + drafts` counts each decision once, and it settles expired Drafts first, as the lists do.
  The route's first answer counts at once; once Home's or Approvals' rows are on screen a refresh holds the rows and the route's answer until all three have answered, and the Inbox and Drafts parts come from that held answer (`withRows`), so the rows and the count change together (the Inbox, Drafts and the route refetch on one debounce after live events, so a row event asks all three together); while the route fails the count falls back to the lists, asked with their default limits, and a full list makes its part a lower bound.
  Approvals (`views/Approvals.tsx`) lists the shell's own waiting Drafts and Proposals (`NavSignals.waitingDrafts`/`waitingProposals`), so its sections, its Waiting tab and the navigation agree; In progress (`executing` Drafts) and Finished (finished Drafts, `GET /memory/proposals?status=applied,rejected`) are its own requests, each failing on its own.
  A failure of the Inbox or Drafts list shows at once and stays until the pair settles again with a good answer (`pair.ts`, `apps/web/test/pair.test.ts`), while their good answers are applied as one pair.
  `approvals.ts` holds its pure rules (row text, when "Nothing waits for your OK." is true, decided rows kept in place, Finished's order; `apps/web/test/approvals.test.ts`); a Draft's own page is `/approvals/<id>` (`routes.ts` `draftHref`, `views/DraftPage.tsx`).
  `draft-state.ts` is that page as one pure rule: the stored status and the editor's state (unsaved text, blank text, the version it was loaded from) map to one of fourteen states, each with its status word, step line, notice and buttons (`apps/web/test/draft-state.test.ts`, one case per state); the view only draws it and runs the buttons.
  `shortcuts.ts` is the keymap the shell listens with and `ShortcutSheet` lists behind `?`.
  Search is one shape everywhere: `search.ts` (pure, unit-tested) holds what to ask `GET /memory/search`, what a result says (kind, part, file and lines), where it opens (a memory note in the Brain with the query kept, anything else in the evidence view at the cited lines) and the ranking line; `search-answer.ts` keeps the last answer while a new one loads; `components/SearchField.tsx` is the combobox with its listbox of up to six results that Home shows (`views/HomeSearch.tsx`, with the date and Browse).
  The Brain keeps its query in its address (`/brain?q=`); `search-keys.ts` and `search-launch.ts` decide what `Ctrl K`, `Cmd K` and `/` do on each screen: on Home they focus Home's field, elsewhere the shell opens `components/SearchPalette.tsx`, the same `SearchField` in a modal dialog whose listbox puts a Go to group (`palette.ts`, pure: every screen and Settings section from `routes.ts`, matched by word starts) before the passages.
  The Brain screen's place is its address: `brain.ts` (pure, unit-tested in `apps/web/test/brain.test.ts`) reads and writes it (`brainPlace`, `brainHref`: view, collection, note, query, Recent saves filter) and holds the screen's other rules: a fact's source parsed from the words the note stores into what its button shows and opens (`parseSource`), Recent saves' filters (`filterChanges`), the waiting Proposals that change a note, and the Notes and History parts of a note as stored (`noteSections`).
  `views/Brain.tsx` is the search field, Library and the results; `views/NoteReader.tsx` the read-only reader; `views/RecentSaves.tsx` the filtered changes with Revert; `views/RebuildIndex.tsx` Rebuild index for the Brain's menu and Settings; `components/ChipNav.tsx` the row of chips that keeps the chosen one in view.
  The Connections page (`views/Connections.tsx`) is drawn from `/capabilities` by `connections-page.ts` (pure, unit-tested in `apps/web/test/connections-page.test.ts`): the groups in page order with a "Needs you" group first while a Connection needs sign-in, each row's columns (account, what it may read and write, last read) and which rows open when the page opens (every row in Needs you, and the one `?open=<id>` names, which is where Home's Reconnect lands).
  A row's state word comes from `connection-status.ts` (`connectionState`, `CONNECTION_LOOK`), the same rule that decides the Connection banner, so the page and the banner name a problem alike; an opened row or tile holds `components/ConnectionCard.tsx`'s `ConnectionControls`, which Setup shows inside a card.
  Jobs (`views/Jobs.tsx`) asks for running work (`GET /jobs?status=queued,running`) and ended work (`status=succeeded,failed,cancelled,blocked`, a page of 50 at a time) as two requests, each failing on its own; `views/JobDetail.tsx` is one job with its events, Cancel and Retry.
  `jobs.ts` holds its pure rules (`apps/web/test/jobs.test.ts`): the order under Running, a row's few words and tag, its time, the job the detail opens on (chosen once when both lists first answer, never again by a live update; a pick lives in `?id=`), what Cancel reports, and each event in words.
  `routes.ts` also lists the Settings sections (`SETTINGS_SECTIONS`, each at `/settings/<id>`, grouped by `settingsGroups()`; `settingsSectionShown()` picks the one an address shows, the first at `/settings`).
  `views/Settings.tsx` shows the section list (`views/SettingsNav.tsx`) beside that one section (`SettingsAttache.tsx`, `SettingsBrain.tsx`, `SettingsMachines.tsx`, `SettingsService.tsx`, each wrapped in `SettingsSection.tsx`); on a narrow window the list is Settings' first screen and a section replaces it.
  Arriving at a section from anywhere but the list focuses it at the top of the page (`views/settings-section.ts`); each section asks only for what it shows.
  `views/FeatureList.tsx` is the feature switches Setup and Settings share; `feature-problem.ts` (pure) decides that a switch names only a problem (`apps/web/test/settings.test.ts`).
  The look is defined once, in `apps/web/src/styles/`, following `docs/design/dashboard-blind-astra/DESIGN.md`: `tokens.css` holds the surfaces (`--canvas`, `--paper`, `--sunken`, `--feature`), the words over a painting (`--painting-text` on `--painting-scrim`, measured against every shipped painting by `apps/web/test/paintings.test.ts`), ink (`--ink`, `--ink-2`, `--ink-3`), edges (`--rule` decorative, `--line` control outline, `--key` field edge), actions (`--link`, `--primary` solid ink with `--on-primary`, `--focus`), the brass attention dot (`--attn`), the type scale (`--serif` Georgia headings, `--font` Inter, `--mono`) and seven role hues (blue, rust, plum, green, amber, red, slate), each a word-and-glyph step and a `-soft` tint, for light and dark; `base.css`, `controls.css` and `components.css` style elements, controls and shared components (with `citations.css`, `brain-changes.css` and `notices.css` for citations, Brain changes and shared status lines); `shell.css` the frame; and one file per screen the rest, imported in that order by `index.css`.
  The theme follows the system's light or dark setting.
  Accessibility is set in the same files: under forced colours `--focus` becomes the system's `Highlight`, so every focus outline (on a control, a stretched row or a field's box) takes it, and `accessibility.css` gives every selection a solid system-coloured frame or bar (forced colours drop the ink fill and inset bar) and keeps the attention dot drawn; `base.css` stops every transition and animation under reduced motion, and `motion.ts` `scrollMotion()` does the same for scrolls started in script; `accessibility.css` makes every control on every screen a 44 x 44 px target at 720 px and below or with a coarse pointer (a row's stretched subject already has its row).
  The shell keeps one polite status region that `count-announcement.ts` fills when a Source refresh changed the decision count (`count.ts` `refreshAnnouncement`): a Source refresh ends with a `source-refresh` live event (`SOURCE_REFRESH_EVENT`) saying whether its own writes changed the decision count, measured around them in `ConnectionManager.refresh` (counted open Inbox items plus sign-ins needed; a refresh that resolves one item and opens another changes nothing), and only then is the first count asked after it read out.
  `tests/e2e/a11y.spec.ts` holds the whole Dashboard to these with axe-core and in-browser measurements, and `tests/e2e/home-days.spec.ts` measures Home's fold on four days.
  A component takes a hue through `hueClass()` (`theme/hues.ts`) and reads `--c` and `--c-soft`, never a hue's own tokens.
  `Tag` replaced the old status pill and has no green variant: `StateTag` shows a healthy status as plain text and the rest as a tag (`state-tone.ts`).
  `TypeIcon` (a 19 px glyph stamped on its hue's tint, 34 px), `AttentionDot` (the logo's dot at 8 px) and `icons.tsx` (one inline SVG set, no icon package) are the other shared pieces.
  The typeface is Inter, bundled from `@fontsource-variable/inter` (one variable face, Latin subset) and served by Attache, so the Dashboard loads nothing from the internet; `tooling/font-budget.ts` fails `vite build` when the font files pass 150 KB.
  `apps/web/test/contrast.test.ts` reads `tokens.css`, checks that canvas, paper, ink and the design's foreground pairs ship as approved, and measures every text pair at 4.5:1 and every non-text pair (stamped glyphs, control edges, the focus outline, the attention dot) at 3:1 on the surfaces they sit on, in both themes; `tokens-used.test.ts` fails when a stylesheet or screen uses a token that is not set.
- Obsidian: no plugin.
  The data folder is Obsidian-compatible Markdown, and edits made there are picked up by the file watcher.
  (A desktop plugin shipped until 0.2.x and was removed on 2026-10-30.)
- Electron: not in this release.
  The API is versioned (`/api/v1`) and has no browser-only assumptions, so an Electron shell can load the same Dashboard.
