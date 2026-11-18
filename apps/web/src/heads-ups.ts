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
import type { AttentionItemView } from "@attache/contracts";
import { briefingLines } from "./briefing-text.ts";
import { meetingPrep, type MeetingPrep } from "./heads-up-meeting.ts";
import { byUrgency, DAILY_BRIEFING_UNTIL, RANK, REQUESTED_BRIEFING_STAYS_MS, VISIBLE_FOLLOWERS } from "./heads-up-rules.ts";
import { atTimeOfDay, clockTime, sameDay, spokenTime, startOfDay } from "./zoned-time.ts";

// The rules, as named constants, live in `heads-up-rules.ts`; meeting prep's kind in `heads-up-meeting.ts`.
export * from "./heads-up-rules.ts";
export { meetingPrep, promotedMeetings, withArrivedMeetings, type MeetingPrep, type Placed } from "./heads-up-meeting.ts";

// ---- inputs ----------------------------------------------------------------------------------------------------------

export type BriefingKind = "daily" | "away" | "manual";

export interface BriefingRelatedNote {
  title: string;
  relPath: string;
  lines: [number, number];
}

export interface BriefingSectionItem {
  /** The Inbox item's id: how meeting prep finds its related notes, never by title. */
  id: string;
  title: string;
  summary: string;
  url: string | null;
  isNew: boolean;
  changed: boolean;
  related?: BriefingRelatedNote[];
}

/** `GET /briefings/latest`: the newest briefing of any kind, from this Machine or replicated from the Reader. */
export interface BriefingView {
  id: string;
  kind: BriefingKind;
  createdAt: string;
  since: string | null;
  summary: string;
  sections: Array<{ id: string; title: string; items: BriefingSectionItem[] }>;
  counts: { open: number; new: number; changed: number; drafts: number; proposals: number; failedSources: number };
  deliverablePath: string | null;
}

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
  /** The kind in words, such as "Morning briefing". */
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

/** A sentence that only counts, as the summary written without a model opens: "2 deadlines, 1 review request." */
const COUNTS_ONLY = /^\d+ [^,.\d]+(?:, \d+ [^,.\d]+)*\.$/;

/**
 * The concrete development and its short explanation: the summary's first sentence and the one after it. A first
 * sentence that only counts, or has no words, is no development, so then the first new or changed item leads (else the first item),
 * with its own summary; the counts stay in the full briefing.
 */
function headline(b: BriefingView): { title: string; explanation: string | null } {
  const lines = briefingLines(b.summary);
  const first = lines[0]?.text ?? "Your briefing is ready.";
  const items = b.sections.flatMap((s) => s.items);
  // No words at all (the no-model summary of Other items alone opens with a bare ".") is no development either.
  const noDevelopment = COUNTS_ONLY.test(first) || !/\p{L}/u.test(first);
  const item = noDevelopment ? (items.find((i) => i.isNew || i.changed) ?? items[0]) : undefined;
  if (item) return { title: item.title, explanation: item.summary || null };
  return { title: first, explanation: lines[1]?.text ?? null };
}

function briefingKey(b: BriefingView): string {
  return `briefing:${b.id}`;
}

const dailyBriefing: HeadsUpKind = {
  id: "daily-briefing",
  applies: (input) => {
    const b = knownBriefing(input);
    if (!b || b.kind !== "daily") return [];
    const made = Date.parse(b.createdAt);
    const until = atTimeOfDay(made, input.timeZone, DAILY_BRIEFING_UNTIL);
    if (input.now >= until || input.settled.has(briefingKey(b))) return [];
    return [
      {
        key: briefingKey(b),
        kind: "daily-briefing",
        form: "card",
        rank: RANK.briefing,
        at: made,
        label: "Morning briefing",
        timing: "Until noon",
        ...headline(b),
        why: `Written at ${clockTime(made, input.timeZone)} for this morning. It leaves at noon, or when you press Got it.`,
        actions: ["read-briefing", "got-it"],
        briefing: b,
      },
    ];
  },
  next: (input) => {
    const schedule = input.schedule;
    if (!schedule) return null;
    if (!schedule.enabled) return { at: Number.POSITIVE_INFINITY, text: "The daily briefing is switched off." };
    // An instant from the scheduler, in whatever zone it keeps: shown in the zone the browser is in now.
    const at = schedule.nextRunAt ? Date.parse(schedule.nextRunAt) : Number.NaN;
    if (!(at > input.now)) return null;
    const time = clockTime(at, input.timeZone);
    if (sameDay(at, input.now, input.timeZone)) return { at, text: `The daily briefing is scheduled for ${time}.` };
    if (startOfDay(input.now, input.timeZone, 1) === startOfDay(at, input.timeZone)) return { at, text: `The next daily briefing is scheduled for ${time} tomorrow.` };
    return { at, text: `The next daily briefing is scheduled ${spokenTime(at, input.now, input.timeZone)}.` };
  },
};

/**
 * The daily briefing once it has left (noon or Got it): one line until midnight, for as long as it is the latest
 * briefing, so the owner can reopen it. Yesterday's briefing never shows: its day is over.
 */
const earlierToday: HeadsUpKind = {
  id: "earlier-today",
  applies: (input) => {
    const b = knownBriefing(input);
    if (!b || b.kind !== "daily") return [];
    if (dailyBriefing.applies(input).length) return [];
    const made = Date.parse(b.createdAt);
    if (!sameDay(made, input.now, input.timeZone)) return [];
    const at = clockTime(made, input.timeZone);
    return [
      {
        key: `earlier:${b.id}`,
        kind: "earlier-today",
        form: "line",
        rank: RANK.earlier,
        at: made,
        label: "Daily briefing",
        timing: `Earlier today, ${at}`,
        ...headline(b),
        why: `Written at ${at}. It stays here until midnight while it is the latest briefing.`,
        actions: ["read-briefing"],
        briefing: b,
      },
    ];
  },
};

/** An away summary or a briefing the owner asked for: until Got it or four hours after it was made. */
function requestedKind(id: "away-summary" | "requested-briefing", briefingKind: BriefingKind, label: string): HeadsUpKind {
  return {
    id,
    applies: (input) => {
      const b = knownBriefing(input);
      if (!b || b.kind !== briefingKind) return [];
      const made = Date.parse(b.createdAt);
      const until = made + REQUESTED_BRIEFING_STAYS_MS;
      if (input.now >= until || input.settled.has(briefingKey(b))) return [];
      const leaves = clockTime(until, input.timeZone);
      return [
        {
          key: briefingKey(b),
          kind: id,
          form: "card",
          rank: RANK.briefing,
          at: made,
          label,
          timing: `Until ${leaves}`,
          ...headline(b),
          why: `You asked for it ${spokenTime(made, input.now, input.timeZone)}. It leaves at ${leaves}, or when you press Got it.`,
          actions: ["read-briefing", "got-it"],
          briefing: b,
        },
      ];
    },
  };
}

/** A briefing being written on this Machine: one progress line until the job ends. */
const briefingProgress: HeadsUpKind = {
  id: "briefing-progress",
  applies: (input) => {
    const job = input.briefingJob;
    if (!job) return [];
    return [
      {
        key: `progress:${job.id}`,
        kind: "briefing-progress",
        form: "line",
        rank: RANK.progress,
        at: input.now,
        label: "Preparing a briefing",
        timing: `${Math.round(job.progress * 100)}%`,
        title: job.note ?? "Queued",
        explanation: null,
        why: "Here while the briefing is written. It keeps running if you close this tab.",
        actions: [],
        job,
      },
    ];
  },
};

// ---- the slot --------------------------------------------------------------------------------------------------------

export const HEADS_UP_KINDS: readonly HeadsUpKind[] = [meetingPrep, dailyBriefing, requestedKind("away-summary", "away", "Away summary"), requestedKind("requested-briefing", "manual", "Briefing you asked for"), briefingProgress, earlierToday];

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
