/**
 * Home's fold criterion (spec #14): at 1280 x 800, scroll position zero and disclosures closed, how many complete
 * Inbox rows show under the Inbox heading. For you now, meeting prep and the Connections area all take from it.
 */
import { expect, type Page } from "@playwright/test";

function countComplete(page: Page, selector: string, parts: readonly string[], heading: string): Promise<number> {
  return page.evaluate(({ selector, parts, heading }) => {
    const scroller = document.querySelector(".page")!;
    scroller.scrollTo(0, 0);
    const fold = window.innerHeight;
    if (document.querySelector(heading)!.getBoundingClientRect().bottom > fold) return -1;
    const rows = [...document.querySelectorAll<HTMLElement>(selector)];
    const insideClips = (el: Element) => {
      const box = el.getBoundingClientRect();
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (getComputedStyle(p).overflow === "visible") continue;
        const clip = p.getBoundingClientRect();
        if (box.top < clip.top - 0.5 || box.bottom > clip.bottom + 0.5 || box.left < clip.left - 0.5 || box.right > clip.right + 0.5) return false;
      }
      return true;
    };
    const drawn = (el: HTMLElement | null) =>
      el !== null && el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1 && el.getBoundingClientRect().bottom <= fold && insideClips(el);
    return rows.filter((row) => row.getBoundingClientRect().bottom <= fold && parts.every((part) => drawn(row.querySelector<HTMLElement>(part)))).length;
  }, { selector, parts, heading });
}

/** The fold criterion for the two complete rows in the Inbox. */
export async function completeRows(page: Page): Promise<number> {
  await expect(page.locator("#inbox [data-inbox-row]").first()).toBeVisible();
  return countComplete(page, "#inbox [data-inbox-row]", [".inbox-kind-word", ".inbox-subject", ".inbox-source", ".inbox-time"], "#inbox h2");
}

/** The fold criterion for the two complete entries in For you now. */
export async function completeForYouNow(page: Page): Promise<number> {
  await expect(page.locator(".for-you-now [data-inbox-row]").first()).toBeVisible();
  return countComplete(page, ".for-you-now [data-inbox-row]", [".inbox-kind-word", ".inbox-subject", ".inbox-source", ".inbox-time"], ".for-you-now h2");
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
