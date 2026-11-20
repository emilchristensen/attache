/**
 * For you now: the Heads-ups on Home, computed in the Dashboard from what the service already returns and fixed
 * rules. A registry of kinds (`HEADS_UP_KINDS`) says, for each kind, when it applies, how urgent it is, what it says,
 * what the owner can do, and why it is here and when it leaves. The slot (`forYouNow`) orders what applies, picks the
 * lead and the followers, and says what comes next when nothing is timely. A new kind is a new registry entry; the
 * slot, the ordering, the leaving rules and the "why" line stay as they are.
 *
 * Pure: the clock, the time zone and what the owner settled in this browser come in as input, so every rule is a
 * table test against a fixed clock.
 */
import type { AttentionItemView, BriefingView } from "@attache/contracts";
import { meetingPrep, type MeetingPrep } from "./heads-up-meeting.ts";
import { byUrgency, VISIBLE_FOLLOWERS } from "./heads-up-rules.ts";

// The rules, as named constants, live in `heads-up-rules.ts`; meeting prep's kind in `heads-up-meeting.ts`.
export * from "./heads-up-rules.ts";
export { endedMeetings, meetingPrep, promotedMeetings, withArrivedMeetings, type MeetingPrep, type Placed } from "./heads-up-meeting.ts";

// ---- inputs ----------------------------------------------------------------------------------------------------------

export type { BriefingView } from "@attache/contracts";
export type BriefingKind = BriefingView["kind"];
export type BriefingRelatedNote = BriefingView["sections"][number]["items"][number]["related"] extends Array<infer T> | undefined ? T : never;
export type BriefingSectionItem = BriefingView["sections"][number]["items"][number];

/** A briefing job queued or running on this Machine. */
export interface BriefingJob {
  id: string;
  progress: number;
  note: string | null;
}

export interface HeadsUpInput {
  /** The current instant. */
  now: number;
  /** The browser's current IANA zone; times are shown and days are counted in it. */
  timeZone: string;
  /** The latest briefing, `null` when there is none, `"unknown"` while it is not known (loading or failed). */
  briefing: BriefingView | null | "unknown";
  briefingJob: BriefingJob | null;
  /** Occurrence keys the owner settled in this browser (Got it, Not now). */
  settled: ReadonlySet<string>;
  /**
   * The daily briefing's schedule row as the service's scheduler keeps it (`/status`): whether it runs and the instant
   * it runs next. `null` when not known.
   */
  schedule: { enabled: boolean; nextRunAt: string | null } | null;
  /**
   * The open Inbox items (only meeting prep with a meeting counts here), `"unknown"` while the Inbox has not answered.
   * Meeting prep is a view of its Inbox item: Done is the item's decision, and the item is not listed below while shown.
   */
  meetings: readonly AttentionItemView[] | "unknown";
}

// ---- outputs ---------------------------------------------------------------------------------------------------------

export type HeadsUpKindId = "daily-briefing" | "away-summary" | "requested-briefing" | "earlier-today" | "briefing-progress" | "meeting-prep";

/**
 * What the owner can do with a Heads-up, in the order offered; the view draws each one. Meeting prep: `open-prep`
 * opens the attendees and related notes in place, `calendar` opens the event in Google Calendar, `join` the call,
 * `done` is the Inbox item's Done decision and `not-now` hides the Heads-up while the item stays open.
 */
export type HeadsUpAction = "read-briefing" | "got-it" | "open-prep" | "calendar" | "join" | "done" | "not-now";

export interface HeadsUp {
  /** One occurrence: what Got it remembers and what the view keys by, so a re-render keeps focus in place. */
  key: string;
  kind: HeadsUpKindId;
  /** A card can lead; a line is always compact. */
  form: "card" | "line";
  rank: number;
  /** The instant it is about, for ordering within a rank. */
  at: number;
  /** The kind in words. */
  label: string;
  /** When it leaves or when it was, such as "Until noon". */
  timing: string;
  /** One concrete development or subject. */
  title: string;
  /** One short explanation under the title, or null. */
  explanation: string | null;
  /** Why it is here and when it leaves. */
  why: string;
  actions: readonly HeadsUpAction[];
  briefing?: BriefingView;
  job?: BriefingJob;
  /** While held: the key of the progress line whose place this briefing took (`heldSlot`). */
  inPlaceOf?: string;
  meeting?: MeetingPrep;
}

export interface HeadsUpKind {
  id: HeadsUpKindId;
  /** The occurrences of this kind that apply at `input.now`. */
  applies: (input: HeadsUpInput) => HeadsUp[];
  /** What of this kind comes next when nothing is timely, as an instant and the words for it. */
  next?: (input: HeadsUpInput) => { at: number; text: string } | null;
}

export interface Slot {
  lead: HeadsUp | null;
  /** Compact lines under the lead, in order. */
  followers: HeadsUp[];
  /** Further eligible entries, in order, behind a disclosure. */
  more: HeadsUp[];
  /** The one quiet line when nothing is timely, or null; null too while an input is not known. */
  quiet: string | null;
}

// ---- the kinds -------------------------------------------------------------------------------------------------------

function knownBriefing(input: HeadsUpInput): BriefingView | null {
  return input.briefing === "unknown" ? null : input.briefing;
}

// ---- the slot --------------------------------------------------------------------------------------------------------

export const HEADS_UP_KINDS: readonly HeadsUpKind[] = [meetingPrep];

/** What For you now shows at `input.now`. */
export function forYouNow(input: HeadsUpInput, kinds: readonly HeadsUpKind[] = HEADS_UP_KINDS): Slot {
  const all = kinds.flatMap((k) => k.applies(input)).sort(byUrgency);
  const lead = all[0]?.form === "card" ? all[0] : null;
  const rest = lead ? all.slice(1) : all;
  return { lead, followers: rest.slice(0, VISIBLE_FOLLOWERS), more: rest.slice(VISIBLE_FOLLOWERS), quiet: all.length ? null : quietLine(input, kinds) };
}

/** Nothing is timely: say so, and what comes next soonest. Null while an input is not known, so it never claims too much. */
function quietLine(input: HeadsUpInput, kinds: readonly HeadsUpKind[]): string | null {
  if (input.briefing === "unknown" || input.meetings === "unknown") return null;
  const next = kinds
    .map((k) => k.next?.(input) ?? null)
    .filter((n) => n !== null)
    .sort((a, b) => a.at - b.at)[0];
  return next ? `Nothing timely right now. ${next.text}` : "Nothing timely right now.";
}

// ---- the hold --------------------------------------------------------------------------------------------------------

/**
 * Whether the briefing job held in `held` (its progress line) has ended and a briefing newer than the held one is in
 * `live`: the briefing that line promised.
 */
export function briefingWritten(held: HeadsUpInput, live: HeadsUpInput): boolean {
  const written = knownBriefing(live);
  return !!held.briefingJob && !!written && written.id !== knownBriefing(held)?.id && live.briefingJob?.id !== held.briefingJob.id;
}

/**
 * What For you now shows while the pointer or focus is inside the Heads-ups: the slot of `held`, the input when the
 * hold began (with the owner's own Got it added), so nothing moves or leaves under the owner. A newer briefing, the
 * clock and another tab's Got it all wait until the hold ends.
 *
 * One thing comes through: a progress line is a promise of the briefing it writes, so once that briefing is here
 * (`handoff`, the first input where `briefingWritten` holds, kept as it was for the rest of the hold), it takes the
 * line's place, as a line marked `inPlaceOf` that line, and nothing around it moves. It takes its own place in the
 * order when the hold ends. Without this, a briefing the owner just asked for would wait behind its own finished
 * progress line for as long as the pointer happened to rest where the Briefings menu was.
 */
export function heldSlot(held: HeadsUpInput, handoff: HeadsUpInput | null, kinds: readonly HeadsUpKind[] = HEADS_UP_KINDS): Slot {
  const slot = forYouNow(held, kinds);
  if (!handoff || !briefingWritten(held, handoff)) return slot;
  const entries = [...slot.followers, ...slot.more];
  const at = entries.findIndex((h) => h.kind === "briefing-progress");
  if (at < 0) return slot;
  const written = knownBriefing(handoff)!;
  // Settled as held: the owner's own Got it applies at once, another tab's waits.
  const now = forYouNow({ ...handoff, settled: held.settled }, kinds);
  const arrived = [now.lead, ...now.followers, ...now.more]
    .filter((h): h is HeadsUp => h?.briefing?.id === written.id)
    .map((h) => ({ ...h, inPlaceOf: entries[at]!.key }));
  const next = [...entries.slice(0, at), ...arrived, ...entries.slice(at + 1)];
  const empty = !slot.lead && !next.length;
  return { lead: slot.lead, followers: next.slice(0, VISIBLE_FOLLOWERS), more: next.slice(VISIBLE_FOLLOWERS), quiet: empty ? quietLine(held, kinds) : null };
}
