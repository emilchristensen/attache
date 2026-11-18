import { useEffect, useMemo, useRef, useState } from "react";
import type { AttentionItemView } from "@attache/contracts";
import { frozenList, ordered, type InboxOrder } from "../inbox-view.ts";
import type { RowDecision } from "./InboxRow.tsx";

/**
 * The Inbox's frozen list. The rows the owner sees keep their order while the live list changes underneath: an
 * item that arrives waits behind Show new items, and a row decided here stays in its place as one line with Undo.
 * The snapshot is taken from the first answer of each view, an empty one included.
 */

export interface DecidedEntry {
  item: AttentionItemView;
  decision: RowDecision;
  until: string | null;
  /**
   * The latest answer when the decision succeeded; a newer answer that has the item again retires the receipt. Any
   * answer to a request started earlier is dropped by `useResource` once the reload after the decision starts.
   */
  since: readonly AttentionItemView[] | null;
}

/**
 * Whether a decided row's receipt still stands in `live`: until a newer answer than the one it was decided on has the
 * item again (after Undo, a snooze that ran out, or evidence that changed after a dismissal).
 */
export function receiptStands(entry: DecidedEntry, live: readonly AttentionItemView[]): boolean {
  return live === entry.since || !live.some((i) => i.id === entry.item.id);
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

export function useInboxList(live: readonly AttentionItemView[] | null, listKey: string, order: InboxOrder): InboxList {
  const [snap, setSnap] = useState<{ key: string; ids: readonly string[] } | null>(null);
  // Decided lines belong to one view: a new view starts without the old one's.
  const [decidedIn, setDecidedIn] = useState<{ key: string; map: ReadonlyMap<string, DecidedEntry> }>({ key: listKey, map: new Map() });
  const decisions = decidedIn.key === listKey ? decidedIn.map : NONE;
  const setDecisions = (change: (prev: ReadonlyMap<string, DecidedEntry>) => ReadonlyMap<string, DecidedEntry>) =>
    setDecidedIn((prev) => ({ key: listKey, map: change(prev.key === listKey ? prev.map : NONE) }));

  // The latest answer, read when a decision succeeds: a refresh that landed while the decision was being sent still
  // has the item, and must not count as the service answering with it again.
  const latest = useRef(live);
  useEffect(() => {
    latest.current = live;
  }, [live]);

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
    if (!live || [...decisions.values()].every((d) => receiptStands(d, live))) return;
    setDecidedIn((prev) => ({ ...prev, map: new Map([...prev.map].filter(([, d]) => receiptStands(d, live))) }));
  }, [live, decisions]);

  const entries = useMemo<ListEntry[]>(() => {
    if (!frozen || !ids) return [];
    const byId = new Map(frozen.rows.map((i) => [i.id, i]));
    return ids.flatMap((id): ListEntry[] => {
      const d = decisions.get(id);
      const item = byId.get(id);
      if (d && live && receiptStands(d, live)) return [{ item: d.item, decided: d }];
      return item ? [{ item, decided: null }] : [];
    });
  }, [frozen, ids, decisions, live]);

  return {
    entries,
    arrivals: frozen ? frozen.arrivals.filter((i) => !decisions.has(i.id)) : [],
    showNew: () => {
      if (live) setSnap({ key: listKey, ids: ordered(live, order).map((i) => i.id) });
      setDecisions(() => NONE);
    },
    decided: (item, decision, until) => {
      setDecisions((prev) => new Map(prev).set(item.id, { item, decision, until, since: latest.current }));
      if (decision === "reopen") setWelcome((prev) => new Set([...prev, item.id]));
    },
  };
}
