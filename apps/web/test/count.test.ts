import { describe, expect, it } from "vitest";
import type { ActionStatus, ConnectionStatus, DecisionTotals } from "@attache/contracts";
import { countDecisions as countFrom, dotAfter, homeLine, refreshAnnouncement, shownCount, spokenCount, tabTitle, withRows, type Answer, type CountInputs, type Tally, type Totals } from "../src/count.ts";

/** Answers as the Dashboard gets them. */
const rows = <T>(list: T[], limit: number | null = 100): Answer<T> => ({ kind: "rows", rows: list, limit });
const failed = { kind: "failed" } as const;
const waiting = { kind: "waiting" } as const;
const off = { kind: "off" } as const;

let nextId = 0;
/** An open Inbox item, optionally with its Draft's status. */
const item = (actionStatus: ActionStatus | null = null, kind = "review_request") => ({ id: `item-${++nextId}`, kind, actionStatus });
const items = (n: number, actionStatus: ActionStatus | null = null) => Array.from({ length: n }, () => item(actionStatus));
const draft = (status: ActionStatus) => ({ status });
const proposals = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}` }));
const connection = (status: ConnectionStatus["status"]) => ({ status });

/** Nothing waits, every source answered. */
const quiet: CountInputs = { inbox: rows([], 200), proposals: rows([]), drafts: rows([]), connections: rows([], null) };

/** The count route's answer. */
const totals = (t: DecisionTotals): Totals => ({ kind: "totals", totals: t });
/** The count as the lists alone give it: the count route failed, so the module falls back to them. */
const countDecisions = (lists: CountInputs) => countFrom(failed, lists);
/** The lists at their limits: what they would say on their own is a lower bound. */
const fullLists: CountInputs = {
  inbox: rows(items(200), 200),
  proposals: rows(proposals(100), 100),
  drafts: rows(Array.from({ length: 100 }, () => draft("draft")), 100),
  connections: rows([connection("needs_auth")], null),
};

/** What a tally reads as: "6", "4+", or "-" for no number, then whether it is exact. */
const read = (t: Tally) => `${shownCount(t) ?? "-"}${t.exact ? " exact" : ""}`;

describe("countDecisions from the count route", () => {
  it.each<[string, Totals, CountInputs, { total: string; home: string; approvals: string; connections: string }]>([
    [
      "exact above every list limit",
      totals({ inbox: 230, drafts: 102, proposals: 101, signIns: 1 }),
      fullLists,
      { total: "434 exact", home: "230 exact", approvals: "203 exact", connections: "1 exact" },
    ],
    [
      "the route's totals win over lists that say otherwise: the Drafts are already left out of the Inbox part",
      totals({ inbox: 2, drafts: 2, proposals: 1, signIns: 0 }),
      { inbox: rows([...items(2), ...items(2, "draft")], 200), proposals: rows(proposals(1)), drafts: failed, connections: waiting },
      { total: "5 exact", home: "2 exact", approvals: "3 exact", connections: "- exact" },
    ],
    [
      "nothing waits: an exact zero",
      totals({ inbox: 0, drafts: 0, proposals: 0, signIns: 0 }),
      fullLists,
      { total: "- exact", home: "- exact", approvals: "- exact", connections: "- exact" },
    ],
    [
      "Attention and briefings off: Home is off, the rest still count exactly",
      totals({ inbox: "off", drafts: 1, proposals: 1, signIns: 0 }),
      fullLists,
      { total: "2 exact", home: "- exact", approvals: "2 exact", connections: "- exact" },
    ],
    [
      "Drafts and approvals off: the Drafts half of Approvals is off",
      totals({ inbox: 3, drafts: "off", proposals: 1, signIns: 2 }),
      fullLists,
      { total: "6 exact", home: "3 exact", approvals: "1 exact", connections: "2 exact" },
    ],
    [
      "first load: no number until the route answers, even when the lists have",
      { kind: "waiting" },
      fullLists,
      { total: "-", home: "-", approvals: "-", connections: "-" },
    ],
    [
      "the route failed: the lists count, and a full list is a lower bound",
      failed,
      fullLists,
      { total: "401+", home: "200+", approvals: "200+", connections: "1 exact" },
    ],
    [
      "the route failed: lists that are not full are still exact",
      failed,
      { inbox: rows([item(), item("draft")], 200), proposals: rows(proposals(1)), drafts: rows([draft("draft")]), connections: rows([], null) },
      { total: "3 exact", home: "1 exact", approvals: "2 exact", connections: "- exact" },
    ],
  ])("%s", (_, route, lists, expected) => {
    const c = countFrom(route, lists);
    expect({ total: read(c.total), home: read(c.home), approvals: read(c.approvals), connections: read(c.connections) }).toEqual(expected);
  });

  it("names a counted part known and a switched-off part off", () => {
    expect(countFrom(totals({ inbox: "off", drafts: "off", proposals: 0, signIns: 3 }), fullLists)).toMatchObject({
      home: { state: "off" },
      approvals: { state: "known" },
      connections: { state: "known", count: 3 },
      total: { state: "known", count: 3, exact: true },
    });
  });
});

describe("withRows", () => {
  const shown = totals({ inbox: 4, drafts: 1, proposals: 2, signIns: 0 });
  const fresh = totals({ inbox: 3, drafts: 2, proposals: 5, signIns: 1 });
  it("keeps the Inbox and Drafts parts of the answer held with the rows on screen, and takes Proposals and sign-ins as they arrive", () => {
    expect(withRows(fresh, shown)).toEqual(totals({ inbox: 4, drafts: 1, proposals: 5, signIns: 1 }));
  });
  it("takes the fresh answer whole when no answer is held with the rows yet (first load)", () => {
    expect(withRows(fresh, { kind: "waiting" })).toEqual(fresh);
  });
  it("keeps counting from the lists on screen when the route failed with them, until the rows are asked again with it", () => {
    expect(withRows(fresh, failed)).toEqual(failed);
  });
  it("falls back, or waits, as the fresh answer does", () => {
    expect(withRows(failed, shown)).toEqual(failed);
    expect(withRows({ kind: "waiting" }, shown)).toEqual({ kind: "waiting" });
  });
});

describe("countDecisions from the lists, when the count route failed", () => {
  it.each<[string, CountInputs, { total: string; home: string; approvals: string; connections: string }]>([
    [
      "a live Draft counts once, in Approvals, not as its Inbox item",
      { inbox: rows([...items(2), ...items(2, "draft")], 200), proposals: rows(proposals(1)), drafts: rows([draft("draft"), draft("draft")]), connections: rows([connection("needs_auth"), connection("connected")], null) },
      { total: "6 exact", home: "2 exact", approvals: "3 exact", connections: "1 exact" },
    ],
    [
      "approved and revoked Drafts wait too, and their items are decided in Approvals",
      { inbox: rows([item(), item("approved"), item("revoked")], 200), proposals: rows([]), drafts: rows([draft("approved"), draft("revoked")]), connections: rows([], null) },
      { total: "3 exact", home: "1 exact", approvals: "2 exact", connections: "- exact" },
    ],
    [
      "a finished Draft counts nowhere; its open item is a decision on Home again",
      { inbox: rows([item("expired"), item("rejected"), item("succeeded"), item("failed"), item("unknown")], 200), proposals: rows([]), drafts: rows([]), connections: rows([], null) },
      { total: "5 exact", home: "5 exact", approvals: "- exact", connections: "- exact" },
    ],
    [
      "a Draft being sent is not counted, while its item stays a decision on Home",
      { inbox: rows([item("executing")], 200), proposals: rows([]), drafts: rows([draft("executing")]), connections: rows([], null) },
      { total: "1 exact", home: "1 exact", approvals: "- exact", connections: "- exact" },
    ],
    [
      "a Draft whose item was snoozed still counts in Approvals",
      { inbox: rows([], 200), proposals: rows([]), drafts: rows([draft("draft")]), connections: rows([], null) },
      { total: "1 exact", home: "- exact", approvals: "1 exact", connections: "- exact" },
    ],
    [
      "nothing waits: an exact zero",
      quiet,
      { total: "- exact", home: "- exact", approvals: "- exact", connections: "- exact" },
    ],
    [
      "the prototype's normal day: 11 open items, 1 with a waiting Draft, and a Draft being sent",
      { inbox: rows([...items(10), item("draft")], 200), proposals: rows(proposals(2)), drafts: rows([draft("draft"), draft("draft"), draft("executing")]), connections: rows([], null) },
      { total: "14 exact", home: "10 exact", approvals: "4 exact", connections: "- exact" },
    ],
    [
      "a full Inbox list is a lower bound",
      { inbox: rows([...items(199), item("draft")], 200), proposals: rows(proposals(2)), drafts: rows([draft("draft"), draft("draft")]), connections: rows([], null) },
      { total: "203+", home: "199+", approvals: "4 exact", connections: "- exact" },
    ],
    [
      "a full Drafts list makes Approvals a lower bound",
      { inbox: rows(items(1), 200), proposals: rows(proposals(1)), drafts: rows(Array.from({ length: 3 }, () => draft("draft")), 3), connections: rows([], null) },
      { total: "5+", home: "1 exact", approvals: "4+", connections: "- exact" },
    ],
    [
      "a failed Drafts request leaves Approvals a lower bound from the Proposals",
      { inbox: rows([item(), item("draft")], 200), proposals: rows(proposals(2)), drafts: failed, connections: rows([connection("needs_auth")], null) },
      { total: "4+", home: "1 exact", approvals: "2+", connections: "1 exact" },
    ],
    [
      "a failed Inbox request gives Home no number, and the rest a lower bound",
      { inbox: failed, proposals: rows(proposals(2)), drafts: rows([draft("draft"), draft("approved")]), connections: rows([], null) },
      { total: "4+", home: "-", approvals: "4 exact", connections: "- exact" },
    ],
    [
      "a failed request with nothing else waiting gives no number at all",
      { ...quiet, inbox: failed },
      { total: "-", home: "-", approvals: "- exact", connections: "- exact" },
    ],
    [
      "every request failed: no numbers",
      { inbox: failed, proposals: failed, drafts: failed, connections: failed },
      { total: "-", home: "-", approvals: "-", connections: "-" },
    ],
    [
      "Attention and briefings off: Home is off, the rest still count exactly",
      { inbox: off, proposals: rows(proposals(1)), drafts: rows([draft("draft")]), connections: rows([], null) },
      { total: "2 exact", home: "- exact", approvals: "2 exact", connections: "- exact" },
    ],
    [
      "Drafts and approvals off: the Drafts half of Approvals is off",
      { inbox: rows(items(3), 200), proposals: rows(proposals(1)), drafts: off, connections: rows([], null) },
      { total: "4 exact", home: "3 exact", approvals: "1 exact", connections: "- exact" },
    ],
    [
      "a Connection in error is not a decision; only sign-ins count",
      { ...quiet, inbox: rows(items(2), 200), connections: rows([connection("error"), connection("disconnected"), connection("not_configured")], null) },
      { total: "2 exact", home: "2 exact", approvals: "- exact", connections: "- exact" },
    ],
    [
      "a meeting prep item shown as a Heads-up is still one Inbox decision",
      { ...quiet, inbox: rows([item(null, "meeting_prep"), item()], 200) },
      { total: "2 exact", home: "2 exact", approvals: "- exact", connections: "- exact" },
    ],
    [
      "first load: nothing has answered, so there is no number",
      { inbox: waiting, proposals: waiting, drafts: waiting, connections: waiting },
      { total: "-", home: "-", approvals: "-", connections: "-" },
    ],
    [
      "first load, partly answered: what has answered is a lower bound",
      { inbox: rows(items(3), 200), proposals: waiting, drafts: waiting, connections: waiting },
      { total: "3+", home: "3 exact", approvals: "-", connections: "-" },
    ],
    [
      "the service is unreachable: every answer failed",
      { inbox: failed, proposals: failed, drafts: failed, connections: failed },
      { total: "-", home: "-", approvals: "-", connections: "-" },
    ],
  ])("%s", (_, inputs, expected) => {
    const c = countDecisions(inputs);
    expect({ total: read(c.total), home: read(c.home), approvals: read(c.approvals), connections: read(c.connections) }).toEqual(expected);
  });

  it("names each part's condition: known, at its list limit, unknown or off", () => {
    expect(countDecisions({ inbox: rows(items(2), 200), proposals: rows(proposals(1)), drafts: off, connections: failed })).toMatchObject({
      home: { state: "known" },
      approvals: { state: "known" },
      connections: { state: "unknown" },
      total: { state: "unknown" },
    });
    expect(countDecisions({ ...quiet, inbox: rows(items(200), 200) }).home.state).toBe("at_limit");
    expect(countDecisions({ ...quiet, inbox: off }).home.state).toBe("off");
    expect(countDecisions({ ...quiet, proposals: rows(proposals(1)), drafts: off }).approvals.state).toBe("known");
  });
});

describe("dotAfter", () => {
  const total = (inputs: CountInputs) => countDecisions(inputs).total;
  it("is off on first load until the first answer", () => {
    expect(dotAfter(false, total({ inbox: waiting, proposals: waiting, drafts: waiting, connections: waiting }))).toBe(false);
  });
  it("lights when a decision waits, exact or a lower bound", () => {
    expect(dotAfter(false, total({ ...quiet, proposals: rows(proposals(1)) }))).toBe(true);
    expect(dotAfter(false, total({ ...quiet, proposals: rows(proposals(1)), drafts: failed }))).toBe(true);
  });
  it("goes out only at an exact zero", () => {
    expect(dotAfter(true, total(quiet))).toBe(false);
  });
  it("stays as it was when an unknown part leaves nothing known to wait", () => {
    expect(dotAfter(true, total({ ...quiet, drafts: failed }))).toBe(true);
    expect(dotAfter(false, total({ ...quiet, drafts: failed }))).toBe(false);
  });
});

describe("tabTitle", () => {
  it.each<[string, CountInputs, string]>([
    ["names the total when decisions wait", { ...quiet, inbox: rows(items(12), 200), proposals: rows(proposals(2)) }, "(14) Attache"],
    ["marks a lower bound", { ...quiet, inbox: rows(items(12), 200), drafts: failed }, "(12+) Attache"],
    ["has no number at an exact zero", quiet, "Attache"],
    ["has no number when nothing is known", { inbox: failed, proposals: failed, drafts: failed, connections: failed }, "Attache"],
  ])("%s", (_, inputs, title) => {
    expect(tabTitle(countDecisions(inputs).total)).toBe(title);
  });
});

describe("spokenCount", () => {
  it("reads a number with its words, and a lower bound as at least", () => {
    const c = countDecisions({ ...quiet, inbox: rows(items(1), 200), proposals: rows(proposals(2)), drafts: failed });
    expect(spokenCount(c.home, (n) => (n === 1 ? "needs you" : "need you"))).toBe("1 needs you");
    expect(spokenCount(c.approvals, () => "waiting")).toBe("at least 2 waiting");
    expect(spokenCount(c.connections, () => "needed")).toBeNull();
  });
});

describe("refreshAnnouncement", () => {
  const needYou = (n: number) => (n === 1 ? "needs you" : "need you");
  it.each([
    ["several wait", { state: "known", count: 4, exact: true }, "4 need you now."],
    ["one waits", { state: "known", count: 1, exact: true }, "1 needs you now."],
    ["nothing waits", { state: "known", count: 0, exact: true }, "Nothing needs you now."],
    ["a lower bound", { state: "at_limit", count: 200, exact: false }, "At least 200 need you now."],
    ["a part is unknown: it never claims nothing waits", { state: "unknown", count: 0, exact: false }, null],
  ] as const)("%s", (_, after, said) => {
    expect(refreshAnnouncement(after as Tally, needYou)).toBe(said);
  });
});

describe("homeLine", () => {
  const exact = (n: number): Tally => ({ state: "known", count: n, exact: true });
  const lower = (n: number): Tally => ({ state: "unknown", count: n, exact: false });
  it("says nothing when the rows below are the decisions", () => {
    expect(homeLine(rows(items(3), 200), exact(3))).toBeNull();
  });
  it("relates rows to decisions when an item's Draft waits in Approvals", () => {
    expect(homeLine(rows([...items(3), item("draft")], 200), exact(3))).toBe("3 items below need you · 1 Draft in Approvals");
  });
  it("counts meeting prep as a row below like any other item: the Inbox lists every open item", () => {
    const meeting = item(null, "meeting_prep");
    expect(homeLine(rows([meeting, ...items(3), item("approved"), item("revoked")], 200), exact(4))).toBe("4 items below need you · 2 Drafts in Approvals");
  });
  it("uses the singular for one item below", () => {
    expect(homeLine(rows([item(), item("draft")], 200), exact(1))).toBe("1 item below needs you · 1 Draft in Approvals");
  });
  it("counts the rows on screen when the count is only a lower bound and the list is whole", () => {
    expect(homeLine(rows([...items(2), item("draft")], 200), lower(1))).toBe("2 items below need you · 1 Draft in Approvals");
  });
  it("takes the decisions below from the exact count when the list is full, and the Drafts as a lower bound", () => {
    expect(homeLine(rows([...items(2), item("draft")], 3), exact(250))).toBe("250 items below need you · at least 1 Draft in Approvals");
  });
  it("says at least for both when the list is full and the count is not exact", () => {
    expect(homeLine(rows([...items(2), item("draft")], 3), lower(2))).toBe("At least 2 items below need you · at least 1 Draft in Approvals");
  });
  it("says nothing when the Inbox has not answered", () => {
    expect(homeLine(failed, exact(0))).toBeNull();
  });
});
