---
status: accepted
---

# One adapter boundary for Harness Connections

Attache connected Claude Code, Codex, Antigravity and Claude Desktop through one shape: a JSON hooks file, an MCP configuration file and, for Antigravity, a rule file.
OpenCode, Pi and Copilot CLI (#98) each integrate through their own plugin, extension or hook system, and bending them into that shape would mean working around their official APIs.
We define one Harness adapter boundary instead (`apps/service/src/agents/harness-adapters.ts`, types in `packages/contracts/src/harness.ts`): detect, preview, apply, status, refresh and uninstall.
Each product's adapter owns how its files look; the rest of Attache only calls the boundary.

## Capabilities

- Every adapter reports three capabilities on its own: MCP access, memory and session capture.
  None is implied by another, and a successful MCP registration says nothing about memory or capture.
- MCP access is the baseline every Harness Connection gets.
  A Harness may ship with MCP access only when its lifecycle events cannot be trusted for memory or capture.
- Memory is `none`, `runtime-fresh` (the Harness reads the Brain's memory at a session or prompt boundary) or `managed-file` (Attache keeps a file the Harness always loads).
  Runtime-fresh memory is preferred wherever the Harness offers a boundary to read it at.
- Session capture is `none`, `with-final-event` or `without-final-event`.
  A Harness without a reliable final event says in its Connection notes that the newest in-flight turn can be missed.
- Each adapter records whether a running Harness must be restarted before an install or update takes effect, and the preview and every apply carry it.

## Ownership

- Every file and entry an adapter writes carries this Attache instance's identity, so two instances on one Machine never touch each other's entries.
- The owner's own configuration stays as it was: a file that does not parse stops the change before anything is written, and each existing file is backed up before it changes.
- Connecting again changes nothing, and refreshing replaces only stale Attache entries.
- Uninstall tries every part even when one fails, and reports each failure with its file.
- Status is `current`, `stale`, `missing` or `failed`.

## Delivery and support

- Each Harness ships on its own; a problem with one Harness's API does not hold back another.
- Attache calls a Harness officially supported only once it has install, update and uninstall fixtures, transcript parser fixtures, and a smoke test that runs the real executable in an isolated home.
  A failing smoke test withdraws that claim for that Harness only.
  Officially supported describes Attache's tested integration, not an endorsement by the Harness's maker.

## Considered options

- **Extend the hooks file shape with a case per Harness.**
  Least new code at first, but each new Harness adds special cases to one module and still cannot express a plugin or an extension.
- **Move every existing Harness onto new adapters now.**
  Uniform, but rewrites installation logic that works and is tested, for no change the owner sees.

## Consequences

- Claude Code, Codex, Antigravity and Claude Desktop stay on their working installation (`agents/install.ts`); a thin adapter delegates to it, and its behaviour is the compatibility baseline.
- A new Harness adds an adapter and its fixtures, not a branch inside the existing installation.
- The Connections page, setup notes and the user guide describe each Harness by its three capabilities and its restart requirement.
