import type { AttentionItemView, BriefingView } from "@attache/contracts";
import { clockTime } from "./zoned-time.ts";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const WORKING_DAY_MS = 24 * HOUR_MS;
export const MEETING_LEAD_MS = 15 * MINUTE_MS;
export const REPLY_WORKING_DAY_MS = WORKING_DAY_MS;
export const REPLY_DUE_SOON_MS = 2 * HOUR_MS;
export const FOR_YOU_NOW_LIMIT = 5;
export const FOR_YOU_NOW_TICK_MS = MINUTE_MS;

export type ForYouNowReason = "meeting-prep" | "reply-nearly-late" | "due-today" | "picked-this-morning";

export interface ForYouNowEntry {
  item: AttentionItemView;
  reason: ForYouNowReason;
  reasonText: string;
}

export interface ForYouNowInput {
  items: readonly AttentionItemView[];
  briefing: BriefingView | null;
  now: number;
  timeZone: string;
}

export interface ForYouNowResult {
  entries: ForYouNowEntry[];
  moreInInbox: number;
  quiet: string | null;
}

const REASON_RANK: Readonly<Record<ForYouNowReason, number>> = { "meeting-prep": 0, "reply-nearly-late": 1, "due-today": 2, "picked-this-morning": 3 };
const REPLY_KINDS = new Set(["pending_reply", "mention"]);

function workingMilliseconds(from: number, to: number, timeZone: string): number {
  if (to <= from) return 0;
  const cursor = new Date(from);
  let total = 0;
  while (cursor.getTime() < to) {
    const next = new Date(cursor);
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(0, 0, 0, 0);
    const boundary = Math.min(next.getTime(), to);
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(cursor);
    if (weekday !== "Sat" && weekday !== "Sun") total += boundary - cursor.getTime();
    cursor.setTime(boundary);
  }
  return total;
}

function localDay(iso: string, timeZone: string): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  return dateOnly ? iso : new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

function dueToday(item: AttentionItemView, now: number, timeZone: string): boolean {
  return item.kind !== "meeting_prep" && !!item.dueAt && localDay(item.dueAt, timeZone) === localDay(new Date(now).toISOString(), timeZone);
}

function replyNearlyLate(item: AttentionItemView, now: number, timeZone: string): boolean {
  if (!REPLY_KINDS.has(item.kind)) return false;
  if (item.dueAt) {
    const due = Date.parse(item.dueAt);
    if (due >= now && due <= now + REPLY_DUE_SOON_MS) return true;
  }
  return workingMilliseconds(Date.parse(item.firstSeenAt), now, timeZone) >= REPLY_WORKING_DAY_MS;
}

function reasonText(reason: ForYouNowReason, item: AttentionItemView, now: number, timeZone: string): string {
  if (reason === "meeting-prep") {
    const minutes = Math.max(0, Math.ceil((Date.parse(item.meeting!.start) - now) / MINUTE_MS));
    return minutes ? `Starts in ${minutes} min, prep not read` : "Meeting started, prep not read";
  }
  if (reason === "reply-nearly-late") {
    if (item.dueAt && Date.parse(item.dueAt) >= now) return `Due in ${Math.ceil((Date.parse(item.dueAt) - now) / MINUTE_MS / 60)} hours`;
    return `${item.title.replace(/^Reply to /, "")} has waited since ${new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long" }).format(new Date(item.firstSeenAt))}`;
  }
  if (reason === "due-today") return "Due today";
  return "Picked in this morning’s Daily Briefing";
}

function reasonFor(item: AttentionItemView, briefing: BriefingView | null, now: number, timeZone: string): ForYouNowReason | null {
  if (item.state !== "open") return null;
  if (item.kind === "meeting_prep" && item.meeting && !item.startedAt) {
    const start = Date.parse(item.meeting.start);
    if (now >= start - MEETING_LEAD_MS && now < Date.parse(item.meeting.end)) return "meeting-prep";
  }
  if (item.kind === "meeting_prep") return null;
  if (replyNearlyLate(item, now, timeZone)) return "reply-nearly-late";
  if (dueToday(item, now, timeZone)) return "due-today";
  if (briefing?.kind === "daily" && localDay(briefing.createdAt, timeZone) === localDay(new Date(now).toISOString(), timeZone) && briefing.topPicks.includes(item.id)) return "picked-this-morning";
  return null;
}

function nextPrep(items: readonly AttentionItemView[], now: number, timeZone: string): string | null {
  const next = items
    .filter((item) => item.state === "open" && item.kind === "meeting_prep" && item.meeting && !item.startedAt && Date.parse(item.meeting.start) - MEETING_LEAD_MS > now)
    .map((item) => ({ item, at: Date.parse(item.meeting!.start) }))
    .sort((a, b) => a.at - b.at || a.item.id.localeCompare(b.item.id))[0];
  return next ? `Next: prep for ${next.item.title.replace(/^Prepare for /, "")} at ${clockTime(next.at, timeZone)}` : null;
}

export function curateForYouNow({ items, briefing, now, timeZone }: ForYouNowInput): ForYouNowResult {
  const ranked = items.flatMap((item) => {
    const reason = reasonFor(item, briefing, now, timeZone);
    return reason ? [{ item, reason, reasonText: reasonText(reason, item, now, timeZone) }] : [];
  });
  const all = ranked
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => REASON_RANK[a.reason] - REASON_RANK[b.reason] || a.index - b.index)
    .map(({ index: _index, ...entry }) => entry);
  const entries = all.slice(0, FOR_YOU_NOW_LIMIT);
  const next = nextPrep(items, now, timeZone);
  return { entries, moreInInbox: Math.max(0, all.length - entries.length), quiet: entries.length ? null : ["Nothing right now.", next].filter(Boolean).join(" ") };
}
