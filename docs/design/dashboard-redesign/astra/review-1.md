# Review round 1: Astra on Fable

## Adopt from Fable

- One Inbox for owner decisions, retaining dedicated Drafts and Brain review destinations.
- Inbox and Brain labels, preserving existing routes and shortcut letters.
- Search first in Brain and Ctrl K access from anywhere, with keyword fallback explained.
- Compact disclosure rows with evidence beside the action, replacing my separate decision cards.
- Plain text for healthy states, warm paper and copper, and serif reading surfaces.
- Shared change presentation with an explicit link from Recently added to Recent saves.

## Disagree

- The dot should mean an actionable decision, not freshness, transient failure and unverified information simultaneously.
  Fable’s principle says never “new”, but its queue and dot inventory explicitly use it for new items.
  Use textual changed and overdue labels, and a separate coverage warning for incomplete reading.
- Do not treat Apply as safely reversible or assign Apply and Reject single-letter shortcuts.
  The service checks Revert eligibility and later changes can prevent reversal.
  Keyboard navigation should reach explicit action buttons without executing them.
- Do not hide provenance behind hover alone or replace full history with a shortened sentence.
  Provide a focusable disclosure with the complete source and history entry, including on touch screens.
- Keep the palette limited to search and navigation initially.
  Mixing backup and research mutations into passage results complicates keyboard expectations.
  Tab must move focus, not open a note.
- Do not collapse rows and automatically move into another draft after a decision.
  Preserve selection through live updates and require a deliberate next selection.
- The 1360px filter strip visibly clips Drafts, and the narrow capture clips later categories.
  Use a labelled native selector with every category instead of requiring horizontal discovery.
- “Nothing is required” overstates service readiness for exact totals.
  The documents endpoint defaults to 300 results and actions defaults to 100, with no collection totals in the documents response.
  Omit collection counts and settle queue completeness before advertising exact global totals.

## Fable's open questions

1. Rename Home and Memory to Inbox and Brain, keeping old routes and shortcut aliases.
2. Keep Proposals in Inbox even when usually absent because Consolidation is enabled.
3. Count a linked draft once with its open attention item using actionId, while retaining independent draft status and attention decisions.
   Closing the attention item must expose an unfinished draft as its own row.
4. A transient failed source does not light the dot, but a connection requiring sign-in does.
   Zero decisions never implies complete coverage.
5. No single-key Apply or Reject, and never a sending shortcut.
6. Start with system sans and Georgia or Iowan, then judge bundled font value after an offline comparison.
   The claimed 120 KB needs measurement of actual shipped assets.
7. Replace the overflowing Inbox tabs with a labelled selector, including empty categories so controls do not move with live updates.
8. Brain collection counts are not returned as totals by the current documents endpoint.
   Omit them rather than counting a potentially truncated list.

## Agreed direction so far

Both designs put decisions and evidence first, make Brain search prominent, keep notes read-only, separate approval from execution, and use copper with warm neutral surfaces.
Both retain source coverage, Recently added and Revert, indexed Settings, grouped Connections, every setup step and both themes.
This is Astra’s assessment of overlap, not a claim that Fable has accepted these revisions.

### Evidence checked

Opened Fable’s prototype in Chrome and read its HTML and design specification.
Inspected the light Inbox, dark Brain and narrow Inbox captures alongside current Home and Memory captures.
The captures substantiate buried Brain search and clipped categories.
App.tsx currently derives the logo from attention only, while Memory.tsx renders ProposalReview and RecentSaves before search.
Inbox.tsx already exposes actionId and distinguishes incomplete coverage from successful source reading.
GLOSSARY.md defines Brain as curated memory, evidence and deliverables, supporting the label change.
The user guide preserves separate approval, execution, source recovery and Replication behavior.
Service routes-data.ts exposes limited document arrays, search passages, proposed Proposals and checked Revert actions.
Service routes-work.ts exposes version-specific approval and execution and a default 100-action list limit.
Fable’s prototype is a visual specification, not proof of keyboard triage, focus trapping or mutation handling.
Its narrow More control currently navigates straight to Settings, so Jobs and Connections access still needs demonstration.

## Improve next

1. Specify and demonstrate unified-count correctness under linked drafts, closed items, expired approvals, feature-disabled endpoints, partial loads and service disconnection.
2. Demonstrate narrow and keyboard flows with all categories, reachable operations pages, preserved selection and safe explicit decision controls.
3. Exercise realistic evidence and failure density: long provenance, conflicting Proposals, refused Revert, unknown send outcome and zero decisions with incomplete coverage.
