// Installing an Update (spec #130, ticket #137): the Updater downloads and checks the artifact, then hands it to the installer runner, here a fake that records the request.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UpdatesView } from "@attache/contracts";
import { manifestFileName, signatureFileName } from "../../src/release/manifest.ts";
import { releaseTarget } from "../../src/platform/release-target.ts";
import { signedRelease } from "../fixtures/signed-release.ts";
import { CHECK_EVERY_MS } from "../../src/updates/updater.ts";
import { installerFinished, updatesWorld, type UpdatesMachine } from "./updates-world.ts";

const { key, releases, machine, restart, outcomeSeen } = updatesWorld();
const TARGET = releaseTarget()!;

const install = (m: UpdatesMachine) => m.post<UpdatesView>("/updates/install");
const view = (m: UpdatesMachine) => m.get<UpdatesView>("/updates");
/** Every file the Updater keeps for Updates in the Machine's state, as paths relative to it. */
function updateFiles(stateDir: string, dir = join(stateDir, "updates"), rel = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? updateFiles(stateDir, join(dir, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`]));
}

describe("installing an Update", () => {
  it("downloads the release for this computer, checks it against the signed manifest and hands it to the installer runner", async () => {
    const server = await releases("0.6.0", "0.7.0");
    const m = await machine("0.6.0", server);

    const v = await install(m);
    expect(v).toMatchObject({ version: "0.6.0", status: "installing", reason: null, update: { version: "0.7.0" } });
    expect(m.runner.requests).toHaveLength(1);
    const [request] = m.runner.requests;
    expect(request).toMatchObject({ from: "0.6.0", version: "0.7.0", prefix: m.prefix, stateDir: m.stateDir, port: Number(new URL(m.url).port) });
    // The staged folder is a release folder, as the installer's own check reads one: the signed manifest, its signature and this computer's archive.
    const published = signedRelease({ version: "0.7.0", key });
    const archive = readdirSync(published.folder).find((f) => f.includes(TARGET))!;
    expect(readdirSync(request!.release).sort()).toEqual([archive, manifestFileName("0.7.0"), signatureFileName("0.7.0")].sort());
    expect(request!.archive).toBe(join(request!.release, archive));
    expect(readFileSync(request!.archive, "utf8")).toBe(`Attache 0.7.0 for ${TARGET}`);
    expect(await view(m)).toEqual(v);
  });

  for (const [what, tamper] of [
    ["whose SHA-256 differs from the manifest", (s: string) => s.toUpperCase()],
    ["whose size differs from the manifest", (s: string) => `${s} and more`],
  ] as const) {
    it(`refuses an artifact ${what}, and changes nothing`, async () => {
      const server = await releases("0.6.0");
      const release = signedRelease({ version: "0.7.0", key });
      const artifact = release.artifacts[TARGET]!;
      writeFileSync(artifact, tamper(readFileSync(artifact, "utf8")));
      server.publish("0.7.0", release);
      const m = await machine("0.6.0", server);

      const v = await install(m);
      expect(v.status).toBe("check_failed");
      expect(v.reason).toMatch(/^The Update to Attache 0\.7\.0 was refused: attache-0\.7\.0-[a-z0-9-]+\.(tar\.gz|zip) does not match the signed manifest, so it was refused\.$/);
      expect(m.runner.requests).toEqual([]);
      expect(updateFiles(m.stateDir)).toEqual([]);
      expect((await view(m)).version).toBe("0.6.0");
    });
  }

  it("installs nothing when the Machine is up to date", async () => {
    const m = await machine("0.7.0", await releases("0.6.0", "0.7.0"));
    expect(await install(m)).toMatchObject({ status: "up_to_date", update: null });
    expect(m.runner.requests).toEqual([]);
  });

  it("installs nothing on a source checkout, and asks the release feed nothing", async () => {
    const server = await releases("0.7.0");
    const m = await machine("0.6.0", server, { releaseInstall: false });
    expect((await install(m)).status).toBe("unavailable");
    expect(m.runner.requests).toEqual([]);
    expect(server.requests).toEqual([]);
  });

  it("starts the installer once when Install is asked twice at the same time", async () => {
    const m = await machine("0.6.0", await releases("0.7.0"));
    const [a, b] = await Promise.all([install(m), install(m)]);
    expect([a.status, b.status]).toEqual(["installing", "installing"]);
    expect(m.runner.requests).toHaveLength(1);
  });

  it("keeps only the Update being installed in the staging folder", async () => {
    const server = await releases("0.7.0");
    const m = await machine("0.6.0", server);
    m.runner.onStart = () => installerFinished(m.stateDir, { outcome: "failed", from: "0.6.0", to: "0.7.0", reason: "could not back up the existing installation; nothing was changed" });
    await install(m);
    await outcomeSeen(m);
    expect((await view(m)).lastUpdate?.outcome).toBe("failed");
    server.publish("0.7.1", signedRelease({ version: "0.7.1", key }));
    m.runner.onStart = null;
    await install(m);
    expect(updateFiles(m.stateDir).filter((f) => f.startsWith("staging/")).map((f) => f.split("/")[1])).toEqual(["0.7.1", "0.7.1", "0.7.1"]);
  });
});

describe("after the installer finishes", () => {
  it("says which version the Machine updated from, with the release notes, once the restarted service reads the outcome", async () => {
    const m = await machine("0.6.0", await releases("0.7.0"));
    await install(m);
    const after = await restart(m, "0.7.0");
    // The installer checks the new version's health before it writes its outcome, so the new service starts first.
    expect(await view(after)).toMatchObject({ version: "0.7.0", status: "installing", lastUpdate: null });

    installerFinished(after.stateDir, { outcome: "updated", from: "0.6.0", to: "0.7.0" });
    await outcomeSeen(after);
    expect((await view(after)).lastUpdate).toMatchObject({ outcome: "updated", from: "0.6.0", to: "0.7.0", notes: "## 0.7.0\n\nWhat changed in 0.7.0.\n" });
    const v = await view(after);
    expect(Date.parse(v.lastUpdate!.at)).not.toBeNaN();
    // The installed release is no longer staged.
    expect(updateFiles(after.stateDir).filter((f) => f.startsWith("staging/"))).toEqual([]);

    // A later restart still says so, until the next Update.
    expect((await view(await restart(after, "0.7.0"))).lastUpdate).toMatchObject({ outcome: "updated", from: "0.6.0", to: "0.7.0" });
  });

  // The service on the version the installer leaves running starts while the installer still checks its health, so its check at start waits for the outcome.
  for (const [outcome, runs] of [
    ["updated", "0.7.0"],
    ["failed", "0.6.0"],
    ["rolled_back", "0.6.0"],
  ] as const) {
    it(`looks for an Update as soon as it reads that the Update ${outcome === "updated" ? "installed" : outcome === "failed" ? "failed" : "rolled back"}, not 6 hours later`, async () => {
      const server = await releases("0.7.0");
      const m = await machine("0.6.0", server);
      await install(m);
      const after = await restart(m, runs);
      await after.clock.advance(0);
      const checksBefore = server.requests.filter((r) => r.path.endsWith("/releases")).length;
      installerFinished(after.stateDir, { outcome, from: "0.6.0", to: "0.7.0", ...(outcome === "updated" ? {} : { reason: "the service did not become healthy" }) });
      await outcomeSeen(after);
      await after.clock.advance(0);
      expect(server.requests.filter((r) => r.path.endsWith("/releases")).length).toBe(checksBefore + 1);
      expect(await view(after)).toMatchObject({ version: runs, status: "up_to_date", update: null, lastCheckedAt: expect.any(String) });
      expect(after.runner.requests.map((r) => r.version)).toEqual(["0.7.0"]);
    });
  }

  it("says why, stays on its version and never tries that version again, when the installer stopped before changing anything", async () => {
    const server = await releases("0.7.0");
    const m = await machine("0.6.0", server);
    m.runner.onStart = () => installerFinished(m.stateDir, { outcome: "failed", from: "0.6.0", to: "0.7.0", reason: "could not back up the existing installation; nothing was changed" });
    await install(m);
    await outcomeSeen(m);
    expect((await view(m)).lastUpdate).toMatchObject({ outcome: "failed", from: "0.6.0", to: "0.7.0", reason: "could not back up the existing installation; nothing was changed" });
    await m.clock.advance(0);
    await m.clock.advance(CHECK_EVERY_MS);
    expect(await view(m)).toMatchObject({ version: "0.6.0", status: "up_to_date", update: null });
    expect(m.runner.requests.map((r) => r.version)).toEqual(["0.7.0"]);
    const again = await restart(m, "0.6.0");
    expect(await again.post<UpdatesView>("/updates/check", { reportOnly: true })).toMatchObject({ status: "up_to_date", update: null, lastUpdate: { outcome: "failed" } });

    // A newer release is still offered.
    server.publish("0.7.1", signedRelease({ version: "0.7.1", key }));
    expect(await again.post<UpdatesView>("/updates/check", { reportOnly: true })).toMatchObject({ status: "available", update: { version: "0.7.1" } });
  });

  it("never tries a version again whose installer did not report back within 15 minutes", async () => {
    const server = await releases("0.7.0");
    const m = await machine("0.6.0", server);
    await install(m);
    const after = await restart(m, "0.6.0");
    await after.clock.advance(15 * 60_000);
    expect((await view(after)).lastUpdate).toMatchObject({ outcome: "failed", from: "0.6.0", to: "0.7.0", reason: expect.stringMatching(/did not report back within 15 minutes/) });
    await after.clock.advance(0);
    await after.clock.advance(CHECK_EVERY_MS);
    expect(await view(after)).toMatchObject({ version: "0.6.0", status: "up_to_date", update: null });
    expect(after.runner.requests.map((r) => r.version)).toEqual(["0.7.0"]);
  });

  it("tells a rolled-back Update apart from a successful one", async () => {
    const m = await machine("0.6.0", await releases("0.7.0"));
    await install(m);
    const after = await restart(m, "0.6.0");
    installerFinished(after.stateDir, { outcome: "rolled_back", from: "0.6.0", to: "0.7.0", reason: "the service did not become healthy" });
    await outcomeSeen(after);
    expect((await view(after)).lastUpdate).toMatchObject({ outcome: "rolled_back", from: "0.6.0", to: "0.7.0", reason: "the service did not become healthy" });
  });
});

// A failed Update is never retried (spec #130, ticket #138): the version the installer switched back from is marked bad on this Machine.
describe("after an Update rolled back", () => {
  async function rolledBack(versions: string[]) {
    const server = await releases(...versions);
    const m = await machine("0.6.0", server);
    await install(m);
    const after = await restart(m, "0.6.0");
    installerFinished(after.stateDir, { outcome: "rolled_back", from: "0.6.0", to: "0.7.0", reason: "the service did not become healthy", database: "restored", backup: join(after.stateDir, "backups", "pre-update-0.6.0-to-0.7.0-20261126101500.tar.gz") });
    await outcomeSeen(after);
    expect((await view(after)).lastUpdate?.outcome).toBe("rolled_back");
    return { server, after };
  }

  it("shows the rollback, the versions involved, the reason and what became of the database", async () => {
    const { after } = await rolledBack(["0.7.0"]);
    expect((await view(after)).lastUpdate).toEqual({
      outcome: "rolled_back",
      from: "0.6.0",
      to: "0.7.0",
      at: expect.any(String),
      reason: "the service did not become healthy",
      database: "restored",
      backup: join(after.stateDir, "backups", "pre-update-0.6.0-to-0.7.0-20261126101500.tar.gz"),
    });
  });

  it("never offers that version again, also after another restart", async () => {
    const { after } = await rolledBack(["0.7.0"]);
    expect(await after.post<UpdatesView>("/updates/check", { reportOnly: true })).toMatchObject({ status: "up_to_date", update: null });
    const again = await restart(after, "0.6.0");
    expect(await again.post<UpdatesView>("/updates/check", { reportOnly: true })).toMatchObject({ status: "up_to_date", update: null });
  });

  it("in Automatic, the version it went back to never installs the failed one again, neither at its start nor 6 hours later", async () => {
    const m = await machine("0.6.0", await releases("0.7.0"));
    await install(m);
    // The installer starts the earlier version again before it writes its outcome: that service checks at start.
    const after = await restart(m, "0.6.0");
    await after.clock.advance(0);
    installerFinished(after.stateDir, { outcome: "rolled_back", from: "0.6.0", to: "0.7.0", reason: "the service did not become healthy", database: "restored" });
    await outcomeSeen(after);
    await after.clock.advance(CHECK_EVERY_MS);
    expect(await view(after)).toMatchObject({ version: "0.6.0", status: "up_to_date", update: null });
    expect(after.runner.requests.map((r) => r.version)).toEqual(["0.7.0"]);
  });

  it("looks again at once, and no longer shows the failed version as available", async () => {
    const m = await machine("0.6.0", await releases("0.7.0"));
    await install(m);
    // The version it went back to: it waits for the outcome, so its check at start is skipped.
    const after = await restart(m, "0.6.0");
    await after.clock.advance(0);
    installerFinished(after.stateDir, { outcome: "rolled_back", from: "0.6.0", to: "0.7.0", reason: "the service did not become healthy", database: "restored" });
    await outcomeSeen(after);
    await after.clock.advance(0);
    expect(await view(after)).toMatchObject({ status: "up_to_date", update: null, lastCheckedAt: expect.any(String), lastUpdate: { outcome: "rolled_back", to: "0.7.0" } });
  });

  it("forgets the failed version as the Update it found, in a service that read the rollback without restarting", async () => {
    const m = await machine("0.6.0", await releases("0.7.0"));
    await install(m);
    installerFinished(m.stateDir, { outcome: "rolled_back", from: "0.6.0", to: "0.7.0", reason: "the service did not become healthy", database: "restored" });
    await outcomeSeen(m);
    await m.clock.advance(0);
    expect(await view(m)).toMatchObject({ status: "up_to_date", update: null });
  });

  it("still offers a newer release", async () => {
    const { server, after } = await rolledBack(["0.7.0"]);
    server.publish("0.7.1", signedRelease({ version: "0.7.1", key }));
    expect(await after.post<UpdatesView>("/updates/check", { reportOnly: true })).toMatchObject({ status: "available", update: { version: "0.7.1" } });
  });
});
