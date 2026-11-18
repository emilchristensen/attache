import { describe, expect, it } from "vitest";
import { INBOX_KINDS } from "@attache/contracts";
import { FAMILIES, inboxType, KIND_FAMILY, typeWord } from "../src/inbox-types.ts";

// The service declares every Inbox kind it raises in `INBOX_KINDS` (contracts), and its connectors can only
// raise a kind from that list (`AttentionCandidate.kind` is `InboxKind`). This file is the other half: the
// Dashboard's map and the service's list must name exactly the same kinds.

describe("the kind-to-type map", () => {
  it("maps every kind the service raises to a family other than Other", () => {
    for (const kind of INBOX_KINDS) expect.soft(KIND_FAMILY[kind], kind).toBeDefined();
    for (const kind of INBOX_KINDS) expect.soft(inboxType({ kind, sourceKind: "x" }).family, kind).not.toBe("other");
  });

  it("names no kind the service does not raise", () => {
    expect(Object.keys(KIND_FAMILY).sort()).toEqual([...INBOX_KINDS].sort());
  });

  it("groups the kinds into the spec's families", () => {
    expect(KIND_FAMILY).toEqual({
      deadline: "deadlines",
      review_request: "reviews",
      authored_pr: "reviews",
      pending_reply: "replies",
      mention: "mentions",
      invite_response: "meetings",
      meeting_prep: "meetings",
      assigned_issue: "work",
      overdue_work_item: "work",
      due_work_item: "work",
      "fact-review": "facts",
      replication_blocked: "system",
      replication_unauthorized: "system",
      replication_prose_versions: "system",
      replication_deleted_and_changed: "system",
    });
  });

  it("orders the families for Group by type", () => {
    expect(FAMILIES.map((f) => f.label)).toEqual(["Deadlines", "Reviews", "Replies", "Mentions", "Meetings", "Work items", "Facts to check", "System", "Other"]);
  });
});

describe("a row's type", () => {
  const cases: Array<[kind: string, sourceKind: string, word: string, icon: string, hue: string]> = [
    ["review_request", "github", "Review request", "fork", "blue"],
    ["authored_pr", "github", "Authored PR", "pull-request", "blue"],
    ["assigned_issue", "github", "Assigned issue", "checklist", "green"],
    ["pending_reply", "gmail", "Pending reply", "envelope", "rust"],
    ["pending_reply", "slack", "Slack DM", "bubble", "plum"],
    ["mention", "confluence", "Mention", "at", "plum"],
    ["mention", "slack", "Slack mention", "at-bubble", "plum"],
    ["invite_response", "gcal", "Invite response", "calendar-question", "green"],
    ["meeting_prep", "gcal", "Meeting prep", "calendar-notes", "blue"],
    ["deadline", "vault", "Deadline", "clock", "rust"],
    ["overdue_work_item", "jira", "Jira work item", "ticket", "blue"],
    ["due_work_item", "jira", "Jira work item", "ticket", "blue"],
    ["fact-review", "vault", "Fact to check", "dated-page", "green"],
    ["replication_blocked", "replication", "Replication blocked", "blocked-arrows", "rust"],
    ["replication_unauthorized", "replication", "Replication refused", "blocked-arrows", "rust"],
    ["replication_prose_versions", "replication_merge", "Two versions", "split-page", "rust"],
    ["replication_deleted_and_changed", "replication_merge", "Deleted and changed", "split-page", "rust"],
  ];
  it.each(cases)("%s from %s reads %s with the %s glyph in %s", (kind, sourceKind, word, icon, hue) => {
    expect(inboxType({ kind, sourceKind })).toMatchObject({ word, icon, hue });
  });

  it("keeps a review request and a pending reply apart in colour, glyph and word", () => {
    const review = inboxType({ kind: "review_request", sourceKind: "github" });
    const reply = inboxType({ kind: "pending_reply", sourceKind: "gmail" });
    expect(review.hue).not.toBe(reply.hue);
    expect(review.icon).not.toBe(reply.icon);
    expect(review.word).not.toBe(reply.word);
  });

  it("shows a kind it does not know under Other with a readable word", () => {
    expect(inboxType({ kind: "calendar_event", sourceKind: "gcal" })).toEqual({ id: "calendar_event", family: "other", word: "Calendar event", icon: "document", hue: "slate" });
    expect(inboxType({ kind: "replication_split-brain", sourceKind: "replication" })).toMatchObject({ family: "other", word: "Replication split brain" });
    expect(inboxType({ kind: "", sourceKind: "x" })).toMatchObject({ family: "other", word: "Other" });
  });

  it("gives each type one id, so Slack DMs and Gmail replies count apart in the picker", () => {
    expect(inboxType({ kind: "pending_reply", sourceKind: "slack" }).id).toBe("slack_dm");
    expect(inboxType({ kind: "pending_reply", sourceKind: "gmail" }).id).toBe("pending_reply");
    expect(inboxType({ kind: "overdue_work_item", sourceKind: "jira" }).id).toBe(inboxType({ kind: "due_work_item", sourceKind: "jira" }).id);
  });
});

describe("a type's word by its id", () => {
  it("names known types, source types and unknown ids", () => {
    expect(typeWord("slack_dm")).toBe("Slack DM");
    expect(typeWord("jira_work_item")).toBe("Jira work item");
    expect(typeWord("review_request")).toBe("Review request");
    expect(typeWord("calendar_event")).toBe("Calendar event");
  });
});
