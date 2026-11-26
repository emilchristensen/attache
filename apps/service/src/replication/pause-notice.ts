/**
 * The system notification for a paused Replication (spec #130, "System notifications"; ADR 0008): the Brain is in a
 * Brain format this Machine's Attache cannot read, so it sends and merges nothing until it is updated. Raised when the
 * pause begins, after the Machine asked the Updater for an Update, so it can say what happens next.
 *
 * Once per pause: the paused status is written to the database before the notification is raised (`Replication`'s
 * `onPaused`), and a service that starts while paused finds it written, so a restart raises nothing more.
 */
import type { ReplicationPause, UpdatesView } from "@attache/contracts";

/** What happens about the Update, as the Updater says right after the pause asked it to check. */
function nextStep(updates: UpdatesView): string {
  const version = updates.update?.version;
  switch (updates.status) {
    case "off":
      return "Automatic updates is Off, so Attache does not look for one: install a newer release, or choose Automatic or Ask first in Settings, Updates.";
    case "unavailable":
      return "This copy of Attache does not update itself: install a newer release on this Machine.";
    case "ready":
      return `Attache ${version} is ready: select Install in the Dashboard.`;
    case "waiting_for_jobs":
      return `Attache ${version} installs once no Job is running.`;
    case "installing":
      return `Installing Attache ${version}.`;
    default:
      return "Attache is looking for an Update now.";
  }
}

export function pausedNotification(pause: ReplicationPause, updates: UpdatesView): { title: string; body: string } {
  return {
    title: "Update this Machine to keep replicating",
    body: `Replication is paused: the Brain is in Brain format ${pause.brainFormat}, and this Machine's Attache reads Brain format ${pause.readsBrainFormat} at most. Saves carry on here and are sent once it is updated. ${nextStep(updates)}`,
  };
}
