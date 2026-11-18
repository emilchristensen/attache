import { describe, expect, it } from "vitest";
import { draftTag, rowText, rowTime, snoozeChoices, untilText } from "../src/inbox-rows.ts";

// What a row's middle and trailing columns say, from the titles the connectors write today.

const item = (kind: string, sourceKind: string, title: string, extra: { summary?: string; url?: string | null } = {}) => ({
  kind,
  sourceKind,
  title,
  summary: extra.summary ?? "",
  url: extra.url ?? null,
});

describe("a row's subject and source line", () => {
  const cases: Array<[name: string, row: ReturnType<typeof item>, subject: string, source: string]> = [
    [
      "a review request moves the repository to the source line",
      item("review_request", "github", "Review acme/web#42: Add checkout retry", { url: "https://github.com/acme/web/pull/42" }),
      "Add checkout retry",
      "GitHub · acme/web #42",
    ],
    [
      "an authored PR names its repository",
      item("authored_pr", "github", "Address the pagination feedback", { url: "https://github.com/acme/api/pull/391" }),
      "Address the pagination feedback",
      "GitHub · acme/api #391",
    ],
    ["an assigned issue names its repository", item("assigned_issue", "github", "Flaky login test", { url: "https://github.com/acme/api/issues/7" }), "Flaky login test", "GitHub · acme/api #7"],
    ["a Gmail reply moves the sender to the source line", item("pending_reply", "gmail", "Reply to Nora Lind: Confirm the pilot window"), "Confirm the pilot window", "Gmail · Nora Lind"],
    ["a Gmail reply without a subject keeps its title", item("pending_reply", "gmail", "Reply to Nora Lind: (no subject)"), "Reply to Nora Lind: (no subject)", "Gmail"],
    ["a Slack DM keeps its title, which names the sender", item("pending_reply", "slack", "Reply to Mira in Slack"), "Reply to Mira in Slack", "Slack"],
    ["a Slack mention keeps its title, which names the channel", item("mention", "slack", "Mentioned in #payments"), "Mentioned in #payments", "Slack"],
    [
      "a Confluence mention moves who mentioned to the source line",
      item("mention", "confluence", 'Mentioned in "Pilot plan"', { summary: "Ana Ruiz mentioned you in Payments." }),
      "Pilot plan",
      "Confluence · Ana Ruiz",
    ],
    ["a Jira item moves its key to the source line", item("overdue_work_item", "jira", "PAY-119 overdue since 2026-11-10: Submit the pilot decision"), "Submit the pilot decision", "Jira · PAY-119"],
    ["a Jira item due soon too", item("due_work_item", "jira", "PAY-114 due 2026-11-20: Verify receipt timestamps"), "Verify receipt timestamps", "Jira · PAY-114"],
    [
      "a deadline names its note",
      item("deadline", "vault", "Due in 3 days: Send the board pack", { summary: "From “Board” (projects/board.md, line 4), due 2026-11-21." }),
      "Send the board pack",
      "Notes · Board",
    ],
    ["an overdue deadline", item("deadline", "vault", "Overdue: File the expenses", { summary: "From “Admin” (admin.md, line 2), due 2026-11-01." }), "File the expenses", "Notes · Admin"],
    ["an invite response", item("invite_response", "gcal", "Respond to invite: Offsite planning"), "Offsite planning", "Google Calendar"],
    ["meeting prep", item("meeting_prep", "gcal", "Prepare for Design review"), "Design review", "Google Calendar"],
    [
      "a fact to check keeps its title and comes from the Brain",
      item("fact-review", "vault", "Review date passed: “Status” in Orion migration"),
      "Review date passed: “Status” in Orion migration",
      "Brain",
    ],
    ["a Replication item", item("replication_blocked", "replication", "Replication is blocked"), "Replication is blocked", "Replication"],
    ["an unknown kind and source keep what they have", item("calendar_event", "new_source", "Something new"), "Something new", "New source"],
    ["a title that only looks like a prefix is kept", item("deadline", "vault", "Overdue:", { summary: "" }), "Overdue:", "Notes"],
  ];
  it.each(cases)("%s", (_name, row, subject, source) => {
    expect(rowText(row)).toEqual({ subject, source });
  });
});

describe("a row's time", () => {
  const zone = "Europe/Copenhagen";
  // Wednesday 18 November 2026, 09:30 in Copenhagen.
  const now = Date.parse("2026-11-18T08:30:00Z");
  const cases: Array<[name: string, dueAt: string | null, firstSeenAt: string, text: string]> = [
    ["first seen today shows the clock time", null, "2026-11-18T07:12:00Z", "08:12"],
    ["first seen yesterday", null, "2026-11-17T20:00:00Z", "Yesterday"],
    ["first seen earlier", null, "2026-11-10T09:00:00Z", "10 Nov"],
    ["due today", "2026-11-18", "2026-11-10T09:00:00Z", "Due today"],
    ["due tomorrow", "2026-11-19", "2026-11-10T09:00:00Z", "Due tomorrow"],
    ["due later", "2026-11-21", "2026-11-10T09:00:00Z", "Due 21 Nov"],
    ["past due", "2026-11-10", "2026-11-01T09:00:00Z", "Overdue"],
    ["due at an instant later today", "2026-11-18T15:00:00Z", "2026-11-10T09:00:00Z", "Due today"],
  ];
  it.each(cases)("%s", (_name, dueAt, firstSeenAt, text) => {
    expect(rowTime({ dueAt, firstSeenAt }, now, zone).text).toBe(text);
  });

  it("says the full time for a screen reader and a tooltip", () => {
    expect(rowTime({ dueAt: "2026-11-21", firstSeenAt: "2026-11-10T09:00:00Z" }, now, zone).label).toBe("Due on 21 November");
    expect(rowTime({ dueAt: null, firstSeenAt: "2026-11-18T07:12:00Z" }, now, zone).label).toBe("First seen at 08:12");
  });
});

describe("a row's Draft tag", () => {
  it("names the state of a Draft that still stands for the item", () => {
    expect(draftTag("draft")).toBe("Draft waiting");
    expect(draftTag("approved")).toBe("Draft approved");
    expect(draftTag("revoked")).toBe("Approval ended");
    expect(draftTag("executing")).toBe("Sending");
  });

  it("says nothing for a finished Draft or none", () => {
    for (const s of ["succeeded", "failed", "rejected", "expired", null] as const) expect(draftTag(s)).toBeNull();
  });
});

describe("snooze choices", () => {
  it("offers an hour, tomorrow at 09:00 and next Monday at 09:00, in local time", () => {
    // Wednesday 18 November 2026, 09:30 local.
    const now = new Date(2026, 10, 18, 9, 30);
    expect(snoozeChoices(now)).toEqual([
      { label: "1 hour", iso: new Date(2026, 10, 18, 10, 30).toISOString() },
      { label: "Tomorrow 09:00", iso: new Date(2026, 10, 19, 9, 0).toISOString() },
      { label: "Next Monday", iso: new Date(2026, 10, 23, 9, 0).toISOString() },
    ]);
  });

  it("goes to the Monday after next when today is Monday", () => {
    expect(snoozeChoices(new Date(2026, 10, 23, 8, 0))[2]!.iso).toBe(new Date(2026, 10, 30, 9, 0).toISOString());
  });
});

describe("when a snooze ends", () => {
  const zone = "Europe/Copenhagen";
  const now = Date.parse("2026-11-18T08:30:00Z");
  it.each([
    ["later today", "2026-11-18T10:30:00Z", "11:30"],
    ["tomorrow", "2026-11-19T08:00:00Z", "tomorrow 09:00"],
    ["later", "2026-11-23T08:00:00Z", "23 Nov 09:00"],
  ])("%s", (_name, iso, text) => {
    expect(untilText(iso, now, zone)).toBe(text);
  });
});
