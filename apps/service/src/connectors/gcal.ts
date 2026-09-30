import type { ConnectorAdapter, AdapterContext, AttentionCandidate, Observation, SyncResult } from "./types.ts";
import { CoverageTracker } from "./types.ts";
import { paginate } from "./http.ts";
import { asRemoteError, daysBetween, listingNote, listingState, recordFailure } from "./common.ts";
import { GOOGLE_SECRET_NAMES, buildAuthorizeUrl, completeGoogleAuthorization, configureGoogle, googleAuthMethod, googleRequest, googleSetupSteps, grantedScopes } from "./google.ts";

export interface EventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

interface Attendee {
  email?: string;
  displayName?: string;
  self?: boolean;
  resource?: boolean;
  responseStatus?: string;
}

interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  htmlLink?: string;
  location?: string;
  hangoutLink?: string;
  start?: EventTime;
  end?: EventTime;
  attendees?: Attendee[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
}

export const GCAL_READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

const DEFAULT_BASE = "https://www.googleapis.com";
const HOUR = 3_600_000;
const RANGE_MS = 48 * HOUR;
const PREP_MS = 24 * HOUR;
const MAX_PAGES = 3;
const MAX_NAMES = 6;
const SCOPE_LABEL = "Upcoming events (48 hours)";
const WALL_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?/;

function base(ctx: AdapterContext): string {
  return `${ctx.endpoint(DEFAULT_BASE).replace(/\/$/, "")}/calendar/v3`;
}

function isMidnight(m: RegExpExecArray): boolean {
  return m[2] === "00" && m[3] === "00" && (m[4] ?? "00") === "00" && /^0*$/.test(m[5] ?? "");
}

/**
 * True for all-day events: a date-only start, or a span that starts and ends
 * exactly at 00:00:00 wall-clock time (as written in the event's own offset)
 * covering one or more whole days. Some clients encode all-day blocks that way.
 */
export function looksAllDay(start: EventTime | undefined, end: EventTime | undefined): boolean {
  if (start?.date && !start.dateTime) return true;
  const s = WALL_TIME.exec(start?.dateTime ?? "");
  const e = WALL_TIME.exec(end?.dateTime ?? "");
  if (!s || !e || !isMidnight(s) || !isMidnight(e)) return false;
  const elapsed = Date.parse(end!.dateTime!) - Date.parse(start!.dateTime!);
  return daysBetween(s[1]!, e[1]!) >= 1 && elapsed >= 23 * HOUR;
}

function startMs(t: EventTime | undefined): number {
  return Date.parse(t?.dateTime ?? (t?.date ? `${t.date}T00:00:00` : ""));
}

/** Wall-clock start as written by Google (the calendar's own time zone), e.g. "2026-09-30 14:00". */
function startLabel(t: EventTime | undefined): string {
  if (t?.dateTime) return t.dateTime.slice(0, 16).replace("T", " ");
  return t?.date ?? "unknown time";
}

function selfResponse(ev: CalendarEvent): string {
  const self = (ev.attendees ?? []).find((a) => a.self);
  if (self) return self.responseStatus ?? "needsAction";
  return "accepted";
}

const people = (ev: CalendarEvent) => (ev.attendees ?? []).filter((a) => !a.resource);

function attendeeList(ev: CalendarEvent): string {
  const others = people(ev).filter((a) => !a.self);
  const names = others.slice(0, MAX_NAMES).map((a) => a.displayName || a.email || "unknown");
  const more = others.length - names.length;
  return `${names.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`;
}

function attentionFor(ev: CalendarEvent, allDay: boolean, response: string, nowMs: number): AttentionCandidate | undefined {
  const title = ev.summary || "(untitled event)";
  const when = startLabel(ev.start);
  const start = startMs(ev.start);
  const base = { key: `gcal:${ev.id}`, ...(ev.htmlLink ? { url: ev.htmlLink } : {}), dueAt: ev.start?.dateTime ?? ev.start?.date ?? null };
  if (response === "needsAction") {
    return { ...base, kind: "invite_response", title: `Respond to invite: ${title}`, summary: `Starts ${when}${people(ev).length ? ` with ${attendeeList(ev)}` : ""}.`, why: "You have not responded to this invitation yet.", priority: 60 };
  }
  const count = people(ev).length;
  if (allDay || response === "declined" || count < 2 || start < nowMs || start >= nowMs + PREP_MS) return undefined;
  const hours = Math.max(0, Math.round((start - nowMs) / HOUR));
  return { ...base, kind: "meeting_prep", title: `Prepare for ${title}`, summary: `Starts ${when} with ${attendeeList(ev)}.`, why: "A meeting with other people starts within 24 hours.", priority: Math.max(40, 75 - hours * 2) };
}

function toObservation(ev: CalendarEvent, nowMs: number): Observation {
  const allDay = looksAllDay(ev.start, ev.end);
  const response = selfResponse(ev);
  const count = people(ev).length;
  const attention = attentionFor(ev, allDay, response, nowMs);
  const start = ev.start?.dateTime ?? ev.start?.date ?? null;
  const end = ev.end?.dateTime ?? ev.end?.date ?? null;
  return {
    kind: "calendar_event",
    externalId: ev.id,
    title: ev.summary || "(untitled event)",
    ...(ev.htmlLink ? { url: ev.htmlLink } : {}),
    ...(ev.organizer?.email ? { author: ev.organizer.email } : {}),
    ...(start ? { occurredAt: start } : {}),
    data: { start, end, allDay, selfResponseStatus: response, attendeeCount: count, attendees: people(ev).map((a) => a.displayName || a.email || ""), location: ev.location ?? null, meetLink: ev.hangoutLink ?? null },
    fingerprintParts: [start, end, response, count],
    ...(attention ? { attention } : {}),
  };
}

async function listEvents(ctx: AdapterContext) {
  const now = ctx.now();
  return paginate<CalendarEvent>(
    async (cursor) => {
      const qs = new URLSearchParams({ timeMin: now.toISOString(), timeMax: new Date(now.getTime() + RANGE_MS).toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "100" });
      if (cursor) qs.set("pageToken", cursor);
      const res = await googleRequest<{ items?: CalendarEvent[]; nextPageToken?: string }>(ctx, { url: `${base(ctx)}/calendars/primary/events?${qs}` });
      return { items: res.data.items ?? [], next: res.data.nextPageToken ?? null };
    },
    { maxPages: MAX_PAGES },
  );
}

async function identify(ctx: AdapterContext): Promise<string | null> {
  const res = await googleRequest<{ id?: string }>(ctx, { url: `${base(ctx)}/calendars/primary`, retries: 1 });
  return res.data.id ?? null;
}

export const gcalAdapter: ConnectorAdapter = {
  kind: "gcal",
  secretNames: GOOGLE_SECRET_NAMES,
  definition: {
    kind: "gcal",
    label: "Google Calendar",
    description: "Meetings in the next 48 hours that need preparation, and invitations waiting for your response.",
    authMethods: [googleAuthMethod()],
    scopes: [{ id: "upcoming", label: "My primary calendar, next 48 hours", default: true }],
    writeActions: [],
    setupHelp: "Jarvis reads your primary calendar with read-only access and never changes events.",
    unavoidableSteps: googleSetupSteps("Google Calendar API"),
  },

  configure: configureGoogle,

  async authorizeUrl(ctx, p) {
    return buildAuthorizeUrl(ctx, { ...p, scopes: p.scopes.length ? p.scopes : [GCAL_READ_SCOPE] });
  },

  async completeAuthorization(ctx, p) {
    return completeGoogleAuthorization(ctx, p, identify);
  },

  async test(ctx) {
    try {
      const res = await googleRequest<{ items?: Array<{ id: string; primary?: boolean }> }>(ctx, { url: `${base(ctx)}/users/me/calendarList?maxResults=1`, retries: 1 });
      const primary = (res.data.items ?? []).find((c) => c.primary)?.id ?? ctx.connection.account ?? null;
      return { ok: true, state: "complete", account: primary, message: primary ? `Signed in as ${primary}` : "Connected to Google Calendar", grantedScopes: grantedScopes(ctx) };
    } catch (e) {
      const err = asRemoteError(e);
      return { ok: false, state: err.state, account: null, message: err.message };
    }
  },

  async sync(ctx): Promise<SyncResult> {
    const cov = new CoverageTracker();
    const observations: Observation[] = [];
    if (!ctx.connection.readScopes.includes("upcoming")) return { coverage: cov.finish(), observations };
    try {
      const r = await listEvents(ctx);
      const events = r.items.filter((e) => e.id && e.status !== "cancelled");
      const nowMs = ctx.now().getTime();
      for (const ev of events) observations.push(toObservation(ev, nowMs));
      cov.add(SCOPE_LABEL, listingState(r, events.length), events.length, r.pages, listingNote(r, MAX_PAGES));
    } catch (e) {
      recordFailure(cov, SCOPE_LABEL, e);
    }
    return { coverage: cov.finish(), observations };
  },
};
