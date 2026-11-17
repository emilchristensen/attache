# Review round 2: Fable on Astra

Read: `astra/review-1.md`, `astra/DESIGN.md` v2 and `astra/prototype.html`.
While I worked, `astra/review-2.md`, `astra/spec-states.md` and `astra/dense-fixture.json` appeared, and the prototype moved to v3.
I read `review-2.md` and the fixture, and answer both here so round 3 starts from the real gap.
`spec-states.md` is reviewed in round 3 as agreed; I only took the fixture and the narrow briefing rule from it.

Checked, not assumed.

- Rendered Astra's prototype in Chrome at 1280 x 800 and read its source.
- Embedded `dense-fixture.json` unchanged in my prototype and measured both at 1280 x 800.
- Read the service for every claim about drafts and counts; the references are in `spec-dot-and-drafts.md`.
- Measured the font files instead of estimating them.

## The seven open items

### 1. Dot scope: settled, with the rule tightened

Astra's v2 already moved to "everything the owner can decide", and `review-2.md` accepts it.
My final position is the rule in `spec-dot-and-drafts.md`, which is narrower and more exact than my v2.

- Open attention items, proposed Proposals, drafts in `draft`, `approved` or `revoked` that no open item already represents, and connections in `needs_auth`.
- A transient or partial source failure, and a connection in `error`, never count.
- An unknown never changes the dot, in either direction.
- "Nothing needs you." is only said from an exact zero.

I concede two things to Astra here.
My v2 called the list limits "caps" and summed capped parts into one number; they are defaults with no upper bound, and a deduplicated total over an incomplete list has to be a provable lower bound.
The spec now leaves out any draft whose item cannot be seen, so "N+" is never too large.

### 2. Headings: settled

Astra accepts the live headline, and Astra's v3 prototype now opens with "38 decisions need you."
I take one thing back from Astra's version: its second line ("30 attention items, 6 Proposals and 2 standalone drafts; 2 linked drafts count with their items") explains the number.
In my design the count links under the briefing carry the same breakdown, so I do not add a second sentence, but the linked-draft explanation is worth one line in the shortcut and help sheet.
Measured on the shared fixture at 1280 x 800 with the briefing open, my prototype shows 6 closed rows above the fold and Astra's v3 shows 5, with the sixth cut at its source line.
That is the acceptance test ROUND-2 set for this item, and both pass it.

### 3. Type: hold, now with numbers

Astra's compromise is "bundled faces within a measured 150 KB budget".
I measured the files the build would ship (`@fontsource-variable`, Latin subset, woff2, variable weight).

| File | Size |
| --- | --- |
| Newsreader, roman | 58.1 KB |
| Instrument Sans, roman | 30.1 KB |
| Both romans | 88.2 KB |
| Newsreader, italic | 64.5 KB |
| Newsreader with the optical-size axis | 132.0 KB |

Position: ship the two romans, 88 KB, and nothing else.
No italic (quotes are set roman, and synthesised italics are switched off) and no optical-size axis.
That is 62 KB under the budget Astra accepted, so I consider this settled on Astra's own terms.
The prototype now loads the same cut (weights only), so what it shows is what would ship.
Phase 0 still confirms the number from the real build, and the fallback stack stays Astra's.
The reason has not changed: the owner's own Machine is Linux, where Georgia resolves to Liberation Serif.

### 4. Density: settled

Astra accepts 14.5 px interface text and 32 px desktop buttons.
I accept Astra's two conditions, and my v2 did not meet either.

- Reading text is 16 px or more everywhere: the briefing lines and quotes were 15 px and are now 16.
- 44 px targets on a coarse pointer and under 760 px: my v2 said so and the prototype did not do it; it does now.

Long titles wrap when a row is opened, as Astra asks.

### 5. Colour: settled, and I found my own violation

Astra accepts that copper is brand, selection and action only.
Holding myself to the same rule, my v2 broke it in four places: the current step of the draft step line, the current step in Setup, the job progress bar and the job spinner were copper.
A current step and a progress bar are status.
All four are ink in v3.
The rule is now: copper appears on a link, the primary button, the selected row and the active destination, and nowhere else.

### 6. Inbox filter: accept Astra's compromise

Wrapping count links that jump to the real group headings, plus a separate Hidden toggle.
Astra is right that they are controls, and my v2 was wrong to say otherwise.
So their order is fixed, and a group that empties while the page is open stays in the line as "0 Deadlines" until the next visit, so a focused link never disappears.
I add one thing for narrow screens, which is Astra's original idea put where it works best: under 760 px the links become one native "Jump to a group" picker with the same counts.
Seven links wrap to three 44 px rows at 360 px; the picker is one.
It is navigation, not a filter, so nothing is hidden by it.

### 7. Replication: settled

One "Machines and Replication" section in Settings.
From Astra's wording I add the link: the Machine and Reader lines at the foot of the sidebar open that section directly, and a Replication item in the Inbox links to it.

## Astra's remaining objections

| Objection | Position |
| --- | --- |
| Do not promise one-click Revert for every automatic save | Accept. Events and note-text appends cannot be reverted and later edits end eligibility. The Settings sentence now reads "a change that can still be reverted has a Revert button", and the rail says "events cannot be reverted" on such a row. |
| Do not call defaults caps; prove the bound | Accept. See item 1 and section 1.3 of the spec. |
| Decision shortcuts off by default, including Done and Dismiss | Accept. `j`, `k` and `Enter` only move and open. The single keys for Done, Snooze and Dismiss exist but are switched on by the owner in the shortcut sheet. Undo does not make an accidental decision welcome. |
| The narrow Inbox spends its first screen before the second item | Accept. On a narrow screen the dated briefing is a closed disclosure showing its first line, its buttons appear when it is opened, and the count links are one picker. Measured at 360 x 800 on the fixture: 4 rows above the fold, first row at 308 px, against 489 px before. |
| Do not auto-select the newest failed job on every update | Accept. The default selection in Jobs is made once, when the screen opens. |

## New in Astra's v2 and v3 that I disagree with

1. **"No backend work is required for the core proposal."**
   It is required, and for something neither design had noticed.
   When an approval's 15 minutes end, the draft stays `approved`, and `approve` refuses anything that is not `draft` or `revoked`.
   Both our status tables say "approve again"; today the service answers `not_approvable`.
   The owner has to revoke an approval that has already ended, then approve.
   The spec lists the change (D1) and the two-call workaround.
2. **A draft's version history is not available.**
   Astra's prototype shows "Version history: v3, v2, v1".
   The service keeps the version number and hash of each edit and overwrites the text.
   History can list versions, never show them, and Save has to say the old text is gone.
3. **Reject is not final, and today it is silently reversible.**
   Astra lists Reject beside Approve as an end state.
   The service lets a rejected draft be edited back into `draft`, and today's editor stays enabled on it.
   I make that an explicit "Restore as vN+1" and lock the editor.
4. **"View draft" outlives its draft.**
   Both designs put the linked draft's state on the attention item.
   `action_id` is never cleared, so after a draft is rejected, expires or fails, the item says "View draft" for ever and "Prepare draft" never comes back.
   The spec asks for `actionStatus` on the item (C3).
5. **The expanded queue row only navigates.**
   Astra's text says a row shows evidence and consequences when opened; the prototype row holds one sentence and an "Open Drafts" or "Open Brain" button.
   For attention items and Proposals the decision belongs in the row, with the evidence, or the unified Inbox is a table of contents.
   Approve and Send stay on the Drafts screen; on that we agree.
6. **The logo's dot is still drawn permanently** in the prototype, also on Setup.
   Minor, but it is the one thing the redesign is built around.
7. **Mixed names.**
   The navigation says Inbox and Brain; the v2 document's screen sections still say Home and Memory and the Brain page head says "Memory / Library".
   One name per screen, everywhere, or the rename costs more than it gives.
8. **A fourth hue for focus.**
   Astra's focus ring is blue.
   I keep the ring in ink: it is 2 px with a 2 px offset, never looks like selection, and keeps the interface at three hues.
   I hold this loosely; a blue ring is not wrong, only one more colour to justify.
9. **Narrow navigation.**
   Astra's spec moves to one brand row with a Menu disclosure for all six destinations.
   That fixes the two-row wrap I measured in round 1.
   I still prefer the bottom bar for the three daily destinations, because a Menu puts the Inbox count one tap away on the screen where it matters most.
   This is Astra's spec to own; I will argue it in round 3 with both versions on the fixture.

## Where this leaves the two designs

All seven items are settled or one confirmation away.
What is left for round 3 is small and concrete.

- Review each other's spec: mine against `spec-states.md`, especially the lower-bound rule against Astra's "deduplicate loaded IDs" wording, which I believe now say the same thing.
- The service changes C1 to C3 and D1: agree which are in scope for the redesign and which ship as "N+" and a two-call workaround.
- Narrow navigation: bottom bar or Menu.
- One merged token table and phase plan.
