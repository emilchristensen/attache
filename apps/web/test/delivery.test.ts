import { describe, expect, it } from "vitest";
import type { ActionStatus, ActionView } from "@attache/contracts";
import { deliveryCheck, replacementWarning, unconfirmedDraftId } from "../src/delivery.ts";

const PR = "https://github.com/acme/web/pull/42";
const COMMENT = "https://github.com/acme/web/pull/42#issuecomment-901";

/** A Draft as `GET /actions/:id` returns it after a send whose outcome is unknown. */
function draft(over: Partial<ActionView> = {}): ActionView {
  return {
    id: "d1",
    kind: "github.comment",
    connectionId: "github",
    title: "Review acme/web#42: Add checkout retry",
    target: { repo: "acme/web", number: 42, url: PR },
    payload: { body: "Looks good." },
    payloadHash: "h".repeat(64),
    version: 1,
    context: { item: { id: "item-1", title: "Add checkout retry", summary: "", url: PR } },
    status: "unknown",
    expiresAt: "2026-11-20T16:21:00.000Z",
    createdAt: "2026-11-18T09:00:00.000Z",
    updatedAt: "2026-11-18T09:20:00.000Z",
    approval: null,
    receipt: { url: COMMENT, verified: false, note: "Sent, but the result could not be read back. Check the target before sending again." },
    events: [],
    executable: { ok: false, reason: null },
    ...over,
  };
}

describe("which item carries Delivery unconfirmed", () => {
  it("only an item whose linked Draft ended with an unknown outcome", () => {
    const statuses: ActionStatus[] = ["draft", "approved", "revoked", "executing", "succeeded", "failed", "rejected", "expired"];
    for (const actionStatus of statuses) expect(unconfirmedDraftId({ actionId: "d1", actionStatus }), actionStatus).toBeNull();
    expect(unconfirmedDraftId({ actionId: "d1", actionStatus: "unknown" })).toBe("d1");
    expect(unconfirmedDraftId({ actionId: null, actionStatus: null })).toBeNull();
  });
});

describe("Check destination and the warning on the open row", () => {
  it("goes to the receipt's own place when the send left one, and says the Draft page's words", () => {
    expect(deliveryCheck({ url: PR, draftable: null }, draft())).toEqual({
      href: COMMENT,
      notice: {
        tone: "attention",
        warning: true,
        lines: ["The outcome could not be verified. The request may have reached GitHub. Check the pull request before you do anything else.", "Sent, but the result could not be read back. Check the target before sending again."],
      },
    });
  });

  it("falls back to the Draft's target, then to the item's own link", () => {
    expect(deliveryCheck({ url: "https://example.com/item", draftable: null }, draft({ receipt: { error: "socket hang up" } })).href).toBe(PR);
    expect(deliveryCheck({ url: "https://example.com/item", draftable: null }, draft({ receipt: null, target: { repo: "acme/web", number: 42 }, context: {} })).href).toBe("https://example.com/item");
    expect(deliveryCheck({ url: null, draftable: null }, draft({ receipt: null, target: { repo: "acme/web", number: 42 }, context: {} })).href).toBeNull();
  });

  it("a Gmail draft whose creation is unconfirmed is checked in Gmail's drafts, not in the thread it answers", () => {
    const gmail = draft({ kind: "gmail.draft", target: { threadId: "t1" }, receipt: { error: "timeout" }, context: { item: { id: "item-1", url: "https://mail.google.com/mail/u/0/#inbox/t1" } } });
    expect(deliveryCheck({ url: "https://mail.google.com/mail/u/0/#inbox/t1", draftable: null }, gmail).href).toBe("https://mail.google.com/mail/u/0/#drafts");
    expect(deliveryCheck({ url: null, draftable: null }, { ...gmail, receipt: { url: "https://mail.google.com/mail/u/0/#drafts?compose=abc" } }).href).toBe("https://mail.google.com/mail/u/0/#drafts?compose=abc");
  });

  it("before the Draft is read (or when it cannot be), warns in general words and points at the item's link", () => {
    expect(deliveryCheck({ url: PR, draftable: null }, null)).toEqual({
      href: PR,
      notice: { tone: "attention", warning: true, lines: ["The last send could not be verified. It may have arrived. Check the destination before you do anything else."] },
    });
  });

  it("before a Gmail item's Draft is read, points at Gmail's drafts, never at the thread it answers", () => {
    const item = { url: "https://mail.google.com/mail/u/0/#inbox/t1", draftable: { actionKind: "gmail.draft", target: {}, context: {} } };
    expect(deliveryCheck(item, null).href).toBe("https://mail.google.com/mail/u/0/#drafts");
  });
});

describe("the warning before a replacement", () => {
  it("asks whether the message arrived, or for a Gmail draft whether it was created", () => {
    expect(replacementWarning("github.comment")).toBe("Only if the message did not arrive. A replacement is a new Draft for this item; nothing is sent until you approve and send it.");
    expect(replacementWarning(null)).toBe("Only if the message did not arrive. A replacement is a new Draft for this item; nothing is sent until you approve and send it.");
    expect(replacementWarning("gmail.draft")).toBe("Only if the draft is not in your Gmail drafts. A replacement is a new Draft for this item; nothing reaches Gmail until you approve and create it.");
  });
});
