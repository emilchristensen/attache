import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { AttentionItemView } from "@attache/contracts";
import { useSignals } from "../nav-signals.ts";
import type { HeadsUpClock } from "../heads-up-clock.ts";
import { curateForYouNow, type ForYouNowEntry, type ForYouNowResult } from "../for-you-now.ts";
import { useHold } from "../hold.ts";
import { DecidedRow, InboxRow, type RowDecision } from "./InboxRow.tsx";
import { useBriefings } from "./briefings.ts";
import { useRowActions } from "./row-actions.ts";

/** A decision made from an entry: it stays in its place as one line with Undo until Undo or the next decision. */
interface Decided {
  item: AttentionItemView;
  decision: RowDecision;
  until: string | null;
  /** Its place in the list when it was decided. */
  at: number;
}

/** The list as shown: while the pointer or focus is inside it, the list it showed when the hold began. */
function useFrozenResult(live: ForYouNowResult, held: boolean): ForYouNowResult {
  const frozen = useRef(live);
  if (!held) frozen.current = live;
  return frozen.current;
}

type Shown = { entry: ForYouNowEntry; decided: null } | { entry: null; decided: Decided };

/**
 * The entries with each decided line in its place: over its entry while the list still holds the item (an answer
 * not yet back, or the list held under the pointer), else back where it was decided.
 */
function withDecided(entries: readonly ForYouNowEntry[], decided: readonly Decided[]): Shown[] {
  const byItem = new Map(decided.map((d) => [d.item.id, d]));
  const rows = entries.map((entry): Shown => {
    const line = byItem.get(entry.item.id);
    return line ? { entry: null, decided: line } : { entry, decided: null };
  });
  const listed = new Set(entries.map((e) => e.item.id));
  return decided
    .filter((d) => !listed.has(d.item.id))
    .toSorted((a, b) => a.at - b.at)
    .reduce<Shown[]>((all, d) => [...all.slice(0, d.at), { entry: null, decided: d }, ...all.slice(d.at)], rows);
}

/**
 * For you now: the short list of Inbox items to act on now, each with its reason (`for-you-now.ts`), as Inbox rows in
 * their narrow form with Start working, Snooze and Done, opening in place. Worked out again on Home's clock, when the
 * page becomes visible and when the Inbox changes; nothing moves or leaves while the pointer or focus is inside it.
 * `onShown` hears which items it shows, so their Inbox rows carry "Suggested now".
 */
export function ForYouNow({ attentionOn, draftsOn, clock, onShown }: { attentionOn: boolean; draftsOn: boolean; clock: HeadsUpClock; onShown: (ids: readonly string[]) => void }) {
  const headingId = useId();
  const openInbox = useSignals().openInbox;
  const briefings = useBriefings(attentionOn);
  const [openId, setOpenId] = useState<string | null>(null);
  const [decided, setDecided] = useState<readonly Decided[]>([]);
  const live = useMemo(
    () => curateForYouNow({ items: openInbox.data?.items ?? [], briefing: briefings.data?.daily ?? null, now: clock.now, timeZone: clock.timeZone }),
    [openInbox.data, briefings.data, clock.now, clock.timeZone],
  );
  const { held, holdProps } = useHold("data-item-key");
  const shown = useFrozenResult(live, held);
  useEffect(() => onShown(shown.entries.map((e) => e.item.id)), [shown, onShown]);
  const rows = withDecided(shown.entries, decided);

  const onDecided = useCallback(
    (item: AttentionItemView, decision: RowDecision, until: string | null) => {
      setOpenId(null);
      // One line with Undo at a time: the newest decision's.
      setDecided([{ item, decision, until, at: Math.max(0, shown.entries.findIndex((e) => e.item.id === item.id)) }]);
    },
    [shown],
  );
  const { actions, undo } = useRowActions({ reload: openInbox.reload, onDecided, onUndone: (item) => setDecided((d) => d.filter((x) => x.item.id !== item.id)) });

  if (!attentionOn)
    return (
      <section className="for-you-now quiet" aria-labelledby={headingId}>
        <h2 className="heading-section" id={headingId}>
          For you now
        </h2>
        <p className="for-you-now-quiet-text">Attention and briefings is switched off.</p>
      </section>
    );

  const failed = !!openInbox.error;
  const listed = rows.length > 0;
  return (
    <section className={`for-you-now${listed ? "" : " quiet"}`} aria-labelledby={headingId} data-for-you-now={listed ? "entries" : "quiet"} {...holdProps}>
      <div className="for-you-now-head">
        <h2 className="heading-section" id={headingId}>
          For you now
        </h2>
      </div>
      {failed ? (
        <p className="for-you-now-failed" role="alert">
          Could not read the Inbox.{" "}
          <button className="small" onClick={openInbox.reload}>
            Retry
          </button>
        </p>
      ) : listed ? (
        <>
          <ul className="inbox-rows for-you-now-rows">
            {rows.map((row) =>
              row.decided ? (
                <DecidedRow key={row.decided.item.id} item={row.decided.item} decision={row.decided.decision} until={row.decided.until} onUndo={() => undo(row.decided.item)} busy={actions.busy} clock={clock} />
              ) : (
                <InboxRow key={row.entry.item.id} item={row.entry.item} open={openId === row.entry.item.id} onToggle={() => setOpenId(openId === row.entry.item.id ? null : row.entry.item.id)} actions={actions} draftsOn={draftsOn} clock={clock} reason={row.entry.reasonText} />
              ),
            )}
          </ul>
          {shown.moreInInbox > 0 && (
            <p className="for-you-now-more">
              <a href="#inbox">{shown.moreInInbox} more in the Inbox</a>
            </p>
          )}
        </>
      ) : (
        <p className="for-you-now-quiet-text" role="status">
          {briefings.error && !briefings.data ? (
            <>
              Could not read the Daily Briefing, so its picks are missing.{" "}
              <button className="small" onClick={briefings.reload}>
                Retry
              </button>
            </>
          ) : openInbox.data ? (
            shown.quiet
          ) : (
            "Checking For you now…"
          )}
        </p>
      )}
    </section>
  );
}
