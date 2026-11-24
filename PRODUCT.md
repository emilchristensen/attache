# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Knowledge workers who spend their day inside an AI Harness such as Claude Code, Codex, Claude Desktop, Antigravity, OpenCode, Pi or Copilot CLI, and whose work is spread across GitHub, Jira, Confluence, Slack, Gmail and Google Calendar.
They install Attache on their own computer, on macOS, Linux or Windows, and are comfortable running an installer and pairing a browser, but should not need developer tools.
The project's author is one such person, not the design target: decisions are made for the general case.

The owner opens the Dashboard in three situations:

- A morning check: read the Daily Briefing, then clear the Inbox and Approvals before the day starts.
- Glances between meetings: a pinned browser tab on a laptop, checked for a minute when the Attention dot shows.
- On the phone: a narrow window or phone browser, away from the desk.

Most questions to the Brain, and most additions to it, happen in the Harness through Attache's MCP server, not in the Dashboard.

## Product Purpose

Attache is a local-first personal assistant that keeps one person's knowledge and brings forward what needs their attention.
It keeps the Brain as Markdown in a folder the owner chooses, answers with cited evidence, watches the sources the owner connects, and prepares Drafts that are sent only after the owner approves the exact version.

The Dashboard shows the Brain and the Inbox and takes the owner's decisions.
Success is an owner who can see in a glance what waits for them, decide it in a click, and trust that nothing was sent, lost or hidden without their knowing.

## Positioning

1. The knowledge stays the owner's: plain Markdown in a folder they choose, readable and editable in Obsidian or any Markdown editor, and the Dashboard loads nothing from the internet.
2. Every answer cites file and lines.
3. Attache holds no conversation of its own (ADR 0003): the owner asks from the Harness they already use, and the Dashboard only shows and decides.
4. Nothing goes out until the owner approves the exact version, enforced by the service and confirmed with a verified receipt.
5. It says what it knows and what it does not: an empty Inbox says what was read, a failed request is never shown as an empty list, and a count that could not be read fully is written as a lower bound.

## Operating Context

- The service runs in the background on the owner's computer and serves the Dashboard at `http://127.0.0.1:7427`; each browser, the command line and each Harness pairs with a one-time code.
- The Dashboard's screens are Home, Approvals, Brain, Connections, Jobs and Settings, in one masthead, or a bottom bar on a narrow window.
- Home holds Search the Brain, For you now, the Inbox, Recently added and the Connections that need a look.
- Connections are optional and start read-only: local Markdown and Obsidian folders, GitHub, Jira, Confluence, Slack, Gmail, Google Calendar, a model provider, and the Harnesses.
- Replication (opt-in) keeps every Machine's copy of the Brain the same through a private git repository.
- Jobs (research, briefings, Draft preparation, Source refresh) keep running when the browser closes.
- Setup asks only for a data folder; everything else is optional and can wait.
- Changes reach the Brain without review by default (ADR 0004); the owner sees them afterwards in Recently added and Recent saves and reverts them there.

## Capabilities and Constraints

- Vocabulary follows `GLOSSARY.md`, and the words it lists under _Avoid_ never appear in text the owner reads.
- The Dashboard does not capture, edit or correct notes, and no chat box comes back without the owner deciding it again (ADR 0003).
- No key ever applies, approves, sends, rejects, reverts or disconnects; the Decision keys are off until the owner switches them on.
- The Attention dot follows the Decision count only; it never means new, unread, changed or offline.
- Search works without a model; meaning-based search runs on a small local multilingual model.
- The Dashboard follows the system's light or dark setting and works offline.
- Every feature the Dashboard has today is kept by a redesign; moving or regrouping is fine, dropping needs an explicit argument.
- Releases are not code-signed.

## Brand Commitments

- The name is Attache, written without the accent so it works as the `attache` command.
  It was called Jarvis until November 2026; older commits still say so.
- The logo is `docs/assets/logo.svg` (`apps/web/src/components/Logo.tsx` in the Dashboard); its dot is the Attention dot.
- Voice: plain, literal sentences in the glossary's words.
  User-facing text tells the owner what to do next, never shows a secret, and never claims more than Attache knows.
  Counts are exact ("1 file", "2 files", never "file(s)").
  No em dash character.

## Evidence on Hand

- Logo: `docs/assets/logo.svg`.
- Earlier design records, prototypes and screenshots: `docs/design/` (kept as records of their time, not as current authority).
- A realistic heavy day of Inbox content: `docs/design/dashboard-redesign/astra/dense-fixture.json`.
- Visual captures of every screen, both themes, 1280 x 800 and 375 x 812: `tests/e2e/` (`visual.spec.ts`, `home-days.spec.ts`).
- No testimonials, user counts, press, benchmarks or hosted version exist; do not invent them.
- Attache is free under MIT and closed to outside contributions; there is no pricing.

## Product Principles

1. **Decide, then leave.** The Dashboard exists to show what waits and take a one-click decision; it never becomes a place to dwell or converse.
2. **Honest state over tidy state.** Say what was read, what failed and what is unknown; never turn an error or a partial read into silence or an empty list.
3. **The owner holds the pen.** Nothing leaves without approval of the exact version, and anything written without review can be seen and reverted.
4. **Cite everything.** Every fact and result names where it came from.
5. **Local and owned.** The Brain is plain files the owner can read without Attache, and the Dashboard needs no network.

## Accessibility & Inclusion

- WCAG 2.2 A and AA, checked with axe-core on every screen, opened state, Setup and pairing (`tests/e2e/a11y.spec.ts`).
- Works at 320 px and at 200% zoom with no sideways scrolling, with a screen reader, under forced colours and under reduced motion.
- 44 x 44 px touch targets on a phone or with a coarse pointer.
- Inbox types stay distinguishable in grayscale and under colour-vision simulation: each carries a word and a glyph, not colour alone.
