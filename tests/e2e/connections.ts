/** Connections page locators (#31 of spec #14): a Connection's row or tile, and opening it in place. */
import { expect, type Locator, type Page } from "@playwright/test";

/** A Connection on the Connections page, a row when it is set up and a tile when it is not, by its id. */
export function connection(page: Page, id: string): Locator {
  return page.locator(`.page [data-connection="${id}"]`);
}

/** The button that opens and closes a row or tile: the row's name, or the whole tile. */
export function connectionToggle(item: Locator): Locator {
  return item.locator("[aria-expanded]").first();
}

/** Open a Connection's row or tile in place, unless it is open already, and return it. */
export async function openConnection(page: Page, id: string): Promise<Locator> {
  const item = connection(page, id);
  const toggle = connectionToggle(item);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  return item;
}
