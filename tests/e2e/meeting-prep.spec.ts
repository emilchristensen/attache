/**
 * Meeting prep Heads-ups (#26 of spec #14), driven through the Dashboard against the real bundled service and the
 * TEST-ONLY fixtures. Google Calendar is connected through the fixture claude.ai connector; each journey sets the
 * calendar to meetings at times relative to now (`setCalendar`) and runs a Source refresh, so the service raises the
 * meeting prep items with their start, end and Meet link, and For you now promotes them on the real clock.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { api, JourneyBrowser } from "./browser.ts";
import { buildAll, harnessSave, startStack, type Stack } from "./stack.ts";
import { completeRows, routeSignIn } from "./home-fold.ts";

let stack: Stack;
let journeys: JourneyBrowser;

const MINUTE = 60_000;
const SELF = "alex@example.com";

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  buildAll();
  stack = await startStack();
  journeys = await JourneyBrowser.start(browser, stack.url, { timezoneId: "Europe/Copenhagen" });
  const page = await journeys.newPage();
  await page.goto(stack.pairUrl());
  await expect(page.getByRole("heading", { name: "Where should Attache keep your knowledge?" })).toBeVisible();
  await api(page, "POST", "/setup/data-folder", { path: stack.dataDir });
  await api(page, "POST", "/setup/identity", { name: "Test User", email: SELF, confirm: true });
  await api(page, "POST", "/connections/model/configure", { method: "openai-compatible", fields: { baseUrl: `${stack.fixtureUrl}/model`, model: "fixture-model" } });
  await api(page, "POST", "/connections/github/configure", { method: "token", fields: { token: "ghp_fixturetokenfixturetoken12345678" } });
  await api(page, "POST", "/connections/gcal/configure", { method: "claude-ai", fields: {} });
  // A Harness too, so every feature is ready and Home's Connections area is the one green line of a healthy day.
  await api(page, "POST", "/connections/claude-code/configure", { method: "hooks", fields: {} });
  await api(page, "POST", "/setup/complete");
  // No daily briefing is due while the journeys run, so the quiet line speaks of meeting prep alone.
  await api(page, "PATCH", "/config", { schedules: { refreshEveryMinutes: 30, briefingAt: "08:00", briefingEnabled: false } });
  await api(page, "POST", "/import", { path: stack.vaultDir });
  await api(page, "POST", "/connections/github/refresh");
  await expect.poll(async () => (await api<{ items: unknown[] }>(page, "GET", "/attention?state=open")).items.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
});
test.afterAll(async () => {
  await journeys?.close();
  await stack?.stop();
});

interface Meeting {
  id: string;
  summary: string;
  /** Minutes from now. */
  start: number;
  end: number;
  meetLink?: string;
  attendees?: string[];
}

const at = (minutes: number) => new Date(Date.now() + minutes * MINUTE).toISOString();

/**
 * Put these meetings on the fixture calendar and read it again with a Source refresh, until the open Inbox has a
 * meeting prep item for each one whose end is still ahead.
 */
async function setCalendar(page: Page, meetings: readonly Meeting[]): Promise<Record<string, { start: string; end: string }>> {
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
const clock = (page: Page, iso: string) => page.evaluate((v) => new Date(v).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }), iso);

const area = (page: Page) => page.getByRole("region", { name: "For you now" });
/** The meeting prep Heads-up (lead or line) whose subject is exactly `subject`. */
const meetingHeadsUp = (page: Page, subject: string) =>
  area(page)
    .locator('[data-heads-up="meeting-prep"]')
    .filter({ has: page.locator(".heads-up-title, .heads-up-line-head strong").getByText(subject, { exact: true }) });
const needYou = (page: Page) => page.locator("#inbox [data-need-you]");
const inboxRowFor = (page: Page, subject: string) => page.locator("#inbox [data-inbox-row]", { hasText: subject });
const rowFor = (page: Page, id: string) => page.locator(`#inbox [data-inbox-row][data-item-key="gcal:${id}"]`);

/** Opens a follower's prep in place. */
async function openPrep(headsUp: Locator): Promise<void> {
  const toggle = headsUp.getByRole("button", { name: "Open prep" });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(headsUp.locator("[data-meeting-detail]")).toBeVisible();
}

test("before: a meeting hours away is an Inbox row, and the quiet line says when its Heads-up comes", async () => {
  const page = await journeys.open("/");
  const times = await setCalendar(page, [{ id: "design", summary: "Design review", start: 180, end: 240, meetLink: "https://meet.google.com/des-ign-rev" }]);
  await page.reload();
  await expect(rowFor(page, "design")).toContainText("Design review");
  await expect(rowFor(page, "design")).toHaveAttribute("data-type", "meeting_prep");
  const showsAt = new Date(Date.parse(times.design!.start) - 15 * MINUTE).toISOString();
  const shows = await clock(page, showsAt);
  // Run within three hours of midnight, the Heads-up comes tomorrow, and the line says so.
  const tomorrow = await page.evaluate((v) => new Date(v).toDateString() !== new Date().toDateString(), showsAt);
  await expect(area(page).locator(".for-you-now-quiet-text")).toHaveText(`Nothing timely right now. Prep for Design review shows here ${tomorrow ? "tomorrow " : ""}at ${shows}.`);
});

test("failure: open Inbox items that could not be read say so with Try again, never that nothing is timely", async () => {
  const page = await journeys.newPage();
  for (const p of journeys.context.pages()) if (p !== page) await p.close();
  await page.route("**/api/v1/attention?state=open*", (route) => route.abort());
  await page.goto(stack.url);
  const forYou = area(page);
  await expect(forYou.locator(".for-you-now-quiet-text")).toContainText("Could not check your meetings.");
  await expect(forYou).not.toContainText("Nothing timely");
  await page.unroute("**/api/v1/attention?state=open*");
  await forYou.getByRole("button", { name: "Try again" }).click();
  await expect(forYou.locator(".for-you-now-quiet-text")).toContainText("Nothing timely right now.");
  // A refresh that fails after a good answer says so too, rather than that nothing is timely.
  await page.route("**/api/v1/attention?state=open*", (route) => route.abort());
  await api(page, "POST", "/connections/gcal/refresh");
  await expect(forYou.locator(".for-you-now-quiet-text")).toContainText("Could not check your meetings.");
  await page.unroute("**/api/v1/attention?state=open*");
  await forYou.getByRole("button", { name: "Try again" }).click();
  await expect(forYou.locator(".for-you-now-quiet-text")).toContainText("Nothing timely right now.");
  await page.close();
});

test("upcoming: 15 minutes before the start the meeting leads, leaves the Inbox, and the count stays the same", async () => {
  const page = await journeys.open("/");
  await expect(needYou(page)).toBeVisible();
  const counted = await needYou(page).textContent();
  const times = await setCalendar(page, [{ id: "handover", summary: "Pilot handover", start: 10, end: 40, meetLink: "https://meet.google.com/abc-defg-hij", attendees: ["Nora Lind", "Sam Berg"] }]);
  const lead = meetingHeadsUp(page, "Pilot handover");
  await expect(lead).toBeVisible();
  const [from, to] = [await clock(page, times.handover!.start), await clock(page, times.handover!.end)];
  await expect(lead).toHaveAttribute("data-meeting-phase", "upcoming");
  await expect(lead.locator(".heads-up-eyebrow")).toHaveText(`Meeting prep · On your calendar · Starts ${from}`);
  await expect(lead.getByRole("heading", { level: 3 })).toHaveText("Pilot handover");
  await expect(lead.locator(".heads-up-why")).toHaveText(new RegExp(`^A meeting with other people starts at ${from}\\. It is here from \\d\\d:\\d\\d until it ends at ${to}, or until Done or Not now\\.$`));
  // Before the start, preparing comes first; the real event and call are there too.
  await expect(lead.locator(".heads-up-foot .heads-up-actions > *")).toHaveText(["Open prep", "Open in Google Calendar", "Join", "Done", "Not now"]);
  await expect(lead.getByRole("link", { name: "Open in Google Calendar" })).toHaveAttribute("href", "https://calendar.google.com/event?eid=handover");
  await expect(lead.getByRole("link", { name: "Join" })).toHaveAttribute("href", "https://meet.google.com/abc-defg-hij");
  // Shown above, it is not listed below, and it is still one decision: the count is unchanged.
  await expect(rowFor(page, "handover")).toHaveCount(0);
  await expect(needYou(page)).toHaveText(counted!);
  await expect(page.locator("#inbox .count-line")).toHaveText(/^1 meeting above · \d+ items below need you$/);
  // Open prep: the attendees, and no related notes yet, said in words rather than an empty row.
  await lead.getByRole("button", { name: "Open prep" }).click();
  const detail = lead.locator("[data-meeting-detail]");
  await expect(detail.locator(".meeting-prep-who")).toHaveText(`${from} to ${to} · With Nora Lind, Sam Berg`);
  await expect(detail.locator("[data-meeting-notes]")).toHaveText("No briefing has looked at this meeting yet, so there are no related notes. Prepare a briefing to find some.");
});

test("related notes: the latest briefing's notes for the item, labelled with its time, or that it found none", async () => {
  const page = await journeys.open("/");
  // A person note the briefing can relate to the meeting, saved as a Harness saves (the Dashboard never writes the Brain).
  await harnessSave(stack, [{ action: "create", type: "person", title: "Nora Lind", facts: [{ subject: "Role", value: "Pilot lead at the client; owns the handover" }] }], { agent: "claude-code", session: "meeting-prep" });
  await setCalendar(page, [
    { id: "handover", summary: "Pilot handover", start: 10, end: 40, meetLink: "https://meet.google.com/abc-defg-hij", attendees: ["Nora Lind"] },
    { id: "standup", summary: "Kiosk standup", start: 12, end: 20, attendees: ["Quill Ostrander"] },
  ]);
  const before = (await api<{ briefing: { id: string } | null }>(page, "GET", "/briefings/latest")).briefing?.id ?? null;
  await api(page, "POST", "/briefings", { kind: "manual" });
  let written: { createdAt: string } | null = null;
  await expect.poll(async () => ((written = (await api<{ briefing: { id: string; createdAt: string } | null }>(page, "GET", "/briefings/latest")).briefing), written && (written as { id: string }).id !== before), { timeout: 30_000 }).toBe(true);
  const when = await clock(page, written!.createdAt);
  await page.mouse.move(5, 5);
  const handover = meetingHeadsUp(page, "Pilot handover");
  await openPrep(handover);
  const notes = handover.getByRole("group", { name: `Related notes · As the briefing at ${when} found them` });
  await expect(notes.getByRole("button", { name: "Nora Lind" })).toBeVisible();
  // A related note opens at the lines the briefing matched.
  await notes.getByRole("button", { name: "Nora Lind" }).click();
  await expect(page.getByRole("dialog", { name: /Evidence/ })).toBeVisible();
  await page.keyboard.press("Escape");
  // A meeting the briefing looked at and found nothing for says so. The fixture search relates something to every
  // meeting, so the briefing's answer for this one is routed to the empty list a real search can give.
  const standupId = (await api<{ items: Array<{ id: string; key: string }> }>(page, "GET", "/attention?state=open")).items.find((i) => i.key === "gcal:standup")!.id;
  await page.route("**/api/v1/briefings/latest", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { briefing: { sections: Array<{ id: string; items: Array<{ id: string; related?: unknown[] }> }> } };
    for (const section of body.briefing.sections) section.items = section.items.map((i) => (i.id === standupId ? { ...i, related: [] } : i));
    await route.fulfill({ response: res, json: body });
  });
  await page.reload();
  const standup = meetingHeadsUp(page, "Kiosk standup");
  await openPrep(standup);
  await expect(standup.locator("[data-meeting-notes]")).toHaveText(`No related notes: the briefing at ${when} found none in your Brain.`);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("in progress: overlapping meetings lead with Join, the next one follows as a compact line, then the briefing", async () => {
  const page = await journeys.open("/");
  await page.setViewportSize({ width: 1280, height: 800 });
  const times = await setCalendar(page, [
    { id: "handover", summary: "Pilot handover", start: -10, end: 10, meetLink: "https://meet.google.com/abc-defg-hij" },
    { id: "triage", summary: "Billing triage", start: 10, end: 40, meetLink: "https://meet.google.com/bil-ling-tri" },
  ]);
  const lead = meetingHeadsUp(page, "Pilot handover");
  await expect(lead).toHaveAttribute("data-meeting-phase", "in-progress");
  await expect(page.locator("article.heads-up-lead")).toHaveCount(1);
  await expect(page.locator("article.heads-up-lead .heads-up-title")).toHaveText("Pilot handover");
  await expect(lead.locator(".heads-up-eyebrow")).toHaveText(`Meeting prep · On your calendar · In progress, ends ${await clock(page, times.handover!.end)}`);
  // Join first during the meeting.
  const actions = lead.locator(".heads-up-foot .heads-up-actions > *");
  await expect(actions.first()).toHaveText("Join");
  await expect(actions).toHaveText(["Join", "Open in Google Calendar", "Done", "Not now", "Open prep"]);
  // The next meeting: one line with its subject, "On your calendar", its interval and Open prep, below the one in progress.
  const next = meetingHeadsUp(page, "Billing triage");
  await expect(next).toHaveJSProperty("tagName", "LI");
  await expect(next.locator(".heads-up-line-head")).toHaveText(`Billing triage · On your calendar · ${await clock(page, times.triage!.start)} to ${await clock(page, times.triage!.end)}`);
  await expect(next.locator(".heads-up-actions").getByRole("button")).toHaveText(["Open prep"]);
  // Then the briefing the journey before asked for, as a follower line.
  const briefing = area(page).locator(".heads-up-lines > li").nth(1);
  await expect(briefing).toHaveAttribute("data-heads-up", "requested-briefing");
  // One line under both meetings: its why opens with Read briefing.
  await expect(briefing.locator(".heads-up-why")).toHaveCount(0);
  await briefing.getByRole("button", { name: "Read briefing" }).click();
  await expect(briefing.locator(".briefing-detail .heads-up-why")).toHaveText(/^You asked for it at \d\d:\d\d\. It leaves at \d\d:\d\d, or when you press Got it\.$/);
  await briefing.getByRole("button", { name: "Read briefing" }).click();
  // Its destinations and decisions are inside Open prep.
  await openPrep(next);
  await expect(next.locator("[data-meeting-detail] .heads-up-actions > *")).toHaveText(["Open in Google Calendar", "Join", "Done", "Not now"]);
  // Its why is inside too, so the line stays one line.
  await expect(next.locator("[data-meeting-detail] .heads-up-why")).toHaveText(/^A meeting with other people starts at \d\d:\d\d\. It is here from \d\d:\d\d until it ends at \d\d:\d\d, or until Done or Not now\.$/);
  await expect(next.getByRole("link", { name: "Join" })).toHaveAttribute("href", "https://meet.google.com/bil-ling-tri");
  await next.getByRole("button", { name: "Open prep" }).click();
  // Neither meeting is listed below; each is one decision.
  await expect(rowFor(page, "handover")).toHaveCount(0);
  await expect(rowFor(page, "triage")).toHaveCount(0);
  await expect(page.locator("#inbox .count-line")).toHaveText(/^2 meetings above · \d+ items below need you$/);
  // The fold: with both meetings, the briefing follower and one sign-in problem, the first Inbox row is still whole.
  await routeSignIn(page);
  await page.reload();
  await expect(page.getByRole("status", { name: "Connections" }).locator('.conn-row[data-state="sign_in"]')).toBeVisible();
  await expect(meetingHeadsUp(page, "Billing triage")).toBeVisible();
  expect(await completeRows(page), "complete Inbox rows during overlapping meetings").toBeGreaterThanOrEqual(1);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("Not now hides only the Heads-up: the item is back in the flat Inbox and its type, and the count does not change", async () => {
  const page = await journeys.open("/");
  await expect(meetingHeadsUp(page, "Billing triage")).toBeVisible();
  const counted = await needYou(page).textContent();
  const next = meetingHeadsUp(page, "Billing triage");
  await openPrep(next);
  await next.getByRole("button", { name: "Not now" }).click();
  await expect(next).toHaveCount(0);
  await expect(area(page).getByRole("heading", { name: "For you now" })).toBeFocused();
  await expect(area(page).getByRole("status").last()).toHaveText("Billing triage moved to the Inbox. It stays open there.");
  // Back in the Inbox at once, in its place (not behind Show new items), and still one decision.
  await expect(rowFor(page, "triage")).toContainText("Billing triage");
  await expect(page.locator("#inbox [data-show-new]")).toBeDisabled();
  await expect(needYou(page)).toHaveText(counted!);
  await expect(page.locator("#inbox .count-line")).toHaveText(/^1 meeting above · \d+ items below need you$/);
  // In the Meeting prep type too.
  const type = page.locator("#inbox").getByRole("combobox", { name: "Type" });
  await expect(type.locator("option", { hasText: /^Meeting prep \(1\)$/ })).toHaveCount(1);
  await type.selectOption({ label: "Meeting prep (1)" });
  await expect(page.locator("#inbox [data-inbox-row]")).toHaveCount(1);
  await expect(rowFor(page, "triage")).toBeVisible();
  await type.selectOption({ index: 0 });
  // Remembered in this browser: a reload keeps it in the Inbox and out of For you now.
  await page.reload();
  await expect(rowFor(page, "triage")).toBeVisible();
  await expect(meetingHeadsUp(page, "Billing triage")).toHaveCount(0);
  await expect(meetingHeadsUp(page, "Pilot handover")).toBeVisible();
});

test("Done clears the Heads-up and decides the Inbox item, which no longer counts", async () => {
  const page = await journeys.open("/");
  const lead = meetingHeadsUp(page, "Pilot handover");
  await expect(lead).toBeVisible();
  const count = async () => Number((await needYou(page).textContent())!.match(/\d+/)![0]);
  const before = await count();
  await lead.getByRole("button", { name: "Done" }).click();
  await expect(lead).toHaveCount(0);
  await expect(area(page).getByRole("heading", { name: "For you now" })).toBeFocused();
  await expect(area(page).getByRole("status").last()).toHaveText("Pilot handover marked done, on every Machine.");
  // The Inbox item is decided Done in the service (its record replicates to every Machine), so it is listed nowhere.
  await expect(rowFor(page, "handover")).toHaveCount(0);
  await expect.poll(count).toBe(before - 1);
  const resolved = (await api<{ items: Array<{ key: string; state: string }> }>(page, "GET", "/attention?state=resolved")).items;
  expect(resolved.find((i) => i.key === "gcal:handover")?.state).toBe("resolved");
  // The meeting moves, so its evidence changes and the service opens the item again: its Heads-up comes back, and
  // stays while the pointer is on it (Done here applied to the item as it was, not to this one).
  await page.mouse.move(5, 5);
  await setCalendar(page, [{ id: "handover", summary: "Pilot handover", start: -10, end: 25, meetLink: "https://meet.google.com/abc-defg-hij" }]);
  const back = meetingHeadsUp(page, "Pilot handover");
  await expect(back).toBeVisible();
  await back.hover();
  await back.getByRole("button", { name: "Open prep" }).focus();
  await page.waitForTimeout(500);
  await expect(back).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
});

test("hold: with focus on Join, the next meeting still comes in on time below it, and Join keeps its meeting", async ({ browser }) => {
  // The browser clock is the whole context's, so this journey has a paired context of its own.
  const own = await JourneyBrowser.start(browser, stack.url, { timezoneId: "Europe/Copenhagen", storageState: await journeys.context.storageState() });
  const page = await own.newPage();
  await page.clock.install({ time: new Date() });
  await page.goto(stack.url);
  await page.setViewportSize({ width: 1280, height: 800 });
  await setCalendar(page, [
    { id: "crit", summary: "Design crit", start: -10, end: 20, meetLink: "https://meet.google.com/cri-tic-now" },
    { id: "hiring", summary: "Hiring sync", start: 20, end: 50, meetLink: "https://meet.google.com/hir-ing-syn" },
    { id: "budget", summary: "Budget sync", start: 35, end: 60 },
  ]);
  // Loaded afresh, so the new items are rows, not behind Show new items.
  await page.reload();
  const join = meetingHeadsUp(page, "Design crit").getByRole("link", { name: "Join" });
  await join.focus();
  // Twenty minutes before its start the next meeting is still an Inbox row.
  await expect(rowFor(page, "hiring")).toBeVisible();
  await expect(meetingHeadsUp(page, "Hiring sync")).toHaveCount(0);
  // Six minutes on it is due: it comes in below the meeting the focus is on, on time, and leaves the Inbox.
  await page.clock.fastForward("06:00");
  const next = meetingHeadsUp(page, "Hiring sync");
  await expect(next).toBeVisible();
  await expect(next).toHaveJSProperty("tagName", "LI");
  await expect(rowFor(page, "hiring")).toHaveCount(0);
  // The focused Join is the same element, still the current meeting's call.
  await expect(join).toBeFocused();
  await expect(join).toHaveAttribute("href", "https://meet.google.com/cri-tic-now");
  // It stays where it came in for the rest of the hold: the pointer moves onto it and the focus leaves.
  const lines = area(page).locator(".heads-up-lines").first().locator(":scope > li");
  await expect(lines.first()).toHaveAttribute("data-heads-up", "meeting-prep");
  await next.hover();
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await expect(lines.first()).toHaveAttribute("data-heads-up", "meeting-prep");
  await expect(lines.first()).toContainText("Hiring sync");
  // Still held (the pointer stays in the Heads-ups), Not now on the arrived meeting takes it out at once, back to the Inbox.
  await openPrep(next);
  await next.getByRole("button", { name: "Not now" }).click();
  await expect(next).toHaveCount(0);
  await expect(rowFor(page, "hiring")).toBeVisible();
  // The next one comes due, still held, and Done takes it out at once.
  await page.clock.fastForward("15:00");
  const budget = meetingHeadsUp(page, "Budget sync");
  await expect(budget).toBeVisible();
  await openPrep(budget);
  await budget.getByRole("button", { name: "Done" }).click();
  await expect(budget).toHaveCount(0);
  await expect(rowFor(page, "budget")).toHaveCount(0);
  expect(own.consoleErrors).toEqual([]);
  await own.close();
});

test("no call: without a Meet link the meeting in progress leads with Open in Google Calendar", async () => {
  const page = await journeys.open("/");
  await setCalendar(page, [{ id: "walk", summary: "Site walk", start: -5, end: 25 }]);
  const lead = meetingHeadsUp(page, "Site walk");
  await expect(lead.locator(".heads-up-foot .heads-up-actions > *")).toHaveText(["Open in Google Calendar", "Done", "Not now", "Open prep"]);
  await expect(lead.getByRole("link", { name: "Join" })).toHaveCount(0);
});

test("insertion: a meeting Heads-up arriving above keeps the reader's place in the Inbox, with and without the browser's scroll anchoring", async () => {
  for (const safari of [false, true]) {
    const page = await journeys.newPage();
    for (const p of journeys.context.pages()) if (p !== page) await p.close();
    if (safari) {
      // As in Safari: no scroll anchoring, so the Dashboard keeps the place itself.
      await page.addInitScript(() => {
        const supports = CSS.supports.bind(CSS);
        CSS.supports = ((a: string, b?: string) => (/overflow-anchor/.test(a) ? false : b === undefined ? supports(a) : supports(a, b))) as typeof CSS.supports;
      });
    }
    await page.goto(stack.url);
    await setCalendar(page, [{ id: `later-${safari}`, summary: "Quarterly planning", start: 180, end: 240 }]);
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.reload();
    if (safari) await page.addStyleTag({ content: ".page, .page * { overflow-anchor: none !important; }" });
    const row = inboxRowFor(page, "Send the cutover plan to finance");
    await expect(row).toBeVisible();
    await expect(area(page)).toHaveAttribute("data-for-you-now", /quiet|timely/);
    // The owner reads the Inbox: scrolled so this row is near the top, then so the Inbox heading is a little below the
    // top, with the Connections line above it in view and For you now out of sight.
    const scrollTo = (selector: string, below: number) =>
      page.evaluate(
        ([sel, gap]) => {
          const el = sel === "row" ? [...document.querySelectorAll<HTMLElement>("#inbox [data-inbox-row]")].find((r) => r.textContent!.includes("Send the cutover plan to finance"))! : document.querySelector<HTMLElement>(sel as string)!;
          const scroller = document.querySelector<HTMLElement>(".page")!;
          scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - (gap as number);
        },
        [selector, below] as const,
      );
    for (const [step, [place, below]] of ([["row", 40], ["#inbox", 60]] as const).entries()) {
      await scrollTo(place, below);
      const before = (await row.boundingBox())!.y;
      // A meeting comes within 15 minutes of its start: its Heads-up arrives above.
      const subject = `${safari ? "Vendor" : "Partner"} sync ${step + 1}`;
      await setCalendar(page, [
        { id: `later-${safari}`, summary: "Quarterly planning", start: 180, end: 240 },
        ...Array.from({ length: step + 1 }, (_, n) => ({ id: `soon-${safari}-${n}`, summary: `${safari ? "Vendor" : "Partner"} sync ${n + 1}`, start: 10 + n, end: 40 })),
      ]);
      await expect(meetingHeadsUp(page, subject)).toHaveCount(1);
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      expect(Math.abs((await row.boundingBox())!.y - before), `${safari ? "without" : "with"} scroll anchoring, reading at ${place}`).toBeLessThanOrEqual(1);
    }
    // The first row in view is a meeting that comes due: it moves up into For you now, and the row after it stays put.
    // Room below the Inbox, so the page can scroll that row to the top edge.
    await page.addStyleTag({ content: "#inbox { padding-bottom: 1200px; }" });
    await scrollTo(`#inbox [data-item-key="gcal:later-${safari}"]`, -2);
    const after = page.locator(`#inbox [data-item-key="gcal:later-${safari}"] + [data-inbox-row]`);
    const afterKey = await after.getAttribute("data-item-key");
    const kept = page.locator(`#inbox [data-item-key="${afterKey}"]`);
    const was = (await kept.boundingBox())!.y;
    await setCalendar(page, [
      { id: `later-${safari}`, summary: "Quarterly planning", start: 12, end: 40 },
      ...[0, 1].map((n) => ({ id: `soon-${safari}-${n}`, summary: `${safari ? "Vendor" : "Partner"} sync ${n + 1}`, start: 10 + n, end: 40 })),
    ]);
    await expect(meetingHeadsUp(page, "Quarterly planning")).toHaveCount(1);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    expect(Math.abs((await kept.boundingBox())!.y - was), `${safari ? "without" : "with"} scroll anchoring, the row after the promoted one`).toBeLessThanOrEqual(1);
    // With the Heads-up in view above the Inbox rows, opening its prep moves nothing above it: the clicked control stays put.
    const prep = meetingHeadsUp(page, `${safari ? "Vendor" : "Partner"} sync 1`).getByRole("button", { name: "Open prep" });
    await prep.evaluate((el) => {
      const scroller = el.closest<HTMLElement>(".page")!;
      scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 40;
    });
    const at = (await prep.boundingBox())!.y;
    await prep.click();
    await expect(prep).toHaveAttribute("aria-expanded", "true");
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    expect(Math.abs((await prep.boundingBox())!.y - at), `Open prep ${safari ? "without" : "with"} scroll anchoring`).toBeLessThanOrEqual(1);
    await page.close();
  }
});

test("narrow: meeting prep fits a phone with no sideways scrolling and no clipped words", async () => {
  const page = await journeys.open("/");
  await setCalendar(page, [
    { id: "handover2", summary: "Steering group handover with the client", start: -10, end: 10, meetLink: "https://meet.google.com/abc-defg-hij" },
    { id: "triage2", summary: "Billing triage for the invoice fallback", start: 10, end: 40, meetLink: "https://meet.google.com/bil-ling-tri" },
  ]);
  await expect(meetingHeadsUp(page, "Billing triage for the invoice fallback")).toBeVisible();
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    await openPrep(meetingHeadsUp(page, "Billing triage for the invoice fallback"));
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${width} px overflow`).toBeLessThanOrEqual(0);
    const clipped = await area(page).evaluate((el) => [...el.querySelectorAll("h3, p, button, a")].filter((n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent));
    expect(clipped, `${width} px clipped text`).toEqual([]);
  }
});

test("captures: overlapping meetings and an open prep, light, dark and narrow", async () => {
  const page = await journeys.open("/");
  await expect(meetingHeadsUp(page, "Billing triage for the invoice fallback")).toBeVisible();
  await page.mouse.move(5, 5);
  const shoot = async (name: string) => {
    for (const scheme of ["light", "dark"] as const) {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `test-results/screens/${scheme}-home-meetings${name}.png` });
    }
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `test-results/screens/narrow-home-meetings${name}.png` });
  };
  await shoot("");
  await page.setViewportSize({ width: 1280, height: 800 });
  await meetingHeadsUp(page, "Steering group handover with the client").getByRole("button", { name: "Open prep" }).click();
  await openPrep(meetingHeadsUp(page, "Billing triage for the invoice fallback"));
  await page.mouse.move(5, 5);
  await shoot("-prep-open");
  await page.emulateMedia({ colorScheme: null });
});

test("no console errors during the meeting prep journeys", () => {
  expect(journeys.consoleErrors).toEqual([]);
});
