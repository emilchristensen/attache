import type { LastUpdateView, UpdatesView } from "@attache/contracts";
import type { ServicePaths } from "../core/paths.ts";
import type { CliIo } from "./memory-commands.ts";
import { ServiceClient, ServiceError } from "./client.ts";

export const UPDATE_USAGE = `Usage: attache update [--check] [--json]

attache update installs an available Update now: the service restarts on the new version, and the command says which version this Machine updated from.
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

/** How long `attache update` waits for the installer: a backup, the switch, and up to 30 s for the new version's health. */
const INSTALL_WAIT_MS = 10 * 60_000;
const POLL_MS = 500;

/** What `attache update` says once the installer reported back; a failure goes to stderr through the error it throws. */
export function renderUpdateOutcome(last: LastUpdateView): { line: string | null; failure: string | null } {
  switch (last.outcome) {
    case "updated":
      return { line: `Attache updated from ${last.from} to ${last.to}.`, failure: null };
    case "rolled_back":
      return { line: null, failure: `The Update to Attache ${last.to} failed, so Attache went back to ${last.from}: ${last.reason}` };
    case "failed":
      return { line: null, failure: `The Update to Attache ${last.to} failed, and Attache stayed on ${last.from}: ${last.reason}` };
  }
}

/** What `attache update` says when Install did not start an installer: up to date, or why not. */
export function renderNotInstalled(v: UpdatesView): { lines: string[]; failure: string | null } {
  // An install's reasons are whole sentences that already say what failed: a check, a download or the installer's start.
  if (v.status === "check_failed") return { lines: [], failure: v.reason ?? "The Update did not start, and no reason was given. Try again." };
  if (v.status === "unavailable" || v.status === "up_to_date") return renderUpdateCheck(v);
  return { lines: [], failure: "The Update did not start. Try again." };
}

/** The Updates status, or null while the service is restarting and does not answer. */
async function currentView(paths: ServicePaths): Promise<UpdatesView | null> {
  try {
    // A new client each time: the restarted service writes its address again.
    return await new ServiceClient(paths).get<UpdatesView>("/updates");
  } catch {
    // The service is between versions; the next try reaches the new one.
    return null;
  }
}

/** Wait until the installer's outcome for `to` shows, one that is not `before`. */
async function waitForOutcome(paths: ServicePaths, to: string, before: string | null): Promise<UpdatesView> {
  const end = Date.now() + INSTALL_WAIT_MS;
  for (;;) {
    const view = await currentView(paths);
    const last = view?.lastUpdate;
    if (view && last && last.to === to && last.at !== before) return view;
    if (view && view.status !== "installing" && !last) return view;
    if (Date.now() > end) throw new Error(`The Update to Attache ${to} did not finish within ${INSTALL_WAIT_MS / 60_000} minutes. See the installer's log, update-${to}.log, in the logs folder of the Machine's state.`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** `attache update`: install an available Update now and say how it went. */
async function installCommand(paths: ServicePaths, io: CliIo): Promise<void> {
  const client = new ServiceClient(paths);
  // A check first names the version to wait for, and answers "up to date" or why not without starting anything.
  const checked = await client.post<UpdatesView>("/updates/check", { reportOnly: true });
  if (checked.status !== "available" || !checked.update) {
    const { lines, failure } = renderUpdateCheck(checked);
    io.out(lines.join("\n"));
    if (failure) throw new Error(failure);
    return;
  }
  const before = checked.lastUpdate?.at ?? null;
  let to = checked.update.version;
  try {
    const started = await client.post<UpdatesView>("/updates/install", {});
    if (started.status !== "installing" || !started.update) {
      const { lines, failure } = renderNotInstalled(started);
      if (lines.length) io.out(lines.join("\n"));
      if (failure) throw new Error(failure);
      return;
    }
    to = started.update.version;
  } catch (e) {
    // The installer stops the service as its first change; it can do so before the answer arrives.
    if (!(e instanceof ServiceError && e.code === "unreachable")) throw e;
  }
  io.out(`Installing Attache ${to}. Attache restarts to finish the Update.`);
  const done = await waitForOutcome(paths, to, before);
  if (!done.lastUpdate) throw new Error(`The Update to Attache ${to} did not finish: ${done.reason ?? "the installer gave no outcome."}`);
  const { line, failure } = renderUpdateOutcome(done.lastUpdate);
  if (line) io.out(line);
  if (failure) throw new Error(failure);
}

/** `attache update [--check]`: install an Update, or only look for one, through the running service. */
export async function updateCommand(argv: readonly string[], paths: ServicePaths, io: CliIo): Promise<void> {
  if (argv.includes("--help")) return io.out(UPDATE_USAGE);
  if (!argv.includes("--check")) return installCommand(paths, io);
  const view = await new ServiceClient(paths).post<UpdatesView>("/updates/check", { reportOnly: true });
  if (argv.includes("--json")) return io.out(JSON.stringify(view));
  const { lines, failure } = renderUpdateCheck(view);
  io.out(lines.join("\n"));
  if (failure) throw new Error(failure);
}
