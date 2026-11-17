# State and narrow-screen specification, v3

## Scope

These are proposed rendering rules over today's contracts, not claims that the current Dashboard already implements them.
Fable owns the authoritative dot and ten-status draft specification; round 3 must reconcile its rule with this fixture.

## Layout and keyboard

At 360 through 760 px use one compact brand row, an explicit Menu disclosure for all six destinations, and Search beside it.
Do not put a wrapping navigation header above the content.
The briefing is a closed dated disclosure on narrow screens and a short reading block on desktop.
All narrow and coarse-pointer targets are at least 44 px, and reading text stays at least 16 px.
At 1280 by 800 the live headline, dated briefing, coverage and first queue rows must be visible without scrolling.
Long paths wrap, lists have min-width zero, and no page requires horizontal scrolling.
Brain, Drafts and Jobs open selected detail full width on narrow screens with Back to list restoring selection, focus and scroll.
Connections, Settings, Setup and pairing are single-column forms with labels above fields and the primary action below its required fields.
Evidence and search dialogs fit the viewport, scroll internally, trap focus, close on Escape and restore their opener.

| Screen | Safe keyboard model |
| --- | --- |
| Shell | Tab follows visible order; Ctrl/Cmd K opens search; g sequences navigate only outside inputs, editors and dialogs; provide a shortcut-disable preference. |
| Inbox | Tab reaches count links and disclosure summaries; Enter or Space opens a row; Tab reaches explicit action buttons; no mutation hotkeys by default. |
| Brain and Proposals | Search remains a normal input; results are links; subviews are links; Apply, Reject, Rebuild and Revert require focused buttons. |
| Drafts | Text editing consumes typing shortcuts; Save, Approve, Revoke, Reject and execution are separate focused buttons; never move focus to another draft after an action. |
| Jobs | Research is a labelled form; submission is explicit; Cancel and Retry stay beside the selected job; updates never steal selection. |
| Connections | Native disclosure summaries and labelled fields; confirmations preserve focus and return it on cancel. |
| Settings | Section links preserve browser Back; native switches and radios keep their normal keys; identity and destructive changes retain confirmation. |
| Setup and pairing | Native form order, inline errors associated with fields, first invalid field focused on submit; no shell shortcuts while entering a code. |

An SSE update must not remove the focused control or reorder an open review beneath the pointer.
Retain a result row after an acknowledged decision, and expose a deliberate refresh for new ordering.
The prototype demonstrates native focus and disclosure behavior, not the complete production keyboard model.

## Proposal conflicts

[apps/service/src/memory/proposals.ts](../../../../apps/service/src/memory/proposals.ts) checks already-decided and unreadable records before applying, and checks saved correction values through [apps/service/src/memory/proposal-corrections.ts](../../../../apps/service/src/memory/proposal-corrections.ts).
Keep a refused Proposal open with the exact service message, its evidence and the proposed change.
Offer Reload current state and Reject where the record is still proposed, never Force apply or silent rebasing.
An already-decided response becomes a read-only result after reload; a missing record offers Return to list.
Unreadable records have no Apply button, matching [apps/web/src/components/ProposalReview.tsx](../../../../apps/web/src/components/ProposalReview.tsx).
Do not imply that retrying the same conflicting change will resolve it.

## Refused Revert

[apps/service/src/memory/revert.ts](../../../../apps/service/src/memory/revert.ts) returns 409 not_revertible with a reason and 404 for a missing applied change.
A later correction to the same subject, external edits, a reused filename, protected identity, appends and missing historical copies can all prevent reversal.
Keep the original row and show the reason inline, then refresh eligibility without pretending success.
Where appropriate link to the note's Change log or Identity in Settings; never offer a forced overwrite.
An acknowledged revert is itself a new change, not erasure of history.
[apps/web/src/components/RecentChange.tsx](../../../../apps/web/src/components/RecentChange.tsx) already exposes eligibility and reason and only renders Revert when allowed.

## Coverage, request errors and empty states

[apps/web/src/views/Inbox.tsx](../../../../apps/web/src/views/Inbox.tsx) reads connection coverage separately from attention items; complete and empty coverage mean successful reads, not necessarily discoveries.
List every configured source's last success and complete, empty, partial, failed, never-run or sign-in state in one coverage disclosure.
A connected source without a successful read is not complete coverage.
Keep last success separate from the time of the failed attempt.
Notes-only says no attention items found in connected notes, never that all of the owner's work is clear.
Feature-off says Attention and briefings is off while independent Proposal and draft decisions remain visible.
A transient failed source qualifies the list without lighting the dot; required sign-in is a decision.
[apps/web/src/views/ReaderLine.tsx](../../../../apps/web/src/views/ReaderLine.tsx) distinguishes another Reader, no Reader and a silent Reader; preserve those messages rather than assuming this Machine is reading.
[apps/web/src/live.ts](../../../../apps/web/src/live.ts) separates loading, data and errors and refetches after reconnect.
Initial load shows loading, failed requests show Retry, and stale data stays labelled with its observation time.
Do not display zero or an all-clear headline while any contributing decision request is unresolved.
Disable affected mutations while disconnected and wait for acknowledged responses; never automatically retry execution.

## Limited lists

[apps/service/src/http/routes-data.ts](../../../../apps/service/src/http/routes-data.ts) defaults attention to 200, Proposals to 100 and documents to 300; [apps/service/src/http/routes-work.ts](../../../../apps/service/src/http/routes-work.ts) defaults actions and jobs to 100.
These are request defaults, not all hard maxima.
Recent changes defaults to 50 and explicitly validates a maximum of 200.
The list routes do not establish an authoritative deduplicated total.
At a full returned page say Showing the first N records; more may exist, and do not manufacture pagination where the contract supplies no cursor.
Group counts describe loaded records until totals or a complete snapshot are available.
For unified counts, deduplicate loaded IDs before computing a lower bound; unknown requests still prevent asserting zero.
An exact combined headline needs a service count or complete traversal contract, including deduplication, not a larger arbitrary limit.

## Shared dense fixture: heavy-day-v1

Use the same deterministic fixture in both prototypes, with stable IDs and this ordering.
Astra publishes it as dense-fixture.json in this folder; Fable may copy or embed it without changing the values.
The date is 2026-11-17 at 09:30, Reader Work Mac, daily briefing 08:00.
There are 30 open attention items: 8 Deadlines, 8 Review queue, 4 Meetings, 6 Pending replies and 4 Facts to check.
There are six proposed Proposals, including one 15-fact Proposal, and four drafts: two linked to open attention items, two standalone.
Drafts are d1 draft linked to a9, d2 approved linked to a21, d3 revoked standalone and d4 draft standalone.
There are 38 deduplicated decisions: 30 attention items plus six Proposals plus two standalone drafts.
There are eight source entries: Notes, Imported notes, GitHub, Jira, Confluence, Slack, Gmail and Google Calendar.
Slack has a transient failed refresh with last success yesterday at 17:12; the seven others succeeded at 09:26, and no source needs sign-in.
The failure does not add a 39th decision.
Each group includes long project titles, full source paths and explicit metadata; no synthetic priority is added.
All rows start closed, the fifth attention row remains reachable without opening the first four, and the long Proposal exposes all 15 facts when opened.
Compare 1280 by 800 and 360 by 800 in both themes, including expanded titles and the fifteenth Proposal fact.
Browser measurements remain a validation task, not an assertion based on CSS alone.
