# Attache Dashboard

Home is a reading desk for a single working day.
Search has the largest type and its own field; timely information gets one illustrated spread; recurring work reads like a ruled index.
The owner can recognize a request from its left edge and decide whether to read its subject.

## Navigation and attention

The masthead carries the original briefcase, Attache, Home, Approvals, Brain, Connections, Jobs and Settings.
On narrow screens Menu opens the same destinations with counts and current location.
Each destination has a stable URL; preserve legacy links to notes, Drafts and Proposals with redirects.
Preserve the two-key navigation chords g then h/m/d/j/c/s for Home, Brain, Approvals, Jobs, Connections and Settings respectively.
Ignore chords during text entry, composition and modal interaction and provide a switch to disable them.

| Destination | What belongs here |
| --- | --- |
| Home / | Brain search, Heads-ups, Connection exceptions, Inbox, Recently added and three-day Away summary |
| Approvals /approvals | Decisions on outgoing Drafts on this Machine and replicated Proposals, with sending and finished work below |
| Brain /brain | Read-only notes, imported material, archived evidence, deliverables, Recent saves and their provenance |
| Connections /connections | Source refresh coverage, access, Harness installation and available Connections |
| Jobs /jobs | Background progress and cancellation |
| Settings /settings | Identity, features, local operation, storage and sharing |
| Setup /setup | Pairing, five resumable setup steps and join-existing-Brain entry |

Compute all badges from one snapshot of decision identities.
Home counts open actionable Inbox keys plus timely standalone Heads-ups with an outstanding decision, such as the morning briefing, once per briefing ID and browser.
Meeting prep retains its Inbox key in either position.
Approvals counts each Draft needing approval, reapproval or an available Send decision, and each undecided Proposal once.
Executing and finished work contribute zero.
An Inbox decision and a Draft decision have separate identities even when their subjects match.
Connections counts distinct incidents with a concrete remedy such as reconnecting or retrying a failed check.
While the first read runs, show coverage as pending with zero decisions.
When a replicated Inbox notice calls for the same reconnect, assign that decision to Connections, label the Inbox row “Counted in Connections” and link the remedy.
Omit counts from informational Brain, Jobs and Settings links.
With four Inbox items, one briefing, two approvals and healthy Connections, the parts are 5 + 2 + 0 and the title reads “(7) Home | Attache”.
Badge text includes its destination and count for assistive technology.
Mark the brand link with the total accessible name.
Keep the original SVG path, fill, aperture and proportions; display its supplied dot when total is positive and hide only the independent dot layer at zero.
Use the same mark on the favicon and the same positive total prefix on the title, omitting it at zero.
Never use that dot for network state or unread activity.
Retain the last verified count during a failed request and label its age in the navigation details; on first load an unavailable number reads “Unknown”.

## Home and search

At desktop sizes cap the reading surface at 1072 px inside 36 px gutters.
A quiet date locates the owner above Search the Brain.
The field spans the content width, with a magnifier and visible Ctrl K hint.
Typing searches passages inline; Enter opens the selected passage and Escape clears results before returning focus to the field.
Outside Home, Ctrl K or the navigation search command opens the same results in a named modal and Escape returns focus to the opener.
Keep the query and highlighted passage while following evidence and returning.
Show title, area, section, path and line range; distinguish Current state, History and body, include session logs and exclude raw transcripts and review records.
Show “Unverified” beside facts past their Review date.
Explain keywords-only ranking and the reason while meaning search is unavailable.
The Dashboard has no conversational input.

### For you now

Every Heads-up provides a kind, subject, reason, start and end, primary action and dismissal policy.
Give new kinds the same contract and require an explicit rank and stable key.
The morning briefing runs from its scheduled local morning delivery until local noon as a design default.
Lead with one concrete development; the full briefing gives one point per line about changes, judgment needed and prepared work, with linked counts to Inbox groups or Approvals.
Got it records the briefing ID in browser storage; Not now suppresses this occurrence for the session and leaves the underlying work open.
Away summary remains available after the briefing leaves.

A meeting is eligible on [start minus 15 minutes, scheduled end), in the owner's local time.
Show its subject, reason, scheduled interval, participants and relevant notes in prep detail.
Use the event's actual Google Calendar URL and Meet conference URL as separate links; omit Join when there is no call and lead with Calendar event.
During the meeting lead with Join and “In progress, ends 14:30”.
At 14:20 a 14:00-14:30 meeting appears first and its 14:30 successor second, followed by any timely briefing.
Break ties by start time then stable key.
Done sends the Inbox Done decision; Not now hides only this occurrence and its open row becomes available in Inbox.
Natural expiry removes the promotion and the underlying item's service state determines its Inbox visibility.
With zero timely entries, reserve only a text line beside the section name.

### Connections on Home

Successful coverage compresses to “Connections · All working” and a details link.
Require at least one configured source and known successful reads before displaying success.
With no sources show “No sources connected” and Connect a source.
For exceptions name only the affected source, cause, last successful read and next action.
Distinguish offline, partial read, sign-in needed, first read pending and could not check.
A failed status request says “Coverage unknown”; continue displaying the last verified Inbox and its timestamp.
On a heavy day group by remedy with an explicit expand control and a total.

### Inbox

The index has a shape and kind word on the left, a subject and source in the middle, and an absolute time on the right.
Narrow screens put type above the subject and wrap metadata below it.
Keep distinct kind words even for items from the same connector.
Use the service kind together with the source to distinguish a Slack mention from a GitHub mention.
Use its why, due time, evidence label, observed time, source URL or file and line range on the item's detail page.

| Kind | Ink family | Icon and visible word |
| --- | --- | --- |
| review_request | Blue | Branch fork · Review request |
| authored_pr | Blue | Pull request with owner silhouette · Authored PR |
| assigned_issue | Green | Square checklist · Assigned issue |
| pending_reply | Rust | Envelope with return arrow · Pending reply |
| mention | Plum | At sign · Mention |
| slack_dm | Plum | Speech bubble · Slack DM |
| slack_mention | Plum | At sign in bubble · Slack mention |
| invite_response | Green | Calendar with question · Invite response |
| deadline | Rust | Clock · Deadline |
| jira_work_item | Blue | Ticket · Jira work item |
| meeting_prep | Blue | Calendar with notes · Meeting prep |
| Fact past Review date | Green | Dated page · Fact to check |
| Replication notices | Rust | Split document or blocked arrows · Conflicting versions, deletion conflict, blocked Replication or reconnect |
| Unregistered kind | Neutral | Document · Human-readable kind, with source below |

Expose the familiar deadlines, review queue, meetings, pending replies and facts to check as group filters alongside individual kinds.
Default ordering follows priority, due time and stable ID with a bounded page of 20; keep filters, scroll anchor and page across detail visits.
Show the visible range, filtered total and Load more on heavy days.
Dismiss holds until evidence changes, Snooze asks for a local return time, Done resolves, and the decision history allows Reopen.
Mark “Changed since your decision” explicitly.
Prepare draft starts a Job only when the item is draftable; View draft replaces it for all four open action statuses.
The item remains available for its own Inbox decisions.
A terminal Draft restores Prepare draft and remains in Finished on this Machine.

Recently added sits below Inbox, newest first, limited to seven days of auto-accepted Harness changes and Consolidation.
Show note, fact or event, struck-through prior value and named new value, reason, origin, timestamp and Revert eligibility.
Exclude confirmed saves and applied Proposals here and retain a reverted row with its status until it ages out.

## Approvals

Use one queue with Draft and Proposal sections, then Sending and Finished, searchable by source, Machine and outcome.
Draft detail opens with destination, verb, exact payload and version; place the originating item, evidence, context, expiry, event history and final receipt below.
Editing increments the version and cancels prior approval.
Approve vN binds the displayed payload for 15 minutes; only a subsequent Send sends.
Render the expiry as a wall-clock time rather than a ticking countdown.
If write authorization is missing, explain the missing permission and link to that Connection.
Revalidate nonce, version, expiry, target and permission on the service immediately before execution.
Draft lifetime is 48 business hours.

| Contract status | Placement and behavior |
| --- | --- |
| draft | Waiting, Edit, Reject or Approve vN; after approval timeout show when it ended, “Nothing was sent” and Approve vN again |
| approved | Waiting, approved version and expiry, Send if executable, revoke or edit |
| revoked | Waiting, show why approval ended and allow review and approval again |
| executing | Sending, lock duplicate submissions and show pending confirmation |
| succeeded | Finished, Sent with remote receipt |
| rejected | Finished, Rejected with decision time |
| expired | Finished, Expired with lifetime and no send |
| failed | Finished, show service reason and source item |
| unknown | Finished, delivery unconfirmed, inspect destination before preparing another Draft |

Proposal detail names the originating Machine, reason, target or new note, every fact, old and new values with reasons and Review dates, events, notes, tags and quoted line-linked evidence.
Apply writes the entire change atomically and moves replaced values to History; Reject writes no change to the note.
Explain dropped past Review dates in History.
On a conflict keep the full visible change and refusal reason, disable stale Apply and offer Reject.
Exclude identity changes.
Replication may settle a newer decision from another Machine; show its time, origin and outcome, including events retained in History.

## Brain

Browse People, Projects, Decisions, Notes, imported notes, Evidence and Deliverables.
Use a simple title index and a dedicated read-only reader, with Current state first, dated entries per subject, Review dates, provenance, links, History and the original path.
Imported material retains its own document structure.
Allow line-range deep links into citations, including session summaries, meeting captures, wrap-ups and archived connector evidence.
Recent saves spans every origin including the owner and applied Proposals and shows old/new values, reason, Machine, Harness, session or capture and time.
Label auto-accepted and consolidated changes distinctly.
Revert restores the previous fact as a Correction, moves an added fact to History, removes a newly created note with its bundled changes, or restores a removed note.
Record the revert as its own revertible change, and mark earlier rows reverted.
Events stay in History; explain an unavailable Revert when a newer change or outside edit superseded it.
For changes to curated notes direct the owner to their Harness or Markdown editor.

## Connections, Jobs and Settings

Connections opens with the Reader Machine and the time it last refreshed every source.
Each source records last success, last attempt and complete, partial or failed coverage with cause and Refresh now on this Machine.
Group configured sources before available sources, then Harnesses and model access.
Support GitHub, Slack, Gmail, Google Calendar, Jira and Confluence; explain admin prerequisites before connecting.
Start read-only, show identity and per-action write grants, test, reconnect and disconnect.
Route claude.ai connector repair to its settings, distinguish local Claude sign-in, auto-approve rule conflicts and remote workspace permission, and retest after reconnect.
Jira and Confluence also accept an Atlassian site and direct sign-in or API token.
After successful reconnect refresh immediately.
Harness cards cover Claude Code, Codex, Antigravity and Claude Desktop with a file-change preview, backup location, MCP server and applicable hooks, parse failure reason, Codex hook trust instructions and selective disconnect.

Jobs separates queued/running work from history for research, briefing, Draft preparation and Source refresh.
A detail shows service progress, timing, error or output, and Cancel with an explicit stopped versus already-finished outcome.
Reconnect using the job ID when returning to the page.

Settings uses named sections with anchor links and independent saves.
Identity owns the owner's identity record.
Features exposes saving, background work, attention and briefings, approvals and agent sessions with dependency previews and the consequences of disconnecting session hooks.
Auto-accept is per connected Harness on this Machine; Consolidation is a separate setting for sessions and meeting captures that switches between immediate writes and Proposals.
Model offers local Claude Code, Anthropic key and OpenAI-compatible endpoints including local servers.
Schedules includes refresh cadence, briefing time, urgent notifications, quiet hours and service availability after wake.
Meaning-based search offers the local model download, size, downloading, building, ready and failed with retry and keyword fallback.
Service health shows service reachability and credential store with the reason for local-file fallback.
Backup and export includes Create backup now, contents, destination, credential exclusions and restore instructions.
This Machine exposes name, stable ID and data folder; preview folder selection before adoption.

Replication offers enable with private GitHub repository, join into an empty folder, backup and refusal details, Check now and Switch off.
List Machines, last changes, Reader, Preferred Reader, Standby and last contact; explain silent Reader, automatic takeover and catch-up.
Display off, up to date, offline, unauthorized and blocked with last check, last send and last up-to-date time.
Name the offending file and line for credential checks without revealing the secret.
Explain private-repository failures, missing git, reconnect, deletion conflicts and two-version notes with an editor resolution path.
A blocked commit does not prevent local saves or search.

## Setup and service recovery

Pair the browser using the one-time code; an expired code offers the exact recovery command `attache pair --open`.
Start with Data folder and a non-destructive preview including an existing notes folder or Obsidian vault, or Join another Machine.
Next select Features and dependencies, optional Connections and Harnesses, then Model and schedules.
Test and finish reports ready, partial, needs setup or unavailable per feature and allows a notes-only workspace.
Preserve completed steps after navigation or failure and link each issue to its step.
Service unreachable uses a persistent banner, the last verified data, Retry and local status/start instructions.

## Screen states and stability

| Screen | Empty | Loading | Failed request | Heavy day |
| --- | --- | --- | --- | --- |
| Home | Compact Heads-up line, verified clear Inbox or explicit incomplete coverage | Reserve search, section headings and a fixed snapshot placeholder | Keep previous items and name the unavailable source with retry | Ordered Heads-ups, exception summary, type filters and paged Inbox |
| Search | Recent context before typing; no passages after a miss with Clear query | Retain prior result height and mark searching | Keep query and prior citations with Retry | Page passages and group adjacent hits by document |
| Inbox detail | Item resolved elsewhere with return link | Reserve title, evidence and decision region | Preserve decision and snooze inputs and allow retry after revalidation | Fold long evidence below first citation |
| Approvals | No waiting decisions with Finished still available | Named queue placeholder | Keep snapshot and disable unverified decisions | Separate Drafts, Proposals and Finished with independent pages |
| Draft or Proposal detail | Missing or finished with return link and outcome | Static payload placeholder, no live actions | Retain version, edits and conflict explanation | Long payload scrolls in document order with jump links to evidence and decisions |
| Brain and note | Named empty collection or removed note | Reserve index and text widths | Keep text and provenance with stale label | Filter collection, page saves and collapse older History |
| Connections | Available sources and notes-only explanation | Checking coverage by source | Last success plus unknown coverage | Group exceptions first and collapse healthy source details |
| Jobs | No work running, history available | Reserve progress rows | Last observed state with reconnect | Page history separately from running work |
| Settings | Defaults and explicit unconfigured values | Load each section separately | Keep unsaved fields and inline retry | Section index, disclosure for diagnostics and Machine lists |
| Setup and pairing | Explain the next required input | Named test in progress | Preserve safe entries and retry failed step | Expand per-source results only on demand |

Pin the rendered list snapshot while it is visible.
Reserve a status line on populated live views for “Updates available” and a user-triggered refresh.
Insert new records only on that refresh, on navigation or on a new foreground visit with no active reading position.
At an eligibility boundary replace expired Heads-up content in place with a same-size inert “Meeting ended” placeholder until reconciliation; offer the newly eligible Heads-up via the reserved update control.
For the in-progress transition reserve the action footprint in advance and update the time text in place without moving focus.
Use the same approach for decisions made on another Machine and timed-out approvals, checking eligibility again on activation.
After an explicit local action focus the next surviving item or its section heading and announce the result once.
Never reorder rows because a network response arrived.
Use timestamps, fixed-width count slots, intrinsic media dimensions and local font fallbacks to avoid incidental shifts.

## Visual language

The paper background is warm, the text has a blue-black cast and the briefing has a low sun etched into its outer margin.
In dark mode the paper becomes deep green slate and the briefing becomes amber-brown.
The illustration is a decorative CSS contour with no semantic role.
Georgia gives search, section names and briefing subjects an editorial cadence; system sans keeps actions and subjects plain; system monospace aligns dates, type captions and keyboard hints.
Use 58/66 px for the desktop page title, 32/38 for featured subjects, 29/35 for sections, 16/23 for body and 13/19 for metadata.
At phone width the title is 38 px and sections are 26 px.
Use a 4 px base with 8, 12, 16, 24, 36 and 48 px intervals; 6 px control corners, 10 px feature corners and flat list rows.
Use one 19 px rounded stroke icon in each type stamp with a written label and a separate source line.
Keep the primary action solid, secondary actions outlined and navigation links underlined where context needs it.
Use instant page changes, no auto-advancing cards, shimmer, repeated pulse or animated resorting.

### Contrast measurements

Ratios use WCAG relative luminance in sRGB.
The values below use the specified adjacent background in each theme; colors for paper, canvas and the feature spread are included directly in the table.
Subtle row rules and illustration lines are decorative; functional boundaries and focus rings use the stronger tokens.

| Role | Light foreground / background | Ratio | Dark foreground / background | Ratio |
| --- | --- | ---: | --- | ---: |
| Text on canvas | #192d32 / #f7f6ef | 13.25 | #f6f3de / #192628 | 13.93 |
| Text on paper | #192d32 / #fffef8 | 14.21 | #f6f3de / #202f32 | 12.41 |
| Secondary on feature | #46595b / #f7dfaf | 5.68 | #c0d0c9 / #43351e | 7.42 |
| Blue / focus | #164d84 / #f7f6ef | 7.98 | #a1cdff / #192628 | 9.41 |
| Plum | #713760 / #f7f6ef | 8.02 | #f2b6dc / #192628 | 9.26 |
| Rust on feature | #8a3d22 / #f7dfaf | 5.82 | #ffbb96 / #43351e | 7.25 |
| Green | #215b48 / #f7f6ef | 7.30 | #a4ddc0 / #192628 | 10.14 |
| Input edge | #204d57 / #fffef8 | 9.19 | #b4ded9 / #202f32 | 9.50 |
| Control outline | #798482 / #fffef8 | 3.82 | #91aaa3 / #202f32 | 5.60 |

## Components and access

Build a shared masthead and decision badge, search field and results dialog, section with reserved update strip, Heads-up with action group, coverage line, filterable typed list, citation link, before/after fact, decision detail, timestamped receipt, setup step, form error and progress region.
Give each page one h1 and each landmark an accessible name.
Announce totals with context, changed values as “previous” and “new”, and external link destinations in text.
Hide redundant pictograms from assistive technology.
Use native links for navigation, buttons for mutations, labelled inputs and selects, and dialogs with focus containment, close control, Escape and opener restoration.
The skip link bypasses navigation; preserve visible 3 px keyboard focus on controls and text links.
Use a polite live region for user-triggered results and failures; do not read the whole queue on refresh.
Enter and Space activate only the focused control, with no single-character destructive shortcut.
Allow 44 px touch areas on coarse pointers, wrap button groups, preserve document reading order and allow long paths to break.
At 200% zoom collapse to the narrow layout; use no fixed sidebar, clipped table or horizontally scrolling action bar.
At 360 px the menu, search, reason, expiry, first action, source and type remain available in the same sequence.
Use forced-colors system borders for stamps and focus; color is supplemental throughout.

## Delivery sequence

1. Ship the shared shell, read-only snapshot, decision identity projection, routes, search and theme tokens behind a switch.
2. Build the Home order, bounded promotion windows, briefing acknowledgment, coverage exceptions and typed rows; test adjacent events, daylight-saving transitions, partial reads and cross-Machine duplicate notices.
3. Connect Inbox decisions, Draft detail, immutable version approval and receipts, Proposal conflict handling and all history views; test expiry while focused, simultaneous decisions and unknown delivery outcomes.
4. Move Brain, Sources into Connections, Jobs, first-run setup and every Settings section with existing routes redirected; check notes-only, offline, Linux credential fallback, Harness reconnect and multi-Machine recovery flows.
5. Verify keyboard and screen-reader paths, 360 px and 200% zoom, forced colors, stability during incoming updates and count conservation before enabling the redesign.

The standalone prototype uses fictional data, fixed local times and offline previews for calendar and call destinations.
Scene changes only the sample conditions; production has no scene switch.
The four captures pair a quiet morning in light mode with a busier meeting overlap in dark mode.
