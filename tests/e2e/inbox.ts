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

/** Picks one of the Inbox views: "Priority order", "Newest first", "Group by type" or "Hidden". */
export async function inboxView(page: Page, label: string): Promise<void> {
  await page.locator("#inbox").getByRole("combobox", { name: "View" }).selectOption({ label });
}
