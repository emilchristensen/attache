import { describe, expect, it } from "vitest";
import type { ActionView } from "@attache/contracts";
import { draftScreen, type DraftEditor, type DraftScreen } from "../src/draft-state.ts";

const NOW = Date.parse("2026-11-18T16:30:00.000Z");

/** Times as the owner reads them, in UTC so the cases do not depend on the machine's zone. */
const clock = {
  time: (iso: string) => iso.slice(11, 16),
  day: (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)} ${iso.slice(11, 16)}`,
};

/** A Draft as `GET /actions/:id` returns it, with only what a case sets. */
function draft(over: Partial<ActionView> = {}): ActionView {
  return {
    id: "d1",
    kind: "github.comment",
    connectionId: "github",
    title: "Review acme/web#42: Add checkout retry",
    target: { repo: "acme/web", number: 42, url: "https://github.com/acme/web/pull/42" },
    payload: { body: "Looks good." },
    payloadHash: "h".repeat(64),
    version: 2,
    context: { item: { id: "item-1", title: "Add checkout retry", summary: "", url: "https://github.com/acme/web/pull/42" } },
    status: "draft",
    expiresAt: "2026-11-20T16:21:00.000Z",
    createdAt: "2026-11-18T09:00:00.000Z",
    updatedAt: "2026-11-18T09:00:00.000Z",
    approval: null,
    receipt: null,
    events: [],
    executable: { ok: false, reason: "Needs approval" },
    ...over,
  };
}

const APPROVAL = { version: 2, payloadHash: "h".repeat(64), nonce: "n".repeat(48), approvedAt: "2026-11-18T16:21:00.000Z", expiresAt: "2026-11-18T16:36:00.000Z" };

/** The editor holding the stored text of v2, untouched. */
const CLEAN: DraftEditor = { dirty: false, empty: false, baseVersion: 2 };
const EDITED: DraftEditor = { dirty: true, empty: false, baseVersion: 2 };

const screen = (d: ActionView, editor: DraftEditor = CLEAN): DraftScreen => draftScreen({ draft: d, editor, now: NOW, clock });

/** The buttons, primary first, as `label` (or `label [primary]`, `label (disabled: reason)`). */
const buttons = (s: DraftScreen) => s.actions.map((a) => `${a.label}${a.primary ? " [primary]" : ""}${a.disabled ? ` (disabled: ${a.disabled})` : ""}`);
const steps = (s: DraftScreen) => s.steps?.map((p) => `${p.label}: ${p.mark}`) ?? null;

describe("a Draft's own page: the fourteen states", () => {
  it("Draft: Approve vN leads, Send vN is visible but disabled with its reason", () => {
    const s = screen(draft());
    expect(s.state).toBe("draft");
    expect(s.status).toBe("Draft");
    expect(steps(s)).toEqual(["Draft v2: current", "Approved: todo", "Sent: todo"]);
    expect(s.notice).toEqual({ tone: "plain", warning: false, lines: ["Send unlocks after approval. Approval covers exactly this version, for 15 minutes."] });
    expect(buttons(s)).toEqual(["Approve v2 [primary]", "Send v2 (disabled: Send unlocks after approval.)", "Reject"]);
    expect(s.editor).toBe("on");
  });

  it("Draft: Approve waits while the text is empty", () => {
    expect(buttons(screen(draft(), { ...CLEAN, empty: true }))[0]).toBe("Approve v2 [primary] (disabled: Write the text first.)");
  });

  it("Approved: Send vN leads, with the approval's times and the warning that it cannot be undone", () => {
    const s = screen(draft({ status: "approved", approval: APPROVAL, executable: { ok: true, reason: null } }));
    expect(s.state).toBe("approved");
    expect(s.status).toBe("Approved");
    expect(steps(s)).toEqual(["Draft v2: done", "Approved until 16:36: current", "Sent: todo"]);
    expect(s.notice).toEqual({ tone: "plain", warning: false, lines: ["v2 approved at 16:21, valid until 16:36.", "Send posts exactly v2 and cannot be undone. Attache rechecks the approval and the write permission right before sending."] });
    expect(buttons(s)).toEqual(["Send v2 [primary]", "Revoke approval", "Reject"]);
    expect(s.editor).toBe("on");
  });

  it("Approved, for a Gmail draft: the button creates vN in Gmail and nothing is sent", () => {
    const s = screen(draft({ kind: "gmail.draft", target: { to: "nora@example.com" }, status: "approved", approval: APPROVAL, executable: { ok: true, reason: null } }));
    expect(buttons(s)[0]).toBe("Create v2 in Gmail [primary]");
    expect(s.notice.lines[1]).toBe("Create v2 in Gmail makes exactly v2 a draft in your Gmail; nothing is sent. Attache rechecks the approval and the write permission right before.");
    expect(buttons(screen(draft({ kind: "gmail.draft" })))[1]).toBe("Create v2 in Gmail (disabled: Creating it in Gmail unlocks after approval.)");
  });

  it("Cannot send yet: a brass notice with the service's reason, Send disabled, and Connections when the reason is about authorisation", () => {
    const reason = "Writing (github.comment) is not authorised for GitHub. Authorise it in Connections.";
    const s = screen(draft({ status: "approved", approval: APPROVAL, executable: { ok: false, reason } }));
    expect(s.state).toBe("cannot_send");
    expect(s.status).toBe("Approved");
    expect(steps(s)).toEqual(["Draft v2: done", "Approved until 16:36: current", "Sent: todo"]);
    expect(s.notice).toEqual({ tone: "attention", warning: true, lines: ["Cannot send yet.", reason] });
    expect(buttons(s)).toEqual([`Send v2 (disabled: ${reason})`, "Open Connections", "Revoke approval", "Reject"]);
    // A reason that is not about Connections offers no way there.
    expect(buttons(screen(draft({ status: "approved", approval: APPROVAL, executable: { ok: false, reason: "Drafts and approvals is turned off" } })))).not.toContain("Open Connections");
  });

  it("Approval ended: the service returned it to draft; Approve vN again leads and nothing was sent", () => {
    const ended = draft({ events: [{ event: "approved", data: { version: 2 }, at: "2026-11-18T16:06:00.000Z", actor: "c1" }, { event: "approval_expired", data: { version: 2, approvalExpiresAt: "2026-11-18T16:21:00.000Z" }, at: "2026-11-18T16:21:05.000Z", actor: "service" }] });
    const s = screen(ended);
    expect(s.state).toBe("approval_ended");
    expect(s.status).toBe("Approval ended");
    expect(steps(s)).toEqual(["Draft v2: current", "Approval ended 16:21: ended", "Sent: todo"]);
    expect(s.notice).toEqual(plainNotice("The approval of v2 ended at 16:21. Nothing was sent."));
    expect(buttons(s)).toEqual(["Approve v2 again [primary]", "Send v2 (disabled: Send unlocks after approval.)", "Reject"]);
  });

  it("Approval ended, before the service noticed: an approved Draft whose 15 minutes have passed reads the same", () => {
    const s = screen(draft({ status: "approved", approval: { ...APPROVAL, expiresAt: "2026-11-18T16:29:00.000Z" }, executable: { ok: false, reason: "Approval expired; approve again" } }));
    expect(s.state).toBe("approval_ended");
    expect(s.notice.lines).toEqual(["The approval of v2 ended at 16:29. Nothing was sent."]);
    expect(buttons(s)[0]).toBe("Approve v2 again [primary]");
  });

  it("Revoked by the owner: Approve vN leads again and nothing was sent", () => {
    const s = screen(draft({ status: "revoked", events: [{ event: "approval_revoked", data: { reason: "approval revoked" }, at: "2026-11-18T16:25:00.000Z", actor: "c1" }] }));
    expect(s.state).toBe("revoked_by_owner");
    expect(s.status).toBe("Approval revoked");
    expect(steps(s)).toEqual(["Draft v2: current", "Approval revoked: ended", "Sent: todo"]);
    expect(s.notice).toEqual(plainNotice("You revoked the approval at 16:25. Nothing was sent."));
    expect(buttons(s)).toEqual(["Approve v2 [primary]", "Send v2 (disabled: Send unlocks after approval.)", "Reject"]);
    expect(s.editor).toBe("on");
  });

  it("Revoked by the service: a brass notice says why and what keeps Send locked", () => {
    const revoked = (reason: string) => screen(draft({ status: "revoked", events: [{ event: "approval_revoked", data: { reason }, at: "2026-11-18T16:25:00.000Z", actor: "service" }] }));
    const s = revoked("connection disconnected");
    expect(s.state).toBe("revoked_by_service");
    expect(s.status).toBe("Approval revoked");
    expect(s.notice).toEqual({ tone: "attention", warning: true, lines: ["Attache revoked the approval at 16:25: connection disconnected. Nothing was sent.", "Send stays locked until GitHub is connected again."] });
    expect(buttons(s)).toEqual(["Approve v2 [primary]", "Send v2 (disabled: Send unlocks after approval.)", "Reject"]);
    expect(revoked("write permission removed").notice.lines[1]).toBe("Send stays locked until writing is allowed for GitHub in Connections.");
    expect(revoked("Drafts and approvals was turned off").notice.lines[1]).toBe("Send stays locked until Drafts and approvals is turned on in Settings.");
  });

  it("Sending: no buttons, the editor is off, and it keeps running without the tab", () => {
    const s = screen(draft({ status: "executing", approval: APPROVAL }));
    expect(s.state).toBe("sending");
    expect(s.status).toBe("Sending");
    expect(steps(s)).toEqual(["Draft v2: done", "Approved: done", "Sending v2: current"]);
    expect(s.notice).toEqual(plainNotice("Sending v2. Attache marks it sent only after GitHub confirms it. This keeps running if you close the tab."));
    expect(s.actions).toEqual([]);
    expect(s.editor).toBe("off");
  });

  it("Sent: every step checked, with the verified time", () => {
    const s = screen(draft({ status: "succeeded", receipt: { verified: true, verifiedAt: "2026-11-18T16:22:00.000Z", remoteId: "900", url: "https://github.com/acme/web/pull/42#c900" } }));
    expect(s.state).toBe("sent");
    expect(s.status).toBe("Sent");
    expect(steps(s)).toEqual(["Draft v2: done", "Approved: done", "Sent 16:22, verified: done"]);
    expect(s.notice).toEqual(plainNotice("Sent at 16:22 and verified on GitHub."));
    expect(buttons(s)).toEqual(["Open on GitHub"]);
    expect(s.editor).toBe("off");
  });

  it("Not sent: a red notice with the warning icon says who stopped it; the Draft is final", () => {
    const refused = screen(draft({ status: "failed", receipt: { error: "Validation failed", attempted: true, sent: false } }));
    expect(refused.state).toBe("not_sent");
    expect(refused.status).toBe("Not sent");
    expect(steps(refused)).toEqual(["Draft v2: done", "Approved: done", "Not sent: failed"]);
    expect(refused.notice).toEqual({ tone: "danger", warning: true, lines: ["Not sent. GitHub refused it: Validation failed", "This Draft is finished. It cannot be edited or sent again."] });
    expect(buttons(refused)).toEqual(["Copy text", "Prepare a new Draft", "Open on GitHub"]);
    expect(refused.editor).toBe("off");
    const stopped = screen(draft({ status: "failed", receipt: { error: "The approval expired before it could be sent", attempted: false } }));
    expect(stopped.notice.lines[0]).toBe("Not sent. Attache stopped before calling GitHub: The approval expired before it could be sent");
  });

  it("Outcome unknown: check the target first; never a check mark, never Send or Prepare again, nothing primary", () => {
    const s = screen(draft({ status: "unknown", receipt: { error: "socket hang up", note: "The request may have reached the service. Check the target before sending again." } }));
    expect(s.state).toBe("unknown");
    expect(s.status).toBe("Outcome unknown");
    expect(steps(s)).toEqual(["Draft v2: done", "Approved: done", "Outcome unknown: unknown"]);
    expect(s.notice).toEqual({ tone: "attention", warning: true, lines: ["The outcome could not be verified. The request may have reached GitHub. Check the pull request before you do anything else.", "socket hang up", "The request may have reached the service. Check the target before sending again."] });
    expect(buttons(s)).toEqual(["Open the pull request", "Copy text"]);
    expect(s.editor).toBe("off");
  });

  it("Unsaved edits: Save as vN+1 leads and warns the old text is replaced; Approve and Send wait", () => {
    const s = screen(draft(), EDITED);
    expect(s.state).toBe("unsaved");
    expect(s.status).toBe("Draft");
    expect(steps(s)).toEqual(["Draft v2: current", "Approved: todo", "Sent: todo"]);
    expect(s.notice).toEqual(plainNotice("Saving creates v3 and replaces the text of v2, which is not kept."));
    expect(buttons(s)).toEqual(["Save as v3 [primary]", "Discard changes", "Approve v2 (disabled: Save or discard your changes first.)", "Send v2 (disabled: Save or discard your changes first.)", "Reject"]);
    expect(s.editor).toBe("on");
  });

  it("Unsaved edits on an approved Draft: the step line stays as before the edit, and saving cancels the approval", () => {
    const s = screen(draft({ status: "approved", approval: APPROVAL, executable: { ok: true, reason: null } }), EDITED);
    expect(s.state).toBe("unsaved");
    expect(s.status).toBe("Approved");
    expect(steps(s)).toEqual(["Draft v2: done", "Approved until 16:36: current", "Sent: todo"]);
    expect(s.notice.lines).toEqual(["Saving creates v3 and replaces the text of v2, which is not kept. It also cancels the approval of v2."]);
    expect(buttons(s)[0]).toBe("Save as v3 [primary]");
  });

  it("Rejected: the editor is locked and Restore as vN+1 is offered until the Draft expires", () => {
    const rejected = (expiresAt: string) => screen(draft({ status: "rejected", expiresAt, events: [{ event: "rejected", data: null, at: "2026-11-18T16:30:00.000Z", actor: "c1" }] }));
    const s = rejected("2026-11-20T16:21:00.000Z");
    expect(s.state).toBe("rejected");
    expect(s.status).toBe("Rejected");
    expect(s.steps).toBeNull();
    expect(s.notice).toEqual(plainNotice("You rejected v2 at 16:30. Nothing was sent.", "Restore as v3 brings it back as a Draft. It can be restored until 20/11 16:21."));
    expect(buttons(s)).toEqual(["Restore as v3", "Copy text"]);
    expect(s.editor).toBe("off");
    // A rejected Draft is never expired by the service, so past its lifetime it simply cannot come back.
    const late = rejected("2026-11-18T16:00:00.000Z");
    expect(late.notice.lines[1]).toBe("It expired at 18/11 16:00, so it can no longer be restored.");
    expect(buttons(late)).toEqual(["Copy text"]);
  });

  it("Expired: final, nothing was sent, and a new Draft can be prepared from its item", () => {
    const s = screen(draft({ status: "expired", expiresAt: "2026-11-18T16:21:00.000Z" }));
    expect(s.state).toBe("expired");
    expect(s.status).toBe("Expired");
    expect(s.steps).toBeNull();
    expect(s.notice).toEqual(plainNotice("Expired 18/11 16:21, 48 business hours after it was prepared. Nothing was sent."));
    expect(buttons(s)).toEqual(["Copy text", "Prepare a new Draft"]);
    expect(s.editor).toBe("off");
  });

  it("Changed elsewhere: a newer version arrived under unsaved text; Load it leads, Copy my text keeps the words", () => {
    const s = screen(draft({ version: 3 }), EDITED);
    expect(s.state).toBe("changed_elsewhere");
    expect(s.status).toBe("Draft");
    expect(steps(s)).toEqual(["Draft v3: current", "Approved: todo", "Sent: todo"]);
    expect(s.notice).toEqual({ tone: "attention", warning: true, lines: ["This Draft became v3 while you were editing. Your text is not saved, and any approval of v2 no longer applies."] });
    expect(buttons(s)).toEqual(["Copy my text", "Load v3 [primary]", "Approve v3 (disabled: Load v3 first.)", "Send v3 (disabled: Load v3 first.)"]);
    expect(s.editor).toBe("on");
  });

  it("Changed elsewhere: the Draft left the editable states under unsaved text (rejected or sent from another tab)", () => {
    const s = screen(draft({ status: "rejected" }), EDITED);
    expect(s.state).toBe("changed_elsewhere");
    expect(s.status).toBe("Rejected");
    expect(s.notice.lines).toEqual(["This Draft changed while you were editing: it is now Rejected. Your text is not saved."]);
    expect(buttons(s)).toEqual(["Copy my text", "Load v2 [primary]"]);
  });
});

const plainNotice = (...lines: string[]) => ({ tone: "plain", warning: false, lines });
