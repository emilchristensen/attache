# Astra review 3

Owner feedback takes precedence over my v3 state specification.
The direction is agreed, with the must-fix items below required before design sign-off.

## Works

The search, indigo proactive card, compact service line and typed Inbox establish a much clearer hierarchy than v3.
Approvals has a convincing separate identity in both themes, with drafts and Brain changes visibly separated and no Send action in the list.
The type word and icon survive independently of colour, including Invite versus Meeting prep within the same family.
The connector mapping is credible: GitHub authored PRs and assigned issues are observations, while Slack direct messages raise pending_reply and Slack mentions raise mention.
The attention contract deliberately allows string kinds, so the documented unknown-kind fallback matters.
The heavy fixture still totals 38 decisions: 28 Inbox plus 10 Approvals.
The incomplete-draft-list deduction is conservative and avoids counting the same decision twice.

## Must fix

### 1. Complete the service-status decision table

Problem: DESIGN.md section 5.1 excludes incomplete coverage from green but supplies no presentation for never_run, denied, unauthorized, offline, missing coverage or partial feature readiness.
Where: Connected services and prototype statusHTML, which currently exercise only fine, auth and down.
Evidence: packages/contracts/src/features.ts defines those coverage states and includes model and Harness connections that need not have a Source refresh.
Concrete fix: distinguish readable sources from other connections, map every coverage and readiness state to explicit copy and an appropriate action, and reserve green for positively established health.
Show never-run as Not read yet and unknown requests as Checking or Could not check, without a fabricated last-success time.
Only say other services are working when their health is known, and do not promise automatic retry without checking the Reader and enabled schedule.
Add fixtures for these cases, notes-only, feature-off, missing Reader and mixed problems.
Keep working-service names off the overview, as the owner requested.

### 2. Demonstrate failed decision requests and scoped empty states

Problem: the prototype always computes exact counts from local arrays, and its empty Inbox says Nothing needs you based on Inbox emptiness and service health alone.
Where: counts(), inboxHTML() and Part 1 of spec-dot-and-drafts.md.
Concrete fix: add an independent request-failure control for attention, drafts and Proposals, including initial failure and failure after a successful load.
Show Retry, retained rows with observation time, lower bounds and the retained dot exactly as the written rule requires.
Add an empty Inbox with approvals still waiting and label it No open Inbox items, reserving Nothing needs you for an exact combined zero.
A source refresh failure is not a substitute for an API request failure.

### 3. Restore an at-a-glance type overview at 360 px

Problem: narrow-today-morning shows a large briefing, controls and only the first deadline, while replacing all type counts with the closed All types picker.
Where: narrow-today-morning.png, narrow-today-heavy-dark.png and the narrow .chips rules.
Concrete fix: keep a compact visible summary of nonempty types and their counts above the first group, with the picker retained for filtering.
Collapse the dated briefing to its headline and a deliberate expansion on narrow screens, as my state specification proposed, and reduce the stacked control rows rather than shrinking targets or reading text.
Verify that normal and heavy days expose the work mix without opening a picker or scrolling through the deadline group.

## Should fix

The narrow search placeholder is visibly cut off after projects, so shorten it to Search the Brain and put examples outside the input if needed.
The narrow heavy-day titles are ellipsized into nearly identical rehearsal text, so permit two title lines and expose the full title on expansion.
The screenshot palette has collision risks: sky replies and teal mentions under blue-yellow deficiencies, rose deadlines and purple reviews under red-green deficiencies, and moss meetings versus orange work items and gold facts under red-green deficiencies.
Dark amber and gold are particularly close, with both using #372a15 as the soft background, so do not claim every hue is independently distinguishable.
Keep the existing distinct words and icons, and validate simulated protanopia, deuteranopia and tritanopia in both themes before adjusting hues.
This review inspected the actual palette and redundant labels but did not run a colour-vision simulation or independently certify contrast ratios.
The proactive registry is a credible extension seam, but document simultaneous meetings, timezone changes and the case where no related notes exist.
GET /briefings/latest returns one latest briefing, including manual briefings, rather than a latest daily briefing plus an away history.
Define the current-route fallback for stale, absent or manual results, join related notes by item ID and show their observation time instead of implying fresh meeting research.
Do not promise a meeting end time from AttentionItemView, which provides dueAt but no end time.
Keep disappearance timing accessible on narrow screens even though the current narrow rules hide the why line.
Executing drafts should appear under In progress rather than Finished, without adding to the decision count.
Update residual Settings copy that still says Proposals are reviewed in the Inbox.

## Disagree with v4

I disagree with removing an attention item from its type group merely because a draft exists.
The owner separated approval work from Inbox work, but the underlying reply or review remains an open obligation and should remain discoverable by type.
Keep the row with Draft waiting and a View draft link, place approval controls only on Approvals, and count its decision only there.
Label type counts as open items and decision badges as needs you so that visible rows and deduplicated totals are not confused.
I accept the bottom navigation as a reasonable replacement for my v3 Menu disclosure, provided Connections and Reader problems remain discoverable through More and the status area.
I accept moving complete source coverage details to Connections because the owner explicitly rejected listing healthy services on the first screen.

## Four open points

Today versus Inbox: keep Today for the whole page and Inbox for its attention section, without implying that older obligations are filtered out.
Waiting draft placement: retain the original typed item with a Draft waiting tag, and deduplicate its decision into Approvals.
Missing request-failed toggle: must fix in this round because it verifies the most consequential dot and empty-state rules.
Stale README: update it when Fable applies the agreed fixes, marking v4 and this review as authoritative and retiring conflicting v3 navigation, density and three-hue rules.

## Review evidence and limits

I opened the local prototype in Chrome and inspected its accessible structure and source.
I inspected light-today-morning, dark-today-full, narrow-today-morning, narrow-today-heavy-dark, dark-approvals, narrow-approvals and light-colours screenshots.
I checked attention.ts, features.ts, the GitHub, Slack, Jira and Calendar connectors, attention/briefing.ts and the data, core and work route definitions.
The shared preview rejected file URLs, so I used the chrome-devtools-axi fallback, closed the tab I opened and stopped its bridge.
This was a design review, not an implementation test or a full interaction accessibility audit.
