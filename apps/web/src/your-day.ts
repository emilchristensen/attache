/**
 * Your day (pure, table tests in `apps/web/test/your-day.test.ts`): today's meetings from the agenda route, in the
 * browser's current zone, against the clock: which show, in what order, which is in progress or ended, when Join
 * shows, and which state the area is in.
 */
import type { AgendaEvent, AgendaResponse, Coverage } from "@attache/contracts";
import { MEETING_LEAD_MS } from "./heads-up-rules.ts";
import { instantOf, startOfDay } from "./zoned-time.ts";

/** Timed meetings shown side by side in the band; the rest are "N more" (a narrow list shows them all). */
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
  /** Shown in the wide band: every all-day event, and the first `YOUR_DAY_VISIBLE` timed ones. */
  visible: boolean;
}

export interface YourDayView {
  state: "checking" | "events" | "empty" | "nothing-more" | "error" | "unconnected" | "off";
  events: DayEvent[];
  tomorrow: DayEvent | null;
  more: number;
}

const HEALTHY: ReadonlySet<string> = new Set(["complete", "empty"]);

/** The range Your day asks the agenda route for: from midnight today to midnight after tomorrow, in `timeZone`. */
export function yourDayRange(now: number, timeZone: string): { from: string; to: string } {
  return { from: new Date(startOfDay(now, timeZone)).toISOString(), to: new Date(startOfDay(now, timeZone, 2)).toISOString() };
}

/** An all-day event's date ("2026-11-20") is that day wherever the browser is; a timed event is its instant. */
function instant(value: string, allDay: boolean, timeZone: string): number {
  if (!allDay) return Date.parse(value);
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return instantOf({ year, month, day, hour: 0, minute: 0 }, timeZone);
}

type Timed = AgendaEvent & { startMs: number; endMs: number };

function decorate(event: Timed, now: number, visible: boolean): DayEvent {
  const { startMs, endMs, ...rest } = event;
  const phase = endMs <= now ? "ended" : startMs <= now ? "in-progress" : "upcoming";
  const joinable = !event.allDay && !!event.meetLink && now >= startMs - MEETING_LEAD_MS && now < endMs;
  return { ...rest, phase, joinable, visible };
}

function stateOf(input: YourDayInput, today: readonly DayEvent[], tomorrow: Timed | undefined): YourDayView["state"] {
  if (input.coverage && !HEALTHY.has(input.coverage.state)) return "error";
  if (today.length && today.some((e) => e.phase !== "ended")) return "events";
  if (today.length || tomorrow) return "nothing-more";
  // "Nothing on your calendar today" only after a complete read; before one, still checking.
  return input.coverage ? "empty" : "checking";
}

export function yourDay(input: YourDayInput): YourDayView {
  if (input.enabled === false) return { state: "off", events: [], tomorrow: null, more: 0 };
  if (!input.connection || input.connection.status === "not_configured" || input.connection.status === "disconnected") return { state: "unconnected", events: [], tomorrow: null, more: 0 };
  const [today, tomorrowStart, afterTomorrow] = [0, 1, 2].map((d) => startOfDay(input.now, input.timeZone, d)) as [number, number, number];
  const all = input.events
    .filter((event) => event.response !== "declined")
    .map((event) => ({ ...event, startMs: instant(event.start, event.allDay, input.timeZone), endMs: instant(event.end, event.allDay, input.timeZone) }))
    .toSorted((a, b) => Number(b.allDay) - Number(a.allDay) || a.startMs - b.startMs || a.id.localeCompare(b.id));
  const todays = all.filter((event) => event.startMs < tomorrowStart && event.endMs > today);
  const timed = todays.filter((event) => !event.allDay);
  const events = todays.map((event) => decorate(event, input.now, event.allDay || timed.indexOf(event) < YOUR_DAY_VISIBLE));
  const tomorrow = all.find((event) => !event.allDay && event.startMs >= tomorrowStart && event.startMs < afterTomorrow);
  return { state: stateOf(input, events, tomorrow), events, tomorrow: tomorrow ? decorate(tomorrow, input.now, false) : null, more: Math.max(0, timed.length - YOUR_DAY_VISIBLE) };
}
