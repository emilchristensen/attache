import { approvalEndedAt, type ActionView } from "@attache/contracts";

/**
 * A Draft's own page as one pure rule (table-tested in `test/draft-state.test.ts`): the stored status and the
 * editor's state map to one of fourteen states, each with its status word, step line, notice and buttons.
 */

export type DraftStateId =
  | "draft"
  | "unsaved"
  | "approved"
  | "cannot_send"
  | "approval_ended"
  | "revoked_by_owner"
  | "revoked_by_service"
  | "sending"
  | "sent"
  | "not_sent"
  | "unknown"
  | "rejected"
  | "expired"
  | "changed_elsewhere";

/** What the editor holds: whether its text differs from the stored text, is blank, and which version it was loaded from. */
export interface DraftEditor {
  dirty: boolean;
  empty: boolean;
  baseVersion: number;
}

/** How times read on the page: a clock time ("16:36") and a day with its time ("Thu 19 Nov, 16:21"). */
export interface DraftClock {
  time: (iso: string) => string;
  day: (iso: string) => string;
}

export type StepMark = "todo" | "current" | "done" | "ended" | "failed" | "unknown";

export interface DraftStep {
  label: string;
  mark: StepMark;
}

export type DraftActionId = "approve" | "send" | "revoke" | "reject" | "save" | "discard" | "restore" | "copy" | "copy-mine" | "load" | "prepare" | "open-target" | "open-connections";

export interface DraftButton {
  id: DraftActionId;
  label: string;
  /** At most one button is primary, and it is the next step forward. */
  primary: boolean;
  /** Why it cannot be pressed now; null when it can. */
  disabled: string | null;
}

export interface DraftNotice {
  /** plain, attention (brass) or danger (red); a warning icon goes with every failed or uncertain send. */
  tone: "plain" | "attention" | "danger";
  warning: boolean;
  lines: string[];
}

export interface DraftScreen {
  state: DraftStateId;
  /** The stored status as a word, for the header. */
  status: string;
  /** Draft, Approved, Sent; null where the Draft left that line (rejected, expired). */
  steps: DraftStep[] | null;
  notice: DraftNotice;
  actions: DraftButton[];
  editor: "on" | "off";
}

export interface DraftStateInput {
  draft: ActionView;
  editor: DraftEditor;
  now: number;
  clock: DraftClock;
}

const button = (id: DraftActionId, label: string, opts: { primary?: boolean; disabled?: string | null } = {}): DraftButton => ({ id, label, primary: opts.primary ?? false, disabled: opts.disabled ?? null });

const plain = (...lines: string[]): DraftNotice => ({ tone: "plain", warning: false, lines });
const attention = (...lines: string[]): DraftNotice => ({ tone: "attention", warning: true, lines });

/** A Gmail draft is created in Gmail, not sent; every other kind posts. */
const sends = (kind: string) => kind !== "gmail.draft";

/** "Send v2", or "Create v2 in Gmail". */
const sendLabel = (d: ActionView) => (sends(d.kind) ? `Send v${d.version}` : `Create v${d.version} in Gmail`);
const sendLocked = (d: ActionView) => (sends(d.kind) ? "Send unlocks after approval." : "Creating it in Gmail unlocks after approval.");

/** A reason the service gives that the owner fixes in Connections. */
const CONNECTION_REASON = /authoris|authoriz|not connected|connection/i;

const SERVICE: Readonly<Record<string, string>> = { github: "GitHub", jira: "Jira", confluence: "Confluence", slack: "Slack", gmail: "Gmail" };

/** The other service a Draft goes to, by name ("GitHub"). */
export function draftService(d: Pick<ActionView, "kind">): string {
  return SERVICE[d.kind.split(".")[0] ?? ""] ?? "the other service";
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Where the owner checks the Draft's destination: the sent message, else the target, else the item it answers. */
export function draftTargetUrl(d: Pick<ActionView, "target" | "receipt" | "context">): string | null {
  return str(rec(d.receipt).url) ?? str(d.target.url) ?? str(rec(rec(d.context).item).url);
}

/** Gmail's list of drafts: where a Gmail draft of unknown outcome is checked when Gmail returned no address for it. */
export const GMAIL_DRAFTS_URL = "https://mail.google.com/mail/u/0/#drafts";

/** Where to check a send of unknown outcome: the receipt's address, else (a Gmail draft) Gmail's drafts, else the target. */
export function uncertainTargetUrl(d: Pick<ActionView, "kind" | "target" | "receipt" | "context">): string | null {
  return str(rec(d.receipt).url) ?? (d.kind === "gmail.draft" ? GMAIL_DRAFTS_URL : draftTargetUrl(d));
}

/** The thing to check on the other service ("the pull request"). */
function targetThing(d: ActionView): string {
  switch (d.kind) {
    case "github.comment":
      return /\/issues\//.test(str(d.target.url) ?? "") ? "the issue" : "the pull request";
    case "jira.comment":
      return "the Jira issue";
    case "confluence.comment":
      return "the page";
    case "slack.post":
      return "the conversation";
    case "gmail.draft":
      return "your Gmail drafts";
    default:
      return "the destination";
  }
}

const finished = (s: Omit<DraftScreen, "editor">): DraftScreen => ({ ...s, editor: "off" });

const steps = (first: StepMark, second: [string, StepMark], third: [string, StepMark], v: string): DraftStep[] => [
  { label: `Draft ${v}`, mark: first },
  { label: second[0], mark: second[1] },
  { label: third[0], mark: third[1] },
];

/** When the current version's approval ended: the service already returned it to `draft`, or its 15 minutes passed. */
function approvalEnded(d: ActionView, now: number): string | null {
  const ended = approvalEndedAt(d);
  if (ended) return ended;
  return d.status === "approved" && d.approval && Date.parse(d.approval.expiresAt) <= now ? d.approval.expiresAt : null;
}

function approveButton(d: ActionView, editor: DraftEditor, again = false): DraftButton {
  return button("approve", `Approve v${d.version}${again ? " again" : ""}`, { primary: true, disabled: editor.empty ? "Write the text first." : null });
}

function waitingForApproval(d: ActionView, editor: DraftEditor, now: number, clock: DraftClock): DraftScreen {
  const v = `v${d.version}`;
  const send = button("send", sendLabel(d), { disabled: sendLocked(d) });
  const ended = approvalEnded(d, now);
  if (ended) {
    return {
      state: "approval_ended",
      status: "Approval ended",
      steps: steps("current", [`Approval ended ${clock.time(ended)}`, "ended"], ["Sent", "todo"], v),
      notice: plain(`The approval of ${v} ended at ${clock.time(ended)}. Nothing was sent.`),
      actions: [approveButton(d, editor, true), send, button("reject", "Reject")],
      editor: "on",
    };
  }
  return {
    state: "draft",
    status: "Draft",
    steps: steps("current", ["Approved", "todo"], ["Sent", "todo"], v),
    notice: plain(`${sendLocked(d)} Approval covers exactly this version, for 15 minutes.`),
    actions: [approveButton(d, editor), send, button("reject", "Reject")],
    editor: "on",
  };
}

function approved(d: ActionView, approval: NonNullable<ActionView["approval"]>, clock: DraftClock): DraftScreen {
  const v = `v${d.version}`;
  const stepLine = steps("done", [`Approved until ${clock.time(approval.expiresAt)}`, "current"], ["Sent", "todo"], v);
  const after = [button("revoke", "Revoke approval"), button("reject", "Reject")];
  if (!d.executable.ok) {
    const reason = d.executable.reason ?? "The service did not say why.";
    return {
      state: "cannot_send",
      status: "Approved",
      steps: stepLine,
      notice: attention("Cannot send yet.", reason),
      actions: [button("send", sendLabel(d), { disabled: reason }), ...(CONNECTION_REASON.test(reason) ? [button("open-connections", "Open Connections")] : []), ...after],
      editor: "on",
    };
  }
  const warning = sends(d.kind)
    ? `Send posts exactly ${v} and cannot be undone. Attache rechecks the approval and the write permission right before sending.`
    : `Create ${v} in Gmail makes exactly ${v} a draft in your Gmail; nothing is sent. Attache rechecks the approval and the write permission right before.`;
  return {
    state: "approved",
    status: "Approved",
    steps: stepLine,
    notice: plain(`${v} approved at ${clock.time(approval.approvedAt)}, valid until ${clock.time(approval.expiresAt)}.`, warning),
    actions: [button("send", sendLabel(d), { primary: true }), ...after],
    editor: "on",
  };
}

/** How the latest approval was revoked: by the owner, or by the service with its reason. */
function revocation(d: ActionView): { at: string; byService: boolean; reason: string } {
  const last = d.events.findLast((e) => e.event === "approval_revoked");
  return { at: last?.at ?? d.updatedAt, byService: last?.actor === "service", reason: str(rec(last?.data).reason) ?? "approval revoked" };
}

/** What keeps Send locked after the service revoked an approval, by the reason it gave. */
function stillLocked(reason: string, service: string): string | null {
  if (/disconnected/i.test(reason)) return `Send stays locked until ${service} is connected again.`;
  if (/write permission/i.test(reason)) return `Send stays locked until writing is allowed for ${service} in Connections.`;
  if (/turned off/i.test(reason)) return "Send stays locked until Drafts and approvals is turned on in Settings.";
  return null;
}

function revoked(d: ActionView, editor: DraftEditor, clock: DraftClock): DraftScreen {
  const v = `v${d.version}`;
  const r = revocation(d);
  const base = {
    status: "Approval revoked",
    steps: steps("current", ["Approval revoked", "ended"], ["Sent", "todo"], v),
    actions: [approveButton(d, editor), button("send", sendLabel(d), { disabled: sendLocked(d) }), button("reject", "Reject")],
    editor: "on" as const,
  };
  if (!r.byService) return { ...base, state: "revoked_by_owner", notice: plain(`You revoked the approval at ${clock.time(r.at)}. Nothing was sent.`) };
  const locked = stillLocked(r.reason, draftService(d));
  return { ...base, state: "revoked_by_service", notice: attention(`Attache revoked the approval at ${clock.time(r.at)}: ${r.reason}. Nothing was sent.`, ...(locked ? [locked] : [])) };
}

const lastStep = (d: ActionView) => (sends(d.kind) ? "Sent" : "Created in Gmail");

/** After Send was pressed: sending, sent, not sent or of unknown outcome. Nothing here can be sent again. */
function afterSend(d: ActionView, clock: DraftClock): DraftScreen {
  const v = `v${d.version}`;
  const service = draftService(d);
  const receipt = rec(d.receipt);
  const url = draftTargetUrl(d);
  const openOn = url ? [button("open-target", `Open on ${service}`)] : [];
  const prepare = str(rec(rec(d.context).item).id) ? [button("prepare", "Prepare a new Draft")] : [];
  if (d.status === "executing") {
    const doing = sends(d.kind) ? `Sending ${v}` : `Creating ${v} in Gmail`;
    return { state: "sending", status: "Sending", steps: steps("done", ["Approved", "done"], [doing, "current"], v), notice: plain(`${doing}. Attache marks it ${sends(d.kind) ? "sent" : "created"} only after ${service} confirms it. This keeps running if you close the tab.`), actions: [], editor: "off" };
  }
  if (d.status === "succeeded") {
    const at = str(receipt.verifiedAt) ?? str(receipt.at) ?? d.updatedAt;
    return finished({ state: "sent", status: lastStep(d), steps: steps("done", ["Approved", "done"], [`${lastStep(d)} ${clock.time(at)}, verified`, "done"], v), notice: plain(`${lastStep(d)} at ${clock.time(at)} and verified on ${service}.`), actions: openOn });
  }
  const error = str(receipt.error);
  if (d.status === "failed") {
    const why = receipt.attempted === false ? `Attache stopped before calling ${service}` : `${service} refused it`;
    return finished({
      state: "not_sent",
      status: "Not sent",
      steps: steps("done", ["Approved", "done"], ["Not sent", "failed"], v),
      notice: { tone: "danger", warning: true, lines: [`Not sent. ${why}${error ? `: ${error}` : "."}`, "This Draft is finished. It cannot be edited or sent again."] },
      actions: [button("copy", "Copy text"), ...prepare, ...openOn],
    });
  }
  const thing = targetThing(d);
  const check = uncertainTargetUrl(d);
  return finished({
    state: "unknown",
    status: "Outcome unknown",
    steps: steps("done", ["Approved", "done"], ["Outcome unknown", "unknown"], v),
    notice: unknownOutcomeNotice(d),
    actions: [...(check ? [button("open-target", thing.startsWith("the ") ? `Open ${thing}` : `Open ${service}`)] : []), button("copy", "Copy text")],
  });
}

/**
 * What a send of unknown outcome means, with the receipt's error and note: the Draft's page and the Inbox item it
 * came from (Delivery unconfirmed) say the same words.
 */
export function unknownOutcomeNotice(d: ActionView): DraftNotice {
  const receipt = rec(d.receipt);
  return attention(`The outcome could not be verified. The request may have reached ${draftService(d)}. Check ${targetThing(d)} before you do anything else.`, ...[str(receipt.error), str(receipt.note)].filter((l): l is string => l !== null));
}

/** A Draft that is finished without being sent: rejected (restorable until it expires) or expired. */
function notSentFinal(d: ActionView, now: number, clock: DraftClock): DraftScreen {
  const v = `v${d.version}`;
  const prepare = str(rec(rec(d.context).item).id) ? [button("prepare", "Prepare a new Draft")] : [];
  if (d.status === "expired") {
    return finished({ state: "expired", status: "Expired", steps: null, notice: plain(`Expired ${clock.day(d.expiresAt)}, 48 business hours after it was prepared. Nothing was sent.`), actions: [button("copy", "Copy text"), ...prepare] });
  }
  const at = d.events.findLast((e) => e.event === "rejected")?.at ?? d.updatedAt;
  const restorable = Date.parse(d.expiresAt) > now;
  const restore = `Restore as v${d.version + 1}`;
  return finished({
    state: "rejected",
    status: "Rejected",
    steps: null,
    notice: plain(`You rejected ${v} at ${clock.time(at)}. Nothing was sent.`, restorable ? `${restore} brings it back as a Draft. It can be restored until ${clock.day(d.expiresAt)}.` : `It expired at ${clock.day(d.expiresAt)}, so it can no longer be restored.`),
    actions: [...(restorable ? [button("restore", restore, { primary: true })] : []), button("copy", "Copy text")],
  });
}

/** The page for the stored Draft alone, as if the editor held its text. */
function stored(input: DraftStateInput): DraftScreen {
  const { draft: d, editor, now, clock } = input;
  if (d.status === "rejected" || d.status === "expired") return notSentFinal(d, now, clock);
  if (d.status === "approved" && d.approval && !approvalEnded(d, now)) return approved(d, d.approval, clock);
  if (d.status === "revoked") return revoked(d, editor, clock);
  if (d.status === "executing" || d.status === "succeeded" || d.status === "failed" || d.status === "unknown") return afterSend(d, clock);
  return waitingForApproval(d, editor, now, clock);
}

/** The stored statuses whose text the owner can change. A rejected Draft is locked until it is restored. */
export const EDITABLE_STATUSES: ReadonlySet<string> = new Set(["draft", "approved", "revoked"]);

function unsaved(d: ActionView, base: DraftScreen): DraftScreen {
  const v = `v${d.version}`;
  const wait = "Save or discard your changes first.";
  return {
    ...base,
    state: "unsaved",
    notice: plain(`Saving creates v${d.version + 1} and replaces the text of ${v}, which is not kept.${d.status === "approved" ? ` It also cancels the approval of ${v}.` : ""}`),
    actions: [button("save", `Save as v${d.version + 1}`, { primary: true }), button("discard", "Discard changes"), button("approve", `Approve ${v}`, { disabled: wait }), button("send", sendLabel(d), { disabled: wait }), button("reject", "Reject")],
    editor: "on",
  };
}

function changedElsewhere(d: ActionView, editor: DraftEditor, base: DraftScreen): DraftScreen {
  const v = `v${d.version}`;
  const what =
    d.version !== editor.baseVersion
      ? `This Draft became ${v} while you were editing. Your text is not saved, and any approval of v${editor.baseVersion} no longer applies.`
      : `This Draft changed while you were editing: it is now ${base.status}. Your text is not saved.`;
  // A warning the stored state carries (a failed or unknown send) stays, with the way to check the destination.
  const lines = [what, ...(base.notice.warning ? base.notice.lines : [])];
  const wait = `Load ${v} first.`;
  // Approve and Send show, waiting, only while the stored Draft could still take them.
  const waiting = EDITABLE_STATUSES.has(d.status) ? [button("approve", `Approve ${v}`, { disabled: wait }), button("send", sendLabel(d), { disabled: wait })] : [];
  return {
    ...base,
    state: "changed_elsewhere",
    notice: { tone: base.notice.tone === "danger" ? "danger" : "attention", warning: true, lines },
    actions: [button("copy-mine", "Copy my text"), button("load", `Load ${v}`, { primary: true }), ...waiting, ...base.actions.filter((b) => b.id === "open-target")],
    editor: "on",
  };
}

/**
 * The page for a Draft and the editor beside it. Unsaved text on a Draft that moved on (a newer version, or a status
 * that cannot be edited) is Changed elsewhere, so the owner's words are never dropped without a choice.
 */
export function draftScreen(input: DraftStateInput): DraftScreen {
  const { draft: d, editor } = input;
  const base = stored(input);
  if (!editor.dirty) return base;
  if (d.version !== editor.baseVersion || !EDITABLE_STATUSES.has(d.status)) return changedElsewhere(d, editor, base);
  return unsaved(d, base);
}
