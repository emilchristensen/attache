# Astra: The daily decision desk, v3

## Changes in v3

Replace slogans with plain screen names and a live Inbox headline.
Adopt compact desktop controls, neutral status labels, wrapping count links and one Machines and Replication section.
Accept locally bundled fonts only within a measured combined 150 KB budget; this prototype shows the system fallback pending that measurement.
Use a compact Menu on narrow screens and collapse the dated briefing there.
Render heavy-day-v1 with 38 deduplicated decisions and transient Slack coverage failure.
The detailed edge-state and keyboard rules are in spec-states.md.

## Changes in v2

Adopt Fable’s unified Inbox, Inbox and Brain labels, compact disclosure rows, quiet healthy states and globally available Brain search.
Keep coverage uncertainty explicit and keep Apply, Reject, approval and execution as deliberate buttons.
Use one deduplicated decision count for the logo, with unknown loading or failed requests never interpreted as zero.
Use system fonts initially and a labelled filter selector instead of an overflowing tab strip.

A calm editorial workspace for deciding what needs you, with evidence kept beside the decision.
The central change is structural: Home becomes a briefing and triage desk, Memory becomes a library with separate review workspaces, and operational configuration becomes an indexed set of focused pages.
There is no chat, capture composer, invented priority score, or direct note editor.

## Grounding and observed problems

I ran the real Dashboard with service port 17643 and an isolated state folder inside astra/.scratch, paired the browser, and completed a notes-only setup.
The development script fixes Vite to port 5173 even when the service receives a unique port.
I inspected the live setup and Home at 1280 by 800, and used the source and user guide for populated and remote-service states.
No live work accounts were connected; populated prototype content is explicitly illustrative.

- Setup's main continuation button falls below the 800px viewport while optional import and identity forms occupy most of the page.
- Optional and required sections have almost identical bordered-card weight.
- The live empty Home says “Nothing needs your attention” even though only the data folder is connected, making the scope of that reassurance easy to miss.
- Home begins directly with a small Briefing heading and has no strong page-level orientation.
- The copper identity is visually isolated from the blue action system.
- In the source, Memory places ProposalReview and RecentSaves before search, so review volume can push the library's main task down.
- Connections and Settings are long stacks whose unrelated tasks must be found by scrolling.

## Principles

Decisions get space; routine status gets a quiet line.
Always distinguish no items from incomplete coverage and disabled features.
Keep the source, destination, version and consequence visible at the point of decision.
Use the service's ordering and state instead of inventing urgency or inferred confidence.
Preserve the owner's place after a decision, and never silently advance to another draft that could be sent.

## Navigation and layout

Keep the six existing routes and old shortcuts, with Home labelled Inbox and Memory labelled Brain.
Add g-i and g-b aliases.
Ctrl K or Cmd K opens Brain search from anywhere, using the existing search endpoint and keyword fallback explanation.
Keep the palette read-only, with explicit Open note and Open evidence controls and normal Tab focus traversal.
A 208px navigation rail groups Home, Memory and Drafts as daily work, with Jobs, Connections and Settings below an Operations label.
Inbox remains the landing page.
Memory gets Library, Proposals and Recent saves subnavigation, addressable through query parameters.
Settings gets an in-page index with focused sections, preserving direct links and browser Back.
At 1100px and above, review pages have a 300px list and flexible reading panel.
Below 760px the rail becomes a compact brand row with a Menu disclosure; list selection opens a full-width detail with a Back to list control and restored scroll position.
No horizontal scrolling is required at 320px.

## Screen scope and feature preservation

### Pairing and setup

Pairing retains automatic code handling, manual code entry, busy state, expired-code errors and recovery instructions.
Setup retains all five steps and resumability.
Step one puts Start a Brain and Join a Brain before optional identity and import disclosures.
Keep folder previews, counts, skipped files, zero-source-modification assurance, protected identity confirmation and join refusal details.
The continuation area follows the required form immediately, with optional sections below it.
Features retain readiness, dependency explanations and confirmation of dependent feature changes.
Connections reuse the same forms as the main page.
Model and schedules retain all providers, action permissions, refresh interval, briefing time, notifications and quiet hours.
Test and finish keeps ready, partial, needs setup and unavailable outcomes, with a deliberate notes-only finish.

### Home

Lead with a live decision count and a separately dated briefing.
The briefing is a readable document with cited points, full-file access, Prepare briefing and three-day Away summary.
A unified queue includes attention items, proposed Proposals, actionable drafts and connections needing sign-in.
Deduplicate drafts using the attention item actionId, preserving both decisions within the same work row.
A wrapping line of count links navigates to stable group headings; Hidden remains a separate toggle.
Compact disclosure rows show evidence and consequences when expanded.
Draft approval and execution remain in Drafts.
A source coverage strip sits above the attention list and names the Reader, last successful refresh and failed or partial sources.
Expand it for per-source detail and manage links.
For notes-only use, say “No attention items from your connected notes” and offer Connections.
For failed sources, say “No items from available sources” and keep the failure visible.
Maintain deadlines, review queue, meetings, pending replies and facts to check as real group headings.
Selecting an item exposes evidence and Prepare draft, Done, Dismiss and Snooze in a detail panel.
Keep exact snooze choices, dismissed-item visibility, reopen and changed-since-your-decision markers.
Recently added remains on Home, covering seven days of unreviewed writes with provenance, before/after values, reasons and Revert.
Keep reverted entries visible and do not add a seen state.

### Memory

Default to Library, with search at the top and People, Projects, Decisions, Notes, Imported, Evidence and Deliverables filters.
Search retains paths, line citations, snippets, superseded history markers, unverified facts and keyword-only explanations.
A note is read-only with Current state first, then History, Change log and the Markdown file.
Protected identity points to Settings.
Rebuild index remains available in the library toolbar.
Proposals become a dedicated list/detail workspace showing the whole proposed change, quoted evidence, originating Machine, reasons, facts, Review dates, events, notes and tags.
Apply and Reject remain atomic service actions; a conflict stays visible with its explanation and no local optimistic removal.
Recent saves retains pagination or existing list expansion, auto-accepted labels, provenance, revert eligibility and outcomes.
Revert errors must explain when later changes prevent reversal.

### Drafts

A review document replaces nested cards.
Its header always names target service, destination, action kind, version and status.
Context and quoted evidence precede the editable body; secondary history opens below.
Save new version invalidates approval.
Approval and execution remain separate actions: Approve vN, then Send or Create in Gmail.
Show the approved version beside execution and retain Revoke approval and Reject.
Keep Needs review, Finished and All filters and every status including expired, failed, unknown and executing.
Unknown outcome requires checking the target and must not offer a misleading success state.
Show verified receipt time, remote identifier and remote link.
No bulk approvals or keyboard shortcuts for sending.

### Jobs

Keep research creation, all existing job types, diagnostic job, list/detail selection, progress, events, results, cancel and retry.
Results link to evidence or the created draft.
A running job is described as continuing in the service when the browser closes.
Cancel uses the service's actual outcome, not an immediate local “cancelled” assumption.
Move the diagnostic job into a labelled diagnostics disclosure.

### Connections

Use a compact directory grouped into Notes, Work sources, Harnesses and Model.
Rows show state, read/write permission and last success; expansion reveals the existing full form.
Preserve folder import preview and import, all provider fields, OAuth callbacks, token alternatives, prerequisites, connection tests, scope coverage, source refresh and disconnect.
Keep GitHub, Jira, Confluence, Slack, Gmail and Google Calendar distinct.
Keep Claude Code, Codex, Antigravity and Claude Desktop distinct, including restart and hook-review instructions.
A read-only badge describes permissions, not a guarantee that every source refreshed successfully.

### Settings and Replication

An indexed settings workspace contains Features; Schedules and notifications; Identity; This Machine and Replication; Auto-accept and Consolidation; Meaning-based search; Paired clients; Backup and export; Service health.
Retain every existing field and capability dependency.
Identity remains protected and requires explicit confirmation.
Replication preserves setup, join, repository constraints, check now, off, last checked/sent/up-to-date times, blocked causes, Machine roster, Standby and Preferred Reader.
Keep replication failures separate from source coverage failures.
Auto-accept remains per Harness and per Machine, and Consolidation retains its current scope.
Meaning-based search retains download, progress, rebuild, removal and keyword fallback states.
Paired clients retain code generation and revocation.
Backups retain creation, file list and existing command-line restore/uninstall guidance.
Service health retains runtime, paths, credential-store explanation, indexed documents, jobs and schedules.

### Shared evidence and service states

Keep EvidenceProvider as a consistent source reader with path, lines, safe rendered Markdown and source content.
Evidence can be opened from every citation without losing the parent review.
Retain reconnecting, disconnected, not found, loading, recoverable errors and feature-disabled states.
Stale data is labelled and mutations wait for a service response.
Do not replace a failing list request with an empty-state illustration.

## Visual language

Use warm paper and ink, with copper reserved for the brand, active navigation and primary action.
Typography targets locally bundled faces under a measured combined 150 KB budget, with system sans and Georgia as fallback.
Desktop UI is 14.5px with 32px controls; touch controls are 44px and reading body is 16px/1.55, supporting text 14px, labels 12px, page headings 38px and note headings 26px.
Use a 4px spacing unit with 8, 12, 16, 24, 32 and 48px steps.
Panels have 8px corners, one-pixel rules and no routine shadows.
Icons are small inline SVG strokes with visible labels; never rely on a glyph alone.

| Token | Light | Dark |
| --- | --- | --- |
| Canvas | #f5f1e9 | #181b19 |
| Surface | #fffdf8 | #222723 |
| Text | #252d28 | #f1eee6 |
| Secondary | #62695f | #b7beb4 |
| Rule | #d9d9cc | #424b42 |
| Action | #8e402b | #efad93 |
| Action text | #ffffff | #241b16 |
| Selected wash | #f0dfd3 | #403128 |
| Success | #326248 | #a3d2ac |
| Warning | #765112 | #e6c37f |
| Danger | #a1322d | #f4aaa3 |
| Focus | #245f86 | #9dc9ef |

Retain the actual copper logo geometry and #ba6249 brand fill.
Its amber dot means the unified queue contains an owner decision.
Transient failed or partial refreshes show a coverage warning without adding a decision or lighting the dot on their own.
Needs-auth connections count once; Replication issues already represented by attention items are not added twice.
A zero count with incomplete coverage says “No decisions from available sources; Slack was not read”.
Collection totals are omitted because the documents route returns a limited array, not authoritative counts.
Do not use it as a network indicator or permanently show it on an empty Brain.
Provide an adjacent textual attention count; the logo itself can remain decorative when the brand name is present.
Use 120ms opacity transitions for state changes, no animated counts or pulsing dot, and remove transitions under reduced motion.

## Components and implementation phases

1. Foundation: replace tokens and layout rules in apps/web/src/styles.css, reorganize Shell in App.tsx, retain Logo.tsx geometry, and add reusable PageHeader, CoverageStrip and ReviewLayout under components/.
2. Home: restructure views/Home.tsx and Inbox.tsx around briefing and selection, keeping ReaderLine.tsx, RecentlyAdded.tsx and components/RecentChange.tsx service semantics.
3. Review: split views/Memory.tsx into query-addressable subviews using ProposalReview.tsx and RecentSaves.tsx, then restyle Drafts.tsx and Evidence.tsx with shared review layout.
4. Operations: reorganize Jobs.tsx, Connections.tsx and ConnectionCard.tsx, followed by Settings.tsx, Replication.tsx, ReplicationMachines.tsx, MeaningSearch.tsx, AutoAccept.tsx and ConsolidationSwitch.tsx.
5. Onboarding: refactor Setup.tsx and App.tsx pairing layout using shared controls in ui.tsx, Tabs.tsx and SwitchRow.tsx.
6. Validate feature parity against the user guide, narrow-screen reading, keyboard navigation, evidence return focus and all draft approval states before replacing the existing screens.

All phases use api.ts and live.ts rather than introducing a second state or transport layer.
Use existing attention, action, memory, job, capability, configuration and Replication responses.
The combined review experience is composition of existing endpoints, not a new service inbox.
Exact unified totals require a service contract for complete, deduplicated counts.
Brain search is globally accessible but remains passage search, not global search across jobs or configuration.
Do not add cross-item scoring or cross-Machine job aggregation without a separate contract.
The actions route defaults to 100 entries, so completeness must be established before promising an exact combined count.

## Accessibility and validation

Target WCAG AA with measured text contrast and non-color status labels.
Use real headings, landmarks, labelled inputs and buttons, visible focus, 44px touch targets and a skip link.
Tabs need arrow-key behavior; navigation links use aria-current.
Evidence dialogs trap focus, close with Escape and restore focus to their citation.
Keep the selected item stable during SSE updates and announce only decision outcomes in a polite live region.
Validate at 200% zoom, 320px width, both themes, reduced motion and keyboard-only use.
Test source failure plus zero items, conflicting Proposal, edited approved draft, unknown send outcome and reconnect during a decision.

## Prototype and uncertainties

prototype.html is a self-contained visual prototype with illustrative data and local-only interactions.
It demonstrates Home, Drafts, Memory, Proposals, Jobs, Connections, Settings and setup in light and dark.
It is not a service simulator and its action feedback is explicitly labelled as a demo.
The proposal commits to one independent direction; alternatives belong in the later joint design round.
Real populated-account density and long evidence documents still need usability checks.
Replication belongs in Machines and Replication within Settings.
The proposed unified dot semantics extend the current implementation and require explicit acceptance in the joint design.
No one-key Apply or Reject is offered because Revert eligibility can change after subsequent writes.
