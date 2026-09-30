import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { registerSecret } from "./log.ts";

/**
 * Credentials live only in the service's credential store: the macOS login
 * Keychain in normal operation, or a 0600 file under the service state
 * directory where no Keychain exists (portable fallback, isolated tests).
 * Secrets are never written to the data folder, the database or clients.
 */
export interface CredentialStore {
  readonly kind: "keychain" | "file";
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys this installation has stored (tracked separately; Keychain cannot be enumerated safely). */
  keys(): Promise<string[]>;
}

export class FileCredentialStore implements CredentialStore {
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

function run(cmd: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? Number((error as { code: number }).code) : error ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

/** Quote a value for `security -i` command parsing. */
function securityQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * macOS Keychain via /usr/bin/security. Secret values are passed on stdin to
 * `security -i` so they never appear in process arguments.
 */
export class KeychainCredentialStore implements CredentialStore {
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
    const r = await run("/usr/bin/security", ["find-generic-password", "-s", this.service, "-a", key, "-w"]);
    if (r.code !== 0) return null;
    const v = r.stdout.replace(/\n$/, "");
    registerSecret(v);
    return v;
  }
  async set(key: string, value: string) {
    if (/[\n\r]/.test(value)) throw new Error("Credential values cannot contain newlines");
    registerSecret(value);
    const cmd = `add-generic-password -U -s ${securityQuote(this.service)} -a ${securityQuote(key)} -l ${securityQuote("Jarvis: " + key)} -w ${securityQuote(value)}\n`;
    const r = await run("/usr/bin/security", ["-i"], cmd);
    if (r.code !== 0 || /error/i.test(r.stderr)) throw new Error(`Keychain write failed: ${r.stderr.trim() || r.code}`);
    this.writeIndex([...this.readIndex(), key]);
  }
  async delete(key: string) {
    await run("/usr/bin/security", ["delete-generic-password", "-s", this.service, "-a", key]);
    this.writeIndex(this.readIndex().filter((k) => k !== key));
  }
  async keys() {
    return this.readIndex();
  }
}

export function createCredentialStore(opts: { stateDir: string; secretsFile: string; instance: string }): CredentialStore {
  const mode = process.env.JARVIS_CREDENTIAL_STORE;
  if (mode === "file" || (mode !== "keychain" && platform() !== "darwin")) return new FileCredentialStore(opts.secretsFile);
  return new KeychainCredentialStore(`dev.jarvis.${opts.instance}`, `${opts.stateDir}/keychain-index.json`);
}
