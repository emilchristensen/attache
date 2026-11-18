/** The browser side of the journeys: one paired browser profile per spec, and the Attache API as the Dashboard calls it. */
import type { Browser, BrowserContext, BrowserContextOptions, ConsoleMessage, Page } from "@playwright/test";

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
    async ([m, p, b]) => {
      const res = await fetch(`/api/v1${p}`, { method: m, credentials: "same-origin", headers: { "content-type": "application/json", "x-attache-client": "1" }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) });
      if (!res.ok) throw new Error(`${m} ${p} failed: ${res.status} ${await res.text()}`);
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    },
    [method, path, body] as const,
  ) as Promise<T>;
}
