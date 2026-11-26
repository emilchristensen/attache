/**
 * The install test's rollback scenario (spec #130, ticket #138), after the Update scenario left the Machine on `next`
 * with `to` before it. A release built to fail its health check (`build-release.mjs --fail-health-check`) migrates
 * the database past every release and never answers: the installer switches back, restores the database from the
 * pre-Update backup and records the rollback, and the version it went back to marks the failed one bad. Then a
 * Machine whose installed version cannot open its database rolls back without that backup and says so, and a newer
 * release, the fourth Update, leaves only the 3 newest pre-Update backups beside the owner's own. Checks are id `rollback`.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { runUpdate } from "./update.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastLines = (said, n = 3) => said.trim().split("\n").slice(-n).join(" | ");
const RESTORED = "The database was restored from the backup taken just before the Update.";

/** Stop the service; one that already stopped, or refused to start, is stopped too. */
function stopped(attacheCli) {
  try {
    attacheCli(["stop"]);
  } catch {
    // Nothing runs.
  }
}

/** The database's schema version, and whether the release built to fail its health check migrated it. */
function schemaOf(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const version = Number(db.prepare("pragma user_version").get().user_version);
    const migratedByTheFailedRelease = !!db.prepare("select 1 from sqlite_master where name = 'release_built_to_fail'").get();
    return { version, migratedByTheFailedRelease };
  } finally {
    db.close();
  }
}

/**
 * @param t.failing  the version built to fail its health check
 * @param t.newer    a good release after it
 */
export async function rollbackScenario(t) {
  const { root, prefix, state, next, failing, newer, check, http, attacheCli, shRefused, artifact, server, waitForHealth } = t;
  const db = join(state, "attache.sqlite");
  const backups = () => readdirSync(join(state, "backups")).sort();
  const preUpdate = () => backups().filter((f) => /^pre-update-/.test(f));
  const currentVersion = () => readFileSync(join(prefix, "current", "VERSION"), "utf8").trim();

  // A backup the owner made, which no Update may remove.
  const owners = JSON.parse(attacheCli(["backup"])).path;
  const schemaBefore = schemaOf(db);

  // --- an Update that fails its health check rolls back, with the database from before it ---
  await server.publish(failing, join(root, "release", failing));
  const failed = runUpdate(attacheCli);
  check("rollback", "attache update says the Update failed and Attache went back, with the reason and what became of the database", !failed.ok && failed.said.includes(`The Update to Attache ${failing} failed, so Attache went back to ${next}: the service did not become healthy`) && failed.said.includes(RESTORED), lastLines(failed.said));
  const health = await http("GET", "/health");
  check("rollback", "the previous version runs again, healthy", health.status === 200 && health.body.version === next && currentVersion() === next, `version ${health.body?.version}, current ${currentVersion()}`);
  check("rollback", "the database is the one from before the Update", JSON.stringify(schemaOf(db)) === JSON.stringify(schemaBefore), `${JSON.stringify(schemaBefore)} -> ${JSON.stringify(schemaOf(db))}`);
  const keptAs = readdirSync(state).find((f) => /^attache\.sqlite\.pre-restore-\d+$/.test(f));
  check("rollback", "the database the failed version migrated is kept beside it, as it left it", !!keptAs && schemaOf(join(state, keptAs)).migratedByTheFailedRelease, keptAs ?? "none");
  const token = await t.pairToken();
  const hits = (await http("GET", "/memory/search?q=Helios budget", null, token)).body.hits;
  check("rollback", "the data is still there after the rollback (decision still retrievable)", hits.some((h) => h.text.includes("Cap Helios at 40k")));
  const updates = (await http("GET", "/updates", null, token)).body;
  const last = updates.lastUpdate;
  check("rollback", "the Updates status shows the rollback, the versions involved, the reason and the restored database", last?.outcome === "rolled_back" && last.from === next && last.to === failing && last.reason.startsWith("the service did not become healthy") && last.database === "restored" && last.backup?.includes(`pre-update-${next}-to-${failing}-`), JSON.stringify(last));
  const log = readFileSync(join(state, "logs", `update-${failing}.log`), "utf8");
  check("rollback", "the installer's log says it rolled back and restored the database", log.includes(`Rolling back to ${next}`) && log.includes(RESTORED), lastLines(log, 4));

  // --- the failed version is never offered again; a newer release is ---
  const checked = attacheCli(["update", "--check"]);
  check("rollback", "the failed version is not offered again", checked.includes("Attache is up to date."), checked.trim());
  await server.publish(newer, join(root, "release", newer));
  const checkedNewer = attacheCli(["update", "--check"]);
  check("rollback", "a newer release is offered", checkedNewer.includes(`Attache ${newer} is available.`), checkedNewer.trim());

  // --- without a pre-Update backup, a rollback leaves the database as it is and says so ---
  // A Machine left on a database a newer Attache wrote: its service refuses to start (#132), so no backup can be taken.
  stopped(attacheCli);
  for (const ext of ["-wal", "-shm"]) rmSync(db + ext, { force: true });
  copyFileSync(join(state, keptAs), db);
  if (existsSync(join(state, `${keptAs}-wal`))) copyFileSync(join(state, `${keptAs}-wal`), `${db}-wal`);
  try {
    attacheCli(["start"]);
  } catch {
    // The service refuses to start, which is the point.
  }
  const refused = join(state, "refused-to-start");
  for (let i = 0; i < 80 && !existsSync(refused); i++) await sleep(250);
  check("rollback", "a Machine on a database a newer Attache wrote refuses to start", existsSync(refused));
  const backupsBefore = backups();
  const noBackup = shRefused(artifact(failing));
  check("rollback", "an install that fails there rolls back without a backup, and says the database was not restored", !noBackup.ok && noBackup.said.includes("installed without a backup first") && noBackup.said.includes(`Rolling back to ${next}`) && noBackup.said.includes(`The database was not restored, because Attache ${next} could not open it to back it up before the Update.`), lastLines(noBackup.said, 4));
  check("rollback", "that rollback switches back and takes no backup", currentVersion() === next && JSON.stringify(backups()) === JSON.stringify(backupsBefore), `current ${currentVersion()}`);
  // The owner restores the database by hand, as the Dashboard's Details say.
  const restoreFrom = join(state, "backups", preUpdate().find((f) => f.startsWith(`pre-update-${next}-to-${failing}-`)));
  stopped(attacheCli);
  attacheCli(["restore", restoreFrom, "--database-only"]);
  attacheCli(["start"]);
  const recovered = await waitForHealth();
  check("rollback", `restoring the pre-Update backup by hand brings Attache ${next} back`, recovered?.body.version === next && !existsSync(refused), `version ${recovered?.body.version}`);

  // --- the fourth Update keeps only the 3 newest pre-Update backups, and the owner's own ---
  const newest = preUpdate()
    .map((f) => ({ f, at: statSync(join(state, "backups", f)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
    .map((b) => b.f)
    .slice(0, 2);
  const updated = runUpdate(attacheCli);
  check("rollback", "the newer release installs", updated.ok && updated.said.includes(`Attache updated from ${next} to ${newer}.`), lastLines(updated.said));
  const left = preUpdate();
  const expected = [...newest, left.find((f) => f.startsWith(`pre-update-${next}-to-${newer}-`))].sort();
  check("rollback", "after the fourth Update only the 3 newest pre-Update backups remain", JSON.stringify(left) === JSON.stringify(expected), `left ${left.join(", ")}`);
  check("rollback", "a backup the owner made with attache backup is still there", existsSync(owners), owners);
  const apps = readdirSync(join(prefix, "app")).filter((d) => !d.startsWith(".")).sort();
  check("rollback", "the next Update removes the version that rolled back", JSON.stringify(apps) === JSON.stringify([next, newer].sort()), `apps=${apps.join(",")}`);
  return t.pairToken();
}
