# Attache user guide

Attache is a personal assistant that keeps your knowledge on your own computer, on macOS, Linux or Windows.
It keeps your knowledge as Markdown in a folder you choose, answers questions with cited evidence, watches the sources you connect, and prepares drafts that are only sent after you approve them.

## Install

You do not need Node, Homebrew or any developer tools; the installer carries its own runtime.

### On macOS

Requirements: macOS on Apple silicon.

1. Download `Attache-Installer-<version>-macos-arm64.command` from the release.
2. Double-click it.
   macOS may say it is from an unidentified developer because the release is not signed.
   In that case open it with right-click → Open, or run `sh ~/Downloads/Attache-Installer-<version>-macos-arm64.command` in Terminal.
3. The installer copies Attache to `~/Library/Application Support/Attache`, starts the service at login as a LaunchAgent, and opens `http://127.0.0.1:7427` in your browser with a one-time pairing code.

### On Linux

Requirements: Linux on x86_64 with systemd, which every mainstream desktop distribution uses.

1. Download `Attache-Installer-<version>-linux-x64.sh` from the release.
2. In a terminal, run `sh ~/Downloads/Attache-Installer-<version>-linux-x64.sh` as yourself, not with `sudo`.
3. The installer copies Attache to `~/.local/share/attache`, keeps its state in `~/.local/state/attache`, and runs it as the systemd user service `attache.service`.
   The service starts when you log in, and systemd restarts it if it crashes.
   The installer then opens `http://127.0.0.1:7427` in your browser with a one-time pairing code.
4. The command line goes to `~/.local/bin`.
   Most distributions already have that folder on your `PATH`; if `attache` is not found, add it, or run `~/.local/bin/attache`.

Two packages are optional, and most desktops already have them.
`secret-tool` (`libsecret-tools` on Debian and Ubuntu, `libsecret` on Arch and Fedora) lets Attache keep credentials in your desktop's keyring; without it they go to a file only you can read (see [Credentials on Linux](#credentials-on-linux)).
`notify-send` (`libnotify-bin` on Debian and Ubuntu, `libnotify` on Arch and Fedora) lets Attache raise desktop notifications for urgent items.

The service stops when you log out, like any other user service.
To keep it running without a login, for example on a home server, run `loginctl enable-linger` once.
If the installer says systemd could not be reached for your user, you are in a session without a systemd user manager (for example after `su` to another user); log in as yourself, or turn on lingering as above.
`systemctl --user status attache` shows the service, and `journalctl --user -u attache` shows what systemd did with it.

### On Windows

Requirements: Windows 10 or 11 on x86_64 (64-bit Intel or AMD).
You do not need administrator rights.

1. Download `Attache-Installer-<version>-windows-x64.cmd` from the release.
2. Double-click it.
   Windows may say it protected your PC, because the release is not signed; choose **More info** → **Run anyway**.
   Instead of the one-step installer you can also unpack `attache-<version>-windows-x64.zip` and double-click `install.cmd` in it.
3. The installer copies Attache to `%LOCALAPPDATA%\Attache` and keeps its state in `%LOCALAPPDATA%\Attache\state`.
   It registers the task `Attache` in Task Scheduler, which starts Attache when you log on, without a window, and starts it again if it crashes.
   The installer then opens `http://127.0.0.1:7427` in your browser with a one-time pairing code, and its window waits for a key so you can read what it did.
4. The command line goes to `%LOCALAPPDATA%\Attache\bin` as `attache.cmd` and `attache-uninstall.cmd`.
   The installer does not change your `PATH`; add that folder to it (Settings → System → About → Advanced system settings → Environment Variables), or run `%LOCALAPPDATA%\Attache\bin\attache`.

The service stops when you log off, and starts again at your next logon.
Task Scheduler → Task Scheduler Library → `Attache` shows the task, and its output goes to `logs` in the state folder.
Claude Code runs Attache's hooks through Git Bash, as it runs every hook on Windows, and Codex through cmd.exe; both work with the paths Attache writes, including a user folder with letters such as æ, ø and å.

### Repair and install a newer release

Running the installer again repairs the installation without touching your data.
Running a newer installer installs it in place: it backs up first, switches versions and keeps your settings and knowledge.
On Windows, repairing the version you already run replaces its files, so close each Harness that has Attache's MCP server open first; the installer says so if one still holds them.
Harness hooks and the MCP server run Attache through a stable `current` link, so they keep working when a newer release is installed.
Attache no longer has voice; upgrading from a version that had it removes the downloaded speech model, the speech connection and its key.

## First-run setup

The installer opens the Dashboard with a one-time pairing code, and your browser pairs by itself.
If the code is missing, wrong or expired, **Pair this browser** asks for it and says what is wrong beside the field; run `attache pair --open` for a new code.

Setup shows its five steps on the left and the current step on the right.
Each step works without the ones after it, you can go back to any step you have reached, and Setup resumes at the step you left.
**Continue** is never greyed out: when something is missing, it says what beside the field and puts the cursor there.

1. **Data folder.**
   Choose where Attache stores knowledge (default `~/Documents/Attache`).
   Preview shows exactly what will be created and confirms that existing files are not modified; **Use this folder** asks you to preview first.
   Three optional sections sit below **Use this folder**, closed until you open them.
   *Import an existing Markdown folder or Obsidian vault* points Attache at your notes; they are read in place and never changed.
   *Who is this for?* takes your name and email, so Attache can tell your own messages from others'.
   *Already use Attache on another Machine?* joins the Brain you already have instead of starting a new one (see Replication below).
2. **Features.**
   Search is always on.
   Saving to memory, background work, attention and briefings, drafts and approvals, and agent sessions are optional.
   If a feature needs another one, Attache explains it and offers to turn the requirement on (or dependents off).
3. **Connections.**
   Connect only what you want: GitHub, Jira, Confluence, Slack, Gmail, Google Calendar.
   Every connection starts read-only.
   Slack, Gmail, Google Calendar, Jira and Confluence use your existing claude.ai connectors (Slack, Gmail, Google Calendar and Atlassian Rovo): Claude Code must be installed and signed in on this computer with your claude.ai work account, and each connector must be connected in claude.ai → Settings → Connectors.
   For Jira and Confluence you also enter your site URL, for example `https://acme.atlassian.net`.
   If your organization allows it, Jira and Confluence can instead connect directly with **Sign in with Atlassian** or an Atlassian API token made for the MCP server.
   Steps that need an admin on the other side (allowing the Atlassian Rovo MCP server, enabling a claude.ai connector for the workspace, a GitHub token) are explained on the card before you connect.
   Under *Harnesses*, connect Claude Code, Codex, Antigravity, Claude Desktop, Pi, OpenCode or Copilot CLI if you use them.
   Each gets Attache's MCP server, so it can search your Brain and save to it (see The Brain in any Harness below).
   Claude Code, Codex, Antigravity, Pi, OpenCode and Copilot CLI also save their sessions and give each session your memory (see Agent sessions, and Pi, OpenCode and Copilot CLI, below).
4. **Model and schedules.**
   Pick a model: Claude Code on this computer (uses your existing Claude sign-in), an Anthropic API key, or any OpenAI-compatible endpoint including a local Ollama or LM Studio.
   Without a model, Attache still searches and shows you the evidence it finds.
   Set how often sources refresh, when the daily briefing is prepared, and whether urgent items raise a desktop notification.
5. **Test and finish.**
   Attache tests each connection and reports every feature as ready, partial, needs setup or unavailable.
   You can finish with a notes-only workspace and connect things later.

Everything chosen during setup can be changed later in **Settings** and **Connections**.

## Everyday use

**Home** shows what is timely now, under **For you now**, and the Inbox.
Attache has no chat box: you ask the Brain from your Harness (see Using the Brain from a Harness below).

### Getting around

On a desktop window the masthead runs along the top: the Attache mark, then **Home**, **Approvals**, **Brain**, **Connections**, **Jobs** and **Settings** on one line, with the page below in a centred reading column.
The total of every decision that waits sits as a small raised number beside the word Attache.
The screen you are on is a solid ink pill.
A number in an outlined box beside a screen counts the decisions waiting there: Inbox items beside Home, Drafts and Proposals beside Approvals, and Connections that need you to sign in again beside Connections.
Each decision counts once: an Inbox item whose Draft waits is counted as the Draft, in Approvals, and a Draft that is being sent or is finished is not counted.
On Home itself Home carries no number; instead the Inbox heading says how many need you there, such as "4 need you here", and it shows beside Home again from every other screen.
When the rows and the decisions differ, a line under the heading relates them, such as "3 items need you here · 1 Draft in Approvals": an item whose Draft waits is counted in Approvals; with nothing to relate the line is not there.
The logo shows its brass dot while any decision waits, and so does the browser tab's icon; the tab's title carries the total, such as "(14) Attache".
The numbers beside Home, Approvals and Connections always add up to the one in the tab title and beside the word Attache.
The count is exact however many decisions wait.
When the count could not be read, the Dashboard counts the lists it shows instead, and a list that stops at its limit makes the number a lower bound, such as "200+".
A part that could not be read at all adds nothing: the dot then stays as it was rather than claim that nothing waits.
When Replication is blocked or the repository refused this Machine, Settings carries a brass dot named "Replication blocked" or "Replication unauthorized"; in Settings the same words sit under **Machines and Replication**, which says why and what to do.

Off Home, **Search** in the masthead opens the search palette; on Home the search field is the first thing on the page.
At the far right of the masthead, this Machine's name opens a short panel: this Machine, which Machine is the Reader and when it last refreshed every source, whether live updates are connected, and a link to Machines and Replication in Settings.
When live updates to the service drop, the button itself says **Reconnecting** or **Offline** until they are back; work in progress carries on in the service meanwhile.
A full-width Connection banner sits directly under the masthead on every screen except **Connections**.
It names the issue that most needs you with its source, state and what may be missing, for example "Gmail · Sign-in needed · Replies may be missing", counts any others as more connection issues, and offers the fixing action (**Reconnect**, **Retry now**, **Refresh now**, or **Machines and Replication** for a silent Reader), **Disable** for a problem owned by one Connection, and **Go to Connections**.
**Disable** asks first and shows what disabling affects.
Only a Connection that needs you to sign in again counts toward the dot, and a disabled Connection leaves the count.
Each issue has an icon and a word: a key for **Sign-in needed** and **Access denied**, a warning triangle for **Not reading**, **Down**, **Offline**, **Partly read** and **Cannot run**, and a question mark for **Not read yet** and **Could not check**; amber means you can act or part was read, red means nothing was read or it cannot run.
Sources that could not reach the network at all share one issue, whatever words each one recorded.
When the Reader has gone silent, the banner says **Not reading** until a Reader is back.
Having only your notes connected, or Attention and briefings switched off, is how you set Attache up, not a problem, so neither raises the banner.
A check that fails for only a moment never raises the banner: Attache asks again on its own and says **Could not check** only once the failure has lasted a few seconds, then keeps asking until an answer comes.
The banner has no close button: it stays while the Inbox may be incomplete, and a screen reader hears a new issue once, not on every refresh.
On a narrow window it wraps to two lines with the fixing action in view and the other choices behind one menu.
A healthy setup has no banner, and Connections in the masthead carries a green dot.

On a narrow window a bar along the bottom holds **Home**, **Approvals**, **Search**, **Brain** and **More**.
**More** opens a sheet with **Jobs**, **Connections**, **Settings** and the same lines about this Machine; it carries the brass dot when a sign-in or Replication needs you.
**Search** in the bar puts you in Home's search field on Home and opens the search palette everywhere else.

Press `g` and then a letter to jump to a screen: `h` Home, `a` Approvals, `b` Brain, `j` Jobs, `c` Connections, `s` Settings.
Press `Ctrl K` (`Cmd K` on a Mac) or `/` to search the Brain: on Home they put you in Home's search field, elsewhere they open the search palette.
The search palette is the same search in a dialog over the screen you are on, with the same results and a **Go to** group above them.
Before you type, Go to lists every screen and every Settings section; as you type it keeps the places whose name starts with your words, so `repl` finds Machines and Replication and `settings ident` finds Identity.
Arrow keys move through places and passages, `Enter` opens the chosen one, and **All results in Brain** takes the query to the Brain.
`Tab` stays inside the palette, `Esc` closes it, and focus goes back to where it was; each time it opens, its field is empty.
Searching from the palette only reads: it starts no job and changes nothing.
Press `?` for the list of keyboard shortcuts.
`j` and `k` move between the rows of the Inbox, Approvals, Jobs, Connections and the Brain's note list, and `Enter` opens one; they change nothing.
The decision keys, `w` for Start working, `d` for Done, `s` for Snooze until tomorrow at 09:00 and `x` for Dismiss on the row you are on, are off until you switch them on with **Use the decision keys** in the shortcut list, and each decision keeps its Undo.
`w` does all that **Start working** does, its first step included.
No single key ever applies, approves, sends, rejects, reverts or disables a Connection.
Shortcuts do nothing while a dialog is open, nor while you type in a field, except `Ctrl K` and `Cmd K`.
The old Memory and Drafts addresses are gone: the Brain lives at `/brain` and Approvals at `/approvals`.

### Look

The Dashboard follows your system's light or dark setting: warm paper with dark blue-black ink in light, deep green slate with pale ink in dark.
Headings are set in Georgia, and The Daily Briefing leads Home in its own painting card.
Attache serves its typeface (Inter) itself, so every page looks the same on every Machine and loads nothing from the internet.
Colour always comes with a word: a state that is fine, such as connected, ready or succeeded, is written in plain text, and only a state that needs a look, such as needs setup, partial or failed, gets a coloured tag.
The keyboard focus is a blue outline around the control, and the selected screen or row is filled in ink, so you can always tell where the keyboard is from what is selected.
With a high-contrast theme (Windows contrast themes and other forced colours) the outline takes your system's highlight colour, the selected screen, tab or row keeps a frame or a bar, and the brass dot stays drawn.

Every screen works in a window 320 px wide and at 200% zoom without scrolling sideways.
On a phone or a touch screen, a tablet included, every button, link, field, tab and switch on every screen, sheet and dialog is at least 44 × 44 px, and the page's first and last controls stay clear of the bottom bar and the phone's home indicator.
With reduced motion switched on in your system, nothing glides or turns: the Dashboard jumps straight to where a link takes you.
Type is never told by colour alone, so the stamps stay apart in grayscale and with colour blindness, and a failure keeps its warning triangle.
A screen reader hears each screen's areas by name, a count with its words, such as "Approvals, 2 waiting", and what changed, such as a decided row or a new Connection issue, once.
When a Source refresh changes how many decisions wait, it hears the new total once, such as "4 need you now."; opening the Dashboard, your own decisions and other live updates stay quiet.

### Home

Home holds Search the Brain, The Daily Briefing, For you now, Your day and the Inbox, which ends with Recently added.
At 960 px and wider, Search the Brain, The Daily Briefing and Your day span the reading column; For you now uses one third beside the Inbox at two thirds.
From 600 to 959 px, the shared row splits in half.
Below 600 px, the areas stack as Search the Brain, The Daily Briefing, For you now, Your day and Inbox.
Each area responds to the space it is given, so an area in a narrow column looks and behaves as it does on a phone.

- **Search the Brain** sits under the heading Home, with today's full date beside it on the same line, such as "Wednesday, 18 November".
  It is one tall field with the search icon, the `Ctrl K` keycap and **Browse**.
  The field waits until you click it or press `Ctrl K`, `Cmd K` or `/`; it is not focused when Home opens.
  As you type, up to six passages show under it (session summaries, not raw session transcripts), each with its title, a snippet, its kind (person, project, decision, note, imported note, evidence or deliverable, and *Current state* or *History* when it comes from one), and its file and lines.
  The arrow keys choose a passage and `Enter` opens it: a memory note opens in the Brain, anything else in the evidence view at the cited lines, and closing the evidence view brings you back to the field with your words still in it.
  `Esc` closes the results and keeps what you typed.
  A line under the results says whether they are ranked by meaning and keywords or by keywords only, and why.
  **All results in Brain** opens the Brain with your words in its search field and in its address (`/brain?q=…`), so you can bookmark or share the search; `Enter` with no passage chosen does the same.
  Searching starts no job and changes nothing.
- **Browse**, inside the field at its right end, opens direct links to People, Projects, Decisions, Notes and Recent saves in the Brain on a line under it.
- **The Daily Briefing** is its own Home area for the whole day.
  It shows the latest briefing written today, its time, a locally shipped public-domain painting, credit, and **First on your list**.
  **Read briefing** opens the briefing page, under "Home / The Daily Briefing": First on your list with the briefing's points, Top to-dos as they were when it was written, New updates, and Your day as it stands now; every entry opens the Inbox item, Draft or Proposal it comes from, and its source.
  **Got it** folds the card to one line; select the line to open it again.
  The painting changes each day and is the same on every Machine that day; Attache ships the paintings and never fetches them.
  **Briefing options** holds **Prepare a briefing**, **Away summary** and **Meeting context**.
  When none exists it says **No briefing yet today**; a running briefing shows progress, and switched-off briefings link to Settings.
  When Attache could not check for a newer briefing after a good read, the area keeps what it showed and a quiet line says from what time, with **Retry**.
  With nothing from that read on screen, the line says only since when it could not check.
  With no Daily Briefing yet today, **Prepare a briefing** writes today's Daily Briefing, so the area fills with its card and its picks reach For you now; once there is one, it writes a briefing you asked for.
  An Away summary or a briefing you asked for appears above the Daily Briefing for four hours or until **Got it**, as a plain card named for what it is; **Read briefing** opens its page under that name, without a painting.
  An Away summary counts and marks only what is new or changed since the time you give.
  It still names its first item and Top to-dos from the whole Inbox, and lists them even when they have not changed.
- **For you now** is a short curated list of the Inbox items to act on now.
  It orders unread meeting prep from 15 minutes before a meeting, replies that have waited a working day or are nearly due, items due today, and today's Daily Briefing picks.
  A due date without a time of day is never nearly due: it counts as due today on its own day, wherever you are.
  Each row gives its reason, such as "Starts in 12 min, prep not read" or "Nora has waited since Tuesday"; an item appears once under its most urgent reason.
  At most five items show, followed by the count of the rest in the Inbox.
  Every row has **Start working**, **Snooze** and **Done**, and opens with the same detail as its Inbox row.
  Starting an item keeps it in progress when its reason still applies.
  Opening meeting prep (the meeting's time, the other attendees and the notes the newest briefing related to it) marks it read, whether you open its row, press **Start working** or press `w`: it goes **In progress** and leaves the list on every page and Machine; its row stays in the complete Inbox throughout, with **Suggested now** while it is listed here.
  **Done** or **Snooze** on an entry leaves one line with **Undo** in its place, and **Undo** puts the entry back in that place, even while your pointer or focus is in the list.
  An entry never moves or leaves while your pointer or keyboard focus is in the list, but it shows what changes at once, such as **In progress**; one whose reason has ended leaves when you move away.
  With nothing timely the area says what comes next, and a failed Inbox request shows an error with **Retry** rather than an empty list.
  When the Daily Briefing could not be read, a quiet line says its picks are missing, with **Retry**, under any entries the list still has.
  When it could not be read again after a good read, the list keeps the picks it had and the line says from what time they are, also with **Retry**.
  With Attention and briefings switched off, the area says so with a link to Settings.
- **Your day** is the ruled band between Home's upper areas.
  It shows today's calendar meetings in start order in your computer's current time zone, with all-day events on one compact line above timed meetings.
  The meeting in progress is marked, ended meetings are dimmed, declined meetings are left out, and an invitation you have not answered says **Not answered**, all-day ones included.
  Select a meeting or an all-day event to open it in Google Calendar.
  **Join** appears from 15 minutes before its start until its scheduled end when it has a Meet link.
  Once the day's timed meetings have ended, the band says **Nothing more today** and names tomorrow's first meeting when one is known; an all-day event is never a meeting in progress, so it stays on its line above.
  Google Calendar is read from the start of today, so the meetings that have ended still count as today's.
  It says **Nothing on your calendar today** only after a complete read, and otherwise distinguishes **Checking**, **Could not read**, **No calendar connected** and **Switched off**.
  A failed read keeps the last known meetings and says when they were read.
  The band follows the one-minute clock, refreshes when the page becomes visible and changes with the computer's time zone.
  On a wide window extra meetings sit behind **N more**; in a narrow space every meeting is a list.
  Your day is a schedule and never adds to the Attention dot's count.
- **Inbox** is one ruled list of what may need you, the most important first: the service's priority, then the earliest due time, items with no due time last.
  Each row says what it is with a coloured stamp, a glyph and a word, such as **Review request** (blue, a branch fork), **Pending reply** (rust, an envelope), **Slack DM** (plum, a speech bubble), **Deadline** (rust, a clock), **Jira work item** (blue, a ticket) or **Fact to check** (green, a dated page), so two kinds never look alike even without colour.
  A kind Attache does not know yet still shows, under its own readable word with a plain document glyph.
  Beside the type is the subject, with where it comes from on the line below (for example "GitHub · acme/web #42" or "Gmail · Nora Lind"), and on the right when it is due or when it arrived.
  The actions end the row's line: **Start working** outlined, **Snooze** with a caret and **Done** with a green check.
  On a narrow window the type comes first, then the whole subject, then the source and time.
  Every row offers **Start working**, **Snooze** and **Done** without opening it.
  **Start working** takes the item's first step: prepare a Draft for a reply, open a review or work item at its source, open meeting prep or the calendar event, or open other items in place, except that any of those others Attache can draft a reply to gets a prepared Draft.
  It keeps the item open and marks it **In progress** on every Machine; the button then reads **Continue**.
  Opening the row shows **Not started** to clear the mark.
  A row with a waiting Draft keeps **Draft waiting · View draft**, and **Start working** opens that Draft.
  **Snooze** opens the same return times as an opened row.
  In a two-thirds space, as the Inbox has beside For you now on a desktop window, Snooze and Done become a clock and a check with their full names for a screen reader and on hover, and the time moves under them; in a half or narrower space, all three sit behind **Actions** and remain in the opened row.
  Select a row to open it in place for the summary, why it is here, evidence, the main action and every decision, including **Dismiss**.
  **Dismiss** hides an item until its evidence changes; **Snooze** hides it until a time; **Done** closes it.
  A decided row stays where it was as one line with **Undo**, so nothing below it moves.
  The list does not reorder itself while you read: new items wait behind **Show 1 new item** in the Inbox heading until you press it, and the page does not scroll or close the row you have open.
  Up to 20 rows show at a time, with the range ("1–20 of 34") and **Load more**.
  Two menus sit at the right of the Inbox heading.
  **All types** lists every type with its count and shows one type at a time; the button then names the type.
  **View options** offers **Priority order** (the default), **Newest first**, **Group by type** (Deadlines, Reviews, Replies, Mentions, Meetings, Work items, Facts to check, System and Other, three rows each with **Show all**) and **Hidden**, the snoozed and dismissed items, where **Reopen** brings one back.
  The view, the type and the open row are kept for the tab, so they are as you left them when you come back from a Draft, and the row you opened the Draft from stands where it stood on screen.
  When the list could not be loaded, the Inbox says so with **Retry** where the rows would be; it never shows that as an empty list.
  When it could not be refreshed after a good load, it keeps the rows it had and says from what time they are, also with **Retry**.
  An empty Inbox says exactly what is known.
  **Nothing needs you.**, beside the logo without its dot, appears only when no decision waits anywhere and every source was read, and says when they were read.
  When a source was not read it says "Nothing found in the 4 sources that were read." and names the one that was not; with only your notes connected, "Nothing found in your notes."; when Approvals or a sign-in still wait, "No open Inbox items." and where they wait; and when the count could not be read, that Attache cannot say nothing needs you, with **Retry**.
  With Attention and briefings switched off the Inbox says so, and that this is not a claim that nothing needs you.
- **Recently added** is one line at the end of the Inbox, such as "3 changes written without your review in the last 7 days", that opens into every such change, newest first: saves a Harness wrote with auto-accept on, and Consolidation's changes.
  It is not there while Saving to memory is switched off, and it says so with **Retry** when it could not be loaded.
  Saves you confirmed in the Harness and Proposals you applied are left out, since you saw them.
  Each row shows the note, what changed (a new note, a new fact, an event, or a corrected fact's old value struck through before the new one, with the reason), where it came from (the Harness and session, or the session or meeting Consolidation read) and when.
  **Revert** works as in Recent saves below, and a reverted change stays listed, marked reverted.
  Changes older than 7 days drop off on their own, so there is nothing to mark as seen; with none, the line says so and has nothing to open.
  A dismissed item comes back only if something about it changed, and it is marked "changed since your decision".
- **Prepare draft** asks Attache to write a reply or review comment with the item's context.
  While that draft waits for you or is being sent, the item stays in the Inbox with a tag naming the Draft's state, such as **Draft waiting**, and offers **View draft** instead.
  Once the draft is finished (rejected, expired, sent or failed), the item offers **Prepare draft** again, and the finished draft stays under **Finished** in Approvals.
  When a send's outcome could not be verified, the item stays open and says **Delivery unconfirmed**, after a reload too.
  Open it and **Check destination** comes first: it opens where the message went, in a new tab, and changes nothing.
  **View the Draft** shows the original Draft and its receipt.
  Only if the message did not arrive, **Prepare a replacement** and confirm it to prepare a new Draft; mark the item **Done** if it did arrive.
  Drafts stay on the Machine they were prepared on, so another Machine can offer Prepare draft for the same item.

### Brain

The **Brain** opens with a full-width search field, and under it two views, each with its own address: **Library** (`/brain`) and **Recent saves** (`/brain/recent`).

**Library** puts the collections, the notes in the chosen collection and the note you are reading side by side.
The collections are People, Projects, Decisions, Notes, Imported, Evidence and Deliverables; they show no counts.
A person, project, decision or note opens in the reader beside the list; imported notes, evidence and deliverables open in the evidence view.
On a narrow window the collections become one row of chips that scrolls sideways, and the note goes below the list.
The address names the note you are reading (`/brain?root=…&path=…`), so you can bookmark it or come back to it.

Type in the search field and every matching passage, up to 50, takes the Library's place, with a line saying how they were ranked (by meaning and keywords, or by keywords only and why).
The Brain's search includes raw session transcripts that Home's search leaves out, and it keeps your words in the address as you type (`/brain?q=…`).
A passage in a note opens that note in the reader beside the results; anything else opens in the evidence view at the cited lines.
**Clear search** brings the Library back.

The reader shows one note:

- *Current state* first, one dated entry per subject, with its Review date when it has one; past that date the entry is marked **unverified**.
- **Source** beside an entry is a button: select, tap or press it to open the source in place, exactly as the note stores it, with when it was observed and a way to open it, the cited lines in the evidence view or the web page.
  Select it again to close it.
- The note's *Notes*, then *History* exactly as the note stores it.
- The **Change log**, closed until you open it: every recorded change to the note, with who made it and why.
- On your identity record, a line saying it changes only from Settings.
- When a Proposal waits to change the note, a line linking to it in Approvals, where it opens in place.
- **Markdown file** opens the file itself at its path, with line numbers.

The **⋯** menu beside the heading holds **Rebuild index**, which reads every note into search again when search misses one; it is also in Settings, under *Service health*.
Jobs shows its progress, and it changes no note.

The Dashboard shows notes, evidence and deliverables read-only: it has no capture box and no way to correct or edit a note.
Every change to the Brain goes through a Harness (see Using the Brain from a Harness below) or through your own edits to the Markdown files.
A changed fact replaces the current one, the old value moves to *History* with the date and the reason, and the next search returns the new value.
Changes that Attache proposes wait in **Approvals**, under *Changes to the Brain*, until you apply or reject them.
Each Proposal shows the whole change before you decide: the new note or the note it updates, every fact with its reason, every event, notes and tags, why it was suggested and the evidence it cites, with the words it quotes from that evidence.
**Apply** writes every part at once, and each replaced value moves to *History*; **Reject** writes nothing.
If the Brain changed since the Proposal was made, for example the note was deleted or a note with the same title now exists, Apply refuses and writes nothing; the Proposal stays so you can reject it.
A Proposal can never change your identity record.
With Replication on, a Proposal made on one Machine shows on every Machine, and the Machine it was made on is named.
Decide it on any of them: approving applies it once, where you clicked, and it leaves the list everywhere.
If two Machines decided the same Proposal while apart, the later decision stands on both; an approval that a later rejection overrules is undone, except for events, which stay in *History*.

**Recent saves** on the Brain screen lists the newest changes to your Brain, newest first, 50 at a time with **Show more** below.
Its filters keep **All** changes, those **Written without review** (auto-accepted or consolidated), or those **Reverted**, each with the revert that undid it; the filter is part of the address (`/brain/recent?show=reverted`).
Each row shows the note, the fact with its old and new value, where the change came from (the Harness and session, the session or meeting Consolidation read, a Proposal you approved, or you) and when.
A change written without your review is marked auto-accepted, or consolidated when Consolidation wrote it.
**Revert** undoes one change with one click:

- A corrected fact gets its previous value back as a new correction, so the note's *History* shows both the change and its revert.
- A fact a save added is taken out of *Current state* and kept in *History*.
- A note a save created is removed from your Brain and from search, together with the events and facts that same save wrote into it.
- A removed note can be brought back by reverting the removal.

Every revert is listed as a change of its own, so you can revert a revert.
A change can be reverted only while it is still the last word on what it changed.
When a later change overwrote the same fact, or the note was edited outside Attache since, the row says why and offers no **Revert**; revert the later change first.
Events stay in *History*, which only grows, so they cannot be reverted.

### Approvals

**Approvals** holds everything Attache prepared that waits for your OK.
Approvals is only the page's name: you approve one exact version of a Draft, and you apply or reject a Proposal.

The **Waiting** tab has two ruled sections, so sending a message and changing the Brain never look alike:

- *Drafts to send*, marked with a blue pen and the word Draft.
  Each row shows the Draft's subject, where it goes and its version, such as "GitHub comment on acme/web #42 · v2", and the first line of its text.
  Opening a row shows, read-only, what the Draft answers and its whole text, with **Review and approve vN** (or **Review and send vN** once approved) and **Reject**.
  **Approve** and **Send** are never in the list: they are on the Draft's own page, with the version in view.
- *Changes to the Brain*, marked with a plum change glyph and the word Proposal.
  Each row names the note and the change, the old value and the new one for a correction, such as "Owner: Sam → Nora", or what it adds.
  Opening a row shows every part, the reason and the evidence (as described above), with **Apply** and **Reject**.
  When Apply is refused, the reason shows in the row and the row stays, so you can still reject it.

A row you decide stays as one line in its place, such as "Applied · Email vendor", until your next visit, so nothing below it moves.
A Draft that is being sent shows under *In progress*; it is not counted, since nothing waits for you there.
"Nothing waits for your OK." shows only when both the Drafts and the Proposals answered with nothing.
The Drafts and the Proposals are asked for separately, and each section answers for its own: when one cannot be loaded it says so with **Retry**, and keeps the rows it last had with the time they were loaded.
The Waiting tab and Approvals in the navigation still count every waiting decision; only when the count could not be read either do they show what is known as a lower bound, such as "2+".

The **Finished** tab lists sent, not sent, unknown, rejected and expired Drafts and applied or rejected Proposals, the latest outcome first.

A Draft's own page is at its own address under Approvals, with **Back to Approvals** at the top and Approvals selected in the navigation.
Its header names the kind of Draft and where it goes, such as "GitHub comment on acme/web #42", then its version, its status and, while it can still be sent, when it expires.
A step line under it shows where the Draft stands: Draft, Approved, then Sent.
The message the Draft answers is quoted above its text at every width, and the text itself is the main part of the page, at reading size.
Under the text one line says what the state means, and the buttons follow, the next step first.
Whatever you press, the page stays on the same Draft.

- **Approve vN** binds your approval to that exact version for 15 minutes.
  **Send vN** is shown before that, switched off, with the reason; for a Gmail draft it reads **Create vN in Gmail**, which makes a draft in your Gmail and sends nothing.
- Typing makes the text unsaved: **Save as vN+1** and **Discard changes** come first, and Approve and Send wait.
  Saving replaces the text of the old version, which is not kept, and cancels any approval of it; the page says so before you save.
- When the 15 minutes end before you send, the Draft says when the approval ended and that nothing was sent, and offers **Approve vN again**.
- **Send** works only when the connection is authorised to write that kind of action.
  Until then the page says "Cannot send yet." with the reason, and **Open Connections** when the fix is there.
  Attache rechecks everything on the service immediately before sending and marks the Draft sent only after the other service confirms it.
- **Revoke approval** takes an approval back; Attache also revokes one itself when its Connection is disabled, its write permission is removed or Drafts are switched off, and says which.
- **Reject** locks the Draft, and nothing is sent.
  Until the Draft expires, **Restore as vN+1** brings the same text back as a new version, waiting for your approval again; nothing else undoes a rejection, so typing cannot undo it by accident.
  Restore is refused while a newer Draft for the same item waits, was sent, or has an unknown outcome.
- When the other service cannot confirm what happened, the page says the outcome is unknown, with a warning sign, and asks you to check the destination first.
  It never offers to send that Draft again; prepare a new one from its Inbox item only after you have looked.
- A Draft that was not sent, or expired, is finished: **Copy text** keeps its words and **Prepare a new Draft** asks Attache for a fresh one.
- If the Draft changes elsewhere while you are typing, such as in another tab, your words stay in the box: **Copy my text** keeps them, and **Load vN** shows the current Draft.

Drafts expire after 48 business hours.

### Connections

**Connections** opens with the Reader, the Machine that runs Source refresh and briefings, and when it last refreshed every source.
Below it each Connection you set up is one row in its group: **Notes**, **Work sources**, **Harnesses** and **Model**.
A row shows the Connection's name, its account (or folder, or the settings file a Harness was installed in), what Attache may read and write there, and when Attache last read it, each in its own column.
A Connection that works carries no state word; one with a problem says so under its name in the same words Home uses, such as **Down**, **Offline**, **Partly read** or **Not read yet**.
Select a row to open it in place: its description, last success and last error, the last Source refresh scope by scope, and **Test**, **Refresh now**, **Reconfigure**, **Disable…**, what Attache reads and its write permissions.
Connections you have not set up are small tiles under their group; a tile opens across the group into its setup form.
The Notes group also has **Import a folder**, which reads a Markdown folder or Obsidian vault without changing it.

When a Connection needs you to sign in again, a **Needs you** group comes first with that Connection's row already open, ready to sign in or take a new token.
**Reconnect** on Home lands there, on that Connection's row, when the fix needs you to type something.

### Settings

**Settings** lists its sections on the left, in four groups, and shows one section at a time beside the list:

- **Attache:** *Features*, *Schedules and notifications* and *Identity*.
- **Brain:** *Saving and review* (Auto-accept for each connected Harness, and Consolidation), *Meaning-based search* and *Backup and export*.
- **Machines:** *Machines and Replication* (this Machine's name, then Replication with every state and action it has) and *Paired clients*.
- **Service:** *Service health*, with the credential store, *Rebuild index* and, under *Diagnostics*, the process, the jobs and when each schedule runs next.

Each section has its own address (`/settings/identity`, `/settings/machines` and so on), so a link or a bookmark opens it, and the browser's Back goes through the sections you opened.
`/settings` itself opens Features.
On a narrow window Settings opens on the list; a section then fills the screen, with **All settings** above it to go back.
A feature switch says nothing more while the feature works or is off; one that is on but not fully working shows **needs setup**, **partly working** or **unavailable** with the reason.
Changing your identity record still asks you to confirm it first.

### Jobs

**Jobs** lists background work: research, briefings, draft preparation and source refreshes.
It is a quiet table: each job's title, what it came to in a few words, and the time it started or finished.
Work that is queued or running comes first, under **Running**; everything that ended follows under **Finished**, newest first, 50 at a time with **Show 50 more**.
A job that succeeded carries no tag, only what it produced, such as "Answered from 3 sources" or "Draft v2 ready".
A job that failed carries a red **Failed** tag and one that is blocked an amber **Blocked** tag, each with its reason.

The detail beside the table shows a job's progress, times, result or reason, and its events.
When you open Jobs it shows the running job, else the newest one that failed or is blocked, else the newest job.
Live updates change the table, never which job the detail shows; picking a row changes it, and that pick stays in the address, so a reload or a link comes back to it.

Type a question and press **Research** to research it across your notes; the answer is saved as a deliverable you can open from the result.
**Diagnostics** runs a two-minute self-test that checks background work survives a restart.
**Cancel** stops queued or running work and says what happened: it stopped, or it had already finished and its result stands.
**Retry** starts a failed, cancelled or blocked job again.
Jobs keep running when you close the browser; reopen the page and progress resumes from the service.

## Agent sessions

Attache remembers your work in Claude Code, Codex, Antigravity, Pi, OpenCode and Copilot CLI.
Connect each one you use under Connections → *Harnesses*; its tile lists what the Connection gives the Harness (MCP access, memory and session capture, each on its own), every file that changes, and whether the Harness must restart, before you connect.
This section describes Claude Code, Codex and Antigravity; Pi, OpenCode and Copilot CLI connect through their own extension, plugin and hooks, described in their own section below.

- **What changes in the Harness:** connecting adds Attache's MCP server (see the next section) and Attache's own hooks, in one step.
  The hooks go into `~/.claude/settings.json`, `~/.codex/hooks.json` or `~/.gemini/config/hooks.json`; the MCP server into `~/.claude.json`, `~/.codex/config.toml` or `~/.gemini/config/mcp_config.json`.
  Your other settings, hooks and MCP servers are kept, each file is backed up to Attache's `backups/` folder first, and **Disable** removes exactly what Attache added.
  A file Attache cannot read (for example JSON with comments, or TOML that does not parse) is refused with a message that names it, and nothing is changed.
- **Saving a session:** when a session ends or its context is compacted, the conversation is saved to `evidence/sessions/transcripts/` in your data folder, without tool output or injected context, and with secrets redacted.
  Antigravity has no end-of-session event, so its conversations are saved after every turn and summarised once they have been quiet for 15 minutes.
- **Session log:** each session gets an entry in `evidence/sessions/<date>-<machine>.md` with what was decided and learned, written by your model.
  Each Machine writes its own log file, named after the Machine (see *This Machine* below); logs from before Attache named Machines keep their `<date>.md` name and are still searched and shown.
  Most sessions have nothing durable, and the entry says so; without a model the entry only links the transcript, and says that the session was not consolidated.
  Session logs are searchable; raw transcripts are kept but never quoted as evidence.
- **Consolidation:** when the session log entry holds something durable, Attache reads the session again, with the notes that search finds related to it, and writes what it finds to your Brain straight away.
  Each change names the note it changes (or the new note it creates), the facts and events, an optional Review date, the reason, and the words in the session it rests on, linked to the line of the transcript.
  Each change is listed in *Recent saves* on the Brain screen, marked as written without review, and one click reverts it.
  There is no limit on how many changes a session yields, but nothing is written twice: a change that is already waiting for review, or a fact the note already holds, is left out, and your identity record is never changed.
  When a session states a different value for a fact a note already holds, Attache writes the new value and moves the old one to the note's *History* with the reason.
  A session that only mentions or repeats a fact changes nothing.
  To see Consolidation's changes before they are written, switch **Consolidation** off in Settings, under **Saving and review**, beside the Harness switches; on that Machine it then makes Proposals under *Changes to the Brain* in Approvals instead.
  A Proposal that is a correction shows the current value struck through beside the new one, with the reason and the evidence, and applying it moves the old value to *History*.
  If the fact changed after the Proposal was made, Apply is refused, so a correction never replaces a value you were not shown; reject it instead.
  A Harness's auto-accept switch has no say over Consolidation.
  It runs on the Machine where the session ended, with that Machine's model; a session that reaches another Machine through Replication is not consolidated there again.
- **Memory in new sessions:** every new session starts with a short block about you, the titles of the notes Attache keeps, and a command the agent can run to search Attache for more (`attache search "…"`).
  A session started inside one of a project's repositories also gets, first, that project's current state, the decisions and people linked to it, and the latest session-log entries from sessions in its repositories.
  A decision or a person is linked to a project when either note names the other, by its title or with a link to its file.
  The whole block stays within about 8 KB; when there is more, Attache drops note titles first, then the oldest session entries, then the least recently updated decisions and people, and says what it left out.
  The project's own facts are always there, and a fact past its Review date is marked unverified.
  A project lists its repositories in a `Repositories` fact, for example `- **Repositories** (2026-11-11): acme/web, git@gitlab.com:team/api.git`; write `owner/name` for GitHub, `host/owner/name`, or a remote address, separated by commas, and ask your agent to save it like any other fact.
  The SSH and HTTPS addresses of a repository both match, in any folder or worktree of it; a session anywhere else gets the general block.
  Attache rewrites these blocks whenever your memory changes, and the agent's hook picks one by reading the folder's git remotes from disk, so session start stays instant and works offline.
  Antigravity gets the same block from an always-on rule, `~/.gemini/config/rules/attache-memory.md`.
- **Codex asks first:** Codex runs new hooks only after you approve them.
  The next time Codex starts it shows *Hooks need review*; choose **Review hooks** and trust the three Attache hooks.
  Codex remembers trust by position, so after you disable it you may need to review hooks listed after Attache's again; connecting it again updates Attache's hooks in place and leaves yours where they are.
- **If Attache is not running,** sessions are queued on your computer and saved the next time it starts.

Turning *Agent sessions* off in Settings disables Claude Code, Codex, Antigravity, Pi, OpenCode and Copilot CLI and removes Attache's hooks, extension, plugin and MCP server from them; Claude Desktop stays connected.
Connect them again after you turn the feature back on.
Uninstalling Attache removes them all.

## Pi, OpenCode and Copilot CLI

Pi, OpenCode and Copilot CLI are Harnesses of their own under Connections → *Harnesses*, each connected and disabled on its own.
Each connects through the product's own extension, plugin or hooks system, and its tile lists three capabilities on their own: MCP access, memory and session capture.
MCP access never implies the other two; each is listed only because Attache's tests show it working with the real program (see `docs/harness-support.md` for the versions and what each test covers).
All three get MCP access, memory read fresh from your Brain, and session capture, and all three must restart, or start a new session, before a change takes effect.
Memory and session capture need the *Agent sessions* feature on.
You can connect each one even when Attache did not find it on this computer.

What they have in common:

- **Only Attache's own files and entries change.**
  Each file Attache writes names this Attache install inside it, so a second Attache install on the same computer gets its own file (`attache-<code>`) and disabling one leaves the other.
  Your own settings, MCP servers, extensions, plugins and hooks are never changed.
- **A file Attache cannot read stops the change.**
  If the Harness's own settings file does not parse, or it already lists a server under Attache's name, or it turns Attache's extension, plugin or hooks off, connecting stops with a message that names the file, and nothing is written.
- **Backups and recovery.**
  Before Attache changes a file that already exists, it copies it to the `backups/` folder in Attache's state folder, named after the file's path and the time, so you can copy it back.
  A file Attache creates has no earlier version to back up; disabling it removes the file.
- **Out of date.**
  When the tile says **Out of date**, Attache's file no longer matches this Attache version, for example after you edited it.
  Attache repairs its files, with a backup, each time it starts, so after installing a newer release only a restart of the Harness is needed; to repair them now, connect again and restart the Harness.
- **Saves through MCP.**
  Like every connected Harness, each saves without asking while its auto-accept switch in Settings is on, which it is when you connect it; with the switch off, a save asks you first where the Harness can show the request, and otherwise waits for you as a Proposal in Approvals.
- **What is saved.**
  Only your words and the Harness's answers are kept, never tool calls, tool output, Attache's memory, other injected context or subagent conversations.
  A session in a format Attache does not recognise is not saved at all; the Connection shows the problem, naming the Harness and the format.
  Pi, OpenCode and Copilot CLI keep a redacted local copy of captured turns in Attache's state folder so a session can resume after a long pause.
  Attache retains these copies indefinitely.

### Pi

- **Setup:** connect Pi under *Harnesses*, then run `/reload` in a Pi session that is already open, or start a new one.
  Pi 0.99.0 or later with its built-in MCP support on is needed.
- **Files:** one extension, `~/.pi/agent/extensions/attache.ts` (or in `PI_CODING_AGENT_DIR` when the Attache service has it set).
  Your Pi `settings.json`, `mcp.json` and other extensions are only read, never changed.
- **MCP access:** the extension registers Attache's MCP server each time Pi starts a session, for that session only.
- **Memory:** sent with every model call and never saved in the session, so resumed and compacted sessions see today's memory.
- **Session capture:** after each prompt, before each compaction and when a session closes.
  Sessions run with `--no-session`, such as Pi's subagents, are never saved.
- **Limits:** only the newest turn of a Pi that is killed or crashes can be missed.
  Pi started with its extensions turned off gets neither MCP access nor memory.

### OpenCode

- **Setup:** connect OpenCode under *Harnesses*, then restart OpenCode; for OpenCode 2's background service, run `opencode service restart`.
  OpenCode 1 (1.18.29 or later) and OpenCode 2 work; an older OpenCode 1 is refused.
- **Files:** one plugin, `~/.config/opencode/plugins/attache.js` (or in `XDG_CONFIG_HOME` or `OPENCODE_CONFIG_DIR` when the Attache service has them set).
  Your `opencode.json`, `opencode.jsonc`, MCP servers and other plugins are only read, never changed.
  OpenCode 1 itself writes `package.json`, a lockfile and `node_modules` into that folder when it starts.
- **MCP access:** the plugin registers Attache's MCP server each time OpenCode loads it; OpenCode 2 loads it inside its server or background service.
- **Memory:** added to the system prompt of every model call and never saved in the session.
- **Session capture:** each time a turn ends and before each compaction.
- **Limits:** OpenCode has no session-end event, so a turn still running when OpenCode quits can be missed.
  OpenCode started with `--pure` loads no plugins, so it gets neither MCP access nor memory.
  Project-level OpenCode settings are not checked.

### Copilot CLI

- **Setup:** connect Copilot CLI under *Harnesses*, then start a new `copilot` process; Copilot CLI reads hooks when it starts.
  Copilot CLI 1.0.22 or later is needed.
- **Files:** Attache's entry in your personal MCP configuration, `~/.copilot/mcp-config.json`, and one personal hooks file, `~/.copilot/hooks/attache.json` (both in `COPILOT_HOME` when the Attache service has it set).
  `mcp-config.json` is backed up first and written back as plain JSON, so comments in it are kept only in the backup.
  Your other MCP servers and hooks files are not changed, and no repository is touched.
- **MCP access:** Copilot CLI starts Attache's MCP server from your personal MCP configuration.
- **Memory:** the session-start hook gives each new, cleared (`/clear`) or resumed session your current memory.
- **Session capture:** after each turn, before compaction and when the session ends, read from the session's `events.jsonl`.
- **Limits:** after `/compact` a session has no Attache memory until you `/clear`, resume or start a new one.
  Only a Copilot CLI that is killed or crashes mid-turn can lose that newest turn.
  A repository whose `.github/copilot/settings.json` sets `disableAllHooks` turns Attache's hooks off there, and a repository's own `.mcp.json` can replace a server of the same name.

## Meeting captures

A meeting capture is a Markdown file in your data folder's `evidence/captures/` folder whose frontmatter `tags` include `meeting` or `meeting-transcript`, for example the notes and transcript of a meeting that an export routine writes there.
When a new one arrives, Attache reads it, with the notes that search finds related to it, and writes what it finds to your Brain, the same way it does for a Harness session; with the Consolidation switch off, it makes Proposals under *Changes to the Brain* in Approvals instead.
This needs a model connection; without one, the capture is kept and is not read.

- Each change names the note it changes (or the new note it creates), the facts and events, an optional Review date, the reason, and the words in the meeting it rests on, linked to the lines of the capture that hold them.
  It is listed in *Recent saves*, marked as written without review, and one click reverts it.
- There is no limit on how many changes a capture yields, and nothing is written twice: a change that is already waiting for review, or a fact the note already holds, is left out.
- A capture is read once.
  Editing it afterwards, or restarting Attache, does not read it again.
  A capture written while Attache was stopped is read when Attache starts.
- The captures already in a data folder when you choose it, or when a Machine joins your Brain, are not read: only captures that arrive afterwards are.
- With Replication on, a capture is read on the Machine where it arrived; the Machines that receive it do not read it again.
- Snapshots that Source refresh writes from Slack, mail, Jira and your calendar (`evidence/connectors/`) are never read this way, and neither are captures without a meeting tag.
- With the Consolidation switch off, its Proposals wait for your click.

## The Brain in any Harness (MCP)

Every Harness you connect reaches your Brain through Attache's MCP server, including Claude Desktop, which has no shell and no hooks.
Connect Claude Desktop under Connections → *Harnesses* like the others; it gets the MCP server only, in its `claude_desktop_config.json`, and needs a restart to load it.
Its Code tab runs Claude Code, so connect Claude Code too to save those sessions.

The Harness starts the server as a local process (`attache mcp`, pinned to this install); there is no URL and no token to copy.
The server pairs with the running service the way the command line does and keeps its token in Attache's state folder, never in the Harness's configuration.
It is listed under the name `attache`.
If the Harness already lists a server named `attache` that Attache did not add (for example one you added by hand with `claude mcp add`), connecting stops and says so; remove that entry, then connect again.

Earlier versions installed two skills, `attache-save` and `attache-audit`, and a `attache save` command.
The MCP tools and prompts replace both, because a Harness with auto-accept off asks you to confirm a save through the MCP server, which a shell command cannot do.
When Attache starts after that release is installed, it removes the skill folders it installed (the ones with its `.attache-skill.json` marker) and adds the MCP server to every Harness that was already connected; skill folders without the marker are left alone.

- **search** finds passages in your Brain and returns each one with its path, line range, area (`memory` for curated notes, `evidence` for logs, snapshots and wrap-ups), the kind of section it is in (current state, history or body) and the note's title.
  Like recall, it leaves out chat archives from earlier versions and raw session transcripts, and includes session summaries.
  A fact past its Review date is marked unverified.
  Once meaning-based search is ready on this Machine, passages are found by meaning as well as by keywords; until then the answer starts with a line saying the passages match keywords only, and why.
- **read** returns a whole note, or only a line range, for a path that search returned, and names the facts in it that are past their Review date.
- **save** writes facts and events: create a note with its facts, or update a note by its path with new values (each with a reason) and events.
  A fact can carry a Review date (see below).
  Every item is checked first, so one invalid item rejects the whole save with a message that says what to fix, and nothing is written.
  A save from a Harness with auto-accept on (the default, see below) is written without asking.
  With auto-accept off, the Harness asks you to confirm before anything is written, listing every item with its facts and events.
  Accept, and the items are written as you, each fact citing the Harness and session it came from.
  Decline or close the request, and nothing is written; the agent is told so.
  When Attache cannot ask you, each item is stored as a Proposal instead, for you to apply or reject in the Dashboard, and the agent is told the save waits there.
  That happens when the Harness cannot show the request, when it answers within a second (faster than a person could, as Claude Code does when it runs without a window), or when nobody answers within 2 minutes.
  Each Proposal's reason says which of these happened.
  After one request goes unanswered, that Harness session stores Proposals without asking again.
  Your identity record (`memory/self.md`) cannot be changed through this tool; change it in Settings.
- **Auto-accept** writes a save without review, so nothing waits for you (ADR 0004).
  In Settings, under **Saving and review**, each connected Harness has a switch, on by default; upgrading from an earlier version switched it on for every Harness, including one you had left off.
  With it on, a save from that Harness is written without asking; switch it off and that Harness asks you to confirm every save.
  A Harness that is not connected, and an unknown MCP client (an agent application that is not a Harness Attache knows), always ask, because the Dashboard has no switch for them.
  The setting belongs to this Machine only: it is kept in Attache's local state, not in your Brain, so switching a Harness off on one Machine leaves it on elsewhere.
  Disabling a Harness forgets its setting, so connecting it again starts with auto-accept on.
  A save written without review still records the Harness and session, and Recent saves on the Brain screen marks it **auto-accepted**, so you can see and revert it.
  Your identity record is never changed this way.
- **audit** lists every current fact with its date, Review date, age, source and flags, plus newer passages that name the note, where a contradiction would show up.
  A fact is flagged stale only when it is past its Review date; a fact without one is never stale, however old it is.
  It writes nothing.
- Three prompts carry Attache's procedures, so the Harness needs no installed skills.
  In Claude Code they appear as `/mcp__attache__save`, `/mcp__attache__audit` and `/mcp__attache__wrap-up`.
  - **save** distills what matters from the last turn: it searches before creating a note, sorts each item into a fact or an event, and saves through Attache rather than editing files.
    Text after the prompt says what to focus on.
  - **audit** runs the audit, judges each fact against the newer evidence, and shows you every correction before making it through Attache.
    Text after the prompt limits the audit to a topic.
  - **wrap-up** records the durable points of the current conversation: decisions, facts about people and projects, commitments and stated preferences.
    Use it where Attache cannot capture the conversation itself, such as the Chat tab in Claude Desktop.
    The agent stores the points with the `wrap_up` tool as one evidence document in `evidence/wrap-ups/`, with the Harness and the date, and with secrets redacted.
    The points are evidence, not curated memory: search finds them, labelled `evidence`, but none becomes a current fact unless it is saved to a note.
    When the conversation held nothing durable, nothing is stored and the agent tells you so.
- When the Harness connects, the server tells it who you are and lists the titles of your notes, so a Harness without Attache's hooks knows when to search.
- If Attache is not running, the server still starts, and each tool answers that Attache is not running and how to start it (`attache start`).
  The tools work as soon as Attache runs, without restarting the Harness.

## Review dates

A fact you expect to change, such as a status, a plan or a deadline, can carry a Review date: the day after which it should be checked again.
In the note it sits beside the fact's own date, for example `- **Status** (2026-11-10, review 2026-11-13): Beta opens to customers`.
An agent sets it when it saves a fact, and a Proposal can carry one per fact; it must come after the fact's own date.
You can also add or change one by hand in your editor, and Attache reads it.
Facts that stay true, such as a repository's name, need none, and Attache never adds Review dates in bulk.

Past its Review date a fact stays in your Brain, marked unverified: in the Dashboard, in search results, in what a Harness reads, and in the context a new agent session starts with.
Each such fact also raises one item under **Facts to check** in the inbox, naming the note and the fact, when your data folder is next refreshed.
Dismissing the item keeps it dismissed until the fact or its Review date changes.
The audit flags these facts, and only these, as stale.

To clear the mark and the item, save the fact again: a correction without a Review date clears the old one, and one with a new date sets it.
To confirm a fact is still true, save the same value with a later Review date.
The old value keeps its Review date in History, and reverting a correction brings back the previous value with its Review date.
A Proposal whose Review date passes before you apply it is still applied: the fact is written without that date, and the note's History says which date was dropped and why.
Give the fact a new Review date with a later save if it still needs one.

## Editing notes in Obsidian

Your data folder is plain Markdown, so you can open it as an Obsidian vault or in any editor.
Attache picks up your edits within a few seconds.
A note an editor on Windows saved with CRLF line endings reads the same as any other; whatever Attache writes uses LF line endings.
There is no Obsidian plugin; use the Dashboard in the browser to search, review Inbox items and decide on Proposals.

## Meaning-based search

Meaning-based search finds notes by what they mean, so a question in other words, or in Danish, finds an English note.
Names, ticket numbers and repository names still match exactly, because keyword matches keep their place in the ranking.
It uses a small multilingual model (multilingual-e5-small, about 135 MB) that runs on each Machine, without a network and without sending your notes anywhere.
Attache does not ship the model: download it once per Machine in **Settings → Meaning-based search**.
The card shows the model's state: not downloaded, downloading, building, ready or failed.
After the download Attache builds a vector for every passage it has indexed, in the background, and keeps them current as files change.
Search keeps working on keywords the whole time, and results in the Dashboard, in a Harness and from `attache search` say they match keywords only, and why.
Once every passage has a vector, the card says search ranks by meaning and keywords, and the keywords-only line goes away.
While a changed note's new passages are embedded, search falls back to keywords for those few seconds.
If the download fails, the card says why and offers to download again.
The model lives in the service state folder and its vectors in this Machine's index, never in your Brain, so they are not replicated; each Machine builds its own.

## Measuring search

`attache evaluate-recall` scores search against a set of questions you keep in your Brain at `evaluation/recall-questions.json`.
Each question names the note and the current fact that should answer it:

```json
{ "questions": [{ "question": "When is the Orion cutover?", "note": "memory/projects/orion-migration.md", "fact": "Status" }] }
```

`note` is the note's path inside the Brain and `fact` is the subject written in bold in its Current State.
The report says how often the expected fact is the first result and how often it is in the first three, and lists every question that missed with the first three results search returned instead.
It also says whether search ranked by meaning and keywords or by keywords only, so compare scores measured the same way.
A question whose note or fact is no longer in the Brain is not scored; the report lists it with the reason so you can correct the set.
Use `--set <file>` to score another set and `--json` for the full report.
Attache must be running, because the command scores the search the service runs.
The set is JSON, not Markdown, so search never finds the questions themselves.

## Sleep, offline and notifications

The service runs only while your computer is awake.
When it wakes, each overdue schedule runs once to catch up; missed intervals are not replayed.
If a service is unreachable, its coverage shows *offline* and it is retried at the next refresh.

Urgent inbox items raise a desktop notification when that is switched on in Settings, except during quiet hours.
On macOS they appear in Notification Center.
On Linux they go to the desktop's notification service (GNOME, KDE Plasma, mako, dunst and others) through `notify-send`, which comes with libnotify (`libnotify-bin` on Debian and Ubuntu, `libnotify` on Arch and Fedora).
Without `notify-send` or a running notification service, Attache keeps working and its log says `desktop notifications are off` with the reason; it says `desktop notifications are on again` once one answers.
On Windows they are Windows notifications from *Attache*, and they stay in the notification center like any other app's.
If notifications are turned off for Attache or for your account in Windows Settings (System > Notifications), or by your organisation's policy, Attache keeps working and its log says why.
Uninstalling removes Attache from the list of apps that send notifications.

## Credentials on Linux

On Linux, Attache keeps credentials in the Secret Service: GNOME Keyring, KWallet or KeePassXC, whichever your desktop runs.
It talks to it through `secret-tool`, which comes with libsecret (`libsecret-tools` on Debian and Ubuntu, `libsecret` on Arch and Fedora).
Each credential is an item labelled `Attache: <name>` with the attribute `service` set to `dev.attache.default`.

When no Secret Service is reachable as Attache starts, for example on a computer without a desktop, credentials go to `secrets.json` in the service state folder, a file only you can read.
**Settings → Service health → Credentials** shows which store is in use and, for the file, why.
The next time Attache starts with a Secret Service reachable, it moves the credentials from the file into it and deletes the file.

## Credentials on Windows

On Windows, Attache keeps credentials in Credential Manager, under **Windows Credentials** as generic credentials named `dev.attache.default/<name>`.
They stay on this computer and do not roam with your account.
A credential longer than Credential Manager holds in one entry continues in entries ending `#2`, `#3` and so on.

When Credential Manager does not work as Attache starts, for example in a logon without a loaded user profile or where your organisation blocks the tools Attache uses, credentials go to `secrets.json` in the service state folder.
That file, like the command line's `cli-token`, gets its own access list that lets only you in, even when the state folder is somewhere others can read, such as `D:\Attache`.
**Settings → Service health → Credentials** shows which store is in use and, for the file, why.
The next time Attache starts with Credential Manager working, it moves the credentials from the file into it and deletes the file.

## Backup, restore and uninstall

- **Backup:** Settings → Backup and export → *Create backup now*, or `attache backup` in a terminal.
  A backup contains your data folder and Attache's database (settings, jobs, drafts, receipts).
  Credentials stay in your Keychain (on Linux, the Secret Service; on Windows, Credential Manager) and are not included; after restoring elsewhere, reconnect your accounts.
- **Restore:** run `attache stop`, then `attache restore <backup.tar.gz> --data-folder <empty folder> --force`, then `attache start`.
  `--force` keeps the replaced database as a `.pre-restore` copy; without it, restore only writes into a fresh profile.
- **Uninstall:** `~/.local/bin/attache-uninstall` (on Windows, `%LOCALAPPDATA%\Attache\bin\attache-uninstall`) removes the app, the background service and the command line, removes Attache's hooks from each Harness, and keeps your data.
  `attache-uninstall --delete-data` also removes service state, stored credentials and the data folder, after asking you to type DELETE.
  Files you had before Attache are left alone, including notes already in the data folder you chose: only what Attache created there is removed.

## This Machine

Attache gives the computer it runs on an id and a name.
The name starts as the computer's hostname; change it in **Settings → Machines and Replication**.
The id never changes.
Session logs and connector snapshots carry the name in their file name, for example `evidence/sessions/2026-11-11-work-mac-3f9a2c1d.md`, so you can tell which computer wrote them.
Renaming the Machine affects files written from then on; earlier files keep their name.

Only one Attache service can use a data folder at a time.
The lock that enforces this lives outside the data folder, in `~/Library/Application Support/Attache/locks` on macOS and `~/.local/state/attache/locks` on Linux.

## Replication

Replication keeps the Brain the same on every Machine you run Attache on, through a private git repository.
It is off until you switch it on; a Brain on one Machine works exactly as before.
Each Machine needs git installed.
Setting up and joining check for it first, and when git is missing they say how to install it on that Machine: `xcode-select --install` or `brew install git` on macOS, the distribution's package manager on Linux, Git for Windows (https://git-scm.com/download/win or `winget install --id Git.Git -e`) on Windows.
On Windows, Attache also finds Git for Windows where its installer puts it, so you need not restart Attache after installing it.
Machines on macOS, Linux and Windows share one Brain.
The Brain's repository keeps every note with LF line endings, whatever git's own `core.autocrlf` setting is.
A note Attache writes on Windows has the same bytes on every Machine, and one an editor on Windows saved with CRLF reaches the other Machines with LF.

Replication is in the Dashboard under **Settings → Machines and Replication**, and in the terminal as `attache replication`.

- **Connect GitHub first** in the Dashboard's Connections.
  Replication reaches the repository with the GitHub connection's token, so its token needs Contents: read and write on the Brain's repository, besides what the GitHub source uses.
- **Switch it on** on the Machine that has your Brain: choose **Start with this Brain**, name the repository and select **Set up Replication** (or `attache replication setup owner/attache-brain`).
  Name an empty, private repository: `owner/name` on GitHub, a GitHub `ssh://` or `git@github.com:` address (which uses this Machine's ssh keys), or a folder path.
  A public repository is refused with a message that says so, and so is a repository on another host, because Attache can confirm that a repository is private only on GitHub.
  Attache makes the data folder a git repository, commits everything in it and pushes it.
  A repository that already holds a Brain is refused, so two Brains are never mixed.
- **Join** from another Machine.
  On a new Machine, open **Already use Attache on another Machine?** on the first setup screen, name the repository and select **Join into this folder**.
  On a Machine that is already set up, choose **Join another Machine** in Settings and name an empty folder for the Brain (or `attache replication join owner/attache-brain --data-folder ~/Documents/Attache`).
  The folder must be empty or not exist yet.
  A folder that is not empty may hold a Brain of its own, and Attache never merges two Brains, so the join is refused.
  Attache backs that folder up first, together with its database, to the `backups/` folder, and the refusal names the archive; it changes nothing in the folder.
  Move the folder aside or name an empty one, then join again; `attache restore` brings the backup back if you need it.
  Attache clones the Brain into it, makes it this Machine's data folder and builds its search index, so search works straight away.
- **Status:** the card says off, up to date, offline, unauthorized or blocked, when this Machine was last up to date, and when it last checked and last sent changes.
  When it is not up to date, the card shows the cause and what to do.
  **Check now** replicates straight away instead of waiting for the next check (`attache replication status` and `attache replication check` in the terminal).
- **Machines:** the card lists every Machine that shares the Brain, with when each last changed it.
  Rename this Machine under **This Machine**; the others show the new name after their next check.
  Tick **Standby** to let this Machine take over as Reader when the Reader goes silent, and choose the **Preferred Reader**, the Machine that should run Source refresh and briefings whenever it is online.
  Both are recorded in the Brain, in `machines/`, so every Machine reads the same; when two Machines choose differently at the same time, the later choice wins.
- **The Reader:** the list marks the Reader, the one Machine that runs scheduled Source refresh, briefings and the inbox items for facts past their Review date, so no source is read twice.
  The Machine that switched Replication on starts as the Reader; the Preferred Reader takes the role at its next check once you choose it, and whenever it comes back online.
  The other Machines read nothing on a schedule, and show the Reader's latest Source refresh on Connections and in the green line on Home.
  A Source refresh you start yourself with **Refresh now** still runs on the Machine you are on.
  The Reader says it is still there every 10 minutes through the repository, without adding to the Brain's history.
  A Reader that could not reach the repository for 30 minutes, because it was asleep or offline, shows as silent and reads nothing on a schedule until it is back; then it catches up once.
- **Failover:** when the Reader has been silent for 30 minutes, a Machine marked **Standby** becomes the Reader at its next check, so the inbox keeps moving while your always-on Machine is off.
  It takes over only if it has a source of its own connected, such as Slack or GitHub; the data folder does not count, because every Machine has it.
  A Machine that is not on standby, or has no source connected, never takes over.
  When the Preferred Reader is back online, it takes the role back at its next check and the standby stops reading on a schedule; you never switch it by hand.
  For a minute or so around a handover both Machines may refresh at once; the inbox still shows each item once, and each Machine's briefing is kept in a file of its own.
- **Switch off** stops replicating from this Machine (`attache replication off`).
  The Brain stays in the data folder with its history, saves carry on locally, and the other Machines keep their copies.
  Set Replication up again with the same repository to pick up where it left off: this Machine's changes from while it was off are sent, and the others' are merged in.

What happens on its own:

- A save is committed and pushed 30 seconds after the last write, so a burst of saves becomes one commit.
- Edits you make by hand in an editor are committed and pushed too.
- Every minute, at start and when the Machine wakes, Attache fetches the other Machines' changes and merges them; search includes them as soon as they arrive.
- Each commit message names the files that changed, what changed in them (for example `added Owner, corrected Status, added an event`) and the Machine.
- Offline, saves and search carry on as usual; the status reads offline, and the Machine catches up by itself when the repository can be reached again.
- A failing Replication never fails a save.
- Attache merges and never rebases or force-pushes, so nothing another Machine pushed is ever rewritten.
- A note is never left with conflict markers, and no merge waits for you.
- If the service stops in the middle of a merge, for example in a crash or a power cut, it abandons the half-done merge when it starts again, leaves the folder as it was before, and merges again.
- A note you delete, in Attache or in an editor, disappears from every Machine and from their search.
- When two Machines changed the same note while apart, its facts merge by subject.
  A fact only one Machine changed keeps that change.
  When both changed the same fact, the value with the newer date wins on every Machine, with its Review date; the other value goes to the note's History, naming the Machine it came from.
  On the same date, every Machine picks the same winner (the one whose Machine id sorts last).
  History keeps every line from both Machines, once each.
  The frontmatter merges field by field: the earliest `created`, the latest `updated`, lists such as `tags` and `sources` keep every item.
- Two notes with the same type and title, created on two Machines, become one note with the facts and History of both.
- A note deleted on one Machine and changed on another before they saw each other's change is kept, with the change, on every Machine.
  One inbox item, which every Machine shows, names the note and both Machines; delete the note again if it should go.
- The free text of a note, such as its Notes section, merges line by line: when the two Machines changed different lines, both changes are kept.
  When both changed the same lines, the note keeps both versions, each under a heading such as `### Version from Mac`, and Replication carries on with every other file.
  One inbox item, which every Machine shows, names the note.
  Keep the version you want and delete the other with its heading, in an editor on any Machine; the item then resolves by itself.
  A note that gets two versions again later raises the item again.
- Any other file both Machines changed in the same place, outside the notes and Attache' own review files, blocks Replication, and the cause names it; edit the file on one Machine to match the other and Replication carries on.
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

Files that belong to one computer stay out of the repository: Attache's own `.attache/` folder, temporary files, `.DS_Store` and Obsidian's workspace layout.

### Credential scan

Before every commit, setup and merges included, Attache scans the files about to be committed for credentials.
It looks for exactly what it redacts from logs and evidence: GitHub, Slack, Atlassian, AWS, Google and Anthropic tokens, API keys, JSON web tokens, private keys, authorization headers, and the secrets of your connections.
A finding stops the commit and the push: the status reads blocked, and the cause and the inbox item name the file and line, never the credential itself.
Saves and search keep working on this Machine meanwhile, and the other Machines keep replicating with each other.
Everything already committed stays in the repository and on the other Machines.
Remove the credential from the file, by hand or with a save, and Replication continues by itself at the next check.
If you corrected the fact with a save, the old value is still in the note's History, so remove it there too.
A credential that is in the repository's history already does not hold back later edits to its file, but it is still there: rotate it, and purge it from the history by hand if you need to (see [Deleted notes stay in git history](#deleted-notes-stay-in-git-history)).

### Private repository and token

The repository holds the whole Brain in plain text, so Attache keeps checking that it is private:

- Attache asks GitHub whether the repository is private at setup, at join, and again before pushing once the last answer is five minutes old.
  A repository that has turned public blocks pushing and reads as blocked; make it private again and Replication carries on by itself.
- The token stays in the secret store.
  Git gets it from Attache's credential helper (`attache git-credential`) each time it reaches GitHub, so it is never part of the repository's address, its `.git/config`, a command line or the logs.
  Your own git credential helpers are not used for the Brain's repository.
- When GitHub rejects the token, the status reads unauthorized and the inbox asks you to reconnect GitHub; once you have, Replication carries on.

### Deleted notes stay in git history

Deleting a note removes it from the Brain, not from the repository's history: every earlier version stays in git, on GitHub and on every Machine's copy.
Attache never rewrites history, so it cannot erase it for you.
To purge a note that must not be kept, for example one holding a secret:

1. Check that `attache replication status` says up to date on every Machine, so nothing is waiting to be pushed, then run `attache stop` on every Machine.
2. On one Machine, clone the repository into a new folder outside the data folder and rewrite its history without the file, for example with [git filter-repo](https://github.com/newren/git-filter-repo): `git filter-repo --invert-paths --path memory/notes/the-note.md`.
   filter-repo removes the clone's remote, so add it back (`git remote add origin <repository>`) and run `git push --force origin main`.
   On GitHub, branch protection must allow the force-push, and GitHub support can remove cached views of old commits.
3. On every Machine, in the data folder, replace the old history with the rewritten one: `git fetch origin`, `git reset --hard origin/main`, `git reflog expire --expire=now --all` and `git gc --prune=now`.
   Otherwise the next merge would bring the old history back.
4. Run `attache start` on every Machine, and delete the clone from step 2.

A secret that was ever pushed should be treated as exposed: rotate it as well.

## Where things live

| What | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Your knowledge (Markdown) | The data folder you chose | The data folder you chose | The data folder you chose |
| Service state (settings, jobs, drafts, receipts, logs, backups, this Machine's id and name, the search index and its vectors) | `~/Library/Application Support/Attache/state` | `~/.local/state/attache` | `%LOCALAPPDATA%\Attache\state` |
| Meaning model, once downloaded | `models` in the service state folder | `models` in the service state folder | `models` in the service state folder |
| Writer locks (one per data folder in use) | `~/Library/Application Support/Attache/locks` | `~/.local/state/attache/locks` | `%LOCALAPPDATA%\Attache\locks` |
| Credentials | macOS Keychain, service `dev.attache.default` | Secret Service, service `dev.attache.default`; `secrets.json` in the service state folder, readable only by you, when none is reachable (see [Credentials on Linux](#credentials-on-linux)) | Credential Manager, generic credentials `dev.attache.default/<name>`; `secrets.json` in the service state folder, readable only by you, when it cannot be used (see [Credentials on Windows](#credentials-on-windows)) |
| App | `~/Library/Application Support/Attache/current` | `~/.local/share/attache/current` | `%LOCALAPPDATA%\Attache\current` |
| Command line | `~/.local/bin/attache`, `~/.local/bin/attache-uninstall` | `~/.local/bin/attache`, `~/.local/bin/attache-uninstall` | `%LOCALAPPDATA%\Attache\bin\attache.cmd`, `%LOCALAPPDATA%\Attache\bin\attache-uninstall.cmd` |
| Background service | `~/Library/LaunchAgents/dev.attache.service.plist` | `~/.config/systemd/user/attache.service` | the task `Attache` in Task Scheduler |
| Harness hooks | `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.gemini/config/hooks.json` (only the entries Attache added) | the same | the same, under `%USERPROFILE%` |
| Harness MCP server | `~/.claude.json`, `~/.codex/config.toml`, `~/.gemini/config/mcp_config.json`, `~/Library/Application Support/Claude/claude_desktop_config.json` (only the `attache` entry) | the same, with Claude Desktop's in `~/.config/Claude/claude_desktop_config.json` | the same, under `%USERPROFILE%`, with Claude Desktop's in `%APPDATA%\Claude\claude_desktop_config.json` |

The command line offers `status`, `start`, `stop`, `pair`, `search`, `audit`, `evaluate-recall`, `replication`, `update`, `mcp`, `agent-hooks`, `backup` and `restore`.
`attache update --check` looks for an Update now and says which version this Machine runs, its Update channel and the newest version it may take, without installing anything.
`attache agent-hooks status` lists the hooks and MCP servers Attache added to your Harnesses.
On Linux, setting `XDG_DATA_HOME`, `XDG_STATE_HOME` or `XDG_CONFIG_HOME` moves the app, the state or the service definition.
`attache paths` prints every one of these locations for the computer it runs on, and `attache service status` says whether the background service is loaded.

## Troubleshooting

- *Attache service is not reachable:* the Dashboard says so, with **Retry**; run `attache status`, and `attache start` if it is not running.
  `attache service status` says whether the background service is loaded.
  Reinstalling repairs the service without touching data.
  Logs: `logs` in the service state folder (`~/Library/Application Support/Attache/state/logs` on macOS, `~/.local/state/attache/logs` on Linux, `%LOCALAPPDATA%\Attache\state\logs` on Windows).
- *Pairing code expired:* run `attache pair --open`.
- *A connection says "Sign-in needed":* its sign-in was rejected or expired, so it moves to **Needs you** at the top of Connections, open, with a **Sign-in needed** box saying what to fix.
  For a claude.ai connector, reconnect it in claude.ai → Settings → Connectors, or run `claude` once and sign in if Claude Code itself is signed out, then press **Reconnect** in its row.
  Reconnect tests the connection again and says what is still wrong if it fails.
  Once it succeeds, Attache refreshes that source straight away, so the row goes back to its group without the failed Source refresh.
  Right after connecting a connector in claude.ai, Claude Code can keep reporting it as unauthenticated for a few minutes; press **Reconnect** again shortly.
  For an API token, **Reconnect** opens the form so you can enter a new token.
  If you chose **Sign in with Atlassian** directly, sign in again in its row.
- *Slack, Gmail or Calendar says Claude Code settings auto-approve its tools:* remove the listed `permissions.allow` rule from `~/.claude/settings.json`.
  Attache approves every connector call itself and will not run while a rule would skip that check.
