/** Whether desktop notifications can be shown, and why not when they cannot. */
export type NotifierState = { available: true } | { available: false; reason: string };

/** Posts a desktop notification through the operating system's notification service. */
export interface Notifier {
  /** Whether this computer can show notifications, without showing one. Never rejects. */
  check(): Promise<NotifierState>;
  /** Hand a notification to the operating system. Resolves available when it was shown. Never rejects. */
  notify(title: string, body: string): Promise<NotifierState>;
  /** Remove whatever this notifier registered with the operating system, for the uninstaller. Nothing on macOS and Linux. */
  forget(): Promise<void>;
}
