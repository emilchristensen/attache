import type { UpdatesView } from "@attache/contracts";
import type { ServicePaths } from "../core/paths.ts";
import type { CliIo } from "./memory-commands.ts";
import { ServiceClient } from "./client.ts";

export const UPDATE_USAGE = `Usage: attache update --check [--json]

--check looks for an Update now and reports the version this Machine runs, its Update channel and the newest version it may take, without installing anything.
The Update channel and Automatic updates are set in the Dashboard, under Settings.`;

const CHANNEL: Record<UpdatesView["channel"], string> = { stable: "Stable", beta: "Beta" };

/** What `attache update --check` prints for a status; a failure goes to stderr instead, through the error it throws. */
export function renderUpdateCheck(v: UpdatesView): { lines: string[]; failure: string | null } {
  const head = `Attache ${v.version}, Update channel ${CHANNEL[v.channel]}`;
  switch (v.status) {
    case "unavailable":
      return { lines: [head], failure: `Updates are unavailable here: ${v.reason ?? "this copy cannot update itself."}` };
    case "check_failed":
      return { lines: [head], failure: `The check for an Update failed: ${v.reason ?? "no reason was given."}` };
    case "up_to_date":
      return { lines: [head, "Attache is up to date."], failure: null };
    case "off":
      return { lines: [head, "Automatic updates is Off, so Attache does not look for Updates. Change it in the Dashboard, under Settings."], failure: null };
    case "not_checked":
    case "checking":
      return { lines: [head], failure: "The check for an Update did not finish. Try again." };
    case "available":
    case "downloading":
    case "ready":
    case "waiting_for_jobs":
    case "installing":
      return { lines: [head, `Attache ${v.update?.version ?? "(unknown version)"} is available.`], failure: null };
  }
}

/** `attache update --check`: look for an Update through the running service. */
export async function updateCommand(argv: readonly string[], paths: ServicePaths, io: CliIo): Promise<void> {
  if (argv.includes("--help") || !argv.includes("--check")) return io.out(UPDATE_USAGE);
  const view = await new ServiceClient(paths).post<UpdatesView>("/updates/check", { reportOnly: true });
  if (argv.includes("--json")) return io.out(JSON.stringify(view));
  const { lines, failure } = renderUpdateCheck(view);
  io.out(lines.join("\n"));
  if (failure) throw new Error(failure);
}
