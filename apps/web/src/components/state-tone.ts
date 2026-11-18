/**
 * How a stored status shows on screen (`StateTag`).
 * plain: healthy, shown as plain text and never a tag, so only exceptions stand out.
 * warning: the owner can fix it, or part was read (amber).
 * neutral: underway or not known yet.
 * danger: failed, refused or not read (red).
 */
export type StateTone = "plain" | "warning" | "neutral" | "danger";

const TONES: Record<Exclude<StateTone, "neutral">, readonly string[]> = {
  plain: ["ready", "connected", "complete", "empty", "succeeded", "ok", "applied", "open"],
  warning: ["partial", "needs_setup", "needs_auth", "blocked", "revoked", "unknown"],
  danger: ["error", "failed", "unavailable", "denied", "unauthorized", "offline", "expired", "rejected"],
};

/** The tone for a status from the service; one it does not know is neutral. */
export function stateTone(state: string): StateTone {
  for (const [tone, states] of Object.entries(TONES) as Array<[StateTone, readonly string[]]>) if (states.includes(state)) return tone;
  return "neutral";
}
