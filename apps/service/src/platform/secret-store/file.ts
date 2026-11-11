import { existsSync, readFileSync, rmSync } from "node:fs";
import { registerSecret } from "../../core/log.ts";
import type { SecretStore } from "./types.ts";
import { writePrivateFile } from "../private-file.ts";

/**
 * Secrets in a file only the owner can read (mode 0600, or an owner-only
 * access-control list on Windows) under the service state folder. The fallback where no operating-system secret store is
 * reachable, and what tests use. The file is removed once it holds nothing.
 */
export class FileSecretStore implements SecretStore {
  readonly kind = "file" as const;
  readonly note: string | null;
  private readonly file: string;
  constructor(file: string, note: string | null = null) {
    this.file = file;
    this.note = note;
  }

  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    return JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>;
  }

  private write(data: Record<string, string>): void {
    if (!Object.keys(data).length) {
      rmSync(this.file, { force: true });
      return;
    }
    writePrivateFile(this.file, JSON.stringify(data));
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
    const data = this.read();
    if (!(key in data)) return;
    const { [key]: _removed, ...rest } = data;
    this.write(rest);
  }
  async keys() {
    return Object.keys(this.read());
  }
}
