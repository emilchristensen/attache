import type { Locator, Page } from "@playwright/test";

/** Helpers for Home's typed Inbox rows, shared by the journeys and the visual captures. */

/** The Inbox row whose text (subject, kind word or source line) matches. */
export function inboxRow(page: Page, text: string | RegExp): Locator {
  return page.locator("#inbox [data-inbox-row]", { hasText: text });
}

/** Opens a row in place (its subject is the toggle); does nothing when it is already open. */
export async function openRow(row: Locator): Promise<void> {
  const toggle = row.locator("[data-row-toggle]");
  await toggle.waitFor({ timeout: 15_000 });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

/**
 * One of a row's own actions (Start working, Snooze, Done), by the start of its accessible name. In a half or narrower
 * space they sit behind the row's Actions button, which this opens first when the action is not in view.
 */
export async function rowAction(row: Locator, name: "Start working" | "Continue" | "Snooze" | "Done"): Promise<Locator> {
  const action = row.locator(".inbox-row-actions").getByRole("button", { name: new RegExp(`^${name}:`) });
  if (!(await action.isVisible())) await row.locator(".inbox-row-actions").getByRole("button", { name: /^Actions:/ }).click();
  return action;
}

/** Opens Home's Recently added line into its changes and waits until it has opened; does nothing when it is already open. */
export async function openRecentlyAdded(page: Page): Promise<void> {
  const details = page.getByRole("region", { name: "Recently added" }).locator("details");
  await details.waitFor({ timeout: 15_000 });
  if (!(await details.evaluate((d) => (d as HTMLDetailsElement).open))) await details.locator("summary").click();
  // The chevron turns as it opens: wait for the turn to end, so a capture never catches it halfway.
  await details.locator(".disclosure-chevron").evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
}

/** Picks one of the Inbox views: "Priority order", "Newest first", "Group by type" or "Hidden". */
export async function inboxView(page: Page, label: string): Promise<void> {
  await page.locator("#inbox").getByRole("combobox", { name: "View" }).selectOption({ label });
}
