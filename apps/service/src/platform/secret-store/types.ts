/**
 * Where credentials live: the operating system's secret store in normal
 * operation, or a file only the owner can read where none is reachable.
 * Secrets are never written to the Brain, the database or clients.
 */
export interface SecretStore {
  readonly kind: "keychain" | "secret-service" | "credential-manager" | "file";
  /** Why this store is in use when it is not the operating system's own, for the Dashboard; null otherwise. */
  readonly note: string | null;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys this install has stored (tracked by Jarvis, because a system secret store cannot be listed safely). */
  keys(): Promise<string[]>;
}
