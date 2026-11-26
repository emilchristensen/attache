import { resolve } from "node:path";
import type { ReplicationView } from "@attache/contracts";
import type { ServicePaths } from "../core/paths.ts";
import type { CliIo } from "./memory-commands.ts";
import { ServiceClient } from "./client.ts";

export const REPLICATION_USAGE = `Usage: attache replication status [--json]
       attache replication setup <repository> [--json]
       attache replication join <repository> [--data-folder <empty folder>] [--json]
       attache replication check [--json]
       attache replication off [--json]

Replication keeps the Brain the same on every Machine through a private git repository.
setup switches it on with this Machine's Brain; the repository must be empty.
join clones the Brain onto this Machine, into an empty folder that becomes the data folder.
A repository is a private one on GitHub (owner/name, or its https:// or ssh:// address) or a folder path.
check commits, fetches, merges and pushes now instead of at the next one-minute check.
off stops replicating from this Machine; the Brain in its data folder stays as it is.`;

const STATUS_TEXT: Record<ReplicationView["status"], string> = {
  off: "Replication is off",
  up_to_date: "Replication is up to date",
  offline: "Replication is offline; saves carry on and are sent when the repository can be reached",
  unauthorized: "Replication is not authorised by the repository",
  blocked: "Replication is blocked",
  paused: "Replication is paused until this Machine is updated",
};

export function renderReplication(v: ReplicationView): string {
  const lines = [v.remote ? `${STATUS_TEXT[v.status]} (${v.remote})` : STATUS_TEXT[v.status]];
  if (v.cause) lines.push(`Cause: ${v.cause}`);
  if (v.upToDateAt) lines.push(`Last up to date: ${v.upToDateAt}`);
  if (v.lastCheckedAt) lines.push(`Last checked: ${v.lastCheckedAt}`);
  if (v.lastPushedAt) lines.push(`Last sent: ${v.lastPushedAt}`);
  return lines.join("\n");
}

function positional(argv: string[]): string[] {
  return argv.filter((a, i) => !a.startsWith("--") && !(argv[i - 1] ?? "").match(/^--(state-dir|data-folder)$/));
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value.\n\n${REPLICATION_USAGE}`);
  return value;
}

/** `attache replication`: set up, join and look at Replication through the running service. */
export async function replicationCommand(argv: string[], paths: ServicePaths, io: CliIo) {
  const [, sub = "status", repository] = positional(argv);
  if (argv.includes("--help")) return io.out(REPLICATION_USAGE);
  const client = new ServiceClient(paths);
  const needRepository = () => {
    if (!repository) throw new Error(`Name the repository.\n\n${REPLICATION_USAGE}`);
    return repository;
  };
  let view: ReplicationView;
  if (sub === "status") view = await client.get<ReplicationView>("/replication");
  else if (sub === "setup") view = await client.post<ReplicationView>("/replication/setup", { remote: needRepository() });
  else if (sub === "join") {
    const folder = flag(argv, "data-folder");
    view = await client.post<ReplicationView>("/replication/join", { remote: needRepository(), ...(folder ? { path: resolve(io.cwd, folder) } : {}) });
  } else if (sub === "check") view = await client.post<ReplicationView>("/replication/check", {});
  else if (sub === "off") view = await client.post<ReplicationView>("/replication/off", {});
  else throw new Error(REPLICATION_USAGE);
  io.out(argv.includes("--json") ? JSON.stringify(view) : renderReplication(view));
}
