# Spec: the dot, the Inbox count and the draft state machine

Fable, round 2, with Part 1 revised for v4 and again for v5.
This is the one place both designs take these two rules from.

**Changed in v5** (after Astra's third review, `../astra/review-3.md`).
The count itself does not change: every row of the test table gives the same total as in v4.
Four things around it do.

- An open item whose draft is waiting is no longer taken out of its type group.
  It stays there with a "Draft waiting" tag and is still counted once, in Approvals.
- Two words keep two counts apart: "open items" for what the type groups hold, "need you" for decisions.
- What each part shows when its request fails is written out per place (1.6), and the prototype shows it.
- A draft that is being sent is listed under "In progress" in Approvals, not under Finished.

**Changed in v4** (after the owner's review, `../FEEDBACK-1.md`): approvals have their own page, so the count has three parts shown in three places, and an open item whose draft is waiting is counted as the draft, in Approvals, not as the item.
The total is the same number as before for every case in the test table.
Part 2, the draft state machine, is unchanged; the Drafts screen it describes is now the draft's own page inside Approvals.
Everything marked "today" was read in the code on this branch; file references are given so round 3 can check them.
`prototype.html` shows every state named here: the first screen's states through the bar at the bottom right, the draft states through the picker on the draft's own page, reached from Approvals.

## Part 1. The dot and the Inbox count

### 1.1 What the code does today

- The logo's dot follows attention items only: `Logo attention={(counts.data?.items.length ?? 0) > 0}` in `Shell`, `apps/web/src/App.tsx`.
  While `/attention` is loading or has failed, `counts.data` is null, so the dot is off: an unknown is drawn as "nothing".
- The Home badge is `counts.data.items.length`, so a full list shows "200" with nothing to say there may be more.
- The Drafts badge counts `/actions?status=draft,approved` (`App.tsx`), while the Drafts screen's "Needs review" tab lists `draft,approved,revoked,executing` (`views/Drafts.tsx`).
  A draft whose approval was revoked is on the screen and not in the badge.
- Proposals (`/memory/proposals`) and connections that need sign-in (`/connections`) reach no badge and no dot.
- The list routes take a `limit` query and fall back to a default: `/attention` 200, `/actions` 100, `/memory/proposals` 100, `/memory/documents` 300 (`apps/service/src/http/routes-data.ts`, `routes-work.ts`).
  These are defaults, not hard caps: no route enforces an upper bound, and none returns a total.
  Astra's objection to my v2 wording ("caps") is right.
- `/actions` builds every row with `ActionService.get`, which runs a second query for that draft's events (`apps/service/src/actions/service.ts`, `list` and `get`).
  Asking it for a large limit to count rows is the wrong tool.
- `useResource` keeps the last data when a reload fails and sets `error` beside it (`apps/web/src/live.ts`).
  So "the last known value" is already available to the shell without new state.

### 1.2 The rule

One hook, `useNeedsYou()`, owns the numbers.
The logo, the favicon, the tab title, the Today and Approvals nav entries, the narrow tab bar and the Inbox heading all read it and nothing else.

The count has four parts, shown in three places.

| Part | Counts | From | Shown on |
| --- | --- | --- | --- |
| Inbox | attention items in state `open` that no live draft represents | `/attention?state=open` | The Today nav entry and the Inbox heading |
| Proposals | Proposals in status `proposed` | `/memory/proposals?status=proposed` | The Approvals nav entry |
| Drafts | drafts in status `draft`, `approved` or `revoked` | `/actions?status=draft,approved,revoked` | The Approvals nav entry |
| Sign-ins | connections in status `needs_auth` | `/connections` | A dot on Connections and a row in Today's Connected services area |

The total, on the logo, the favicon and the tab title, is the four added together, so the numbers on screen always add up to it.

An open item is "represented" when its `actionId` is the id of a draft in `draft`, `approved` or `revoked` status.
Its next step is the approval, so it is counted once, as that draft, in Approvals.
The item itself stays in its type group, in the service's order, with a copper tag that names the draft's state ("Draft waiting", "Approved, not sent", "Approval revoked") and View draft as its first action.
It never carries Approve, Send or Reject; those are on the draft's own page.
v3 counted the same decision on the other side, as the item, and left the draft out; v4 counted it in Approvals and moved the item to a quiet line; the total does not differ between the three.

Two counts are on the first screen, and they are named differently so they are not confused.

| Name | Counts | Shown on |
| --- | --- | --- |
| Open items | every attention item in state `open`, represented or not | the type chips, the group headers, the narrow type summary |
| Need you | decisions: the Inbox part of the table above | the Today entry, the Inbox heading |

They differ by the represented items, and one line under the Inbox heading states the sum: "11 open items: 10 need you here, and 1 has a draft waiting in Approvals (4 waiting)."
When no item is represented the two are equal and the line only points at Approvals: "Also waiting: 4 approvals, on their own page."

Each part is in one of four conditions.

| Condition | When | Contributes |
| --- | --- | --- |
| Known | the request succeeded and returned fewer rows than it asked for | its number |
| At the limit | the request returned as many rows as it asked for | its number, as a lower bound |
| Unknown | the request failed, or has not answered yet | nothing, and the total cannot be exact |
| Off | the feature is off: `attention` for the first part, `drafts` for the third | zero, exactly |

The total is the sum of what the parts contribute.
It is exact only when every part is Known or Off.

| Total | Exactness | Logo, favicon | Nav and tab title | Inbox heading |
| --- | --- | --- | --- | --- |
| 0 | exact | no dot | no number, "Attache" | "Nothing needs you." plus what was read, when every source was read; "Nothing found in the 4 sources that were read." when one was not |
| N above 0 | exact | dot | "N", "(N) Attache" | "N need you" beside the Inbox heading, for the Inbox part |
| N above 0 | lower bound | dot | "N+", "(N+) Attache" | "At least N need you" plus the reason |
| 0 | not exact | unchanged from the last exact answer | no number | no claim: the error and Retry |
| nothing yet (first load) | - | no dot | no number | skeleton |

Three consequences are deliberate.

- An unknown never turns the dot off and never turns it on.
- "Nothing needs you." is only ever said from an exact zero.
- A lower bound is always labelled as one, in the number ("9+") and in words ("At least 9").

Things that never count, and why.

| Not counted | Shown where |
| --- | --- |
| A source whose last Source refresh failed, was partial, was denied, was offline or has never run, or a connection in status `error` | A row in Today's Connected services area, with its own word. The owner has no decision to make in Attache; `DESIGN.md` section 5.1 has the table. |
| A proactive card (daily briefing, meeting prep) | The "For you now" area. A meeting prep card points at an attention item that is already counted. |
| A draft in `executing` | Approvals, on the Waiting tab under "In progress", without a dot and outside the tab's number. It has not finished, so it is not under Finished. |
| Drafts in `succeeded`, `failed`, `unknown`, `rejected`, `expired` | Approvals, under Finished. A `failed` or `unknown` send also raises a toast when it happens. |
| Snoozed, dismissed and resolved attention items | "Hidden" on the Inbox heading. |
| Recently added changes | The Recently added line under the Inbox. Nothing there asks for a decision. |
| A running, blocked or failed job | Jobs. |
| Replication blocked or unauthorized | Not a separate part: the service already raises an attention item (`replication/blocked-inbox.ts`), so it is in the first part. |

### 1.3 Checked against the awkward cases

**Linked drafts.**

| Case | Result |
| --- | --- |
| Open item, its draft is `draft`, `approved` or `revoked` | One decision: the draft, in Approvals. The item stays in its type group with the "Draft waiting" tag, is in the open-items count and is not in the Inbox part. |
| The item is snoozed, dismissed, resolved or deleted while its draft is unfinished | The draft counts in Approvals, as every live draft does. Closing an item never hides an unfinished draft. |
| The item is open, its draft is `rejected`, `expired`, `failed`, `unknown` or `succeeded` | One decision: the item, in the Inbox part again, without the tag and with Prepare draft. The draft is finished and counts nowhere. |
| The item is open, its draft is `executing` | The draft is under In progress and is not counted. The item is counted in the Inbox part and offers View draft, not Prepare draft, until the send ends. |
| A draft with no item (none exists today, since every draft is made from an item, but the contract allows it) | Counts in Approvals. |
| The Drafts part is At the limit or Unknown | An open item that names a draft which cannot be seen is left out of the Inbox part, see below. Its row stays in its group with the tag "Has a draft, not loaded". |
| Another Machine | `action_id` and the `actions` table are local to a Machine (`core/db.ts`, `actions/service.ts`); attention items replicate, drafts do not. The count is this Machine's count, and the same Inbox can show "Draft ready" on one Machine and "Prepare draft" on another. This is today's behaviour and stays. |

Why a lower bound stays a lower bound.
Deduplication needs the list of live drafts.
When that list is incomplete or could not be loaded, an open item with an `actionId` that is not among the loaded drafts could be either represented by a live draft that was not loaded, or free because its draft is finished.
Such an item is left out of the Inbox part.
If its draft is live, the draft belongs to the part that is already marked incomplete; if not, the Inbox part is one too small.
So the total can be too small, and says so, but is never too large.
This answers Astra's objection that a capped component cannot simply be summed into a deduplicated total.
With C3 (`actionStatus` on the item) the Inbox part needs no second list and this case goes away.

**Expired approvals.**
An approval lasts 15 minutes (`APPROVAL_TTL_MS`).
When it ends the stored status stays `approved`; only `executable.reason` changes to "Approval expired; approve again" (`executability`, `actions/service.ts`).
The draft was in the count as `approved` and stays in it, so the count does not move.
What is broken is the way out, see 2.5.

**Expired drafts.**
A draft expires 48 business hours after it was first prepared (`actions/expiry.ts`).
`expireStale` flips it to `expired` on every `GET /actions`, `GET /actions/:id`, approve, and every 30 seconds from housekeeping (`HOUSEKEEPING_EVERY_MS`, `app.ts`).
Because the list request sweeps before it answers, a fetched list is always right.
The gap is the refetch: housekeeping emits `attention.changed`, not `actions.changed`, when a draft expires (`scheduleHousekeeping`, `app.ts`).
The hook therefore refetches the drafts part on both events, and also drops any row whose `expiresAt` has passed while the page sat open.

**Failed requests.**

| Case | Result |
| --- | --- |
| One part fails, others load | That part is Unknown. The rest show. "At least 9 things need you. Drafts could not be loaded." with Retry, and the failed group's place in the queue holds the error, not an empty group. |
| One part fails and the rest sum to zero | No number, no "nothing". The dot stays as it last was. |
| A reload fails after a good load | `useResource` still holds the old data. The part is Unknown; its old rows stay on screen labelled "as of 16:20". |
| The live stream reconnects | Every part refetches (`live.ts` emits `reconnected`). While they load, the previous exact answer stays. |
| The service is unreachable | The existing banner; the dot and number stay as last known; the sidebar foot says "Disconnected". |
| A part answers 409 `feature_disabled` | Off, not Unknown. The hook does not ask when it already knows the feature is off. |
| A part answers 401 | The whole app goes to pairing, as today. |

**List limits.**
Without a service change the hook asks each list for one row more than it will show and treats a full answer as At the limit: `limit=201` for attention, `limit=101` for Proposals and drafts.
That makes "exactly 200" and "more than 200" different, which they are not today.
It is a probe, not a bigger arbitrary limit, and the answer is still labelled a lower bound.
An exact number above the limit needs the count route in 1.4.

**Feature switches.**

| Switched off | Effect |
| --- | --- |
| Attention and briefings | First part Off. Proposals, drafts and sign-ins still count and still show. The Inbox and the proactive area say "Attention and briefings is off." |
| Drafts and approvals | Third part Off. The service revokes every approval when this is switched off (`applyFeatureChange`, `app.ts`), so a draft that was `approved` comes back as `revoked` when it is switched on again. |
| Search and recall, or capture | Proposals still list (`GET /memory/proposals` has no feature gate). Apply and Reject need capture; with it off the row says so and offers no buttons. |

### 1.4 What the service has to change

Needed for the count.

| # | Change | Why | Without it |
| --- | --- | --- | --- |
| C1 | `GET /inbox/count` returning `{ inbox, proposals, drafts, signIns }`, each a number or `null` for Off, with represented items already left out of `inbox` in SQL (`attention_items.action_id` joined to `actions.status`) | One request and one subscription in the shell instead of four lists; exact above any list limit; no per-row event query | The probe above: exact up to the limit, "N+" beyond it |
| C2 | Emit `actions.changed` when housekeeping expires a draft | The Drafts list and the count refetch on their own event | The hook also listens to `attention.changed` |
| C3 | `actionStatus` beside `actionId` on `AttentionItemView` | The Inbox can tell a represented item from a free one without loading the drafts list, so it knows which page the item is counted on | The Inbox looks the id up in the drafts part, and leaves the item out when that part is Unknown |

C3 also fixes a bug that exists today.
`Inbox.tsx` shows "View draft" whenever `item.actionId` is set, and `action_id` is never cleared.
After a draft is rejected, expires or fails, the item still says "View draft" and can never offer "Prepare draft" again.
The rule becomes: "View draft" while the linked draft is `draft`, `approved`, `revoked` or `executing`, with the tag for the first three; otherwise "Prepare draft", with the finished draft still listed in Approvals under Finished.
`createDraft` already makes a new draft in that case, because it only reuses one in `draft`, `approved` or `revoked`.

Worth doing, not blocking.

- Reject a `limit` that is not a whole number in a sane range on the list routes, as `/memory/recent-changes` already does.
- Raise an attention item when a connection has been in `error` for a day, the way Replication does when it is blocked.
  Today a source that fails for a week is a red row in the Connected services area and nothing else.

### 1.5 Test table for `needs-you.ts`

Each row is one unit test.
"Inbox" is the Inbox part, "Approvals" is Proposals plus Drafts.

| Attention | Proposals | Drafts | Sign-ins | Expected |
| --- | --- | --- | --- | --- |
| 4 open, 2 of them with a `draft` draft | 1 | those 2 | 1 | 6, exact: Inbox 2, Approvals 3, sign-ins 1 (Astra's v2 example) |
| 30 open, a9 and a21 linked | 6 | d1, d2 linked, d3 `revoked`, d4 `draft` | 0 | 38, exact: Inbox 28, Approvals 10 (the shared fixture `heavy-day-v1`) |
| 0 | 0 | 0 | 0 | 0, exact, no dot |
| item snoozed, its draft `draft` | 0 | 1 | 0 | 1, exact: Approvals 1 |
| item open, its draft `expired` | 0 | 0 in the live set | 0 | 1, exact: Inbox 1 |
| 1 open | 0 | 1 `approved`, approval ended | 0 | 2, exact: Inbox 1, Approvals 1 |
| 201 rows returned | 2 | 1 unlinked, 1 linked to a loaded item | 0 | "203+": Inbox 199+, Approvals 4 |
| 2 open, one with an `actionId` | 2 | request failed | 1 | "4+": Inbox 1 (the item with an `actionId` is left out), Proposals 2, sign-ins 1 |
| request failed | 0 | 0 | 0 | no number, dot unchanged |
| Off | 1 | 1 | 0 | 2, exact: Approvals 2 |
| 3 | 1 | Off | 0 | 4, exact: Inbox 3, Approvals 1 |
| 2 | 0 | 0 | 0, one connection in `error` | 2, exact |
| 2 open, one of them `meeting_prep` shown as a proactive card | 0 | 0 | 0 | 2, exact: the card adds nothing |
| 11 open, 1 with a `draft` draft | 2 | that 1 and 1 unlinked, plus 1 `executing` | 0 | 14, exact: Inbox 10, Approvals 4; 11 open items in the type groups; the `executing` draft adds nothing (the prototype's normal day) |
| 11 open, 1 with an `actionId` | 2 | request failed | 0 | "12+": Inbox "10+", Approvals "2+" |
| reload failed after a good load of 11 | 2 | 2 | 0 | "4+": Inbox unknown and its dot kept, Approvals 4 |
| 0 open | 2 | 2 | 0 | 4, exact: "No open Inbox items.", not "Nothing needs you." |
| 0 open | 0 | request failed | 0 | no number, dot unchanged, "No open Inbox items." and no "nothing" |

### 1.6 What each place shows when a part is not known

Added in v5.
The rule of 1.2 says what the number is; this says what stands on screen.
"As it last was" means the state at the last exact answer: nothing on first load, the earlier state after a good load.

| Part not known | Its nav entry | Its list | Elsewhere |
| --- | --- | --- | --- |
| Inbox, first load failed | No number, no dot | The heading without a count, and "Could not load. The Inbox request failed." with Retry in the rows' place. No rows, no chips, no empty state | Tab title is a lower bound from the other parts: "(4+) Attache". The logo's dot is on because approvals are known |
| Inbox, reload failed after a good load | No number; the dot as it last was | The heading with "as of 16:16, not refreshed", "Could not refresh. Showing the Inbox as it was at 16:16." with Retry, and the retained rows | The retained rows are left out of the total. The sidebar foot says "Count as of 16:16. Retrying." |
| Drafts, first load failed | Approvals shows the Proposals as a lower bound: "2+" | The Drafts group keeps its header and shows "Drafts could not be loaded. This is not an empty list." with Retry | The Inbox heading says "At least 10 need you", the count line says why, and a represented item's tag reads "Has a draft, not loaded" |
| Drafts or Proposals, reload failed after a good load | The other part as a lower bound | The group's header says "as of 08:06", then "could not be refreshed" with Retry, then the retained rows | The retained rows are left out of the total |
| All three failed, first load | No numbers, no dots | Each list shows its own error | Tab title "Attache", no dot on the logo, the foot says "The count is incomplete. Retrying." |
| All three failed after a good load | No numbers; each dot as it last was | Each list shows its error and its retained rows | The logo's dot is as it last was |

Retry asks again for the failed request only.
A failed Source refresh is not one of these: it is a row in the Connected services area and changes no number.

Empty states follow the same rule: say only what is known.

| Known | The Inbox says |
| --- | --- |
| Total exactly 0, every source read | "Nothing needs you." with the logo without its dot, and what was read |
| Total exactly 0, a source not read | "Nothing found in the 4 sources that were read.", and which one was not |
| Inbox part 0, approvals or a sign-in wait | "No open Inbox items.", what was read, and "4 approvals wait on their own page." or "A connection needs your sign-in, above." |
| Inbox part 0, drafts or Proposals unknown | "No open Inbox items.", and "Approvals could not be loaded, so Attache cannot say that nothing needs you." with Retry |
| Inbox part off | "The Inbox is switched off. Nothing is read for it, so this is not a claim that nothing needs you." |

"Nothing needs you." is said in the first row only.

## Part 2. The draft state machine

### 2.1 Nine stored statuses, not ten

ROUND-2 and my own v2 say "ten statuses".
The contract has nine: `draft`, `approved`, `rejected`, `expired`, `revoked`, `executing`, `succeeded`, `failed`, `unknown` (`ActionStatus`, `packages/contracts/src/actions.ts`).
My v2 table reached ten by listing two things the Dashboard derives.
There are five such derived states, and they matter more than the count.

| Derived state | Stored status | How the Dashboard knows |
| --- | --- | --- |
| Unsaved edits | any editable one | the editor's text differs from `payload` |
| Cannot send yet | `approved` | `executable.ok` is false for an authority reason |
| Approval ended | `approved` | `approval.expiresAt` has passed; `executable.reason` is "Approval expired; approve again" |
| Revoked by the service | `revoked` | the last `approval_revoked` event has actor `service` and a reason |
| Changed elsewhere | any | saving answers 409 `version_conflict`, or a live update brings a higher `version` while the editor has unsaved text |

### 2.2 Transitions

Every arrow below is a line in `actions/service.ts` or `jobs/runners.ts`.

| From | Action | To | Service call | Guard and refusal |
| --- | --- | --- | --- | --- |
| (none) | Prepare draft on an attention item | `draft` v1 | `POST /attention/:id/draft`, a job | `not_draftable`; needs Drafts on |
| `draft`, `approved`, `revoked`, `rejected` | Save new version | `draft` v+1, approval cleared | `PUT /actions/:id` with `expectedVersion` | `version_conflict`, `expired`, `not_editable` |
| `draft`, `revoked` | Approve vN | `approved`, valid 15 min or until the draft expires, whichever is sooner | `POST .../approve` with version and hash | `not_approvable`, `stale_approval`, `expired` |
| `approved` | Revoke approval | `revoked` | `POST .../revoke` | `not_approved` |
| `approved` | (service) connection disconnected, write permission removed, Drafts switched off | `revoked` | `revokeWhere` | - |
| `approved` | Send vN | `executing` | `POST .../execute` with nonce, version, hash | `approval_expired`, `payload_changed`, `not_authorized`, `replayed`, `approval_mismatch`, `not_approved`, `expired` |
| `executing` | (service) the other service confirmed it | `succeeded` | `finishExecution` | - |
| `executing` | (service) refused before anything was written, or stopped before the call | `failed` | `finishExecution` | - |
| `executing` | (service) timeout, network failure, 5xx, or sent but not read back | `unknown` | `finishExecution` | - |
| `draft`, `approved`, `revoked` | Reject | `rejected` | `POST .../reject` | `not_rejectable` |
| `rejected` | Restore | `draft` v+1 | `PUT /actions/:id` with the same text | `expired` |
| `draft`, `approved`, `revoked` | (service) 48 business hours passed | `expired` | `expireStale` | - |

Three facts in that table are easy to miss.

- **A new version replaces the old text.**
  `edit` overwrites `payload`; `action_events` keeps the version number and hash, not the words.
  History can list versions; it cannot show them.
- **Reject is not final.**
  `edit` accepts a `rejected` draft and sets it back to `draft`.
  Today's screen leaves the editor enabled on a rejected draft, so typing and saving silently un-rejects it.
- **`failed`, `unknown`, `succeeded` and `expired` are final.**
  `edit`, `approve` and `reject` all refuse them.
  The only way forward is a new draft from the attention item.

### 2.3 What the owner sees in each state

"vN" is the current version.
Send reads "Create vN in Gmail" for a `gmail.draft`, which creates a draft in Gmail and sends nothing.
The header always shows kind, destination, version and stored status.

| State | Step line | Message | Buttons, primary first | Editor |
| --- | --- | --- | --- | --- |
| `draft` | 1 current | "Send unlocks after approval. Approval covers exactly this version, for 15 minutes." | **Approve vN**, Send vN (disabled), Reject | on |
| Unsaved edits | as before the edit | "Saving creates vN+1 and replaces the text of vN, which is not kept." Plus "It also cancels the approval of vN." when approved | **Save as vN+1**, Discard changes, Approve vN (disabled), Send vN (disabled), Reject | on |
| `approved` | 2 current, "Approved, 14:32 left" | "vN approved at 16:21, valid until 16:36. Send posts exactly vN and cannot be undone. Attache rechecks the approval and the write permission right before sending." | **Send vN**, Revoke approval, Reject | on; typing leads to Unsaved edits |
| Cannot send yet | 2 current | Brass notice: "Cannot send yet." plus `executable.reason`, and Open Connections when the reason is about authorisation | Send vN (disabled), Revoke approval, Reject | on |
| Approval ended | 1 current, step 2 reads "Approval ended 16:36" | "The approval of vN ended at 16:36. Nothing was sent." | **Approve vN again**, Send vN (disabled), Reject | on |
| `revoked` by the owner | 1 current, "Approval revoked" | "You revoked the approval at 16:25. Nothing was sent." | **Approve vN**, Send vN (disabled), Reject | on |
| Revoked by the service | 1 current, "Approval revoked" | Brass notice: "Attache revoked the approval at 16:25: connection disconnected. Nothing was sent." Plus "Send stays locked until GitHub is connected." | **Approve vN**, Send vN (disabled), Reject | on |
| `executing` | 3 current, "Sending vN" | "Sending vN. Attache marks this sent only after GitHub confirms it. This keeps running if you close the tab." | none | off |
| `succeeded` | all three checked, "Sent 16:22, verified" | Receipt: verified time, remote id, link | none | off |
| `failed` | step 3 red, "Not sent" | Red notice: "Not sent." plus `receipt.error`. "This draft is finished. It cannot be edited or sent again." | Copy text, Prepare a new draft, Open on GitHub | off |
| `unknown` | step 3 brass with "?", "Outcome unknown" | Brass notice: "The outcome could not be verified. The request may have reached GitHub. Check the pull request before you do anything else." Plus `receipt.note` | Open the pull request, Copy text | off |
| `rejected` | none | "You rejected vN at 16:30. Nothing was sent." | Restore as vN+1, Copy text | off |
| `expired` | none | "Expired Thu 19 Nov, 16:21, 48 business hours after it was prepared. Nothing was sent." | Copy text, Prepare a new draft | off |
| Changed elsewhere | 1 current | Brass notice: "This draft became vN+1 while you were editing. Your text is not saved, and the approval of vN no longer applies." | Copy my text, **Load vN+1**, Approve and Send disabled | on, holding the owner's text |

Rules that hold in every state.

- At most one button is copper, and it is the next step forward.
  Reject is never copper.
  In `unknown` nothing is copper: the next step is to look, not to act.
- Approve and Send always carry the version number.
- Approve is disabled while the text is empty, as today.
- "Nothing was sent." is said in every state where that is true and the owner might wonder.
- `unknown` is never drawn with a check mark and never says "sent".
- After any action the screen stays on this draft, also when it leaves the "Needs review" tab.
- There is no keyboard shortcut for any button on this screen.
- Every refusal from the service (the codes in 2.2) is shown in the status line under the buttons with the service's own sentence, and the draft reloads.
  The service records refused sends as `execution_refused` events, so they also appear in History.

`failed` has two shapes in `receipt`.
With `attempted: false` Attache stopped before calling the other service: the approval or the write permission had lapsed.
With `attempted: true, sent: false` the other service refused it.
The notice says which.

`unknown` deliberately has no "Prepare a new draft" button.
A second send is the one mistake this state exists to prevent, so the path to it goes through the Inbox item, after the owner has looked.

### 2.4 Irreversible steps

| Step | Reversible | How the screen treats it |
| --- | --- | --- |
| Send | No. It posts to another service. | Two separate presses (Approve, then Send), a named version, a 15 minute window, a server-side recheck, no shortcut. The sentence beside Send says "cannot be undone". |
| Save as vN+1 | No. The text of vN is gone and any approval of it with it. | Says so before saving. Discard changes is always beside it. |
| Expiry at 48 business hours | No, and automatic. | The expiry time is on the step line from the start, and the Inbox row says "expires in 2 days". |
| Reject | Yes, until the draft expires. | Restore as vN+1. |
| Approve | Yes. | Revoke approval. |
| Revoke approval | Yes. | Approve vN. |

### 2.5 What the service has to change

| # | Change | Why | Without it |
| --- | --- | --- | --- |
| D1 | When an approval's 15 minutes end, housekeeping sets the draft back to `draft`, clears the approval, records `approval_expired` and emits `actions.changed` | Today the draft stays `approved` and `approve` refuses anything that is not `draft` or `revoked` (`not_approvable`). The only ways out are Revoke approval followed by Approve, or an edit. Today's screen offers neither as such: Send is disabled and there is no Approve button. `actions.test.ts` covers the refused send and not the recovery. | "Approve vN again" sends revoke, then approve. If the second call fails the draft is `revoked`, which is a safe place to be. |
| D2 | C2 from Part 1: `actions.changed` on expiry | The open detail learns its draft expired | The detail runs a timer to `expiresAt` and reloads |
| D3 | C3 from Part 1: `actionStatus` on the attention item | "Prepare a new draft" after a finished draft | A lookup in the drafts list |

Not needed, but honest to name: "Prepare a new draft" asks the model again, so the owner's edited text is not carried over.
"Copy text" is the bridge.
A route that makes a new draft from a finished one with the same text would be better, and it is the one place I would add a write route for the Dashboard.

To confirm with a test before building, because I read it and did not run it.

- An `executing` draft never stays `executing`: `jobs.onUnsuccessful` in `app.ts` finishes it as `unknown` or `failed`, and after a restart `JobQueue.recover` either calls the same hook or resumes the job, which then reconciles through its pending side effect in `runAction`.
- `revoke` and `GET /actions/:id` have no feature gate, so a draft stays readable and revocable with Drafts switched off, while `GET /actions` answers 409.
  The Drafts screen with the feature off therefore shows "Drafts and approvals is off" with the link to Settings, not an error.
