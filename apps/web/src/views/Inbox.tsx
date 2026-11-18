import { draftHref } from "../routes.ts";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { plural, type AttentionItemView, type JobView } from "@attache/contracts";
import { post } from "../api.ts";
import { useResource } from "../live.ts";
import { Empty, ErrorState, Link, Loading, navigate, useAction } from "../components/ui.tsx";
import type { InboxCoverage } from "../connection-status.ts";
import { homeLine } from "../count.ts";
import { useSignals } from "../nav-signals.ts";
import { AttentionDot } from "../components/AttentionDot.tsx";
import { useHeadsUpClock } from "../heads-up-clock.ts";
import { backFromAbove, groupRows, listedBelow, PAGE_SIZE, pageLabel, typeOptions, withType } from "../inbox-view.ts";
import { snoozeChoices } from "../inbox-rows.ts";
import { INBOX_VIEWS, useInboxPlace, type InboxViewId } from "../inbox-place.ts";
import { useRowKeys, type RowKey } from "../shortcuts.ts";
import { DecidedRow, InboxRow, type RowActions, type RowDecision } from "./InboxRow.tsx";
import { useInboxList, type ListEntry } from "./inbox-list.ts";

const EMPTY: Record<InboxCoverage, { title: string; body: string }> = {
  all: { title: "Nothing needs your attention", body: "Items appear here when deadlines approach, reviews are requested, meetings need prep or replies are pending." },
  notes: { title: "Nothing needs your attention in your notes", body: "No work source is connected, so only your notes were read." },
  incomplete: { title: "Nothing found in the sources that were read", body: "Connections above says what was not read, so this may not be complete." },
};

/** Every open item is shown above as meeting prep: nothing else waits below. */
const EMPTY_BELOW = { title: "Nothing else needs your attention", body: "The meeting prep above is open. Not now brings it back here." };

/** The empty open list: nothing needs the owner, or nothing else when the only open items are meeting prep above. */
function EmptyBelow({ coverage, above }: { coverage: InboxCoverage; above: boolean }) {
  const words = above ? EMPTY_BELOW : EMPTY[coverage];
  return <Empty title={words.title}>{words.body}</Empty>;
}

/** What each decision key decides on the focused row. */
const KEY_DECISION: Readonly<Partial<Record<RowKey, RowDecision>>> = { done: "done", snooze: "snooze", dismiss: "dismiss" };

/**
 * The Inbox heading with Home's decision count beside it ("4 need you here"), while the navigation leaves Home's
 * number out, the line that relates the rows to the decisions when they differ, and the view controls.
 */
function InboxHeading({ id, children, open, above }: { id: string; children: ReactNode; open: boolean; above: ReadonlySet<string> }) {
  const signals = useSignals();
  const home = signals.count.home;
  const needYou = home.count > 0 ? `${home.exact ? "" : "At least "}${home.count} ${home.count === 1 && home.exact ? "needs" : "need"} you here` : null;
  const line = open ? homeLine(signals.inbox, above) : null;
  return (
    <>
      <div className="inbox-head">
        <div className="inbox-title">
          <h2 className="heading-section" id={id}>
            Inbox
          </h2>
          {needYou && (
            <span className="need-you" data-need-you>
              <AttentionDot decorative />
              {needYou}
            </span>
          )}
        </div>
        {children}
      </div>
      {line && <p className="count-line">{line}</p>}
    </>
  );
}

interface ToolsProps {
  items: readonly AttentionItemView[];
  type: string;
  view: InboxViewId;
  arrivals: number;
  /** The visible range (or the count under Group by type), which fills Show new items' place on a narrow window while nothing waits. */
  range: string;
  onType: (type: string) => void;
  onView: (view: InboxViewId) => void;
  onShowNew: () => void;
}

/** The view controls: Show new items in a place kept for it, the one type picker with counts, and the view. */
function InboxTools({ items, type, view, arrivals, range, onType, onView, onShowNew }: ToolsProps) {
  const options = useMemo(() => typeOptions(items, type), [items, type]);
  return (
    <div className="inbox-tools">
      {arrivals === 0 && (
        <span className="inbox-tools-range" aria-hidden>
          {range}
        </span>
      )}
      <button className="inbox-show-new" data-show-new data-waiting={arrivals > 0 || undefined} disabled={arrivals === 0} aria-hidden={arrivals === 0 || undefined} tabIndex={arrivals === 0 ? -1 : undefined} onClick={onShowNew}>
        Show {plural(arrivals, "new item")}
      </button>
      <select className="inbox-picker" aria-label="Type" value={type} onChange={(e) => onType(e.target.value)}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label} ({o.count})
          </option>
        ))}
      </select>
      <select className="inbox-picker" aria-label="View" value={view} onChange={(e) => onView(e.target.value as InboxViewId)}>
        {INBOX_VIEWS.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label}
          </option>
        ))}
      </select>
    </div>
  );
}

interface RowsProps {
  entries: readonly ListEntry[];
  clock: { now: number; timeZone: string };
  openId: string | null;
  onToggle: (id: string) => void;
  actions: RowActions;
  draftsOn: boolean;
  onUndo: (entry: ListEntry) => void;
}

function Rows({ entries, clock, openId, onToggle, actions, draftsOn, onUndo }: RowsProps) {
  return (
    <ul className="inbox-rows">
      {entries.map((e) =>
        e.decided ? (
          <DecidedRow key={e.item.id} item={e.item} decision={e.decided.decision} until={e.decided.until} onUndo={e.decided.decision === "reopen" ? null : () => onUndo(e)} busy={actions.busy} clock={clock} />
        ) : (
          <InboxRow key={e.item.id} item={e.item} open={openId === e.item.id} onToggle={() => onToggle(e.item.id)} actions={actions} draftsOn={draftsOn} clock={clock} />
        ),
      )}
    </ul>
  );
}

/** After a decision the keyboard stays in the row: on its Undo, or back on the row after Undo or Show new items. */
function useFocusAfter(): (id: string, target: "undo" | "row") => void {
  const want = useRef<{ id: string; target: "undo" | "row" } | null>(null);
  useEffect(() => {
    if (!want.current) return;
    const row = document.querySelector<HTMLElement>(`#inbox [data-inbox-row][data-item-id="${CSS.escape(want.current.id)}"]`);
    const target = row?.querySelector<HTMLElement>(want.current.target === "undo" ? "[data-undo]" : "[data-row-toggle]");
    if (!target) return;
    target.focus();
    want.current = null;
  });
  return useCallback((id, target) => {
    want.current = { id, target };
  }, []);
}

/** `j`/`k` move between rows; the decision keys, once switched on, decide on the focused row. */
function useInboxKeys(live: readonly AttentionItemView[] | null, decide: RowActions["decide"], busy: boolean): void {
  const onRowKey = useCallback(
    (key: RowKey): boolean => {
      const toggles = [...document.querySelectorAll<HTMLElement>("#inbox [data-row-toggle]")];
      if (!toggles.length) return false;
      const row = document.activeElement?.closest<HTMLElement>("#inbox [data-inbox-row]") ?? null;
      const at = toggles.findIndex((t) => t.closest("[data-inbox-row]") === row);
      if (key === "next" || key === "previous") {
        const next = at < 0 ? 0 : Math.min(toggles.length - 1, Math.max(0, at + (key === "next" ? 1 : -1)));
        toggles[next]!.focus();
        toggles[next]!.scrollIntoView({ block: "nearest" });
        return true;
      }
      const decision = KEY_DECISION[key];
      const item = live?.find((i) => i.id === row?.dataset.itemId);
      if (!decision || !item || item.state !== "open" || busy) return false;
      decide(item, decision, decision === "snooze" ? snoozeChoices(new Date())[1]!.iso : undefined);
      return true;
    },
    [live, busy, decide],
  );
  useRowKeys(onRowKey);
}

/**
 * The meeting prep items that left For you now while still open (Not now) come back into their places, not behind
 * Show new items.
 */
function useBackFromAbove(above: ReadonlySet<string>, live: readonly AttentionItemView[] | null, now: number, welcomeBack: (ids: readonly string[]) => void): void {
  const before = useRef(above);
  useEffect(() => {
    if (before.current === above) return;
    const back = live ? backFromAbove(before.current, above, live, now) : [];
    before.current = above;
    welcomeBack(back);
  });
}

/**
 * The Inbox list. `coverage` comes from Home's Connections area: an empty list says nothing needs the owner only
 * when every source was read, and names what was read otherwise. `above` holds the items For you now shows as
 * meeting prep: the open list leaves them out, and meeting prep whose meeting has ended, until the service resolves it.
 */
export function Inbox({ attentionOn, draftsOn, coverage, above }: { attentionOn: boolean; draftsOn: boolean; coverage: InboxCoverage; above: ReadonlySet<string> }) {
  const [place, setPlace] = useInboxPlace();
  const [said, setSaid] = useState("");
  const heading = useId();
  const hiddenView = place.view === "hidden";
  const order = place.view === "newest" ? "newest" : "priority";
  // The open rows are the shell's request behind the count, so the rows, their Retry and the count agree.
  const open = useSignals().openInbox;
  const hidden = useResource<{ items: AttentionItemView[] }>(attentionOn && hiddenView ? "/attention?state=dismissed,snoozed" : null, ["attention.changed", "actions.changed"]);
  const source = hiddenView ? hidden : open;
  const clock = useHeadsUpClock();
  const answered = source.data?.items ?? null;
  const live = useMemo(() => (answered && !hiddenView ? listedBelow(answered, above, clock.now) : answered), [answered, hiddenView, above, clock.now]);
  const list = useInboxList(live, source.askedAt, hiddenView ? "hidden" : order, order);
  useBackFromAbove(above, open.data?.items ?? null, clock.now, list.welcomeBack);
  const { busy, run } = useAction();
  const focusAfter = useFocusAfter();

  const typed = useMemo(() => list.entries.filter((e) => withType([e.item], place.type).length > 0), [list.entries, place.type]);
  const arrivals = useMemo(() => withType(list.arrivals, place.type), [list.arrivals, place.type]);
  const expanded = useMemo(() => new Set(place.expanded), [place.expanded]);
  const grouped = place.view === "grouped" ? groupRows(typed.map((e) => e.item), expanded) : null;
  const shown = grouped ? typed : typed.slice(0, place.shown);

  // A decision moves an item between the open list and Hidden, so both are asked again.
  const reloadOpen = open.reload;
  const reloadHidden = hidden.reload;
  const reload = useCallback(() => {
    reloadOpen();
    if (hiddenView) reloadHidden();
  }, [reloadOpen, reloadHidden, hiddenView]);
  const { decided } = list;
  const decide = useCallback(
    (item: AttentionItemView, decision: RowDecision, until?: string) =>
      void run(`decide:${item.id}`, async () => {
        await post(`/attention/${item.id}/decision`, { decision, ...(until ? { until } : {}) });
        decided(item, decision, until ?? null);
        focusAfter(item.id, "undo");
        reload();
      }),
    [run, decided, focusAfter, reload],
  );
  const undo = (e: ListEntry) =>
    void run(`undo:${e.item.id}`, async () => {
      await post(`/attention/${e.item.id}/decision`, { decision: "reopen" });
      focusAfter(e.item.id, "row");
      reload();
    });
  const actions: RowActions = {
    decide,
    busy: busy !== null,
    prepareDraft: (item) =>
      void run(
        "draft",
        async () => {
          await post<{ job: JobView }>(`/attention/${item.id}/draft`, {});
          reload();
        },
        "Preparing a draft in the background",
      ),
    viewDraft: (draftId) => navigate(draftHref(draftId)),
  };
  useInboxKeys(live, decide, busy !== null);

  const showNew = () => {
    const first = arrivals[0]?.id;
    setSaid(`${plural(arrivals.length, "new item")} added.`);
    list.showNew();
    if (first) focusAfter(first, "row");
  };
  const toggle = (id: string) => setPlace({ openId: place.openId === id ? null : id });
  const rowsProps = { clock, openId: place.openId, onToggle: toggle, actions, draftsOn, onUndo: undo };

  if (!attentionOn)
    return (
      <Empty title="Attention and briefings is off" action={<Link to="/settings">Turn it on in Settings</Link>}>
        Search still works.
      </Empty>
    );

  return (
    <section id="inbox" className="inbox" aria-labelledby={heading}>
      <InboxHeading id={heading} open={!hiddenView} above={above}>
        <InboxTools
          items={live ?? []}
          type={place.type}
          view={place.view}
          arrivals={arrivals.length}
          range={grouped ? plural(typed.length, "item") : typed.length > 0 ? pageLabel(shown.length, typed.length) : ""}
          onType={(type) => setPlace({ type, shown: PAGE_SIZE })}
          onView={(view) => {
            setPlace({ view, shown: PAGE_SIZE, openId: null, expanded: [] });
          }}
          onShowNew={showNew}
        />
      </InboxHeading>
      <p className="sr-only" role="status">
        {arrivals.length ? `${plural(arrivals.length, "new item")} waiting. Show new items adds them.` : said}
      </p>
      {hiddenView && <p className="count-line">Snoozed and dismissed items. Reopen one to bring it back.</p>}
      {source.loading && !source.data && <Loading label="Loading the Inbox" />}
      <ErrorState error={source.error} retry={source.reload} />
      {live && list.entries.length === 0 && arrivals.length > 0 && <p className="inbox-none">New items arrived. Show new items adds them.</p>}
      {live && list.entries.length === 0 && arrivals.length === 0 && (hiddenView ? <Empty title="Nothing snoozed or dismissed">{null}</Empty> : <EmptyBelow coverage={coverage} above={above.size > 0 && coverage === "all"} />)}
      {live && typed.length === 0 && list.entries.length > 0 && <p className="inbox-none">No items of this type.</p>}
      {grouped
        ? grouped.map((g) => (
            <section key={g.family} id={`attention-${g.family}`} className="inbox-family" aria-label={g.label} data-family={g.family}>
              <h3 className="inbox-family-title">
                {g.label} <span className="inbox-family-count">{g.total}</span>
              </h3>
              <Rows entries={typed.filter((e) => g.rows.some((i) => i.id === e.item.id))} {...rowsProps} />
              {g.hidden > 0 && (
                <button className="small inbox-show-all" onClick={() => setPlace({ expanded: [...place.expanded, g.family] })}>
                  Show all {g.total}
                </button>
              )}
            </section>
          ))
        : shown.length > 0 && <Rows entries={shown} {...rowsProps} />}
      {!grouped && typed.length > 0 && (
        <div className="inbox-more">
          <span className="inbox-range" data-range>
            {pageLabel(shown.length, typed.length)}
          </span>
          {shown.length < typed.length && <button onClick={() => setPlace({ shown: place.shown + PAGE_SIZE })}>Load more</button>}
        </div>
      )}
    </section>
  );
}
