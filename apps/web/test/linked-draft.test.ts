import { describe, expect, it } from "vitest";
import type { ActionStatus } from "@attache/contracts";
import { openDraftId } from "../src/linked-draft.ts";

const item = (actionStatus: ActionStatus | null) => ({ actionId: actionStatus ? "draft-1" : null, actionStatus });

describe("openDraftId", () => {
  it("has nothing to view when the item was never drafted", () => {
    expect(openDraftId(item(null))).toBeNull();
  });

  it.each<ActionStatus>(["draft", "approved", "revoked", "executing"])("views the linked draft while it is %s", (status) => {
    expect(openDraftId(item(status))).toBe("draft-1");
  });

  it.each<ActionStatus>(["rejected", "expired", "succeeded", "failed", "unknown"])("prepares a new draft once the linked one is %s", (status) => {
    expect(openDraftId(item(status))).toBeNull();
  });

  it("prepares a new draft when the linked draft is gone", () => {
    expect(openDraftId({ actionId: "draft-1", actionStatus: null })).toBeNull();
  });
});
