import { randomUUID } from "node:crypto";
import type { ActionStatus, AttentionItemView, Coverage } from "@attache/contracts";
import { type Db, json, nowIso, tx } from "../core/db.ts";
import { fingerprint } from "./fingerprint.ts";
import type { AttentionCandidate } from "../connectors/types.ts";
import { isFullyCovered } from "../connectors/types.ts";
import { deriveState, INBOX_RECORD_VERSION, type InboxDecisionKind, type InboxDecisionPart, type InboxItemPart, type InboxMachine, type InboxRecord } from "./inbox-record.ts";

export interface CandidateWithSource extends AttentionCandidate {
  sourceKind: string;
  connectionId: string | null;
  fingerprint: string;
  evidence: AttentionItemView["evidence"];
}

export interface ApplyResult {
  created: string[];
  changed: string[];
  unchanged: string[];
  resolved: string[];
  keptDismissed: string[];
  reopened: string[];
  /** Keys whose replicated record changed, so its file in the Brain must be written. */
  touched: string[];
}

/** When "now" is and which Machine is writing; tests and old callers get the system clock and no Machine. */
export interface InboxContext {
  now: () => string;
  machine: () => InboxMachine | null;
}

const SYSTEM: InboxContext = { now: nowIso, machine: () => null };

interface ItemRow {
  id: string;
  item_key: string;
  fingerprint: string;
  kind: string;
  title: string;
  summary: string;
  why: string | null;
  source_kind: string;
  connection_id: string | null;
  evidence: string;
  url: string | null;
  due_at: string | null;
  priority: number;
  state: AttentionItemView["state"];
  snooze_until: string | null;
  decided_fingerprint: string | null;
  first_seen_at: string;
  updated_at: string;
  last_briefing_id: string | null;
  action_id: string | null;
  draftable: string | null;
  resolved_at: string | null;
  decision: string | null;
  machine: string | null;
}

/**
 * An item row with the status of the draft it links to. The link is never cleared: a finished draft keeps it,
 * and the next draft prepared for the item replaces it, so the status is read here instead of being copied onto the row.
 */
const SELECT_VIEW = "select i.*, a.status as action_status from attention_items i left join actions a on a.id = i.action_id";

function rowByKey(db: Db, key: string): ItemRow | undefined {
  return db.prepare("select * from attention_items where item_key = ?").get(key) as unknown as ItemRow | undefined;
}

/** The replicated record of a row: everything but this Machine's own links (drafts, briefings). */
export function recordOfRow(r: ItemRow): InboxRecord {
  return {
    version: INBOX_RECORD_VERSION,
    id: r.id,
    key: r.item_key,
    item: {
      fingerprint: r.fingerprint,
      kind: r.kind,
      title: r.title,
      summary: r.summary,
      why: r.why ?? null,
      sourceKind: r.source_kind,
      connectionId: r.connection_id ?? null,
      url: r.url ?? null,
      dueAt: r.due_at ?? null,
      priority: Number(r.priority),
      evidence: json(r.evidence, []),
      draftable: json(r.draftable, null),
      firstSeenAt: r.first_seen_at,
      updatedAt: r.updated_at,
      resolvedAt: r.resolved_at ?? null,
      machine: json(r.machine, null),
    },
    decision: json<InboxDecisionPart | null>(r.decision, null),
  };
}

export function recordByKey(db: Db, key: string): InboxRecord | null {
  const r = rowByKey(db, key);
  return r ? recordOfRow(r) : null;
}

function allRows(db: Db): ItemRow[] {
  return db.prepare("select * from attention_items order by item_key").all() as unknown as ItemRow[];
}

export function allRecords(db: Db): InboxRecord[] {
  return allRows(db).map(recordOfRow);
}

/**
 * Store a record as this Machine's row, with its state worked out at `now`.
 * The row keeps its local links to drafts and briefings; `briefingId` replaces the briefing link when given.
 */
export function storeRecord(db: Db, rec: InboxRecord, now: string, briefingId?: string | null): AttentionItemView["state"] {
  const { item, decision } = rec;
  const derived = deriveState(item, decision, now);
  const values = [
    rec.id, item.fingerprint, item.kind, item.title, item.summary, item.why, item.sourceKind, item.connectionId, JSON.stringify(item.evidence), item.url, item.dueAt, item.priority,
    derived.state, derived.snoozeUntil, derived.decidedFingerprint, item.firstSeenAt, item.updatedAt, item.draftable ? JSON.stringify(item.draftable) : null,
    item.resolvedAt, decision ? JSON.stringify(decision) : null, item.machine ? JSON.stringify(item.machine) : null,
  ] as const;
  const prev = rowByKey(db, rec.key);
  if (!prev) {
    db.prepare(
      `insert into attention_items (id, fingerprint, kind, title, summary, why, source_kind, connection_id, evidence, url, due_at, priority, state, snooze_until, decided_fingerprint, first_seen_at, updated_at, draftable, resolved_at, decision, machine, item_key, last_briefing_id)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(...values, rec.key, briefingId ?? null);
  } else {
    db.prepare(
      `update attention_items set id = ?, fingerprint = ?, kind = ?, title = ?, summary = ?, why = ?, source_kind = ?, connection_id = ?, evidence = ?, url = ?, due_at = ?, priority = ?,
         state = ?, snooze_until = ?, decided_fingerprint = ?, first_seen_at = ?, updated_at = ?, draftable = ?, resolved_at = ?, decision = ?, machine = ?, last_briefing_id = ?
       where item_key = ?`,
    ).run(...values, briefingId === undefined ? prev.last_briefing_id : briefingId, rec.key);
  }
  return derived.state;
}

function itemOf(c: CandidateWithSource, firstSeenAt: string, now: string, machine: InboxMachine | null): InboxItemPart {
  return {
    fingerprint: c.fingerprint,
    kind: c.kind,
    title: c.title,
    summary: c.summary,
    why: c.why ?? null,
    sourceKind: c.sourceKind,
    connectionId: c.connectionId,
    url: c.url ?? null,
    dueAt: c.dueAt ?? null,
    priority: c.priority,
    evidence: c.evidence,
    draftable: c.draftable ?? null,
    firstSeenAt,
    updatedAt: now,
    resolvedAt: null,
    machine,
  };
}

/** Whether the source said something new about the item, beyond when it last looked. */
function reworded(prev: InboxItemPart, c: CandidateWithSource): boolean {
  return prev.title !== c.title || prev.summary !== c.summary || JSON.stringify(prev.draftable) !== JSON.stringify(c.draftable ?? null);
}

/**
 * Apply one source's candidates to the attention inbox.
 *
 * - New key → open item.
 * - Same key, same fingerprint → no change (dismissed stays dismissed; no repeat alert).
 * - Same key, new fingerprint → updated; a dismissed/done item reopens because its evidence changed.
 * - Key absent → resolved only when this source was fully covered now AND on its previous run.
 */
export function applyCandidates(
  db: Db,
  source: { sourceKind: string; connectionId: string | null; coverage: Coverage; previousCoverage: Coverage | null },
  candidates: CandidateWithSource[],
  briefingId: string | null = null,
  ctx: InboxContext = SYSTEM,
): ApplyResult {
  const out: ApplyResult = { created: [], changed: [], unchanged: [], resolved: [], keptDismissed: [], reopened: [], touched: [] };
  const now = ctx.now();
  const machine = ctx.machine();
  tx(db, () => {
    const existing = db
      .prepare("select * from attention_items where source_kind = ? and coalesce(connection_id,'') = coalesce(?, '')")
      .all(source.sourceKind, source.connectionId) as unknown as ItemRow[];
    const seen = new Set<string>();
    for (const c of candidates) {
      if (seen.has(c.key)) continue;
      seen.add(c.key);
      const prev = rowByKey(db, c.key);
      if (!prev) {
        storeRecord(db, { version: INBOX_RECORD_VERSION, id: randomUUID(), key: c.key, item: itemOf(c, now, now, machine), decision: null }, now, briefingId);
        out.created.push(c.key);
        out.touched.push(c.key);
        continue;
      }
      const rec = recordOfRow(prev);
      if (prev.fingerprint === c.fingerprint && !rec.item.resolvedAt) {
        // Same evidence: refresh what it says without alerting again; it replicates only when its wording changed.
        const again = reworded(rec.item, c);
        storeRecord(db, { ...rec, item: { ...rec.item, title: c.title, summary: c.summary, evidence: c.evidence, draftable: c.draftable ?? null, ...(again ? { updatedAt: now, machine } : {}) } }, now);
        if (again) out.touched.push(c.key);
        out.unchanged.push(c.key);
        if (prev.state === "dismissed") out.keptDismissed.push(c.key);
        continue;
      }
      // Evidence changed, or an item its source had resolved came back.
      const state = storeRecord(db, { ...rec, item: itemOf(c, rec.item.firstSeenAt, now, machine) }, now, briefingId);
      out.touched.push(c.key);
      if (prev.fingerprint === c.fingerprint && state !== "open") {
        out.unchanged.push(c.key);
        continue;
      }
      if ((prev.state === "dismissed" || prev.state === "resolved") && state === "open") out.reopened.push(c.key);
      out.changed.push(c.key);
    }
    const canResolve = isFullyCovered(source.coverage) && isFullyCovered(source.previousCoverage);
    if (canResolve) {
      for (const r of existing) {
        if (seen.has(r.item_key) || r.state === "resolved") continue;
        const rec = recordOfRow(r);
        storeRecord(db, { ...rec, item: { ...rec.item, resolvedAt: now, updatedAt: now, machine } }, now);
        out.resolved.push(r.item_key);
        out.touched.push(r.item_key);
      }
    }
  });
  return out;
}

export function decide(db: Db, id: string, decision: InboxDecisionKind, actor: string, until?: string, ctx: InboxContext = SYSTEM): AttentionItemView {
  const row = db.prepare("select * from attention_items where id = ?").get(id) as unknown as ItemRow | undefined;
  if (!row) throw new Error("not_found");
  const now = ctx.now();
  if (decision === "snooze" && (!until || until <= now)) throw new Error("Snooze needs a future time");
  const part: InboxDecisionPart = { decision, fingerprint: row.fingerprint, until: decision === "snooze" ? until! : null, at: now, actor, machine: ctx.machine() };
  tx(db, () => {
    storeRecord(db, { ...recordOfRow(row), decision: part }, now);
    logDecision(db, row.item_key, part);
  });
  return getItem(db, id)!;
}

function logDecision(db: Db, key: string, d: InboxDecisionPart): void {
  db.prepare("insert into attention_decisions (item_key, fingerprint, decision, until, at, actor) values (?,?,?,?,?,?)").run(key, d.fingerprint, d.decision, d.until, d.at, d.machine ? `${d.actor} on ${d.machine.name}` : d.actor);
}

/**
 * Take in a record another Machine wrote. A decision this Machine has not seen
 * yet is added to its decision log. Returns whether anything changed here.
 */
export function takeRecord(db: Db, rec: InboxRecord, now: string): boolean {
  const prev = rowByKey(db, rec.key);
  const before = prev ? recordOfRow(prev) : null;
  if (before && JSON.stringify(before) === JSON.stringify(rec)) return false;
  tx(db, () => {
    storeRecord(db, rec, now);
    if (rec.decision && JSON.stringify(rec.decision) !== JSON.stringify(before?.decision ?? null)) logDecision(db, rec.key, rec.decision);
  });
  return true;
}

/**
 * Work every item's state out again from its record at `now`, and store it where the row held another
 * state, snooze time or decided fingerprint. Those columns are only this Machine's copy of what
 * the record gives: a database from an earlier release can hold one the record does not give,
 * which nothing else would correct. Returns the keys of the rows it corrected.
 */
export function rederiveStates(db: Db, now: string): string[] {
  return rederive(db, allRows(db), now);
}

/**
 * End the snoozes whose time has passed by `now`: the only states that change as time passes.
 * Each row takes the state its record gives; the record, its report time included, stays as it is.
 * Returns the keys of the items it woke.
 */
export function endSnoozes(db: Db, now: string): string[] {
  const due = db.prepare("select * from attention_items where state = 'snoozed' and snooze_until <= ?").all(now) as unknown as ItemRow[];
  return rederive(db, due, now);
}

/** Store each row's state as its record gives it at `now`, where the row held another. Returns the keys it corrected. */
function rederive(db: Db, rows: readonly ItemRow[], now: string): string[] {
  const stale = rows
    .map((row) => ({ row, rec: recordOfRow(row) }))
    .filter(({ row, rec }) => {
      const d = deriveState(rec.item, rec.decision, now);
      return d.state !== row.state || d.snoozeUntil !== (row.snooze_until ?? null) || d.decidedFingerprint !== (row.decided_fingerprint ?? null);
    });
  if (!stale.length) return [];
  tx(db, () => {
    for (const { rec } of stale) storeRecord(db, rec, now);
  });
  return stale.map(({ rec }) => rec.key);
}

/** Forget an item another Machine deleted. Returns whether it was here. */
export function forgetItem(db: Db, key: string): boolean {
  return Number(db.prepare("delete from attention_items where item_key = ?").run(key).changes) > 0;
}

function resolveRows(db: Db, rows: readonly ItemRow[], ctx: InboxContext): string[] {
  const now = ctx.now();
  tx(db, () => {
    for (const r of rows) {
      const rec = recordOfRow(r);
      storeRecord(db, { ...rec, item: { ...rec.item, resolvedAt: now, updatedAt: now, machine: ctx.machine() } }, now);
    }
  });
  return rows.map((r) => r.item_key);
}

/** A disconnected source no longer reports its items: resolve the ones still waiting. Returns their keys. */
export function resolveConnection(db: Db, connectionId: string, ctx: InboxContext = SYSTEM): string[] {
  const rows = db.prepare("select * from attention_items where connection_id = ? and state in ('open','snoozed')").all(connectionId) as unknown as ItemRow[];
  return resolveRows(db, rows, ctx);
}

/** A source's items it has not resolved yet, whatever the owner decided about them. */
export function unresolvedItems(db: Db, sourceKind: string): AttentionItemView[] {
  return (db.prepare(`${SELECT_VIEW} where i.source_kind = ? and i.resolved_at is null order by i.first_seen_at`).all(sourceKind) as Array<Record<string, unknown>>).map(toView);
}

/** Resolve items whose cause is gone, by key. Returns the keys of the items it resolved. */
export function resolveItems(db: Db, keys: readonly string[], ctx: InboxContext = SYSTEM): string[] {
  const rows = keys.map((k) => rowByKey(db, k)).filter((r): r is ItemRow => r !== undefined && r.resolved_at === null);
  return resolveRows(db, rows, ctx);
}

/** Delete a disconnected source's items, as the owner asked. Returns their keys. */
export function deleteConnection(db: Db, connectionId: string): string[] {
  const keys = (db.prepare("select item_key from attention_items where connection_id = ?").all(connectionId) as Array<{ item_key: string }>).map((r) => r.item_key);
  db.prepare("delete from attention_items where connection_id = ?").run(connectionId);
  return keys;
}

export function getItem(db: Db, id: string): AttentionItemView | null {
  const r = db.prepare(`${SELECT_VIEW} where i.id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? toView(r) : null;
}

export function listItems(db: Db, opts: { states?: string[]; limit?: number } = {}): AttentionItemView[] {
  const states = opts.states ?? ["open"];
  const rows = db
    .prepare(`${SELECT_VIEW} where i.state in (${states.map(() => "?").join(",")}) order by i.priority desc, coalesce(i.due_at, '9999') asc, i.updated_at desc limit ?`)
    .all(...states, opts.limit ?? 200) as Array<Record<string, unknown>>;
  return rows.map(toView);
}

function toView(r: Record<string, unknown>): AttentionItemView {
  return {
    id: String(r.id),
    key: String(r.item_key),
    kind: String(r.kind),
    title: String(r.title),
    summary: String(r.summary),
    why: (r.why as string) ?? null,
    sourceKind: String(r.source_kind),
    connectionId: (r.connection_id as string) ?? null,
    url: (r.url as string) ?? null,
    dueAt: (r.due_at as string) ?? null,
    priority: Number(r.priority),
    state: r.state as AttentionItemView["state"],
    snoozeUntil: (r.snooze_until as string) ?? null,
    evidence: json(r.evidence, []),
    firstSeenAt: String(r.first_seen_at),
    updatedAt: String(r.updated_at),
    actionId: (r.action_id as string) ?? null,
    actionStatus: (r.action_status as ActionStatus) ?? null,
    changedSinceDecision: !!r.decided_fingerprint && r.decided_fingerprint !== r.fingerprint,
    draftable: json(r.draftable, null),
  };
}

export function toCandidate(c: AttentionCandidate, obs: { fingerprintParts: Array<string | number | boolean | null>; url?: string; title: string; occurredAt?: string }, sourceKind: string, connectionId: string | null, observedAt: string): CandidateWithSource {
  return {
    ...c,
    sourceKind,
    connectionId,
    fingerprint: fingerprint([...obs.fingerprintParts, ...(c.extraFingerprint ?? [])]),
    evidence: [{ label: obs.title, ...(c.url || obs.url ? { url: c.url ?? obs.url } : {}), observedAt }],
  };
}
