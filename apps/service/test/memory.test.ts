import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/core/db.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { search, queryTerms } from "../src/memory/search.ts";
import { assertWritable, PolicyError } from "../src/memory/policy.ts";
import { tempDir } from "./helpers.ts";

function setup() {
  const db = openDb(":memory:");
  const store = new MemoryStore(db, null, "test");
  const root = tempDir();
  store.open(root);
  return { db, store, root };
}

describe("memory store and retrieval", () => {
  it("retrieves a source-linked decision with exact line evidence", () => {
    const { db, store, root } = setup();
    const cap = store.capture({ text: "We agreed the Atlas launch moves to 14 October because QA found blocking issues.", title: "Atlas sync notes", source: { kind: "user", ref: "meeting", observedAt: "2026-09-29T10:00:00Z" } });
    const { relPath } = store.recordDecision({ title: "Atlas launch date", decision: "Launch Atlas on 14 October", source: { kind: "capture", ref: cap.relPath, observedAt: "2026-09-29T10:00:00Z" } });
    const hits = search(db, "When does Atlas launch?");
    expect(hits[0]?.relPath).toBe(relPath);
    const hit = hits[0]!;
    const lines = readFileSync(join(root, relPath), "utf8").split("\n").slice(hit.startLine - 1, hit.endLine).join("\n");
    expect(lines).toContain("Launch Atlas on 14 October");
    expect(hit.section).toBe("state");
  });

  it("a correction replaces current state, keeps history, and changes the next retrieval", () => {
    const { db, store, root } = setup();
    const { relPath } = store.recordDecision({ title: "Atlas launch date", decision: "Launch Atlas on 14 October", source: { kind: "user", ref: "chat", observedAt: "2026-09-29T10:00:00Z" } });
    store.correct(relPath, { subject: "Decision", value: "Launch Atlas on 21 October", reason: "QA slipped a week" }, "user");
    const text = readFileSync(join(root, relPath), "utf8");
    const current = text.split("## History")[0]!;
    expect(current).toContain("21 October");
    expect(current).not.toContain("14 October");
    expect(text.split("## History")[1]).toMatch(/was "Launch Atlas on 14 October".*QA slipped a week/);
    const hits = search(db, "Atlas launch date");
    expect(hits[0]!.section).toBe("state");
    expect(hits[0]!.text).toContain("21 October");
    const history = hits.find((h) => h.section === "history");
    if (history) expect(history.score).toBeLessThan(hits[0]!.score);
    expect(store.listChanges({ relPath })[0]).toMatchObject({ change: "correct", beforeValue: "Launch Atlas on 14 October", afterValue: "Launch Atlas on 21 October" });
  });

  it("quotes FTS operators so hostile queries cannot break or widen search", () => {
    const { db, store } = setup();
    store.createMemory({ type: "note", title: "Vendor", state: [{ subject: "Status", value: "Contract renewed" }] }, "user");
    expect(() => search(db, 'contract" OR * NEAR( NOT')).not.toThrow();
    expect(queryTerms('title:secret NEAR "x"')).toEqual(["title", "secret", "near"]);
  });

  it("enforces write policy by actor and protects identity", () => {
    expect(() => assertWritable("memory/notes/x.md", "model")).toThrow(PolicyError);
    expect(() => assertWritable("memory/notes/x.md", "connector")).toThrow(PolicyError);
    expect(() => assertWritable("evidence/connectors/x.md", "connector")).not.toThrow();
    expect(() => assertWritable("memory/self.md", "user")).toThrow(/protected/);
    expect(() => assertWritable("memory/self.md", "user", { confirmedProtected: true })).not.toThrow();
    expect(() => assertWritable("../outside.md", "user")).toThrow(PolicyError);
    expect(() => assertWritable("memory/notes/x.sh", "user")).toThrow(PolicyError);
  });

  it("refuses to write through a symlink that leaves the data folder", () => {
    const { store, root } = setup();
    const outside = tempDir("jarvis-outside-");
    symlinkSync(outside, join(root, "memory", "escape"));
    expect(() => store.createMemory({ type: "note", title: "x", state: [] }, "user")).not.toThrow();
    expect(() => (store as unknown as { writeFile: (r: string, c: string, a: string) => void }).writeFile("memory/escape/evil.md", "x", "user")).toThrow(/escapes/);
  });

  it("picks up edits made outside Jarvis on rescan and drops deleted files", () => {
    const { db, store, root } = setup();
    mkdirSync(join(root, "memory", "notes"), { recursive: true });
    writeFileSync(join(root, "memory/notes/manual.md"), "# Manual\n\nThe espresso machine descaling is due Friday.\n");
    const r = store.indexer.scan(store.rootRef!);
    expect(r.indexed).toBeGreaterThanOrEqual(1);
    expect(search(db, "espresso descaling")[0]?.relPath).toBe("memory/notes/manual.md");
  });
});
