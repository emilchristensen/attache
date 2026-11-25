/**
 * Open prep for a meeting prep Inbox item (pure, table tests in `apps/web/test/meeting-prep.test.ts`): the meeting's
 * interval in the current zone, who else is in it, and the related notes the newest briefing that looked at it found.
 */
import type { AttentionItemView, BriefingRelatedNote, BriefingView } from "@attache/contracts";
import { clockTime } from "./zoned-time.ts";

export interface MeetingPrep {
  /** "14:30 to 15:00", in the current zone. */
  interval: string;
  attendees: readonly string[];
  /**
   * The related notes the newest briefing that looked at this item found (matched by its id), and when that briefing
   * was written; null when no briefing looked at this meeting.
   */
  notes: { related: readonly BriefingRelatedNote[]; foundAt: number } | null;
}

/** The prep of a meeting prep item, or null for any other item (or one from before items carried their meeting). */
export function meetingPrep(item: AttentionItemView, briefings: ReadonlyArray<BriefingView | null>, timeZone: string): MeetingPrep | null {
  if (item.kind !== "meeting_prep" || !item.meeting) return null;
  const looked = briefings
    .filter((b): b is BriefingView => b !== null)
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
    .flatMap((b) => {
      const found = b.sections.filter((s) => s.id === "meetings").flatMap((s) => s.items).find((i) => i.id === item.id);
      return found ? [{ related: found.related ?? [], foundAt: Date.parse(b.createdAt) }] : [];
    });
  return {
    interval: `${clockTime(Date.parse(item.meeting.start), timeZone)} to ${clockTime(Date.parse(item.meeting.end), timeZone)}`,
    attendees: item.meeting.attendees,
    notes: looked[0] ?? null,
  };
}
