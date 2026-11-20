import type { AgendaEvent, AgendaResponse, Coverage } from "@attache/contracts";
import { MEETING_LEAD_MS } from "./heads-up-rules.ts";
import { instantOf, startOfDay } from "./zoned-time.ts";

export const YOUR_DAY_VISIBLE = 4;

export interface YourDayInput {
  now: number;
  timeZone: string;
  events: readonly AgendaEvent[];
  connection: AgendaResponse["connection"];
  readAt: string | null;
  coverage: Coverage | null;
  enabled?: boolean;
}

export interface DayEvent extends AgendaEvent {
  phase: "upcoming" | "in-progress" | "ended";
  joinable: boolean;
  visible: boolean;
}

export interface YourDayView {
  state: "checking" | "events" | "empty" | "nothing-more" | "error" | "unconnected" | "off";
  events: DayEvent[];
  tomorrow: DayEvent | null;
  more: number;
}

export function yourDayRange(now: number, timeZone: string): { from: string; to: string } {
  return { from: new Date(startOfDay(now, timeZone)).toISOString(), to: new Date(startOfDay(now, timeZone, 2)).toISOString() };
}

export function yourDay(input: YourDayInput): YourDayView {
  if (input.enabled === false) return { state: "off", events: [], tomorrow: null, more: 0 };
  if (!input.connection || input.connection.status === "not_configured" || input.connection.status === "disconnected") return { state: "unconnected", events: [], tomorrow: null, more: 0 };
  const today = startOfDay(input.now, input.timeZone);
  const tomorrowStart = startOfDay(input.now, input.timeZone, 1);
  const afterTomorrow = startOfDay(input.now, input.timeZone, 2);
  const all = input.events
    .filter((event) => event.response !== "declined")
    .map((event) => ({ ...event, startMs: eventStart(event, input.timeZone), endMs: eventEnd(event, input.timeZone) }))
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startMs - b.startMs || a.id.localeCompare(b.id));
  const decorate = (event: (typeof all)[number], visible: boolean): DayEvent => {
    const phase = event.endMs <= input.now ? "ended" : event.startMs <= input.now ? "in-progress" : "upcoming";
    return { id: event.id, start: event.start, end: event.end, allDay: event.allDay, title: event.title, response: event.response, calendarUrl: event.calendarUrl, meetLink: event.meetLink, phase, joinable: !event.allDay && !!event.meetLink && input.now >= event.startMs - MEETING_LEAD_MS && input.now < event.endMs, visible };
  };
  const todayEvents = all.filter((event) => event.startMs < tomorrowStart && event.endMs > today);
  let timed = 0;
  const visibleEvents = todayEvents.map((event) => decorate(event, event.allDay || timed++ < YOUR_DAY_VISIBLE));
  const tomorrow = all.find((event) => event.startMs >= tomorrowStart && event.startMs < afterTomorrow);
  const failed = !!input.coverage && !["complete", "empty"].includes(input.coverage.state);
  const ended = visibleEvents.length > 0 && visibleEvents.every((event) => event.phase === "ended");
  let state: YourDayView["state"] = visibleEvents.length && !ended ? "events" : "checking";
  if (failed) state = "error";
  else if (ended) state = "nothing-more";
  else if (visibleEvents.length === 0) {
    if (tomorrow) state = "nothing-more";
    else if (input.coverage?.state === "complete" || input.coverage?.state === "empty") state = "empty";
    else state = "checking";
  }
  return { state, events: visibleEvents, tomorrow: tomorrow ? decorate(tomorrow, false) : null, more: Math.max(0, timed - YOUR_DAY_VISIBLE) };
}

function eventStart(event: AgendaEvent, timeZone: string): number {
  return event.allDay ? localDate(event.start, timeZone) : Date.parse(event.start);
}

function eventEnd(event: AgendaEvent, timeZone: string): number {
  return event.allDay ? localDate(event.end, timeZone) : Date.parse(event.end);
}

function localDate(value: string, timeZone: string): number {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return instantOf({ year, month, day, hour: 0, minute: 0 }, timeZone);
}
