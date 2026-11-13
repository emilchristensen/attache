/**
 * Google Calendar through the user's claude.ai Google Calendar connector
 * (see claude-adapter.ts). list_events returns recurring events expanded
 * into instances, in the same shape as the Calendar REST API. Read-only.
 */
import type { ConnectorAdapter, AdapterContext, AttentionCandidate, Observation, RefreshResult } from "./types.ts";
import { CoverageTracker } from "./types.ts";
import { RemoteError } from "./http.ts";
import { daysBetween, listingState, recordFailure } from "./common.ts";
import { CLAUDE_SERVERS, claudeAuthMethods, claudeDataNote, claudeSetupSteps, configureClaude, paginateStreams, serverName, streamOrThrow, testClaude, toolError } from "./claude-adapter.ts";
import { str } from "./atlassian-shapes.ts";
import { plural } from "@jarvis/contracts";

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
  conferenceUrl?: string;
  start?: EventTime;
  end?: EventTime;
  attendees?: Attendee[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
}

const HOUR = 3_600_000;
const RANGE_MS = 48 * HOUR;
const PREP_MS = 24 * HOUR;
const MAX_PAGES = 3;
const MAX_NAMES = 6;
const SCOPE_LABEL = "Upcoming events (48 hours)";
const WALL_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?/;

const server = (ctx: AdapterContext) => serverName(ctx, CLAUDE_SERVERS.gcal);

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
    data: { start, end, allDay, selfResponseStatus: response, attendeeCount: count, attendees: people(ev).map((a) => a.displayName || a.email || ""), location: ev.location ?? null, meetLink: ev.conferenceUrl ?? ev.hangoutLink ?? null },
    fingerprintParts: [start, end, response, count],
    ...(attention ? { attention } : {}),
  };
}

/** Parse one list_events page. */
export function parseEventPage(text: string): { items: CalendarEvent[]; next: string | null; unreadable: number; calendar: string | null } {
  let res: { events?: unknown; items?: unknown; nextPageToken?: unknown; summary?: unknown };
  try {
    res = JSON.parse(text) as typeof res;
  } catch {
    throw new RemoteError("Google Calendar returned an unreadable result", "error");
  }
  if (!res || typeof res !== "object") throw new RemoteError("Google Calendar returned an unreadable result", "error");
  const err = (res as { error?: unknown }).error;
  if (err !== undefined) throw toolError("Google Calendar", "list_events", typeof err === "string" ? err : JSON.stringify(err));
  const events = res.events ?? res.items ?? [];
  if (!Array.isArray(events)) throw new RemoteError("Google Calendar returned an unexpected result shape", "error");
  const items = events.filter((e): e is CalendarEvent => !!e && typeof e === "object" && typeof (e as CalendarEvent).id === "string");
  return { items, next: str(res.nextPageToken), unreadable: events.length - items.length, calendar: str(res.summary) };
}

/** The window is fixed once per listing: a page token only belongs to the query that produced it. */
function eventsCall(now: Date, cursor: string | null, pageSize = 100) {
  return { tool: "list_events", args: { startTime: now.toISOString(), endTime: new Date(now.getTime() + RANGE_MS).toISOString(), orderBy: "startTime", pageSize, ...(cursor ? { pageToken: cursor } : {}) } };
}

export const gcalAdapter: ConnectorAdapter = {
  kind: "gcal",
  secretNames: [],
  definition: {
    kind: "gcal",
    label: "Google Calendar",
    description: "Meetings in the next 48 hours that need preparation, and invitations waiting for your response.",
    authMethods: claudeAuthMethods(CLAUDE_SERVERS.gcal),
    scopes: [{ id: "upcoming", label: "My primary calendar, next 48 hours", default: true }],
    writeActions: [],
    setupHelp: `${claudeDataNote(CLAUDE_SERVERS.gcal)} Jarvis only reads your primary calendar and never changes events.`,
    unavoidableSteps: claudeSetupSteps(CLAUDE_SERVERS.gcal),
  },

  configure: async (_ctx, fields) => configureClaude(fields, CLAUDE_SERVERS.gcal),

  async test(ctx) {
    return testClaude(ctx, server(ctx), eventsCall(ctx.now(), null, 1), (text) => ({ account: parseEventPage(text).calendar }));
  },

  async refresh(ctx): Promise<RefreshResult> {
    const cov = new CoverageTracker();
    const observations: Observation[] = [];
    if (!ctx.connection.readScopes.includes("upcoming")) return { coverage: cov.finish(), observations };
    try {
      const now = ctx.now();
      const results = await paginateStreams<CalendarEvent>(ctx, server(ctx), [{ id: "upcoming", label: SCOPE_LABEL, maxPages: MAX_PAGES, call: (cursor) => eventsCall(now, cursor), parse: parseEventPage }]);
      const r = streamOrThrow(results.get("upcoming"));
      const events = r.items.filter((e) => e.status !== "cancelled");
      const nowMs = now.getTime();
      for (const ev of events) observations.push(toObservation(ev, nowMs));
      const notes = [...(r.error ? [r.error.message] : !r.complete ? [`Stopped after ${MAX_PAGES} pages`] : []), ...(r.unreadable ? [`${plural(r.unreadable, "event")} could not be read`] : [])];
      cov.add(SCOPE_LABEL, r.unreadable ? "partial" : listingState({ items: events, complete: r.complete }), events.length, r.pages, notes.length ? notes.join("; ") : undefined);
    } catch (e) {
      recordFailure(cov, SCOPE_LABEL, e);
    }
    return { coverage: cov.finish(), observations };
  },
};
