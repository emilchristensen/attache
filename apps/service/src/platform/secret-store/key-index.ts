import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * The keys this install has put in a system secret store, kept by Jarvis in
 * an owner-only file because those stores cannot be listed safely.
 * Holds key names only, never values.
 */
export class KeyIndex {
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
  }

  list(): string[] {
    if (!existsSync(this.file)) return [];
    return JSON.parse(readFileSync(this.file, "utf8")) as string[];
  }

  add(key: string): void {
    this.write([...this.list(), key]);
  }

  remove(key: string): void {
    this.write(this.list().filter((k) => k !== key));
  }

  private write(keys: string[]): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify([...new Set(keys)].sort()), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
