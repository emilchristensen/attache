# Attache Dashboard redesign - Fable, v6

Open `prototype.html` in a browser to see every screen described here.
The bar at its bottom right switches light and dark, the moment (Morning, 15 min before a meeting, Later), the connected services (sixteen states, from all fine to could not check), the day (Normal, Heavy day which is the shared fixture `heavy-day-v1`, Inbox empty, All clear) and a failed request (attention, drafts, Proposals or all three, on first load or after a good load), and opens the Colours page and Setup.
The first screen is Today, Approvals is the second entry in the sidebar, and a draft opened from Approvals has a picker that shows it in each of its fourteen states.
`Ctrl K` focuses the search field on Today and opens the search palette everywhere else.
`screenshots/` holds 114 PNGs of the v6 prototype at 1280 x 800 and 360 x 800, and `current/` holds captures of today's Dashboard taken with `tests/e2e/visual.spec.ts`.
Some captures show the whole page instead of one viewport: names ending in `-full`, the Colours pages, `light-approvals-heavy` and the two `today-deuteranopia` captures.
Names starting with `status-` show the Connected services area alone, one per state.
`../astra/review-3.md` is the review of v4 that this version answers, and `../FEEDBACK-1.md` is the owner's review of v3 that v4 answered.
`spec-dot-and-drafts.md` is the authoritative rule for the dot, the count and the draft state machine; its Part 1 is revised for v5, and sections 5.1, 5.3 and 7 here summarise it.

## Changes in v6

v6 changes the look and nothing else.
The owner liked the colours of v5 and asked for the direction of T3 Code's interface, and then gave up the copper and brown palette.
Structure, wording, states, the count rule and the phases are as in v5, and the 114 screenshots were retaken under the same names.

- **Neutral surfaces.**
  The warm paper neutrals are replaced by a zinc scale: near-white `#fcfcfc` with white cards in light, near-black `#09090b` with `#111113` cards in dark.
  On neutral ground the type hues, the proactive panel and the status rows are the only colour on the screen, so they separate more than they did on paper.
- **One accent, and it is indigo.**
  Copper is gone from the interface.
  Links, the primary button, the focus ring, selection and the Draft type use indigo, the hue the proactive area already had.
  The hue table has twelve hues instead of thirteen.
- **One typeface.**
  Newsreader and Instrument Sans are replaced by Inter, with the system sans as fallback.
  Titles are semibold sans with tight tracking, the uppercase letterspaced eyebrows became plain 12 px labels, and reading text is 15 px (16 px on narrow screens).
  The bundle carries one face instead of two.
- **Search is built like a composer.**
  A 56 px neutral field with a 16 px radius, a hairline border and the only resting shadow on the screen; the border and a 3 px ring turn indigo on focus.
  The Browse links under it are pills.
  Its identity is its size, shape and position, no longer a copper border.
- **Quieter chrome.**
  Sidebar rows are 32 px with a filled selection and no outline, on a sidebar one step darker than the page.
  Buttons have a hairline border, the By type and Newest first switch is a segmented control with a raised thumb, and controls have an 8 px radius, cards 12 px, panels 16 px.
- **Floating surfaces are glass.**
  Search results, the palette, menus and the More sheet are 86 percent opaque with a 14 px backdrop blur.
- **What did not change.**
  The twelve hues and their four steps, the brass attention dot, the icons, every layout, and the logo.
  The logo mark keeps its copper and brass because it is the shipped product mark and lives outside this folder; it is now the only warm thing in the interface (section 13).

Contrast was recomputed for the new neutrals: the lowest text ratio is 4.63:1 (meta text on the indigo panel in light), the lowest solid-on-surface ratio is 4.41:1, the input border is 3.12:1 or better and the attention dot 3.28:1 or better.
Where a sentence below still says copper in the change logs of v2 to v5, read it as history; sections 1 to 13 describe v6.

## Changes in v5

v5 is the final design pass.
It applies Astra's third review and two things the coordinator saw in the v4 screenshots.
The direction of v4 is unchanged: Today with its four areas, Approvals as its own page, one hue per type.

**Must fix, all three applied.**

- **Connected services has a complete decision table** (section 5.1, area 3).
  v4 drew three states: fine, sign-in needed and down.
  v5 separates readable sources from other connections (the model and the Harnesses, which have no Source refresh), the Reader and the features, and gives every coverage state, connection status and readiness state its own word, sentence and action.
  Green now needs positive evidence from all three requests; a source that was never read says "Not read yet" and shows no time; a request that has not answered says "Checking" and one that failed says "Could not check".
  "The other N sources are working" counts only what is known to work, and a retry is promised only when a Reader is active and the refresh is scheduled.
  The prototype has sixteen states, with notes only, feature off, no Reader, a silent Reader and mixed problems among them.
- **Failed requests and scoped empty states are shown, not only written** (section 5.1, area 4, section 5.3 and section 7).
  The prototype has a control for a failed attention, drafts or Proposals request, on first load or after a good load, independent of the services control.
  It shows Retry, the retained rows with the time they were observed, the lower bounds ("12+", "At least 10 need you") and the dot that stays as it last was.
  An Inbox that is empty while approvals wait says "No open Inbox items."; "Nothing needs you." is said only from an exact combined zero with every source read.
- **The work mix is visible at 360 px** (section 4, Narrow screens).
  A summary of the types that have items, with their counts, stands above the first group; the picker stays for filtering.
  The briefing shows its headline and two buttons, and opens on "Read the briefing".
  The order switch and the type picker share one row, and "Hidden" moves under the list.

**Decisions on the open points**, following Astra's positions; the owner may still override them (section 13).

- The first screen keeps the name "Today", and "Inbox" names its fourth area.
- **An item whose draft is waiting stays in its type group**, with a "Draft waiting" tag and View draft.
  Its decision is counted in Approvals only.
  A type count is a count of open items and "need you" is a count of decisions; one line under the Inbox heading says how the two relate ("11 open items: 10 need you here, and 1 has a draft waiting in Approvals").
  v4's quiet line "1 more item has a draft waiting" is gone.
- The "a request failed" control is in the prototype.
- Approvals stays as drafts plus Proposals.

**From the coordinator's look at the v4 screenshots.**

- **The sidebar no longer repeats the search field.**
  v4 had a "Search the Brain" box in the sidebar directly beside the big field on Today.
  It is now one small control beside the wordmark, a search icon and `Ctrl K`, on every screen.
  `Ctrl K` and `/` work everywhere as before.
- **The type chips fit one row at 1280 px.**
  The column is 932 px wide instead of 880 and the chips are a little tighter.
  When they do not fit (nine types, or a narrower window) they wrap into rows of even length, never one chip alone.
  Approvals takes the same width, so the two pages share a left edge.

**Should fix, applied.**

- The narrow search placeholder is "Search the Brain"; the examples stay on the desktop.
- A title has two lines on a narrow screen before it is cut, and the opened row shows it whole.
- The claim that every hue is distinguishable is withdrawn.
  The palette was run through a simulation of protanopia, deuteranopia and tritanopia in both themes; section 6 has the numbers, and the prototype's Colours page can show every screen that way.
- The proactive registry documents simultaneous meetings, a change of time zone and a meeting with no related notes (section 5.1, area 2).
- `GET /briefings/latest` returns one briefing of any kind, so the fallback for a stale, absent or manual briefing is defined, related notes are joined by item id and shown with the time they were found, and no meeting end time is shown.
- The time a card leaves stays visible on a narrow screen ("Leaves at 14:10, or on Done.").
- A draft that is being sent is listed under "In progress" in Approvals, not under Finished, and is not counted.
- Settings said Proposals are reviewed in the Inbox; it says Approvals.

**Also changed, not asked for.**

- A secondary button that is a link ("Open in GitHub") was drawn in link copper; it is ink like every other secondary button.
- When Attention and briefings is off, the first screen says so once, in the Connected services area, and not three times.

**Measured.**
At 1280 x 800 on a normal day, all four areas and the one-row chips are above the fold, with 2 Inbox rows while the briefing is unread and 4 once it is read.
On the heavy day with a source down and the briefing unread, the chips and the first row are above the fold.
At 360 x 800 on a normal morning the search, the briefing's headline, the status line, the Inbox heading, the type summary, the two pickers and the first row are above the fold, and 2 rows once the briefing is read.
On the heavy day at 360 x 800 with a source down, the type summary is above the fold and the pickers are cut by it.

## Not applied

Every must-fix item is applied; none is skipped.
These are the parts of the review that v5 does not do, or does differently, with the reason.

1. **The hues are not retuned** (should fix, the palette).
   Astra asked for the simulation before any adjustment, and v5 does the simulation and stops there.
   The result is in section 6: with one cone type missing, the eight type hues fall into two or three bands, most clearly in the light theme.
   Lightness is the only cue that survives all three deficiencies, and in the light theme every ink step already sits at the dark end to reach 4.5:1 on its soft step, so eight separable lightness steps do not fit without giving up either the contrast floor or the bright look the owner asked for.
   The word and the icon carry the type for those readers, as designed.
   A retune of the worst pairs is listed for the owner in section 13.
2. **Simultaneous meetings, a time zone change and a meeting without related notes are specified, not drawn** (should fix, the registry).
   The rules are in section 5.1; the prototype has one meeting in one time zone with notes.
   Each is a unit test of the registry against a fixed clock in Phase 2.
3. **Coverage `unauthorized` has no fixture of its own** (must fix 1, fixtures).
   It shows the same row as a connection in `needs_auth`, which the prototype has; the table in section 5.1 names both.
   It is counted in the dot only through the connection's `needs_auth` status, so the count keeps one source.
4. **A stale part's rows are left out of the number, not shown as a second number** (must fix 2).
   The written rule says an unknown part contributes nothing, so after a failed reload the retained rows are on screen with their time and the total is a lower bound without them.
   Showing "10 as of 16:16" beside it would be a second count with a different meaning; the heading says "as of 16:16, not refreshed" instead.
5. **The README is not updated.**
   Astra's fourth open point asks for it; the coordinator owns that file and asked me to leave it.

## Changes in v4

Kept as history; where v5 says otherwise, v5 holds.
The owner's review of v3 said two things: it is too dense to get an overview, and its colours are too dull to tell things apart.
v4 keeps what was settled (the dot, no single-key irreversible actions, nothing moves under the owner, accessibility, every feature) and changes the first screen, the place of approvals, and the colour system.

- **The first screen is Today, and it has four areas in a fixed order**: Search the Brain, For you now, Connected services, Inbox.
  It is one calm column, 880 px wide, with no rail.
  v3 led with a headline, a briefing, a count line and a coverage line above a dense queue.
- **Search is a field, not only a shortcut.**
  A 54 px field in copper opens the first screen and shows results in place.
  `Ctrl K` focuses it there and opens the same component as a palette elsewhere.
- **A proactive area, "For you now", is new.**
  It is a slot with one lead card: the daily briefing in the morning, meeting prep from 15 minutes before a meeting.
  Every card says why it is there and when it leaves, and the slot shrinks to one line when nothing is timely.
  Section 5.1 defines the slot, and section 10 names the service work that lets it learn.
- **Connected services is one green line when all is well.**
  Working services are never listed.
  A service that needs sign-in or is down gets one row with its consequence and its button.
  It replaces v3's coverage line.
- **Approvals have their own page.**
  Drafts waiting for approval and Proposals waiting for Apply or Reject leave the Inbox and move to Approvals, second in the navigation.
  The Drafts screen becomes the draft's own page inside Approvals, and the Brain's Proposals subview is gone.
- **Every Inbox item shows its type**: one hue, one icon and one word per type, grouped by type by default, with type chips that count and filter.
  The types come from the service's real attention kinds, which were checked in the code (section 5.1).
- **Colour is used actively.**
  v3's rule of three hues is withdrawn.
  Copper stays the brand; eight type hues, indigo for the proactive area, and green, amber and red for status join it.
  Every hue has four steps that pass contrast in light and dark (section 6), and the prototype's Colours page shows them all.
- **The count is split by page and still adds up.**
  The logo's dot and the tab title carry the total; Today shows the Inbox's part, Approvals its part, Connections a dot for sign-in.
  An open item whose draft is waiting counts once, in Approvals (section 7).
- **Density is traded for overview, and measured.**
  At 1280 x 800 on a normal day, all four areas and the type chips are above the fold with 2 Inbox rows in the morning and 3 once the briefing is read; v3 showed 6 rows and no overview.
  On the heavy day with a service down and the briefing unread, the chips are above the fold and the first row is cut by it; with the briefing read and all services fine, 4 rows are above it.
  At 360 x 800 the search, the proactive card, the status line and the Inbox heading are above the fold.
- **Recently added leaves the rail** and becomes one line under the Inbox that opens in place.

## Changes in v3

Kept as history; where a later version says otherwise, the later one holds.
Round 2 settled the seven open items; these are the changes that follow, and what reading the service turned up.

- **The count rule is written once and can be wrong in only one direction.**
  It lives in `spec-dot-and-drafts.md`.
  Each of its four parts is known, at its list limit, unknown or off.
  The number is shown as exact ("10"), as a lower bound ("9+", "At least 9 things need you"), or not at all.
  An unknown never switches the dot on or off, and "Nothing needs you." is only said from an exact zero.
  v2 called the list limits "caps" and summed them; they are defaults, and Astra was right that the sum has to be a proven bound.
- **The draft state machine is nine stored statuses and five derived states**, not "ten statuses".
  Three things in it are new and come from the service code: an approval that has ended cannot be approved again today, a new version replaces the old text for good, and Reject can be undone until the draft expires.
- **Four service changes are named** (section 10), each with what the Dashboard does without it.
  v2 asked for one.
- **Copper is no longer used for status anywhere.**
  The current step of a draft and of Setup, the job progress bar and the job spinner were copper in v2; they are ink.
- **Type is measured.**
  The two faces are 88 KB as Latin woff2 without italics and without the optical-size axis, 62 KB under the budget.
- **Reading text is 16 px or more** (the briefing and quotes were 15), and 44 px targets under a coarse pointer are now in the prototype, not only in the text.
- **The count links are controls**: fixed order, a group that empties stays as "0" until the next visit, and under 760 px they are one native picker.
- **Decision shortcuts are off by default**, including Done, Snooze and Dismiss.
- **The dated briefing is a disclosure**: open on a desktop, closed with its first line on a narrow screen, and its state is remembered.
- **The foot of the sidebar opens Machines and Replication** directly.
- **Jobs picks its default job once**, when the screen opens, and never again on a live update.
- **Revert is not promised for every change**: events and note text cannot be reverted, and the wording says so.
- **Measured on the shared fixture** (38 decisions): 6 closed rows above the fold at 1280 x 800 with the briefing open, 4 at 360 x 800.
  Today's Home shows two items at 1360 x 900.

## Changes in v2

Taken from Astra's design and from Astra's review of v1.

- **The headline is live and the briefing is dated.**
  v1 used the briefing's first sentence as the page headline, which goes stale as the queue is worked.
  The headline is now one sentence computed from the current count and coverage; the briefing sits under it with its kind and time.
- **The dot means one thing: a decision the owner can make.**
  A transient or partial source failure no longer lights it.
  The dot is gone from queue rows, from "unverified" and from blocked jobs; those say what they are in words.
- **One coverage line on the queue** replaces the sidebar ticks, the rail's Sources section and the "Attache" filter.
  Every empty state names what was read: all sources, some sources, notes only, or the feature is off.
- **Nothing advances by itself.**
  A decided row stays in place as a one-line result with Undo.
  The Drafts detail stays on the same draft after Approve, Send or Reject.
  Live updates never move or close the open row.
- **No single-key Apply, Reject, Approve or Send.**
  Single keys remain on Done, Snooze and Dismiss, which Reopen undoes.
- **The filter tab strip is gone.**
  It clipped at 1360 px.
  A wrapping line of count links jumps to each group, as today's count chips do.
- **Drafts**: what the draft answers is quoted above the text at every width, the send button names its version ("Send v2"), and all ten statuses are specified.
- **Brain**: the note browser is called Library, subviews are in the URL, the source of a fact is a disclosure button and not a hover, History lines are shown as stored, the Change log is back, and collection counts are dropped because the service does not return totals.
- **Search palette** is search and navigation only; the "Do" group is removed and `Tab` moves focus.
  It moves to the last phase.
- **Settings** has nine sections; This Machine and Replication are one.
- **Setup** puts the required field and its button first, with import and identity as optional disclosures.
- **The focus ring is an outline**, so focus never looks like selection, which is a fill.
- **"The service has to add nothing" is withdrawn.**
  The list routes cap their answers and return no totals, so an exact count needs a small addition.
- Restored from today's Dashboard, having been left out of v1 without an argument: the note's Change log, the protected identity line, the feature-off states.

Unchanged from v1 and still argued for: one Inbox for everything that waits, the Inbox and Brain labels, brass for attention and copper for the owner's actions, quiet healthy states, desktop density, bundled type, and the bottom bar on narrow screens.

## 1. The core idea

The logo makes one promise: the dot shows when something needs you.
Today the Dashboard does not keep that promise.
The dot follows only attention items, while Proposals wait on the Memory screen, drafts wait on the Drafts screen, and a connection that lost its sign-in waits on Connections.

This design makes the whole Dashboard an extension of the mark, and makes the first screen an overview.

- **The first screen answers four questions in order**: what do I want to look up, what should I know right now, is everything connected, and what is waiting for me.
- **The brass dot points at a decision the owner can make, and at nothing else.**
  It is not "new", not "changed", not "a source was slow".
- **Two places hold what waits.**
  The Inbox holds what the world asks of the owner; Approvals holds what Attache prepared and will not do without the owner's OK.
- **Everything that is fine goes quiet**, down to one green line for all connected services.
- **Every kind of thing has its own look**: a hue, an icon and a word, so a pull request review never looks like a reply that is waiting.
- **When nothing waits the dot leaves the logo**, the favicon and the tab title, and the screen says what was read to reach that conclusion.

## 2. Problems in the current Dashboard

These come from running the real Dashboard through the visual spec (captures in `current/`), and items 16 to 18 from Astra's run of a notes-only setup, checked against the source.

1. **Decisions are spread over three screens.**
   Home has attention items, Memory has "Memory changes to review", Drafts has approvals.
   The Home badge and the logo dot count only the first.
2. **Home spends its best space on things that are fine.**
   The Sources block (three green pills, "ok just now" three times) sits above the first item.
   At 1360 x 900 the owner sees two attention items (`current/light-home.png`).
3. **Every attention item is a five-line card with up to six buttons.**
   Title, summary, pill row, "Why", button row.
   Ten items take three screens of scrolling, and nothing can be triaged from the keyboard.
4. **The Memory screen buries the Brain.**
   Proposals and Recent saves come first, so the note list starts below the fold and the search box sits under two cards (`current/dark-memory-note.png`).
5. **Two near-identical ledgers**, Recently added on Home and Recent saves on Memory, with no visible relation between them.
6. **The collection tabs overflow.**
   People, Projects, Decisions, Notes, then "Im" cut off behind a chevron in a 340 px column.
7. **Provenance is unreadable.**
   "Source: Claude Code session in af0b809d-002071834c0a03e1 (agent-session: claude-code/6f1c2b0e-visual, observed 2026-11-17)" repeats under every fact and wraps to two lines.
   History is a bullet list of sentences that run over 200 characters.
8. **Status colour carries no information.**
   Jobs shows five green "succeeded" pills (`current/light-jobs.png`), Settings shows six green "ready" pills, Connections shows "connected" and "Complete" on every card.
   A real failure would be one more pill among them.
9. **The brand stops at the 26 px logo.**
   The interface is blue on blue-grey; the copper mark is the only warm thing on the page and the accent colour has nothing to do with it.
10. **Settings is one column of eleven cards** with no way to jump.
11. **Connections cards are all the same height**, healthy or broken, and show a raw temp path as "Account".
12. **Jobs opens on an empty "Select a job" pane**, and the only free-text input in the Dashboard (Research) is hidden there.
13. **The narrow layout has six text tabs** in the bottom bar; "Connections" and "Settings" touch (`current/narrow-home.png`).
14. **The draft screen leads with metadata**, a version hash and an expiry timestamp, above the text the owner is asked to approve; the 15 minute approval window is invisible.
15. **Search needs a visit to Memory and a scroll.**
16. **A notes-only Home says "Nothing needs your attention"**, because `Inbox.tsx` only changes that sentence when a connected source failed.
    The reassurance sounds wider than it is.
17. **Setup's continue button falls below an 800 px viewport** on step one, under the optional import and identity forms.
18. **Required and optional parts of Setup have the same visual weight.**

Found in the owner's review of v3, and fixed since v4.

19. **v3 was too dense to give an overview** (owner feedback).
    A headline, a briefing, a count line, a coverage line and a tight queue all competed above the fold, and nothing said "start here".
20. **v3 made every row look the same** (owner feedback).
    A review request, a reply and a deadline differed only by a small grey source tag.
21. **v3 used three muted hues**, so colour could not separate types, areas or states (owner feedback).
22. **Approvals were mixed into the Inbox** in v3, although they are a different kind of work: Attache is waiting for the owner, not the world.

## 3. Principles

1. **The dot is a promise.**
   Brass means "there is a decision here that you can make".
   It is never decoration, never "new", never "changed", never a health light.
2. **Overview first, detail on request.**
   The first screen shows few, clearly separate things.
   Detail opens in place: a row, the rest of a briefing, the rest of a group.
3. **Quiet when well.**
   A healthy state is one line; only exceptions get rows, buttons and their own colour.
4. **Colour separates, and never speaks alone.**
   A type, an area or a state has one hue, and the hue always comes with an icon and a word.
5. **Two queues, one count.**
   The Inbox is what others ask; Approvals is what Attache prepared.
   One decision is counted once, on the page where its next step is.
6. **Say what was read.**
   "Nothing" is always followed by its scope: which services answered, when, and which did not.
   A request that failed is an error, never an empty state, and an unknown count is never shown as zero.
7. **Evidence in place.**
   The quoted lines that justify an item or a Proposal are shown where the decision is made.
8. **Nothing moves unless the owner moved it.**
   A decision leaves its result where the row was.
   No screen advances to the next thing that could be applied or sent.
   Every mutation waits for the service's answer before the screen changes.
   The proactive area is the one place that changes with the clock, and it says when it will.
9. **The service's state, not ours.**
   Order, priority, kind and status come from the service; the Dashboard invents no urgency and no confidence.
10. **Read like a brief, work like a tool.**
    The briefing, note facts and draft text are set at reading size (15 px, 16 px on narrow screens); controls and metadata stay smaller.
11. **The Dashboard still holds no conversation** (ADR 0003).
    Search finds and opens; it does not answer.
12. **Glossary words only.**
    Inbox, Brain, Proposal, Harness, Connection, Machine, Reader, Source refresh, Consolidation, Correction, Review date.
    "Today" and "Approvals" are screen names, proposed for the glossary's Dashboard entry.

## 4. Information architecture and navigation

### Sidebar

| Today's Dashboard | v5 | Why |
| --- | --- | --- |
| Home | **Today** | The first screen is now an overview with four areas, of which the Inbox is the last. "Inbox" (v3) would name the page after one of its parts; "Today" says what the page is for. |
| (Memory, Drafts) | **Approvals** | New. Drafts to approve and Proposals to apply are both "Attache prepared this and waits for your OK". |
| Memory | **Brain** | Unchanged from v3. Its Proposals subview moves to Approvals. |
| Drafts | (inside Approvals) | A draft's own page opens from Approvals; `/drafts?id=` keeps working. |
| Jobs, Connections, Settings | unchanged | Below a divider. |

The sidebar has three zones, top to bottom.

1. **Brand**: the logo at 30 px, the wordmark and, at the right, one small search control: a search icon and `Ctrl K`.
   On Today it moves focus to the search field; elsewhere it opens the palette.
   v4 had a full "Search the Brain" box here, which stood beside the big field on Today and said the same thing twice.
   The control is the same on every screen, so the navigation never shifts.
2. **Nav**: Today, Approvals, Brain, a divider, then Jobs, Connections, Settings.
   Today shows a brass dot and the number of Inbox items that need the owner.
   Approvals shows a brass dot and the number of drafts and Proposals that wait.
   Jobs shows a small spinner while a job runs.
   Connections shows a brass dot when one needs sign-in.
   Settings shows a brass dot when Replication is blocked or unauthorized.
   The three numbers add up to the total behind the logo's dot (section 7).
3. **This Machine** at the foot: the Machine's name and who the Reader is ("emil-pc, the Reader" or "emil-pc. Work Mac is the Reader"), and the state of the live connection.
   A Reader that went silent is also a row in the Connected services area, because it stops every read.
   The block is a link to Settings, Machines and Replication.
   When the count is not exact it says so here ("Count as of 16:16. Retrying.", or "The count is incomplete. Retrying." when there was no earlier answer).

### Keyboard

- `g` then a letter still jumps: `t`, `i` or `h` Today, `a` Approvals, `b` or `m` Brain, `d` Approvals (the old Drafts letter), `j`, `c`, `s`.
- `Ctrl K`, `Cmd K` or `/` goes to search.
- In the Inbox and in Approvals: `j` and `k` move and `Enter` opens or closes a row.
  These change nothing.
- No key decides anything by default.
  `e` Done, `s` Snooze and `x` Dismiss exist, for the three decisions that Reopen undoes, and the owner switches them on in the shortcut sheet.
- There is never a single key for Apply, Reject, Approve, Send, Revert or Disconnect.
  The keyboard reaches those buttons with `Tab` and presses them with `Enter` or `Space`, like any button.
- `?` lists the shortcuts and holds that switch.

### Search

One component, `BrainSearch`, in three places.

| Place | Form | What it does |
| --- | --- | --- |
| Today | The field at the top of the page | Typing shows up to six `/memory/search` results in a panel under the field. `Enter` opens the chosen result. "All results in Brain" goes to the Brain with the query. |
| Any other screen | The palette, opened with `Ctrl K`, `/` or the search control beside the wordmark | The same field and results in a dialog, plus a "Go to" group with the screens and the Settings sections. |
| Brain | The field under the title | The same field; results replace the Library as a full list. |

- A result shows title, snippet, kind, file and line.
  A memory note opens in the Brain's Library, anything else in the evidence drawer at the cited lines, which is what `Memory.tsx` does with a hit today.
- The results heading states the ranking ("ranked by meaning and keywords" or "matching keywords only: ..."), as today's `KeywordsOnly` line does.
- The query travels in the URL (`/memory?q=`), so the Brain shows what Today's field found.
- Under the field on Today, a "Browse" line links to People, Projects, Decisions, Notes and Recent saves, for the owner who wants to look, not search.
- Search runs no jobs and changes nothing, and it does not reintroduce chat.
- "Go to" stays in the palette only: Today's field searches the Brain and nothing else, so it never surprises.

### Narrow screens

The bottom bar has five icon tabs with labels: Today (with the dot), Approvals (with the dot), Search, Brain, More.
Search focuses the field on Today and opens the palette elsewhere.
More opens a sheet with Jobs, Connections (with the dot when one needs sign-in), Settings and the This Machine lines, so a connection or Reader problem is reachable there and in the Connected services area.
On Today the four areas stack in the same order, and each is cut down to what gives the overview.

| Area | At 360 px |
| --- | --- |
| Search | The 52 px field with the placeholder "Search the Brain". The examples and the Browse links are desktop only. |
| For you now, a briefing | The eyebrow, the headline and two buttons: Got it and "Read the briefing". Read the briefing opens the lines, Open the full briefing and More in place, and its state is remembered. This is the closed dated disclosure of Astra's `spec-states.md`. |
| For you now, meeting prep | Whole: the title, the attendees, the note chips and the three buttons. It is bound to a clock time, so it is not collapsed. |
| When a card leaves | One short line stays under the buttons: "Leaves at 12:00, or on Got it." The longer reason is on the desktop and in the opened card. |
| Connected services | The same rows; a row's button moves under its text. The green line is one line: "All good. 5 sources read 4 min ago." |
| Inbox heading | "Inbox" and the count. |
| The work mix | A summary of every type that has items, with its icon, name and count in the type's ink colour: "Deadlines 2, Reviews 2, Replies 2, ...". It wraps to two or three lines and is not interactive, so it needs no 44 px targets. |
| Filter and order | One row with two native pickers: "All types (11)" and "By type". v4 had the order switch, Hidden and the picker on three rows and no summary. |
| Hidden | One line under the list: "Hidden: 3 snoozed or dismissed items". |
| A row | The type word and source, then the title on up to two lines, then the tag and the date. The opened row shows the whole title. |

The summary answers the question v4 left closed behind the picker: what kinds of work are waiting.
On a normal and on the heavy day it is above the fold without opening anything and without scrolling through the first group.
List and detail screens show the list first; choosing a row opens the detail full width with "Back to list", and the list's scroll position is restored on return.
Every target is 44 px or more, and reading text stays at 16 px.
Astra's `spec-states.md` owns the other narrow rules.

### Routes

`/` stays the first screen and `/memory` stays the Brain.
`/approvals` is new, with `?tab=waiting|finished`.
`/drafts?id=` opens that draft's page inside Approvals, and `/drafts` alone goes to `/approvals`.
`/memory?view=library|saves` selects the Brain's subview; `view=proposals` goes to `/approvals`.
`/settings/<section>` is new and `/settings` opens the first section.

## 5. Screens

### 5.1 Today (the first screen, was Home)

One column, 932 px at most, four areas in this order.
Each area has its own colour identity, so the page reads as four things, not as one list.

| # | Area | Identity | Height when quiet |
| --- | --- | --- | --- |
| 1 | Search the Brain | Neutral, built like a composer; indigo ring on focus | 56 px field and one line of links |
| 2 | For you now | Indigo panel, spark icon | One dashed line |
| 3 | Connected services | Green line; amber, red or slate rows for what is not fine | One 40 px line |
| 4 | Inbox | One hue per type | Heading, chips, groups |

#### Area 1. Search the Brain

The field is described in section 4, Search.
It is first because looking something up is the most frequent reason to open Attache, and v3 hid it behind a shortcut.
It is not focused when the page opens, so `j`, `k` and `g` keep working; `Ctrl K` or `/` focuses it.

#### Area 2. For you now (the proactive area)

**What it is.**
A slot for things the owner needs and has not asked for.
It holds one lead card, and under it at most two one-line followers ("Earlier today: Daily briefing, 08:00").
When no occupant applies it shrinks to one dashed line that says what comes next ("Next: Ledger sync at 14:00. Its prep shows here at 13:45."), so the area never jumps in and out of the page.

**The occupant contract.**
Every occupant is one entry in a registry, `views/today/proactive/occupants.ts`, and answers the same five questions.

| Question | Field | Example: meeting prep |
| --- | --- | --- |
| Does it apply now? | `from`, `until` | From 15 minutes before the start until 10 minutes after it |
| How urgent is it? | `rank` | 1: it is bound to a clock time |
| What does it say? | `title`, `lines`, `related` | "Ledger sync, starts 14:00", the attendees, three notes from the Brain |
| What can the owner do? | `actions` | Open in Calendar, Done, Not now |
| Why is it here, and when does it leave? | `why` | "Here because it starts within 15 minutes and other people attend. It leaves at 14:10, or when you press Done." |

The slot sorts the occupants that apply by `rank`, then by `from`, shows the first as the lead and the next two as followers.
A new kind of proactive content is a new entry in the registry and, where it needs a new look, one card body; the slot, the ranking, the fading and the "why" line do not change.
An occupant the Dashboard does not know (sent by a newer service, see P1) renders with the generic body: title, lines, links and why.

**Today's occupants.**
All four are built from routes that exist, and from what those routes return and nothing more.

| Occupant | Source | Shows | Leaves |
| --- | --- | --- | --- |
| Meeting prep | An open `meeting_prep` attention item (`connectors/gcal.ts` raises it within 24 hours of a meeting with two or more people) and its `dueAt`, which is the start | From 15 minutes before the start. The title and "starts 14:00", the attendees from the item's summary, and the related notes as chips that open the evidence drawer | 10 minutes after the start, or on Done (sends `done`), or on Not now (hides the card; the item stays in the Inbox) |
| Daily briefing | `/briefings/latest`, when its kind is `daily` and it was made today | From its creation (`schedules.briefingAt`, 08:00 by default). The briefing's first sentence as the title, its first two lines, "More lines" for the rest, Open the full briefing | On Got it, or at 12:00, or when a newer briefing arrives. Then it is a follower line, and after the day ends it is only in the menu |
| Away summary | `/briefings/latest`, when its kind is `away` | Like the daily briefing, titled "While you were away" | On Got it, or 4 hours after it was made |
| A briefing the owner asked for | `/briefings/latest`, when its kind is `manual` | Like the daily briefing, with the eyebrow "Briefing you asked for, 10:12" | On Got it, or 4 hours after it was made |
| Briefing in progress | The briefing job | A progress line in place of the card's buttons | When the job ends |

**What the routes do not give, and what the card does about it.**

- **One briefing, not a history.**
  `GET /briefings/latest` returns the single newest briefing of any kind (`latestBriefing`, `attention/briefing.ts`).
  So the slot has at most one briefing occupant, chosen by the kind of that one briefing.
  When it is older than today the slot has no briefing occupant: the quiet line offers "Prepare a briefing" and never shows yesterday's text as today's.
  When there is none, the same.
  When a manual or away briefing replaces the daily one, the daily one is no longer on this screen; its file (`deliverablePath`) is still in the Brain under Deliverables.
  The follower line "Earlier today: Daily briefing, 08:00" is therefore shown only while that briefing is still the latest one.
  P7 in section 10 asks for the list that would lift this.
- **Related notes are joined by item id, and dated.**
  The briefing lists related notes per meeting item (`sections[meetings].items[].related`, with the item's `id`).
  The card shows the notes of the entry whose `id` is the attention item's id, never by matching titles.
  The row is labelled with when they were found: "From your Brain, as the 08:00 briefing found them."
  It is not fresh research, and it does not say it is.
- **No end time.**
  `AttentionItemView` has `dueAt`, the start, and no end.
  The card says "starts 14:00" and leaves 10 minutes after the start; it does not show "14:00 to 14:30" as v4's prototype did.
  P3 adds the end time.

**Cases the registry has to handle.**

| Case | Rule |
| --- | --- |
| Two meetings start within the same lead time | Both apply with the same `rank`. The one that starts first leads; the other is the first follower, as one line with its start time and Open. When the first leaves, the second becomes the lead, and it keeps its own leaving time. Two that start at the same minute are ordered by item id, so the order never flips between renders. |
| A meeting starts while another card is being read | The new card waits as a follower until the pointer and the focus leave the lead card. |
| The clock or the time zone changes (travel, daylight saving) | Every `from` and `until` is an instant, computed from the item's `dueAt` and the briefing's `createdAt`, which are stored with their offsets. Times are shown in the browser's current zone. The "12:00" rule for the briefing is noon in the current zone on the briefing's local day. The slot recomputes when the page becomes visible and on a one-minute tick, so a laptop that wakes in another zone shows the right card. |
| A card was dismissed, then the zone changes | "Got it" and "Not now" are stored by occurrence id, not by clock time, so a dismissed card does not come back. |
| The meeting has no related notes | No entry with the item's id in the latest briefing, or an entry with none: the notes row is replaced by one line, "No related notes were found in the 08:00 briefing.", and "Meeting context" in More runs the job that looks again. With no briefing at all the line reads "No briefing has looked for related notes yet." |
| The latest briefing is older than the meeting item | The notes are shown with the briefing's time as always; the owner can see they predate a change. |

The item behind a meeting prep card stays in the Inbox under Meetings the whole time.
The card is a pointer to it, not a move, so the count does not change when the card appears or leaves.
Prepare a new briefing, Away summary and Meeting context stay available at all times in the card's More menu and on the quiet line, so nothing from today's briefing card is lost.
The card does not repeat "Slack was not read"; the Connected services area directly under it says so.
With Attention and briefings off, the area shows "Attention and briefings is off." with a link to Settings.

**How content fades.**
Nothing disappears without having said when it would.
A lead card leaves at the time its "why" line names; it then becomes a follower line for the rest of the day, and a follower leaves at midnight.
"Got it" and "Not now" are remembered per occurrence (the briefing's id, the item's id), in the browser today and in the service with P5.
A card never leaves while the pointer or the focus is inside it: it leaves when the owner next moves away, so nothing moves under the owner.

**How it adapts as the Brain learns.**
Three layers, each useful without the next.

1. *Today, in the Dashboard only.*
   Fixed rules: the lead times above, the precedence clock-bound, then away summary, then daily briefing.
2. *With the service ranking (P1, P2).*
   The service returns the ranked occupants from `GET /proactive`, so new kinds ship without a Dashboard release, and records what the owner did with each card (opened, Got it, Not now, ignored).
   It uses that record to order and to time: an owner who always opens meeting prep 30 minutes early gets it 30 minutes early.
3. *With the Brain in the loop (P3, P4).*
   What Attache learns about the owner's habits is not hidden state: it is proposed as facts on the protected identity note ("Wants meeting prep 30 minutes before", "Reads the briefing after 09:00"), which the owner sees and approves in Approvals like any Proposal.
   New occupants then draw on the Brain: who is in the next meeting and what was promised to them, a promise that falls due today, a decision whose Review date has passed and that today's meeting touches, a person the owner has not answered in a week.

Every adaptive card carries the same "why" line, so the owner can always see the rule behind it and correct it.
Section 10 lists the service work; none of it blocks v5.

#### Area 3. Connected services

One request each to `/connections`, `/capabilities` and `/reader`, which the Dashboard already makes.
The area answers one question, "can I trust what is below?", and it claims no more than those three answers establish.

**What is checked.**

| Thing | From | Healthy when |
| --- | --- | --- |
| A readable source: the notes, GitHub, Jira, Confluence, Slack, Gmail, Google Calendar | `/connections`: `status` and `coverage.state` | `status` is `connected` and its last Source refresh was `complete` or `empty` |
| Another connection: the model and the Harnesses | `/connections`: `status` only | `status` is `connected`. These have no Source refresh, so no "last read" is ever shown for them |
| The Reader | `/reader` | A `machine` is named and `silent` is false |
| A feature the owner switched on | `/capabilities`: `readiness` | `ready` |

A connection in `not_configured` or `disconnected` is not a connected service; it is on Connections and never here.
A feature with readiness `disabled` is one the owner switched off; it is not a problem and is not listed, with one exception below.

**All is well.**
One green line: a check mark, "All good.", "All 5 sources were read, and the 3 other connections work.", and on the right "Read 4 minutes ago by this Machine." with a link to Connections.
The line is green only when all three requests answered and every row of the table above is healthy.
The time comes from the Reader's `lastRefreshAt`; when that is null there is no green line.
The names are not listed: the owner asked not to see what works.

**Everything else.**
The green line is replaced by one row per state, each with an icon, a word, a sentence and at most one button.

| State | When | Word, colour, icon | The row says | Action | In the dot |
| --- | --- | --- | --- | --- | --- |
| Checking | One of the three requests has not answered yet, on first load | "Checking", neutral, spinner | "Checking your connected services." No time and no claim | None | No |
| Could not check | One of the three requests failed | "Could not check", slate, warning | Which request failed, and that Attache cannot say which services work. The last answer and its time, only when there was one | Retry | No |
| Sign-in needed | A connection in `needs_auth`, or a source whose coverage is `unauthorized` | "Sign-in needed", amber, key | Which one. For a source: since when it is not read, and what may be missing below. For the model: what waits (briefings, new drafts, Consolidation) | Reconnect | Yes, for `needs_auth`: the owner can fix it |
| Not reading | `/reader` has no `machine`, or `silent` is true | "Not reading", red, warning | Which Machine is silent and for how long, or that no Machine is the Reader. When sources were last read. That nothing retries by itself | Machines and Replication | No |
| Down | A connection in `error`, or coverage `error` | "Down", red, warning | Which one, when the read failed and the service's reason (`lastError`), when it last worked | Retry now | No |
| Offline | Coverage `offline` | "Offline", red, warning | That this Machine had no network at that time, and which sources were not read, as one row for all of them | Retry now | No |
| Access denied | Coverage `denied`, for the source or for one of its scopes | "Access denied", amber, key | Which read was refused, what may be missing below, and what was still read | Open in Connections | No |
| Partly read | Coverage `partial`, for the source or for one of its scopes | "Partly read", amber, warning | Which one and the coverage note ("stopped after 3 of 5 pages"), and what may be missing | Open in Connections | No |
| Partly working, Needs setup | A switched-on feature with readiness `partial` or `needs_setup` | The same words, amber, key | The feature and the service's `reason`, and what still works | Open Settings | No |
| Cannot run | A switched-on feature with readiness `unavailable` | "Cannot run", red, warning | The feature and the service's `reason` | Open Settings | No |
| Not read yet | A connected source with no coverage, or coverage `never_run` | "Not read yet", slate, sync | Which one and when it was connected. No last-read time, because there is none | Refresh now | No |
| Notes only | No work source is connected | "Notes only", slate, note | When the notes were read, and that the Inbox holds only deadlines and facts from them | Connect a work source | No |
| Switched off | Attention and briefings is off | "Switched off", slate, sync | That sources are not read for the Inbox and no briefing is made, and what still works | Open Settings | No. The Inbox part of the count is off, exactly zero |

Rules that hold for every row.

- **Order.**
  Sign-in needed, Not reading, Down, Offline, Access denied, Partly read, the feature rows, Not read yet.
  What the owner can fix comes first, then what was not read, then what is waiting.
- **At most three rows.**
  More are behind one line, "1 more: not read yet", which opens in place.
  The overview stays an overview on a bad day.
- **One cause, one row.**
  Four sources that were not read because the Machine was offline are one row that names the four.
- **The last line counts only what is known.**
  "The other 3 sources and 2 other connections are working." counts the sources and connections that pass the table above, and names none of them.
  It is absent when that cannot be said: while the Reader is not reading, and when a request failed.
- **No invented times.**
  "Last read" is shown only from `lastSuccessAt` or the Reader's `lastRefreshAt`.
  A source that never had one says "Not read yet".
- **A retry is promised only when it will happen.**
  "The next automatic read is at about 09:56." is written only when a Machine is the Reader and is not silent, Attention and briefings is on, and its refresh schedule is listed in `/capabilities`; the time is the Reader's last refresh plus `schedules.refreshEveryMinutes`.
  Otherwise the row says that nothing retries by itself, and offers the button.
  v4 wrote "Attache retries by itself" on every Down row.
- **What it means below.**
  A row names what may be missing from the Inbox ("Slack replies and mentions may be missing below"), which is what v3's coverage line did.
- **Colour follows what the owner can do.**
  Amber: the owner can fix it, or part of it was read.
  Red: nothing was read, or it cannot run.
  Slate: nothing is wrong yet, or nothing is known.
  The word says the state; the colour only repeats it.

The full per-service detail (every source, its last read, Test, Refresh now) is on Connections, one link away, and nowhere on this screen.
The area has `role="status"`, so a change is announced once, politely.
A unit test covers every row of the table, from fixtures of the three answers.

#### Area 4. Inbox

The Inbox holds every open attention item, whatever its age.
"Today" is the name of the page, not a filter: an item first seen three weeks ago is here until it is done, snoozed or dismissed.
Drafts and Proposals are on Approvals; a connection that needs sign-in is in area 3.

**The heading.**
"Inbox", then the dot and "10 need you", and on the right the order switch (By type, Newest first) and "Hidden 3" for snoozed and dismissed items.
There is no separate headline sentence; the heading carries the count, with the exactness rules of section 7 ("At least 10 need you", or no number).

**The count line**, directly under the heading, makes the numbers add up.
Two numbers are on this screen and they count different things: a type count is a count of open items, and "need you" is a count of decisions.
They differ when an open item has a draft waiting, because that decision is counted in Approvals.

| Case | The line |
| --- | --- |
| Some open items have a draft waiting | "11 open items: 10 need you here, and 1 has a draft waiting in Approvals (4 waiting)." |
| None has, and approvals wait | "Also waiting: 4 approvals, on their own page." |
| The drafts request failed | "11 open items: at least 10 need you here. 1 has a draft, and drafts could not be loaded, so it is not counted." with Retry |
| No approvals and no linked drafts | No line |

So 10 on the Today entry and 4 on the Approvals entry are 14 in the tab title, and the 11 in the chips is explained where it stands.

**The type system.**
The service sets `kind` on every attention item.
These are all the kinds it raises today, read in the code.

| Family | Hue | Icon | Kinds (the word on the row) | Raised by |
| --- | --- | --- | --- | --- |
| Deadlines | Rose | Flag | `deadline` (Deadline) | `connectors/vault.ts`: a task or note with a due date |
| Reviews | Purple | Pull request | `review_request` (Review) | `connectors/github.ts`: a pull request that asks for the owner's review |
| Replies | Sky | Reply arrow | `pending_reply` (Reply) | `connectors/gmail.ts`: a thread waiting for the owner; `connectors/slack.ts`: a direct message waiting for the owner |
| Mentions | Teal | At sign | `mention` (Mention) | `connectors/slack.ts` and `connectors/confluence.ts` |
| Meetings | Moss | Calendar | `invite_response` (Invite), `meeting_prep` (Meeting prep) | `connectors/gcal.ts` |
| Work items | Orange | Ticket | `overdue_work_item` (Work item, overdue), `due_work_item` (Work item) | `connectors/jira.ts`: an assigned work item with a due date |
| Facts to check | Gold | Note with a check | `fact-review` (Fact to check) | `attention/fact-reviews.ts`: a fact past its Review date |
| System | Slate | Sync arrows | `replication_blocked`, `replication_unauthorized` (Replication) | `replication/blocked-inbox.ts` |
| Other | Neutral | Dot | any kind the Dashboard does not know | A newer service |

Three notes on that table.

- The feedback also lists `authored_pr`, `assigned_issue`, `jira_work_item`, `slack_dm` and `slack_mention`.
  Those are observation kinds: the connectors record them, but none of them raises an attention item today.
  If the service starts to raise `authored_pr` or `assigned_issue`, they belong to Work items ("Your pull request", "Issue") and need one line in the map.
- The family is the colour and the icon; the kind is the word.
  So two kinds in one family still read differently ("Invite" and "Meeting prep"), and the same kind from two services is told apart by the source beside the word ("Reply · Gmail", "Reply · Slack").
- The map is one file, `views/today/kinds.ts`, with a unit test that fails when the service's kinds and the map disagree.
  Today's `GROUPS` in `Inbox.tsx` guesses the group with regular expressions, which is why Jira work items land under Deadlines and Replication under Other.

**A row** has three treatments that all say the type, so no single one is needed to read it.

- A 4 px bar in the family's solid colour on the left edge.
- A first line with the family's icon and the kind's word in the family's ink colour, then the source and who it is from in meta ink.
- A second line with the title in semibold ink.
  The service's titles start with a verb that repeats the kind ("Review acme/api#7: ...", "Reply to Priya Shah: ..."); the row drops that prefix when it matches the kind and shows the full title when it does not.

On the right: at most one state tag ("changed since your decision") and the due date or age.
"2 days overdue" is red and says "overdue".
A row opens in place and shows the summary, the evidence excerpt, "Why this is here", and the actions, primary first: Prepare draft for a review, reply or mention, Done for a deadline or work item, Open note for a fact to check, then Open in the source, Done, Snooze and Dismiss.

**Grouped by type** is the default.
Each family that has items is one bordered group with a tinted header (the icon on a solid tile, the family's name, its count), in the fixed order of the table above.
A group shows its first three rows in the service's order and a button "Show all 7 reviews"; a group with three rows or fewer shows them all.
That is the progressive disclosure for a heavy day: 28 items show as seven groups of at most three, and the chips above already said how many there are of each.

**The type chips** sit between the count line and the groups: "All 11", then one chip per family with its icon, name and count of open items, in the family's colours.
A chip is a toggle (`aria-pressed`) that shows only that family, with all its rows; pressing it again, or "All", returns.
They replace v3's count links, and they hold still: the order is fixed, and a family that empties while the screen is open stays as a "0" chip until the next visit.
The row is one line at 1280 px with the seven families of a normal day.
When it does not fit it wraps into rows of even length (`text-wrap: balance`), so a chip never sits alone on a second line, which is what v4 did with "Facts to check".
Under 760 px the chips become the type summary and one native picker, "All types (11)" (section 4, Narrow screens).

**Newest first** shows one flat list.
Every row still carries its bar, icon and word, so the type stays readable without the groups.

**After a decision** the row stays where it was as one line in meta ink, "Done: acme/api#7: Rate limit search", with Undo, which sends `reopen`.
After Prepare draft the line reads "Draft requested: ..." with a link, "It will wait in Approvals".
Focus stays on the line, and it is cleared on the next visit.
A decision the service refuses leaves the row open with the service's message.

**Items whose draft is waiting.**
An open item with a draft in `draft`, `approved` or `revoked` status stays where it is, in its type group, in the service's order.
The reply or review is still owed, so it stays findable by type; only the decision moved.

- The row carries an indigo tag with the draft's state: "Draft waiting", "Approved, not sent" or "Approval revoked".
- Opened, its first button is View draft, which opens the draft's own page; then Open in the source, Done, Snooze and Dismiss.
  Approve, Send and Reject are never on this row.
- One sentence says why the row is not in the count: "A draft is prepared for this item, so its decision is counted in Approvals and not here."
- The row is in the type count (an open item) and not in "need you" (its decision is in Approvals).
- When the draft is sent, rejected or expired, the tag goes, the item is counted here again and offers Prepare draft.
- When the drafts cannot be loaded, the tag reads "Has a draft, not loaded" and the item is left out of the count, which is then a lower bound.

v4 moved these items out of their group onto a quiet line under the Inbox.
Astra's objection holds: the owner who looks under Reviews for a pull request should find it there.

**Recently added** is the second quiet line: "4 changes reached the Brain without your review in the last 7 days."
It opens in place into the same ledger as before (`/memory/recent-changes?unreviewed=1`): note, change, source, age and Revert where the service allows it.
It stays on the first screen because ADR 0004 lets changes reach the Brain without review, and this ledger is what makes that safe; it is one line because nothing in it asks for a decision.
With the recall feature off the line is absent.

**Stability under live updates.**
New items are inserted in their group without scrolling the page, an open row stays open and in view, and a row whose item changed while open shows "Updated just now".

**Empty states.**
An empty Inbox says how much it knows, and no more.

| What is known | It says |
| --- | --- |
| The total is exactly zero, and every source was read | The logo at 56 px without its dot and "Nothing needs you.", then "All 5 sources were read 4 minutes ago by this Machine." |
| The total is exactly zero, and a source was not read | "Nothing found in the 4 sources that were read.", and which one was not ("Slack was not read, so replies and mentions there may be missing.") |
| The Inbox is empty and approvals wait | "No open Inbox items.", what was read, and "4 approvals wait on their own page." |
| The Inbox is empty and a connection needs sign-in | "No open Inbox items.", and "A connection needs your sign-in, above." |
| The Inbox is empty and drafts or Proposals could not be loaded | "No open Inbox items.", and "Approvals could not be loaded, so Attache cannot say that nothing needs you." with Retry |
| The connected services could not be checked | The sentence under the title is "Connected services could not be checked, so this may be incomplete." |
| Attention and briefings is off | "The Inbox is switched off. Nothing is read for it, so this is not a claim that nothing needs you." |

"Nothing needs you." and the logo without its dot appear only in the first row.

**When the attention request fails.**

| Case | The Inbox shows |
| --- | --- |
| On first load | The heading without a count, the count line for approvals when those are known, and a red row in the list's place: "Could not load. The Inbox request failed." with Retry. No rows, no chips and no empty state: an empty list here would read as nothing needs you |
| After a good load | The heading with "as of 16:16, not refreshed" in place of the count, a red row "Could not refresh. Showing the Inbox as it was at 16:16." with Retry, and the retained rows under it |

In both cases the Inbox part of the count is unknown: the Today entry shows no number, and its dot is as it last was (absent on first load, present after a good load that had items).
The total in the tab title is a lower bound from the parts that did answer ("(4+) Attache"), and the sidebar foot says "Count as of 16:16. Retrying."
A Source refresh that failed is a different thing and is in area 3; it never puts an error here.

### 5.2 Brain (was Memory)

**Search comes first.**
A full-width search field under the title, focused with `/`, with the keywords-only line directly under it.
Results replace the browser with a list of passages: title, snippet, `path:line`, area, "superseded" for a History hit and an "unverified" tag, as today.

**Two subviews**, in the URL: Library and Recent saves.
Proposals moved to Approvals in v4; the tab row ends with a link, "2 Proposals wait in Approvals", carrying the dot.

- **Library** is a three-pane browser.
  Collections are a vertical list on the left (People, Projects, Decisions, Notes; then Imported, Evidence, Deliverables under "Also searched"), which fixes the overflowing tab strip.
  They carry no counts: `/memory/documents` returns at most 300 documents and no total, so a count would be wrong exactly when it matters.
  The note list is in the middle; the reader is on the right.
  Under 1080 px the reader goes below; under 760 px the collections become a wrapping chip row.
- **Recent saves** is today's list, full width, with a filter: All, Written without review, Reverted.

**The note reader.**

- Kind as an eyebrow, the title at 26 px, then path, last update and "Show the Markdown file".
- A brass strip when a Proposal waits for this note, with "Review in Approvals".
- **Current state** as a definition list: subject, value at reading size, date on the right.
  Under the value, one line of provenance: the source as a small button ("Claude Code session"), the Review date, and Revert when the fact's last change can still be reverted.
  The source button is a disclosure: pressed, it shows the complete source string that today is printed under every fact.
  It works with a pointer, a keyboard and a finger.
  A fact past its Review date gets an "unverified" tag and "review was due ...".
- "This identity record changes only from Settings." on the protected note, as today.
- **History** as a list of the stored lines, word for word, with the bold markers rendered as `HistoryLine` does today.
  A line longer than two rows is clamped with "more".
  The Dashboard does not rewrite History.
- **Change log**, collapsed by default: time, change, subject, actor, old value, reason and status, as today.
- Evidence and deliverable documents render as today (Markdown body), in the same reader.

**Rebuild index** moves into an overflow menu on the page head and into Settings, Service health.

The Dashboard stays read-only for notes: no capture box, no edit.
The page head says so.

### 5.3 Approvals, and the draft's own page

**What it is.**
Everything Attache prepared that needs the owner's OK: drafts waiting for approval or sending, and Proposals waiting for Apply or Reject.
It is second in the navigation, with the dot and its count, and the first screen links to it from the Inbox heading.

**The list.**
Two tabs, Waiting and Finished.
Waiting has two groups, built like the Inbox's type groups.

| Group | Hue | Icon | Holds | Row |
| --- | --- | --- | --- | --- |
| Drafts to send | Indigo | Pen | Drafts in `draft`, `approved` or `revoked` status | "Draft", the action kind and version; the title of what it answers; the first line of the text at reading size; on the right the state ("Approved, not sent", "Approval revoked") and "expires in 2 days" |
| Changes to the Brain | Gold | Note with a check | Proposals in status `proposed` | "Proposal", what kind of change and on which note; the change as the title; on the right the Machine it was made on and its age |

Indigo is the draft's colour because a draft is the owner's own words about to be sent, and indigo is the accent of the owner's action.
Gold is the Brain's colour: a Proposal here and a fact to check in the Inbox are both about what the Brain holds.

**A draft row** opens in place and shows what it answers, the text read-only, and two buttons: "Review and approve v1", which opens the draft's own page, and Reject.
Approve and Send are never in the list.
They are separate presses on the draft's page, with the version named, as in v3.

**A Proposal row** opens in place and shows the whole change as today's `ProposalReview` does: every fact with its reason, events, notes, tags, why it was suggested, the evidence quote and the Machine it was made on.
Apply and Reject sit under it and wait for the service.
A refused Apply shows its reason in the row and the row stays, so the owner can reject it; a Proposal that can no longer be read offers only Reject.
Astra's `spec-states.md` owns the conflict cases.

**After a decision** the row stays as one line ("Applied: ...", "Rejected: ...") until the next visit, as in the Inbox.
Reject of a draft can be undone with Restore on the draft's page until the draft expires; Apply can be undone from Recent saves where the service allows Revert.

**In progress** is a third, neutral group under the two on Waiting, shown only when a draft is being sent (status `executing`).
Its row says "Sending", the action kind and version, and when it started, and opens the draft's own page.
There is nothing to decide, so it has no dot, is not in the Waiting number and is not in the count.
It is not under Finished, because it has not finished: when the other service confirms, the row moves to Finished with its receipt.

**Finished** lists drafts that are sent, not sent, of unknown outcome, rejected or expired, and Proposals that were applied or rejected, newest first.
A `failed` or `unknown` send is red or brass there with its words, and also raised a toast when it happened.

**When a request fails.**
Drafts and Proposals are two requests, and each group answers for its own.

| Case | The group shows |
| --- | --- |
| Its request failed on first load | The group's header and one red line in the rows' place: "Drafts could not be loaded. This is not an empty list: Attache does not know what waits here." with Retry |
| Its request failed after a good load | The header with "as of 08:06" in place of the count, a red line "Proposals could not be refreshed. These are the rows from 08:06. They may have changed, and the count leaves them out." with Retry, and the retained rows |

The Waiting tab and the Approvals entry show the known part as a lower bound ("2+"), and no number when neither part is known.
"Nothing waits for your OK." is said only when both requests answered with nothing.

**Empty.**
"Nothing waits for your OK.", with the logo without its dot.

**The draft's own page** is v3's Drafts detail, unchanged, reached from a draft row and from "View draft" on an Inbox item.
It has a "Back to Approvals" link, no list beside it, and the sidebar keeps Approvals selected.

- **Header, always**: the action kind and destination on one line ("GitHub comment to github.com/acme/web/pull/42"), then version and status ("v2 · draft").
- **A three-step line**: Draft v2, Approved for 15 min, Sent with receipt.
  The current step is ink, a finished step has a check, a failed send is red and an unknown outcome is brass with a question mark.
  A current step is status, so it is never the accent.
- **What it answers**: the source message (`context.source.body`) as a quote directly above the text, with the item summary, changed files and evidence chips.
  It is above the text at every width.
- **The text is the hero**: the editor at reading size.
- **Actions**: Approve v2, Send v2 and Reject.
  Send names the version it sends and reads "Create v2 in Gmail" for a Gmail draft.
  It is visible and disabled before approval, with one line saying why.
  Save as v3 appears when the text is dirty, beside Discard changes, with "Saving creates v3 and replaces the text of v2, which is not kept"; Approve and Send are disabled while it is dirty.
  At most one button is the accent, and it is the next step forward.
- **Details and History** move to a side column: version and hash, prepared by, expiry; the event list.
- After any action the detail stays on the same draft.
  The list never selects another draft by itself, also when the draft leaves the "Needs review" filter.

The service stores nine statuses, and the Dashboard derives five more states from them.
`spec-dot-and-drafts.md`, part 2, has every transition, message, button and refusal; this is the summary.

| State | Stored status | What the owner sees and can do |
| --- | --- | --- |
| Draft | `draft` | Edit, Approve vN, Reject. Send vN is visible and disabled. |
| Unsaved edits | any editable | Save as vN+1, Discard changes. Approve and Send wait. |
| Approved | `approved` | "vN approved at 16:21, valid until 16:36" with the time left. Send vN, Revoke approval, Reject. |
| Cannot send yet | `approved` | The service's reason and a link to Connections. Send vN disabled. |
| Approval ended | `approved` | "The approval of vN ended at 16:36. Nothing was sent." Approve vN again. |
| Revoked by the owner | `revoked` | "You revoked the approval." Approve vN, Reject. |
| Revoked by the service | `revoked` | Why: connection disconnected, write permission removed, or Drafts switched off. Approve vN, Reject. |
| Sending | `executing` | "Attache marks this sent only after the other service confirms it." No buttons. |
| Sent | `succeeded` | Receipt: verified time, remote id, link. |
| Not sent | `failed` | The receipt's error, in red. Copy text, Prepare a new draft. Final. |
| Outcome unknown | `unknown` | "Check the target before you do anything else." Open the target, Copy text. Never styled as sent, no button that could send again. |
| Rejected | `rejected` | "You rejected vN." Restore as vN+1 until the draft expires. The editor is locked. |
| Expired | `expired` | "Expired after 48 business hours. Nothing was sent." Copy text, Prepare a new draft. Final. |
| Changed elsewhere | any | "This draft became vN+1 while you were editing." Copy my text, Load vN+1. |

Three of these correct today's Dashboard.

- **Approval ended.**
  Today the draft stays `approved`, Send is disabled, and there is no Approve button, because the service only approves a `draft` or `revoked` draft.
  The owner has to revoke an approval that already ended.
- **Rejected.**
  Today the editor stays enabled on a rejected draft and saving silently makes it a draft again.
  That becomes an explicit Restore.
- **Save.**
  The service overwrites the text of the previous version.
  History lists versions by number; it cannot show their text, and Save says so before it happens.

Send is the only step that cannot be undone, and the sentence beside the button says so.


### 5.4 Jobs

- The Research box stays at the top.
- The list becomes a quiet table: title, result in a few words, time.
  Running jobs come first under "Running" with a progress bar and the current note.
  A succeeded job has no pill at all; a blocked job has a brass tag with its reason; a failed one a red mark and tag.
- The right pane shows the running job, or the newest failed one, or the newest job, so it is never an empty "Select a job".
  That choice is made once, when the screen opens; a live update never changes which job is selected.
  It has the progress, the event timeline, the result with its link to evidence or the created draft, and Cancel or Retry.
- Cancel reports the service's answer: stopped, or already finished.
- Diagnostics stays as a button in the page head.

### 5.5 Connections

Cards become rows in four groups (Notes, Work sources, Harnesses, Model).

- A row shows a monogram, the name and account, what Attache may read and write in one line, and the last Source refresh.
  Permission and refresh are two separate columns: "read only" is not a claim that the source was read.
- A row opens in place into everything the card has today: coverage detail, Test, Refresh now, Reconfigure, Change what Attache reads, write actions with their confirmation, Disconnect with its preview.
- **A "Needs you" group comes first** when any connection needs sign-in, already open with its Sign-in needed box.
  The Reconnect button in Today's status area lands here.
- This screen is the only place that lists every service, working or not.
- Connections that are not set up are small dashed tiles under their group instead of full cards.
- Harness rows say whether auto-accept is on, linking to the switch in Settings, and keep the restart and hook-review instructions in the opened row.
- The paths shown are shortened with `~`; the full path is in the opened row.
- Import a Markdown folder stays under Notes as a tile that opens the existing form with its preview.

### 5.6 Settings

A section list on the left, content on the right, one route per section.

| Group | Sections |
| --- | --- |
| Attache | Features; Schedules and notifications; Identity |
| Brain | Saving and review (Auto-accept, Consolidation); Meaning-based search; Backup and export |
| Machines | Machines and Replication; Paired clients |
| Service | Service health (with Credentials and Rebuild index) |

- Features become switch rows: name, one line, and what it needs.
  "ready" is not shown; "partial", "needs setup" and "unavailable" are, as a tag with the reason.
  The dependency dialog (turn on what it needs, or turn off what depends on it) is unchanged.
- Auto-accept and Consolidation share one section, because together they answer one question: what reaches the Brain without review.
- **Machines and Replication** starts with this Machine's name, then Replication.
  It keeps every state (off, up to date, offline, unauthorized, blocked) and every action (Set up, Join, Check now, Switch off with its confirmation), with last checked, last sent and the repository.
  The Machines list marks this Machine and the Reader with tags and a silent Machine with "silent 2 h"; Standby and Preferred Reader stay as a checkbox and a radio per Machine.
  A blocked or unauthorized state shows its cause in a brass notice at the top of the section.
- Replication is not in the main navigation.
  With one Machine it is one section the owner may never open; with several, its failures are attention items and the Reader is named in the sidebar foot and, when it is silent, in the Connected services area.
- Identity stays protected and asks for confirmation.
- Meaning-based search keeps download, progress, rebuild, removal and the keywords-only state; Paired clients keeps code creation and revocation; Backup keeps creation, the file list and the command-line restore guidance.

### 5.7 Setup and pairing

- Setup becomes two panes: a sunken left pane with the logo at 56 px (no dot: nothing needs you yet), the five steps as a vertical list, and "Already use Attache on another Machine?" at the bottom; the form on the right.
- On every step the required fields come first and the continue button sits directly under them.
  On step one that is the data folder, its preview and "Use this folder".
  "Import an existing Markdown folder" and "Your identity" follow as closed disclosures marked optional.
- The steps, their order, their fields, resumability and the Join flow are unchanged.
- The Pair screen and the "service is not reachable" screen get the same centred layout with the large logo, and keep the code field, the busy state, the error and the recovery instructions.

### 5.8 Evidence drawer, toasts, errors

- The drawer keeps its behaviour and takes the new tokens; its file view uses the same excerpt component as the Inbox, and the note chips on a proactive card open it.
  It returns focus to the citation that opened it.
- Toasts move to the bottom left, above the sidebar foot, so they never cover a row's actions on the right.
- The reconnecting and disconnected banners stay at the top of the main area.
  While disconnected, lists are labelled "as of 16:20" and action buttons are disabled.
- Loading keeps the skeleton lines; an error keeps `ErrorState` with Retry.

## 6. Visual language

### Colour

v3 allowed three hues and kept them muted.
The owner found that dull, and found that nothing could be told apart.
Since v4 the design adds a hue for every thing that has to be recognised at a glance, and since v6 it sets them on neutral zinc surfaces with indigo as the one accent.

**What colour is for.**

| Job | Hues | Rule |
| --- | --- | --- |
| Links, the primary button, the focus ring, selection, Drafts | Indigo (`--accent`) | The owner's own action. Never a status. |
| The attention dot | Brass (`--attn`) | A decision waits. The dot only. |
| The proactive area | Indigo | The panel, its tile and its label. It shares the accent hue because it is Attache speaking to the owner. |
| Status | Green, amber, red, slate | Green: every connected service is known to work, and success toasts. Amber: the owner can fix it, or part was read. Red: not read, down, failed, overdue, destructive. Slate: nothing is wrong yet, or nothing is known ("Not read yet", "Could not check"). |
| Inbox types | Rose, purple, sky, teal, moss, orange, gold, slate | One family each (section 5.1). Gold is also the Proposal. |
| Neutral states | Ink on `--sunken` | "draft", "running", "v2", "read only", a current step, a progress bar. |

Colour never carries meaning alone.
Every coloured thing has an icon and a word beside it, and a status colour always comes with its word: "All good", "Sign-in needed", "Down", "Not read yet" and the others of section 5.1.

**Four steps per hue.**

| Step | Token | Used for | Contrast it must reach |
| --- | --- | --- | --- |
| Solid | `--<hue>` | Icon tiles, the row's left bar, a pressed chip, status icons | 3:1 or better against `--surface` and `--paper`; its on-colour `--on-c` is 4.5:1 or better on it |
| Ink | `--<hue>-ink` | The type word, group headings, chip text, status words | 4.5:1 or better on its own soft step, on `--surface` and on `--paper` |
| Soft | `--<hue>-soft` | Group headers, chips, the proactive panel, status rows | A background only |
| Line | `--<hue>-line` | Borders of the same | Decoration; the shape is never the only cue |

`--on-c` is `#ffffff` in light and `#09090b` in dark.
Components do not name a hue: a class sets `--c`, `--c-ink`, `--c-soft` and `--c-line` (`.c-rose`, `.c-indigo`, ...), and a row, chip, tile or group reads those four.

**The hues**, as solid, ink, soft, line.
The numbers were computed, not eyeballed, and recomputed on the v6 neutrals: the lowest solid-on-surface ratio is 4.41:1 (3:1 required) and the lowest ink ratio is 5.21:1 (4.5:1 required), in both themes.
The prototype's Colours page prints the same values from the stylesheet.

| Hue | Used for | Light | Dark |
| --- | --- | --- | --- |
| Indigo | Accent, For you now, Draft | `#625ad8` `#3b30cf` `#e7e6f9` `#bbb8ea` | `#766edd` `#8d87e3` `#171537` `#2f2b64` |
| Green | All good | `#218355` `#1d724a` `#e7f9f0` `#b8ead3` | `#33cc85` `#5cd69d` `#153727` `#2b6449` |
| Amber | Sign-in needed, needs setup | `#a5680d` `#8e5a0b` `#faf2e5` `#ead6b8` | `#d99126` `#eba947` `#372a15` `#644d2b` |
| Red | Down, failed, overdue | `#d44035` `#b12f25` `#fae7e6` `#eabbb8` | `#d85046` `#e27b74` `#371715` `#642f2b` |
| Rose | Deadlines | `#dd2c67` `#b81e51` `#fae5ec` `#eab8c9` | `#dd4075` `#e8739a` `#371521` `#642b3e` |
| Purple | Reviews | `#ae46ce` `#9630b5` `#f4e7f9` `#dfb8ea` | `#b352d1` `#c57adc` `#2f1537` `#572b64` |
| Sky | Replies | `#1679ca` `#1366aa` `#e5f1fa` `#b8d4ea` | `#2688d9` `#4ca4eb` `#152837` `#2b4a64` |
| Teal | Mentions | `#138086` `#116f74` `#e5f9fa` `#b8e8ea` | `#26d0d9` `#4cdee6` `#153637` `#2b6164` |
| Moss | Meetings | `#4e8321` `#426e1c` `#eff9e7` `#cfeab8` | `#7acc33` `#95d65c` `#253715` `#45642b` |
| Orange | Work items | `#c15710` `#a0480d` `#faeee5` `#eaccb8` | `#d96e26` `#eb8947` `#372315` `#64422b` |
| Gold | Facts to check, Proposal | `#926e0c` `#7f600a` `#faf5e5` `#eaddb8` | `#d9a926` `#ebbf47` `#372e15` `#64552b` |
| Slate | System | `#67778e` `#566376` `#edeff2` `#cad0d8` | `#6e7f96` `#8f9cae` `#20252c` `#3c4553` |

The accent tokens (`--accent`, `--accent-solid`, `--on-accent`, `--accent-soft`) are listed with the neutrals below; a Draft row uses the indigo steps through `.c-indigo`.

**What the hues can and cannot do.**
The contrast numbers above hold.
The claim v4 implied, that every hue can be told from every other by colour alone, does not, and v5 withdraws it.

Two pairs sit close on the wheel on purpose, and are kept apart by place, icon and word.
Gold (a fact or a Proposal) and amber (sign-in, partly read) never share an area: gold is on rows in the Inbox and Approvals, amber only in the Connected services area.
Rose (a deadline) and red (overdue, down) can meet on one row: the bar and word are rose, and only the words "2 days overdue" are red.

For colour vision without one cone type, the palette was simulated in both themes (Machado, Oliveira and Fernandes 2009, full severity, in linear RGB) and the distance between every pair of type hues was computed in OKLab.
A distance under about 4 reads as the same colour, and normal vision has no pair under 6.8.

| Theme | Protanopia | Deuteranopia | Tritanopia |
| --- | --- | --- | --- |
| Light, closest type pairs | Teal and slate 1.8, orange and gold 2.4, moss and gold 3.5 | Teal and slate 1.9, moss and gold 2.1, orange and gold 2.9, purple and sky 3.6 | Moss and slate 3.2, sky and teal 3.6 |
| Dark, closest type pairs | Moss and gold 6.2 | Moss and gold 1.3, purple and sky 2.4 | Rose and orange 6.3 |
| Light, status | Amber and red 6.0 | Amber and red 2.5 | All above 11 |
| Dark, status | All above 13 | All above 9 | All above 13 |

Read plainly: with a red-green deficiency the light theme's types fall into a warm band (deadlines, meetings, work items, facts), a blue band (reviews, replies) and a grey one (mentions, system), and amber and red status rows look alike.
With a blue-yellow deficiency, replies and mentions look alike.
The dark theme separates better, because its solids can differ in lightness.
These are the pairs Astra named, plus teal and slate, which is also the weakest pair for normal vision (7.7).

What carries the type for those readers is what always accompanies the hue: a different icon and a written word on every row, chip and group, and a sentence on every status row.
A type is never shown by a bar or a tint alone.
The prototype's Colours page has a "Seen as" switch (Protanopia, Deuteranopia, Tritanopia, Greyscale) that applies to every screen, and `screenshots/light-colours-deuteranopia.png` and `light-today-deuteranopia.png` show the result.
The hues themselves are not retuned in v5 (see Not applied, and section 13).
This is a simulation, not a test with people who have these deficiencies, and it does not replace one.

**The neutrals and the accent** are new in v6.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--paper` | `#fcfcfc` | `#09090b` | Page background |
| `--side` | `#f7f7f8` | `#0c0c0e` | Sidebar, facet column, Setup's left pane |
| `--surface` | `#ffffff` | `#111113` | Lists, cards, inputs |
| `--raised` | `#ffffff` | `#18181b` | Search results, palette, drawer, menus (86 percent opaque over a 14 px blur) |
| `--sunken` | `#f4f4f5` | `#1c1c1f` | Neutral tags, the segmented control's track, key caps |
| `--row-hover` | `rgba(24,24,27,.045)` | `rgba(255,255,255,.05)` | A hovered row |
| `--row-on` | `rgba(24,24,27,.08)` | `rgba(255,255,255,.09)` | The current destination, a selected row or result |
| `--line` | `#e4e4e7` | `#26262a` | Dividers and card borders |
| `--line-btn` | `#d4d4d8` | `#34343a` | Button borders; the label carries the button, so this is decoration |
| `--line-strong` | `#8f8f98` | `#6b6b74` | Input borders and the search field (3.12:1 or better) |
| `--ink` | `#18181b` | `#f4f4f5` | Text |
| `--ink-2` | `#3f3f46` | `#c9c9cf` | Secondary text |
| `--ink-3` | `#66666e` | `#a1a1aa` | Meta text (4.63:1 or better on every background, tinted panels included) |
| `--accent` | `#4338ca` | `#a5a0f0` | Links and the focus ring (6.4:1 or better, on the indigo panel too) |
| `--accent-solid` | `#4f46e5` | `#8d87e3` | The primary button, the switch, the selected row's edge |
| `--on-accent` | `#ffffff` | `#09090b` | Text on the primary button (6.3:1) |
| `--accent-soft` | `rgba(79,70,229,.14)` | `rgba(141,135,227,.2)` | The focus halo of fields |
| `--attn` | `#c2780e` | `#e0a03a` | The attention dot (3.28:1 or better as a graphic) |
| `--attn-ink` | `#8a5206` | `#ebb65c` | The count beside the dot, attention tags |
| `--attn-soft` | `rgba(217,145,38,.16)` | `rgba(224,160,58,.15)` | Attention tag background |
| `--danger` | `#b12f25` | `#e27b74` | Destructive button text |
| `--logo-copper` | `#ba6249` | `#ba6249` | The mark only |
| `--logo-brass` | `#c38942` | `#c38942` | The mark's dot only |

v3's `--ok` is replaced by the green hue.
The mark keeps the shipped logo's copper and brass and is never used for text.
The interface dot uses `--attn`, a deeper brass than the logo's dot, so it reaches 3:1 as a graphic on a white page.
The neutrals are the zinc scale T3 Code uses, with `--ink-3` and `--line-strong` taken one step darker than its muted text and input border so they pass on tinted panels and as a field boundary.

Theme follows `prefers-color-scheme` as today.
The tokens are written under `[data-theme]` so a manual override in Settings is a one-line addition later; it is not in scope.

### Type

| Role | Face | Size / line | Where |
| --- | --- | --- | --- |
| Title | Inter 600, -0.02em | 22 / 1.25 | Page titles; note titles at 26 |
| Heading | Inter 600, -0.015em | 18 to 19 / 1.3 | The proactive card's title, the Inbox heading, empty states |
| Reading | Inter 400 | 15 / 1.55, 16 on narrow screens | Briefing lines, fact values, draft text, evidence quotes |
| UI | Inter 400, 500, 600 | 14 / 1.5 | Everything else; row titles are 550 |
| Meta | Inter 400, 500 | 12 to 12.5 | Times, sources, hints, group labels |
| Mono | system mono | 12 | Paths, hashes, file excerpts |

There is one typeface and no serif.
Hierarchy comes from weight and size, and there are no uppercase or letterspaced labels.
A page title is the screen's name; there are no slogans.
The prototype loads Inter from Google Fonts.
The real Dashboard must not: it is served from `127.0.0.1` and has to work offline, so the face ships in the bundle (`@fontsource-variable/inter`, Latin subset), with `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif` after it.
That is the stack T3 Code uses, with the bundled face first so the owner's Linux machine shows the same design as a Mac.
One variable face replaces the two of v5, so the 150 KB font budget of v5 still holds; Phase 0 confirms the number from the real build, and above the budget the system stack ships alone.
`font-synthesis` is off and there is no italic: quotes are roman.

### Spacing, radius, elevation

- A 4 px scale: 4, 8, 12, 16, 24, 32, 48.
- Radius 8 for controls, 6 for tags, 12 for lists and cards, 16 for the search field, the proactive panel, the palette and the empty state.
- Hairline borders, not shadows, separate surfaces; the search field has one soft resting shadow, and the palette, results, the drawer and menus float as glass with a shadow.
- Rows are 60 px for two lines and 32 px for nav; areas on the first screen are 18 px apart and Inbox groups 12 px.
- Controls are 32 px high with a pointer, 28 px for the secondary buttons inside an opened row, and 44 px under `(pointer: coarse)` or 760 px.
  WCAG 2.2 AA (2.5.8) asks for 24 px.

### Iconography

- One small set of 16 px line icons at 1.7 stroke, round caps, drawn to match the logo's round handle: today, approvals, brain, draft, jobs, connections, settings, search, check, chevron, external, more; one per Inbox family (flag, pull request, reply, at sign, calendar, ticket, note with a check, sync); and spark, key and warning for the proactive area and status.
  They are inline SVG in one `icons.tsx`; no icon package.
- Sources and Harnesses use two-letter monograms in a rounded square, not vendor logos, which avoids shipping third-party marks.
- Icons never replace a text label; in the narrow tab bar each has its label under it, and a type icon always has its word beside it.

### Motion

- 120 to 180 ms, one easing (`cubic-bezier(.2,.7,.2,1)`), for row open, palette rise and switch travel.
- **The dot lands**: when the count goes from zero to one, the logo's dot scales in once with a small overshoot (420 ms).
  It never pulses or loops.
- Counts do not animate.
- The only looping motion is the 8 px spinner on a running job.
- `prefers-reduced-motion` removes all of it.

## 7. The logo and its dot

| Place | Rule |
| --- | --- |
| Sidebar, 30 px | Dot on when the total is above zero. |
| Favicon | Two SVGs, with and without the dot, swapped at runtime on the same rule. Today `public/favicon.svg` always has it. |
| Tab title | "(15) Attache" when the total is above zero, "Attache" otherwise. |
| Empty Inbox and empty Approvals, 56 px | Without the dot. |
| Setup, Pair, unreachable screens, 56 px | Without the dot. |
| README and docs | With the dot, as now (`docs/assets/logo.svg`). |

The count behind the dot is one number, computed in one place, `useNeedsYou()`.
`spec-dot-and-drafts.md`, part 1, is the rule with its test table; this is the summary.

    Inbox      open attention items, minus those whose draft is draft, approved or revoked
    Approvals  Proposals with status proposed
               + drafts in draft, approved or revoked status
    Sign-ins   connections in status needs_auth

The total is the three added together, and each part is shown where its decisions are: the Inbox part on Today's nav entry and the Inbox heading, the Approvals part on the Approvals entry, and sign-ins as a dot on Connections and a row in the Connected services area.
So the numbers the owner sees always add up to the number in the tab title.

Two words keep two counts apart.
"Open items" is what the type chips and group headers count: every open attention item, with or without a draft.
"Need you" is what the badges count: decisions, each once.
An open item whose draft is waiting is an open item in its type group and a decision in Approvals, so it is in the first count and not in the Inbox part of the second.
The count line under the Inbox heading states the sum ("11 open items: 10 need you here, and 1 has a draft waiting in Approvals").

What changed from v4 is where that item is shown, not where it is counted.
v4 took it out of its type group; v5 leaves it there with a tag.
The total is the same number in v3, v4 and v5: 38 on the shared fixture, as 28 in the Inbox and 10 in Approvals, with 30 open items in the type groups.

Each part is known, at its list limit, unknown or off, and the total is exact only when every part is known or off.

| Case | Count and dot |
| --- | --- |
| An open item has a live draft | Counted once, in Approvals, as the draft. The item stays in its type group with a "Draft waiting" tag and is in the type count. |
| The item is closed and its draft is unfinished | The draft is counted, in Approvals. |
| An open item's draft is finished | The item is counted, in the Inbox, and offers Prepare draft again. |
| An approval ended | The draft is still `approved` and still counted. |
| A draft is `executing` | Not counted. Listed under In progress in Approvals. |
| A draft is `succeeded`, `failed`, `unknown`, `rejected` or `expired` | Not counted. Listed under Finished. |
| A service is down, offline, partly read, denied or not read yet, or a connection is in `error` | Not counted. The Connected services area says it. |
| A connection needs sign-in | Counted: the owner can fix it. |
| Replication blocked or unauthorized | Already an attention item, counted once, under System. |
| A proactive card | Never counted. A meeting prep card points at an item that is already counted. |
| A feature is off | Its part is zero, exactly. |
| A list came back full | A lower bound: "200+", dot on. |
| One request failed, the others found something | A lower bound: "12+", dot on, and the reason in words where the missing part would be. An item that names a draft is left out while the drafts cannot be seen, so the bound is never too high. |
| A request failed after a good load | Its retained rows stay on screen with their time and are left out of the number. Its own entry shows no number and keeps the dot it had. |
| A request failed and the others found nothing | No number. The dot stays as it last was. |
| First load | No dot and no number until the first answer. |
| The service is unreachable | The last known dot stays, the sidebar foot says "Disconnected". |

The count is this Machine's: attention items replicate, drafts do not.

The in-product dot (`<AttentionDot>`) is the same shape at 8 px, in brass.
It appears only beside a count of decisions or on a pointer to them: the Today and Approvals entries in the sidebar and tab bar, the Inbox heading, the count line under it, the Waiting tab, a note with a waiting Proposal, the Connections and Settings entries.
It does not appear on rows (the "Draft waiting" tag is indigo, not brass), on a proactive card, on "new", "changed", "overdue" or "unverified", on a job, or on anything that succeeded.

## 8. Component inventory

| Component | Status | Notes |
| --- | --- | --- |
| `Logo` | keep | Add nothing; callers pass `attention` from the new count. |
| `AttentionDot` | new | 8 px, with an accessible label. |
| `Shell`, `Sidebar`, `TabBar`, `MoreSheet` | new, split from `App.tsx` | Nav, counts, shortcuts. |
| `MachineFoot` | new, from `ReaderLine` | Sidebar foot. |
| `BrainSearch` | new | The field, the results and their keyboard model; used by Today, the palette and Brain. |
| `SearchPalette` | new | `BrainSearch` in a dialog, plus "Go to". |
| `ProactiveSlot`, `ProactiveCard`, `occupants.ts` | new | The slot, the generic card, and the registry with meeting prep, daily briefing, away summary and briefing progress. |
| `ServiceStatus`, `service-states.ts` | new, from `ReaderLine` and `Coverage` | The green line and the rows. `service-states.ts` is the decision table of section 5.1 as one pure function of the three answers, with a test per row. |
| `RequestError` | new, from `ErrorState` | The red row with Retry that stands in a list's place, in its first-load and after-a-good-load forms. Used by the Inbox and by each Approvals group. |
| `CountLine` | new | The sentence under the Inbox heading that relates open items to decisions. |
| `kinds.ts` | new | The map from attention kind to family, word, hue and icon, with its test. |
| `TypeChips`, `TypeMix`, `TypeGroup`, `TypeIcon` | new | The filter chips, the narrow summary of types and counts with its two pickers, a group with its tinted header and "Show all", the icon on its tile. |
| `ShortcutSheet` | new | Opened with `?`. |
| `Tag` | replaces `StatusPill` | Neutral, attention, danger, outline. No green variant. |
| `Button` | restyle | Primary, default, ghost, danger; small size; optional key hint. |
| `Switch` | restyle of `SwitchRow` | Same semantics. |
| `Tabs` | keep, restyle | Add a vertical orientation for collections. |
| `Queue`, `QueueRow`, `DecidedRow`, `QuietLine` | new | The list used by the Inbox and Approvals; a row is a disclosure with roving focus; the two one-line disclosures under the Inbox. |
| `ItemBody`, `ProposalBody`, `DraftBody` | new, from `Inbox.tsx` `Item`, `ProposalReview`, `Drafts.tsx` | What an opened row shows: an item in the Inbox, a Proposal and a draft in Approvals. |
| `Excerpt` | new, shares code with `Evidence.tsx` `SourceView` | File, lines, highlighted passage. |
| `BriefingBody` | from `BriefingCard` | The briefing as a proactive card body: title, lines, actions, progress. |
| `ChangeRow` | restyle of `RecentChange` | Used by the Recently added line and Recent saves. |
| `FactList`, `SourceDisclosure`, `Timeline` | new, from `Memory.tsx` | Note reader parts; `Timeline` also serves job events and draft history. |
| `DraftSteps`, `DraftStatus` | new | The step line and the per-status message. |
| `ConnectionRow` | from `ConnectionCard` | Summary row plus the existing card body. |
| `SettingsNav`, `Section` | new | Section routing. |
| `Evidence` drawer, `Toasts`, `Loading`, `Empty`, `ErrorState`, `ErrorBoundary` | keep, restyle | |

## 9. Accessibility

- Text is 4.5:1 or better in both themes, including meta text on every background; input and button borders and the dot are 3:1 or better.
  The numbers were computed for every token pair in the table above.
- No colour stands alone: every type has its icon and its word on every row, every status has its word ("All good", "Sign-in needed", "Down"), and every dot has a count or a sentence beside it and an accessible name ("needs you").
  The page was checked in greyscale and in simulated protanopia, deuteranopia and tritanopia: several type hues look alike there (section 6), and the types remain readable by icon and word.
  The simulation is not a test with people; one is part of Phase 6.
- Every hue's ink step is 4.5:1 or better on its soft step, on surface and on paper, and every solid step is 3:1 or better, in both themes (section 6).
- The four areas of Today are landmarks with names: `search`, and three `section`s labelled "For you now", "Connected services" and "Inbox".
- The search field is a combobox with a listbox of results; `Esc` closes the results and keeps the text.
- A type chip is a toggle button with `aria-pressed`, and its name includes the count ("Reviews, 7 open").
  On a narrow screen the type summary is a list named "Open items by type", and filtering and ordering are two native pickers.
- A request error is announced as an alert, once, and its Retry button is the next focus stop; the retained rows under it stay operable.
- The Connected services area is a polite status region; the proactive area is not live, so a card that arrives by the clock does not interrupt a screen reader, and it never takes focus.
- Focus is a 2 px ink ring with 2 px offset on every control.
  A selected row is a neutral fill with an indigo edge and the focus ring is an outline, so a focused row and a selected row never look alike.
- The queue is a list of disclosures (`button` with `aria-expanded`), not a grid of nested interactive cards.
  `j` and `k` move a roving tabindex; every action is a visible button reached with `Tab`.
  The single-letter decision shortcuts are off until the owner switches them on, cover only undoable decisions, and are off while typing (WCAG 2.1.4).
- The type chips keep their order and never remove the chip that has focus.
- The source of a fact is a button with `aria-expanded`, not a tooltip.
- The palette is a modal dialog with a combobox and listbox, focus trapped, `Esc` closes and returns focus; `Tab` moves focus.
- Tabs keep the existing `tablist` behaviour with arrow keys; the collection list uses `aria-orientation="vertical"`.
- One polite live region announces the outcome of the owner's own decisions ("Done. Undo available.", "Apply refused: ...").
  The count is not announced on every live update; it is announced once when a Source refresh finishes with a different number.
- The selected and the open row stay put during live updates.
- Layout reflows to one column at 320 px wide with no horizontal scroll and holds at 200% zoom.
- Motion honours `prefers-reduced-motion`; nothing flashes or loops except the job spinner.
- Headings: one `h1` per screen, `h2` per section, `h3` inside rows; a skip link to the main area.

## 10. What the service has to add

Every screen can be built from routes the Dashboard already calls.

| Need | Route today |
| --- | --- |
| Attention items, decisions | `/attention`, `/attention/:id/decision`, `/attention/:id/draft` |
| Proposals | `/memory/proposals?status=proposed`, `/apply`, `/reject` |
| Drafts | `/actions`, `/actions/:id` and its approve, execute, revoke, reject |
| Connected services | `/connections`, `/capabilities`, `/reader` |
| Proactive area | `/briefings/latest`, `/briefings`, `/attention` (the `meeting_prep` items) |
| Search | `/memory/search` |
| Evidence excerpt | `/memory/document?root=&path=` (fetched when a row opens, lines sliced in the client) |
| Recently added, Recent saves, Revert | `/memory/recent-changes`, `/memory/changes/:id/revert` |

**For the count and the drafts**, four things need the service, and each has a way to ship without it.
The reasons and the code references are in `spec-dot-and-drafts.md`, sections 1.4 and 2.5.

| # | Change | Without it |
| --- | --- | --- |
| C1 | `GET /inbox/count`: `inbox`, `proposals`, `drafts` and `signIns` as totals, with represented items already left out of `inbox` | The hook asks each list for one row more than it shows and labels a full answer "N+". |
| C2 | Emit `actions.changed` when housekeeping expires a draft (today it emits `attention.changed`) | The hook also listens to `attention.changed`. |
| C3 | `actionStatus` beside `actionId` on an attention item | The Inbox looks each item's draft up in the drafts list to decide whether the item is represented. |
| D1 | When an approval's 15 minutes end, set the draft back to `draft` and say so in an event | "Approve vN again" sends revoke, then approve. |

C3 matters more since v4 than in v3: it decides which page an item is counted on, and in v5 whether the row shows the "Draft waiting" tag.

**For the proactive area**, v5 ships with no service change.
These make it grow, in the order I would build them.

| # | Change | What it unlocks | Without it |
| --- | --- | --- | --- |
| P1 | `GET /proactive`: the occupants that apply now, ranked, each with `id`, `type`, `title`, `lines`, `related`, `actions`, `from`, `until` and `why`, and a `proactive.changed` live event | New kinds of proactive content ship in the service; the Dashboard renders unknown types with the generic card | The registry in the Dashboard, with the four occupants of section 5.1 |
| P2 | `POST /proactive/:id/feedback` with `opened`, `done`, `dismissed` or `expired`, stored per occupant type | The service can order and time cards by what the owner uses | Fixed precedence and lead times |
| P3 | On a `meeting_prep` item: `startsAt`, `endsAt`, `meetLink`, `attendees`, and `related` notes for the attendees and the meeting's project, with the time they were found | The card can show the end time and Join, leave when the meeting ends, and show Brain notes without waiting for a briefing | The start time from `dueAt` and no end time, attendees from the summary text, related notes joined by item id from the latest briefing and labelled with its time, leaving 10 minutes after the start |
| P4 | `schedules.meetingPrepLeadMinutes` (default 15) and `schedules.briefingUntil` (default 12:00) in the config, shown in Settings, Schedules and notifications | The owner, and later the Brain through a Proposal on the identity note, can set when things appear | Constants in the Dashboard |
| P5 | The "Got it" and "Not now" state stored in the service and replicated | A briefing read on one Machine is read on the others | Remembered per browser |
| P7 | `GET /briefings?since=`: the briefings of the day, newest first, with their kinds | The slot can keep "Earlier today: Daily briefing, 08:00" after a manual or away briefing was made, and can lead with the daily one while offering the others | One briefing occupant, from `/briefings/latest`; an older one is only in Deliverables |
| P6 | New occupant producers that read the Brain: a promise that falls due, a person waiting more than a week, a decision past its Review date that today's meeting touches, a weekly review | The area adapts as the Brain learns the owner | Briefings and meeting prep only |

P1 is the one that matters for the design: once the service owns the list, P2 to P6 change what shows without changing the screen.
P6's producers must put their reason in `why`, in words the owner can check, and anything they learn about the owner goes to the Brain as a Proposal, not into hidden state.

**For Connected services**, nothing is needed: every row of the table in section 5.1 is built from `/connections`, `/capabilities` and `/reader` as they are.
Worth doing: `nextRefreshAt` on `/reader`, so the Dashboard does not compute the next read from the last one and the interval.
Also worth doing: raise an attention item when a connection has been in `error` for a day, the way Replication does when it is blocked, so a service that stays down eventually reaches the dot.

Also wanted, not needed: a total on `/memory/documents` if collection counts are to come back, and a sane range for `limit` on the list routes.

To confirm with a test before building: Undo after Done sends `reopen` for a resolved item.
`decide` in `attention/engine.ts` accepts any decision whatever the item's state, so it should work, but the Dashboard only offers Reopen on dismissed and snoozed items today and nothing exercises this path.

## 11. Phased implementation scope

Each phase ships on its own and leaves the Dashboard whole.
`tests/e2e/visual.spec.ts` and the journeys are updated in the phase that changes what they look at; role and name based locators mostly survive, class based ones (`.item`, `.machine-row`, `.list-item`) need new hooks, and the names "Home", "Memory" and "Drafts" change in Phase 1.

**Phase 0 - Foundations.**

- `styles.css` (1,523 lines) splits into `styles/tokens.css`, `styles/base.css`, `styles/controls.css` and one file per screen, imported from `main.tsx`.
  The neutral and accent tokens change first, mapped onto the old names, so every screen takes the new look before any layout changes.
- The thirteen hues of section 6 go into `tokens.css` with the `.c-<hue>` classes, and a unit test computes the contrast of every solid and ink step against its backgrounds in both themes.
- Bundle the two faces (measured at 88 KB) and confirm the built size against the 150 KB budget; add `components/icons.tsx`, `components/AttentionDot.tsx`, `components/Tag.tsx`, `components/TypeIcon.tsx`.
- `components/ui.tsx`: `StatusPill` becomes `Tag`; healthy states stop rendering a pill.
- `public/favicon.svg` gains a no-dot sibling.

**Phase 1 - Shell and the dot.**

- New `needs-you.ts`: `useNeedsYou()` returns the total, its three parts and whether each is known, from `/attention`, `/memory/proposals`, `/actions` and `/connections`, with one unit test for every row of the test table in `spec-dot-and-drafts.md`, section 1.5.
- `App.tsx`: `Shell` moves to `components/Shell.tsx` with `Sidebar.tsx`, `TabBar.tsx`, `MoreSheet.tsx` and `MachineFoot.tsx` (from `views/ReaderLine.tsx`); `NAV` gets Today, Approvals and Brain and the new letters; the logo, favicon and title follow `useNeedsYou()`.
- The `/approvals` route exists from this phase, at first showing today's Drafts screen and `ProposalReview` list under one heading, so nothing is unreachable between phases.
- New `components/ShortcutSheet.tsx`.
- `Pair` and the unreachable screen get the centred layout.

**Phase 2 - Today.**

- `views/Home.tsx` becomes `views/today/Today.tsx` with its four areas.
- `components/BrainSearch.tsx` with the field and the results panel; Today uses it, and `Ctrl K` focuses it.
- `views/today/ServiceStatus.tsx` and `service-states.ts` from `views/ReaderLine.tsx` and the coverage part of `views/Inbox.tsx`, with a unit test per row of the decision table in section 5.1.
- `components/RequestError.tsx`, with the Inbox's first-load and after-a-good-load failures in the visual captures.
- `views/today/proactive/ProactiveSlot.tsx`, `ProactiveCard.tsx`, `occupants.ts`, `BriefingBody.tsx` (from `BriefingCard`) and `MeetingPrepBody.tsx`, with a unit test per occupant for when it applies and when it leaves, run against a fixed clock.
- `views/Inbox.tsx` (333 lines) splits into `views/today/Inbox.tsx`, `kinds.ts`, `TypeChips.tsx`, `TypeMix.tsx`, `CountLine.tsx`, `TypeGroup.tsx`, `QueueRow.tsx`, `DecidedRow.tsx`, `ItemBody.tsx` and `QuietLine.tsx`.
- `components/Evidence.tsx` shares `SourceView` with the new `components/Excerpt.tsx`.
- `views/RecentlyAdded.tsx` and `components/RecentChange.tsx` move into the Recently added line.

**Phase 3 - Approvals and the draft's page.**

- `views/approvals/Approvals.tsx` with the two groups and the Finished tab; `ProposalBody.tsx` takes the change rendering from `components/ProposalReview.tsx`; `DraftBody.tsx` is the read-only preview.
- `views/Drafts.tsx` becomes `views/approvals/DraftPage.tsx`: detail reordered, `components/DraftSteps.tsx` and `DraftStatus.tsx` added, no list beside it.
  New `views/approvals/draft-state.ts` maps an `ActionView` and the editor's state to one of the fourteen states, with a unit test per row of the table in section 5.3.

**Phase 4 - Brain and Jobs.**

- `views/Memory.tsx` (265 lines) splits into `views/brain/Brain.tsx`, `Collections.tsx`, `NoteList.tsx`, `NoteReader.tsx`, `FactList.tsx`, `SourceDisclosure.tsx`, `SearchResults.tsx`; `components/Timeline.tsx` is new.
- `views/RecentSaves.tsx` becomes the Recent saves subview; `components/Tabs.tsx` gains the vertical orientation.
- `views/Jobs.tsx`: table list, default selection, `Timeline` for events.

**Phase 5 - Connections, Settings, Setup.**

- `components/ConnectionCard.tsx` (342 lines) splits into `ConnectionRow.tsx` and the existing body; `views/Connections.tsx` adds the "Needs you" group and the tiles.
- `views/Settings.tsx` becomes a section router with `SettingsNav.tsx`; `AutoAccept.tsx`, `ConsolidationSwitch.tsx`, `MeaningSearch.tsx`, `Replication.tsx` and `ReplicationMachines.tsx` keep their logic and restyle.
- `views/Setup.tsx`: two-pane frame, required fields first, optional parts as disclosures.

**Phase 6 - Palette and finish.**

- `components/SearchPalette.tsx`: `BrainSearch` in a dialog with "Go to", for every screen but Today.
- Motion, a pass with a screen reader, in greyscale and the three colour-vision simulations, at 320 px and at 200% zoom.
- `docs/user-guide.md`, `README.md` and `GLOSSARY.md` (the Dashboard entry) updated for Today, Approvals, Brain, search and the moved sections.
- New visual captures for every screen in light, dark and narrow, plus each state of Today.

**Later, with the service** (section 10): P1 moves `occupants.ts` behind `GET /proactive`; P2 to P6 follow without changes to the screen.

## 12. What moves, and what is dropped

Nothing the owner can do today is removed.

| Today | After |
| --- | --- |
| Home | Today |
| Home: Briefing card | The proactive area's daily briefing card; Prepare briefing, Away summary and Meeting context in its More menu |
| Home: Sources block and Reader line | The Connected services area; every service in detail on Connections; the Reader also in the sidebar foot |
| Home: count chips | The type chips; they filter instead of jumping |
| Home: Show dismissed | "Hidden" on the Inbox heading |
| Home: Recently added | The Recently added line under the Inbox |
| Home: View draft on an item | Still on the item, in its type group, with a "Draft waiting" tag; the approval itself is in Approvals |
| Memory: Memory changes to review | Approvals, "Changes to the Brain" |
| Memory: Recent saves | Brain subview "Recent saves" |
| Memory: Rebuild index | Brain overflow menu and Settings, Service health |
| Memory: the search box | The field on Today, the palette, and the field on Brain; one small search control beside the wordmark on every screen |
| Drafts: list and tabs | Approvals, Waiting and Finished |
| Drafts: detail | The draft's own page inside Approvals |
| Settings: one page | Nine sections in four groups |
| Sidebar hint "g then a letter" | `?` shortcut sheet |

Dropped on purpose, and only as presentation:

- The green pills for healthy states ("ready", "connected", "complete", "succeeded", "up to date"), and the list of working sources on the first screen.
  The state is still stated: as one green line there, and as text on Connections.
- "first seen just now" in the collapsed row; it is in the opened row.
- The full source string printed under every fact; it is one press of the source button away.
- v3's headline sentence, count line, coverage line and right-hand rail, which v4 replaces.

## 13. Open questions

Settled before v4 and unchanged: what the dot means, the Brain label, bundled type, one accent for the owner's action (indigo since v6), Replication in Settings, the bottom bar on narrow screens, a focus ring that is an outline (indigo since v6).

Decided in v5 on Astra's position, and still the owner's to override.

1. **"Today" is the first screen and "Inbox" is its fourth area.**
   Keeping "Inbox" as the page name costs one label and changes nothing else.
2. **Approvals is drafts plus Proposals.**
   A connection that needs sign-in is not an approval and lives in Connected services.
3. **An item with a waiting draft stays in its type group**, tagged, and is counted in Approvals only.
   The price is two numbers that differ by the linked items, which the count line explains.
   The alternative is v4's: the item leaves its group, and every number on Today is the same number.

Open for the owner.

4. **Should the hues be retuned for colour vision deficiencies?**
   The simulation in section 6 shows which pairs collapse.
   A retune would spread the light theme's type hues over lightness, which makes some types paler or darker than others and takes some of the even, bright look v4 was asked for.
   The smallest useful step is three pairs: orange against gold, moss against gold, and teal against slate.
   I recommend doing it in Phase 0 with the contrast test, and checking it with a person who has a red-green deficiency.
5. **How long the briefing leads.**
   Until Got it or 12:00 is a guess; P4 makes it a setting.
6. **Which service changes are in scope.**
   C1 to C3 and D1 as before; C3 decides which page an item is counted on and whether it shows the tag.
   P1 to P7 are for the proactive area's growth and none blocks v5; P7 (a list of the day's briefings) is new.
7. **A new draft from a finished one**, and **Undo after Done**, are open as in v3.
8. **Rows above the fold.**
   v5 shows 2 rows at 1280 x 800 while the briefing is unread and 4 after.
   If that proves too few on a real account, the first lever is the briefing card's height (title and one line), not the type groups.
9. **The wider column.**
   Today and Approvals are 932 px wide so the chips fit one row; every other number in the layout is unchanged.
9. **The logo and the accent.**
   v6 leaves the shipped copper and brass mark alone and makes indigo the accent, so the mark is the one warm thing on a neutral page.
   If the mark should follow the interface, that is a change to the logo files outside this folder, and the attention dot would then take its colour from the new mark.
10. **The accent and the proactive area share indigo.**
   That is deliberate: both are Attache acting for the owner, and it keeps the palette at twelve hues.
   If the proactive area should stand apart from buttons and links, the accent can become neutral ink (black buttons in light, white in dark) with no other change.
