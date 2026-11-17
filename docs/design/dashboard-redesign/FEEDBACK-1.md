# Owner feedback on v3

The v3 design is too dense: the owner cannot get an overview at a glance.

## What must be prominent on the first screen, in this order

1. **Search the Brain.**
   A prominent search field, not only a `Ctrl K` palette.
2. **A proactive area.**
   Things the owner needs but does not know yet.
   Examples: the daily briefing in the morning, meeting prep that appears 15 minutes before a meeting starts.
   It must be designed to grow: as the Brain learns the owner, it adapts what shows here.
   Design it as a slot that can hold different kinds of proactive content over time, with what exists today (briefings, `meeting_prep` attention items) as the first occupants.
3. **Status of connected services.**
   Working services are not important and should not be listed.
   Call out only what is down or needs re-authentication.
   When everything is fine, show one simple green message.
4. **The Inbox, below the status.**
   Approvals do not belong in the Inbox; they get their own page.
   Interpretation (owner can correct): "approvals" means drafts waiting for approval and Proposals waiting for Apply or Reject - anything Attache prepared that needs the owner's OK.
   Each Inbox message must make its type obvious at a glance.
   Today everything blurs together: a PR review request must not look like a pending reply.
   The service already distinguishes kinds (see `packages/contracts/src/attention.ts` and the connectors: `review_request`, `authored_pr`, `assigned_issue`, `pending_reply`, `mention`, `slack_dm`, `slack_mention`, `invite_response`, `deadline`, `jira_work_item`, `meeting_prep`, and others).

## What stays

Everything settled in `README.md` that this feedback does not contradict: the dot, the visual language, no single-key irreversible actions, nothing moves under the owner, accessibility, every feature kept.
Colour is still never the only signal for type; pair it with an icon and a word.

## Colour (added after the first feedback)

The colours are too dull, and colour is not used to make items distinct from each other, so everything blurs together.
Use colour actively to separate item types, areas of the first screen and states, with a richer palette than copper, brass and paper neutrals.
This revisits the v3 rule of "three hues": keep copper as the brand, but give each Inbox type (and the proactive area and the status callout) its own clear colour identity.
Colour must still pass contrast in light and dark, and must still be paired with an icon and a word, never the only signal.
