/**
 * Meeting prep in the journeys: the fixture Google Calendar, and where the Dashboard shows its meetings. Each journey
 * sets the calendar (`setCalendar`) and runs a Source refresh, so the service raises the meeting prep items with their
 * start, end and Meet link.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { api } from "./browser.ts";
import type { Stack } from "./stack.ts";

export const MINUTE = 60_000;
/** The owner, as the journeys' setup names them. */
export const SELF = "alex@example.com";

export interface Meeting {
  id: string;
  summary: string;
  /** Minutes from `from` (now, unless given). */
  start: number;
  end: number;
  meetLink?: string;
  attendees?: string[];
}

/**
 * Put these meetings on the fixture calendar and read it again with a Source refresh, until the open Inbox has a
 * meeting prep item for each one whose end is still ahead. Times are minutes from `from`, now by default.
 */
export async function setCalendar(page: Page, stack: Stack, meetings: readonly Meeting[], from = Date.now()): Promise<Record<string, { start: string; end: string }>> {
  const at = (minutes: number) => new Date(from + minutes * MINUTE).toISOString();
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

/** "14:05": an instant's clock time in the browser's zone, as the Dashboard shows it. */
export const clock = (page: Page, iso: string) => page.evaluate((v) => new Date(v).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }), iso);

export const area = (page: Page) => page.getByRole("region", { name: "For you now" });
/** The curated meeting-prep row whose subject is exactly `subject`. */
export const meetingHeadsUp = (page: Page, subject: string) =>
  area(page).locator('[data-inbox-row][data-type="meeting_prep"]', { has: page.locator(".inbox-subject").getByText(subject, { exact: true }) });
/** The Inbox heading's count: "4 need you here", or "At least 4 need you here". */
export const needYou = (page: Page) => page.locator("#inbox [data-need-you]");
export const inboxRowFor = (page: Page, subject: string) => page.locator("#inbox [data-inbox-row]", { hasText: subject });
/** The Inbox row of the fixture event `id`. */
export const rowFor = (page: Page, id: string) => page.locator(`#inbox [data-inbox-row][data-item-key="gcal:${id}"]`);

/** Opens a curated row's meeting prep in place. */
export async function openPrep(headsUp: Locator): Promise<void> {
  const toggle = headsUp.locator("[data-row-toggle]");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(headsUp.locator(".inbox-detail")).toBeVisible();
}
