/** The element of a Settings section (`views/SettingsSection.tsx` gives each this id). */
export const settingsSectionDomId = (id: string) => `settings-${id}`;

/** Whether `el` takes up room on screen (a narrow window hides the section list or the section). */
export const shownOnScreen = (el: Element | null): el is HTMLElement => el instanceof HTMLElement && el.getClientRects().length > 0;

/**
 * Brings Settings' section `id` to the top, as a page of its own, and with `focus` gives it focus. False while it is not
 * on screen. The palette's Go to calls it directly for the section the address already names, since the address does
 * not change.
 */
export function revealSettingsSection(id: string, focus: boolean): boolean {
  const el = document.getElementById(settingsSectionDomId(id));
  if (!shownOnScreen(el)) return false;
  el.closest(".page")?.scrollTo({ top: 0 });
  if (focus) el.focus({ preventScroll: true });
  return true;
}
