// The system notification after an Update (spec #130, ticket #141): a rolled-back Update raises one, once, whatever restarts follow; a successful Update raises none.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UpdatesView } from "@attache/contracts";
import { installerFinished, updatesWorld } from "./updates-world.ts";

const { releases, machine, restart, outcomeSeen } = updatesWorld();

describe("the system notification after an Update", () => {
  it("a rollback raises one, naming both versions, why it failed and what became of the database, though desktop notifications for urgent items are off", async () => {
    const m = await machine("0.6.0", await releases("0.7.0"));
    await m.post<UpdatesView>("/updates/install");
    const after = await restart(m, "0.6.0");
    installerFinished(after.stateDir, { outcome: "rolled_back", from: "0.6.0", to: "0.7.0", reason: "Attache 0.7.0 did not answer within 30 seconds.", database: "restored", backup: join(after.stateDir, "backups", "pre-update-0.6.0-to-0.7.0-20261126101500.tar.gz") });
    await outcomeSeen(after);

    expect((await after.get<{ config: { notifications: { desktop: boolean } } }>("/config")).config.notifications.desktop).toBe(false);
    await expect.poll(() => after.notifications.shown).toEqual([
      { title: "The Update to 0.7.0 failed", body: "Attache went back to 0.6.0. Attache 0.7.0 did not answer within 30 seconds. The database was restored from the backup taken just before the Update." },
    ]);
  });

  it("raises it once: the same outcome read again after a restart raises nothing", async () => {
    const m = await machine("0.6.0", await releases("0.7.0"));
    await m.post<UpdatesView>("/updates/install");
    installerFinished(m.stateDir, { outcome: "rolled_back", from: "0.6.0", to: "0.7.0", reason: "Attache 0.7.0 did not answer within 30 seconds.", database: "restored" });
    await outcomeSeen(m);
    await expect.poll(() => m.notifications.shown).toHaveLength(1);

    const again = await restart(m, "0.6.0");
    const third = await restart(again, "0.6.0");
    expect((await third.get<UpdatesView>("/updates")).lastUpdate).toMatchObject({ outcome: "rolled_back", to: "0.7.0" });
    expect(third.notifications.shown).toHaveLength(1);
  });

  it("a rollback the version it went back to reads at its start raises one as well", async () => {
    const m = await machine("0.6.0", await releases("0.7.0"));
    await m.post<UpdatesView>("/updates/install");
    await m.stop();
    installerFinished(m.stateDir, { outcome: "rolled_back", from: "0.6.0", to: "0.7.0", reason: "Attache 0.7.0 did not answer within 30 seconds.", database: "no_backup" });
    const after = await restart(m, "0.6.0");
    await expect.poll(() => after.notifications.shown).toEqual([
      { title: "The Update to 0.7.0 failed", body: "Attache went back to 0.6.0. Attache 0.7.0 did not answer within 30 seconds. The database was not restored, because Attache 0.6.0 could not open it to back it up before the Update." },
    ]);
  });

  it("a successful Update raises none, and neither does one that installed nothing", async () => {
    const m = await machine("0.6.0", await releases("0.7.0"));
    await m.post<UpdatesView>("/updates/install");
    installerFinished(m.stateDir, { outcome: "updated", from: "0.6.0", to: "0.7.0" });
    const updated = await restart(m, "0.7.0");
    expect((await updated.get<UpdatesView>("/updates")).lastUpdate).toMatchObject({ outcome: "updated", to: "0.7.0" });

    const other = await machine("0.6.0", await releases("0.7.0"));
    await other.post<UpdatesView>("/updates/install");
    installerFinished(other.stateDir, { outcome: "failed", from: "0.6.0", to: "0.7.0", reason: "The download was refused." });
    await outcomeSeen(other);
    expect(updated.notifications.shown).toEqual([]);
    expect(other.notifications.shown).toEqual([]);
  });
});
