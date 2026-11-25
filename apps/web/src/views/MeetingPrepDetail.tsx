import { useId } from "react";
import type { AttentionItemView } from "@attache/contracts";
import { MEETING_LEAD_MS } from "../heads-up-rules.ts";
import { meetingPrep, type MeetingPrep } from "../meeting-prep.ts";
import { spokenTime } from "../zoned-time.ts";
import { RelatedNoteChips } from "./BriefingParts.tsx";
import { useBriefings } from "./briefings.ts";

interface Clock {
  now: number;
  timeZone: string;
}

/** What the newest briefing that looked at this meeting found, or that it found nothing, or that none looked yet. */
function Notes({ notes, clock }: { notes: MeetingPrep["notes"]; clock: Clock }) {
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
 * Open prep, in a meeting prep row opened in place: the interval, who else is in it, the related notes, and Join from
 * 15 minutes before the meeting until it ends, as in Your day.
 */
export function MeetingPrepDetail({ item, clock }: { item: AttentionItemView; clock: Clock }) {
  const briefings = useBriefings();
  const prep = meetingPrep(item, [briefings.data?.daily ?? null, briefings.data?.requested ?? null], clock.timeZone);
  if (!prep) return null;
  return (
    <div className="meeting-prep-detail" data-meeting-detail>
      <p className="meeting-prep-who">
        <span className="meeting-prep-label">{prep.interval}</span>
        {prep.attendees.length ? ` · With ${prep.attendees.join(", ")}` : " · No one else is listed"}
      </p>
      <Notes notes={prep.notes} clock={clock} />
      {item.meeting?.meetLink && clock.now >= Date.parse(item.meeting.start) - MEETING_LEAD_MS && clock.now < Date.parse(item.meeting.end) && (
        <a className="btn small" href={item.meeting.meetLink} target="_blank" rel="noopener noreferrer">
          Join
        </a>
      )}
    </div>
  );
}
