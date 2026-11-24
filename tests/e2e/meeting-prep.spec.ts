/**
 * Meeting prep in For you now and the Inbox (spec #82), driven through the Dashboard against the real bundled service
 * and the TEST-ONLY fixtures. Google Calendar is connected through the fixture claude.ai connector; each journey sets
 * the calendar to meetings at times relative to now (`setCalendar`) and runs a Source refresh, so the service raises
 * the meeting prep items with their start, end and Meet link, and For you now lists them on the real clock.
 */
import { test, expect, type Page } from "@playwright/test";
import { api, JourneyBrowser } from "./browser.ts";
import { buildAll, harnessSave, startStack, type Stack } from "./stack.ts";
import { completeRows, routeSignIn } from "./home-fold.ts";
import { openRow, rowAction } from "./inbox.ts";
import { area, clock, inboxRowFor, meetingHeadsUp, needYou, openPrep, rowFor, SELF, setCalendar as setFixtureCalendar, type Meeting } from "./meetings.ts";

let stack: Stack;
let journeys: JourneyBrowser;

test.describe.configure({ mode: "serial" });

const setCalendar = (page: Page, meetings: readonly Meeting[]) => setFixtureCalendar(page, stack, meetings);
const isOpenList = (url: URL) => url.pathname === "/api/v1/attention" && url.searchParams.get("state") === "open";

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
  // A Harness too, so every feature is ready and no Connection banner shows on a healthy day.
  await api(page, "POST", "/connections/claude-code/configure", { method: "hooks", fields: {} });
  await api(page, "POST", "/setup/complete");
  // No daily briefing is due while the journeys run, so only a briefing a journey asks for can name related notes.
  await api(page, "PATCH", "/config", { schedules: { refreshEveryMinutes: 30, briefingAt: "08:00", briefingEnabled: false } });
  await api(page, "POST", "/import", { path: stack.vaultDir });
  await api(page, "POST", "/connections/github/refresh");
  await expect.poll(async () => (await api<{ items: unknown[] }>(page, "GET", "/attention?state=open")).items.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
});
test.afterAll(async () => {
  await journeys?.close();
  await stack?.stop();
});

test("before: a meeting hours away is an Inbox row, and an otherwise quiet For you now says when its prep comes", async () => {
  const page = await journeys.open("/");
  const times = await setCalendar(page, [{ id: "design", summary: "Design review", start: 180, end: 240, meetLink: "https://meet.google.com/des-ign-rev" }]);
  // Only the meeting is open, so nothing else is timely and the quiet line speaks of meeting prep alone.
  await page.route(isOpenList, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { items: Array<{ kind: string }> };
    await route.fulfill({ response: res, json: { ...body, items: body.items.filter((i) => i.kind === "meeting_prep") } });
  });
  await page.reload();
  await expect(rowFor(page, "design")).toContainText("Design review");
  await expect(rowFor(page, "design")).toHaveAttribute("data-type", "meeting_prep");
  await expect(meetingHeadsUp(page, "Design review")).toHaveCount(0);
  const starts = await clock(page, times.design!.start);
  // Three hours ahead can be past midnight, where the line names tomorrow, as the browser's own day says.
  const tomorrow = await page.evaluate((v) => new Date(v).toDateString() !== new Date().toDateString(), times.design!.start);
  await expect(area(page).locator(".for-you-now-quiet-text")).toHaveText(`Nothing right now. Next: prep for Design review ${tomorrow ? "tomorrow " : ""}at ${starts}`);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("failure: an Inbox that could not be read says so with Retry, never that nothing is timely", async () => {
  const page = await journeys.newPage();
  for (const p of journeys.context.pages()) if (p !== page) await p.close();
  await page.route(isOpenList, (route) => route.abort());
  await page.goto(stack.url);
  const forYou = area(page);
  await expect(forYou).toContainText("Could not read the Inbox.");
  await expect(forYou).not.toContainText("Nothing right now");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await forYou.getByRole("button", { name: "Retry" }).click();
  await expect(forYou).not.toContainText("Could not read the Inbox.");
  await page.close();
});

test("upcoming: 15 minutes before the start its prep is in For you now and stays in the Inbox; Open prep takes it off, and In progress survives a reload", async () => {
  const page = await journeys.open("/");
  await expect(needYou(page)).toBeVisible();
  const counted = await needYou(page).textContent();
  const times = await setCalendar(page, [{ id: "handover", summary: "Pilot handover", start: 10, end: 40, meetLink: "https://meet.google.com/abc-defg-hij", attendees: ["Nora Lind", "Sam Berg"] }]);
  // Loaded afresh, so the new item is an Inbox row rather than waiting behind Show new items.
  await page.reload();
  const entry = meetingHeadsUp(page, "Pilot handover");
  await expect(entry.locator(".inbox-source")).toContainText(/Starts in (9|10|11) min, prep not read/);
  // The Inbox lists it too, marked as suggested, and it is still one decision: the count is unchanged and the count
  // line has no meetings above.
  await expect(rowFor(page, "handover")).toContainText("Suggested now");
  await expect(needYou(page)).toHaveText(counted!);
  await expect(page.locator("#inbox .count-line", { hasText: "above" })).toHaveCount(0);
  // Open prep: the interval, the attendees, and no related notes yet, said in words rather than an empty row.
  const [from, to] = [await clock(page, times.handover!.start), await clock(page, times.handover!.end)];
  await (await rowAction(entry, "Start working")).click();
  const detail = entry.locator("[data-meeting-detail]");
  await expect(detail.locator(".meeting-prep-who")).toHaveText(`${from} to ${to} · With Nora Lind, Sam Berg`);
  await expect(detail.locator("[data-meeting-notes]")).toHaveText("No briefing has looked at this meeting yet, so there are no related notes. Prepare a briefing to find some.");
  // Once the pointer and focus leave, it is off the list; its row is in progress, here and after a reload.
  await page.mouse.move(5, 5);
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await expect(entry).toHaveCount(0);
  await expect(rowFor(page, "handover")).toContainText("In progress");
  await expect(rowFor(page, "handover")).not.toContainText("Suggested now");
  await page.reload();
  await expect(rowFor(page, "handover")).toContainText("In progress");
  await expect(meetingHeadsUp(page, "Pilot handover")).toHaveCount(0);
  await expect(needYou(page)).toHaveText(counted!);
  // Not started takes the tag back, and the prep is due again.
  await openRow(rowFor(page, "handover"));
  await rowFor(page, "handover").getByRole("button", { name: "Not started: Pilot handover" }).click();
  await expect(rowFor(page, "handover")).not.toContainText("In progress");
  await expect(meetingHeadsUp(page, "Pilot handover")).toBeVisible();
});

test("read by opening: opening unread prep from its Inbox row takes it off For you now on another page too, and marks it In progress", async () => {
  const page = await journeys.open("/");
  await setCalendar(page, [{ id: "retro", summary: "Sprint retro", start: 8, end: 38 }]);
  await page.reload();
  // A second page stands in for another Machine's Dashboard: it hears the decision as a live event.
  const other = await journeys.newPage();
  await other.goto(stack.url);
  await expect(meetingHeadsUp(other, "Sprint retro")).toBeVisible();
  await expect(meetingHeadsUp(page, "Sprint retro")).toBeVisible();
  // The row's subject, not Start working: reading the prep is what counts.
  await openRow(rowFor(page, "retro"));
  await expect(rowFor(page, "retro").locator("[data-meeting-detail]")).toBeVisible();
  await expect(meetingHeadsUp(other, "Sprint retro")).toHaveCount(0);
  await expect(rowFor(other, "retro").locator(".inbox-source")).toContainText("In progress");
  await expect(rowFor(page, "retro").locator(".inbox-source")).toContainText("In progress");
  await other.close();
});

test("read by opening, after a failure: prep opened while its start could not be recorded is recorded on the next try", async () => {
  const page = await journeys.open("/");
  await setCalendar(page, [{ id: "vendor", summary: "Vendor check-in", start: 9, end: 39 }]);
  await page.reload();
  const startedAt = async () => (await api<{ items: Array<{ key: string; startedAt: string | null }> }>(page, "GET", "/attention?state=open")).items.find((i) => i.key === "gcal:vendor")?.startedAt ?? null;
  // The decisions the Dashboard sends fail for a while, as when the service is briefly away.
  let away = true;
  let failures = 0;
  await page.route("**/api/v1/attention/*/decision", (route) => {
    if (!away) return route.fallback();
    failures++;
    return route.fulfill({ status: 503, json: { error: "unavailable" } });
  });
  await openRow(rowFor(page, "vendor"));
  await expect(rowFor(page, "vendor").locator("[data-meeting-detail]")).toBeVisible();
  await expect.poll(() => failures).toBeGreaterThan(0);
  expect(await startedAt()).toBeNull();
  away = false;
  // The owner keeps reading; the next time the list is read again (here after another item changed elsewhere), the
  // open prep is recorded as read.
  const elsewhere = (await api<{ items: Array<{ id: string; key: string; startedAt: string | null }> }>(page, "GET", "/attention?state=open")).items.find((i) => !i.key.startsWith("gcal:") && !i.startedAt)!;
  await api(page, "POST", `/attention/${elsewhere.id}/decision`, { decision: "start" });
  await expect.poll(startedAt, { timeout: 15_000 }).not.toBeNull();
  await expect(rowFor(page, "vendor").locator(".inbox-source")).toContainText("In progress");
  await api(page, "POST", `/attention/${elsewhere.id}/decision`, { decision: "reopen" });
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("related notes: the newest briefing's notes for the meeting, labelled with its time, or that it found none", async () => {
  const page = await journeys.open("/");
  // A person note the briefing can relate to the meeting, saved as a Harness saves (the Dashboard never writes the Brain).
  await harnessSave(stack, [{ action: "create", type: "person", title: "Nora Lind", facts: [{ subject: "Role", value: "Pilot lead at the client; owns the handover" }] }], { agent: "claude-code", session: "meeting-prep" });
  await setCalendar(page, [
    { id: "handover", summary: "Pilot handover", start: 10, end: 40, meetLink: "https://meet.google.com/abc-defg-hij", attendees: ["Nora Lind"] },
    { id: "standup", summary: "Kiosk standup", start: 12, end: 20, attendees: ["Quill Ostrander"] },
  ]);
  const before = (await api<{ requested: { id: string } | null }>(page, "GET", "/briefings")).requested?.id ?? null;
  await api(page, "POST", "/briefings", { kind: "manual" });
  let written!: { id: string; createdAt: string };
  await expect.poll(async () => {
    const { requested } = await api<{ requested: typeof written | null }>(page, "GET", "/briefings");
    if (!requested || requested.id === before) return false;
    written = requested;
    return true;
  }, { timeout: 30_000 }).toBe(true);
  const when = await clock(page, written.createdAt);
  await page.mouse.move(5, 5);
  await page.reload();
  // Prep names the related notes of the briefing Home has read. Wait for Home to show the new briefing first.
  const briefingCard = page.getByRole("article", { name: "Briefing you asked for" }).getByRole("link", { name: "Read briefing" });
  await expect(briefingCard).toHaveAttribute("href", `/briefing/${encodeURIComponent(written.id)}`);
  const handover = rowFor(page, "handover");
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
  await page.route("**/api/v1/briefings", async (route) => {
    const res = await route.fetch();
    type Body = Record<"daily" | "requested", { sections: Array<{ id: string; items: Array<{ id: string; related?: unknown[] }> }> } | null>;
    const body = (await res.json()) as Body;
    for (const b of [body.daily, body.requested]) for (const section of b?.sections ?? []) section.items = section.items.map((i) => (i.id === standupId ? { ...i, related: [] } : i));
    await route.fulfill({ response: res, json: body });
  });
  await page.mouse.move(5, 5);
  await page.reload();
  await expect(briefingCard).toHaveAttribute("href", `/briefing/${encodeURIComponent(written.id)}`);
  const standup = rowFor(page, "standup");
  await openPrep(standup);
  await expect(standup.locator("[data-meeting-notes]")).toHaveText(`No related notes: the briefing at ${when} found none in your Brain.`);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("in progress: For you now says the meeting started, Your day offers Join, no Not now anywhere, and the first Inbox row is whole with a sign-in problem", async () => {
  const page = await journeys.open("/");
  await page.setViewportSize({ width: 1280, height: 800 });
  await setCalendar(page, [
    { id: "handover", summary: "Pilot handover", start: -10, end: 10, meetLink: "https://meet.google.com/abc-defg-hij" },
    { id: "triage", summary: "Billing triage", start: 10, end: 40, meetLink: "https://meet.google.com/bil-ling-tri" },
  ]);
  await page.reload();
  await expect(meetingHeadsUp(page, "Pilot handover").locator(".inbox-source")).toContainText("Meeting started, prep not read");
  await expect(meetingHeadsUp(page, "Billing triage").locator(".inbox-source")).toContainText(/Starts in (9|10|11) min, prep not read/);
  const running = page.getByRole("region", { name: "Your day" }).locator('.your-day-wide [data-phase="in-progress"]');
  await expect(running).toContainText("Pilot handover");
  await expect(running.getByRole("link", { name: "Join" })).toHaveAttribute("href", "https://meet.google.com/abc-defg-hij");
  // Opened in the Inbox, its prep has Join too, while the meeting runs.
  await openPrep(rowFor(page, "handover"));
  await expect(rowFor(page, "handover").locator("[data-meeting-detail]").getByRole("link", { name: "Join" })).toHaveAttribute("href", "https://meet.google.com/abc-defg-hij");
  // Opening it read the prep, so it is In progress; Not started makes it unread again, back in For you now.
  await expect(rowFor(page, "handover").locator(".inbox-source")).toContainText("In progress");
  await rowFor(page, "handover").getByRole("button", { name: "Not started: Pilot handover" }).click();
  await expect(rowFor(page, "handover").locator(".inbox-source")).not.toContainText("In progress");
  // Snooze is the one way to put something off.
  await expect(page.getByRole("button", { name: /Not now/ })).toHaveCount(0);
  await rowFor(page, "handover").locator("[data-row-toggle]").click();
  // The fold: with both meetings in For you now and one sign-in problem in the banner, the first Inbox row is whole.
  await routeSignIn(page);
  await page.reload();
  await expect(page.locator('[data-connection-banner][data-state="sign_in"]')).toBeVisible();
  await expect(meetingHeadsUp(page, "Billing triage")).toBeVisible();
  expect(await completeRows(page), "complete Inbox rows during overlapping meetings").toBeGreaterThanOrEqual(1);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("Done from the Inbox row decides the item everywhere: it leaves For you now and the count; a moved meeting opens it again", async () => {
  const page = await journeys.open("/");
  const entry = meetingHeadsUp(page, "Pilot handover");
  await expect(entry).toBeVisible();
  const count = async () => Number((await needYou(page).textContent())!.match(/\d+/)![0]);
  const before = await count();
  const row = rowFor(page, "handover");
  await (await rowAction(row, "Done")).click();
  await expect(row).toHaveAttribute("data-decided", "done");
  await expect(entry).toHaveCount(0);
  await expect.poll(count).toBe(before - 1);
  const resolved = (await api<{ items: Array<{ key: string; state: string }> }>(page, "GET", "/attention?state=resolved")).items;
  expect(resolved.find((i) => i.key === "gcal:handover")?.state).toBe("resolved");
  // The meeting moves, so its evidence changes and the service opens the item again: its prep is due again.
  await page.mouse.move(5, 5);
  await setCalendar(page, [{ id: "handover", summary: "Pilot handover", start: -10, end: 25, meetLink: "https://meet.google.com/abc-defg-hij" }]);
  await expect(meetingHeadsUp(page, "Pilot handover")).toBeVisible();
});

test("insertion on a phone: prep arriving in For you now above the Inbox keeps the reader's place, with and without the browser's scroll anchoring", async () => {
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
    await page.setViewportSize({ width: 375, height: 700 });
    await page.goto(stack.url);
    await setCalendar(page, [{ id: `later-${safari}`, summary: "Quarterly planning", start: 180, end: 240 }]);
    await page.reload();
    if (safari) await page.addStyleTag({ content: ".page, .page * { overflow-anchor: none !important; }" });
    await page.addStyleTag({ content: "#inbox { padding-bottom: 1200px; }" });
    const row = inboxRowFor(page, "Send the cutover plan to finance");
    await expect(row).toBeVisible();
    // The owner reads the Inbox, scrolled so this row is near the top and For you now is out of sight above.
    await row.evaluate((el) => {
      const scroller = el.closest<HTMLElement>(".page")!;
      scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 40;
    });
    const before = (await row.boundingBox())!.y;
    // A meeting comes within 15 minutes of its start: its prep arrives in For you now, above.
    await setCalendar(page, [
      { id: `later-${safari}`, summary: "Quarterly planning", start: 180, end: 240 },
      { id: `soon-${safari}`, summary: `${safari ? "Vendor" : "Partner"} sync`, start: 10, end: 40 },
    ]);
    await expect(meetingHeadsUp(page, `${safari ? "Vendor" : "Partner"} sync`)).toHaveCount(1);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    expect(Math.abs((await row.boundingBox())!.y - before), `${safari ? "without" : "with"} scroll anchoring`).toBeLessThanOrEqual(1);
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
  // Fresh meetings: the narrow journey opened its prep, which read it and took it off For you now.
  await setCalendar(page, [
    { id: "handover3", summary: "Steering group handover with the client", start: -10, end: 10, meetLink: "https://meet.google.com/abc-defg-hij" },
    { id: "triage3", summary: "Billing triage for the invoice fallback", start: 10, end: 40, meetLink: "https://meet.google.com/bil-ling-tri" },
  ]);
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
  await openPrep(meetingHeadsUp(page, "Billing triage for the invoice fallback"));
  await page.mouse.move(5, 5);
  await shoot("-prep-open");
  await page.emulateMedia({ colorScheme: null });
});

test("your day after the last meeting: it stays read, an unanswered all-day invitation keeps its link and Not answered, and the day says Nothing more today", async () => {
  const page = await journeys.open("/");
  // Today in the browser's zone: a meeting that has already ended (read for the first time only now, after its end) and
  // an all-day offsite the owner has not answered.
  const day = await page.evaluate(() => {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const date = (d: Date) => [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
    const span = now.getTime() - midnight;
    return { today: date(now), tomorrow: date(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)), from: new Date(midnight).toISOString(), to: new Date(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2).getTime()).toISOString(), endedStart: new Date(midnight + span / 4).toISOString(), endedEnd: new Date(midnight + span / 2).toISOString() };
  });
  const events = [
    { id: "sync", summary: "Morning sync", start: { dateTime: day.endedStart }, end: { dateTime: day.endedEnd }, attendees: [{ email: SELF, self: true, responseStatus: "accepted" }, { email: "nora@client.example", displayName: "Nora Lind", responseStatus: "accepted" }] },
    { id: "offsite", summary: "Team offsite", start: { date: day.today }, end: { date: day.tomorrow }, attendees: [{ email: SELF, self: true, responseStatus: "needsAction" }, { email: "mia@client.example", displayName: "Mia Jensen", responseStatus: "accepted" }] },
  ];
  expect((await page.request.post(`${stack.fixtureUrl}/__control/gcal-events`, { data: { events } })).ok()).toBe(true);
  await api(page, "POST", "/connections/gcal/refresh");
  // The read starts at the start of today, so the meeting that ended is still on the agenda.
  const agenda = `/agenda?from=${encodeURIComponent(day.from)}&to=${encodeURIComponent(day.to)}`;
  await expect.poll(async () => (await api<{ events: Array<{ id: string }> }>(page, "GET", agenda)).events.map((e) => e.id).sort(), { timeout: 30_000 }).toEqual(["offsite", "sync"]);
  await page.reload();
  const yourDay = page.getByRole("region", { name: "Your day" });
  const allDay = yourDay.getByRole("list", { name: "All day" });
  await expect(allDay.getByRole("link", { name: "Team offsite" })).toHaveAttribute("href", "https://calendar.google.com/event?eid=offsite");
  await expect(allDay.getByRole("listitem").filter({ hasText: "Team offsite" })).toContainText("Not answered");
  // The all-day event is never a meeting in progress: with the last meeting over, nothing more comes today.
  await expect(yourDay.locator(".your-day-message")).toHaveText("Nothing more today");
  await expect(yourDay).not.toContainText("Nothing on your calendar today");
});

test("no console errors during the meeting prep journeys", () => {
  expect(journeys.consoleErrors).toEqual([]);
});

