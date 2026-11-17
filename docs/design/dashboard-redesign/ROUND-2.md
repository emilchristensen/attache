# Round 2 of 3

Both designs now share: one Inbox for every decision, Inbox and Brain as names, compact rows that open in place, a Brain search palette that only searches and navigates, quiet healthy states, no single-key Apply/Reject/Approve/Send, provenance as a disclosure (not hover), and transient source failures never lighting the dot.

## Open disagreements - settle each one

Each designer writes a final position on every item in `review-2.md`: "accept the other's", "hold" (with the strongest reason) or a new compromise.

1. Dot scope: everything the owner can decide (Proposals, drafts, sign-ins) or attention items only.
2. Headings: descriptive slogan headings ("Your day, in view.") or a live, count-driven headline with items above the fold at 1280 x 800.
3. Type: bundled faces (Fable, 150 KB budget) or system sans plus Georgia (Astra; renders as Liberation Serif on Linux).
4. Density: 44 px controls and 16 px body everywhere, or 44 px for touch only and denser desktop.
5. Colour: may copper double as a status colour.
6. Inbox filter: native select, or a wrapping line of count links.
7. Replication: in the navigation, or one Settings section ("Machines and Replication").

## Improve next - split between the designers

Astra owns, in `astra/spec-states.md`:
- Narrow-screen layout (down to 360 px) and the safe keyboard model for every screen.
- Edge states: Proposal conflicts, a refused Revert, incomplete source coverage, failed requests versus empty, capped lists.
- A shared dense fixture: one realistic heavy day (counts per kind, long titles, many sources) that both prototypes render.

Fable owns, in `fable/spec-dot-and-drafts.md`:
- The dot and Inbox count rule written once, checked against linked drafts, expired approvals, failed requests and capped list routes, and listing any service change it needs.
- The draft state machine for all ten statuses, with every transition, button label and irreversible step.

Each designer reviews the other's spec in round 3.
