/** The element of a Settings section (`views/Settings.tsx` gives each this id). */
export const settingsSectionDomId = (id: string) => `settings-${id}`;

/**
 * Brings Settings' section `id` into view and, with `focus`, gives it focus. False while it is not on screen. The
 * palette's Go to calls it directly for the section the address already names, since the address does not change.
 */
export function revealSettingsSection(id: string, focus: boolean): boolean {
  const el = document.getElementById(settingsSectionDomId(id));
  if (!el) return false;
  el.scrollIntoView({ block: "start" });
  if (focus) el.focus({ preventScroll: true });
  return true;
}
