import { useEffect, useMemo, useState } from "react";
import type { AttentionItemView } from "@attache/contracts";
import { frozenList, ordered, type InboxOrder } from "../inbox-view.ts";
import type { RowDecision } from "./InboxRow.tsx";

/**
 * The Inbox's frozen list. The rows the owner sees keep their order while the live list changes underneath: an
 * item that arrives waits behind Show new items, and a row decided here stays in its place as one line with Undo.
 * Nothing is frozen while no row shows (the first answer, a new view, an empty list).
 */

export interface DecidedEntry {
  item: AttentionItemView;
  decision: RowDecision;
  until: string | null;
  /** Undo was sent; the row returns to the live item once the list answers with it again. */
  undone: boolean;
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
  undone: (id: string) => void;
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

  // Items the owner reopened from Hidden in this tab: they come straight back instead of waiting as arrivals.
  const [welcome, setWelcome] = useState<ReadonlySet<string>>(new Set());

  const held = snap?.key === listKey ? snap.ids : null;
  const base = useMemo(() => {
    if (!live) return held;
    const showing = held?.some((id) => decisions.has(id) || live.some((i) => i.id === id));
    return held && showing ? held : ordered(live, order).map((i) => i.id);
  }, [live, held, decisions, order]);
  const frozen = useMemo(() => (live && base ? frozenList(base, live, order, welcome) : null), [live, base, order, welcome]);
  const ids = frozen?.snapshot ?? base;

  useEffect(() => {
    if (!ids || (held && sameIds(ids, held))) return;
    setSnap({ key: listKey, ids });
    if (ids.some((id) => welcome.has(id))) setWelcome((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
  }, [ids, held, listKey, welcome]);

  // A decided line that was undone gives way to its item once the list has it again.
  useEffect(() => {
    if (!live) return;
    const back = [...decisions.values()].filter((d) => d.undone && live.some((i) => i.id === d.item.id));
    if (!back.length) return;
    setDecidedIn((prev) => ({ ...prev, map: new Map([...prev.map].filter(([id]) => !back.some((d) => d.item.id === id))) }));
  }, [live, decisions]);

  const entries = useMemo<ListEntry[]>(() => {
    if (!frozen || !ids) return [];
    const byId = new Map(frozen.rows.map((i) => [i.id, i]));
    return ids.flatMap((id): ListEntry[] => {
      const d = decisions.get(id);
      const item = byId.get(id);
      if (d && !(d.undone && item)) return [{ item: d.item, decided: d }];
      return item ? [{ item, decided: null }] : [];
    });
  }, [frozen, ids, decisions]);

  return {
    entries,
    arrivals: frozen ? frozen.arrivals.filter((i) => !decisions.has(i.id)) : [],
    showNew: () => {
      if (live) setSnap({ key: listKey, ids: ordered(live, order).map((i) => i.id) });
      setDecisions(() => NONE);
    },
    decided: (item, decision, until) => {
      setDecisions((prev) => new Map(prev).set(item.id, { item, decision, until, undone: false }));
      if (decision === "reopen") setWelcome((prev) => new Set([...prev, item.id]));
    },
    undone: (id) =>
      setDecisions((prev) => {
        const d = prev.get(id);
        return d ? new Map(prev).set(id, { ...d, undone: true }) : prev;
      }),
  };
}
