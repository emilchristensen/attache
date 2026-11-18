import { describe, expect, it } from "vitest";
import { frozenList, groupRows, ordered, PAGE_SIZE, pageLabel, PREVIEWS, typeOptions, withType, type ViewItem } from "../src/inbox-view.ts";

// The Inbox list's rules: order, the frozen snapshot and its arrivals, pages, the type picker and Group by type.

function it_(id: string, extra: Partial<ViewItem> = {}): ViewItem {
  return { id, key: `key-${id}`, kind: "deadline", sourceKind: "vault", priority: 50, dueAt: null, firstSeenAt: "2026-11-18T08:00:00Z", ...extra };
}

const ids = (rows: readonly ViewItem[]) => rows.map((r) => r.id);

describe("the default order", () => {
  it("is service priority, highest first", () => {
    expect(ids(ordered([it_("a", { priority: 40 }), it_("b", { priority: 90 }), it_("c", { priority: 60 })], "priority"))).toEqual(["b", "c", "a"]);
  });

  it("breaks a tie by the earliest due instant, undated last", () => {
    const rows = [it_("undated"), it_("later", { dueAt: "2026-11-25" }), it_("sooner", { dueAt: "2026-11-19" }), it_("today-noon", { dueAt: "2026-11-18T12:00:00Z" })];
    expect(ids(ordered(rows, "priority"))).toEqual(["today-noon", "sooner", "later", "undated"]);
  });

  it("then by the stable item key", () => {
    expect(ids(ordered([it_("b", { key: "k2" }), it_("a", { key: "k1" }), it_("c", { key: "k3" })], "priority"))).toEqual(["a", "b", "c"]);
  });
});

describe("Newest first", () => {
  it("orders by when Attache first saw the item, newest first, then the key", () => {
    const rows = [
      it_("old", { firstSeenAt: "2026-11-10T08:00:00Z", priority: 90 }),
      it_("new", { firstSeenAt: "2026-11-18T09:00:00Z" }),
      it_("tie-b", { key: "b", firstSeenAt: "2026-11-17T08:00:00Z" }),
      it_("tie-a", { key: "a", firstSeenAt: "2026-11-17T08:00:00Z" }),
    ];
    expect(ids(ordered(rows, "newest"))).toEqual(["new", "tie-a", "tie-b", "old"]);
  });
});

describe("the frozen snapshot", () => {
  it("keeps the shown order when priorities change, with each row's new data", () => {
    const live = [it_("a", { priority: 10, kind: "mention" }), it_("b", { priority: 90 })];
    const list = frozenList(["a", "b"], live, "priority");
    expect(ids(list.rows)).toEqual(["a", "b"]);
    expect(list.rows[0]!.kind).toBe("mention");
  });

  it("holds new items back as arrivals, in the view's order", () => {
    const live = [it_("a"), it_("new-low", { priority: 20 }), it_("new-high", { priority: 95 })];
    const list = frozenList(["a"], live, "priority");
    expect(ids(list.rows)).toEqual(["a"]);
    expect(ids(list.arrivals)).toEqual(["new-high", "new-low"]);
  });

  it("lets an item the owner brought back here into its place by order, without moving the rest", () => {
    const live = [it_("a", { priority: 10 }), it_("b", { priority: 90 }), it_("back", { priority: 50 }), it_("new", { priority: 99 })];
    const list = frozenList(["a", "b"], live, "priority", new Set(["back"]));
    // "a" and "b" keep their shown order even though "b" now ranks higher; "back" goes before the first row it outranks.
    expect(ids(list.rows)).toEqual(["back", "a", "b"]);
    expect(ids(list.arrivals)).toEqual(["new"]);
    expect(list.snapshot).toEqual(["back", "a", "b"]);
  });

  it("names the rows that left the list, so a decided row can stay in its place", () => {
    expect(frozenList(["a", "b", "c"], [it_("a"), it_("c")], "priority").gone).toEqual(["b"]);
  });
});

describe("the type picker", () => {
  const rows = [
    it_("r1", { kind: "review_request", sourceKind: "github" }),
    it_("r2", { kind: "review_request", sourceKind: "github" }),
    it_("g", { kind: "pending_reply", sourceKind: "gmail" }),
    it_("s", { kind: "pending_reply", sourceKind: "slack" }),
    it_("d", { kind: "deadline" }),
    it_("x", { kind: "calendar_event", sourceKind: "gcal" }),
  ];

  it("offers All types, then each type present with its count, in family order", () => {
    expect(typeOptions(rows)).toEqual([
      { id: "all", label: "All types", count: 6 },
      { id: "deadline", label: "Deadline", count: 1 },
      { id: "review_request", label: "Review request", count: 2 },
      { id: "pending_reply", label: "Pending reply", count: 1 },
      { id: "slack_dm", label: "Slack DM", count: 1 },
      { id: "calendar_event", label: "Calendar event", count: 1 },
    ]);
  });

  it("keeps a chosen type that has no items left, at zero", () => {
    expect(typeOptions(rows.slice(0, 2), "deadline")).toContainEqual({ id: "deadline", label: "Deadline", count: 0 });
  });

  it("filters to one type", () => {
    expect(ids(withType(rows, "slack_dm"))).toEqual(["s"]);
    expect(ids(withType(rows, "all"))).toEqual(ids(rows));
  });
});

describe("pages", () => {
  it("shows twenty rows at a time", () => {
    expect(PAGE_SIZE).toBe(20);
  });

  it("says which rows are visible out of how many", () => {
    expect(pageLabel(20, 34)).toBe("1–20 of 34");
    expect(pageLabel(34, 34)).toBe("All 34");
    expect(pageLabel(1, 1)).toBe("All 1");
  });
});

describe("Group by type", () => {
  const rows = [
    it_("m1", { kind: "mention", sourceKind: "slack" }),
    it_("d1", { kind: "deadline" }),
    it_("x1", { kind: "brand_new" }),
    it_("d2", { kind: "deadline" }),
    it_("d3", { kind: "deadline" }),
    it_("d4", { kind: "deadline" }),
    it_("r1", { kind: "review_request", sourceKind: "github" }),
  ];

  it("orders families as Deadlines, Reviews, Replies, Mentions, Meetings, Work items, Facts to check, System and Other", () => {
    expect(groupRows(rows, new Set()).map((g) => g.label)).toEqual(["Deadlines", "Reviews", "Mentions", "Other"]);
  });

  it("previews three rows per family, keeping the list's order, with how many more Show all reveals", () => {
    const deadlines = groupRows(rows, new Set())[0]!;
    expect(PREVIEWS).toBe(3);
    expect(ids(deadlines.rows)).toEqual(["d1", "d2", "d3"]);
    expect(deadlines.total).toBe(4);
    expect(deadlines.hidden).toBe(1);
  });

  it("shows every row of a family after Show all", () => {
    const deadlines = groupRows(rows, new Set(["deadlines"]))[0]!;
    expect(ids(deadlines.rows)).toEqual(["d1", "d2", "d3", "d4"]);
    expect(deadlines.hidden).toBe(0);
  });
});
