/** Posts a desktop notification through the operating system's notification service. */
export interface Notifier {
  /** Resolves true when the notification was handed to the operating system, false when it is unavailable. Never rejects. */
  notify(title: string, body: string): Promise<boolean>;
}
