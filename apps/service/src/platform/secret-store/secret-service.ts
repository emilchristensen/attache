import { registerSecret } from "../../core/log.ts";
import { run } from "../run.ts";
import type { FileSecretStore } from "./file.ts";
import { KeyIndex } from "./key-index.ts";
import type { SecretStore } from "./types.ts";

export interface SecretServiceOptions {
  /** Path of libsecret's `secret-tool`. */
  tool: string;
  /** Value of the `service` attribute, one per install instance. */
  service: string;
  indexFile: string;
  /** The private file, which may still hold secrets saved while no Secret Service was reachable. */
  leftovers: FileSecretStore;
}

/**
 * The freedesktop.org Secret Service (GNOME Keyring, KWallet, KeePassXC)
 * through libsecret's `secret-tool`. Each secret is an item with the
 * attributes `service` and `account`. Values are written on stdin and read
 * from stdout, so they never appear in process arguments.
 *
 * Secrets left in the private file from a start without a Secret Service are
 * moved in first; one that cannot be moved stays readable from the file.
 */
export class SecretServiceStore implements SecretStore {
  readonly kind = "secret-service" as const;
  readonly note = null;
  private readonly opts: SecretServiceOptions;
  private readonly index: KeyIndex;
  private readonly ready: Promise<void>;
  constructor(opts: SecretServiceOptions) {
    this.opts = opts;
    this.index = new KeyIndex(opts.indexFile);
    this.ready = this.adoptLeftovers();
  }

  async get(key: string) {
    await this.ready;
    const v = (await this.lookup(key)) ?? (await this.opts.leftovers.get(key));
    registerSecret(v);
    return v;
  }
  async set(key: string, value: string) {
    await this.ready;
    registerSecret(value);
    await this.store(key, value);
    await this.opts.leftovers.delete(key);
  }
  async delete(key: string) {
    await this.ready;
    const r = await run(this.opts.tool, ["clear", ...this.attributes(key)], { timeoutMs: 30_000 });
    // Exit 1 without a message means there was nothing to clear.
    if (r.code !== 0 && r.stderr.trim()) throw new Error(`Secret Service delete failed: ${r.stderr.trim()}`);
    this.index.remove(key);
    await this.opts.leftovers.delete(key);
  }
  async keys() {
    await this.ready;
    return [...new Set([...this.index.list(), ...(await this.opts.leftovers.keys())])];
  }

  private attributes(key: string): string[] {
    return ["service", this.opts.service, "account", key];
  }

  private async lookup(key: string): Promise<string | null> {
    const r = await run(this.opts.tool, ["lookup", ...this.attributes(key)], { timeoutMs: 30_000 });
    return r.code === 0 ? r.stdout : null;
  }

  private async store(key: string, value: string): Promise<void> {
    // A locked keyring asks the owner to unlock it, so allow time for that.
    const r = await run(this.opts.tool, ["store", `--label=Jarvis: ${key}`, ...this.attributes(key)], { input: value, timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`Secret Service write failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    this.index.add(key);
  }

  private async adoptLeftovers(): Promise<void> {
    const { leftovers } = this.opts;
    for (const key of await leftovers.keys()) {
      const value = await leftovers.get(key);
      if (value === null) continue;
      try {
        await this.store(key, value);
        if ((await this.lookup(key)) === value) await leftovers.delete(key);
      } catch {
        // It stays in the file, which get() still reads.
      }
    }
  }
}
