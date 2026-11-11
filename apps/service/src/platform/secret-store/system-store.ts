import { registerSecret } from "../../core/log.ts";
import type { FileSecretStore } from "./file.ts";
import { KeyIndex } from "./key-index.ts";
import type { SecretStore } from "./types.ts";

/** One operating-system secret store, item by item. */
export interface SecretBackend {
  /** The value, or null when there is no such item. */
  lookup(key: string): Promise<string | null>;
  /** Write or replace an item. Throws when it was not stored. */
  store(key: string, value: string): Promise<void>;
  /** Remove an item; nothing to remove is not an error. Throws when it could not be removed. */
  clear(key: string): Promise<void>;
}

export interface SystemSecretStoreOptions {
  kind: Exclude<SecretStore["kind"], "file" | "keychain">;
  backend: SecretBackend;
  /** Key names this install stored, because a system store cannot be listed safely. */
  indexFile: string;
  /** The private file, which may still hold secrets saved while the system store was out of reach. */
  leftovers: FileSecretStore;
}

/**
 * A system secret store (the Secret Service on Linux, Credential Manager on
 * Windows) with the keys this install stored kept in an index.
 *
 * Secrets left in the private file from a start without the system store are
 * moved in first; one that cannot be moved stays readable from the file.
 */
export class SystemSecretStore implements SecretStore {
  readonly kind: SystemSecretStoreOptions["kind"];
  private readonly backend: SecretBackend;
  private readonly leftovers: FileSecretStore;
  private readonly index: KeyIndex;
  private readonly ready: Promise<void>;
  /** Leftover secrets the system store refused, with why, so the Dashboard can say they are still in the file. */
  private stranded: ReadonlyMap<string, string> = new Map();
  constructor(opts: SystemSecretStoreOptions) {
    this.kind = opts.kind;
    this.backend = opts.backend;
    this.leftovers = opts.leftovers;
    this.index = new KeyIndex(opts.indexFile);
    this.ready = this.adoptLeftovers();
  }

  get note(): string | null {
    if (this.stranded.size === 0) return null;
    const keys = [...this.stranded.keys()];
    const reasons = [...new Set(this.stranded.values())].join("; ");
    const one = keys.length === 1;
    return `${keys.length} ${one ? "secret" : "secrets"} (${keys.join(", ")}) could not be moved into the system secret store (${reasons}), so ${one ? "it stays" : "they stay"} in a file only you can read.`;
  }

  async get(key: string) {
    await this.ready;
    const v = (await this.backend.lookup(key)) ?? (await this.leftovers.get(key));
    registerSecret(v);
    return v;
  }
  async set(key: string, value: string) {
    await this.ready;
    registerSecret(value);
    await this.backend.store(key, value);
    this.index.add(key);
    await this.leftovers.delete(key);
  }
  async delete(key: string) {
    await this.ready;
    await this.backend.clear(key);
    this.index.remove(key);
    await this.leftovers.delete(key);
  }
  async keys() {
    await this.ready;
    return [...new Set([...this.index.list(), ...(await this.leftovers.keys())])];
  }

  private async adoptLeftovers(): Promise<void> {
    const stranded = new Map<string, string>();
    for (const key of await this.leftovers.keys()) {
      const value = await this.leftovers.get(key);
      if (value === null) continue;
      try {
        await this.backend.store(key, value);
        this.index.add(key);
        if ((await this.backend.lookup(key)) === value) await this.leftovers.delete(key);
        else stranded.set(key, "it read back a different value");
      } catch (err) {
        // It stays in the file, which get() still reads; the note tells the owner.
        stranded.set(key, err instanceof Error ? err.message : String(err));
      }
    }
    this.stranded = stranded;
  }
}
