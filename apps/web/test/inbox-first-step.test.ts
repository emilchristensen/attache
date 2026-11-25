import { INBOX_KINDS } from "@attache/contracts";
import { describe, expect, it } from "vitest";
import { FIRST_STEP, firstStepFor } from "../src/inbox-first-step.ts";

describe("the Inbox kind-to-first-step map", () => {
  it("covers every kind the service raises and no others", () => {
    expect(Object.keys(FIRST_STEP).sort()).toEqual([...INBOX_KINDS].sort());
  });

  it.each([
    ["pending_reply", "draft"],
    ["mention", "draft"],
    ["review_request", "source"],
    ["authored_pr", "source"],
    ["assigned_issue", "source"],
    ["overdue_work_item", "source"],
    ["due_work_item", "source"],
    ["meeting_prep", "prep"],
    ["invite_response", "calendar"],
    ["deadline", "row"],
    ["fact-review", "row"],
    ["replication_blocked", "row"],
    ["replication_unauthorized", "row"],
    ["replication_prose_versions", "row"],
    ["replication_deleted_and_changed", "row"],
  ] as const)("maps %s to %s", (kind, step) => {
    expect(firstStepFor({ kind, draftable: null })).toBe(step);
  });

  it("opens a newer kind in its row", () => {
    expect(firstStepFor({ kind: "newer_kind", draftable: null })).toBe("row");
  });

  const reply = { actionKind: "slack.reply", target: { channel: "D1" }, context: {} };
  it.each(["deadline", "fact-review", "replication_blocked", "slack_dm"])("prepares a draft for any other draftable item: a draftable %s", (kind) => {
    expect(firstStepFor({ kind, draftable: reply })).toBe("draft");
  });

  it.each([
    ["review_request", "source"],
    ["meeting_prep", "prep"],
    ["invite_response", "calendar"],
    ["pending_reply", "draft"],
  ] as const)("keeps the step its kind names for a draftable %s: %s", (kind, step) => {
    expect(firstStepFor({ kind, draftable: reply })).toBe(step);
  });
});
