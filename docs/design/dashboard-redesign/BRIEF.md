# Dashboard redesign - design brief

Goal: scope a full redesign of the Attache Dashboard (`apps/web`), built around the new copper logo (merged in PR #10: `docs/assets/logo.svg`, `apps/web/src/components/Logo.tsx`; its dot shows when something needs attention).

Two designers work in parallel: Astra (`astra/`) and Fable (`fable/`).
They produce independent designs, then review each other's work for up to 3 rounds and converge on one direction.

## Read first

- `README.md`, `GLOSSARY.md` - what Attache is and the domain words the UI must use.
- `docs/user-guide.md` - every screen and flow the owner sees today.
- `docs/architecture.md` - what the service exposes to the Dashboard.
- `apps/web/src/` - the current Dashboard (views, components, `styles.css`).
- `docs/assets/logo.svg` - the new logo.

## Seeing the current Dashboard

`pnpm install`, then `pnpm dev --port <unique port> --state-dir <your own scratch folder>` (see `docs/developer-guide.md`).
The other designer may be running one at the same time, so never use the default port or state folder.
`tests/e2e/visual.spec.ts` also captures screenshots on OS-picked ports.
Stop any server you start before you finish.

## Deliverables per designer (in your own folder only)

- `DESIGN.md` - the design scope: principles, information architecture and navigation, every screen (what changes and why), visual language (colour tokens for light and dark, type, spacing, iconography, motion), how the logo and its attention dot are used, component inventory, accessibility, and a phased implementation scope mapped to files in `apps/web/src`.
- `prototype.html` - one self-contained static HTML file (no external requests except Google Fonts) showing the key screens with realistic content, light and dark.
- `screenshots/` - optional PNGs of the prototype.

## Rules

- Do not edit anything outside your own folder, do not touch `apps/` source, do not commit or push.
- Never use the em dash character; use a plain dash.
- In Markdown, put each sentence on its own line.
- Keep every feature the current Dashboard has; a redesign may move or regroup, not drop, unless you argue for it explicitly.
