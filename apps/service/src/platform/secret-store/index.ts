import { join } from "node:path";
import type { Os } from "../os.ts";
import { FileSecretStore } from "./file.ts";
import { KeychainSecretStore } from "./keychain.ts";
import { linuxSecretStore } from "./linux.ts";
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
 * The secret store for this operating system: the Keychain on macOS, the
 * Secret Service on Linux when one is reachable (else the owner-only file).
 * Windows (Credential Manager) uses the owner-only file until its store arrives.
 */
export function createSecretStore(opts: SecretStoreOptions): SecretStore {
  const env = opts.env ?? process.env;
  if (env.JARVIS_CREDENTIAL_STORE === "file") return new FileSecretStore(opts.secretsFile, "JARVIS_CREDENTIAL_STORE=file chose the file.");
  const service = `dev.jarvis.${opts.instance}`;
  switch (opts.os) {
    case "macos":
      return new KeychainSecretStore(service, join(opts.stateDir, "keychain-index.json"));
    case "linux":
      return linuxSecretStore({ service, indexFile: join(opts.stateDir, "secret-service-index.json"), secretsFile: opts.secretsFile, env });
    case "windows":
      return new FileSecretStore(opts.secretsFile, "Jarvis does not use the Windows Credential Manager yet, so secrets are kept in a file only you can read.");
  }
}

/** Delete every secret this install stored. Returns how many were removed. */
export async function clearSecrets(store: SecretStore): Promise<number> {
  const keys = await store.keys();
  for (const key of keys) await store.delete(key);
  return keys.length;
}
