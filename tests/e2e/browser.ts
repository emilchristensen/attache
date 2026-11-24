/** The browser side of the journeys: one paired browser profile per spec, and the Attache API as the Dashboard calls it. */
import { expect, type Browser, type BrowserContext, type BrowserContextOptions, type ConsoleMessage, type Page } from "@playwright/test";

/** The header `api()` marks its requests with, so a wait for the Dashboard's own requests can pass them by. */
const JOURNEY_CALL = "x-journey-call";

/**
 * One paired browser profile for a spec's journeys, like a real user's
 * browser, that keeps every console error its pages log so the spec's last
 * journey can check there were none.
 */
export class JourneyBrowser {
  readonly consoleErrors: string[] = [];
  readonly context: BrowserContext;
  private readonly url: string;

  private constructor(context: BrowserContext, url: string) {
    this.context = context;
    this.url = url;
  }

  /** `options` adds to the defaults, such as a `timezoneId` for journeys that depend on the time of day. */
  static async start(browser: Browser, url: string, options: BrowserContextOptions = {}): Promise<JourneyBrowser> {
    return new JourneyBrowser(await browser.newContext({ viewport: { width: 1360, height: 900 }, ...options }), url);
  }

  /** Keep `page`'s console errors. Expected network failures while the service is deliberately stopped are not app errors. */
  watch(page: Page): void {
    page.on("console", (m: ConsoleMessage) => {
      if (m.type() === "error" && !/ERR_CONNECTION_REFUSED|Failed to load resource|net::ERR/.test(m.text())) this.consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => this.consoleErrors.push(`pageerror: ${e.message}`));
  }

  /** A new watched tab, beside the open ones. */
  async newPage(): Promise<Page> {
    const page = await this.context.newPage();
    this.watch(page);
    return page;
  }

  /** The Dashboard at `path` in the only open tab. */
  async open(path = "/"): Promise<Page> {
    for (const p of this.context.pages()) await p.close();
    const page = await this.newPage();
    await page.goto(`${this.url}${path}`);
    await page.bringToFront();
    return page;
  }

  close(): Promise<void> {
    return this.context.close();
  }
}

/** Call the Attache API from a paired page, as the Dashboard does, and return its answer. */
export async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([m, p, b, marker]) => {
      const res = await fetch(`/api/v1${p}`, { method: m, credentials: "same-origin", headers: { "content-type": "application/json", "x-attache-client": "1", [marker]: "1" }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) });
      if (!res.ok) throw new Error(`${m} ${p} failed: ${res.status} ${await res.text()}`);
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    },
    [method, path, body, JOURNEY_CALL] as const,
  ) as Promise<T>;
}

/**
 * The Dashboard's own next answer to `GET /api/v1{path}` that `accept` takes, not one `api()` asked for: the moment
 * the page knows what the service now says. Start the wait before the step that makes the service say it.
 */
export async function dashboardAnswer<T>(page: Page, path: string, accept: (body: T) => boolean): Promise<T> {
  const response = await page.waitForResponse(async (r) => {
    const request = r.request();
    if (request.method() !== "GET" || request.headers()[JOURNEY_CALL] || !r.ok()) return false;
    const url = new URL(r.url());
    if (`${url.pathname}${url.search}` !== `/api/v1${path}`) return false;
    return accept((await r.json()) as T);
  });
  return (await response.json()) as T;
}

/**
 * Two animation frames: whatever the page was doing when this is called has been rendered, laid out and painted, so
 * a measurement or a check that something did not change reads the page as it now is. Needs the page's clock running.
 */
export async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

/**
 * The page drawn as it will stay, for a capture: a page just loaded has finished its requests, no screen is still
 * loading (its placeholder lines or a busy region), web fonts are in, every transition and animation that ends has
 * finished, and that is painted. A change of theme, size, address or content just before is settled after this.
 */
export async function settled(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await expect(page.locator(".skeleton, [aria-busy='true']")).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    const ending = document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getComputedTiming().endTime !== Infinity);
    // A transition the next style change cancels rejects its `finished`; that one is over too.
    await Promise.all(ending.map((a) => a.finished.catch(() => undefined)));
  });
  await nextFrames(page);
}
