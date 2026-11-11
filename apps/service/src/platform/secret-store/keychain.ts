import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { registerSecret } from "../../core/log.ts";
import { run } from "../run.ts";
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
  private readonly service: string;
  private readonly indexFile: string;
  constructor(service: string, indexFile: string) {
    this.service = service;
    this.indexFile = indexFile;
  }

  private readIndex(): string[] {
    if (!existsSync(this.indexFile)) return [];
    return JSON.parse(readFileSync(this.indexFile, "utf8")) as string[];
  }
  private writeIndex(keys: string[]) {
    const tmp = `${this.indexFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify([...new Set(keys)].sort()), { mode: 0o600 });
    renameSync(tmp, this.indexFile);
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
    this.writeIndex([...this.readIndex(), key]);
  }
  async delete(key: string) {
    await run(SECURITY, ["delete-generic-password", "-s", this.service, "-a", key]);
    this.writeIndex(this.readIndex().filter((k) => k !== key));
  }
  async keys() {
    return this.readIndex();
  }
}
