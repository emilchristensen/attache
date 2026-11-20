import { describe, expect, it } from "vitest";
import type { ConnectionsStatus, StatusRow } from "../src/connection-status.ts";
import type { DecisionCount, Tally } from "../src/count.ts";
import { emptyInbox, inboxReach, type EmptyInboxInput, type InboxReach } from "../src/inbox-empty.ts";

// The empty Inbox says exactly what is known: what was read (from Home's Connections area) and what still waits
// elsewhere (from the decision count). Rules: docs/design/dashboard-redesign/fable/spec-dot-and-drafts.md, part 1.6.

const TZ = "Europe/Copenhagen";
const NOW = Date.parse("2026-11-18T09:30:00Z");
const READ_AT = "2026-11-18T08:14:00Z";

const known = (count: number): Tally => ({ state: "known", count, exact: true });
const atLimit = (count: number): Tally => ({ state: "at_limit", count, exact: false });
const unknown: Tally = { state: "unknown", count: 0, exact: false };
const off: Tally = { state: "off", count: 0, exact: true };

function count(home: Tally, approvals: Tally, connections: Tally): DecisionCount {
  const parts = [home, approvals, connections];
  const exact = parts.every((p) => p.exact);
  const sum = parts.reduce((n, p) => n + p.count, 0);
  return { home, approvals, connections, total: { state: exact ? "known" : "unknown", count: sum, exact } };
}

const NOTHING = count(known(0), known(0), known(0));
/** Which parts of the count a failed request left inexact. */
const NO_FAILURE = { approvals: false, signIns: false };
const APPROVALS_FAILED = { approvals: true, signIns: false };

/** A problem row as Home's Connections area has it; only the fields the Inbox reads matter. */
function row(state: StatusRow["state"], subject: string, word: string, inbox = true): StatusRow {
  return { key: `${state}:${subject}`, state, word, subject, inbox } as StatusRow;
}

const ALL_GOOD: ConnectionsStatus = { kind: "all_good", sources: 5, others: 2, lastReadAt: READ_AT, reader: "This Machine" };
const READ_ALL: InboxReach = { kind: "all", sources: 5, lastReadAt: READ_AT };
const GMAIL_SIGN_IN: InboxReach = { kind: "partial", sources: 4, missing: [{ subject: "Gmail", word: "Sign-in needed" }] };

function input(over: Partial<EmptyInboxInput> = {}): EmptyInboxInput {
  return { count: NOTHING, reach: READ_ALL, failed: NO_FAILURE, now: NOW, timeZone: TZ, ...over };
}

describe("inboxReach: what Home's Connections area says was read", () => {
  it.each<[string, ConnectionsStatus, InboxReach]>([
    ["all good: every source, and when", ALL_GOOD, READ_ALL],
    ["a problem that hides no Inbox item still counts as all read", { kind: "problems", rows: [row("down", "Model", "Down", false)], working: { sources: 5, others: 1 } }, { kind: "all", sources: 5, lastReadAt: null }],
    ["a sign-in that hides items: the sources read and the one that was not", { kind: "problems", rows: [row("sign_in", "Gmail", "Sign-in needed")], working: { sources: 4, others: 2 } }, GMAIL_SIGN_IN],
    [
      "several missing, none known read while nothing reads",
      { kind: "problems", rows: [row("offline", "GitHub and Slack", "Offline"), row("not_read_yet", "Jira", "Not read yet")], working: null },
      { kind: "partial", sources: null, missing: [{ subject: "GitHub and Slack", word: "Offline" }, { subject: "Jira", word: "Not read yet" }] },
    ],
    ["notes only", { kind: "problems", rows: [row("notes_only", "Work sources", "Notes only")], working: { sources: 1, others: 0 } }, { kind: "notes" }],
    ["still checking", { kind: "problems", rows: [row("checking", "Every Connection", "Checking")], working: null }, { kind: "unknown", checking: true }],
    ["could not check", { kind: "problems", rows: [row("could_not_check", "Reader", "Could not check")], working: null }, { kind: "unknown", checking: false }],
  ])("%s", (_name, status, expected) => {
    expect(inboxReach(status)).toEqual(expected);
  });
});

/** The words as the owner reads them, top to bottom. */
function words(i: EmptyInboxInput): string[] | null {
  const e = emptyInbox(i);
  if (!e) return null;
  return [e.title + (e.clear ? " [logo without its dot]" : ""), ...e.lines.map((l) => l.text + (l.link ? ` [${l.link}]` : "")), ...(e.retry ? ["[Retry]"] : [])];
}

describe("emptyInbox: an empty Inbox claims no more than was read", () => {
  it.each<[string, Partial<EmptyInboxInput>, string[] | null]>([
    ["total exactly zero, every source read: Nothing needs you", {}, ["Nothing needs you. [logo without its dot]", "All 5 sources were read, last at 09:14."]],
    ["one source", { reach: { kind: "all", sources: 1, lastReadAt: READ_AT } }, ["Nothing needs you. [logo without its dot]", "Your one source was read, last at 09:14."]],
    ["read yesterday", { reach: { kind: "all", sources: 5, lastReadAt: "2026-11-17T22:10:00Z" } }, ["Nothing needs you. [logo without its dot]", "All 5 sources were read, last yesterday at 23:10."]],
    ["read, but no time stored", { reach: { kind: "all", sources: 5, lastReadAt: null } }, ["Nothing needs you. [logo without its dot]", "All 5 sources were read."]],
    ["every source read, how many unknown", { reach: { kind: "all", sources: null, lastReadAt: null } }, ["Nothing needs you. [logo without its dot]", "Every source was read."]],
    ["the Inbox and sign-ins off-free: Drafts off is still exact", { count: count(known(0), off, known(0)) }, ["Nothing needs you. [logo without its dot]", "All 5 sources were read, last at 09:14."]],
    ["a source not read: what was found, and what was not read", { reach: GMAIL_SIGN_IN, count: count(known(0), known(0), known(0)) }, ["Nothing found in the 4 sources that were read.", "Not read: Gmail (sign-in needed)."]],
    [
      "several not read, how many read unknown",
      { reach: { kind: "partial", sources: null, missing: [{ subject: "GitHub and Slack", word: "Offline" }, { subject: "Jira", word: "Not read yet" }] } },
      ["No open Inbox items.", "Not read: GitHub and Slack (offline) and Jira (not read yet)."],
    ],
    ["no source known to be read: no claim about what was found", { reach: { kind: "partial", sources: 0, missing: [{ subject: "Every source", word: "Not read yet" }] } }, ["No open Inbox items.", "Not read: Every source (not read yet)."]],
    [
      "Retry beside a lower bound that a failure left",
      { count: count(known(0), { state: "unknown", count: 1, exact: false }, known(0)), failed: APPROVALS_FAILED },
      ["No open Inbox items.", "All 5 sources were read, last at 09:14.", "At least 1 approval waits on its own page. [approvals]", "Approvals could not all be counted.", "[Retry]"],
    ],
    ["a failure beside a part still being asked: nothing to say yet", { count: count(known(0), unknown, unknown), failed: APPROVALS_FAILED }, null],
    ["one source read and one not", { reach: { kind: "partial", sources: 1, missing: [{ subject: "Gmail", word: "Down" }] } }, ["Nothing found in the one source that was read.", "Not read: Gmail (down)."]],
    ["notes only: never that all work is clear", { reach: { kind: "notes" } }, ["Nothing found in your notes.", "No work source is connected, so only your notes were read."]],
    ["approvals wait: no open items, and where the decisions are", { count: count(known(0), known(4), known(0)) }, ["No open Inbox items.", "All 5 sources were read, last at 09:14.", "4 approvals wait on their own page. [approvals]"]],
    ["one approval", { count: count(known(0), known(1), known(0)) }, ["No open Inbox items.", "All 5 sources were read, last at 09:14.", "1 approval waits on its own page. [approvals]"]],
    ["approvals beyond a list limit", { count: count(known(0), atLimit(100), known(0)) }, ["No open Inbox items.", "All 5 sources were read, last at 09:14.", "At least 100 approvals wait on their own page. [approvals]"]],
    ["a sign-in waits", { reach: GMAIL_SIGN_IN, count: count(known(0), known(0), known(1)) }, ["Nothing found in the 4 sources that were read.", "Not read: Gmail (sign-in needed).", "A Connection needs your sign-in, above."]],
    ["two sign-ins and approvals", { count: count(known(0), known(2), known(2)) }, ["No open Inbox items.", "All 5 sources were read, last at 09:14.", "2 approvals wait on their own page. [approvals]", "2 Connections need your sign-in, above."]],
    [
      "approvals could not be counted: no claim, and Retry",
      { count: count(known(0), unknown, known(0)), failed: APPROVALS_FAILED },
      ["No open Inbox items.", "All 5 sources were read, last at 09:14.", "Approvals could not be counted, so Attache cannot say that nothing needs you.", "[Retry]"],
    ],
    [
      "approvals and sign-ins could not be counted",
      { count: count(known(0), unknown, unknown), failed: { approvals: true, signIns: true } },
      ["No open Inbox items.", "All 5 sources were read, last at 09:14.", "Approvals and sign-ins could not be counted, so Attache cannot say that nothing needs you.", "[Retry]"],
    ],
    ["still counting: nothing to say yet", { count: count(known(0), unknown, known(0)) }, null],
    ["the Inbox's own number still counting", { count: count(unknown, known(0), known(0)) }, null],
    ["Connections still being checked", { reach: { kind: "unknown", checking: true } }, ["No open Inbox items.", "Connections are still being checked, so Attache cannot say yet what was read."]],
    ["Connections could not be checked", { reach: { kind: "unknown", checking: false } }, ["No open Inbox items.", "Connections could not be checked, so Attache cannot say what was read."]],
  ])("%s", (_name, over, expected) => {
    const e = words(input(over));
    expect(e).toEqual(expected);
  });

  it("asks for Retry only when a count request failed", () => {
    expect(emptyInbox(input({ count: count(known(0), unknown, known(0)), failed: APPROVALS_FAILED }))?.retry).toBe(true);
    expect(emptyInbox(input())?.retry).toBe(false);
    expect(emptyInbox(input({ count: count(known(0), atLimit(100), known(0)) }))?.retry).toBe(false);
  });

  it("says Nothing needs you only from an exact zero with every source read", () => {
    const cases: Array<Partial<EmptyInboxInput>> = [
      { reach: GMAIL_SIGN_IN },
      { reach: { kind: "notes" } },
      { reach: { kind: "unknown", checking: false } },
      { count: count(known(0), known(1), known(0)) },
      { count: count(known(0), unknown, known(0)), failed: APPROVALS_FAILED },
      { count: count(known(1), known(0), known(0)) },
    ];
    for (const c of cases) expect(emptyInbox(input(c))?.clear).toBe(false);
  });
});
