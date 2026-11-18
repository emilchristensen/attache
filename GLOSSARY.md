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
Keeping every Machine's copy of the Brain, and the owner's Preferences, the same.
It is opt-in, and a Brain that lives on one Machine does not need it.
_Avoid_: Sync, backup

**Preferences**:
The owner's choices about how Attache looks and behaves, such as how Home is arranged, which follow the owner to every Machine.
What belongs to one Machine, such as its sign-ins or whether it is the Reader, is that Machine's configuration and not a Preference.

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
It holds no conversation.
_Avoid_: Chat, app, UI, web client

**Widget**:
One area of Home that the owner can place, resize, add and remove, such as the Inbox or Your day.
_Avoid_: Gadget, applet

**Harness**:
The agent application the owner talks to, such as Claude Code, Claude Desktop, Codex or Antigravity.
It is where the owner asks about the Brain and adds to it.
_Avoid_: client, coding agent

**Connection**:
Attache's access to one outside service or Harness, such as Slack, GitHub, a model or Claude Code, with what it may read and write.
The Dashboard's Connections page lists them, and every place that names the page calls it Connections.
Disabling a Connection takes that access away, sign-in included, until the owner sets it up again.

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

### What needs the owner

**Inbox item**:
Something from a connected source that may need the owner, such as a review request, a pending reply or a deadline.
_Avoid_: Attention item, alert

**Draft**:
A message Attache prepared for the owner to send through a Connection.
Nothing is sent until the owner approves that exact version.
_Avoid_: Outgoing message

**Daily Briefing**:
The summary Attache writes each morning of what needs the owner, what changed and what the day holds.
Every place that shows it titles it "The Daily Briefing".
_Avoid_: Morning briefing, Wednesday Brief

**Heads-up**:
Something Attache suggests the owner do now, before they would have thought of it, such as answering a reply that is nearly late or reading the prep for a meeting about to start.
It is shown while it is timely.
_Avoid_: Occupant, nudge
