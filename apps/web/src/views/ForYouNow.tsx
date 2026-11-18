import { useEffect, useId, useRef, useState } from "react";
import { useResource } from "../live.ts";
import { forYouNow, type BriefingView, type HeadsUp, type HeadsUpInput, type HeadsUpKindId } from "../heads-ups.ts";
import { useHeadsUpClock } from "../heads-up-clock.ts";
import { useSettledHeadsUps } from "../heads-up-memory.ts";
import { useHold } from "../hold.ts";
import { plural } from "@attache/contracts";
import { Disclosure } from "../components/Disclosure.tsx";
import { Icon, type IconName } from "../components/icons.tsx";
import { Link } from "../components/ui.tsx";
import { BriefingActions } from "./BriefingActions.tsx";
import { BriefingDetail, MeetingContext } from "./BriefingParts.tsx";
import { useBriefingJob } from "./briefing-job.ts";

const ICON: Record<HeadsUpKindId, IconName> = {
  "daily-briefing": "sun",
  "earlier-today": "sun",
  "away-summary": "calendar",
  "requested-briefing": "document",
  "briefing-progress": "clock",
};

interface Schedule {
  briefingAt: string;
  briefingEnabled: boolean;
}

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

/** A follower: one compact line, its why under it, opening in place. */
function Line({ headsUp, open, onRead, onGotIt }: EntryProps) {
  const job = headsUp.job;
  return (
    <li className="heads-up-line" data-heads-up={headsUp.kind} data-heads-up-key={headsUp.key}>
      <span className="heads-up-line-icon">
        <Icon name={ICON[headsUp.kind]} size={16} />
      </span>
      <div className="heads-up-line-text">
        <p className="heads-up-line-head">
          <strong>{headsUp.label}</strong>
          <span className="heads-up-line-timing"> · {headsUp.timing}</span>
          <span className="heads-up-line-title"> · {headsUp.title}</span>
        </p>
        <p className="heads-up-why">{headsUp.why}</p>
        {job && (
          <div className="progress" role="progressbar" aria-label="Briefing progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress * 100)}>
            <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
          </div>
        )}
      </div>
      <Actions headsUp={headsUp} lead={false} open={open} onRead={onRead} onGotIt={onGotIt} />
      {open && headsUp.briefing && <BriefingDetail briefing={headsUp.briefing} />}
    </li>
  );
}

/** The latest briefing, as the slot needs it: unknown until the first answer. */
function useLatestBriefing(enabled: boolean) {
  const r = useResource<{ briefing: BriefingView | null }>(enabled ? "/briefings/latest" : null, ["briefing.created"]);
  // A failed answer after a good one keeps the briefing it had, and says the check failed.
  const value: BriefingView | null | "unknown" = r.data ? r.data.briefing : "unknown";
  return { value, failed: !!r.error, retry: r.reload };
}

/**
 * For you now: Home's second area. The Heads-ups that are timely, the most urgent leading and the rest as compact
 * lines, or one quiet line when nothing is. While the pointer or focus is on a Heads-up, the Heads-ups hold still:
 * none moves or leaves until the owner moves away. The owner's own Got it applies at once, and the heading and the
 * briefing actions are outside the hold, so a briefing asked for there shows as soon as it is written.
 */
export function ForYouNow({ attentionOn, schedule }: { attentionOn: boolean; schedule: Schedule | null }) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const clock = useHeadsUpClock();
  const { settled, settle } = useSettledHeadsUps();
  const latest = useLatestBriefing(attentionOn);
  const { job, start } = useBriefingJob(attentionOn);
  const { held, holdProps } = useHold();
  // A briefing the owner asked for here: until it arrives, it and its progress show even while a Heads-up holds still,
  // since asking was the owner's own action. The value is the latest briefing's id when they asked.
  const [askedOver, setAskedOver] = useState<string | null | undefined>(undefined);
  const latestId = typeof latest.value === "object" && latest.value !== null ? latest.value.id : null;
  useEffect(() => {
    if (askedOver !== undefined && latest.value !== "unknown" && latestId !== askedOver) setAskedOver(undefined);
  }, [askedOver, latest.value, latestId]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [context, setContext] = useState(false);
  const [said, setSaid] = useState("");

  const live = {
    now: clock.now,
    timeZone: clock.timeZone,
    briefing: latest.value,
    briefingJob: job,
    schedule,
  };
  const frozen = useRef(live);
  if (!held) frozen.current = live;
  else if (askedOver !== undefined) frozen.current = { ...frozen.current, briefing: live.briefing, briefingJob: live.briefingJob };
  const input: HeadsUpInput = { ...frozen.current, settled };
  const slot = forYouNow(input);

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
    setSaid(h.kind === "daily-briefing" ? "Briefing put away. It stays under Earlier today until midnight." : "Briefing put away.");
    heading.current?.focus();
  };
  const entry = (h: HeadsUp) => ({
    headsUp: h,
    open: open.has(h.key),
    onRead: () => toggle(h.key),
    onGotIt: () => gotIt(h),
  });
  const actions = (
    <BriefingActions
      running={!!job}
      hasBriefing={typeof latest.value === "object" && latest.value !== null}
      start={(kind, since) => {
        setAskedOver(latestId);
        return start(kind, since);
      }}
      onMeetingContext={() => setContext(true)}
    />
  );
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
        {slot.lead && <LeadCard key={slot.lead.key} {...entry(slot.lead)} />}
        {slot.followers.length > 0 && (
          <ul className="heads-up-lines" aria-label={slot.lead ? "Also timely" : "Timely"}>
            {slot.followers.map((h) => (
              <Line key={h.key} {...entry(h)} />
            ))}
          </ul>
        )}
        {slot.more.length > 0 && (
          <Disclosure className="heads-up-more" title={plural(slot.more.length, "more Heads-up")}>
            <ul className="heads-up-lines">
              {slot.more.map((h) => (
                <Line key={h.key} {...entry(h)} />
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
