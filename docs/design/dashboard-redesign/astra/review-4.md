# Dashboard redesign review

**Overall rating: 8/10**

I would build this Home in the agreed order.
Search gives me a place to start with my own question, the briefing tells me something worth knowing before I ask, and the Inbox finally lets me tell a deadline from a reply without reading both.
The design is strongest on an ordinary morning and weakest when several things go wrong together, precisely when the owner most needs an overview.
The main risks are a missed warning before drafting a second message, losing the distinguishing words in a long queue, and spending a phone screen reading about connections before reaching work.

## Sub-ratings

| Dimension | Score | Deciding factor |
| --- | ---: | --- |
| Glanceability and hierarchy | 8/10 | Two complete deadlines visible on a healthy desktop morning, zero on a busy desktop with mixed connection health |
| Visual design | 8/10 | Restrained shell, expressive type families, excess repetition in the queue controls |
| Interaction model | 8/10 | Version-specific approval, separate Send, safe keyboard intent, one consequential gap after an uncertain send |
| Narrow layout | 6/10 | Good bottom navigation and native pickers, clipped identifying details and undersized actions |
| Accessibility | 7/10 | Redundant type cues and explicit stale states, uneven reading size and touch targets |
| Buildability and scope | 8/10 | Sensible incremental releases and deferred proactive service, conflicting acceptance examples at phase boundaries |

## What works

- Compared with the current Home capture, the new Inbox gives the overdue runbook a title I can pick out before opening its evidence.
- The twelve hues earn their keep because icon and word identify the type even when two colours look similar; indigo works in both themes because panel fill signifies context and a solid button signifies action.
- A healthy Connections line earns its position above the Inbox by answering whether I can trust what follows.
- Keeping a linked item among its peers while counting its Draft once in Approvals matches how I would find the conversation again.
- The distinction between a failed first load and retained, timestamped rows after a failed refresh is worth preserving, as are explicit decision buttons and the specified focus retention during live updates.

## Improvements, ranked

### 1. Carry the uncertain-send warning back to the Inbox | Must-fix before build

The owner who misses the toast can return to the original request and prepare the same message twice.
Section 5.3 of Fable's design gives an unknown-outcome Draft a target link and warning under Finished, while section 1.3 of the dot spec restores Prepare draft on its open Inbox item.
Give that item a persistent “Delivery unconfirmed” label and make “Check destination” its first action.
Keep the Draft receipt reachable and put preparation of a replacement behind an explicit choice after the warning.
This fits the existing count because the open item already contributes one decision.

### 2. Bound the height of mixed Connections | Should-fix

At 1280 x 800 in dark mode with Heavy day, meeting prep and mixed services, the Inbox heading began at y=761 and its first item at y=942.
At 375 x 812 the same item began at y=1409, compared with y=627 on a healthy normal morning.
Keep the sign-in request and Reconnect visible, then give each remaining problem a compact source-and-impact line with expandable diagnostics, timestamps and retry details.
Keep Join and the in-progress meeting ahead of these rows under the interview rules.
This preserves the owner's section order and buys space by shortening diagnostics when there are several.

### 3. Make similar deadlines distinguishable on a phone | Should-fix

At 375 px on Heavy day the first three deadlines share the opening “Finish recovery rehearsal and document rollback ownership” and differ by region at the end.
Their 14 px titles occupy 42 px of a 63 px text block, so the two-line clamp hides the region on all three.
Allow titles to wrap fully at narrow widths, starting with the first three visible rows per group, and use the specified 16 px reading size.
Test whether the owner can pick region 2 without opening any row.

### 4. Make the compact actions as easy to hit as the filters | Must-fix before build

In the 375 px meeting and mixed-services state, Done, Not now and Reconnect Slack measured 32 px tall, the related-note buttons 26 px and the two native Inbox pickers 44 px.
That falls short of the narrow target specified in Astra's “Layout and keyboard” section, particularly for adjacent actions with different consequences.
Give the whole clickable element a 44 px minimum hit area, wrap secondary actions as a group, and test actual button bounds and focus order in the phase introducing each component.
Use the space recovered from connection details to accommodate those targets.

### 5. Give the meeting transition one authoritative acceptance fixture | Must-fix before build

The interview changed the meeting's lifetime, actions and Inbox membership, but the meeting fixture still says it leaves at 14:10 and Fable's section 5.1 still describes the older rule.
Build a clock-driven fixture spanning 15 minutes before start, in progress, two overlapping Heads-ups, Not now, Done and scheduled end.
Assert the lead action, destination, item visibility, focus and count at each transition, including the case where focus is on Join when the next meeting appears.
Include this fixture and the exact count endpoint in their consuming phase tickets, with a separate check for a failed list request when the count request succeeds.
Keep richer proactive ranking for the later service roadmap.

### 6. Spend less of the Inbox header explaining arithmetic | Nice-to-have

On a normal 375 px morning the Inbox heading starts at y=361 and the first item at y=627.
Between them are the count explanation, a type census, two pickers and another type heading; the same deadline count appears before the owner has seen a single deadline.
Keep the “10 need you” badge and a short link such as “1 item has a Draft in Approvals”, put the full reconciliation behind the badge, and let the type picker carry the counts on narrow screens.
On desktop keep the direct filter chips because they do double duty as a census and a control.

## Open question for the owner

If the briefing is still unread at noon, should it stay available as a quiet link for the rest of the day?
I would collapse it at noon and keep the link so opening Home late does not cost the owner the morning's context.
