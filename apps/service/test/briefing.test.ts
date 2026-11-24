import { describe, expect, it } from "vitest";
import { BRIEFING_HEADLINE_MAX, BRIEFING_TEXT_MAX, BriefingViewSchema } from "@attache/contracts";
import { openDb } from "../src/core/db.ts";
import { composeBriefing, deterministicSummary } from "../src/attention/briefing.ts";
import { applyModelWords, askForBriefingWords, BRIEFING_MODEL_UPDATES } from "../src/attention/briefing-words.ts";
import type { ModelProvider, StreamRequest } from "../src/models/providers.ts";

function addItem(db: ReturnType<typeof openDb>, id: string, priority: number, words: { title?: string; summary?: string } = {}, seenAt = "2026-01-01T08:00:00.000Z", kind = "deadline") {
  db.prepare(
    `insert into attention_items
      (id, item_key, fingerprint, kind, title, summary, why, source_kind, connection_id, evidence, priority, state, first_seen_at, updated_at)
     values (?, ?, ?, ?, ?, ?, '', 'test', 'test', '[]', ?, 'open', ?, ?)`,
  ).run(id, `key:${id}`, `fingerprint:${id}`, kind, words.title ?? `Title ${id}`, words.summary ?? `Summary ${id}`, priority, seenAt, seenAt);
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

describe("an away summary", () => {
  it("lists what is new or changed, and keeps an entry for the lead and every top pick so the page and the model have their words", () => {
    const db = openDb(":memory:");
    for (const [id, priority] of [["one", 90], ["two", 80], ["three", 70], ["four", 60], ["five", 50], ["quiet", 10]] as Array<[string, number]>) addItem(db, id, priority);
    addItem(db, "arrived", 20, {}, "2026-01-03T08:00:00.000Z");

    const away = composeBriefing(db, { kind: "away", since: "2026-01-02T00:00:00.000Z", coverage: [] });
    const entries = away.sections.flatMap((s) => s.items);

    expect(away.lead?.itemId).toBe("one");
    expect(away.topPicks).toEqual(["one", "two", "three", "four", "five"]);
    expect(entries.map((e) => e.id).sort()).toEqual(["arrived", "five", "four", "one", "three", "two"]);
    expect(entries.find((e) => e.id === "one")).toMatchObject({ title: "Title one", summary: "Summary one", isNew: false, changed: false });
    expect(entries.find((e) => e.id === "arrived")).toMatchObject({ isNew: true });
    expect(away.updates.map((u) => u.itemId)).toEqual(["arrived"]);
  });

  it("counts in its summary only what is new or changed, not the unchanged picks it keeps", () => {
    const db = openDb(":memory:");
    for (const [id, priority] of [["one", 90], ["two", 80], ["three", 70], ["four", 60], ["five", 50]] as Array<[string, number]>) addItem(db, id, priority);
    addItem(db, "arrived", 20, {}, "2026-01-03T08:00:00.000Z");

    const away = composeBriefing(db, { kind: "away", since: "2026-01-02T00:00:00.000Z", coverage: [] });

    expect(deterministicSummary(away)).toBe("1 deadline. 1 new and 0 changed since the time you gave.");
  });

  it("says nothing is new or changed when only unchanged items are open, never a bare full stop", () => {
    const db = openDb(":memory:");
    addItem(db, "one", 90);

    const away = composeBriefing(db, { kind: "away", since: "2026-01-02T00:00:00.000Z", coverage: [] });

    expect(deterministicSummary(away)).toBe("Nothing new or changed since the time you gave; 1 item is still open.");
  });

  it("counts a new item of the Other section, and never says nothing is new beside it", () => {
    const db = openDb(":memory:");
    addItem(db, "old", 90);
    addItem(db, "issue", 20, {}, "2026-01-03T08:00:00.000Z", "assigned_issue");

    const away = composeBriefing(db, { kind: "away", since: "2026-01-02T00:00:00.000Z", coverage: [] });

    expect(deterministicSummary(away)).toBe("1 other item. 1 new and 0 changed since the time you gave.");
  });
});

describe("a Daily Briefing's summary", () => {
  it("counts items of the Other section like every other section", () => {
    const db = openDb(":memory:");
    addItem(db, "pr", 90, {}, undefined, "authored_pr");
    addItem(db, "issue", 80, {}, undefined, "assigned_issue");

    const daily = composeBriefing(db, { kind: "daily", since: null, coverage: [] });

    expect(deterministicSummary(daily)).toBe("2 other items.");
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

  it("reads an answer in a code fence, one part per line, and a part that fails never discards the others", () => {
    const base = twoNewItems();
    const lines = [
      JSON.stringify({ summary: "Two deadlines." }),
      JSON.stringify({ lead: { headline: "Ship the invoice fix", explanation: "It is due first." } }),
      JSON.stringify({ update: { itemId: "one", headline: "New deadline", text: "One arrived today." } }),
      '{"update": {"itemId": "two", "headline": "Cut off mid',
    ];
    const words = applyModelWords(base, `\`\`\`json\n${lines.join("\n")}\n\`\`\``);
    expect(words).toMatchObject({
      summary: "Two deadlines.",
      lead: { itemId: "one", headline: "Ship the invoice fix", explanation: "It is due first." },
      updates: [{ itemId: "one", headline: "New deadline", text: "One arrived today." }, own.updates[1]],
      rejected: ["unreadable line"],
    });
  });
});

/**
 * A model that writes every part the prompt asks for, at full length, one JSON object per line, and stops at its token
 * limit as a real one does (about four characters a token).
 */
function longWindedModel(): ModelProvider & { asked: StreamRequest[] } {
  const asked: StreamRequest[] = [];
  const long = (n: number) => "word ".repeat(n / 5).trim();
  return {
    id: "openai-compatible",
    model: "fixture",
    asked,
    async *stream(req) {
      asked.push(req);
      const prompt = req.messages[0]!.content;
      const updates = [...(prompt.split("exactly these items:")[1] ?? "").matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]!);
      const answer = [
        JSON.stringify({ summary: long(400) }),
        JSON.stringify({ lead: { headline: long(BRIEFING_HEADLINE_MAX), explanation: long(BRIEFING_TEXT_MAX) } }),
        ...updates.map((itemId) => JSON.stringify({ update: { itemId, headline: long(BRIEFING_HEADLINE_MAX), text: long(BRIEFING_TEXT_MAX) } })),
      ].join("\n");
      const limit = (req.maxTokens ?? Infinity) * 4;
      yield answer.slice(0, limit);
      return { cutOff: answer.length > limit };
    },
  };
}

describe("asking the model for a briefing's words", () => {
  it("on a busy day with a dozen flagged items, asks for a bounded number of updates with room to write them all", async () => {
    const db = openDb(":memory:");
    for (let n = 0; n < 12; n++) addItem(db, `item-${String(n).padStart(2, "0")}`, 100 - n);
    const base = composeBriefing(db, { kind: "daily", since: "2025-12-31T00:00:00.000Z", coverage: [] });
    expect(base.updates).toHaveLength(12);
    const model = longWindedModel();

    const words = applyModelWords(base, await askForBriefingWords(model, base));

    expect(words.rejected).toEqual([]);
    expect(words.summary).toMatch(/^word/);
    expect(words.lead?.headline).toMatch(/^word/);
    const asked = base.updates.slice(0, BRIEFING_MODEL_UPDATES).map((u) => u.itemId);
    expect(words.updates.filter((u) => u.headline.startsWith("word")).map((u) => u.itemId)).toEqual(asked);
    // The rest keep each item's own words.
    expect(words.updates.slice(BRIEFING_MODEL_UPDATES)).toEqual(base.updates.slice(BRIEFING_MODEL_UPDATES));
  });
});
