/**
 * A stand-in for the operating system's notifications: it shows nothing and
 * records each notification it is handed, so a service test sees exactly what
 * the owner would. Pass it as `AppOptions.notifier`.
 */
import type { Notifier } from "../../src/platform/notifier/index.ts";

export interface RecordingNotifier extends Notifier {
  readonly shown: Array<{ title: string; body: string }>;
}

export function recordingNotifier(): RecordingNotifier {
  const shown: Array<{ title: string; body: string }> = [];
  return {
    shown,
    check: async () => ({ available: true }),
    notify: async (title, body) => {
      shown.push({ title, body });
      return { available: true };
    },
    forget: async () => {},
  };
}
