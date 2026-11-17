import type { Env } from "../locations.ts";
import { runPowerShell, type PowerShellRequest } from "../powershell.ts";
import type { Notifier, NotifierState } from "./types.ts";
import { TOAST_SCRIPT } from "./windows-script.ts";

const MAX = 240;
/** Starting Windows PowerShell and the Windows Runtime takes a few seconds on a slow computer. */
const TIMEOUT_MS = 30_000;

/** Why Windows does not show Attache's notifications, by its `NotificationSetting`. */
const SETTINGS: Readonly<Record<string, string>> = {
  DisabledForApplication: "notifications from Attache are turned off in Windows Settings (System > Notifications)",
  DisabledForUser: "notifications are turned off for this Windows user",
  DisabledByGroupPolicy: "notifications are turned off by group policy",
  DisabledByManifest: "Windows does not let Attache show notifications",
};

const notificationSettingReason = (setting: string): string => SETTINGS[setting] ?? `Windows reports notifications as ${setting}`;

/** The app id Windows knows Attache by, and the name it shows on each notification. */
export function toastSender(instance: string): { app: string; name: string } {
  return { app: `dev.attache.${instance}`, name: instance === "default" ? "Attache" : `Attache (${instance})` };
}

async function ask(request: PowerShellRequest, env: Env): Promise<NotifierState> {
  const r = await runPowerShell(TOAST_SCRIPT, request, { env, timeoutMs: TIMEOUT_MS });
  if (!r.ok) return { available: false, reason: r.why };
  if (r.reply.enabled === true) return { available: true };
  return { available: false, reason: notificationSettingReason(String(r.reply.setting)) };
}

/**
 * Windows notifications (toasts) from Attache, through Windows PowerShell and
 * the Windows Runtime. The text travels on stdin, never in process arguments.
 */
export function windowsNotifier(instance: string, env: Env = process.env): Notifier {
  const sender = toastSender(instance);
  return {
    check: () => ask({ op: "check", ...sender }, env),
    notify: (title, body) => ask({ op: "show", ...sender, title: title.slice(0, MAX), body: body.slice(0, MAX) }, env),
    async forget() {
      const r = await runPowerShell(TOAST_SCRIPT, { op: "forget", ...sender }, { env, timeoutMs: TIMEOUT_MS });
      if (!r.ok) throw new Error(`Attache could not remove its notification sender from Windows: ${r.why}`);
    },
  };
}

