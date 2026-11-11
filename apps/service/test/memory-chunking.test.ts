import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS, openDb } from "../src/core/db.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { documentBlocks, search } from "../src/memory/search.ts";
import { splitLong } from "../src/memory/chunker.ts";
import { MAX_EVIDENCE_CHARS, renderEvidence } from "../src/conversation/service.ts";
import { tempDir } from "./helpers.ts";

function setup() {
  const db = openDb(":memory:");
  const store = new MemoryStore(db, null, { instance: "test", locksDir: tempDir(), machine: () => ({ id: "00000000-0000-4000-8000-000000000001", name: "Test Machine" }) });
  const root = tempDir();
  store.open(root);
  return { db, store, root };
}

const linesOf = (root: string, rel: string, from: number, to: number) => readFileSync(join(root, rel), "utf8").split("\n").slice(from - 1, to).join("\n");

/** A project note with many long facts, like a real one: its Current State is far longer than one evidence block. */
function bigProject(store: MemoryStore) {
  const filler = "Background that makes this entry long enough to push later entries far down the section. ".repeat(3).trim();
  const state = Array.from({ length: 30 }, (_, i) => ({ subject: `Topic ${i + 1}`, value: `${filler} Detail number ${i + 1}.` }));
  state[24] = { subject: "Pilot customer", value: "The pilot customer is Quillfeather Energy, signed for a three month trial." };
  return store.createMemory({ type: "project", title: "Larkspur Outreach", state, sources: [{ kind: "import", ref: "evidence/archive/oldvault/zebrafile.md", observedAt: "2026-08-01T00:00:00Z", label: "Old vault zebrafile.md" }] }, "user");
}

describe("recall retrieves single facts", () => {
  it("returns the one fact that answers, cited at its own line, however long the note is", () => {
    const { db, store, root } = setup();
    const { relPath } = bigProject(store);
    const hit = search(db, "Who is the Larkspur pilot customer?")[0]!;
    expect(hit.relPath).toBe(relPath);
    expect(hit.section).toBe("state");
    expect(hit.startLine).toBe(hit.endLine);
    expect(linesOf(root, relPath, hit.startLine, hit.endLine)).toContain("Quillfeather Energy");
    expect(hit.text).toContain("Quillfeather Energy");
    expect(hit.text).not.toContain("Detail number 1.");
    expect(hit.snippet).toContain("Quillfeather");
    // The whole fact reaches the model: nothing is cut off by the evidence size limit.
    expect(hit.text.length).toBeLessThan(MAX_EVIDENCE_CHARS);
    expect(renderEvidence([hit], null)).toContain("Quillfeather Energy");
  });

  it("keeps a fact's source in the cited text but does not match queries on it", () => {
    const { db, store } = setup();
    bigProject(store);
    const stateHits = search(db, "zebrafile", { limit: 30 }).filter((h) => h.section === "state");
    expect(stateHits).toEqual([]);
    const fact = search(db, "Quillfeather")[0]!;
    expect(fact.text).toContain("zebrafile.md");
  });

  it("does not let one long note crowd every other source out of the results", () => {
    const { db, store } = setup();
    bigProject(store);
    store.capture({ text: "Larkspur Outreach kickoff: the team agreed on weekly demos.", title: "Larkspur kickoff", source: { kind: "user", ref: "meeting", observedAt: "2026-09-01T10:00:00Z" } });
    const hits = search(db, "Larkspur Outreach", { limit: 8 });
    expect(hits).toHaveLength(8);
    expect(hits.some((h) => h.area === "evidence")).toBe(true);
    // With nothing else to show, a single note may still fill the list.
    expect(search(db, "Detail number", { limit: 8 })).toHaveLength(8);
  });

  it("keeps hand-written prose and indented sub-points under Current State searchable", () => {
    const { db, root, store } = setup();
    mkdirSync(join(root, "memory/notes"), { recursive: true });
    const rel = "memory/notes/hand.md";
    writeFileSync(
      join(root, rel),
      ["---", "type: note", "title: Hand edited", "---", "# Hand edited", "", "## Current State", "A sentence typed in Obsidian about marmalade.", "- **Owner** (2026-10-01): Priya", "  - deputy is Tobias", "- **Status** (2026-10-02): paused", "", "## History", "- 2026-10-01 — created"].join("\n"),
    );
    store.indexer.indexFile(store.rootRef!, rel);
    expect(search(db, "marmalade")[0]).toMatchObject({ relPath: rel, startLine: 8, endLine: 8 });
    const owner = search(db, "deputy Tobias")[0]!;
    expect(owner).toMatchObject({ relPath: rel, startLine: 9, endLine: 10, section: "state" });
    expect(owner.text).toContain("Priya");
    expect(search(db, "paused")[0]).toMatchObject({ startLine: 11, endLine: 11 });
  });
});

describe("splitting long text", () => {
  it("cuts a long list without blank lines into narrow pieces with exact line ranges", () => {
    const { db, root, store } = setup();
    const rel = "evidence/captures/transcript.md";
    const body = Array.from({ length: 400 }, (_, i) => `- speaker said something fairly ordinary on line ${i + 1}${i === 299 ? " about the heliotrope budget" : ""}`);
    writeFileSync(join(root, rel), ["# Transcript", "", ...body].join("\n"));
    store.indexer.indexFile(store.rootRef!, rel);
    const hit = search(db, "heliotrope")[0]!;
    expect(hit.text.length).toBeLessThanOrEqual(2400);
    expect(hit.endLine - hit.startLine).toBeLessThan(60);
    expect(linesOf(root, rel, hit.startLine, hit.endLine)).toContain("heliotrope budget");
    expect(linesOf(root, rel, hit.startLine, hit.endLine)).toBe(hit.text);
  });

  it("never exceeds the hard limit when the text has no pause at all, and keeps ranges contiguous", () => {
    const text = Array.from({ length: 200 }, (_, i) => `word${i} `.repeat(12).trim()).join("\n");
    const pieces = splitLong(text, 10);
    expect(pieces.length).toBeGreaterThan(5);
    expect(Math.max(...pieces.map((p) => p.text.length))).toBeLessThanOrEqual(2400);
    expect(pieces[0]!.startLine).toBe(10);
    pieces.slice(1).forEach((p, i) => expect(p.startLine).toBe(pieces[i]!.endLine + 1));
    expect(pieces.at(-1)!.endLine).toBe(209);
    expect(pieces.map((p) => p.text).join("\n")).toBe(text);
  });

  it("keeps short sections as one piece and does not split inside a code fence at a list marker", () => {
    expect(splitLong("one\n\ntwo", 1)).toEqual([{ text: "one\n\ntwo", startLine: 1, endLine: 3 }]);
    const fence = ["```", ...Array.from({ length: 40 }, (_, i) => `- yaml item ${i} ${"x".repeat(30)}`), "```"].join("\n");
    expect(splitLong(fence, 1)).toHaveLength(1);
  });
});

describe("a note opened as conversation context", () => {
  it("is passed as whole sections, current state first, not as its first few facts", () => {
    const { db, store } = setup();
    const { relPath } = store.createMemory({ type: "project", title: "Juniper", state: Array.from({ length: 12 }, (_, i) => ({ subject: `Fact ${i + 1}`, value: `value ${i + 1}` })), notes: "Free text about Juniper." }, "user");
    const blocks = documentBlocks(db, "data", relPath);
    expect(blocks.map((b) => b.section)).toEqual(["state", "body", "history"]);
    expect(blocks[0]!.text).toContain("value 1");
    expect(blocks[0]!.text).toContain("value 12");
    expect(blocks[0]!.endLine - blocks[0]!.startLine).toBe(11);
    expect(blocks[1]!.text).toContain("Free text about Juniper.");
  });
});

describe("upgrading an index built by an earlier version", () => {
  it("re-chunks every document on the next scan", () => {
    const { db, store } = setup();
    bigProject(store);
    store.indexer.scan(store.rootRef!);
    expect(store.indexer.scan(store.rootRef!).indexed).toBe(0);
    // Replay the migration that invalidates the index, as an upgrade from the version before it would.
    const reindex = MIGRATIONS.findIndex((m) => m.includes("update documents set hash = ''"));
    expect(reindex).toBeGreaterThan(0);
    db.exec(MIGRATIONS[reindex]!);
    const rescanned = store.indexer.scan(store.rootRef!);
    expect(rescanned.indexed).toBeGreaterThan(0);
    expect(rescanned.unchanged).toBe(0);
    expect(search(db, "Quillfeather")[0]!.section).toBe("state");
  });
});
