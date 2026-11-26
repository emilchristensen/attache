/**
 * The install test's Update scenario (spec #130, ticket #137): a Machine on an
 * installed release runs `attache update` against a local stand-in for GitHub
 * Releases. The service downloads and checks the newer release, starts its
 * installer unattended outside its own process group, and the installer
 * stops the service, switches versions and writes its outcome. Checks are id `update`.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { releaseArchive } from "../release-targets.mjs";
import { waitUntil } from "./wait.mjs";


/** Run `attache update`; whether it succeeded, and everything it said. */
export function runUpdate(attacheCli) {
  try {
    return { ok: true, said: attacheCli(["update"]) };
  } catch (e) {
    return { ok: false, said: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/**
 * On Windows, a program that runs from an old version's folder, as a Harness's MCP server started before two Updates
 * does: Windows refuses to remove that folder, so the installer must leave it whole. Elsewhere nothing holds a folder.
 */
function holdFolder(P, prefix, version) {
  if (P.os !== "windows") return { release: () => {} };
  const child = spawn(join(prefix, "app", version, "runtime", "node.exe"), ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  return { release: () => child.kill() };
}

/** When the service last said it was stopping before `version` first listened, from its log; null when it never did. */
function stoppedBefore(state, version) {
  const lines = readFileSync(join(state, "logs", "service.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const started = lines.findIndex((l) => l.msg === "attache service listening" && l.data?.version === version);
  const stopping = lines.slice(0, started < 0 ? lines.length : started).findLast((l) => l.msg === "stopping");
  return stopping ? Date.parse(stopping.t) : null;
}

/**
 * @param t.server   the release server (`release-server.mjs`) the installed service reads
 * @param t.machineState  what must not change when an Update is refused
 */
export async function updateScenario(t) {
  const { root, P, prefix, state, from, to, next, check, http, attacheCli, server } = t;
  const archive = releaseArchive(next, P.target);
  const nextFolder = join(root, "release", next);
  const apps = () => readdirSync(join(prefix, "app")).filter((d) => !d.startsWith(".")).sort();
  const staged = () => (existsSync(join(state, "updates", "staging")) ? readdirSync(join(state, "updates", "staging")) : []);

  // --- a downloaded archive that differs from the signed manifest is refused, and nothing changes ---
  await server.publishTampered(next, nextFolder, archive);
  const before = await t.machineState();
  const refused = runUpdate(attacheCli);
  const after = await t.machineState();
  check("update", "attache update refuses a downloaded archive that does not match the signed manifest, with the reason", !refused.ok && refused.said.includes(`${archive} does not match the signed manifest`), refused.said.trim().split("\n").slice(-1)[0]);
  check("update", "refusing the archive changes nothing on the Machine (same version still running, no backup, no new folder, nothing staged)", JSON.stringify(before) === JSON.stringify(after) && after.health === to && staged().length === 0, `${JSON.stringify(before)} -> ${JSON.stringify(after)} staged=${staged().join(",")}`);

  // --- attache update moves the Machine to the newer release ---
  await server.publish(next, nextFolder);
  const held = holdFolder(P, prefix, from);
  let updated;
  let appsAfter;
  try {
    updated = runUpdate(attacheCli);
    // Read before the hold ends, so a folder the installer could not remove is still there to see.
    appsAfter = apps();
  } finally {
    held.release();
  }
  check("update", "attache update installs the newer release and says which version it updated from", updated.ok && updated.said.includes(`Installing Attache ${next}.`) && updated.said.includes(`Attache updated from ${to} to ${next}.`), updated.said.trim().split("\n").join(" | "));
  const health = await http("GET", "/health");
  check("update", "the Machine runs the newer release, healthy", health.status === 200 && health.body.version === next, `version ${health.body?.version}`);
  const token = await t.pairToken();
  const cfg = (await http("GET", "/config", null, token)).body.config;
  check("update", "the Update keeps the configuration", JSON.stringify(cfg) === JSON.stringify(t.cfgBefore));
  const hits = (await http("GET", "/memory/search?q=Helios budget", null, token)).body.hits;
  check("update", "the Update keeps the data (decision still retrievable)", hits.some((h) => h.text.includes("Cap Helios at 40k")));
  // The installer must start the new version as the service manager's own service, not as a process it lost track of.
  const answering = (await http("GET", "/status", null, token)).body?.pid;
  const managed = P.servicePid();
  check("update", `the updated service is the one the ${P.serviceKind} runs, so stopping and uninstalling reach it`, !!answering && answering === managed, `answering pid ${answering}, service manager's pid ${managed}`);
  const updates = (await http("GET", "/updates", null, token)).body;
  check("update", "after the restart, the Updates status says which version the Machine updated from", updates.version === next && updates.lastUpdate?.outcome === "updated" && updates.lastUpdate.from === to && updates.lastUpdate.to === next, JSON.stringify(updates.lastUpdate));
  const outcomeFile = join(state, "updates", "outcome.json");
  const outcome = existsSync(outcomeFile) ? JSON.parse(readFileSync(outcomeFile, "utf8")) : null;
  check("update", "the unattended installer writes an outcome record", outcome?.outcome === "updated" && outcome.from === to && outcome.to === next && !Number.isNaN(Date.parse(outcome.at)), JSON.stringify(outcome));
  const log = join(state, "logs", `update-${next}.log`);
  const said = existsSync(log) ? readFileSync(log, "utf8") : "";
  check("update", "the unattended installer never pairs or opens the browser", said.includes(`Attache ${next} is running.`) && !/Pairing code|Open: http/.test(said), said.trim().split("\n").slice(-3).join(" | "));
  check("update", "the unattended installer checks the release with the installed version and backs up first", said.includes(`Attache ${to} checked that this release is signed by Attache.`) && readdirSync(join(state, "backups")).some((f) => f.startsWith(`pre-update-${to}-to-${next}-`)));
  // A write the old service made after the backup would be lost by a rollback: the installer stops it first.
  const backup = readdirSync(join(state, "backups")).find((f) => f.startsWith(`pre-update-${to}-to-${next}-`));
  const backupAt = backup ? statSync(join(state, "backups", backup)).mtimeMs : null;
  const stoppedAt = stoppedBefore(state, next);
  check("update", "the installer stops the running service before it takes the pre-Update backup", backupAt !== null && stoppedAt !== null && backupAt >= stoppedAt, `stopped ${stoppedAt && new Date(stoppedAt).toISOString()}, backup ${backupAt && new Date(backupAt).toISOString()}`);
  // On Windows the folder a running program holds stays, whole, for the next install; everywhere else only two versions remain.
  const expected = P.os === "windows" ? [from, to, next].sort() : [to, next].sort();
  const heldIntact = P.os !== "windows" || ["VERSION", join("runtime", "node.exe"), join("service", "attache-service.mjs")].every((f) => existsSync(join(prefix, "app", from, f)));
  check("update", P.os === "windows" ? "only the current and previous versions remain, besides a folder a running program holds, which stays whole" : "only the current and previous versions remain after the Update", JSON.stringify(appsAfter) === JSON.stringify(expected) && heldIntact, `apps=${appsAfter.join(",")}`);
  // The service removes the staged release once it reads the outcome; on Windows the installer may take a moment to let go of it.
  await waitUntil(10, () => staged().length === 0);
  check("update", "the installed release is no longer staged", staged().length === 0, staged().join(","));
  check("update", "the Update leaves exactly one service definition", P.definitions().length === 1, P.definitions().join(","));
  return token;
}
