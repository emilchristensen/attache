/**
 * Home's fold criterion (spec #14): at 1280 x 800, scroll position zero and disclosures closed, how many complete
 * Inbox rows show under the Inbox heading. For you now, meeting prep and the Connections area all take from it.
 */
import { expect, type Page } from "@playwright/test";

/**
 * The fold criterion, measured: at scroll position zero, with the Inbox heading on screen, how many Inbox rows end
 * (bottom edge, not top) inside the viewport, with their whole subject, source line and time visible. -1 when the
 * Inbox heading itself is below the fold.
 */
export async function completeRows(page: Page): Promise<number> {
  await expect(page.locator("#inbox [data-inbox-row]").first()).toBeVisible();
  return page.evaluate(() => {
    const scroller = document.querySelector(".page")!;
    scroller.scrollTo(0, 0);
    const fold = window.innerHeight;
    if (document.querySelector("#inbox h2")!.getBoundingClientRect().bottom > fold) return -1;
    const rows = [...document.querySelectorAll<HTMLElement>("#inbox [data-inbox-row]")];
    const whole = (row: HTMLElement) => row.getBoundingClientRect().bottom <= fold && [...row.querySelectorAll(".inbox-subject, .inbox-source, .inbox-time")].every((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().bottom <= fold);
    return rows.filter(whole).length;
  });
}

/** A sign-in problem on Home's Connections area: GitHub's answer says it needs a new sign-in. */
export async function routeSignIn(page: Page) {
  await page.route("**/api/v1/capabilities", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { connections: Array<{ kind: string; status: string; lastError: string | null }> };
    body.connections = body.connections.map((c) => (c.kind === "github" ? { ...c, status: "needs_auth", lastError: "Bad credentials" } : c));
    await route.fulfill({ response: res, json: body });
  });
}
