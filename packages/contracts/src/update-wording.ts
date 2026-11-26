/**
 * Updates in the owner's words (spec #130): the sentences `attache update`, Settings' Updates section, the line under
 * the masthead and the system notifications all say, kept once so they say a thing alike.
 */

/** Why Automatic updates and the Update channel cannot change now: an Update to `to` is installing (null when unknown). */
export function settingsLockedWhileInstalling(to: string | null): string {
  return `Automatic updates and the Update channel can change once ${to ? `Attache ${to}` : "the Update"} has finished installing.`;
}
