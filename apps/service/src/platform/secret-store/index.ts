import { join } from "node:path";
import type { Os } from "../os.ts";
import { FileSecretStore } from "./file.ts";
import { KeychainSecretStore } from "./keychain.ts";
import type { SecretStore } from "./types.ts";

export type { SecretStore } from "./types.ts";
export { FileSecretStore } from "./file.ts";

export interface SecretStoreOptions {
  os: Os;
  stateDir: string;
  secretsFile: string;
  /** Install name; each instance keeps its own secrets. */
  instance: string;
  /** `JARVIS_CREDENTIAL_STORE=file` forces the file store (tests, isolated installs). */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The secret store for this operating system: the Keychain on macOS. Linux
 * (Secret Service) and Windows (Credential Manager) use the owner-only file
 * until their stores arrive.
 */
export function createSecretStore(opts: SecretStoreOptions): SecretStore {
  if ((opts.env ?? process.env).JARVIS_CREDENTIAL_STORE === "file") return new FileSecretStore(opts.secretsFile);
  switch (opts.os) {
    case "macos":
      return new KeychainSecretStore(`dev.jarvis.${opts.instance}`, join(opts.stateDir, "keychain-index.json"));
    case "linux":
    case "windows":
      return new FileSecretStore(opts.secretsFile);
  }
}

/** Delete every secret this install stored. Returns how many were removed. */
export async function clearSecrets(store: SecretStore): Promise<number> {
  const keys = await store.keys();
  for (const key of keys) await store.delete(key);
  return keys.length;
}
