import type { HistoryItem } from "./parts.ts";

const DATE_RE = /^- (\d{4}-\d{2}-\d{2})\b/;
const keyOf = (item: HistoryItem) => item.join("\n");

/** Each item with the date it starts with, or the date of the item before it. */
function dated(items: readonly HistoryItem[]): Array<{ item: HistoryItem; date: string }> {
  let last = "";
  return items.map((item) => {
    last = DATE_RE.exec(item[0] ?? "")?.[1] ?? last;
    return { item, date: last };
  });
}

/** Two lists merged by date; on the same date the first list's items come first. */
function byDate(a: readonly HistoryItem[], b: readonly HistoryItem[]): HistoryItem[] {
  const [da, db] = [dated(a), dated(b)];
  const out: HistoryItem[] = [];
  let [i, j] = [0, 0];
  while (i < da.length || j < db.length) {
    const takeA = j >= db.length || (i < da.length && da[i]!.date <= db[j]!.date);
    out.push(takeA ? da[i++]!.item : db[j++]!.item);
  }
  return out;
}

/**
 * History from both sides, every item kept once. What both sides share stays
 * in place; what each added since is interleaved by date; the superseded
 * values the fact merge produced come last.
 */
export function mergeHistory(first: readonly HistoryItem[], second: readonly HistoryItem[], superseded: readonly HistoryItem[]): HistoryItem[] {
  let shared = 0;
  while (shared < first.length && shared < second.length && keyOf(first[shared]!) === keyOf(second[shared]!)) shared++;
  const merged = [...first.slice(0, shared), ...byDate(first.slice(shared), second.slice(shared)), ...superseded];
  const seen = new Set<string>();
  return merged.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
