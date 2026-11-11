import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { registerSecret } from "../../core/log.ts";
import type { SecretStore } from "./types.ts";

/**
 * Secrets in a file only the owner can read (mode 0600) under the service
 * state folder. The fallback where no operating-system secret store is
 * reachable, and what tests use.
 */
export class FileSecretStore implements SecretStore {
  readonly kind = "file" as const;
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
  }

  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    return JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>;
  }

  private write(data: Record<string, string>): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  async get(key: string) {
    const v = this.read()[key] ?? null;
    registerSecret(v);
    return v;
  }
  async set(key: string, value: string) {
    registerSecret(value);
    this.write({ ...this.read(), [key]: value });
  }
  async delete(key: string) {
    const { [key]: _removed, ...rest } = this.read();
    this.write(rest);
  }
  async keys() {
    return Object.keys(this.read());
  }
}
