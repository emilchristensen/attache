import { createHash, randomBytes, randomUUID } from "node:crypto";
import { approvalEndedAt, WAITING_ACTION_STATUSES, type ActionStatus, type ActionView } from "@attache/contracts";
import { type Db, json, tx } from "../core/db.ts";
import { addBusinessHours, DRAFT_BUSINESS_HOURS } from "./expiry.ts";

export const APPROVAL_TTL_MS = 15 * 60_000;

/**
 * Why an item whose last Draft has a send of unknown outcome is not drafted again: only the owner's explicit choice
 * (`replaceUnconfirmed`) prepares a replacement. The route refuses with it, and a Draft job checks again when it runs.
 */
export const DELIVERY_UNCONFIRMED_MESSAGE = "The last Draft for this item may have been sent. Check the destination, then choose to prepare a replacement.";

export class ActionError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Canonical JSON: sorted keys, so the hash binds content rather than key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

export function payloadHash(kind: string, target: unknown, payload: unknown): string {
  return createHash("sha256").update(canonicalJson({ kind, target, payload })).digest("hex");
}

export interface AuthorityCheck {
  /** Returns null when allowed, or a reason. Checked on the server immediately before execution. */
  (action: ActionView): string | null;
}

export class ActionService {
  private readonly db: Db;
  authority: AuthorityCheck = () => "No authority configured";
  /** The service's clock: when drafts and approvals expire, and the time every change is stamped with. */
  private readonly now: () => Date;

  constructor(db: Db, now: () => Date) {
    this.db = db;
    this.now = now;
  }

  private event(id: string, event: string, actor: string, data: unknown = null) {
    this.db.prepare("insert into action_events (action_id, event, data, at, actor) values (?,?,?,?,?)").run(id, event, data === null ? null : JSON.stringify(data), this.now().toISOString(), actor);
  }

  createDraft(input: { kind: string; connectionId: string | null; title: string; target: Record<string, unknown>; payload: Record<string, unknown>; context: Record<string, unknown>; attentionItemKey?: string | null; createdBy: string }): ActionView {
    const hash = payloadHash(input.kind, input.target, input.payload);
    // Refreshing a draft for the same item keeps its original creation and expiry,
    // so a periodically regenerated draft cannot postpone its own expiry.
    if (input.attentionItemKey) {
      const existing = this.db.prepare("select id, status from actions where attention_item_key = ? and kind = ? and status in ('draft','approved','revoked') order by created_at desc limit 1").get(input.attentionItemKey, input.kind) as { id: string } | undefined;
      if (existing) {
        const current = this.get(existing.id)!;
        if (current.payloadHash === hash) return current;
        return this.edit(existing.id, input.payload, current.version, input.createdBy, input.context);
      }
    }
    const id = randomUUID();
    const created = this.now();
    tx(this.db, () => {
      this.db
        .prepare(
          `insert into actions (id, kind, connection_id, title, target, payload, payload_hash, version, context, status, expires_at, created_at, updated_at, created_by, attention_item_key)
           values (?,?,?,?,?,?,?,1,?, 'draft', ?, ?, ?, ?, ?)`,
        )
        .run(id, input.kind, input.connectionId, input.title, JSON.stringify(input.target), JSON.stringify(input.payload), hash, JSON.stringify(input.context), addBusinessHours(created, DRAFT_BUSINESS_HOURS).toISOString(), created.toISOString(), created.toISOString(), input.createdBy, input.attentionItemKey ?? null);
      this.event(id, "created", input.createdBy, { version: 1, payloadHash: hash });
      if (input.attentionItemKey) this.db.prepare("update attention_items set action_id = ? where item_key = ?").run(id, input.attentionItemKey);
    });
    return this.get(id)!;
  }

  get(id: string): ActionView | null {
    const r = this.db.prepare("select * from actions where id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    const events = (this.db.prepare("select event, data, at, actor from action_events where action_id = ? order by id").all(id) as Array<Record<string, unknown>>).map((e) => ({ event: String(e.event), data: json(e.data, null), at: String(e.at), actor: String(e.actor) }));
    const view: ActionView = {
      id: String(r.id),
      kind: String(r.kind),
      connectionId: (r.connection_id as string) ?? null,
      title: String(r.title),
      target: json(r.target, {}),
      payload: json(r.payload, {}),
      payloadHash: String(r.payload_hash),
      version: Number(r.version),
      context: json(r.context, {}),
      status: r.status as ActionStatus,
      expiresAt: String(r.expires_at),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      approval: json(r.approval, null),
      receipt: json(r.receipt, null),
      events,
      executable: { ok: false, reason: null },
    };
    view.executable = this.executability(view);
    return view;
  }

  list(opts: { status?: string[]; limit?: number } = {}): ActionView[] {
    const status = opts.status;
    const rows = (status?.length
      ? this.db.prepare(`select id from actions where status in (${status.map(() => "?").join(",")}) order by updated_at desc limit ?`).all(...status, opts.limit ?? 100)
      : this.db.prepare("select id from actions order by updated_at desc limit ?").all(opts.limit ?? 100)) as Array<{ id: string }>;
    return rows.map((r) => this.get(r.id)!);
  }

  /** How many Drafts wait for the owner (`WAITING_ACTION_STATUSES`), however many there are. Settle stale ones first. */
  countWaiting(): number {
    const row = this.db.prepare(`select count(*) n from actions where status in (${WAITING_ACTION_STATUSES.map(() => "?").join(",")})`).get(...WAITING_ACTION_STATUSES) as { n: number };
    return Number(row.n);
  }

  private require(id: string): ActionView {
    const a = this.get(id);
    if (!a) throw new ActionError("not_found", "Action not found", 404);
    return a;
  }

  private isExpired(a: ActionView): boolean {
    return a.expiresAt <= this.now().toISOString();
  }

  edit(id: string, payload: Record<string, unknown>, expectedVersion: number, actor: string, context?: Record<string, unknown>): ActionView {
    const a = this.require(id);
    if (a.version !== expectedVersion) throw new ActionError("version_conflict", `The draft changed (now version ${a.version}); reload before editing.`);
    if (a.status === "rejected") throw new ActionError("not_editable", "A rejected Draft cannot be edited. Restore it first.");
    if (!["draft", "approved", "revoked"].includes(a.status)) throw new ActionError("not_editable", `A ${a.status} action cannot be edited.`);
    if (this.isExpired(a)) throw new ActionError("expired", "This draft has expired.");
    const hash = payloadHash(a.kind, a.target, payload);
    const version = a.version + 1;
    tx(this.db, () => {
      this.db.prepare("update actions set payload = ?, payload_hash = ?, version = ?, status = 'draft', approval = null, updated_at = ?" + (context ? ", context = ?" : "") + " where id = ?").run(JSON.stringify(payload), hash, version, this.now().toISOString(), ...(context ? [JSON.stringify(context)] : []), id);
      this.event(id, "edited", actor, { version, payloadHash: hash });
      if (a.approval) this.event(id, "approval_invalidated", "service", { reason: "payload changed", previousVersion: a.version });
    });
    return this.get(id)!;
  }

  approve(id: string, version: number, hash: string, actor: string): ActionView {
    const a = this.require(id);
    if (a.status !== "draft" && a.status !== "revoked") throw new ActionError("not_approvable", `A ${a.status} action cannot be approved.`);
    if (this.isExpired(a)) throw new ActionError("expired", "This draft has expired.");
    if (a.version !== version || a.payloadHash !== hash) throw new ActionError("stale_approval", "The draft changed since you reviewed it. Review the current version.");
    const nowMs = this.now().getTime();
    const approval = { version, payloadHash: hash, nonce: randomBytes(24).toString("hex"), expiresAt: new Date(Math.min(nowMs + APPROVAL_TTL_MS, Date.parse(a.expiresAt))).toISOString(), approvedAt: new Date(nowMs).toISOString() };
    tx(this.db, () => {
      this.db.prepare("update actions set status = 'approved', approval = ?, updated_at = ? where id = ?").run(JSON.stringify(approval), this.now().toISOString(), id);
      this.event(id, "approved", actor, { version, payloadHash: hash, approvalExpiresAt: approval.expiresAt });
    });
    return this.get(id)!;
  }

  reject(id: string, actor: string, reason?: string): ActionView {
    const a = this.require(id);
    if (!["draft", "approved", "revoked"].includes(a.status)) throw new ActionError("not_rejectable", `A ${a.status} action cannot be rejected.`);
    tx(this.db, () => {
      this.db.prepare("update actions set status = 'rejected', approval = null, updated_at = ? where id = ?").run(this.now().toISOString(), id);
      this.event(id, "rejected", actor, reason ? { reason } : null);
    });
    return this.get(id)!;
  }

  /**
   * Undo a rejection: the same text comes back as a new version in `draft`, until the Draft's own lifetime ends.
   * Refused when another Draft for the same Inbox item already waits or is being sent, so one item never has two.
   */
  restore(id: string, expectedVersion: number, actor: string): ActionView {
    const a = this.require(id);
    if (a.status !== "rejected") throw new ActionError("not_restorable", `A ${a.status} action cannot be restored; only a rejected Draft can.`);
    if (a.version !== expectedVersion) throw new ActionError("version_conflict", `The draft changed (now version ${a.version}); reload before restoring.`);
    if (this.isExpired(a)) throw new ActionError("expired", "This draft has expired, so it can no longer be restored.");
    const key = (this.db.prepare("select attention_item_key k from actions where id = ?").get(id) as { k: string | null }).k;
    if (key) {
      const open = this.db.prepare("select id from actions where attention_item_key = ? and id <> ? and status in ('draft','approved','revoked','executing') limit 1").get(key, id);
      if (open) throw new ActionError("superseded", "A newer Draft for the same item is open. Reject it before restoring this one.");
    }
    const version = a.version + 1;
    tx(this.db, () => {
      this.db.prepare("update actions set status = 'draft', version = ?, approval = null, updated_at = ? where id = ?").run(version, this.now().toISOString(), id);
      this.event(id, "restored", actor, { version, payloadHash: a.payloadHash });
      if (key) this.db.prepare("update attention_items set action_id = ? where item_key = ?").run(id, key);
    });
    return this.get(id)!;
  }

  revoke(id: string, actor: string, reason = "approval revoked"): ActionView {
    const a = this.require(id);
    if (a.status !== "approved") throw new ActionError("not_approved", "Only an approved action can have its approval revoked.");
    tx(this.db, () => {
      this.db.prepare("update actions set status = 'revoked', approval = null, updated_at = ? where id = ?").run(this.now().toISOString(), id);
      this.event(id, "approval_revoked", actor, { reason });
    });
    return this.get(id)!;
  }

  /** Revoke approvals of actions that depend on a connection or write permission that went away. */
  revokeWhere(pred: (a: ActionView) => boolean, reason: string): string[] {
    const affected = this.list({ status: ["approved"], limit: 500 }).filter(pred);
    for (const a of affected) this.revoke(a.id, "service", reason);
    return affected.map((a) => a.id);
  }

  /**
   * Settle every time limit that has passed: a draft past its expiry becomes
   * `expired`, and an approval past its end goes back to `draft` with the
   * approval cleared, so the owner can approve it again. Draft expiry runs
   * first, because an approval never outlives its draft.
   */
  expireStale(): { expired: string[]; approvalsEnded: string[] } {
    const now = this.now().toISOString();
    const expired = (this.db.prepare("select id from actions where status in ('draft','approved','revoked') and expires_at <= ?").all(now) as Array<{ id: string }>).map((r) => r.id);
    for (const id of expired) {
      tx(this.db, () => {
        this.db.prepare("update actions set status = 'expired', approval = null, updated_at = ? where id = ?").run(now, id);
        this.event(id, "expired", "service");
      });
    }
    const ended = this.approvedRows().filter((r) => r.approval.expiresAt <= now);
    for (const r of ended) {
      tx(this.db, () => {
        this.db.prepare("update actions set status = 'draft', approval = null, updated_at = ? where id = ?").run(now, r.id);
        this.event(r.id, "approval_expired", "service", { version: r.approval.version, approvalExpiresAt: r.approval.expiresAt });
      });
    }
    return { expired, approvalsEnded: ended.map((r) => r.id) };
  }

  /** When the next approval ends, so housekeeping can wake exactly then; null when nothing is approved. */
  nextApprovalEnd(): Date | null {
    const ends = this.approvedRows().map((r) => Date.parse(r.approval.expiresAt));
    return ends.length ? new Date(Math.min(...ends)) : null;
  }

  private approvedRows(): Array<{ id: string; approval: NonNullable<ActionView["approval"]> }> {
    const rows = this.db.prepare("select id, approval from actions where status = 'approved' and approval is not null").all() as Array<{ id: string; approval: string }>;
    return rows.flatMap((r) => {
      const approval = json<ActionView["approval"]>(r.approval, null);
      return approval ? [{ id: r.id, approval }] : [];
    });
  }

  executability(a: ActionView): { ok: boolean; reason: string | null } {
    if (a.status !== "approved" || !a.approval) return { ok: false, reason: a.status === "succeeded" ? "Already executed" : "Needs approval" };
    if (this.isExpired(a)) return { ok: false, reason: "Draft expired" };
    if (a.approval.expiresAt <= this.now().toISOString()) return { ok: false, reason: "Approval expired; approve again" };
    const reason = this.authority(a);
    return reason ? { ok: false, reason } : { ok: true, reason: null };
  }

  /**
   * Validate an execution request and move the action to `executing`. All
   * checks happen here, on the server, immediately before execution: status,
   * binding (version, payload hash), single-use nonce, expiry and authority.
   */
  beginExecution(id: string, req: { nonce: string; version: number; payloadHash: string }, actor: string): ActionView {
    const fail = (code: string, message: string): never => {
      throw new ActionError(code, message);
    };
    try {
      return this.validateAndStart(id, req, actor, fail);
    } catch (e) {
      // Refusals are recorded outside the rolled-back transaction so every attempt leaves a receipt.
      if (e instanceof ActionError && e.code !== "not_found") this.event(id, "execution_refused", actor, { code: e.code, message: e.message });
      throw e;
    }
  }

  private validateAndStart(id: string, req: { nonce: string; version: number; payloadHash: string }, actor: string, fail: (code: string, message: string) => never): ActionView {
    return tx(this.db, () => {
      const a = this.require(id);
      const used = this.db.prepare("select action_id from approval_nonces where nonce = ?").get(req.nonce);
      if (used) fail("replayed", "This approval was already used.");
      if (approvalEndedAt(a)) fail("approval_expired", "The approval expired; approve again.");
      if (a.status !== "approved" || !a.approval) fail("not_approved", `Action is ${a.status}, not approved.`);
      if (a.approval!.nonce !== req.nonce) fail("approval_mismatch", "The approval does not match this action.");
      if (req.version !== a.version || req.payloadHash !== a.payloadHash || a.approval!.version !== a.version || a.approval!.payloadHash !== a.payloadHash) fail("payload_changed", "The action changed after approval.");
      if (payloadHash(a.kind, a.target, a.payload) !== a.payloadHash) fail("payload_changed", "Stored payload does not match its approved hash.");
      const now = this.now().toISOString();
      if (a.expiresAt <= now) fail("expired", "The draft expired.");
      if (a.approval!.expiresAt <= now) fail("approval_expired", "The approval expired; approve again.");
      const reason = this.authority(a);
      if (reason) fail("not_authorized", reason);
      this.db.prepare("insert into approval_nonces (nonce, action_id, used_at) values (?,?,?)").run(req.nonce, id, now);
      this.db.prepare("update actions set status = 'executing', updated_at = ? where id = ?").run(now, id);
      this.event(id, "execution_started", actor, { version: a.version });
      return this.get(id)!;
    });
  }

  finishExecution(id: string, outcome: { status: "succeeded" | "failed" | "unknown"; receipt: Record<string, unknown> }): ActionView {
    tx(this.db, () => {
      this.db.prepare("update actions set status = ?, receipt = ?, updated_at = ? where id = ?").run(outcome.status, JSON.stringify(outcome.receipt), this.now().toISOString(), id);
      this.event(id, `execution_${outcome.status}`, "service", outcome.receipt);
    });
    return this.get(id)!;
  }
}

export const newEffectKey = (actionId: string, version: number) => `action:${actionId}:v${version}`;
export { randomUUID };
