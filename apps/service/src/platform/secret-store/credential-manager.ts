import type { Env } from "../locations.ts";
import { runPowerShell, runPowerShellSync, type PowerShellReply, type PowerShellRequest } from "../powershell.ts";
import { CREDENTIAL_MANAGER_SCRIPT } from "./credential-manager-script.ts";
import type { SecretBackend } from "./system-store.ts";

/** Starting Windows PowerShell and compiling the script takes a few seconds on a slow computer. */
const TIMEOUT_MS = 60_000;
/** The account of the throwaway credential written to check Credential Manager. */
const PROBE_KEY = "attache-reachability-check";

const target = (service: string, key: string) => `${service}/${key}`;
const toBase64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
const fromBase64 = (value: string) => Buffer.from(value, "base64").toString("utf8");

async function ask(request: PowerShellRequest, env: Env): Promise<Readonly<Record<string, unknown>>> {
  const r: PowerShellReply = await runPowerShell(CREDENTIAL_MANAGER_SCRIPT, request, { env, timeoutMs: TIMEOUT_MS });
  if (!r.ok) throw new Error(r.why);
  return r.reply;
}

/**
 * Windows Credential Manager. Each secret is a generic credential with the
 * target `dev.attache.<instance>/<key>`. Values travel on stdin and stdout of
 * Windows PowerShell, so they never appear in process arguments.
 */
export function credentialManagerBackend(service: string, env: Env): SecretBackend {
  return {
    async lookup(key) {
      const r = await ask({ op: "read", target: target(service, key) }, env);
      return r.found === true && typeof r.secret === "string" ? fromBase64(r.secret) : null;
    },
    async store(key, value) {
      await ask({ op: "write", target: target(service, key), user: key, secret: toBase64(value) }, env);
    },
    async clear(key) {
      await ask({ op: "delete", target: target(service, key) }, env);
    },
  };
}

/**
 * Whether Credential Manager works for this logon: a throwaway credential is
 * written, read back and removed. Writing is what fails where there is no
 * credential vault, such as a logon without a loaded user profile.
 * Synchronous, because the store is chosen once as the service starts.
 */
export function probeCredentialManager(service: string, env: Env): { reachable: true } | { reachable: false; why: string } {
  const r = runPowerShellSync(CREDENTIAL_MANAGER_SCRIPT, { op: "probe", target: target(service, PROBE_KEY), user: PROBE_KEY }, { env, timeoutMs: TIMEOUT_MS });
  return r.ok ? { reachable: true } : { reachable: false, why: r.why };
}
