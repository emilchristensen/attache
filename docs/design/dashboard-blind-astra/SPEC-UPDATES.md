# Proposed updates to the Dashboard redesign

Keep the behavioral contract of [#14](https://github.com/emilchristensen/attache/issues/14) and change the default view to the ruled Inbox and quiet, single-column Home the owner liked.
The strongest evidence for a change is the owner's preference for the Inbox and the lower information load; the palette is acceptable, while navigation, deadlines and count semantics did not receive a new owner decision.
Use the [blind prototype](prototype.html) for composition, its [design notes](DESIGN.md) for tokens, and the corrections below wherever the screenshots fall short.
The proposals below cover the 24 child issues, #17 through #35 and #37 through #41.
Number 36 is an open, unmerged [implementation PR for #17](https://github.com/emilchristensen/attache/pull/36), not a child ticket.

## Visual language

- **Replace the visual reference and tokens | Rewrite #14 Solution, Look, Further Notes and story 128, and #17; revise PR #36 if implementation resumes.**
  Use warm canvas, paper and ink in light mode (#f7f6ef, #fffef8, #192d32) and slate canvas, paper and pale ink in dark mode (#192628, #202f32, #f6f3de).
  Use amber paper for the lead briefing (#f7dfaf or #43351e), blue for reviews, rust for replies, plum for mentions and green for assigned work, with the exact light and dark foreground pairs from the blind design's contrast table.
  Concentrating color in the kind stamp and one timely subject lets the eye find the work before it notices the interface.
  Keep the copper and brass artwork, semantic token aliases, reusable icons, stylesheet split, same-origin font delivery and build checks already described in #36.
- **Give headings and controls distinct jobs | Amend #17, #23, #25 and #35.**
  Set section headings in local Georgia at about 29/35 px, subjects and controls in locally served Inter or system sans, and short times in tabular or monospace figures at 13 px.
  Use dark ink for primary buttons, an outlined focus ring distinct from selection, 1 px rules between records, and generous space between sections instead of a card around each record.
  Keep quiet rules decorative and measure every functional edge, focus ring and stamped glyph on its actual tinted surface in both themes.
  The subject remains the strongest text within a row and recurring labels occupy predictable positions.

## Home layout and hierarchy

- **Recover the sidebar width | Rewrite desktop shell in #18 and #14 stories 2 to 6; amend #19 and #34.**
  At desktop width use a single-line masthead with the unchanged mark, Home, Approvals, Brain, Connections, Jobs and Settings above a centered reading column of about 1072 px.
  Keep Machine and Reader names one disclosure away in the masthead, show the Reader beside Source refresh in Connections, and retain the Replication warning at Settings with a named status indicator.
  Put the explicit search launcher in the masthead off Home; keep the existing navigation keys, shortcut sheet, routes and mobile destinations.
  The recovered width gives long subjects and their type labels separate columns.
- **Remove the duplicate search headline | Amend #14 stories 23 to 30, #21 and #34.**
  Use a compact “Home” heading beside the date and one full-width, roughly 54 px search field carrying the visible prompt “Search the Brain” and a persistent accessible label.
  Move the five always-visible Browse links into a single Browse disclosure beside or below the field that still opens each collection directly.
  Preserve inline cited results, ranking explanation, “All results in Brain”, no autofocus on arrival and Ctrl K focus on Home.
  Removing the prototype's large “Search the Brain” heading makes the field itself the first obvious action and returns a line of height to the Inbox.
- **Show the Home count once while on Home | Amend #14 stories 3, 13 to 22 and #18, #19, #24; retain #20.**
  Select Home with shape and contrast, suppress its navigation number only while visiting Home, and put its decision count in the Inbox heading as “4 need you here”, including promoted meeting decisions.
  Where visible rows, open items and decisions differ, use #24's reconciliation line, for example “1 meeting above · 3 items below need you · 1 Draft in Approvals”.
  Off Home restore the Home badge; keep Approvals and sign-in counts in navigation or More and the total on the logo, favicon signal and tab title.
  The owner can reconcile the total without reading the same number twice or mistaking a visible row count for a decision count.
- **Make the first viewport an acceptance criterion | Amend #14 Further Notes, #21 to #23, #25, #26, #35 and #38.**
  At 1280 × 800, default text size and scroll position zero, require the Inbox heading and two complete typed rows with an unread briefing and healthy Connections, and four rows after acknowledgment with sufficient items.
  Also require at least the first complete row with a meeting in progress, the next meeting eligible, a briefing follower and one sign-in problem, all disclosures closed.
  Check the actual bottom edge of the last required row against the viewport in both themes.
  This corrects the blind dark screenshot where two expanded meeting cards displace the entire Inbox and makes the earlier README's morning targets testable.

## Inbox

- **Make the owner-preferred index the default | Rewrite #14 stories 63 to 70, Implementation Decisions / Inbox and #23; amend #24 and #39.**
  Use one continuous ruled list with a heading and one visible “All types” picker showing counts in its options; put order, Group by type and Hidden in adjacent view options.
  Default to descending service priority, earliest due instant for ties, then stable item key, and freeze the order of the displayed snapshot.
  Show up to 20 rows with a range and Load more, retain Newest first, and apply the existing three-row previews and “Show all” only when Group by type is selected.
  Drop the default chip strip, tinted section headers, colored left bars and chip-wrapping acceptance criterion from #23.
  A mixed day then exposes several kinds immediately without charging a heading and toolbar to every family.
- **Specify the row the owner actually saw | Rewrite row anatomy in #23; amend #37 and #39.**
  On desktop give the kind column about 185 px, with a 34 px tinted stamp, a 19 px line icon and an explicit kind word; give the subject the flexible middle column, the source and sender or repository its second line, and time the trailing column.
  Reserve a plain exception label for a changed item, waiting Draft or delivery warning; omit routine status pills.
  Distinguish Review request with a branch fork, Authored PR with a PR glyph, Assigned issue with a checklist, Pending reply with an envelope, Mention with an at sign, Slack DM with a bubble and Slack mention with an at-bubble.
  Distinguish Invite response with a calendar question, Meeting prep with a calendar and notes, Deadline with a clock, Jira work item with a ticket, Fact to check with a dated page, and Replication with a split document or blocked arrows.
  Resolve visible labels from kind and available source context, preserve the original subject when stripping a verb would lose meaning, and show a readable kind under Other for unfamiliar records.
  Keep the service-kind coverage test and add a mixed fixture where a PR review and a pending reply remain distinguishable with all color removed.
- **Keep actions close and arrivals quiet | Amend #23, #24 and #37.**
  Open one row in place to show why, linked evidence and the primary action, followed by Done, Snooze or Dismiss as applicable.
  Keep the decision receipt and Undo in its row, preserve the open row and scroll anchor on return from a Draft, and announce new arrivals through a reserved “Show new items” control.
  With unknown delivery, the collapsed row says “Delivery unconfirmed”, the expanded first action is Check destination, and a replacement Draft takes a separate explicit decision.
  Retain Hidden, Reopen, the collapsed Recently added disclosure with Revert, dated retained rows on request failure and truthful empty states.
  This keeps the index quiet while preserving enough context to avoid repeating a send.

## For you now

- **One lead item, compact followers | Amend #14 stories 31 to 50 and #25, #26, #41.**
  Use the earlier design README's lead-and-followers idea with the blind design's amber briefing, limiting illustration to the lead briefing.
  A lead briefing shows one concrete development, one short explanation, “Morning briefing · Until noon”, Read briefing and Got it; its full points and linked counts open on request.
  A lead meeting shows its subject, “On your calendar”, “In progress, ends 14:30” and Join first, with Calendar event, Done and Not now available.
  Render the next meeting as a compact row such as “Billing triage · On your calendar · 14:30 to 15:00” with Open prep; expose both real event destinations and the decisions in that disclosure.
  Keep the briefing below both meetings as a one-line follower, and keep any additional eligible entries reachable in order through a disclosure.
  Show attendees, related notes and the briefing's timestamp on expansion, which saves space without losing the context used to prepare.
- **Preserve timed delivery and a stable reading position | Amend #25, #26 and #41.**
  Keep #26's 24-hour Inbox lifetime before start, 15-minute promotion window, scheduled end, event-ID matching and counted-once rule.
  Keep browser-local, per-occurrence dismissal, Earlier today, four-hour requested briefings and away summaries, the progress line, and an always-available briefing actions menu on the quiet line.
  Reserve the compact upcoming row during the final overlap window transition, or maintain the reader's scroll anchor when it appears below the current meeting.
  Recompute on clock ticks, wake and time-zone change; never repurpose a focused Join element for its successor.
  Keep #41's rendered keyboard journey, including deterministic focus after expiry and the different outcomes of Done and Not now.
  The owner sees the next call on time without losing the current destination or their place in the Inbox.

## Connections

- **Make the exception understandable in one line | Amend #14 stories 51 to 62 and #22, #31, #38, #40.**
  Keep the healthy line “✓ Connections · All good” only after the three successful coverage answers.
  Replace the blind prototype's document glyph with an outlined warning triangle and a specific word for service failure, a key for sign-in, and a question mark for unknown coverage.
  For example, show “Gmail · Sign-in needed · Replies may be missing” with Reconnect visible while collapsed.
  Keep one row per cause, at most three visible, an accessible “N more” disclosure, and last successful read, diagnostics and an honest retry schedule in the expanded row.
  Keep the requested deep link to the affected account's open repair controls on Connections.
  The first line tells the owner which work may be missing and whether they can act, without turning failure reports into a second Inbox.

## Approvals and Draft page

- **Apply the index to Waiting | Amend #14 stories 83 to 93 and #27.**
  Use two ruled sections with word and stamp, “Drafts to send” with a blue pen and “Changes to the Brain” with a plum change glyph labelled Proposal.
  In a Draft row show subject, destination, version and a one-line text preview; in a Proposal row show the note and a concise old-to-new fact or proposed addition.
  Retain in-place read-only Draft preview, in-place complete Proposal and evidence, refused Apply reason, uncounted In progress and independently loaded Waiting and Finished groups.
  This makes the distinction between sending a message and changing the Brain visible before either decision opens.
- **Make the message the reading surface | Amend #28 and its link back through #37.**
  Put Back to Approvals, destination, status and version above a compact step line, followed by the actual message being answered, the editable Draft at 16 px or larger and one version-labelled primary action.
  Keep disabled Send with its reason, the complete fourteen-state model, version conflict recovery, explicit restore, timeout, receipts and the unknown-outcome path.
  Use the semantic warning icon and precise text for a failed or uncertain send and return to the originating item with its warning intact.
  Version and destination then stay visible while reading the words the owner is about to send.

## Other screens

- **Keep the Brain reader and Jobs table | Amend the visual criteria in #29 and #30.**
  Use the same paper, type hierarchy and ruled titles for the Brain's search-first Library, Recent saves and Jobs, with a broad reading column for notes and a narrow time column for work.
  Preserve the three-pane Library where space allows, explicit tap-to-expand source, past Review date label, exact History, collapsed Change log, Proposal links and Revert eligibility.
  Keep Jobs' one-time initial selection, quiet successes, named failures, Research, Cancel, Retry and Diagnostics.
  These existing interactions already reduce rereading when a source or Job updates.
- **Carry the quieter surface through administration | Amend visual criteria in #31, #32 and #33.**
  Use plain grouped rows in Connections with permission and last read in separate columns, “Needs you” first, and restrained tiles for available sources.
  Use the same heading and disclosure scale in routed Settings, including Saving and review, Machines and Replication, Paired clients and Service health.
  Keep required fields and Continue prominent in Setup, preserve all five steps, resume and Join, and use the compact centered form for pairing and service recovery.
  Carry forward the earlier design's feature inventory rather than treating the prototype's sample pages as an exhaustive specification.
  This transfers the calm reading order without hiding administrative tasks.

## Narrow screens and accessibility

- **Fit the search prompt and preserve navigation | Amend #18, #21, #34, #35 and #40.**
  At 375 px replace “Find a person, project or decision...” with the complete “Search the Brain” prompt and hide the visual shortcut keycap when space is tight.
  Keep the accessible label after entry, preserve the shortcut itself and keep the direct Search destination in the narrow Home, Approvals, Search, Brain, More bar.
  Reserve safe-area space below the final row so the bar cannot cover an action.
  Verify the full visible prompt at 320 and 375 px and at 200% zoom; an accessible name alone would miss the truncation in the blind screenshot.
- **Stack each record in reading order | Amend #23, #35, #39, #40 and #41.**
  Place stamp and kind first, the complete wrapping subject at 16 px or larger next, and source plus due time below, including when source or title spans multiple lines.
  Preserve #39's three recovery-rehearsal region suffixes and its visible-title journey.
  Preserve #40's measured 44 × 44 CSS px targets including links, and check first and last actionable rows above the bottom bar.
  Keep the 320 px and 200% no-horizontal-scroll checks, screen-reader landmark and count announcements, reduced motion, forced-color focus checks and no single-key irreversible actions.
  Full subjects and separated targets let the owner distinguish neighboring items and act accurately on a phone.

## Phasing and tickets

- **Change the source of visual authority first | Rewrite #14 Further Notes and amend #17 and #35.**
  Make the corrected blind Home and Inbox composition the visual target, with #14's count, failure, timing and Draft contracts controlling behavior.
  Refer to the earlier spec's heavy-day fixture, Draft and dot tables, feature map and narrow-screen journeys by name so those requirements survive the change in reference.
  Review the token and typography delta against open PR #36 before resuming #17; its contrast tests, local Inter budget, icon primitives and stylesheet separation are reusable.
  This avoids shipping a foundation whose first acceptance criterion is the superseded zinc and indigo look.
- **Test the deciding view before rolling out the new look | Amend #14 Delivery, #17, #18, #21 to #26, #34 and #35.**
  Make the first reviewable slice the masthead, search, lead and follower Heads-ups, coverage line and mixed typed Inbox together on fixture data; carry the approved metrics into the existing production tickets.
  Move the shared search interaction in #34 alongside #21, and run narrow and contrast checks from #35 with each applicable slice.
  Keep the seven deliverable phases, working interim routes and incremental documentation; use the existing issues for implementation and #35 for final verification.
  Keep #19 and #20's decision projection and exact service totals independent of the visual sort, grouping and viewport.
  The recorded prerequisites PR #12 and PR #13 are merged.
- **Make the screenshot suite catch layout regressions | Amend #35 and #37 through #41.**
  Capture the same morning, overlap, quiet and heavy mixed-day data in both themes at 1280 × 800 and 375 × 812, plus the existing 320 px and zoom checks.
  Exercise the 375 px prompt, active Home without a badge, warning-state glyph, complete first Inbox row under overlapping meetings and recognizable kinds in grayscale.
  Record actual row bounds for fold checks, visible text for clipping, target bounds for taps, destination and focus for transitions, and exact or lower-bound counts after each decision.
  Keep #37 to #41 as separate regression tickets with their original journeys; add these checks to their matching acceptance criteria.
  **Disposition:** rewrite #17, #18 and #23 as above, amend the indicated sections of the remaining presentation tickets, retain #20 as written, and carry the underlying #19 rules forward.
  No new ticket or whole-ticket removal is needed; the superseded default chips, tinted headers and sidebar are requirements to replace inside existing tickets.
  The learning roadmap in #15 and live Meet end detection in #16 stay outside this redesign.

## Where the existing spec is stronger

- **Count integrity (#19, #20, #24).**
  Keep the existing projection over the blind design's broader definition of a decision.
  Count a waiting Draft and its open source item once in Approvals, count an open promoted meeting once on Home, exclude standalone briefings and routine failures, and count only sign-ins in Connections.
  Preserve exact totals beyond list limits, lower bounds such as “12+”, the unknown first-load state and the strict coverage condition for “Nothing needs you.”
- **Safety after sending (#27, #28, #37).**
  Preserve all fourteen editor and delivery states, independent group failures, version-specific approval, explicit restore and conflict recovery, and a durable “Check destination” warning back on the Inbox item.
- **Real time, real coverage (#22, #25, #26, #38, #41).**
  Keep the three-input coverage decision, a failed request distinct from an empty response, briefing freshness and per-occurrence dismissal, live wake and time-zone handling, and fixed-clock focus tests on real rendered links.
- **Discoverability and access (#18, #23, #29 to #35, #39, #40).**
  Keep the narrow bottom bar, shortcut sheet, Hidden and Undo, library provenance, deep-linked Settings, first-invalid-field focus, visible-title checks and measured touch targets.
  Retain the agreed new route names and shortcut letters, the no-redirect decision and the incremental rollout without a feature flag.

## Owner decisions (2026-11-18)

1. The flat Inbox opens in service priority order, with Newest first one selection away.
2. At 1280 × 800, show at least one complete Inbox row during overlapping meetings with a sign-in problem and two on a normal morning with an unread briefing.
3. Use a desktop masthead with Machine and Reader one click away, show the Reader immediately on Connections, and keep a persistent warning visible when the Reader is silent.
4. Retire the daily briefing at local noon and keep #25's Earlier today history.
