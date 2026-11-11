import type { Env } from "../locations.ts";
import { credentialManagerBackend, probeCredentialManager } from "./credential-manager.ts";
import { FileSecretStore } from "./file.ts";
import { SystemSecretStore } from "./system-store.ts";
import type { SecretStore } from "./types.ts";

export interface WindowsSecretStoreOptions {
  service: string;
  indexFile: string;
  secretsFile: string;
  env: Env;
}

/** Credential Manager when it works, else the private file, with a note saying why. */
export function windowsSecretStore(opts: WindowsSecretStoreOptions): SecretStore {
  const r = probeCredentialManager(opts.service, opts.env);
  if (!r.reachable) return new FileSecretStore(opts.secretsFile, `Windows Credential Manager is not available (${r.why}), so secrets are kept in a file only you can read.`);
  return new SystemSecretStore({ kind: "credential-manager", backend: credentialManagerBackend(opts.service, opts.env), indexFile: opts.indexFile, leftovers: new FileSecretStore(opts.secretsFile) });
}
