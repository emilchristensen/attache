import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../locations.ts";
import { run } from "../run.ts";
import { locateTool } from "../tools.ts";
import { escapeXml } from "../xml.ts";
import type { Notifier, NotifierState } from "./types.ts";

const MAX = 240;
/** D-Bus starts a notification daemon on its first notification, and a busy desktop answers slowly; allow for both. */
const TIMEOUT_MS = 15_000;

/** Whether there is a session bus for the notification service to listen on, as systemd and desktop sessions provide it. */
function hasSessionBus(env: Env): boolean {
  if (env.DBUS_SESSION_BUS_ADDRESS) return true;
  return !!env.XDG_RUNTIME_DIR && existsSync(join(env.XDG_RUNTIME_DIR, "bus"));
}

type Route = { tool: string } | { available: false; reason: string };

function route(env: Env): Route {
  const tool = locateTool("linux", "notify-send", "JARVIS_NOTIFY_SEND_BIN", env);
  if (!tool) return { available: false, reason: "notify-send is not installed; it comes with libnotify" };
  if (!hasSessionBus(env)) return { available: false, reason: "no desktop session bus (DBUS_SESSION_BUS_ADDRESS is not set)" };
  return { tool };
}

/**
 * The desktop's notification service (org.freedesktop.Notifications: GNOME
 * Shell, KDE Plasma, mako, dunst and others) through libnotify's `notify-send`.
 * Text is passed without a shell and after `--`, so it is never read as options.
 */
export function linuxNotifier(env: Env = process.env): Notifier {
  return {
    async check(): Promise<NotifierState> {
      const r = route(env);
      return "tool" in r ? { available: true } : r;
    },
    async notify(title, body) {
      const r = route(env);
      if (!("tool" in r)) return r;
      // Notification bodies may carry markup (freedesktop.org Desktop Notifications), so their text is escaped.
      const done = await run(r.tool, ["--app-name=Jarvis", "--", title.slice(0, MAX), escapeXml(body.slice(0, MAX))], { timeoutMs: TIMEOUT_MS });
      return done.code === 0 ? { available: true } : { available: false, reason: done.stderr.trim().split("\n")[0] || `notify-send exited with ${done.code}` };
    },
    forget: async () => {},
  };
}
