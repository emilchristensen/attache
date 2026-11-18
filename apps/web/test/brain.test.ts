import { describe, expect, it } from "vitest";
import type { ProposalView, RecentChangeView } from "@attache/contracts";
import { brainHref, brainPlace, collectionOf, filterChanges, noteSections, parseSource, recentFilterAt, waitingProposalsFor, waitingProposalWords } from "../src/brain.ts";

describe("parseSource: a fact's source as the note stores it", () => {
  it.each([
    [
      "a Harness session with a label",
      "Claude Code session in attache (agent-session: claude-code/sess-1, observed 2026-11-17)",
      { text: "Claude Code session in attache (agent-session: claude-code/sess-1, observed 2026-11-17)", summary: "Claude Code session in attache", kind: "Harness session", observed: "2026-11-17", open: null },
    ],
    [
      "a capture in the data folder, with lines",
      "(capture: evidence/captures/2026-11-17-ledger.md#L4-L9, observed 2026-11-17)",
      { summary: "Capture", kind: "Capture", observed: "2026-11-17", open: { kind: "file", root: "data", relPath: "evidence/captures/2026-11-17-ledger.md", lines: [4, 9] } },
    ],
    [
      "a note in the data folder, without lines",
      "Pilot handover (note: memory/notes/pilot-handover.md, observed 2026-11-12)",
      { summary: "Pilot handover", kind: "Note", open: { kind: "file", root: "data", relPath: "memory/notes/pilot-handover.md" } },
    ],
    [
      "an imported note in another root",
      "Orion (import: import:vault-1:Projects/Orion.md#L12-L16, observed 2026-11-10)",
      { summary: "Orion", kind: "Imported note", open: { kind: "file", root: "import:vault-1", relPath: "Projects/Orion.md", lines: [12, 16] } },
    ],
    [
      "a connector with a link",
      "PR acme/web#42 (connector: https://github.com/acme/web/pull/42, observed 2026-11-16)",
      { summary: "PR acme/web#42", kind: "Connector", open: { kind: "url", url: "https://github.com/acme/web/pull/42" } },
    ],
    [
      "a connector reference that is not a file",
      "(connector: slack:C123/1700000000.1, observed 2026-11-16)",
      { summary: "Connector", kind: "Connector", open: null },
    ],
    [
      "a session that is no file in the data folder",
      "(agent-session: codex/thread-9, observed 2026-11-16)",
      { summary: "Harness session", open: null },
    ],
    ["a short hand-written source", "slack", { text: "slack", summary: "slack", kind: null, observed: null, open: null }],
    ["a long hand-written source", "Told in the hallway by Nora after the planning meeting on Tuesday afternoon", { summary: null, kind: null, open: null }],
    ["a link written by hand", "https://example.com/minutes", { summary: "example.com", open: { kind: "url", url: "https://example.com/minutes" } }],
    ["a URL-looking word that is not one", "http://", { summary: "http://", open: null }],
  ])("%s", (_, text, expected) => {
    expect(parseSource(text)).toMatchObject(expected);
  });
});

const change = (over: Partial<RecentChangeView>): RecentChangeView => ({
  id: "c",
  relPath: "memory/projects/atlas.md",
  title: "Atlas",
  kind: "correct",
  subject: "Owner",
  oldValue: "Ada",
  newValue: "Grace",
  oldReview: null,
  newReview: null,
  reason: null,
  source: { harness: "claude-code", harnessLabel: "Claude Code", sessionId: "s", label: "Claude Code, session s", autoAccepted: false, consolidation: null },
  at: "2026-11-17T09:00:00Z",
  revertOf: null,
  revertedBy: null,
  revert: { allowed: true, reason: null },
  ...over,
});

describe("Recent saves filters", () => {
  const reviewed = change({ id: "reviewed" });
  const auto = change({ id: "auto", source: { ...reviewed.source, autoAccepted: true } });
  const consolidated = change({ id: "consolidated", source: { ...reviewed.source, autoAccepted: true, consolidation: { from: "meeting", capture: null } } });
  const reverted = change({ id: "reverted", revertedBy: "undo" });
  const undo = change({ id: "undo", revertOf: "reverted" });
  const all = [reviewed, auto, consolidated, reverted, undo];
  it.each([
    ["all", ["reviewed", "auto", "consolidated", "reverted", "undo"]],
    // Auto-accepted saves and Consolidation's writes reached the Brain without review.
    ["unreviewed", ["auto", "consolidated"]],
    // A reverted change, and the revert that undid it, so the pair reads together.
    ["reverted", ["reverted", "undo"]],
  ] as const)("%s", (filter, ids) => {
    expect(filterChanges(all, filter).map((c) => c.id)).toEqual(ids);
  });

  it.each([
    ["", "all"],
    ["?show=unreviewed", "unreviewed"],
    ["?show=reverted", "reverted"],
    ["?show=nonsense", "all"],
  ])("the address %j shows %s", (search, filter) => {
    expect(recentFilterAt(new URLSearchParams(search))).toBe(filter);
  });
});

describe("where a note lives in the Brain", () => {
  it.each([
    ["memory/people/priya-shah.md", "person"],
    ["memory/projects/atlas.md", "project"],
    ["memory/decisions/vendor.md", "decision"],
    ["memory/notes/idea.md", "note"],
    ["memory/self.md", null],
    ["evidence/captures/x.md", null],
  ])("%s is in %s", (relPath, collection) => {
    expect(collectionOf(relPath)).toBe(collection);
  });

  it.each([
    ["", { view: "library", collection: "person", root: "data", path: null, q: "" }],
    ["?tab=decision", { view: "library", collection: "decision", path: null }],
    // A note named without a collection opens in its own.
    ["?path=memory%2Fprojects%2Fatlas.md", { collection: "project", root: "data", path: "memory/projects/atlas.md" }],
    ["?tab=nonsense&path=memory%2Fnotes%2Fidea.md", { collection: "note" }],
    ["?q=%20Orion%20", { q: "Orion" }],
    ["?root=import%3Avault-1&path=Projects%2FOrion.md&tab=import", { collection: "import", root: "import:vault-1", path: "Projects/Orion.md" }],
  ])("/brain%s", (search, place) => {
    expect(brainPlace("/brain", new URLSearchParams(search))).toMatchObject(place);
  });

  it("Recent saves has its own address", () => {
    expect(brainPlace("/brain/recent", new URLSearchParams())).toMatchObject({ view: "recent" });
  });

  it.each([
    [{ view: "library" as const }, "/brain"],
    [{ view: "recent" as const }, "/brain/recent"],
    [{ view: "recent" as const, show: "reverted" as const }, "/brain/recent?show=reverted"],
    [{ view: "recent" as const, show: "all" as const }, "/brain/recent"],
    [{ view: "library" as const, collection: "decision" as const }, "/brain?tab=decision"],
    [{ view: "library" as const, collection: "person" as const, root: "data", path: "memory/people/a b.md", q: "Priya" }, "/brain?root=data&path=memory%2Fpeople%2Fa+b.md&tab=person&q=Priya"],
    [{ view: "library" as const, q: "  " }, "/brain"],
  ])("%j is at %s", (place, href) => {
    expect(brainHref(place)).toBe(href);
  });
});

const proposal = (over: Partial<ProposalView>): ProposalView => ({
  id: "p",
  status: "proposed",
  item: null,
  target: "memory/projects/atlas.md",
  reason: null,
  source: null,
  evidence: null,
  corrections: [],
  proposedBy: "model",
  createdAt: "2026-11-17T09:00:00Z",
  decidedAt: null,
  proposedOn: "Work Mac",
  decidedOn: null,
  ...over,
});

describe("a waiting Proposal for the note being read", () => {
  const list = [
    proposal({ id: "a" }),
    proposal({ id: "b", target: "memory/people/nora.md" }),
    proposal({ id: "c", status: "applied" }),
    proposal({ id: "d", target: "(new project: Atlas)" }),
    proposal({ id: "e" }),
  ];
  it("only the waiting ones that change this note", () => {
    expect(waitingProposalsFor("memory/projects/atlas.md", list).map((p) => p.id)).toEqual(["a", "e"]);
    expect(waitingProposalsFor("memory/projects/none.md", list)).toEqual([]);
  });

  it.each([
    [1, "A change to this note waits for your OK."],
    [2, "2 changes to this note wait for your OK."],
  ])("%i waiting: %s", (n, words) => {
    expect(waitingProposalWords(n)).toBe(words);
  });
});

describe("noteSections: the parts of a note the reader shows as stored", () => {
  const note = [
    "---",
    "type: project",
    "---",
    "# Atlas",
    "",
    "## Current State",
    "<!-- One entry per subject. -->",
    "- **Owner** (2026-11-17): Grace",
    "",
    "## Notes",
    "Met on the vendor call.",
    "",
    "- Prefers email.",
    "",
    "## History",
    "<!-- Append-only. Never edited. -->",
    '- 2026-11-17: **Owner** was "Ada" (handover)',
    "- 2026-11-18: Launch moved  (source: Claude Code)",
    "",
  ].join("\n");

  it("keeps History lines exactly, without their dash, and the Notes prose", () => {
    expect(noteSections(note)).toEqual({
      notes: "Met on the vendor call.\n\n- Prefers email.",
      history: ['2026-11-17: **Owner** was "Ada" (handover)', "2026-11-18: Launch moved  (source: Claude Code)"],
    });
  });

  it("a note with neither", () => {
    expect(noteSections("# Bare\n\n## Current State\n- **A** (2026-01-01): b\n")).toEqual({ notes: null, history: [] });
  });

  it("a heading written in another case still counts", () => {
    expect(noteSections("# X\n## notes\nSome words\n## history\n- one\n")).toEqual({ notes: "Some words", history: ["one"] });
  });
});
