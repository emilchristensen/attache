/**
 * For you now: the short list of open Inbox items the owner should act on now, each with its reason (its Heads-up).
 * One registry of reasons (`REASONS`), most urgent first, says for each when it applies to an item, what it says, and
 * so when it ends: an item leaves once no reason applies. Meeting prep is listed only for its meeting, so opening the
 * prep takes it off. An item with several reasons appears once, under its most
 * urgent one; within a reason, items keep the Inbox's service order.
 *
 * Pure: the clock, the time zone and the latest Daily Briefing come in as input, so every rule is a table test
 * against a fixed clock (`apps/web/test/for-you-now.test.ts`).
 */
import { plural, type AttentionItemView, type BriefingView } from "@attache/contracts";
import { HOUR_MS, MEETING_LEAD_MS, MINUTE_MS } from "./heads-up-rules.ts";
import { rowContext, rowText } from "./inbox-rows.ts";
import { clockTime, dayKey, dueDayKey, isDateOnly, isWeekend, startOfDay } from "./zoned-time.ts";

export { MEETING_LEAD_MS } from "./heads-up-rules.ts";
/** A reply is nearly late once the other person has waited this much working time (Saturday and Sunday not counted). */
export const REPLY_WORKING_DAY_MS = 24 * HOUR_MS;
/** Any item is nearly late from this long before its due time. */
export const REPLY_DUE_SOON_MS = 2 * HOUR_MS;
/** At most this many entries show; the rest are counted as "N more in the Inbox". */
export const FOR_YOU_NOW_LIMIT = 5;

export type ForYouNowReason = "meeting-prep" | "reply-nearly-late" | "due-today" | "picked-this-morning";

export interface ForYouNowEntry {
  item: AttentionItemView;
  reason: ForYouNowReason;
  reasonText: string;
}

export interface ForYouNowInput {
  items: readonly AttentionItemView[];
  /** The latest Daily Briefing; its top picks count only on the day it was written. */
  briefing: BriefingView | null;
  now: number;
  timeZone: string;
}

export interface ForYouNowResult {
  entries: ForYouNowEntry[];
  moreInInbox: number;
  /** The one quiet line when no reason applies, else null. */
  quiet: string | null;
}

interface Context {
  briefing: BriefingView | null;
  now: number;
  timeZone: string;
}

interface Reason {
  id: ForYouNowReason;
  applies: (item: AttentionItemView, ctx: Context) => boolean;
  text: (item: AttentionItemView, ctx: Context) => string;
}

const REPLY_KINDS: ReadonlySet<string> = new Set(["pending_reply", "mention"]);
/** Any four calendar days hold at least one working day, so a wait that long needs no counting. */
const DAYS_HOLDING_A_WORKING_DAY = 4;

/** Whether the working time (Monday to Friday, in `timeZone`) between two instants reaches one working day. */
function waitedWorkingDay(from: number, to: number, timeZone: string): boolean {
  if (to >= startOfDay(from, timeZone, DAYS_HOLDING_A_WORKING_DAY)) return true;
  const days = Array.from({ length: DAYS_HOLDING_A_WORKING_DAY }, (_, n) => ({ start: Math.max(from, startOfDay(from, timeZone, n)), end: Math.min(to, startOfDay(from, timeZone, n + 1)) }));
  const worked = days.filter((d) => d.end > d.start && !isWeekend(d.start, timeZone)).reduce((sum, d) => sum + d.end - d.start, 0);
  return worked >= REPLY_WORKING_DAY_MS;
}

/** Within 2 hours of a due time. A bare due date has no time of day, so it is never due soon: Due today covers it. */
const dueSoon = (item: AttentionItemView, now: number) => {
  const due = item.dueAt && !isDateOnly(item.dueAt) ? Date.parse(item.dueAt) : NaN;
  return due >= now && due <= now + REPLY_DUE_SOON_MS;
};

/** "Due in 45 min", "Due in 2 hours". */
function dueInText(due: number, now: number): string {
  const minutes = Math.ceil((due - now) / MINUTE_MS);
  return minutes < HOUR_MS / MINUTE_MS ? `Due in ${minutes} min` : `Due in ${plural(Math.round((due - now) / HOUR_MS), "hour")}`;
}

/** The registry, most urgent first. */
export const REASONS: readonly Reason[] = [
  {
    id: "meeting-prep",
    applies: (item, { now }) => item.kind === "meeting_prep" && !!item.meeting && !item.startedAt && now >= Date.parse(item.meeting.start) - MEETING_LEAD_MS && now < Date.parse(item.meeting.end),
    text: (item, { now }) => {
      const minutes = Math.ceil((Date.parse(item.meeting!.start) - now) / MINUTE_MS);
      return minutes > 0 ? `Starts in ${minutes} min, prep not read` : "Meeting started, prep not read";
    },
  },
  {
    id: "reply-nearly-late",
    applies: (item, { now, timeZone }) => item.kind !== "meeting_prep" && (dueSoon(item, now) || (REPLY_KINDS.has(item.kind) && waitedWorkingDay(Date.parse(item.firstSeenAt), now, timeZone))),
    text: (item, { now, timeZone }) => {
      if (dueSoon(item, now)) return dueInText(Date.parse(item.dueAt!), now);
      const since = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long" }).format(Date.parse(item.firstSeenAt));
      const who = rowContext(item);
      return who ? `${who} has waited since ${since}` : `Waiting since ${since}`;
    },
  },
  {
    id: "due-today",
    applies: (item, { now, timeZone }) => item.kind !== "meeting_prep" && !!item.dueAt && dueDayKey(item.dueAt, timeZone) === dayKey(now, timeZone),
    text: () => "Due today",
  },
  {
    id: "picked-this-morning",
    applies: (item, { briefing, now, timeZone }) => item.kind !== "meeting_prep" && briefing?.kind === "daily" && dayKey(Date.parse(briefing.createdAt), timeZone) === dayKey(now, timeZone) && briefing.topPicks.includes(item.id),
    text: () => "Picked in this morning’s Daily Briefing",
  },
];

function entryFor(item: AttentionItemView, ctx: Context): ForYouNowEntry | null {
  if (item.state !== "open") return null;
  const reason = REASONS.find((r) => r.applies(item, ctx));
  return reason ? { item, reason: reason.id, reasonText: reason.text(item, ctx) } : null;
}

/** "Next: prep for Pilot handover at 13:45", or "tomorrow at 09:00"; null when no meeting prep is ahead. */
function nextPrep(items: readonly AttentionItemView[], { now, timeZone }: Context): string | null {
  const next = items
    .filter((item) => item.state === "open" && item.kind === "meeting_prep" && item.meeting && !item.startedAt && Date.parse(item.meeting.start) - MEETING_LEAD_MS > now)
    .map((item) => ({ item, at: Date.parse(item.meeting!.start) }))
    .toSorted((a, b) => a.at - b.at)[0];
  if (!next) return null;
  const day = dayKey(next.at, timeZone) === dayKey(now, timeZone) ? "" : "tomorrow ";
  return `Next: prep for ${rowText(next.item).subject} ${day}at ${clockTime(next.at, timeZone)}`;
}

export function curateForYouNow({ items, briefing, now, timeZone }: ForYouNowInput): ForYouNowResult {
  const ctx: Context = { briefing, now, timeZone };
  const rank = (e: ForYouNowEntry) => REASONS.findIndex((r) => r.id === e.reason);
  // `toSorted` is stable, so within a reason the Inbox's service order stands.
  const all = items.flatMap((item) => entryFor(item, ctx) ?? []).toSorted((a, b) => rank(a) - rank(b));
  const entries = all.slice(0, FOR_YOU_NOW_LIMIT);
  const quiet = entries.length ? null : ["Nothing right now.", nextPrep(items, ctx)].filter(Boolean).join(" ");
  return { entries, moreInInbox: all.length - entries.length, quiet };
}
