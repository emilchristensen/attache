---
status: accepted
---

# Changes reach the Brain without review by default

The Shared Brain spec (#5) had every save confirmed by the owner inside the Harness and every Consolidation change wait as a Proposal, so nothing was written on a model's word alone.
We turn that around: an agent's save and Consolidation's changes are written straight away, and the owner sees afterwards what was added.
The owner does not review every save, so a confirmation step mostly lost saves (a headless Harness declines without asking, #57) and a Proposal queue mostly went unread.
We accept that a prompt-injected or hallucinating agent can write to the Brain unseen, and rely on seeing and reverting changes instead of approving them.

## Consequences

- Auto-accept is on by default for every Harness, and the release that brought it switches it on everywhere; the owner can still switch it off per Harness.
  The exception is a Harness that is not connected and an unknown MCP client: they still ask first, because the Dashboard has no switch to turn them off.
- Consolidation has one switch of its own, on by default, and no longer caps how many changes a session yields; its quality rules (no repeated unchanged facts, no Slack or mail snapshots) stay.
- The Dashboard's Home shows every change written without review in the last 7 days, with its source and a revert, and Corrections as old value to new value.
  An event written without review cannot be reverted, because History only grows; the owner corrects it with a new event.
- The identity record still cannot be changed by a save.
- Proposals remain for a Harness with auto-accept off that cannot ask the owner, and for Consolidation with its switch off.
- User stories 19, 21, 89 and 92 in #5 are superseded where they require review before writing.
- Built in #80 (auto-accept default), #81 (Consolidation) and #82 (Home section); #57 covers a Harness with auto-accept off that cannot ask.
