/**
 * Home's fold criterion (spec #14): at 1280 x 800, scroll position zero and disclosures closed, how many complete
 * Inbox rows show under the Inbox heading. For you now, meeting prep and the Connections area all take from it.
 */
import { expect, type Page } from "@playwright/test";

/**
 * The fold criterion, measured: at scroll position zero, with the Inbox heading on screen, how many Inbox rows end
 * (bottom edge, not top) inside the viewport, with their whole type word, subject, source line and time drawn: each
 * one rendered, cut off neither sideways nor below, and inside every ancestor that clips it. -1 when the Inbox
 * heading itself is below the fold.
 */
export async function completeRows(page: Page): Promise<number> {
  await expect(page.locator("#inbox [data-inbox-row]").first()).toBeVisible();
  return page.evaluate(() => {
    const scroller = document.querySelector(".page")!;
    scroller.scrollTo(0, 0);
    const fold = window.innerHeight;
    if (document.querySelector("#inbox h2")!.getBoundingClientRect().bottom > fold) return -1;
    const rows = [...document.querySelectorAll<HTMLElement>("#inbox [data-inbox-row]")];
    const PARTS = [".inbox-kind-word", ".inbox-subject", ".inbox-source", ".inbox-time"];
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
    const whole = (row: HTMLElement) => row.getBoundingClientRect().bottom <= fold && PARTS.every((s) => drawn(row.querySelector<HTMLElement>(s)));
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
