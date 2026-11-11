import { currentOs, type Os } from "../os.ts";
import { macosNotifier } from "./macos.ts";
import type { Notifier } from "./types.ts";

export type { Notifier } from "./types.ts";

/** Linux and Windows notifications arrive with their releases; until then nothing is shown there, as before. */
const unavailable: Notifier = { notify: async () => false };

export function notifierFor(os: Os): Notifier {
  switch (os) {
    case "macos":
      return macosNotifier;
    case "linux":
    case "windows":
      return unavailable;
  }
}

function inQuietHours(q: { start: string; end: string } | null, now = new Date()): boolean {
  if (!q) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = q.start.split(":").map(Number) as [number, number];
  const [eh, em] = q.end.split(":").map(Number) as [number, number];
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  return s <= e ? m >= s && m < e : m >= s || m < e;
}

/**
 * Post a desktop notification unless notifications are switched off
 * (`JARVIS_NO_NOTIFY=1`) or it is quiet hours. Returns false when nothing was shown.
 */
export function notifyDesktop(title: string, body: string, opts: { quietHours: { start: string; end: string } | null }): Promise<boolean> {
  if (process.env.JARVIS_NO_NOTIFY === "1" || inQuietHours(opts.quietHours)) return Promise.resolve(false);
  return notifierFor(currentOs()).notify(title, body);
}
