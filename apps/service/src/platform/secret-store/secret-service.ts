import { run } from "../run.ts";
import type { SecretBackend } from "./system-store.ts";

/**
 * The freedesktop.org Secret Service (GNOME Keyring, KWallet, KeePassXC)
 * through libsecret's `secret-tool`. Each secret is an item with the
 * attributes `service` and `account`. Values are written on stdin and read
 * from stdout, so they never appear in process arguments.
 */
export function secretServiceBackend(tool: string, service: string): SecretBackend {
  const attributes = (key: string) => ["service", service, "account", key];
  return {
    async lookup(key) {
      const r = await run(tool, ["lookup", ...attributes(key)], { timeoutMs: 30_000 });
      return r.code === 0 ? r.stdout : null;
    },
    async store(key, value) {
      // A locked keyring asks the owner to unlock it, so allow time for that.
      const r = await run(tool, ["store", `--label=Jarvis: ${key}`, ...attributes(key)], { input: value, timeoutMs: 120_000 });
      if (r.code !== 0) throw new Error(`Secret Service write failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    },
    async clear(key) {
      const r = await run(tool, ["clear", ...attributes(key)], { timeoutMs: 30_000 });
      // Exit 1 without a message means there was nothing to clear.
      if (r.code !== 0 && r.stderr.trim()) throw new Error(`Secret Service delete failed: ${r.stderr.trim()}`);
    },
  };
}
