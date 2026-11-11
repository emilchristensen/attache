import { registerSecret } from "../../core/log.ts";
import { run } from "../run.ts";
import { KeyIndex } from "./key-index.ts";
import type { SecretStore } from "./types.ts";

const SECURITY = "/usr/bin/security";

/** Quote a value for `security -i` command parsing. */
function securityQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The macOS login Keychain through /usr/bin/security. Secret values are
 * passed on stdin to `security -i` so they never appear in process arguments.
 */
export class KeychainSecretStore implements SecretStore {
  readonly kind = "keychain" as const;
  readonly note = null;
  private readonly service: string;
  private readonly index: KeyIndex;
  constructor(service: string, indexFile: string) {
    this.service = service;
    this.index = new KeyIndex(indexFile);
  }

  async get(key: string) {
    const r = await run(SECURITY, ["find-generic-password", "-s", this.service, "-a", key, "-w"]);
    if (r.code !== 0) return null;
    const v = r.stdout.replace(/\n$/, "");
    registerSecret(v);
    return v;
  }
  async set(key: string, value: string) {
    if (/[\n\r]/.test(value)) throw new Error("Credential values cannot contain newlines");
    registerSecret(value);
    const cmd = `add-generic-password -U -s ${securityQuote(this.service)} -a ${securityQuote(key)} -l ${securityQuote("Jarvis: " + key)} -w ${securityQuote(value)}\n`;
    const r = await run(SECURITY, ["-i"], { input: cmd });
    if (r.code !== 0 || /error/i.test(r.stderr)) throw new Error(`Keychain write failed: ${r.stderr.trim() || r.code}`);
    this.index.add(key);
  }
  async delete(key: string) {
    await run(SECURITY, ["delete-generic-password", "-s", this.service, "-a", key]);
    this.index.remove(key);
  }
  async keys() {
    return this.index.list();
  }
}
