import { describe, expect, it } from "vitest";
import type { MeaningStatus } from "@attache/contracts";
import { brainResultsHref, hitDestination, hitKind, hitPlace, moveActive, rankingLine, searchPath, type SearchHit } from "../src/search.ts";
import { isSearchChord, searchKeyLabel } from "../src/search-keys.ts";

const hit = (over: Partial<SearchHit> = {}): SearchHit => ({
  chunkId: 1,
  root: "data",
  relPath: "memory/projects/orion.md",
  area: "memory",
  docType: "project",
  title: "Orion",
  heading: null,
  section: "body",
  startLine: 12,
  endLine: 18,
  snippet: "Send the cutover plan to finance",
  review: null,
  unverified: false,
  ...over,
});

const meaning = (over: Partial<MeaningStatus> = {}): MeaningStatus => ({
  state: "missing",
  ranking: "keywords",
  model: { name: "m", bytes: 1 },
  download: null,
  vectors: { chunks: 10, embedded: 0 },
  error: null,
  ...over,
});

describe("searchPath", () => {
  it("asks for at most six passages of the trimmed query, leaving raw transcripts out", () => {
    expect(searchPath("  Orion cutover ", 6)).toBe("/memory/search?q=Orion%20cutover&limit=6&recall=1");
  });
});

describe("brainResultsHref", () => {
  it("carries the query to the Brain screen's address", () => {
    expect(brainResultsHref("Orion & co")).toBe("/brain?q=Orion%20%26%20co");
  });

  it("opens the Brain without a query when there is none", () => {
    expect(brainResultsHref("   ")).toBe("/brain");
  });
});

describe("hitDestination", () => {
  it("opens a memory note in the Brain, keeping the query", () => {
    expect(hitDestination(hit(), "Orion")).toEqual({ kind: "brain", href: "/brain?root=data&path=memory%2Fprojects%2Forion.md&q=Orion" });
  });

  it("opens anything else in the evidence view at the cited lines", () => {
    const h = hit({ relPath: "Projects/Orion.md", root: "vault", area: "import", docType: null });
    expect(hitDestination(h, "Orion")).toEqual({ kind: "evidence", target: { root: "vault", relPath: "Projects/Orion.md", lines: [12, 18], title: "Orion" } });
  });

  it("treats evidence and deliverables in the data folder as evidence", () => {
    expect(hitDestination(hit({ relPath: "evidence/sessions/2026-11-18.md", area: "evidence", docType: null }), "x").kind).toBe("evidence");
    expect(hitDestination(hit({ relPath: "deliverables/plan.md", area: "deliverables", docType: null }), "x").kind).toBe("evidence");
  });
});

describe("hitKind", () => {
  it.each([
    ["person", "memory", "Person"],
    ["project", "memory", "Project"],
    ["decision", "memory", "Decision"],
    ["note", "memory", "Note"],
    [null, "memory", "Note"],
    [null, "import", "Imported"],
    [null, "evidence", "Evidence"],
    [null, "deliverables", "Deliverable"],
  ] as const)("names a %s in %s as %s", (docType, area, word) => {
    expect(hitKind(hit({ docType, area })).kind).toBe(word);
  });

  it("names the part of a note the passage comes from, except its body", () => {
    expect(hitKind(hit({ section: "state" })).section).toBe("Current state");
    expect(hitKind(hit({ section: "history" })).section).toBe("History");
    expect(hitKind(hit({ section: "body" })).section).toBeNull();
  });
});

describe("hitPlace", () => {
  it("gives the file and the cited lines", () => {
    expect(hitPlace(hit())).toBe("memory/projects/orion.md:12-18");
  });

  it("gives one line once", () => {
    expect(hitPlace(hit({ startLine: 7, endLine: 7 }))).toBe("memory/projects/orion.md:7");
  });

  it("names the folder of a file outside the data folder", () => {
    expect(hitPlace(hit({ root: "vault", relPath: "Projects/Orion.md" }))).toBe("vault › Projects/Orion.md:12-18");
  });
});

describe("rankingLine", () => {
  it("says results are ranked by meaning and keywords once the model is ready", () => {
    expect(rankingLine(meaning({ state: "ready", ranking: "meaning", vectors: { chunks: 10, embedded: 10 } }))).toEqual({ ranking: "meaning", text: "Ranked by meaning and keywords." });
  });

  it.each([
    [meaning({ state: "missing" }), "the meaning model is not downloaded"],
    [meaning({ state: "downloading" }), "the meaning model is downloading"],
    [meaning({ state: "failed", error: "disk full" }), "meaning-based search stopped with an error"],
    [meaning({ state: "building", vectors: { chunks: 10, embedded: 4 } }), "search vectors are being built (4 of 10)"],
  ])("says why it ranks by keywords only", (status, reason) => {
    expect(rankingLine(status)).toEqual({ ranking: "keywords", text: "Ranked by keywords only", reason });
  });

  it("trusts the service's ranking over a stale state", () => {
    expect(rankingLine(meaning({ state: "building", ranking: "meaning" })).ranking).toBe("meaning");
  });
});

describe("moveActive", () => {
  it("moves down and up through the results, wrapping round", () => {
    expect(moveActive(0, 6, "ArrowDown")).toBe(1);
    expect(moveActive(5, 6, "ArrowDown")).toBe(0);
    expect(moveActive(0, 6, "ArrowUp")).toBe(5);
    expect(moveActive(-1, 6, "ArrowDown")).toBe(0);
    expect(moveActive(-1, 6, "ArrowUp")).toBe(5);
  });

  it("chooses nothing when there is nothing to choose", () => {
    expect(moveActive(-1, 0, "ArrowDown")).toBe(-1);
  });
});

describe("isSearchChord", () => {
  const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

  it("is Ctrl K or Cmd K", () => {
    expect(isSearchChord(key("k", { ctrlKey: true }))).toBe(true);
    expect(isSearchChord(key("K", { metaKey: true }))).toBe(true);
  });

  it("is not K alone or with other modifiers", () => {
    expect(isSearchChord(key("k"))).toBe(false);
    expect(isSearchChord(key("k", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isSearchChord(key("k", { ctrlKey: true, altKey: true }))).toBe(false);
  });
});

describe("searchKeyLabel", () => {
  it("shows Cmd K on Apple systems and Ctrl K elsewhere", () => {
    expect(searchKeyLabel("MacIntel")).toBe("⌘ K");
    expect(searchKeyLabel("iPad")).toBe("⌘ K");
    expect(searchKeyLabel("Linux x86_64")).toBe("Ctrl K");
    expect(searchKeyLabel("Win32")).toBe("Ctrl K");
  });
});
