/**
 * Meeting prep, one Heads-up kind of For you now's registry (`HEADS_UP_KINDS` in `heads-ups.ts`): an open meeting
 * prep Inbox item shown from `MEETING_LEAD_MS` before its meeting starts until the scheduled end. It is a view of the
 * item, not a second item: Done is the item's decision, Not now settles only the Heads-up, and the Inbox leaves out
 * the items shown here (`promotedMeetings`). Pure, like the rest of the registry.
 */
import type { AttentionItemView, MeetingTimes } from "@attache/contracts";
import type { BriefingRelatedNote, HeadsUp, HeadsUpAction, HeadsUpInput, HeadsUpKind, Slot } from "./heads-ups.ts";
import { MEETING_LEAD_MS, RANK } from "./heads-up-rules.ts";
import { rowText } from "./inbox-rows.ts";
import { clockTime, sameDay } from "./zoned-time.ts";

/** What a meeting prep Heads-up knows of its meeting. */
export interface MeetingPrep {
  /** The Inbox item's id: Done decides it, and the Inbox leaves it out while it is shown here. */
  itemId: string;
  phase: "upcoming" | "in-progress";
  /** "14:30 to 15:00", in the current zone. */
  interval: string;
  /** The event in Google Calendar, or null when the item has no link. */
  calendarUrl: string | null;
  meetLink: string | null;
  attendees: readonly string[];
  /**
   * The related notes the latest briefing found for this item (matched by its id), and when that briefing was
   * written; null when the latest briefing did not look at this meeting.
   */
  notes: { related: readonly BriefingRelatedNote[]; foundAt: number } | null;
}

/** The open meeting prep items that carry their meeting, as the kind reads them. */
function meetingItems(input: HeadsUpInput): Array<AttentionItemView & { meeting: MeetingTimes }> {
  if (input.meetings === "unknown") return [];
  return input.meetings.filter((i): i is AttentionItemView & { meeting: MeetingTimes } => i.kind === "meeting_prep" && !!i.meeting);
}

const meetingKey = (itemId: string) => `meeting:${itemId}`;

/** What the latest briefing found for this item, by its id; null when it did not look at it. */
function briefingNotes(input: HeadsUpInput, itemId: string): MeetingPrep["notes"] {
  // Only types come from heads-ups.ts, which imports this kind: no import cycle at run time.
  const b = input.briefing === "unknown" ? null : input.briefing;
  const found = b?.sections.filter((s) => s.id === "meetings").flatMap((s) => s.items).find((i) => i.id === itemId);
  return b && found ? { related: found.related ?? [], foundAt: Date.parse(b.createdAt) } : null;
}

const UPCOMING_ACTIONS: readonly HeadsUpAction[] = ["open-prep", "calendar", "join", "done", "not-now"];
const IN_PROGRESS_ACTIONS: readonly HeadsUpAction[] = ["join", "calendar", "done", "not-now", "open-prep"];

/**
 * Meeting prep: one card per open meeting prep item, from `MEETING_LEAD_MS` before the start until the scheduled end,
 * unless Not now settled it. "Starts 14:00" before, "In progress, ends 15:00" with Join first during. Ranked before
 * briefings and ordered by start, so the meeting in progress comes first, then the next one.
 */
export const meetingPrep: HeadsUpKind = {
  id: "meeting-prep",
  applies: (input) =>
    meetingItems(input).flatMap((item): HeadsUp[] => {
      const start = Date.parse(item.meeting.start);
      const end = Date.parse(item.meeting.end);
      const key = meetingKey(item.id);
      if (input.now < start - MEETING_LEAD_MS || input.now >= end || input.settled.has(key)) return [];
      const phase = input.now < start ? "upcoming" : "in-progress";
      const [from, to] = [clockTime(start, input.timeZone), clockTime(end, input.timeZone)];
      const call = (a: HeadsUpAction) => a !== "join" || item.meeting.meetLink !== null;
      const leaves = `until it ends at ${to}, or until Done or Not now.`;
      return [
        {
          key,
          kind: "meeting-prep",
          form: "card",
          rank: RANK.meeting,
          at: start,
          label: "Meeting prep",
          timing: phase === "upcoming" ? `Starts ${from}` : `In progress, ends ${to}`,
          title: rowText(item).subject,
          explanation: "On your calendar",
          why:
            phase === "upcoming"
              ? `A meeting with other people starts at ${from}. It is here from ${clockTime(start - MEETING_LEAD_MS, input.timeZone)} ${leaves}`
              : `A meeting with other people, in progress. It is here ${leaves}`,
          actions: (phase === "upcoming" ? UPCOMING_ACTIONS : IN_PROGRESS_ACTIONS).filter(call),
          meeting: {
            itemId: item.id,
            phase,
            interval: `${from} to ${to}`,
            calendarUrl: item.url,
            meetLink: item.meeting.meetLink,
            attendees: item.meeting.attendees,
            notes: briefingNotes(input, item.id),
          },
        },
      ];
    }),
  next: (input) => {
    const soonest = meetingItems(input)
      .filter((i) => !input.settled.has(meetingKey(i.id)))
      .map((i) => ({ item: i, at: Date.parse(i.meeting.start) - MEETING_LEAD_MS }))
      .filter((n) => n.at > input.now)
      .sort((a, b) => a.at - b.at)[0];
    if (!soonest) return null;
    const when = sameDay(soonest.at, input.now, input.timeZone) ? `at ${clockTime(soonest.at, input.timeZone)}` : `tomorrow at ${clockTime(soonest.at, input.timeZone)}`;
    return { at: soonest.at, text: `Prep for ${rowText(soonest.item).subject} shows here ${when}.` };
  },
};

/** The ids of the Inbox items the slot shows as meeting prep: the Inbox leaves them out while they are shown here. */
export function promotedMeetings(slot: Slot): ReadonlySet<string> {
  return new Set([slot.lead, ...slot.followers, ...slot.more].flatMap((h) => (h?.meeting ? [h.meeting.itemId] : [])));
}
