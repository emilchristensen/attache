import { describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.ts";
import { composeBriefing, validateBriefingWords } from "../src/attention/briefing.ts";

function addItem(db: ReturnType<typeof openDb>, id: string, priority: number) {
  db.prepare(
    `insert into attention_items
      (id, item_key, fingerprint, kind, title, summary, why, source_kind, connection_id, evidence, priority, state, first_seen_at, updated_at)
     values (?, ?, ?, 'deadline', ?, ?, '', 'test', 'test', '[]', ?, 'open', ?, ?)`,
  ).run(id, `key:${id}`, `fingerprint:${id}`, `Title ${id}`, `Summary ${id}`, priority, "2026-01-01T08:00:00.000Z", "2026-01-01T08:00:00.000Z");
}

describe("Daily Briefing picks", () => {
  it("keeps the first five open Inbox items in service order", () => {
    const db = openDb(":memory:");
    for (const [id, priority] of [["six", 10], ["two", 80], ["one", 90], ["five", 30], ["four", 40], ["three", 50]] as Array<[string, number]>) addItem(db, id, priority);

    const briefing = composeBriefing(db, { kind: "daily", since: null, coverage: [] });

    expect(briefing.topPicks).toEqual(["one", "two", "three", "four", "five"]);
    expect(briefing.lead).toMatchObject({ itemId: "one", headline: "Title one", explanation: "Summary one" });
  });

  it("validates model words, drops unresolved items and falls back per item", () => {
    const db = openDb(":memory:");
    addItem(db, "one", 90);
    addItem(db, "two", 80);
    const base = composeBriefing(db, { kind: "daily", since: null, coverage: [] });

    const words = validateBriefingWords(base, {
      lead: { itemId: "missing", headline: "Invented", explanation: "Invented" },
      updates: [
        { itemId: "one", headline: "Useful headline", text: "Useful update." },
        { itemId: "missing", headline: "Invented", text: "Invented" },
      ],
    });

    expect(words.lead).toEqual({ itemId: "one", headline: "Title one", explanation: "Summary one" });
    expect(words.updates).toEqual([{ itemId: "one", headline: "Useful headline", text: "Useful update." }]);
  });
});
