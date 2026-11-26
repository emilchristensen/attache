/**
 * The system notification for a paused Replication (spec #130, "System notifications"; ADR 0008): the Brain is in a
 * Brain format this Machine's Attache cannot read, so it sends and merges nothing until it is updated. Raised when the
 * pause begins, after the Machine asked the Updater for an Update, so it can say what happens next.
 *
 * Once per pause: `Replication` records the format it told the owner about before it calls `onPaused`, and keeps it
 * until Replication is up to date again, so neither a restart nor a failure in between raises it again.
 */
import { PAUSED_FOR_UPDATE, UPDATES_OFF_DETAIL, updatesHeadline, type ReplicationPause, type UpdatesView } from "@attache/contracts";

/** What happens about the Update, as the Updater says right after the pause asked it to check; the status in the words Settings uses. */
function nextStep(updates: UpdatesView): string {
  switch (updates.status) {
    case "off":
      return `${updatesHeadline(updates)}. ${UPDATES_OFF_DETAIL} Install a newer release, or choose Automatic or Ask first in Settings, Updates.`;
    case "unavailable":
      return "This copy of Attache does not update itself: install a newer release on this Machine.";
    case "ready":
      return `${updatesHeadline(updates)}: select Install in the Dashboard.`;
    case "waiting_for_jobs":
      return `${updatesHeadline(updates)}, then installs.`;
    case "installing":
      return `${updatesHeadline(updates)}.`;
    default:
      return "Attache is looking for an Update now.";
  }
}

export function pausedNotification(pause: ReplicationPause, updates: UpdatesView): { title: string; body: string } {
  return {
    title: PAUSED_FOR_UPDATE,
    body: `Replication is paused: the Brain is in Brain format ${pause.brainFormat}, and this Machine's Attache reads Brain format ${pause.readsBrainFormat} at most. Saves carry on here and are sent once it is updated. ${nextStep(updates)}`,
  };
}
