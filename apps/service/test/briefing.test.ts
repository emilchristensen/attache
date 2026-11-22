import { describe, expect, it } from "vitest";
import { BriefingViewSchema } from "@attache/contracts";
import { openDb } from "../src/core/db.ts";
import { applyModelWords, composeBriefing } from "../src/attention/briefing.ts";

function addItem(db: ReturnType<typeof openDb>, id: string, priority: number, words: { title?: string; summary?: string } = {}) {
  db.prepare(
    `insert into attention_items
      (id, item_key, fingerprint, kind, title, summary, why, source_kind, connection_id, evidence, priority, state, first_seen_at, updated_at)
     values (?, ?, ?, 'deadline', ?, ?, '', 'test', 'test', '[]', ?, 'open', ?, ?)`,
  ).run(id, `key:${id}`, `fingerprint:${id}`, words.title ?? `Title ${id}`, words.summary ?? `Summary ${id}`, priority, "2026-01-01T08:00:00.000Z", "2026-01-01T08:00:00.000Z");
}

/** Two open items, both new since the last briefing, so each is flagged for an update text. */
function twoNewItems() {
  const db = openDb(":memory:");
  addItem(db, "one", 90);
  addItem(db, "two", 80);
  return composeBriefing(db, { kind: "daily", since: "2025-12-31T00:00:00.000Z", coverage: [] });
}

const own = {
  lead: { itemId: "one", headline: "Title one", explanation: "Summary one" },
  updates: [
    { itemId: "one", headline: "Title one", text: "Summary one" },
    { itemId: "two", headline: "Title two", text: "Summary two" },
  ],
};

describe("Daily Briefing picks", () => {
  it("keeps the first five open Inbox items in service order, the first of them the lead", () => {
    const db = openDb(":memory:");
    for (const [id, priority] of [["six", 10], ["two", 80], ["one", 90], ["five", 30], ["four", 40], ["three", 50]] as Array<[string, number]>) addItem(db, id, priority);

    const briefing = composeBriefing(db, { kind: "daily", since: null, coverage: [] });

    expect(briefing.topPicks).toEqual(["one", "two", "three", "four", "five"]);
    expect(briefing.lead).toEqual({ itemId: "one", headline: "Title one", explanation: "Summary one" });
  });

  it("uses each item's own title and summary without a model, fitted to what the contract stores", () => {
    const db = openDb(":memory:");
    addItem(db, "long", 90, { title: `A\nheadline ${"x".repeat(200)}`, summary: "" });
    const briefing = composeBriefing(db, { kind: "daily", since: null, coverage: [] });

    expect(briefing.lead?.headline).toHaveLength(160);
    expect(briefing.lead?.headline.startsWith("A headline x")).toBe(true);
    expect(briefing.lead?.explanation).toBe(briefing.lead?.headline);
    expect(BriefingViewSchema.safeParse({ ...briefing, summary: "", deliverablePath: null }).success).toBe(true);
  });
});

describe("the model's words for a briefing", () => {
  it.each<[string, unknown, Partial<ReturnType<typeof applyModelWords>>]>([
    [
      "valid words replace the item's own, for the lead the rules chose",
      { summary: "Two deadlines.", lead: { headline: "Ship the invoice fix", explanation: "It is due first." }, updates: [{ itemId: "two", headline: "New deadline", text: "Two arrived today." }] },
      { summary: "Two deadlines.", lead: { itemId: "one", headline: "Ship the invoice fix", explanation: "It is due first." }, updates: [own.updates[0]!, { itemId: "two", headline: "New deadline", text: "Two arrived today." }], rejected: [] },
    ],
    [
      "a lead naming another item is still about the first pick: the model never chooses the lead",
      { summary: "Two deadlines.", lead: { itemId: "two", headline: "Look at two", explanation: "Two first." }, updates: [] },
      { lead: { itemId: "one", headline: "Look at two", explanation: "Two first." }, updates: own.updates },
    ],
    [
      "a numeric headline is rejected and the item's own words stand",
      { summary: "Two deadlines.", lead: { headline: 42, explanation: "Due first." }, updates: [] },
      { lead: own.lead, rejected: ["lead"] },
    ],
    [
      "an update for an item that does not resolve is dropped, and a missing one falls back",
      { summary: "Two deadlines.", lead: null, updates: [{ itemId: "missing", headline: "Invented", text: "Invented." }] },
      { lead: own.lead, updates: own.updates, rejected: ["update for missing"] },
    ],
    ["an answer that is not JSON keeps every word the items' own", "Here is your briefing!", { summary: null, lead: own.lead, updates: own.updates, rejected: ["not JSON"] }],
    ["a summary with no words is rejected", { summary: " ", lead: null, updates: [] }, { summary: null, rejected: ["summary"] }],
  ])("%s", (_, answer, expected) => {
    const base = twoNewItems();
    expect(base.lead).toEqual(own.lead);
    expect(base.updates).toEqual(own.updates);
    expect(applyModelWords(base, typeof answer === "string" ? answer : JSON.stringify(answer))).toMatchObject(expected);
  });
});
