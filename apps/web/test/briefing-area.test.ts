import { describe, expect, it } from "vitest";
import type { BriefingView } from "@attache/contracts";
import { areaState, entryTarget, leadWords, requestedShown, staleReadAt, todaysDaily } from "../src/briefing-area.ts";

const CPH = "Europe/Copenhagen";
const NOW = Date.parse("2026-11-18T12:00:00Z");

function briefing(over: Partial<BriefingView> = {}): BriefingView {
  return { id: "b1", kind: "daily", createdAt: "2026-11-18T07:00:00Z", since: null, summary: "Two deadlines.", sections: [], lead: null, topPicks: [], updates: [], coverage: [], counts: { open: 0, new: 0, changed: 0, drafts: 0, proposals: 0, failedSources: 0 }, deliverablePath: null, ...over };
}

describe("The Daily Briefing area", () => {
  it.each<[string, BriefingView | null, number, string, string | null]>([
    ["shows this morning's briefing all day", briefing(), NOW, CPH, "b1"],
    ["shows it until midnight in the browser's zone", briefing(), Date.parse("2026-11-18T22:59:00Z"), CPH, "b1"],
    ["drops it at midnight", briefing(), Date.parse("2026-11-18T23:00:00Z"), CPH, null],
    ["follows the browser to another zone, where it was written yesterday", briefing({ createdAt: "2026-11-18T03:00:00Z" }), Date.parse("2026-11-18T12:00:00Z"), "America/Los_Angeles", null],
    ["has nothing to show without a briefing", null, NOW, CPH, null],
  ])("%s", (_, daily, now, zone, expected) => {
    expect(todaysDaily(daily, now, zone)?.id ?? null).toBe(expected);
  });

  it.each<[string, Partial<BriefingView>, ReadonlySet<string>, number, boolean]>([
    ["shows an away summary just made", { kind: "away", createdAt: "2026-11-18T11:00:00Z" }, new Set(), NOW, true],
    ["keeps it until four hours after it was made", { kind: "manual", createdAt: "2026-11-18T08:00:01Z" }, new Set(), NOW, true],
    ["drops it four hours after it was made", { kind: "manual", createdAt: "2026-11-18T08:00:00Z" }, new Set(), NOW, false],
    ["drops it once Got it settled it", { kind: "away", createdAt: "2026-11-18T11:00:00Z" }, new Set(["briefing:b1"]), NOW, false],
  ])("%s", (_, over, settled, now, shown) => {
    expect(requestedShown(briefing(over), settled, now) !== null).toBe(shown);
  });

  it.each<[string, Parameters<typeof areaState>[0], string]>([
    ["switched off", { attentionOn: false, writing: false, failed: false, answered: false, daily: null, folded: false }, "off"],
    ["writing one", { attentionOn: true, writing: true, failed: false, answered: true, daily: null, folded: false }, "writing"],
    ["could not ask, and nothing known", { attentionOn: true, writing: false, failed: true, answered: false, daily: null, folded: false }, "failed"],
    ["still asking", { attentionOn: true, writing: false, failed: false, answered: false, daily: null, folded: false }, "checking"],
    ["none yet today", { attentionOn: true, writing: false, failed: false, answered: true, daily: null, folded: false }, "none"],
    ["folded by Got it", { attentionOn: true, writing: false, failed: false, answered: true, daily: briefing(), folded: true }, "folded"],
    ["the card", { attentionOn: true, writing: false, failed: false, answered: true, daily: briefing(), folded: false }, "card"],
  ])("is %s", (_, input, expected) => {
    expect(areaState(input)).toBe(expected);
  });

  it.each<[string, Parameters<typeof staleReadAt>[0], number | null]>([
    ["never read and failed: a failure, not stale", { failed: true, answeredAt: null }, null],
    ["read and fine", { failed: false, answeredAt: NOW }, null],
    ["read, then a later read failed: stale since that read", { failed: true, answeredAt: NOW }, NOW],
  ])("keeps what was read when %s", (_, input, expected) => {
    expect(staleReadAt(input)).toBe(expected);
  });

  it.each<[string, string, { kind: string; id: string }]>([
    ["an Inbox item to its row on Home", "item-1", { kind: "inbox", id: "item-1" }],
    ["a Draft waiting for review to its own page", "draft-1", { kind: "draft", id: "draft-1" }],
    ["a Proposal to Approvals", "proposal-1", { kind: "proposal", id: "proposal-1" }],
    ["a top pick in no section to its Inbox item", "item-9", { kind: "inbox", id: "item-9" }],
  ])("leads from %s", (_, id, expected) => {
    const row = (itemId: string) => ({ id: itemId, title: itemId, summary: "", url: null, isNew: false, changed: false });
    const sections = [
      { id: "deadlines", title: "Deadlines", items: [row("item-1")] },
      { id: "prepared", title: "Prepared for your review", items: [row("draft-1")] },
      { id: "memory", title: "Memory changes to review", items: [row("proposal-1")] },
    ];
    expect(entryTarget({ sections }, id)).toEqual(expected);
  });

  it("leads with the briefing's lead, or says nothing comes first when the Inbox was empty", () => {
    expect(leadWords(briefing({ lead: { itemId: "i1", headline: "Ship the fix", explanation: "Due at noon." } }))).toEqual({ headline: "Ship the fix", explanation: "Due at noon." });
    expect(leadWords(briefing())).toEqual({ headline: "Nothing needs you first", explanation: "Two deadlines." });
  });
});
