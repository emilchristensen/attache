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
import { briefingLines } from "./briefing-text.ts";
import { atTimeOfDay, clockTime, sameDay, spokenTime, startOfDay } from "./zoned-time.ts";

// ---- the rules, as named constants -------------------------------------------------------------------------------

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
/** The daily briefing leads until this time of day, in the current zone on the briefing's day. */
export const DAILY_BRIEFING_UNTIL = "12:00";
/** How long an away summary or a briefing the owner asked for stays, from when it was made. */
export const REQUESTED_BRIEFING_STAYS_MS = 4 * HOUR_MS;
/** How often the slot is computed again; it is also computed again when the page becomes visible. */
export const HEADS_UP_TICK_MS = MINUTE_MS;
/** Followers shown under the lead; any further ones open from a disclosure, in order. */
export const VISIBLE_FOLLOWERS = 2;

/**
 * Urgency, most urgent first: a kind's place in the order. Within one rank, Heads-ups go by their time, then key.
 * Meeting prep (#26 of spec #14) takes `meeting`, so a meeting in progress, then the next one, come before briefings.
 */
export const RANK = { meeting: 10, briefing: 20, progress: 30, earlier: 40 } as const;

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
  /** The daily briefing's schedule from `/config`, `null` when not known. */
  schedule: { briefingAt: string; briefingEnabled: boolean } | null;
}

// ---- outputs ---------------------------------------------------------------------------------------------------------

export type HeadsUpKindId = "daily-briefing" | "away-summary" | "requested-briefing" | "earlier-today" | "briefing-progress";

/** What the owner can do with a Heads-up; the view draws each one. */
export type HeadsUpAction = "read-briefing" | "got-it";

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
  /** The instant it stops applying (exclusive), or null when only the owner's action ends it. */
  until: number | null;
  briefing?: BriefingView;
  job?: BriefingJob;
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

/** The first sentence of a briefing and the one after it: the concrete development and its short explanation. */
function headline(b: BriefingView): { title: string; explanation: string | null } {
  const lines = briefingLines(b.summary);
  const first = lines[0]?.text ?? "Your briefing is ready.";
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
        until,
        briefing: b,
      },
    ];
  },
  next: (input) => {
    const schedule = input.schedule;
    if (!schedule) return null;
    if (!schedule.briefingEnabled) return { at: Number.POSITIVE_INFINITY, text: "The daily briefing is switched off." };
    const today = atTimeOfDay(input.now, input.timeZone, schedule.briefingAt);
    if (today > input.now) return { at: today, text: `The daily briefing is scheduled for ${clockTime(today, input.timeZone)}.` };
    const tomorrow = atTimeOfDay(startOfDay(input.now, input.timeZone, 1), input.timeZone, schedule.briefingAt);
    return { at: tomorrow, text: `The next daily briefing is scheduled for ${clockTime(tomorrow, input.timeZone)} tomorrow.` };
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
        until: startOfDay(made, input.timeZone, 1),
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
          until,
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
        until: null,
        job,
      },
    ];
  },
};

// ---- the slot --------------------------------------------------------------------------------------------------------

export const HEADS_UP_KINDS: readonly HeadsUpKind[] = [dailyBriefing, requestedKind("away-summary", "away", "Away summary"), requestedKind("requested-briefing", "manual", "Briefing you asked for"), briefingProgress, earlierToday];

function byUrgency(a: HeadsUp, b: HeadsUp): number {
  return a.rank - b.rank || a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/** What For you now shows at `input.now`. */
export function forYouNow(input: HeadsUpInput, kinds: readonly HeadsUpKind[] = HEADS_UP_KINDS): Slot {
  const all = kinds.flatMap((k) => k.applies(input)).sort(byUrgency);
  const lead = all[0]?.form === "card" ? all[0] : null;
  const rest = lead ? all.slice(1) : all;
  return { lead, followers: rest.slice(0, VISIBLE_FOLLOWERS), more: rest.slice(VISIBLE_FOLLOWERS), quiet: all.length ? null : quietLine(input, kinds) };
}

/** Nothing is timely: say so, and what comes next soonest. Null while an input is not known, so it never claims too much. */
function quietLine(input: HeadsUpInput, kinds: readonly HeadsUpKind[]): string | null {
  if (input.briefing === "unknown") return null;
  const next = kinds
    .map((k) => k.next?.(input) ?? null)
    .filter((n) => n !== null)
    .sort((a, b) => a.at - b.at)[0];
  return next ? `Nothing timely right now. ${next.text}` : "Nothing timely right now.";
}
