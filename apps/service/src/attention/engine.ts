import { randomUUID } from "node:crypto";
import type { AttentionItemView, Coverage } from "@jarvis/contracts";
import { type Db, json, nowIso, tx } from "../core/db.ts";
import { fingerprint } from "./fingerprint.ts";
import type { AttentionCandidate } from "../connectors/types.ts";
import { isFullyCovered } from "../connectors/types.ts";

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
}

interface ItemRow {
  id: string;
  item_key: string;
  fingerprint: string;
  state: string;
  snooze_until: string | null;
  decided_fingerprint: string | null;
  source_kind: string;
  connection_id: string | null;
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
): ApplyResult {
  const out: ApplyResult = { created: [], changed: [], unchanged: [], resolved: [], keptDismissed: [], reopened: [] };
  const now = nowIso();
  tx(db, () => {
    const existing = db
      .prepare(`select id, item_key, fingerprint, state, snooze_until, decided_fingerprint, source_kind, connection_id from attention_items where source_kind = ? and coalesce(connection_id,'') = coalesce(?, '')`)
      .all(source.sourceKind, source.connectionId) as unknown as ItemRow[];
    const byKey = new Map(existing.map((r) => [r.item_key, r]));
    const seen = new Set<string>();
    for (const c of candidates) {
      if (seen.has(c.key)) continue;
      seen.add(c.key);
      const prev = byKey.get(c.key) ?? (db.prepare("select id, item_key, fingerprint, state, snooze_until, decided_fingerprint, source_kind, connection_id from attention_items where item_key = ?").get(c.key) as unknown as ItemRow | undefined);
      if (!prev) {
        db.prepare(
          `insert into attention_items (id, item_key, fingerprint, kind, title, summary, why, source_kind, connection_id, evidence, url, due_at, priority, state, first_seen_at, updated_at, last_briefing_id, draftable)
           values (?,?,?,?,?,?,?,?,?,?,?,?,?, 'open', ?, ?, ?, ?)`,
        ).run(randomUUID(), c.key, c.fingerprint, c.kind, c.title, c.summary, c.why, c.sourceKind, c.connectionId, JSON.stringify(c.evidence), c.url ?? null, c.dueAt ?? null, c.priority, now, now, briefingId, c.draftable ? JSON.stringify(c.draftable) : null);
        out.created.push(c.key);
        continue;
      }
      // A user "done" decision on this exact evidence also stays closed; an auto-resolved item that reappears reopens.
      if (prev.fingerprint === c.fingerprint && (prev.state !== "resolved" || prev.decided_fingerprint === c.fingerprint)) {
        out.unchanged.push(c.key);
        if (prev.state === "dismissed") out.keptDismissed.push(c.key);
        // Refresh evidence timestamps without touching state or alerting again.
        db.prepare("update attention_items set evidence = ?, title = ?, summary = ?, draftable = ? where id = ?").run(JSON.stringify(c.evidence), c.title, c.summary, c.draftable ? JSON.stringify(c.draftable) : null, prev.id);
        continue;
      }
      // Evidence changed (or a resolved item came back).
      let state = "open";
      if (prev.state === "snoozed" && prev.snooze_until && prev.snooze_until > now) state = "snoozed";
      if ((prev.state === "dismissed" || prev.state === "resolved") && prev.decided_fingerprint !== c.fingerprint) out.reopened.push(c.key);
      db.prepare(
        `update attention_items set fingerprint = ?, kind = ?, title = ?, summary = ?, why = ?, evidence = ?, url = ?, due_at = ?, priority = ?, state = ?, updated_at = ?, last_briefing_id = ?, source_kind = ?, connection_id = ?, draftable = ? where id = ?`,
      ).run(c.fingerprint, c.kind, c.title, c.summary, c.why, JSON.stringify(c.evidence), c.url ?? null, c.dueAt ?? null, c.priority, state, now, briefingId, c.sourceKind, c.connectionId, c.draftable ? JSON.stringify(c.draftable) : null, prev.id);
      out.changed.push(c.key);
    }
    const canResolve = isFullyCovered(source.coverage) && isFullyCovered(source.previousCoverage);
    if (canResolve) {
      for (const r of existing) {
        if (!seen.has(r.item_key) && r.state !== "resolved") {
          db.prepare("update attention_items set state = 'resolved', updated_at = ? where id = ?").run(now, r.id);
          out.resolved.push(r.item_key);
        }
      }
    }
  });
  return out;
}

export function decide(db: Db, id: string, decision: "dismiss" | "snooze" | "reopen" | "done", actor: string, until?: string): AttentionItemView {
  const row = db.prepare("select * from attention_items where id = ?").get(id) as Record<string, string> | undefined;
  if (!row) throw new Error("not_found");
  const now = nowIso();
  if (decision === "snooze" && (!until || until <= now)) throw new Error("Snooze needs a future time");
  const state = decision === "dismiss" ? "dismissed" : decision === "snooze" ? "snoozed" : decision === "done" ? "resolved" : "open";
  tx(db, () => {
    db.prepare("update attention_items set state = ?, snooze_until = ?, decided_fingerprint = ?, updated_at = ? where id = ?").run(state, decision === "snooze" ? until! : null, decision === "reopen" ? null : row.fingerprint!, now, id);
    db.prepare("insert into attention_decisions (item_key, fingerprint, decision, until, at, actor) values (?,?,?,?,?,?)").run(row.item_key!, row.fingerprint!, decision, until ?? null, now, actor);
  });
  return getItem(db, id)!;
}

/** Reopen snoozed items whose time has passed. */
export function wakeSnoozed(db: Db, now = nowIso()): number {
  return Number(db.prepare("update attention_items set state = 'open', snooze_until = null, updated_at = ? where state = 'snoozed' and snooze_until <= ?").run(now, now).changes);
}

export function getItem(db: Db, id: string): AttentionItemView | null {
  const r = db.prepare("select * from attention_items where id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? toView(r) : null;
}

export function listItems(db: Db, opts: { states?: string[]; limit?: number } = {}): AttentionItemView[] {
  const states = opts.states ?? ["open"];
  const rows = db
    .prepare(`select * from attention_items where state in (${states.map(() => "?").join(",")}) order by priority desc, coalesce(due_at, '9999') asc, updated_at desc limit ?`)
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
