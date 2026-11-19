# Attache

Attache is a personal assistant that keeps one person's knowledge and brings forward what needs their attention.

## Language

### Sharing the Brain

**Brain**:
The body of knowledge Attache keeps for one person: curated memory, evidence and deliverables.
_Avoid_: Vault, second brain, data folder (the folder is where one Machine keeps its copy)

**Machine**:
A computer that runs Attache and holds a copy of the Brain.
_Avoid_: Node, device, instance, client

**Replication**:
Keeping every Machine's copy of the Brain the same.
It is opt-in, and a Brain that lives on one Machine does not need it.
_Avoid_: Sync, backup

**Source refresh**:
Reading new activity from connected sources such as Slack, Gmail and Jira into the Brain.
_Avoid_: Sync, poll, fetch

**Reader**:
The Machine that is running Source refresh and briefings right now.
Only one Machine is the Reader at a time.
_Avoid_: Primary, master, leader, server

**Preferred Reader**:
The Machine that should be the Reader whenever it is online.
_Avoid_: Primary Reader, main machine

### Using Attache

**Dashboard**:
Attache's own screen, which shows the Brain and the Inbox and takes the owner's decisions.
Its screens are Home, Approvals, Brain, Connections, Jobs and Settings.
It holds no conversation.
_Avoid_: Chat, app, UI, web client

**Search the Brain**:
Finding passages in the Brain from the Dashboard: the field at the top of Home, the Brain screen, and `Ctrl K`, `Cmd K` or `/`, which open the search palette off Home.
Each result is a passage with its title, kind, file and lines, ranked by meaning and keywords, or by keywords only until meaning-based search is ready.
It is a read: it starts no job, changes nothing and holds no conversation.

**Library**:
The Brain screen's view for reading: the collections, the notes in one collection, and the note reader beside them.
Search results take its place while a query is typed.

**Recent saves**:
The Brain screen's view of every change to the Brain, newest first, with where each came from and whether Revert can undo it.
It filters to all changes, those written without review, or those reverted.

**Job**:
Background work the service runs and records, such as research, a briefing, a Draft's preparation or a Source refresh.
It keeps running when the browser closes; the Jobs screen lists it under Running until it ends, then under Finished.
A job that failed or is blocked is named with its reason; Cancel reports whether the work stopped or had already finished.

**Search palette**:
Search the Brain in a dialog over any screen but Home, opened by `Ctrl K`, `Cmd K`, `/`, the masthead's Search or the bottom bar's Search.
It shows the same results as Home's field, after a **Go to** group of the screens and Settings sections whose names match what was typed.
_Avoid_: Command palette, quick open

**Settings section**:
One page of Settings, at its own address under `/settings/`, such as Identity or Machines and Replication.
Settings lists its nine sections in four groups, Attache, Brain, Machines and Service, and shows one at a time; each setting and action is in exactly one section.

**Attention dot**:
The brass dot on the logo, and beside a count in the Dashboard, that shows something waits for the owner's decision.
It follows the Decision count, also on the favicon; a part that could not be read never turns it on or off.
It never means new, unread, changed or offline.
_Avoid_: badge, notification dot, unread dot

**Pairing**:
Giving one browser, the command line or a Harness's MCP server its own access to the Attache service on this computer, with a one-time code.
A paired browser stays paired until the owner removes it in Settings.

**Setup**:
The five steps that make a Machine ready: data folder, features, Connections, model and schedules, then test and finish.
Only the data folder is required, and a Machine can instead join the Brain another Machine keeps.
Setup resumes at the step the owner left.

**Harness**:
The agent application the owner talks to, such as Claude Code, Claude Desktop, Codex or Antigravity.
It is where the owner asks about the Brain and adds to it.
_Avoid_: client, coding agent

**Connection**:
Attache's access to one outside service or Harness, such as Slack, GitHub, a model or Claude Code, with what it may read and write.
The Dashboard's Connections page lists them, and every place that names the page calls it Connections.
On that page each Connection is one row in its group (Notes, Work sources, Harnesses, Model) with its account, what it may read and write, and when Attache last read it; one not set up is a small tile, and one that needs sign-in moves to a "Needs you" group at the top, already open.
Home's Connections area shows only the Connections that need a look, each with its state word, such as Sign-in needed, Down or Not read yet, and the page uses the same words.

**Agent**:
The AI working inside a Harness on the owner's behalf: it searches the Brain, saves to it and runs the audit.
The Harness is the application; the agent is what runs in it.

### Keeping the Brain true

**Proposal**:
A suggested change to the Brain that waits for the owner's decision.
_Avoid_: Suggestion, pending change, draft

**Consolidation**:
Attache reading finished work, such as a Harness session or a meeting capture, and writing what it learns to the Brain.
When the owner switches Consolidation off, it makes Proposals instead.
_Avoid_: Distillation, auto-save, learning

**Correction**:
A change that gives a current fact a different value; the old value moves to the note's History with the reason.
A fact that is only mentioned or repeated is not corrected.
_Avoid_: Overwrite, fix, edit

**Review date**:
The day after which a fact should be checked again.
A fact past its Review date stays in the Brain and is shown as unverified.
_Avoid_: Expiry, expiration, stale date, TTL

**History**:
The part of a note that keeps replaced values and events, in the words and order they were written.
It only grows, and the Dashboard shows it exactly as stored.

**Change log**:
Attache's own record of every change to a note: what changed, who or what made the change, and why.
Recent saves and Revert read it; the note itself carries History instead.

### What needs the owner

**Inbox item**:
Something from a connected source that may need the owner, such as a review request, a pending reply or a deadline.
_Avoid_: Attention item, alert

**Inbox type**:
What an Inbox row shows an item to be: an explicit word such as "Review request", a glyph and a colour, from the item's kind and, where the kind alone is not enough, its source (a Slack DM against a Gmail reply).
Types belong to families (Deadlines, Reviews, Replies, Mentions, Meetings, Work items, Facts to check, System) for Group by type; a kind the Dashboard does not know shows under Other with a readable word.
_Avoid_: Item category

**Decision keys**:
The single keys that decide on the focused Inbox row: `d` Done, `s` Snooze, `x` Dismiss.
They are off until the owner switches them on in the shortcut sheet, and no key ever applies, approves, sends, rejects, reverts or disconnects.
_Avoid_: Hotkeys

**Draft**:
A message Attache prepared for the owner to send through a Connection.
Nothing is sent until the owner approves that exact version.
Each Draft has its own page under Approvals; saving new text makes the next version and replaces the old text.
A rejected Draft is locked: only Restore brings it back, as the next version, until it expires.
_Avoid_: Outgoing message

**Delivery unconfirmed**:
The label on an Inbox item whose last Draft was sent but whose outcome could not be verified, so the message may or may not have arrived.
The open item leads with Check destination; preparing a replacement Draft is a separate, explicit choice, and checking alone never sends, resolves the item or claims delivery.

**Approvals**:
The Dashboard page that holds everything Attache prepared that waits for the owner's OK: Drafts to send and Proposals to apply.
It is a page name only: the owner approves one exact version of a Draft, and applies or rejects a Proposal.
Its Waiting tab holds Drafts to send and Changes to the Brain (and In progress, Drafts being sent); its Finished tab what happened to the rest.
_Avoid_: Drafts page

**Heads-up**:
Something Attache brings forward before the owner knows they need it, such as the daily briefing or meeting prep, shown while it is timely.
Every Heads-up says why it is here and when it leaves; "Got it" puts it away in this browser.
A meeting prep Heads-up is a view of its Inbox item, not a second item: "Done" decides the item, "Not now" hides only the Heads-up.

**Meeting prep**:
An Inbox item for a meeting with other people, open from 24 hours before it starts until its scheduled end, carrying the meeting's start, end, call and attendees.
From 15 minutes before the start it shows in For you now instead of the Inbox, with Join first once the meeting runs.
A meeting that ends while the pointer or keyboard is on it shows "Meeting ended" in its place until the owner moves on, and a row the keyboard is on when its meeting moves up says "Moved up to For you now"; neither has anything to press.
_Avoid_: Occupant, nudge

**For you now**:
The area on Home that shows the Heads-ups that are timely now, the most urgent one leading, or one quiet line when none is.
_Avoid_: Proactive area

**Briefing**:
A short summary Attache writes of what changed, what needs the owner and what is prepared: the daily briefing on a schedule, or an Away summary or a briefing the owner asked for.
The daily briefing is a Heads-up until noon; one the owner asked for, for four hours.
_Avoid_: Digest

**Decision count**:
The number of decisions that wait for the owner on this Machine, behind the Attention dot, the tab title and the numbers in the navigation.
It has three parts: open Inbox items whose Draft does not wait (Home), Proposals and waiting Drafts (Approvals), and Connections that need sign-in (Connections).
Each decision counts once, so an Inbox item whose Draft waits counts as the Draft.
The service counts every part exactly, however many decisions wait.
When it cannot, the Dashboard counts the lists it has, and a part that could not be read fully makes the count a lower bound, written "12+".
_Avoid_: unread count, badge count

**Open item**:
An Inbox item in the open state, whether or not its Draft waits.
Open items and the Decision count differ by the items whose Draft waits in Approvals, so the Dashboard says "need you" only of decisions.
The count line under the Inbox heading relates the two when they differ.

**Recently added**:
The line under Home's Inbox that opens into every change written to the Brain without the owner's review in the last 7 days: saves a Harness wrote with auto-accept on, and Consolidation's changes, each with Revert where allowed.
Nothing there is a decision, so it never counts toward the Decision count.
_Avoid_: Unread item
