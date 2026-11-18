import { expect, type Locator, type Page } from "@playwright/test";

/** One Approvals row (Draft or Proposal) by text it shows, collapsed or decided. */
export function approvalRow(page: Page | Locator, kind: "draft" | "proposal", hasText: string | RegExp): Locator {
  return page.locator(`[data-approval-row="${kind}"]`, { hasText }).first();
}

/** An Approvals row by its Draft or Proposal id. */
export function approvalRowById(page: Page | Locator, kind: "draft" | "proposal", id: string): Locator {
  return page.locator(`[data-approval-row="${kind}"][data-row-id="${id}"]`);
}

/** Opens a row in place (its subject is the toggle) and waits for it to say so. */
export async function openApprovalRow(row: Locator): Promise<void> {
  const toggle = row.locator("[data-row-toggle]");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

/** The Waiting tab and the Approvals group sections. */
export const waitingTab = (page: Page) => page.getByRole("tab", { name: /^Waiting/ });
export const draftsGroup = (page: Page) => page.getByRole("region", { name: "Drafts to send" });
export const proposalsGroup = (page: Page) => page.getByRole("region", { name: "Changes to the Brain" });
