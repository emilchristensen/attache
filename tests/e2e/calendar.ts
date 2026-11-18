/**
 * The fixture Google Calendar for meeting prep journeys: put meetings on it at times relative to now and read it
 * again, so the service raises their meeting prep items with start, end and Meet link.
 */
import { expect, type Page } from "@playwright/test";
import { api } from "./browser.ts";
import type { Stack } from "./stack.ts";

export const MINUTE = 60_000;
/** The owner's own address on the fixture calendar: not an attendee of their own meetings. */
export const SELF = "alex@example.com";

export interface Meeting {
  id: string;
  summary: string;
  /** Minutes from now. */
  start: number;
  end: number;
  meetLink?: string;
  attendees?: string[];
}

export const at = (minutes: number) => new Date(Date.now() + minutes * MINUTE).toISOString();

/**
 * Put these meetings on the fixture calendar and read it again with a Source refresh, until the open Inbox has a
 * meeting prep item for each one whose end is still ahead.
 */
export async function setCalendar(stack: Stack, page: Page, meetings: readonly Meeting[]): Promise<Record<string, { start: string; end: string }>> {
  const events = meetings.map((m) => ({
    id: m.id,
    summary: m.summary,
    start: { dateTime: at(m.start) },
    end: { dateTime: at(m.end) },
    ...(m.meetLink ? { conferenceUrl: m.meetLink } : {}),
    attendees: [{ email: SELF, self: true, responseStatus: "accepted" }, ...(m.attendees ?? ["Nora Lind"]).map((name) => ({ email: `${name.split(" ")[0]!.toLowerCase()}@client.example`, displayName: name, responseStatus: "accepted" }))],
  }));
  const set = await page.request.post(`${stack.fixtureUrl}/__control/gcal-events`, { data: { events } });
  expect(set.ok()).toBe(true);
  await api(page, "POST", "/connections/gcal/refresh");
  const wanted = Object.fromEntries(events.map((e) => [`gcal:${e.id}`, new Date(e.start.dateTime).toISOString()]));
  let items: Array<{ key: string; meeting: { start: string; end: string } | null }> = [];
  await expect
    .poll(
      async () => {
        items = (await api<{ items: typeof items }>(page, "GET", "/attention?state=open")).items.filter((i) => i.key.startsWith("gcal:"));
        return items.filter((i) => i.meeting && wanted[i.key] === i.meeting.start).map((i) => i.key).sort();
      },
      { timeout: 30_000 },
    )
    .toEqual(Object.keys(wanted).sort());
  return Object.fromEntries(items.map((i) => [i.key.slice("gcal:".length), i.meeting!]));
}
