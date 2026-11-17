import type { Logger } from "../../core/log.ts";
import type { Env } from "../locations.ts";
import type { Os } from "../os.ts";
import { linuxNotifier } from "./linux.ts";
import { macosNotifier } from "./macos.ts";
import { windowsNotifier } from "./windows.ts";
import type { Notifier, NotifierState } from "./types.ts";

export type { Notifier, NotifierState } from "./types.ts";

/** The desktop notifications of this operating system; on Windows, `instance` keeps a test install's sender apart from the owner's. */
export function notifierFor(os: Os, instance: string, env: Env = process.env): Notifier {
  switch (os) {
    case "macos":
      return macosNotifier;
    case "linux":
      return linuxNotifier(env);
    case "windows":
      return windowsNotifier(instance, env);
  }
}

export type QuietHours = { start: string; end: string } | null;

function inQuietHours(q: QuietHours, now: Date): boolean {
  if (!q) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = q.start.split(":").map(Number) as [number, number];
  const [eh, em] = q.end.split(":").map(Number) as [number, number];
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  return s <= e ? m >= s && m < e : m >= s || m < e;
}

/**
 * Desktop notifications for the service: skipped when switched off
 * (`ATTACHE_NO_NOTIFY=1`) or in quiet hours, and logged when the operating
 * system cannot show them, once per change, so a computer without a
 * notification service runs on and says so in the log.
 */
export class DesktopNotifications {
  private readonly notifier: Notifier;
  private readonly log: Logger;
  private readonly env: Env;
  /** The reason last logged for notifications being off; null while they work. */
  private offBecause: string | null = null;

  constructor(deps: { notifier: Notifier; log: Logger; env?: Env }) {
    this.notifier = deps.notifier;
    this.log = deps.log;
    this.env = deps.env ?? process.env;
  }

  private get disabled(): boolean {
    return this.env.ATTACHE_NO_NOTIFY === "1";
  }

  /** Check once at start, so a computer without a notification service says so in the log right away. */
  async start(): Promise<void> {
    if (this.disabled) return;
    this.record(await this.notifier.check());
  }

  /** Post a notification. Returns false when nothing was shown. */
  async notify(title: string, body: string, opts: { quietHours: QuietHours }): Promise<boolean> {
    if (this.disabled || inQuietHours(opts.quietHours, new Date())) return false;
    const state = await this.notifier.notify(title, body);
    this.record(state);
    return state.available;
  }

  private record(state: NotifierState): void {
    if (state.available) {
      if (this.offBecause !== null) this.log.info("desktop notifications are on again");
      this.offBecause = null;
      return;
    }
    if (this.offBecause === state.reason) return;
    this.offBecause = state.reason;
    this.log.warn("desktop notifications are off", { reason: state.reason });
  }
}
