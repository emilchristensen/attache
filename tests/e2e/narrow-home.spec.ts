/**
 * Narrow Home actions (#40 of spec #14): on a phone, related notes, Join, Done, Not now and Reconnect are separate
 * 44 x 44 targets that wrap without overlap, every row's actions stay above the bottom bar and the safe area, Tab
 * follows reading order, and each action reaches its own meeting or Connection. Runs against the real bundled service
 * and the TEST-ONLY fixtures, with two overlapping meetings on the fixture calendar and a mixed Connections answer.
 */
import { test, expect, type Page } from "@playwright/test";
import { api, JourneyBrowser } from "./browser.ts";
import { buildAll, harnessSave, startStack, type Stack } from "./stack.ts";
import { meetingHeadsUp, openPrep, SELF, setCalendar } from "./meetings.ts";
import { openRecentlyAdded, openRow } from "./inbox.ts";
import { overlaps, TARGET, targets as measureTargets } from "./a11y.ts";

let stack: Stack;
let journeys: JourneyBrowser;

const PHONE = { width: 375, height: 812 };
/** The home indicator's inset on a notched phone. */
const SAFE_AREA_BOTTOM = 34;

const HANDOVER = { id: "handover", summary: "Pilot handover", start: -10, end: 20, meetLink: "https://meet.google.com/abc-defg-hij", attendees: ["Nora Lind"] };
const TRIAGE = { id: "triage", summary: "Billing triage", start: 10, end: 40, meetLink: "https://meet.google.com/bil-ling-tri", attendees: ["Sam Berg"] };

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  buildAll();
  stack = await startStack();
  journeys = await JourneyBrowser.start(browser, stack.url, { timezoneId: "Europe/Copenhagen", viewport: PHONE });
  const page = await journeys.newPage();
  await page.goto(stack.pairUrl());
  await expect(page.getByRole("heading", { name: "Where should Attache keep your knowledge?" })).toBeVisible();
  await api(page, "POST", "/setup/data-folder", { path: stack.dataDir });
  await api(page, "POST", "/setup/identity", { name: "Test User", email: SELF, confirm: true });
  await api(page, "POST", "/connections/model/configure", { method: "openai-compatible", fields: { baseUrl: `${stack.fixtureUrl}/model`, model: "fixture-model" } });
  await api(page, "POST", "/connections/github/configure", { method: "token", fields: { token: "ghp_fixturetokenfixturetoken12345678" } });
  await api(page, "POST", "/connections/gcal/configure", { method: "claude-ai", fields: {} });
  await api(page, "POST", "/connections/claude-code/configure", { method: "hooks", fields: {} });
  await api(page, "POST", "/setup/complete");
  await api(page, "PATCH", "/config", { schedules: { refreshEveryMinutes: 30, briefingAt: "08:00", briefingEnabled: false } });
  await api(page, "POST", "/import", { path: stack.vaultDir });
  await api(page, "POST", "/connections/github/refresh");
  await expect.poll(async () => (await api<{ items: unknown[] }>(page, "GET", "/attention?state=open")).items.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
  // A person note the briefing relates to the meeting in progress, so its prep has a related note to open.
  await harnessSave(stack, [{ action: "create", type: "person", title: "Nora Lind", facts: [{ subject: "Role", value: "Pilot lead at the client; owns the handover" }] }], { agent: "claude-code", session: "narrow-home" });
  await setCalendar(page, stack, [HANDOVER, TRIAGE]);
  await api(page, "POST", "/briefings", { kind: "manual" });
  await expect.poll(async () => (await api<{ briefing: unknown }>(page, "GET", "/briefings/latest")).briefing !== null, { timeout: 30_000 }).toBe(true);
  await page.close();
});
test.afterAll(async () => {
  await journeys?.close();
  await stack?.stop();
});

/**
 * Mixed Connection health: GitHub needs a new sign-in (Reconnect), the Harness is in error (a link to Connections),
 * and the rest work, so the sign-in row sits between other rows.
 */
async function routeMixedHealth(page: Page) {
  await page.route("**/api/v1/capabilities", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { connections: Array<{ kind: string; status: string; lastError: string | null }> };
    body.connections = body.connections.map((c) =>
      c.kind === "github" ? { ...c, status: "needs_auth", lastError: "Bad credentials" } : c.kind === "claude-code" ? { ...c, status: "error", lastError: "Hooks file is not readable" } : c,
    );
    await route.fulfill({ response: res, json: body });
  });
}

const connections = (page: Page) => page.getByRole("status", { name: "Connections" });

/** A related note whose title has no space to break at, as a file name with underscores can be. */
const UNBROKEN_TITLE = "Pilot_handover_checklist_for_the_client_kiosk_rollout_2026_11_18";

/** The latest briefing as served, with one more related note for every meeting: one whose title cannot wrap at a space. */
async function routeUnbrokenNote(page: Page) {
  await page.route("**/api/v1/briefings/latest", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { briefing: { sections: Array<{ id: string; items: Array<{ related?: unknown[] }> }> } | null };
    for (const section of body.briefing?.sections ?? [])
      if (section.id === "meetings") section.items = section.items.map((i) => ({ ...i, related: [...(i.related ?? []), { relPath: "memory/people/nora-lind.md", lines: [1, 3], title: UNBROKEN_TITLE }] }));
    await route.fulfill({ response: res, json: body });
  });
}

/** Home on a phone with both meetings' prep open, Recently added open and the mixed Connections rows. */
async function phoneHome(): Promise<Page> {
  const page = await journeys.open("/");
  await routeMixedHealth(page);
  await routeUnbrokenNote(page);
  await page.reload();
  await expect(connections(page).locator('.conn-row[data-state="sign_in"]')).toBeVisible();
  await expect(meetingHeadsUp(page, "Pilot handover")).toHaveAttribute("data-meeting-phase", "in-progress");
  await openPrep(meetingHeadsUp(page, "Pilot handover"));
  await openPrep(meetingHeadsUp(page, "Billing triage"));
  await expect(meetingHeadsUp(page, "Pilot handover").locator(".meeting-prep-notes button").first()).toBeVisible();
  // Recently added starts closed: open it, so its note link and Revert are measured with the rest.
  await openRecentlyAdded(page);
  return page;
}

test("targets: related notes, Join, Done, Not now and Reconnect are 44 x 44, apart and whole at 375 and 320 px", async () => {
  const page = await phoneHome();
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: PHONE.height });
    await page.mouse.move(1, 1);
    // The frame itself never scrolls: only the page does, so the masthead and the bottom bar stay where they are.
    expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight), `${width} px document scrolls`).toBeLessThanOrEqual(0);
    const targets = await page.evaluate(measureTargets, '[aria-label="Home"]');
    const names = targets.map((t) => t.name);
    // Every control the ticket names is among them: the related note, both meetings' decisions and destinations, Reconnect.
    for (const name of ["Nora Lind", UNBROKEN_TITLE, "Join", "Open in Google Calendar", "Done", "Not now", "Open prep", "Reconnect", "View details", "Open in Connections"]) expect(names, `${width} px: ${name} is measured`).toContain(name);
    const small = targets.filter((t) => t.width < TARGET - 0.01 || t.height < TARGET - 0.01).map((t) => `${t.name} ${Math.round(t.width)}x${Math.round(t.height)}`);
    expect(small, `${width} px targets under ${TARGET} px`).toEqual([]);
    expect(targets.filter((t) => t.clipped).map((t) => t.name), `${width} px targets with words cut off`).toEqual([]);
    const blocked = targets.filter((t) => !t.hit).map((t) => t.name);
    expect(blocked, `${width} px targets a tap does not reach`).toEqual([]);
    const touching = targets.flatMap((a, i) => targets.slice(i + 1).filter((b) => overlaps(a, b)).map((b) => `${a.name} / ${b.name}`));
    expect(touching, `${width} px overlapping targets`).toEqual([]);
    expect(await page.evaluate(() => scrollY), `${width} px frame moved`).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${width} px page overflow`).toBeLessThanOrEqual(0);
    expect(await page.locator(".page").evaluate((el) => el.scrollWidth - el.clientWidth), `${width} px Home overflow`).toBeLessThanOrEqual(0);
  }
});

test("destinations: each meeting's Join and Calendar open its own event", async () => {
  const page = await phoneHome();
  for (const m of [HANDOVER, TRIAGE]) {
    const headsUp = meetingHeadsUp(page, m.summary);
    await expect(headsUp.getByRole("link", { name: "Join" })).toHaveAttribute("href", m.meetLink);
    // The fixture calendar's own link for this event.
    await expect(headsUp.getByRole("link", { name: "Open in Google Calendar" })).toHaveAttribute("href", `https://calendar.google.com/event?eid=${m.id}`);
  }
});

test("keyboard: Tab goes through the visible controls in reading order", async () => {
  const page = await phoneHome();
  // Number the visible controls of For you now and Connections in document order, and note where each is drawn.
  const count = await page.evaluate(() => {
    const scope = [...document.querySelectorAll(".for-you-now, .home-connections")];
    const controls = scope.flatMap((s) => [...s.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), summary")]).filter((el) => el.getClientRects().length > 0);
    controls.forEach((el, n) => el.setAttribute("data-tab-n", String(n)));
    (document.querySelector<HTMLElement>(".for-you-now h2") ?? document.body).focus();
    return controls.length;
  });
  const visited: Array<{ n: number; top: number; left: number }> = [];
  for (let i = 0; i < count; i++) {
    await page.keyboard.press("Tab");
    visited.push(
      await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        const r = el.getBoundingClientRect();
        let top = r.top;
        for (let n = el.parentElement; n; n = n.parentElement) top += n.scrollTop;
        return { n: Number(el.getAttribute("data-tab-n") ?? -1), top, left: r.left };
      }),
    );
  }
  expect(visited.map((v) => v.n)).toEqual([...Array(count).keys()]);
  // Reading order: each stop is on a later line, or further along the same line.
  const backwards = visited.slice(1).filter((v, i) => {
    const prev = visited[i]!;
    return v.top < prev.top - 2 || (Math.abs(v.top - prev.top) <= 2 && v.left < prev.left);
  });
  expect(backwards).toEqual([]);
});

test("rows: the first and the last row's actions stay above the bottom bar and the safe area", async () => {
  const page = await phoneHome();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { bottom: SAFE_AREA_BOTTOM } });
  const bar = page.locator(".bottom-bar");
  // The bar keeps the home indicator's inset below its own controls.
  expect(await bar.evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom))).toBeGreaterThanOrEqual(SAFE_AREA_BOTTOM);
  const barTop = await bar.evaluate((el) => el.getBoundingClientRect().top);
  const rows = page.locator("#inbox [data-inbox-row]");
  for (const which of ["first", "last"] as const) {
    const row = which === "first" ? rows.first() : rows.last();
    await openRow(row);
    // Scrolled as far as Home goes, for the last row; the first row brought just into view.
    if (which === "last") await page.locator(".page").evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const actions = await row.locator(".inbox-actions").evaluate((box, top) => {
      box.scrollIntoView({ block: "nearest" });
      return [...box.querySelectorAll<HTMLElement>("a[href], button")].map((el) => {
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { name: el.textContent!.trim(), bottom: r.bottom, width: r.width, height: r.height, above: r.bottom <= top, hit: at !== null && (at === el || el.contains(at)) };
      });
    }, barTop);
    expect(actions.length, `${which} row has actions`).toBeGreaterThan(0);
    for (const a of actions) {
      expect(a.above && a.hit, `${which} row: ${a.name} above the bar and reached by a tap`).toBe(true);
      expect(Math.min(a.width, a.height), `${which} row: ${a.name} size`).toBeGreaterThanOrEqual(TARGET - 0.01);
    }
    if (which === "last") {
      // Nothing is left under the bar: the page's own end is above it.
      const end = await page.locator(".page").evaluate((el) => el.getBoundingClientRect().bottom);
      expect(end).toBeLessThanOrEqual(barTop + 0.5);
    }
  }
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: {} });
});

test("captures: Home's meeting prep and Connections rows on a phone, light and dark, and at 320 px", async () => {
  const page = await phoneHome();
  await page.mouse.move(1, 1);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize(PHONE);
    await page.locator(".page").evaluate((el) => el.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/screens/narrow-${scheme}-home-targets.png` });
    await connections(page).evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/screens/narrow-${scheme}-home-targets-connections.png` });
  }
  await page.emulateMedia({ colorScheme: null });
  await page.setViewportSize({ width: 320, height: PHONE.height });
  await page.locator(".page").evaluate((el) => el.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/screens/narrow-320-home-targets.png" });
  await page.setViewportSize(PHONE);
});

test("Reconnect from the keyboard opens the Connection its row names", async () => {
  const page = await phoneHome();
  const github = (await api<{ connections: Array<{ id: string; kind: string }> }>(page, "GET", "/capabilities")).connections.find((c) => c.kind === "github")!;
  const row = connections(page).locator('.conn-row[data-state="sign_in"]');
  await expect(row).toHaveAttribute("data-subject", "GitHub");
  await row.getByRole("button", { name: "Reconnect" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/connections\\?open=${github.id}$`));
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest<HTMLElement>("[data-connection]")?.dataset.connection ?? null)).toBe(github.id);
});

test("Not now from the keyboard leaves the meeting's Inbox item open", async () => {
  const page = await phoneHome();
  const triage = meetingHeadsUp(page, "Billing triage");
  await triage.getByRole("button", { name: "Not now" }).focus();
  await page.keyboard.press("Enter");
  await expect(triage).toHaveCount(0);
  await expect(page.locator('#inbox [data-inbox-row][data-item-key="gcal:triage"]')).toBeVisible();
  const items = (await api<{ items: Array<{ key: string }> }>(page, "GET", "/attention?state=open")).items;
  expect(items.map((i) => i.key)).toContain("gcal:triage");
  // The meeting in progress is untouched beside it.
  await expect(meetingHeadsUp(page, "Pilot handover")).toBeVisible();
});

test("no console errors during the narrow Home journeys", () => {
  expect(journeys.consoleErrors).toEqual([]);
});
