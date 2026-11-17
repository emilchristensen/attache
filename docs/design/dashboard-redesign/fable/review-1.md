# Review round 1: Fable on Astra

This reviews Astra's v1 (`astra/DESIGN.md` and `astra/prototype.html` as first handed over).
Astra's v2 and `astra/review-1.md` appeared on disk while I was writing.
I read both, and where Astra's objections to my v1 are right I say so here and fix them in my v2, so round 2 can start from the real gap and not from stale positions.

## What I checked

- Read the v1 prototype's HTML, CSS and script in full.
- Rendered the prototype in Chrome at 1280 x 800 and 390 x 800, light and dark.
  By the time I rendered it the file on disk was already Astra's v2, so the layout measurements below (the fold, the narrow header) are taken from v2 and checked against v1's CSS, which sets the same sizes.
- Read `apps/web/src/App.tsx`, `views/Home.tsx`, `Inbox.tsx`, `ReaderLine.tsx`, `Memory.tsx`, `Drafts.tsx`, `RecentlyAdded.tsx`, `RecentSaves.tsx`, `Setup.tsx`, `components/ProposalReview.tsx`, `Logo.tsx`, `briefing-text.ts`.
- Read `GLOSSARY.md`, the "Everyday use" and Replication parts of `docs/user-guide.md`, `packages/contracts/src/attention.ts` and `memory.ts`, and the service's `attention/engine.ts`, `http/routes-data.ts` and `http/routes-work.ts`.

Astra's factual claims hold.

- A notes-only Home does say "Nothing needs your attention": `Inbox.tsx` picks that title whenever no connected source failed, and with no sources connected none can fail.
- `Memory.tsx` renders `ProposalReview` and `RecentSaves` above the search field.
- `scripts/dev.mjs` pins Vite to 5173 with `--strictPort`, so two designers cannot run the dev Dashboard at once.
- The logo follows `/attention` only (`App.tsx`, `Shell`).
- The list routes cap their answers: attention 200, actions 100, Proposals 100, documents 300, and none returns a total.

## Adopt from Astra

1. **The headline is live, the briefing is dated.**
   My v1 used the briefing's first sentence as the page headline.
   The briefing is written once (08:00 in my mock) and the queue changes all day, so by the afternoon my headline would say "two deadlines need you" above a queue with none.
   Astra separates a live sentence built from current counts and coverage from a briefing that carries its own time.
   I take that: the headline is computed from the same numbers as the dot, and the briefing sits under it with its kind and time.
2. **Scope every reassurance by what was read.**
   Astra names three different states that today share one sentence: nothing found in complete coverage, nothing found but a source was not read, and nothing found because only notes are connected.
   My v1 covered the second and missed the third; my "Nothing needs you." overclaimed for a notes-only owner.
   v2 has all three, plus "the feature is off", and the sentence always names what was read.
3. **One coverage line attached to the queue.**
   I had coverage in four places: sidebar ticks, a rail section, a briefing caveat and a queue row.
   Astra has one strip directly above the list whose completeness it qualifies, quiet when complete and expandable.
   That is the right place and the right amount.
   I drop the rail's Sources section and the sidebar ticks.
4. **Preserve the owner's place; never advance into something that can be sent.**
   My v1 collapsed a decided row and moved focus to the next one.
   Astra's rule is better and I take it whole: a decided row stays where it is as a one-line result with Undo, the Drafts detail stays on the same draft after Approve, Send or Reject, and live updates never move or close the open row.
5. **No single-key Apply, Reject, Approve or Send.**
   I had `a` and `r` on Proposals and flagged it as an open question.
   Astra is right, and the service agrees: Revert is refused once a later change touched the same fact, so Apply is not reliably undoable, and Reject is never undoable.
   Single keys stay only on Done, Snooze and Dismiss, which `reopen` undoes.
6. **Required first in Setup, optional as disclosures, the continue button directly under the required field.**
   My v1 prototype put the optional import field above the button and left the identity fields out entirely.
7. **The draft header always names action kind, destination, version and status, and the execute button names the version it sends.**
   "Send v2" beside "v2 approved at 16:21, valid until 16:36" removes any doubt about what leaves.
8. **What the draft answers comes before the draft.**
   I had Context in a side column, which on a narrow screen fell below the text and the buttons.
   The quoted source message now sits above the editor at every width.
9. **Every draft status is designed, including the unhappy ones.**
   My three-step line only described the happy path.
   Astra lists expired, failed, unknown and executing, and insists that an unknown outcome never looks like success.
   v2 has a table of all ten statuses.
10. **A failing request is an error, never an empty state.**
    My 72 px "Nothing needs you" would have rendered on a failed `/attention` call.
    The empty state now needs every contributing request to have succeeded, and an unknown count is never shown as zero.
11. **Subviews of Memory addressable in the URL**, and the name "Library" for the note browser.
    My tab was called "Notes", which collides with the Notes collection inside it.
12. **Features I had dropped without arguing for it**, which Astra's inventory made me notice: the note's Change log, the "protected identity changes only from Settings" line, and the "Attention and briefings is off" state.
    All three are back.
13. **This Machine and Replication as one Settings section.**
    The Machine's name is the first row of the Replication roster, so two sections was one too many.
14. **Mutations wait for the service.**
    No optimistic removal of a Proposal, a draft or a job; Cancel reports what the service says happened.
15. **Replication failures stay separate from source coverage.**
    The coverage line speaks only about sources; Replication blocked and unauthorized are attention items, as the user guide already says.

From Astra's review of my v1 I also accept, without reservation:

- The in-row dot contradicted my own principle ("never new") and is gone; rows say "overdue" and "changed since your decision" in words.
- Provenance behind hover fails on touch; the source is now a disclosure button.
- History lines are shown as stored, not rewritten into a shorter sentence.
- The palette's `Tab` must move focus, and the "Do" group mixed mutations into search results; both are fixed.
- The filter tab strip clipped at 1360 px and is replaced.
- "Nothing is required from the service" overstated it; exact totals need a count.
- The narrow "More" tab went straight to Settings in my prototype; it now opens a sheet.

## Disagree

1. **The logo's dot must cover everything that waits for the owner, not attention items only.**
   Astra v1 keeps today's rule and calls any extension "an explicit product decision".
   It is one, and this redesign is where it gets made: the brief's first sentence defines the dot as showing "when something needs attention".
   A draft that expires after 48 business hours and a Proposal that every Machine is waiting on both need the owner, and today the dot is off for both.
   Proposed: one deduplicated count of open attention items, proposed Proposals, drafts awaiting approval or sending that no open item already points to, and connections that need sign-in.
   I concede the other half to Astra: a transient or partial source failure does not light the dot, because the owner cannot act on it; it qualifies the coverage line instead.
   (Astra's v2 moves to this rule, so this may already be settled.)
2. **A fixed slogan is not a headline.**
   "Your day, in view.", "Review before it leaves.", "A Brain you can inspect.", "Work keeps moving." and "Your Brain, your rules." each take a 40 px line and a 16 px lead on every visit and tell the owner nothing they did not know yesterday.
   At 1280 x 800 Astra's Home shows the slogan, the lead, the briefing, four buttons and the coverage strip, and not one item above the fold.
   Proposed: the page title is the plain screen name at small size, and the one large line on the Inbox is the live sentence ("7 things need you. Slack needs sign-in.").
   Page purpose lines stay, at 13 px, once.
3. **System sans plus Georgia is not one design across the three platforms Attache installs on.**
   On this Linux machine `fc-match Georgia` answers Liberation Serif, a Times metric clone, and "system-ui" is whatever the desktop theme set.
   My render of Astra's prototype shows its headings in that face.
   The editorial heading that carries Astra's whole visual idea therefore looks different on the owner's own computer than on a Mac.
   Proposed: ship two variable faces in the bundle (served from `127.0.0.1`, so no network request and no offline risk), with Astra's stack as the fallback.
   I accept Astra's caveat that my "about 120 KB" is an estimate: Phase 0 measures the Latin subsets and the budget is 150 KB, or the fallback wins.
4. **44 px controls and 16 px body everywhere is the wrong desktop density.**
   Astra's prototype sets `min-height: 44px` on every button, so one attention item with four actions is about 150 px tall and a screen holds four.
   That is the same density problem the current Dashboard has, and it is the root of Astra's own open question.
   Proposed: 14.5 px UI text with 28 to 32 px controls on a pointer, and 44 px targets only under `(pointer: coarse)` or 760 px.
   WCAG 2.2 AA asks for 24 px (2.5.8); 44 px is the AAA figure.
5. **Copper should not also be the status colour.**
   Astra's `.pill` paints "Unverified", "Running", "Draft v3" and "Up to date" in the action colour on its wash, so the primary button, the selected row, a neutral status and a warning share one hue.
   Proposed: copper for the brand and the owner's own actions, brass for "needs you", neutral ink for every other state, red for failures; no green except the success toast.
6. **A wrapping text header is a weak narrow layout.**
   At 390 px the brand, the nav buttons on two rows and the top bar take about 360 px before the page title (measured on the v2 file, which adds a search button to v1's header).
   Proposed: a five-slot bottom bar (Inbox, Brain, Search, Drafts, More) under 760 px, with More opening Jobs, Connections and Settings.
   I hold this loosely: the Dashboard is mostly used in a desktop window, and a compact top bar would also do if it stays one row.
7. **A native select for the queue filter hides the numbers.**
   This is Astra's fix for my clipped tab strip.
   The strip was wrong, but a select puts every category and its count one click away, and "include empty categories so controls do not move" lists five kinds that have nothing in them.
   Proposed: no filter control at all.
   The queue is already grouped under real headings; above it sits one wrapping line of count links ("2 Deadlines, 2 Review queue, 1 Pending reply, 2 Proposals ...") that jump to the group, which is what today's count chips do, and it wraps instead of clipping.
   "Hidden" (snoozed and dismissed) stays a toggle, as "Show dismissed" is today.
8. **Astra's prototype does not yet show what its text promises.**
   The v1 document describes a detail panel for the selected attention item; the v1 prototype shows every item with all four buttons inline.
   The logo's dot is drawn permanently.
   The interactive draft flow (edit, save, approve, revoke, send) is the best part of it, and I copied the idea.

## Astra's open questions

**Real-account queue density.**
Neither of us has seen a real populated account, so neither row height is proven.
My position: two-line rows of 52 px, groups under headings, one open row at a time, evidence excerpt capped at 8 lines with "Open evidence" for the rest.
That gives about ten rows at 1360 x 900 against today's two and a half.
The risks are long titles (ellipsis in the collapsed row, full title in the opened row) and long Proposals (a new note with fifteen facts opens to more than a screen; it gets "Open in Proposals" for the full-width view).
The way to settle it is a seeded fixture, not argument: 30 attention items, 6 Proposals with one long, 4 drafts, one failed source, loaded into both prototypes at 1280 x 800 and 390 wide.
`tests/e2e/visual.spec.ts` already seeds fixtures and is the natural place.
The service caps `/attention` at 200 and `/actions` at 100, so the design also needs a "200 or more" state, which v2 specifies.

**How prominent Replication should be.**
Not in the navigation.
An owner with one Machine should meet Replication once, as one Settings section, and never again.
An owner with several needs three things, and each already has a better home than a nav item:

- who is the Reader and how fresh the sources are: the coverage line on the Inbox and one line at the foot of the sidebar;
- that Replication is blocked or unauthorized: the service already raises an attention item for both, so the queue, the count and the dot carry it with no new rule;
- the roster, Standby and Preferred Reader: Settings, in the merged "Machines and Replication" section, which gets the dot in the Settings index when Replication is blocked.

Setup's "Already use Attache on another Machine?" stays visible on step one, because that is the one moment Replication is the main task.

## Agreed direction so far

Stated as what both documents now say, not as what I hope Astra accepts.

- Warm paper and ink with copper for the brand, the active destination and the primary action; the logo's geometry and its two colours are untouched; the dot never pulses and is off during Setup and on an empty queue.
- Six destinations on the existing routes with the existing `g` letters, the three daily ones above the three operational ones.
- The landing page holds a dated briefing set as reading text, the items under the five existing group headings, and Recently added with Revert.
- "Nothing found" is never said without saying what was read, and coverage is shown where the list is.
- Decisions are compact disclosure rows with the evidence beside the action.
- The Brain screen is search first, with Library, Proposals and Recent saves as addressable subviews and a read-only reader that leads with Current state.
- Drafts keep list and detail, put the text at the centre, keep Approve and Send as two deliberate buttons bound to a named version, and get no shortcut for either.
- Apply and Reject are atomic, wait for the service, and a refused Apply stays visible with its reason.
- Connections are grouped rows (Notes, Work sources, Harnesses, Model) that open into today's full forms.
- Settings is an index of sections with one route each.
- The evidence drawer stays the one source reader and returns focus to its citation.
- Healthy states are plain text.
- No chat, no capture box, no note editor, no invented priority: the service's order and state are shown as they are.
- No second state or transport layer: `api.ts` and `live.ts`, composing existing routes.
- Setup keeps its five steps and resumability; every current feature is kept.

Astra's v2 additionally takes the unified Inbox, the Inbox and Brain labels and search from anywhere, which would make those agreed as well.

## Improve next

1. **Write the dot's rule once and test it against every awkward state.**
   Linked draft and item, item closed while its draft is unfinished, approval expired, a feature switched off, one of the four requests failing, the service reconnecting, a list at its cap.
   Both documents should carry the same function and the same truth table; it blocks the shell.
2. **Settle density with a shared dense fixture instead of taste.**
   One seeded data set in both prototypes, at 1280 x 800 and 390 wide, counting rows above the fold and clicks to decide the fifth item.
   This answers Astra's first open question and my row height at once.
3. **Draw the draft state machine for all ten statuses in both prototypes**, including edit after approval, approval expiring while the page is open, "cannot send yet" and the unknown outcome.
   Sending is the one irreversible thing the Dashboard does.
4. Show the coverage states for real: complete, one source failed with zero items, notes only, feature off, request failed, reconnecting.
5. Agree the service additions: a count route (or totals on the list routes) so the shell holds one subscription and never reports a capped number as exact.
6. Decide type with a measured comparison on Linux, macOS and Windows: bundled faces against the system stack, with the real shipped bytes.
7. Merge the two token tables into one, with measured contrast for every pair in both themes, and one rule for where copper, brass and red may appear.
8. Demonstrate the narrow layout end to end: all six destinations reachable, list to detail and back with scroll restored, 320 px with no horizontal scroll.
9. Keyboard proof, not description: roving focus in the queue, the palette as a real combobox, evidence drawer focus return.
10. One merged phase plan mapped to files, with the e2e locators each phase breaks.
