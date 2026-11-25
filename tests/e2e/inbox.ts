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

/** The Inbox heading's "View options" menu button, whatever view it shows. */
export const viewMenu = (page: Page): Locator => page.locator("#inbox .inbox-tools").getByRole("button", { name: /^View options/ });

/** Picks one of the Inbox views from "View options": "Priority order", "Newest first", "Group by type" or "Hidden". */
export async function inboxView(page: Page, label: string): Promise<void> {
  await viewMenu(page).click();
  await page.locator("#inbox").getByRole("group", { name: "View options" }).getByRole("button", { name: label, exact: true }).click();
}

/** The Inbox heading's "All types" menu button, whatever type it shows. */
export const typeMenu = (page: Page): Locator => page.locator("#inbox .inbox-tools").getByRole("button", { name: /^Type:/ });

/** The type choices as "All types 7", "Pending reply 1": each word with how many rows it lists. Leaves the menu closed. */
export async function typeChoices(page: Page): Promise<string[]> {
  await typeMenu(page).click();
  const choices = page.locator("#inbox").getByRole("group", { name: "Type" }).getByRole("button");
  const texts = await choices.allTextContents();
  await page.keyboard.press("Escape");
  return texts;
}

/** Picks a type from "All types" by its word ("Pending reply"), or every type with "All types". */
export async function inboxType(page: Page, word: string): Promise<void> {
  await typeMenu(page).click();
  await page.locator("#inbox").getByRole("group", { name: "Type" }).getByRole("button", { name: new RegExp(`^${word} \\d+$`) }).click();
}
