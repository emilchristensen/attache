import { randomBytes } from "node:crypto";
import type { Env } from "../locations.ts";
import { runSync } from "../run.ts";
import { locateTool } from "../tools.ts";
import { FileSecretStore } from "./file.ts";
import { secretServiceBackend } from "./secret-service.ts";
import { SystemSecretStore } from "./system-store.ts";
import type { SecretStore } from "./types.ts";

export interface LinuxSecretStoreOptions {
  service: string;
  indexFile: string;
  secretsFile: string;
  env: Env;
}

type Reachability = { reachable: true; tool: string } | { reachable: false; why: string };

/** The account of the throwaway item written to check the Secret Service. */
const PROBE_ACCOUNT = "attache-reachability-check";
/** Writing may ask the owner to unlock the keyring, so it gets longer than reading. */
const STORE_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 10_000;

function secretTool(tool: string, args: string[], opts: { input?: string; timeoutMs: number }) {
  const r = runSync(tool, args, { input: opts.input ?? "", timeoutMs: opts.timeoutMs });
  if (r.timedOut) return { ok: false, stdout: "", why: `the Secret Service did not answer within ${opts.timeoutMs / 1000} seconds` };
  const stderr = r.stderr.trim().split("\n")[0] ?? "";
  return { ok: r.code === 0, stdout: r.stdout, why: stderr || `secret-tool exited with ${r.code}` };
}

/**
 * Whether the Secret Service works: a throwaway item is written, read back and
 * removed. Writing, not just looking up, is what tells a usable keyring from
 * one that answers but has nowhere to store (no login collection, or no way
 * to ask for the unlock password). Synchronous, because the store is chosen
 * once as the service starts.
 */
function reach(opts: LinuxSecretStoreOptions): Reachability {
  const tool = locateTool("linux", "secret-tool", "ATTACHE_SECRET_TOOL_BIN", opts.env);
  if (!tool) return { reachable: false, why: "secret-tool is not installed; it comes with libsecret" };
  const attributes = ["service", opts.service, "account", PROBE_ACCOUNT];
  const value = randomBytes(12).toString("hex");
  const stored = secretTool(tool, ["store", "--label=Attache: reachability check", ...attributes], { input: value, timeoutMs: STORE_TIMEOUT_MS });
  if (!stored.ok) return { reachable: false, why: stored.why };
  const read = secretTool(tool, ["lookup", ...attributes], { timeoutMs: READ_TIMEOUT_MS });
  // Removing is a write too, and a probe left behind would stay in the owner's keyring, so it gets the longer timeout and a second try.
  const clear = () => secretTool(tool, ["clear", ...attributes], { timeoutMs: STORE_TIMEOUT_MS });
  if (!clear().ok) clear();
  if (!read.ok) return { reachable: false, why: read.why };
  if (read.stdout !== value) return { reachable: false, why: "the Secret Service returned a different value than was stored" };
  return { reachable: true, tool };
}

/** The Secret Service when it works, else the private file, with a note saying why. */
export function linuxSecretStore(opts: LinuxSecretStoreOptions): SecretStore {
  const r = reach(opts);
  if (!r.reachable) return new FileSecretStore(opts.secretsFile, `No Secret Service is reachable (${r.why}), so secrets are kept in a file only you can read.`);
  return new SystemSecretStore({ kind: "secret-service", backend: secretServiceBackend(r.tool, opts.service), indexFile: opts.indexFile, leftovers: new FileSecretStore(opts.secretsFile) });
}
