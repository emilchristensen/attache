import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { post } from "../api.ts";
import { useResource } from "../live.ts";
import { useSignals } from "../nav-signals.ts";
import { briefingWritten, forYouNow, heldSlot, promotedMeetings, type BriefingView, type HeadsUp, type HeadsUpInput, type HeadsUpKindId, type MeetingPrep } from "../heads-ups.ts";
import { useHeadsUpClock } from "../heads-up-clock.ts";
import { useSettledHeadsUps } from "../heads-up-memory.ts";
import { useHold } from "../hold.ts";
import { plural, READER_SILENT_AFTER_MS, type ReaderView } from "@attache/contracts";
import { Disclosure } from "../components/Disclosure.tsx";
import { Icon, type IconName } from "../components/icons.tsx";
import { Link, useAction } from "../components/ui.tsx";
import { BriefingActions } from "./BriefingActions.tsx";
import { BriefingDetail, MeetingContext } from "./BriefingParts.tsx";
import { useBriefingJob } from "./briefing-job.ts";
import { MeetingLead, MeetingLine, type MeetingHandlers } from "./MeetingHeadsUp.tsx";

const ICON: Record<HeadsUpKindId, IconName> = {
  "daily-briefing": "sun",
  "earlier-today": "sun",
  "away-summary": "calendar",
  "requested-briefing": "document",
  "briefing-progress": "clock",
  "meeting-prep": "calendar-notes",
};

/** What one Heads-up offers, drawn from its actions. */
function Actions({ headsUp, lead, open, onRead, onGotIt }: { headsUp: HeadsUp; lead: boolean; open: boolean; onRead: () => void; onGotIt: () => void }) {
  if (!headsUp.actions.length) return null;
  return (
    <div className="heads-up-actions">
      {headsUp.actions.includes("read-briefing") && (
        <button className={lead ? "primary" : "small"} aria-expanded={open} onClick={onRead}>
          Read briefing
        </button>
      )}
      {headsUp.actions.includes("got-it") && (
        <button className={lead ? "ghost" : "small ghost"} onClick={onGotIt}>
          Got it
        </button>
      )}
    </div>
  );
}

interface EntryProps {
  headsUp: HeadsUp;
  open: boolean;
  onRead: () => void;
  onGotIt: () => void;
  /** Meeting prep's Done and Not now. */
  meeting: Omit<MeetingHandlers, "onOpenPrep">;
  clock: { now: number; timeZone: string };
}

const isMeeting = (h: HeadsUp): h is HeadsUp & { meeting: MeetingPrep } => !!h.meeting;

/** The lead, drawn as its kind needs. */
function Lead(props: EntryProps) {
  const { headsUp, open, onRead, meeting, clock } = props;
  return isMeeting(headsUp) ? <MeetingLead headsUp={headsUp} open={open} clock={clock} onOpenPrep={onRead} {...meeting} /> : <LeadCard {...props} />;
}

/** A follower, drawn as its kind needs. */
function Follower(props: EntryProps) {
  const { headsUp, open, onRead, meeting, clock } = props;
  return isMeeting(headsUp) ? <MeetingLine headsUp={headsUp} open={open} clock={clock} onOpenPrep={onRead} {...meeting} /> : <Line {...props} />;
}

/** The lead: the one Heads-up shown whole. Only a lead morning briefing is the amber spread with the low sun. */
function LeadCard({ headsUp, open, onRead, onGotIt }: EntryProps) {
  const titleId = useId();
  const feature = headsUp.kind === "daily-briefing";
  return (
    <article className={`heads-up-lead${feature ? " feature" : ""}`} aria-labelledby={titleId} data-heads-up={headsUp.kind} data-heads-up-key={headsUp.key}>
      <p className="heads-up-eyebrow">
        <Icon name={ICON[headsUp.kind]} size={16} />
        <span>
          {headsUp.label} · {headsUp.timing}
        </span>
      </p>
      <h3 className="heads-up-title" id={titleId}>
        {headsUp.title}
      </h3>
      {headsUp.explanation && <p className="heads-up-explanation">{headsUp.explanation}</p>}
      <div className="heads-up-foot">
        <Actions headsUp={headsUp} lead open={open} onRead={onRead} onGotIt={onGotIt} />
        <p className="heads-up-why">{headsUp.why}</p>
      </div>
      {open && headsUp.briefing && <BriefingDetail briefing={headsUp.briefing} />}
    </article>
  );
}

/**
 * A follower: one compact line, opening in place. A line kind (progress, Earlier today) keeps its why under it; a card
 * that follows (a briefing under a meeting) stays one line, with its why inside what Read briefing opens. A briefing
 * that takes a progress line's place (`inPlaceOf`, the same row) keeps at least that line's height while held, so the
 * lines below it stay put.
 */
function Line({ headsUp, open, onRead, onGotIt }: EntryProps) {
  const job = headsUp.job;
  const oneLine = headsUp.form === "card";
  const row = useRef<HTMLLIElement>(null);
  const progressHeight = useRef<number | null>(null);
  useLayoutEffect(() => {
    const li = row.current;
    if (!li) return;
    if (job) progressHeight.current = li.offsetHeight;
    li.style.minHeight = headsUp.inPlaceOf && progressHeight.current ? `${progressHeight.current}px` : "";
  });
  return (
    <li ref={row} className="heads-up-line" data-heads-up={headsUp.kind} data-heads-up-key={headsUp.key}>
      <span className="heads-up-line-icon">
        <Icon name={ICON[headsUp.kind]} size={16} />
      </span>
      <div className="heads-up-line-text">
        <p className="heads-up-line-head">
          <strong>{headsUp.label}</strong>
          <span className="heads-up-line-timing"> · {headsUp.timing}</span>
          <span className="heads-up-line-title"> · {headsUp.title}</span>
        </p>
        {!oneLine && <p className="heads-up-why">{headsUp.why}</p>}
        {job && (
          <div className="progress" role="progressbar" aria-label="Briefing progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress * 100)}>
            <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
          </div>
        )}
      </div>
      <Actions headsUp={headsUp} lead={false} open={open} onRead={onRead} onGotIt={onGotIt} />
      {open && headsUp.briefing && <BriefingDetail briefing={headsUp.briefing} why={oneLine ? headsUp.why : null} />}
    </li>
  );
}

interface StatusView {
  reader: Pick<ReaderView, "replicated" | "thisMachine" | "silent" | "heartbeatAt">;
  schedules: Array<{ jobKind: string; enabled: boolean; nextRunAt: string | null }>;
}

/**
 * The scheduler's daily briefing row (`/status`), or null while not known. Only the Reader runs scheduled briefings,
 * so another Machine's own row, or this Machine's once its Reader lease has lapsed, says nothing about when the next
 * one comes: null there too. A run that wrote no briefing and a lease that lapsed send no event, so once the next run
 * or the lease has passed, `/status` is asked again, once per clock tick (every minute and on wake).
 */
function useBriefingSchedule(enabled: boolean, now: number): HeadsUpInput["schedule"] {
  const r = useResource<StatusView>(enabled ? "/status" : null, ["config.changed", "briefing.created", "reader.changed", "service.resumed"]);
  const reader = r.data?.reader;
  const lapsed = !!reader?.replicated && (!reader.heartbeatAt || Date.parse(reader.heartbeatAt) + READER_SILENT_AFTER_MS <= now);
  const reads = !!reader && (!reader.replicated || (reader.thisMachine && !reader.silent && !lapsed));
  const row = reads ? r.data?.schedules.find((x) => x.jobKind === "briefing") : undefined;
  const stale = (!!row?.nextRunAt && Date.parse(row.nextRunAt) <= now) || (!!reader?.thisMachine && lapsed && !reader.silent);
  const asked = useRef(now);
  const { reload, loading } = r;
  useEffect(() => {
    // One request at a time: a newer one would discard the answer on its way.
    if (!stale || loading || asked.current === now) return;
    asked.current = now;
    reload();
  }, [stale, loading, now, reload]);
  return row ? { enabled: row.enabled, nextRunAt: row.nextRunAt } : null;
}

/** The latest briefing, as the slot needs it: unknown until the first answer. */
function useLatestBriefing(enabled: boolean) {
  const r = useResource<{ briefing: BriefingView | null }>(enabled ? "/briefings/latest" : null, ["briefing.created"]);
  // A failed answer after a good one keeps the briefing it had, and says the check failed.
  const value: BriefingView | null | "unknown" = r.data ? r.data.briefing : "unknown";
  return { value, failed: !!r.error, retry: r.reload };
}

const NONE: ReadonlySet<string> = new Set();

/**
 * The meeting prep items decided Done here, until the open list no longer has them: their Heads-up goes at once and
 * the Inbox does not list them while the list catches up. One that comes back later (its evidence changed) is not
 * held back.
 */
function useDoneHere(items: readonly { id: string }[] | null) {
  const [done, setDone] = useState<ReadonlySet<string>>(NONE);
  useEffect(() => {
    if (!items || !done.size) return;
    const open = new Set(items.map((i) => i.id));
    if ([...done].every((id) => open.has(id))) return;
    setDone((prev) => new Set([...prev].filter((id) => open.has(id))));
  }, [items, done]);
  return { done, add: (id: string) => setDone((prev) => new Set([...prev, id])) };
}

/**
 * For you now: Home's second area. The Heads-ups that are timely, the most urgent leading and the rest as compact
 * lines, or one quiet line when nothing is. While the pointer or focus is on a Heads-up, the Heads-ups hold still:
 * none moves or leaves until the owner moves away (`heldSlot`). The owner's own Got it, Not now and Done apply at
 * once, and a progress line gives way, in place, to the briefing it wrote; the heading and the briefing actions are
 * outside the hold. `onAbove` hears the ids of the Inbox items shown here as meeting prep (and those decided Done here
 * until the list catches up), so the Inbox leaves them out: each is one item, shown once.
 */
export function ForYouNow({ attentionOn, onAbove }: { attentionOn: boolean; onAbove: (ids: ReadonlySet<string>) => void }) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const clock = useHeadsUpClock();
  const { settled, settle } = useSettledHeadsUps();
  const latest = useLatestBriefing(attentionOn);
  const { job, start } = useBriefingJob(attentionOn);
  const schedule = useBriefingSchedule(attentionOn, clock.now);
  const { held, holdProps } = useHold();
  // Got it, Not now and Done pressed in this tab apply at once, even while held; another tab's wait until the hold ends.
  const [mine, setMine] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [context, setContext] = useState(false);
  const [said, setSaid] = useState("");
  // The open Inbox items: the shell's request behind the count, so a meeting and its Inbox row never disagree.
  const openInbox = useSignals().openInbox;
  const items = openInbox.data?.items ?? null;
  const doneHere = useDoneHere(items);
  const doneKeys = useMemo(() => [...doneHere.done].map((id) => `meeting:${id}`), [doneHere.done]);
  const { busy, run } = useAction();

  const live = {
    now: clock.now,
    timeZone: clock.timeZone,
    briefing: latest.value,
    briefingJob: job,
    schedule,
    settled: doneKeys.length ? new Set([...settled, ...doneKeys]) : settled,
    meetings: items ?? ("unknown" as const),
  };
  const frozen = useRef(live);
  // The first briefing to take a progress line's place stays as it came until the hold ends: a later one waits too.
  const handoff = useRef<HeadsUpInput | null>(null);
  if (!held) {
    frozen.current = live;
    handoff.current = null;
  } else if (!handoff.current && briefingWritten(frozen.current, live)) handoff.current = live;
  const slot = held ? heldSlot({ ...frozen.current, settled: new Set([...frozen.current.settled, ...mine, ...doneKeys]) }, handoff.current) : forYouNow(live);

  const above = attentionOn ? new Set([...promotedMeetings(slot), ...doneHere.done]) : NONE;
  const aboveKey = [...above].sort().join(" ");
  const told = useRef<string | null>(null);
  // Before paint, so a meeting never shows both here and as an Inbox row.
  useLayoutEffect(() => {
    if (told.current === aboveKey) return;
    told.current = aboveKey;
    onAbove(above);
  });

  if (!attentionOn)
    return (
      <section className="for-you-now quiet" aria-labelledby={headingId} data-for-you-now="off">
        <div className="for-you-now-head">
          <h2 className="for-you-now-quiet-title" id={headingId}>
            For you now
          </h2>
          <p className="for-you-now-quiet-text">
            Heads-ups need Attention and briefings, which is switched off. <Link to="/settings">Turn it on in Settings</Link>
          </p>
        </div>
      </section>
    );

  const toggle = (key: string) => setOpen((o) => (o.has(key) ? new Set([...o].filter((k) => k !== key)) : new Set([...o, key])));
  const gotIt = (h: HeadsUp) => {
    settle(h.key);
    setMine((m) => new Set([...m, h.key]));
    setSaid(h.kind === "daily-briefing" ? "Briefing put away. It stays under Earlier today until midnight." : "Briefing put away.");
    heading.current?.focus();
  };
  const notNow = (h: HeadsUp) => {
    settle(h.key);
    setMine((m) => new Set([...m, h.key]));
    setSaid(`${h.title} moved to the Inbox. It stays open there.`);
    heading.current?.focus();
  };
  const done = (h: HeadsUp & { meeting: MeetingPrep }) =>
    void run(h.key, async () => {
      await post(`/attention/${h.meeting.itemId}/decision`, { decision: "done" });
      doneHere.add(h.meeting.itemId);
      // A held slot keeps the input from before Done, item included: this tab's own decision applies to it at once.
      setMine((m) => new Set([...m, h.key]));
      setSaid(`${h.title} marked done, on every Machine.`);
      heading.current?.focus();
      openInbox.reload();
    });
  const entry = (h: HeadsUp): EntryProps => ({
    headsUp: h,
    open: open.has(h.key),
    onRead: () => toggle(h.key),
    onGotIt: () => gotIt(h),
    meeting: { onDone: () => isMeeting(h) && done(h), onNotNow: () => notNow(h), busy: busy === h.key },
    clock,
  });
  const actions = <BriefingActions running={!!job} hasBriefing={typeof latest.value === "object" && latest.value !== null} start={start} onMeetingContext={() => setContext(true)} />;
  const meetingContext = context && typeof latest.value === "object" && latest.value !== null && (
    <MeetingContext briefing={latest.value} now={clock.now} timeZone={clock.timeZone} onClose={() => setContext(false)} />
  );
  const quiet = !slot.lead && !slot.followers.length;

  // Without a lead the title shrinks to the quiet line's size, so lines alone cost the Inbox little room.
  const compact = !slot.lead;
  const status = latest.failed ? (
    <>
      Could not check for a briefing.{" "}
      <button className="small" onClick={latest.retry}>
        Try again
      </button>
    </>
  ) : (
    (slot.quiet ?? "Checking for Heads-ups…")
  );

  return (
    <section className={`for-you-now${quiet ? " quiet" : compact ? " compact" : ""}`} aria-labelledby={headingId} data-for-you-now={quiet ? "quiet" : "timely"}>
      <div className="for-you-now-head">
        <h2 className={compact ? "for-you-now-quiet-title" : "heading-section"} id={headingId} ref={heading} tabIndex={-1}>
          For you now
        </h2>
        {quiet && (
          <p className="for-you-now-quiet-text" role="status">
            {status}
          </p>
        )}
        {actions}
      </div>
      <div className="heads-ups" {...holdProps}>
        {slot.lead && <Lead key={slot.lead.key} {...entry(slot.lead)} />}
        {slot.followers.length > 0 && (
          <ul className="heads-up-lines" aria-label={slot.lead ? "Also timely" : "Timely"}>
            {slot.followers.map((h) => (
              <Follower key={h.inPlaceOf ?? h.key} {...entry(h)} />
            ))}
          </ul>
        )}
        {slot.more.length > 0 && (
          <Disclosure className="heads-up-more" title={plural(slot.more.length, "more Heads-up")}>
            <ul className="heads-up-lines">
              {slot.more.map((h) => (
                <Follower key={h.inPlaceOf ?? h.key} {...entry(h)} />
              ))}
            </ul>
          </Disclosure>
        )}
      </div>
      {!quiet && latest.failed && (
        <p className="for-you-now-failed" role="alert">
          {status}
        </p>
      )}
      {meetingContext}
      <span className="sr-only" role="status">
        {said}
      </span>
    </section>
  );
}
