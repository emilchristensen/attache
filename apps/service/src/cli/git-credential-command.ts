import type { ServicePaths } from "../core/paths.ts";
import { connectionSecretKey } from "../connectors/manager.ts";
import { createSecretStore } from "../platform/secret-store/index.ts";
import { currentOs } from "../platform/os.ts";
import { credentialAnswer, parseCredentialRequest } from "../replication/github-credentials.ts";

export interface GitCredentialIo {
  readStdin(): string;
  write(text: string): void;
}

const USAGE = "Usage: attache git-credential [--state-dir <path>] --connection <id> <get|store|erase> (git runs this for Replication)";
const MAX_REQUEST_BYTES = 64 * 1024;

/**
 * `attache git-credential --connection <id> get`: the credential helper git
 * runs when Replication talks to GitHub over https. It answers with the
 * GitHub connection's token, read from this install's secret store. It never
 * stores or erases anything, and it prints nothing else, so nothing about the
 * token reaches git's output or Attache's logs.
 */
export async function gitCredentialCommand(argv: readonly string[], paths: Pick<ServicePaths, "stateDir" | "secretsFile">, io: GitCredentialIo): Promise<void> {
  const i = argv.indexOf("--connection");
  const connectionId = i >= 0 ? argv[i + 1] : undefined;
  const action = argv[argv.length - 1];
  if (!connectionId || !/^[\w-]{1,100}$/.test(connectionId) || !action || action === connectionId) throw new Error(USAGE);
  const request = parseCredentialRequest(io.readStdin().slice(0, MAX_REQUEST_BYTES));
  if (action !== "get") return;
  const store = createSecretStore({ os: currentOs(), stateDir: paths.stateDir, secretsFile: paths.secretsFile, instance: process.env.ATTACHE_INSTANCE ?? "default" });
  const token = await store.get(connectionSecretKey(connectionId, "token")).catch(() => null);
  io.write(credentialAnswer(action, request, token));
}
