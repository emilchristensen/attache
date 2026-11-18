import { useEffect, useMemo, useState } from "react";
import type { AttentionItemView } from "@attache/contracts";
import { frozenList, ordered, type InboxOrder } from "../inbox-view.ts";
import type { RowDecision } from "./InboxRow.tsx";
import { orderMark } from "../live.ts";

/**
 * The Inbox's frozen list. The rows the owner sees keep their order while the live list changes underneath: an
 * item that arrives waits behind Show new items, and a row decided here stays in its place as one line with Undo.
 * The snapshot is taken from the first answer of each view, an empty one included.
 */

export interface DecidedEntry {
  item: AttentionItemView;
  decision: RowDecision;
  until: string | null;
  /** When the decision succeeded, as an `orderMark()`: only an answer asked later can retire the receipt. */
  decidedAt: number;
}

/** A list answer and when its request was asked (`Resource.askedAt`). */
export interface ListAnswer {
  items: readonly AttentionItemView[];
  askedAt: number | null;
}

/**
 * Whether a decided row's receipt still stands: until an answer asked after the decision succeeded has the item again
 * (after Undo, a snooze that ran out, or evidence that changed after a dismissal). An answer asked earlier may still
 * have the item, as it was before the decision, and never counts.
 */
export function receiptStands(entry: DecidedEntry, answer: ListAnswer): boolean {
  return answer.askedAt === null || answer.askedAt < entry.decidedAt || !answer.items.some((i) => i.id === entry.item.id);
}

export type ListEntry = { item: AttentionItemView; decided: DecidedEntry | null };

export interface InboxList {
  /** Every row in the snapshot's order: live items and decided lines. */
  entries: ListEntry[];
  /** Items that arrived since the snapshot, in the view's order. */
  arrivals: AttentionItemView[];
  /** Take the arrivals in, re-sorting the whole list; decided lines go. */
  showNew: () => void;
  decided: (item: AttentionItemView, decision: RowDecision, until: string | null) => void;
}

const NONE: ReadonlyMap<string, DecidedEntry> = new Map();

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, n) => id === b[n]);

export function useInboxList(live: readonly AttentionItemView[] | null, askedAt: number | null, listKey: string, order: InboxOrder): InboxList {
  const [snap, setSnap] = useState<{ key: string; ids: readonly string[] } | null>(null);
  // Decided lines belong to one view: a new view starts without the old one's.
  const [decidedIn, setDecidedIn] = useState<{ key: string; map: ReadonlyMap<string, DecidedEntry> }>({ key: listKey, map: new Map() });
  const decisions = decidedIn.key === listKey ? decidedIn.map : NONE;
  const setDecisions = (change: (prev: ReadonlyMap<string, DecidedEntry>) => ReadonlyMap<string, DecidedEntry>) =>
    setDecidedIn((prev) => ({ key: listKey, map: change(prev.key === listKey ? prev.map : NONE) }));

  // Items the owner reopened from Hidden in this tab: they come straight back instead of waiting as arrivals.
  const [welcome, setWelcome] = useState<ReadonlySet<string>>(new Set());

  const held = snap?.key === listKey ? snap.ids : null;
  const base = useMemo(() => (held ?? (live ? ordered(live, order).map((i) => i.id) : null)), [live, held, order]);
  const frozen = useMemo(() => (live && base ? frozenList(base, live, order, welcome) : null), [live, base, order, welcome]);
  const ids = frozen?.snapshot ?? base;

  useEffect(() => {
    if (!ids || (held && sameIds(ids, held))) return;
    setSnap({ key: listKey, ids });
    if (ids.some((id) => welcome.has(id))) setWelcome((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
  }, [ids, held, listKey, welcome]);

  // A receipt the service has overtaken gives way to the live item, in the same place.
  useEffect(() => {
    if (!live) return;
    const answer = { items: live, askedAt };
    if ([...decisions.values()].every((d) => receiptStands(d, answer))) return;
    setDecidedIn((prev) => ({ ...prev, map: new Map([...prev.map].filter(([, d]) => receiptStands(d, answer))) }));
  }, [live, askedAt, decisions]);

  const entries = useMemo<ListEntry[]>(() => {
    if (!frozen || !ids) return [];
    const byId = new Map(frozen.rows.map((i) => [i.id, i]));
    return ids.flatMap((id): ListEntry[] => {
      const d = decisions.get(id);
      const item = byId.get(id);
      if (d && live && receiptStands(d, { items: live, askedAt })) return [{ item: d.item, decided: d }];
      return item ? [{ item, decided: null }] : [];
    });
  }, [frozen, ids, decisions, live, askedAt]);

  return {
    entries,
    arrivals: frozen ? frozen.arrivals.filter((i) => !decisions.has(i.id)) : [],
    showNew: () => {
      if (live) setSnap({ key: listKey, ids: ordered(live, order).map((i) => i.id) });
      setDecisions(() => NONE);
    },
    decided: (item, decision, until) => {
      // Marked now, before any reload is asked, and outside the updater, which React may run later or twice.
      const decidedAt = orderMark();
      setDecisions((prev) => new Map(prev).set(item.id, { item, decision, until, decidedAt }));
      if (decision === "reopen") setWelcome((prev) => new Set([...prev, item.id]));
    },
  };
}
