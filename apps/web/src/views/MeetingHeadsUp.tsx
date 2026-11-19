import { useId, useLayoutEffect, useRef } from "react";
import type { HeadsUp, HeadsUpAction, MeetingPrep } from "../heads-ups.ts";
import { spokenTime } from "../zoned-time.ts";
import { Icon } from "../components/icons.tsx";
import { hueClass } from "../theme/hues.ts";
import { RelatedNoteChips } from "./BriefingParts.tsx";

/**
 * Meeting prep in For you now: the lead card (Join first during the meeting) and the compact follower line (subject,
 * "On your calendar", the interval and Open prep). Open prep shows the attendees and the related notes the latest
 * briefing found, labelled with that briefing's time; a follower's real Calendar and Meet destinations and its
 * decisions are there too.
 */

export interface MeetingHandlers {
  onOpenPrep: () => void;
  onDone: () => void;
  onNotNow: () => void;
  /** A decision on this item is on its way: Done and Not now wait. */
  busy: boolean;
}

interface MeetingProps extends MeetingHandlers {
  headsUp: HeadsUp & { meeting: MeetingPrep };
  open: boolean;
  /** The current instant and zone, for "the briefing at 08:02". */
  clock: { now: number; timeZone: string };
}

/** One action, the first of a row emphasised. Links open the real event and call in a new tab. */
function Action({ action, meeting, open, primary, small, on }: { action: HeadsUpAction; meeting: MeetingPrep; open: boolean; primary: boolean; small: boolean; on: MeetingHandlers }) {
  const cls = [primary ? "primary" : "", small ? "small" : ""].filter(Boolean).join(" ");
  switch (action) {
    case "join":
      return meeting.meetLink ? (
        <a className={`btn ${cls}`} href={meeting.meetLink} target="_blank" rel="noreferrer" data-meeting-action="join">
          Join
        </a>
      ) : null;
    case "calendar":
      return meeting.calendarUrl ? (
        <a className={`btn ${cls}`} href={meeting.calendarUrl} target="_blank" rel="noreferrer" data-meeting-action="calendar">
          Open in Google Calendar
        </a>
      ) : null;
    case "done":
      return (
        <button className={cls} disabled={on.busy} onClick={on.onDone}>
          Done
        </button>
      );
    case "not-now":
      return (
        <button className={`ghost ${small ? "small" : ""}`} disabled={on.busy} onClick={on.onNotNow}>
          Not now
        </button>
      );
    case "open-prep":
      return (
        <button className={primary ? cls : `ghost ${small ? "small" : ""}`} aria-expanded={open} onClick={on.onOpenPrep}>
          Open prep
        </button>
      );
    default:
      return null;
  }
}

function MeetingActions({ actions, meeting, open, small, on }: { actions: readonly HeadsUpAction[]; meeting: MeetingPrep; open: boolean; small: boolean; on: MeetingHandlers }) {
  return (
    <div className="heads-up-actions">
      {actions.map((a, n) => (
        <Action key={a} action={a} meeting={meeting} open={open} primary={n === 0} small={small} on={on} />
      ))}
    </div>
  );
}

/** What the latest briefing found for this meeting, or that it found nothing, or that no briefing looked yet. */
function Notes({ notes, clock }: { notes: MeetingPrep["notes"]; clock: { now: number; timeZone: string } }) {
  const headingId = useId();
  if (!notes)
    return (
      <p className="meeting-prep-notes-none" data-meeting-notes="none">
        No briefing has looked at this meeting yet, so there are no related notes. Prepare a briefing to find some.
      </p>
    );
  const found = `the briefing ${spokenTime(notes.foundAt, clock.now, clock.timeZone)}`;
  if (!notes.related.length)
    return (
      <p className="meeting-prep-notes-none" data-meeting-notes="empty">
        No related notes: {found} found none in your Brain.
      </p>
    );
  return (
    <div className="meeting-prep-notes" role="group" aria-labelledby={headingId} data-meeting-notes="found">
      <p className="meeting-prep-label" id={headingId}>
        Related notes · As {found} found them
      </p>
      <RelatedNoteChips related={notes.related} />
    </div>
  );
}

/**
 * Open prep: the interval, the attendees and the related notes. A follower keeps its actions and its why here, so its
 * line stays one line.
 */
function MeetingDetail({ headsUp, follower, open, on, clock }: { headsUp: HeadsUp & { meeting: MeetingPrep }; follower: boolean; open: boolean; on: MeetingHandlers; clock: MeetingProps["clock"] }) {
  const m = headsUp.meeting;
  return (
    <div className="meeting-prep-detail" data-meeting-detail>
      {follower && <MeetingActions actions={headsUp.actions.filter((a) => a !== "open-prep")} meeting={m} open={open} small on={on} />}
      {follower && <p className="heads-up-why">{headsUp.why}</p>}
      <p className="meeting-prep-who">
        <span className="meeting-prep-label">{m.interval}</span>
        {m.attendees.length ? ` · With ${m.attendees.join(", ")}` : " · No one else is listed"}
      </p>
      <Notes notes={m.notes} clock={clock} />
    </div>
  );
}

/**
 * The lead meeting: "On your calendar" and when it starts or ends over the subject, then every action (Join first
 * once it runs) beside its why. The interval is inside Open prep.
 */
export function MeetingLead({ headsUp, open, clock, ...on }: MeetingProps) {
  const titleId = useId();
  const m = headsUp.meeting;
  return (
    <article className={`heads-up-lead meeting ${hueClass("blue")}`} aria-labelledby={titleId} data-heads-up={headsUp.kind} data-heads-up-key={headsUp.key} data-meeting-phase={m.phase}>
      <p className="heads-up-eyebrow">
        <Icon name="calendar-notes" size={16} />
        {/* Each phrase stays whole when the line wraps on a narrow screen. */}
        <span className="heads-up-eyebrow-parts">
          <span>{headsUp.label}</span> · <span>{headsUp.explanation}</span> · <span data-meeting-timing>{headsUp.timing}</span>
        </span>
      </p>
      <h3 className="heads-up-title" id={titleId}>
        {headsUp.title}
      </h3>
      <div className="heads-up-foot">
        <MeetingActions actions={headsUp.actions} meeting={m} open={open} small={false} on={on} />
        <p className="heads-up-why">{headsUp.why}</p>
      </div>
      {open && <MeetingDetail headsUp={headsUp} follower={false} open={open} on={on} clock={clock} />}
    </article>
  );
}

/** A follower meeting: one line with its subject, "On your calendar", its interval and Open prep; the rest is inside. */
export function MeetingLine({ headsUp, open, clock, ...on }: MeetingProps) {
  const m = headsUp.meeting;
  return (
    <li className="heads-up-line meeting" data-heads-up={headsUp.kind} data-heads-up-key={headsUp.key} data-meeting-phase={m.phase}>
      <span className={`heads-up-line-icon ${hueClass("blue")}`}>
        <Icon name="calendar-notes" size={16} />
      </span>
      <div className="heads-up-line-text">
        <p className="heads-up-line-head">
          <strong>{headsUp.title}</strong>
          <span className="heads-up-line-timing">
            {" "}
            · {headsUp.explanation} · {m.interval}
          </span>
        </p>
      </div>
      <div className="heads-up-actions">
        <Action action="open-prep" meeting={m} open={open} primary={false} small on={on} />
      </div>
      {open && <MeetingDetail headsUp={headsUp} follower open={open} on={on} clock={clock} />}
    </li>
  );
}

/**
 * A held meeting whose scheduled end has passed (`endedMeetings`): its place shows "Meeting ended" and its subject at
 * the size it had, with nothing to press, until the hold ends, so nothing below it moves and no Join is left that
 * reaches a call. When the keyboard was in it, the focus lands here (Enter does nothing), not on the next call's Join.
 */
export function MeetingEnded({ headsUp, line, height, takeFocus }: { headsUp: HeadsUp; line: boolean; height: number | undefined; takeFocus: boolean }) {
  const ref = useRef<HTMLElement & HTMLLIElement>(null);
  const focus = useRef(takeFocus);
  // On arrival only: the control the keyboard was on has just gone with the content this replaces.
  useLayoutEffect(() => {
    if (focus.current) ref.current?.focus({ preventScroll: true });
  }, []);
  const Tag = line ? "li" : "article";
  return (
    <Tag
      ref={ref}
      tabIndex={-1}
      className={`${line ? "heads-up-line" : "heads-up-lead"} meeting heads-up-ended`}
      style={height ? { height } : undefined}
      aria-label={`Meeting ended: ${headsUp.title}`}
      data-heads-up={headsUp.kind}
      data-heads-up-key={headsUp.key}
      data-meeting-ended
    >
      <span className="heads-up-line-icon">
        <Icon name="calendar-notes" size={16} />
      </span>
      <p className="heads-up-ended-text">
        <strong>Meeting ended</strong> · {headsUp.title}
      </p>
    </Tag>
  );
}
