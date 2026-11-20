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
    expect(firstStepFor({ kind })).toBe(step);
  });

  it("opens a newer kind in its row", () => {
    expect(firstStepFor({ kind: "newer_kind" })).toBe("row");
  });
});
